package link

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// Minimal RFC 6455 WebSocket over the standard library, sufficient for the
// Link stream channel (text frames carrying sealed envelopes, plus control
// frames). Production traffic always hops through Node's `ws` library, so the
// handshake and the client MASK bit have to match what `ws` actually accepts
// — Go-to-Go tests cannot see that hop.

const wsMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

var errNotWebSocket = errors.New("not a websocket upgrade")

// wsAccept is the RFC 6455 Sec-WebSocket-Accept value: standard base64
// (with padding) of SHA-1(key + magic). RawURLEncoding here made Node's `ws`
// client — the hop that proxies /api/link/v2/stream onto this handler —
// reject the upgrade with "Invalid Sec-WebSocket-Accept header", so the Agent
// never attached a stream and every bastion dial died as "no live stream".
func wsAccept(key string) string {
	h := sha1.Sum([]byte(key + wsMagic))
	return base64.StdEncoding.EncodeToString(h[:])
}

// newWSClientKey returns a RFC 6455 Sec-WebSocket-Key: 16 random bytes,
// standard base64 (24 characters, ending in "=="). Node's `ws` library
// (keyRegex = /^[+/0-9A-Za-z]{22}==$/) is the public upgrade gate; a
// printable "zephyr-link-<ts>" key is rejected with 400 and the Agent never
// attaches /link/stream.
func newWSClientKey() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(raw), nil
}

func validSecWebSocketKey(key string) bool {
	if len(key) != 24 || !strings.HasSuffix(key, "==") {
		return false
	}
	decoded, err := base64.StdEncoding.DecodeString(key)
	return err == nil && len(decoded) == 16
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
	if !validSecWebSocketKey(key) {
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
	// Every server frame on this WebSocket — push data, request acknowledgements,
	// pong and close controls — must pass through one writer. writeServerFrame
	// emits its header and payload in separate writes, so independent locks let
	// those bytes interleave and corrupt the stream under keepalive traffic.
	push := &streamPushWriter{conn: conn}
	defer func() {
		// Dropping the stream must not kill the session itself: the session
		// belongs to the dial; the stream is only one carrier for it. A peer
		// may re-attach a fresh stream. The retiring stream may only unregister
		// itself; deleting a successor leaves an online Agent with no push path.
		n.mu.Lock()
		if n.streamWriters[sessionID] == push {
			delete(n.streamWriters, sessionID)
		}
		n.mu.Unlock()
	}()
	// Register the server-push path so the main end can originate sealed frames
	// on this stream (Agent bastion tunnels need server-initiated data).
	n.mu.Lock()
	if n.streamWriters == nil {
		n.streamWriters = make(map[string]*streamPushWriter)
	}
	n.streamWriters[sessionID] = push
	n.mu.Unlock()
	for {
		op, payload, err := readFrame(br)
		if err != nil {
			return
		}
		switch op {
		case 0x8: // close
			_ = push.writeFrame(0x8, nil)
			return
		case 0x9: // ping -> pong
			if err := push.writeFrame(0xA, payload); err != nil {
				return
			}
			continue
		case 0xA: // unsolicited pong is legal and has no business payload
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
		// Dispatch to the per-kind business handler rather than echoing the kind,
		// mirroring handleFrame so the stream and request lanes behave identically.
		replyKind, replyBody, replySecret, derr := n.dispatch.Dispatch(&FrameContext{SessionID: sessionID}, frame)
		if derr != nil {
			return
		}
		if replyBody == nil {
			replyKind, replyBody, replySecret = codec.KindSyncAck, map[string]any{"receivedKind": frame.Kind, "ok": true}, false
		}
		ack, err := ep.Send(replyKind, replyBody, replySecret)
		if err != nil {
			return
		}
		out, _ := json.Marshal(ack)
		if err := push.write(out); err != nil {
			return
		}
	}
}

// streamPushWriter lets the owning host push server-originated sealed envelopes
// onto a live stream connection. Tunnels are the first user; the request-reply
// lanes above are untouched.
type streamPushWriter struct {
	mu   sync.Mutex
	conn net.Conn
}

func (w *streamPushWriter) writeFrame(opcode byte, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeServerFrame(w.conn, opcode, payload)
}

func (w *streamPushWriter) write(env []byte) error {
	return w.writeFrame(0x1, env)
}

// PushStreamFrame seals body under the named session and writes it to that
// session's live stream, if any. It returns an error when the session has no
// attached stream (the /link/push HTTP lane or a fresh dial is then the only
// way to reach the peer).
func (n *Node) PushStreamFrame(sessionID string, kind int, body any, secret bool) error {
	n.mu.Lock()
	ep := n.sessions[sessionID]
	w := n.streamWriters[sessionID]
	n.mu.Unlock()
	if ep == nil || w == nil {
		return fmt.Errorf("link: session %s has no live stream", sessionID)
	}
	env, err := ep.Send(kind, body, secret)
	if err != nil {
		return err
	}
	raw, err := json.Marshal(env)
	if err != nil {
		return err
	}
	return w.write(raw)
}

// readFrame parses one RFC 6455 frame. Client frames must be masked; this
// server still accepts both so a Go-to-Go unit test (unmasked, because it
// never hops through Node) keeps working. Production always hops through
// Node's `ws`, which requires the MASK bit on every client frame.
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

func frameHeader(opcode byte, payloadLen int, masked bool) []byte {
	b0 := byte(0x80 | opcode)
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	switch {
	case payloadLen < 126:
		return []byte{b0, maskBit | byte(payloadLen)}
	case payloadLen < 65536:
		return []byte{b0, maskBit | 126, byte(payloadLen >> 8), byte(payloadLen)}
	default:
		hdr := make([]byte, 10)
		hdr[0] = b0
		hdr[1] = maskBit | 127
		binary.BigEndian.PutUint64(hdr[2:], uint64(payloadLen))
		return hdr
	}
}

// writeServerFrame emits a server (unmasked) frame. RFC 6455 §5.1: a server
// MUST NOT mask frames it sends to a client.
func writeServerFrame(conn net.Conn, opcode byte, payload []byte) error {
	if payload == nil {
		payload = []byte{}
	}
	hdr := frameHeader(opcode, len(payload), false)
	if _, err := conn.Write(hdr); err != nil {
		return err
	}
	_, err := conn.Write(payload)
	return err
}

// writeClientFrame emits a client (masked) frame. RFC 6455 §5.1: a client
// MUST mask every frame it sends to a server. Node's `ws` as a server
// drops unmasked frames with 1002 WS_ERR_EXPECTED_MASK, which is what
// killed the Agent's stream after a successful-looking 101: the first
// envelope never arrived, so the main end never saw a live streamWriter.
func writeClientFrame(conn net.Conn, opcode byte, payload []byte) error {
	if payload == nil {
		payload = []byte{}
	}
	mask := make([]byte, 4)
	if _, err := rand.Read(mask); err != nil {
		return err
	}
	masked := make([]byte, len(payload))
	for i := range payload {
		masked[i] = payload[i] ^ mask[i%4]
	}
	hdr := frameHeader(opcode, len(payload), true)
	if _, err := conn.Write(hdr); err != nil {
		return err
	}
	if _, err := conn.Write(mask); err != nil {
		return err
	}
	_, err := conn.Write(masked)
	return err
}

// writeFrame is the historical name used by the loopback zft2 socket, which
// is a server talking to a Dart WebSocket client and so must stay unmasked.
func writeFrame(conn net.Conn, opcode byte, payload []byte) error {
	return writeServerFrame(conn, opcode, payload)
}
