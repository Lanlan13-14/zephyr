package link

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
)

// Minimal RFC 6455 WebSocket server over the standard library, sufficient for the
// Link stream channel (text frames carrying sealed envelopes, plus control frames).

const wsMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var errNotWebSocket = errors.New("not a websocket upgrade")

func wsAccept(key string) string {
	h := sha1.Sum([]byte(key + wsMagic))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// handleStream upgrades to WebSocket and relays sealed frames for an established
// session. The session id arrives as a query parameter; a peer that cannot prove
// key possession is rejected before any frame is read.
func (n *Node) handleStream(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return
	}
	sessionID := r.URL.Query().Get("sessionId")
	n.mu.Lock()
	ep := n.sessions[sessionID]
	n.mu.Unlock()
	if ep == nil {
		http.Error(w, "session unknown", http.StatusUnauthorized)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		conn.Close()
		return
	}
	rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n")
	rw.WriteString("Upgrade: websocket\r\n")
	rw.WriteString("Connection: Upgrade\r\n")
	rw.WriteString("Sec-WebSocket-Accept: " + wsAccept(key) + "\r\n\r\n")
	if err := rw.Flush(); err != nil {
		conn.Close()
		return
	}
	go n.serveStream(conn, rw.Reader, sessionID, ep)
}

// serveStream reads client frames and answers each sealed frame with an ack. The
// loop owns the connection; any protocol or crypto error closes it.
func (n *Node) serveStream(conn net.Conn, br *bufio.Reader, sessionID string, ep *Endpoint) {
	defer conn.Close()
	defer func() { n.mu.Lock(); delete(n.sessions, sessionID); n.mu.Unlock() }()
	for {
		op, payload, err := readFrame(br)
		if err != nil {
			return
		}
		switch op {
		case 0x8: // close
			writeFrame(conn, 0x8, nil)
			return
		case 0x9: // ping -> pong
			writeFrame(conn, 0xA, payload)
			continue
		case 0x1, 0x2, 0x0: // text/binary/continuation
		default:
			return
		}
		var env Envelope
		if err := json.Unmarshal(payload, &env); err != nil {
			return
		}
		frame, err := ep.Receive(&env)
		if err != nil {
			return
		}
		ack, err := ep.Send(2, map[string]any{"receivedKind": frame.Kind, "ok": true}, false)
		if err != nil {
			return
		}
		out, _ := json.Marshal(ack)
		if err := writeFrame(conn, 0x1, out); err != nil {
			return
		}
	}
}

// readFrame parses one RFC 6455 frame. Client frames must be masked; this server
// enforces that (an unmasked client frame is a protocol violation).
func readFrame(br *bufio.Reader) (opcode byte, payload []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(br, hdr[:]); err != nil {
		return 0, nil, err
	}
	opcode = hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	if length == 126 {
		var b [2]byte
		if _, err = io.ReadFull(br, b[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(b[:]))
	} else if length == 127 {
		var b [8]byte
		if _, err = io.ReadFull(br, b[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(b[:])
	}
	if length > 8<<20 {
		return 0, nil, errors.New("frame too large")
	}
	var maskKey [4]byte
	if masked {
		if _, err = io.ReadFull(br, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}
	payload = make([]byte, length)
	if _, err = io.ReadFull(br, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return opcode, payload, nil
}

// writeFrame emits a server (unmasked) frame.
func writeFrame(conn net.Conn, opcode byte, payload []byte) error {
	var hdr []byte
	b0 := 0x80 | opcode
	switch {
	case len(payload) < 126:
		hdr = []byte{b0, byte(len(payload))}
	case len(payload) < 65536:
		hdr = []byte{b0, 126, byte(len(payload) >> 8), byte(len(payload))}
	default:
		hdr = make([]byte, 10)
		hdr[0] = b0
		hdr[1] = 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(len(payload)))
	}
	if _, err := conn.Write(hdr); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}
