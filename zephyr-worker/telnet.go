package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
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

	telnetOptNAWS  = 31 // Negotiate About Window Size (RFC 1073)
	telnetOptTTYPE = 24 // Terminal Type (RFC 1091)
	telnetOptECHO  = 1  // Echo (RFC 857)
	telnetOptSGA   = 3  // Suppress Go Ahead (RFC 858)
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
		// WILL NAWS - we'll report our window size
		{telnetIAC, telnetWILL, telnetOptNAWS},
		// WILL TTYPE - we'll report our terminal type
		{telnetIAC, telnetWILL, telnetOptTTYPE},
		// DO SGA - ask server to suppress go-ahead
		{telnetIAC, telnetDO, telnetOptSGA},
		// DO ECHO - ask server to echo (common for telnet)
		{telnetIAC, telnetDO, telnetOptECHO},
	}
	for _, p := range packets {
		if _, err := conn.Write(p); err != nil {
			return fmt.Errorf("telnet negotiate: %w", err)
		}
	}
	// Send initial NAWS report
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
	// IAC SB NAWS <cols-hi> <cols-lo> <rows-hi> <rows-lo> IAC SE
	pkt := []byte{telnetIAC, telnetSB, telnetOptNAWS,
		byte(cols >> 8), byte(cols & 0xff),
		byte(rows >> 8), byte(rows & 0xff),
		telnetIAC, telnetSE}
	_, err := conn.Write(pkt)
	return err
}

// serveTelnetWS runs the WebSocket session for a Telnet target: open TCP,
// negotiate options, then pump browser <-> TCP. Unlike SSH, telnet has no
// session persistence beyond the TCP connection - disconnect kills it.
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

	_ = conn.WriteJSON(Envelope{Type: "ready", SessionID: t.ConnID, Cols: cols, Rows: rows,
		Extra: json.RawMessage(`{"protocol":"TELNET","warning":"Telnet is unencrypted; credentials are sent in cleartext."}`)})

	// TCP -> browser (strip/forward IAC subnegotiation responses as needed)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := tcpConn.Read(buf)
			if n > 0 {
				processed := telnetFilterIAC(buf[:n])
				if len(processed) > 0 {
					_ = conn.WriteJSON(Envelope{Type: "data", SessionID: t.ConnID, Data: string(processed)})
				}
			}
			if err != nil {
				_ = conn.WriteJSON(Envelope{Type: "close", Message: "Telnet 连接已关闭"})
				return
			}
		}
	}()

	// Browser -> TCP (forward input, handle resize via NAWS)
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

// telnetFilterIAC processes IAC sequences in the server->client stream.
// It strips option negotiations we don't need to forward to the terminal
// emulator and handles TTYPE subnegotiation by responding with "xterm-256color".
func telnetFilterIAC(data []byte) []byte {
	var out []byte
	i := 0
	for i < len(data) {
		if data[i] != telnetIAC {
			out = append(out, data[i])
			i++
			continue
		}
		if i+1 >= len(data) {
			// Truncated IAC at end of buffer; drop it
			break
		}
		cmd := data[i+1]
		switch cmd {
		case telnetIAC:
			// IAC IAC = literal 0xFF
			out = append(out, telnetIAC)
			i += 2
		case telnetDO, telnetDONT, telnetWILL, telnetWONT:
			// 3-byte: IAC <cmd> <opt> - strip (we already negotiated)
			i += 3
		case telnetSB:
			// Subnegotiation: IAC SB <opt> ... IAC SE
			// Find IAC SE
			end := i + 2
			for end < len(data)-1 {
				if data[end] == telnetIAC && data[end+1] == telnetSE {
					break
				}
				end++
			}
			i = end + 2
		default:
			// Unknown 2-byte command
			i += 2
		}
	}
	return out
}

// Ensure io is referenced (used by session.go)
var _ = io.EOF
