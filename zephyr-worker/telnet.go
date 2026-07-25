package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// Telnet IAC command bytes (RFC 854 / RFC 1073 / RFC 1091)
const (
	telnetIAC  = 255
	telnetDONT = 254
	telnetDO   = 253
	telnetWONT = 252
	telnetWILL = 251
	telnetSB   = 250
	telnetSE   = 240
	telnetNOP  = 241
	telnetGA   = 249

	telnetOptBINARY = 0
	telnetOptECHO   = 1  // Echo (RFC 857)
	telnetOptSGA    = 3  // Suppress Go Ahead (RFC 858)
	telnetOptTTYPE  = 24 // Terminal Type (RFC 1091)
	telnetOptNAWS   = 31 // Negotiate About Window Size (RFC 1073)

	telnetTTypeIS   = 0
	telnetTTypeSEND = 1

	telnetDefaultTerm = "xterm-256color"
)

// dialTelnet opens a raw TCP connection to the telnet target and returns it.
// No credentials - telnet auth happens in-band via the data stream.
func dialTelnet(ctx context.Context, spec HostSpec) (net.Conn, error) {
	host := spec.Host
	port := spec.Port
	if port == 0 {
		port = 23
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	d := &net.Dialer{Timeout: 15 * time.Second}
	return d.DialContext(ctx, "tcp", addr)
}

// telnetNegotiate sends initial option negotiations: we WILL NAWS (window
// size) and WILL TTYPE (terminal type), and DO SGA + DO ECHO to get a sane
// line-mode terminal.
func telnetNegotiate(conn net.Conn, cols, rows int) error {
	packets := [][]byte{
		{telnetIAC, telnetWILL, telnetOptNAWS},
		{telnetIAC, telnetWILL, telnetOptTTYPE},
		{telnetIAC, telnetDO, telnetOptSGA},
		{telnetIAC, telnetDO, telnetOptECHO},
	}
	for _, p := range packets {
		if _, err := conn.Write(p); err != nil {
			return fmt.Errorf("telnet negotiate: %w", err)
		}
	}
	return telnetSendNAWS(conn, cols, rows)
}

// telnetSendNAWS reports the current window size to the server (RFC 1073).
func telnetSendNAWS(conn net.Conn, cols, rows int) error {
	if cols < 1 {
		cols = 80
	}
	if rows < 1 {
		rows = 24
	}
	pkt := []byte{telnetIAC, telnetSB, telnetOptNAWS,
		byte(cols >> 8), byte(cols & 0xff),
		byte(rows >> 8), byte(rows & 0xff),
		telnetIAC, telnetSE}
	_, err := conn.Write(pkt)
	return err
}

// telnetIacEngine is a stateful IAC processor aligned with Node TelnetIacEngine:
// cross-packet buffering, DO/DONT/WILL/WONT replies, TTYPE answers, NOP keepalive.
type telnetIacEngine struct {
	mu       sync.Mutex
	write    func([]byte) error
	termType string
	respond  bool
	wantUs   map[byte]bool
	wantHim  map[byte]bool
	us       map[byte]bool
	him      map[byte]bool
	pending  []byte
	stopKA   chan struct{}
	closed   bool
}

func newTelnetIacEngine(write func([]byte) error, termType string) *telnetIacEngine {
	if termType == "" {
		termType = telnetDefaultTerm
	}
	e := &telnetIacEngine{
		write:    write,
		termType: termType,
		respond:  write != nil,
		wantUs:   map[byte]bool{telnetOptNAWS: true, telnetOptTTYPE: true},
		wantHim:  map[byte]bool{telnetOptSGA: true, telnetOptECHO: true},
		us:       map[byte]bool{telnetOptNAWS: true, telnetOptTTYPE: true},
		him:      map[byte]bool{},
		stopKA:   make(chan struct{}),
	}
	return e
}

func (e *telnetIacEngine) destroy() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.closed = true
	close(e.stopKA)
	e.pending = nil
}

func (e *telnetIacEngine) startKeepalive(interval time.Duration) {
	if interval <= 0 || e.write == nil {
		return
	}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-e.stopKA:
				return
			case <-t.C:
				e.mu.Lock()
				closed := e.closed
				w := e.write
				e.mu.Unlock()
				if closed || w == nil {
					return
				}
				_ = w([]byte{telnetIAC, telnetNOP})
			}
		}
	}()
}

func (e *telnetIacEngine) emit(pkt []byte) {
	if !e.respond || e.write == nil || len(pkt) == 0 {
		return
	}
	_ = e.write(pkt)
}

func (e *telnetIacEngine) reply(cmd, opt byte) {
	e.emit([]byte{telnetIAC, cmd, opt})
}

func (e *telnetIacEngine) onDo(opt byte) {
	if !e.respond {
		return
	}
	enabled := e.us[opt]
	if e.wantUs[opt] {
		if !enabled {
			e.us[opt] = true
			e.reply(telnetWILL, opt)
		}
		return
	}
	if enabled {
		e.us[opt] = false
	}
	e.reply(telnetWONT, opt)
}

func (e *telnetIacEngine) onDont(opt byte) {
	if !e.respond {
		return
	}
	if e.us[opt] {
		e.us[opt] = false
		e.reply(telnetWONT, opt)
	}
}

func (e *telnetIacEngine) onWill(opt byte) {
	if !e.respond {
		return
	}
	enabled := e.him[opt]
	if e.wantHim[opt] || opt == telnetOptBINARY {
		if !enabled {
			e.him[opt] = true
			e.reply(telnetDO, opt)
		}
		return
	}
	if enabled {
		e.him[opt] = false
	}
	e.reply(telnetDONT, opt)
}

func (e *telnetIacEngine) onWont(opt byte) {
	if !e.respond {
		return
	}
	if e.him[opt] {
		e.him[opt] = false
		e.reply(telnetDONT, opt)
	}
}

func (e *telnetIacEngine) onSubnegotiation(opt byte, body []byte) {
	if !e.respond {
		return
	}
	if opt == telnetOptTTYPE && len(body) >= 1 && body[0] == telnetTTypeSEND {
		term := []byte(e.termType)
		pkt := make([]byte, 0, 6+len(term))
		pkt = append(pkt, telnetIAC, telnetSB, telnetOptTTYPE, telnetTTypeIS)
		pkt = append(pkt, term...)
		pkt = append(pkt, telnetIAC, telnetSE)
		e.emit(pkt)
	}
}

// feed processes a TCP chunk and returns payload bytes for the terminal.
// Incomplete trailing IAC sequences are held in pending for the next feed.
// Also normalizes CR NUL → CR when peer is not in BINARY mode (RFC 854).
func (e *telnetIacEngine) feed(data []byte) []byte {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	buf := data
	if len(e.pending) > 0 {
		buf = append(append([]byte{}, e.pending...), data...)
		e.pending = nil
	}
	out := make([]byte, 0, len(buf))
	i := 0
	for i < len(buf) {
		if buf[i] != telnetIAC {
			// CR NUL → CR when not binary (RFC 854 NVT)
			if buf[i] == '\r' && !e.him[telnetOptBINARY] {
				if i+1 < len(buf) {
					if buf[i+1] == 0 {
						out = append(out, '\r')
						i += 2
						continue
					}
				} else {
					// lone CR at end — hold in case next byte is NUL
					e.pending = buf[i:]
					break
				}
			}
			out = append(out, buf[i])
			i++
			continue
		}
		if i+1 >= len(buf) {
			e.pending = buf[i:]
			break
		}
		cmd := buf[i+1]
		switch cmd {
		case telnetIAC:
			out = append(out, telnetIAC)
			i += 2
		case telnetNOP, telnetGA:
			i += 2
		case telnetDO, telnetDONT, telnetWILL, telnetWONT:
			if i+2 >= len(buf) {
				e.pending = buf[i:]
				break
			}
			opt := buf[i+2]
			switch cmd {
			case telnetDO:
				e.onDo(opt)
			case telnetDONT:
				e.onDont(opt)
			case telnetWILL:
				e.onWill(opt)
			case telnetWONT:
				e.onWont(opt)
			}
			i += 3
		case telnetSB:
			end := i + 2
			found := false
			for end < len(buf)-1 {
				if buf[end] == telnetIAC {
					if buf[end+1] == telnetSE {
						found = true
						break
					}
					if buf[end+1] == telnetIAC {
						end += 2
						continue
					}
				}
				end++
			}
			if !found {
				e.pending = buf[i:]
				// break outer by setting i past end
				i = len(buf)
				break
			}
			var opt byte
			if i+2 < end {
				opt = buf[i+2]
			}
			bodyStart := i + 3
			var body []byte
			if bodyStart < end {
				body = buf[bodyStart:end]
			}
			e.onSubnegotiation(opt, body)
			i = end + 2
		default:
			i += 2
		}
	}
	return out
}

// telnetFilterIAC is a one-shot stripper (no replies, no hangover) kept for
// tests and any caller that does not need a live engine.
func telnetFilterIAC(data []byte) []byte {
	e := newTelnetIacEngine(nil, telnetDefaultTerm)
	e.respond = false
	return e.feed(data)
}

// serveTelnetWS runs the WebSocket session for a Telnet target: open TCP,
// negotiate options, then pump browser <-> TCP with a stateful IAC engine.
func (h *WSHandler) serveTelnetWS(ctx context.Context, conn Conn, t *Ticket) {
	defer conn.Close()

	tcpConn, err := dialTelnet(ctx, t.HostSpec)
	if err != nil {
		_ = conn.WriteJSON(Envelope{Type: "error", Code: "telnet_dial_failed", Message: err.Error()})
		return
	}
	defer tcpConn.Close()

	cols, rows := 120, 30
	if err := telnetNegotiate(tcpConn, cols, rows); err != nil {
		_ = conn.WriteJSON(Envelope{Type: "error", Code: "telnet_negotiate_failed", Message: err.Error()})
		return
	}

	engine := newTelnetIacEngine(func(b []byte) error {
		_, err := tcpConn.Write(b)
		return err
	}, telnetDefaultTerm)
	engine.startKeepalive(60 * time.Second)
	defer engine.destroy()

	_ = conn.WriteJSON(Envelope{Type: "ready", SessionID: t.ConnID, Cols: cols, Rows: rows,
		Extra: json.RawMessage(`{"protocol":"TELNET","encoding":"utf-8","warning":"Telnet 未加密；凭据以明文传输"}`)})

	// TCP -> browser
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := tcpConn.Read(buf)
			if n > 0 {
				processed := engine.feed(buf[:n])
				if len(processed) > 0 {
					_ = conn.WriteJSON(Envelope{Type: "data", SessionID: t.ConnID, Data: string(processed)})
				}
			}
			if err != nil {
				code := "telnet_remote_close"
				msg := "对端关闭了 Telnet 连接"
				if err != io.EOF {
					code = "telnet_error"
					msg = "Telnet 连接异常断开: " + err.Error()
				}
				_ = conn.WriteJSON(Envelope{Type: "close", Code: code, Message: msg})
				return
			}
		}
	}()

	// Browser -> TCP
	for {
		var msg Envelope
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		switch msg.Type {
		case "input":
			if _, err := tcpConn.Write([]byte(msg.Data)); err != nil {
				return
			}
		case "resize":
			c := msg.Cols
			r := msg.Rows
			if c < 1 {
				c = 80
			}
			if r < 1 {
				r = 24
			}
			_ = telnetSendNAWS(tcpConn, c, r)
		case "close":
			return
		}
	}
}

// Ensure io is referenced (used by session.go)
var _ = io.EOF
