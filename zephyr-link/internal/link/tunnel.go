package link

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// AgentTunnel carries a bastion byte stream between the main end and an
// enrolled Agent over the encrypted Link stream channel. Both directions ride
// sealed AGENT_TUNNEL frames on /link/stream; the Node front end only ever
// shuttles ciphertext, and no tunnel byte touches plaintext outside the two
// ZSL/2 session endpoints.
//
// Wire body (inside the sealed envelope, identical on both ends):
//
//	{"tun": <tunnel id>, "op": "open"|"data"|"close"|"err",
//	 "host": "...", "port": 22, "seq": N, "data": "<base64>"}
//
// The main end is the tunnel initiator: it sends open, the Agent answers open
// (ack) or err. Data frames flow both ways; close is idempotent.

const (
	tunnelMaxDataBytes   = 256 * 1024 // per-frame plaintext cap, matches ZFT2 chunk sizing
	tunnelDialTimeout    = 12 * time.Second
	tunnelWriteTimeout   = 15 * time.Second
	// Idle timeout applies to the Agent-side TCP hop toward the SSH target.
	// 5 minutes used to tear down a live session the moment the user paused
	// at a prompt; 30 minutes still reclaims abandoned sockets without
	// interrupting an interactive shell.
	tunnelIdleTimeout    = 30 * time.Minute
	tunnelChannelBufSize = 64
	// WebSocket ping keeps NAT / reverse-proxy idle timeouts from dropping
	// /link/stream when no AGENT_TUNNEL frames are in flight. Both Agent and
	// One initiator hubs send these; the peer answers with pong.
	tunnelPingInterval = 20 * time.Second
)

type tunnelFrame struct {
	Tun  int    `json:"tun"`
	Op   string `json:"op"`
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	Seq  int64  `json:"seq,omitempty"`
	Data string `json:"data,omitempty"`
	Err  string `json:"err,omitempty"`
	// Lane names the traffic class. Empty means a plain TCP tunnel; "zft2"
	// routes the bytes to the Agent host's ZFT2 dispatcher instead of a TCP
	// dial, so the file protocol can ride the encrypted stream without any
	// plaintext hop. "one-relay" is a One-originated open: the main end
	// splices it onto an Agent bastion tunnel after authorizing the caller.
	Lane string `json:"lane,omitempty"`
	// AgentID is set on one-relay opens so the main end can pick which
	// enrolled Agent to dial through. Empty on Agent-originated frames.
	AgentID string `json:"agentId,omitempty"`
}

// tunnelStreamConn is the raw client side of /link/stream: it POSTs nothing,
// it upgrades and relays sealed envelopes both ways.
type tunnelStreamConn struct {
	conn   net.Conn
	br     *bufio.Reader
	wmu    sync.Mutex
	closed bool
}

func (t *tunnelStreamConn) writeEnvelope(env []byte) error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if t.closed {
		return errors.New("tunnel: stream closed")
	}
	// Client-to-server: MASK is mandatory. Node's ws (the public hop)
	// drops unmasked frames, which is why a 101 upgrade still left the
	// main end with "session has no live stream".
	return writeClientFrame(t.conn, 0x1, env)
}

func (t *tunnelStreamConn) readEnvelope() ([]byte, error) {
	for {
		op, payload, err := readFrame(t.br)
		if err != nil {
			return nil, err
		}
		switch op {
		case 0x8:
			return nil, io.EOF
		case 0x9: // ping -> pong keeps middleboxes from idling the stream
			t.wmu.Lock()
			_ = writeClientFrame(t.conn, 0xA, payload)
			t.wmu.Unlock()
			continue
		case 0x1, 0x2, 0x0:
			return payload, nil
		default:
			return nil, errors.New("tunnel: bad stream opcode")
		}
	}
}

func (t *tunnelStreamConn) ping() error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if t.closed {
		return errors.New("tunnel: stream closed")
	}
	return writeClientFrame(t.conn, 0x9, nil)
}

func (t *tunnelStreamConn) Close() error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	_ = writeClientFrame(t.conn, 0x8, nil)
	return t.conn.Close()
}

// streamPeerIdentity restores the original hostname when the peer URL was
// rewritten to an IP literal at dial time. TLS SNI and the HTTP Host header
// must be the hostname; connecting to the IP with SNI=IP fails certificate
// verification and vhost routing, which surfaces as "session has no live stream"
// on the main end because the Agent never attached /link/stream.
func streamPeerIdentity(parsed *url.URL, rememberedSNI string) (sni, httpHost string) {
	sni = strings.TrimSpace(rememberedSNI)
	if sni == "" {
		sni = parsed.Hostname()
	}
	httpHost = parsed.Host
	if net.ParseIP(parsed.Hostname()) != nil && sni != "" && net.ParseIP(sni) == nil {
		port := parsed.Port()
		if port == "" || (parsed.Scheme == "https" && port == "443") || (parsed.Scheme == "http" && port == "80") {
			httpHost = sni
		} else {
			httpHost = net.JoinHostPort(sni, port)
		}
	}
	return sni, httpHost
}

// dialTunnelStream upgrades to /link/stream on the peer for an established
// session, using the TLS profile remembered at dial time.
func (n *Node) dialTunnelStream(peerURL, sessionID string) (*tunnelStreamConn, *Endpoint, error) {
	n.mu.Lock()
	ep := n.sessions[sessionID]
	tlsProfile := n.sessionTLS[sessionID]
	n.mu.Unlock()
	if ep == nil {
		return nil, nil, fmt.Errorf("link: session %s not established", sessionID)
	}
	streamURL := strings.TrimSuffix(peerURL, "/") + "/stream?sessionId=" + url.QueryEscape(sessionID)
	parsed, err := url.Parse(streamURL)
	if err != nil {
		return nil, nil, err
	}
	hostPort := parsed.Host
	if parsed.Port() == "" {
		if parsed.Scheme == "https" {
			hostPort = net.JoinHostPort(parsed.Hostname(), "443")
		} else {
			hostPort = net.JoinHostPort(parsed.Hostname(), "80")
		}
	}
	sni, httpHost := streamPeerIdentity(parsed, tlsProfile.serverName)
	var d net.Dialer
	raw, err := d.DialContext(context.Background(), "tcp", hostPort)
	if err != nil {
		return nil, nil, err
	}
	if parsed.Scheme == "https" {
		tc := &tls.Config{ServerName: sni, MinVersion: tls.VersionTLS12}
		if tlsProfile.insecure {
			tc.InsecureSkipVerify = true
		} else if net.ParseIP(parsed.Hostname()) != nil && net.ParseIP(sni) == nil {
			roots, err := x509.SystemCertPool()
			if err != nil {
				raw.Close()
				return nil, nil, fmt.Errorf("link: system CA pool: %w", err)
			}
			if roots == nil {
				roots = x509.NewCertPool()
			}
			tc.RootCAs = roots
		}
		raw = tls.Client(raw, tc)
	}
	key, err := newWSClientKey()
	if err != nil {
		raw.Close()
		return nil, nil, err
	}
	var hdr bytes.Buffer
	hdr.WriteString("GET " + parsed.RequestURI() + " HTTP/1.1\r\n")
	hdr.WriteString("Host: " + httpHost + "\r\n")
	hdr.WriteString("Upgrade: websocket\r\nConnection: Upgrade\r\n")
	hdr.WriteString("Sec-WebSocket-Key: " + key + "\r\n")
	hdr.WriteString("Sec-WebSocket-Version: 13\r\n\r\n")
	if _, err := raw.Write(hdr.Bytes()); err != nil {
		raw.Close()
		return nil, nil, err
	}
	br := bufio.NewReaderSize(raw, 64*1024)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		raw.Close()
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusSwitchingProtocols {
		resp.Body.Close()
		raw.Close()
		return nil, nil, fmt.Errorf("tunnel: stream upgrade failed: %s", resp.Status)
	}
	wantAccept := wsAccept(key)
	gotAccept := strings.TrimSpace(resp.Header.Get("Sec-WebSocket-Accept"))
	if gotAccept != wantAccept {
		resp.Body.Close()
		raw.Close()
		return nil, nil, fmt.Errorf("tunnel: bad Sec-WebSocket-Accept")
	}
	// Do NOT close resp.Body here: for a 101 the body is the hijacked raw
	// connection; closing it would tear down the stream we just upgraded.
	_ = resp
	return &tunnelStreamConn{conn: raw, br: br}, ep, nil
}

// ───────────────────────── Agent side ─────────────────────────
// The embedded Agent process listens for open frames and bridges them to local
// TCP dials. The host (Dart/Kotlin) only names targets; all bytes are pumped
// by the Go core under the session keys.

type agentTunnel struct {
	id     int
	conn   net.Conn
	seqIn  int64
	closed bool
	// zft2 marks a lane tunnel whose conn is a Zft2Lane pipe, not TCP.
	zft2 bool
}

type AgentTunnelHub struct {
	mu      sync.Mutex
	node    *Node
	peerURL string
	// sessionID is the Link session the current stream runs on. It changes
	// on every reconnect.
	sessionID string
	// generation counts Start calls. The pump goroutines carry the stamp they
	// were launched with, so a stale loop that dies after a restart cannot
	// tear down its successor's stream.
	generation uint64
	tunnels    map[int]*agentTunnel
	nextID     int
	stream     *tunnelStreamConn
	ep         *Endpoint
	out        chan tunnelFrame
	ctx        context.Context
	cancel     context.CancelFunc
	readyCh    chan struct{}
	// zft2Conn/zft2WriteMu serialize writes onto the local zft2 socket.
	zft2Conn    net.Conn
	zft2WriteMu *sync.Mutex
	// OnLinkLost fires when the stream dies so the host can re-dial.
	OnLinkLost func()
	// OnZft2Open hands a zft2-lane tunnel's byte pipe to the host (Dart via
	// MethodChannel on Android). When nil, a zft2 open is refused.
	OnZft2Open func(t *Zft2Lane)
}

// Zft2Lane is one zft2-lane tunnel: bytes the main end sealed into the stream
// arrive here; the host writes replies back through the returned writer.
type Zft2Lane struct {
	hub  *AgentTunnelHub
	id   int
	in   chan []byte
	dead chan struct{}
	once sync.Once
}

// LocalAddr reports a synthetic address for the zft2 lane.
func (l *Zft2Lane) LocalAddr() net.Addr { return laneAddr("zft2-local") }

// RemoteAddr reports a synthetic address for the zft2 lane.
func (l *Zft2Lane) RemoteAddr() net.Addr { return laneAddr("zft2-peer") }

// SetDeadline is a no-op; lane pacing is governed by the stream, not timers.
func (l *Zft2Lane) SetDeadline(time.Time) error { return nil }

// SetReadDeadline is a no-op; the lane blocks until data or close.
func (l *Zft2Lane) SetReadDeadline(time.Time) error { return nil }

// SetWriteDeadline is a no-op; writes queue under the stream's own backpressure.
func (l *Zft2Lane) SetWriteDeadline(time.Time) error { return nil }

type laneAddr string

func (a laneAddr) Network() string { return "zft2-lane" }
func (a laneAddr) String() string  { return string(a) }

func (l *Zft2Lane) Read(p []byte) (int, error) {
	select {
	case data, ok := <-l.in:
		if !ok || len(data) == 0 {
			return 0, io.EOF
		}
		n := copy(p, data)
		return n, nil
	case <-l.dead:
		return 0, io.EOF
	}
}

func (l *Zft2Lane) Write(p []byte) (int, error) {
	select {
	case <-l.dead:
		return 0, io.ErrClosedPipe
	default:
	}
	chunk := tunnelMaxDataBytes
	for offset := 0; offset < len(p); offset += chunk {
		end := offset + chunk
		if end > len(p) {
			end = len(p)
		}
		l.hub.out <- tunnelFrame{Tun: l.id, Op: "data", Data: base64.StdEncoding.EncodeToString(p[offset:end]), Lane: "zft2"}
	}
	return len(p), nil
}

func (l *Zft2Lane) Close() error {
	l.once.Do(func() {
		close(l.dead)
		l.hub.out <- tunnelFrame{Tun: l.id, Op: "close", Lane: "zft2"}
	})
	return nil
}

func NewAgentTunnelHub(node *Node) *AgentTunnelHub {
	return &AgentTunnelHub{node: node, tunnels: make(map[int]*agentTunnel), out: make(chan tunnelFrame, tunnelChannelBufSize)}
}

// Start connects the stream channel and serves tunnel frames until the stream
// dies. It blocks; the host runs it on a worker thread.
//
// Start is restartable. An Agent that reconnects calls it again with the new
// session id, so any previous stream and its pump goroutines are retired here
// first. Each run carries a generation stamp: a late-dying old read loop can
// then recognise that it no longer owns the hub and must not tear down the
// stream its successor just installed.
func (h *AgentTunnelHub) Start(peerURL, sessionID string) error {
	stream, ep, err := h.node.dialTunnelStream(peerURL, sessionID)
	if err != nil {
		return err
	}
	h.mu.Lock()
	prevStream, prevCancel := h.stream, h.cancel
	h.generation++
	generation := h.generation
	h.stream = stream
	h.ep = ep
	h.peerURL = peerURL
	h.sessionID = sessionID
	h.ctx, h.cancel = context.WithCancel(context.Background())
	ready := make(chan struct{})
	close(ready)
	h.readyCh = ready
	h.mu.Unlock()
	// Retire the previous run outside the lock: its goroutines take the same
	// mutex on their way out.
	if prevCancel != nil {
		prevCancel()
	}
	if prevStream != nil {
		prevStream.Close()
	}
	go h.writeLoop(generation)
	go h.readLoop(generation)
	go h.pingLoop(generation)
	return nil
}

// SessionID reports the Link session the hub's stream is running on.
func (h *AgentTunnelHub) SessionID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessionID
}

// ServeZft2Local bridges every zft2 lane onto one loopback WebSocket for the
// host (Dart). Wire per binary message: [lane id u32 BE][ZFT2 frame bytes].
// Host→main-end: socket frames write into the lane (sealed onto the stream).
// Main-end→host: a per-lane goroutine forwards lane bytes onto the socket.
func (h *AgentTunnelHub) ServeZft2Local(conn net.Conn, br *bufio.Reader) {
	defer conn.Close()
	writeMu := new(sync.Mutex)
	h.mu.Lock()
	h.zft2Conn = conn
	h.zft2WriteMu = writeMu
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.zft2Conn = nil
		h.zft2WriteMu = nil
		h.mu.Unlock()
	}()
	for {
		op, payload, err := readFrame(br)
		if err != nil {
			return
		}
		switch op {
		case 0x8:
			writeFrame(conn, 0x8, nil)
			return
		case 0x9:
			writeFrame(conn, 0xA, payload)
			continue
		case 0x1, 0x2, 0x0:
		default:
			return
		}
		if len(payload) < 4 {
			return
		}
		laneID := int(binary.BigEndian.Uint32(payload[:4]))
		h.mu.Lock()
		t := h.tunnels[laneID]
		h.mu.Unlock()
		if t == nil || !t.zft2 {
			continue
		}
		if _, err := t.conn.Write(payload[4:]); err != nil {
			h.closeTunnel(laneID, "zft2 local write failed")
		}
	}
}

// pumpZft2LaneToSocket forwards one lane's main-end bytes onto the local
// zft2 socket with the [id][bytes] prefix.
func (h *AgentTunnelHub) pumpZft2LaneToSocket(l *Zft2Lane) {
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(l.id))
	for {
		buf := make([]byte, tunnelMaxDataBytes)
		n, err := l.Read(buf)
		if err != nil || n == 0 {
			return
		}
		h.mu.Lock()
		conn := h.zft2Conn
		mu := h.zft2WriteMu
		h.mu.Unlock()
		if conn == nil || mu == nil {
			return
		}
		out := make([]byte, 4+n)
		copy(out, header)
		copy(out[4:], buf[:n])
		mu.Lock()
		err = writeFrame(conn, 0x2, out)
		mu.Unlock()
		if err != nil {
			return
		}
	}
}

// Ready resolves once the stream is attached and loops are running. Calling
// before Start returns a channel that resolves on the next successful Start.
func (h *AgentTunnelHub) Ready() <-chan struct{} {
	h.mu.Lock()
	if h.readyCh != nil {
		defer h.mu.Unlock()
		return h.readyCh
	}
	h.mu.Unlock()
	// No Start yet (or a fresh hub): poll until one lands. Bounded by the
	// caller's own select deadline.
	late := make(chan struct{})
	go func() {
		for {
			h.mu.Lock()
			ch := h.readyCh
			h.mu.Unlock()
			if ch != nil {
				select {
				case <-ch:
					close(late)
				case <-time.After(50 * time.Millisecond):
				}
				if ch != h.readyCh {
					continue
				}
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	}()
	return late
}

// closeAll tears down the run identified by generation. A stale caller (the
// read loop of a stream that died after Start already installed a successor)
// is ignored, so a reconnect is never torn down by its predecessor.
func (h *AgentTunnelHub) closeAll(generation uint64, reason string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if generation != h.generation {
		return false
	}
	if h.cancel != nil {
		h.cancel()
	}
	for id, t := range h.tunnels {
		t.conn.Close()
		delete(h.tunnels, id)
	}
	h.stream = nil
	h.ep = nil
	return true
}

func (h *AgentTunnelHub) readLoop(generation uint64) {
	defer func() {
		// Only the current run may report the link as lost: a stale loop
		// firing OnLinkLost would make the host re-dial a healthy stream.
		if h.closeAll(generation, "link stream closed") && h.OnLinkLost != nil {
			h.OnLinkLost()
		}
	}()
	for {
		h.mu.Lock()
		stream, ep := h.stream, h.ep
		current := h.generation
		h.mu.Unlock()
		if stream == nil || ep == nil || current != generation {
			return
		}
		payload, err := stream.readEnvelope()
		if err != nil {
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
		if frame.Kind != codec.KindAgentTunnel {
			continue
		}
		var tf tunnelFrame
		if err := codec.Decode(frame.Body, &tf); err != nil {
			continue
		}
		h.handleFrame(&tf)
	}
}

func (h *AgentTunnelHub) writeLoop(generation uint64) {
	for {
		h.mu.Lock()
		ctx, stream, ep := h.ctx, h.stream, h.ep
		current := h.generation
		h.mu.Unlock()
		if ctx == nil || stream == nil || ep == nil || current != generation {
			return
		}
		select {
		case <-ctx.Done():
			return
		case tf := <-h.out:
			env, err := ep.Send(codec.KindAgentTunnel, tf, false)
			if err != nil {
				return
			}
			raw, _ := json.Marshal(env)
			if err := stream.writeEnvelope(raw); err != nil {
				return
			}
		}
	}
}

func (h *AgentTunnelHub) pingLoop(generation uint64) {
	ticker := time.NewTicker(tunnelPingInterval)
	defer ticker.Stop()
	for {
		h.mu.Lock()
		ctx, stream := h.ctx, h.stream
		current := h.generation
		h.mu.Unlock()
		if ctx == nil || stream == nil || current != generation {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := stream.ping(); err != nil {
				return
			}
		}
	}
}

func (h *AgentTunnelHub) handleFrame(tf *tunnelFrame) {
	switch tf.Op {
	case "open":
		if tf.Lane == "zft2" {
			go h.openZft2Lane(tf)
			return
		}
		go h.openTunnel(tf)
	case "data":
		h.mu.Lock()
		t := h.tunnels[tf.Tun]
		h.mu.Unlock()
		if t == nil || t.closed {
			return
		}
		data, err := base64.StdEncoding.DecodeString(tf.Data)
		if err != nil {
			h.closeTunnel(tf.Tun, "bad base64")
			return
		}
		if len(data) > tunnelMaxDataBytes {
			h.closeTunnel(tf.Tun, "oversized frame")
			return
		}
		t.conn.SetWriteDeadline(time.Now().Add(tunnelWriteTimeout))
		if _, err := t.conn.Write(data); err != nil {
			h.closeTunnel(tf.Tun, "tcp write failed")
		}
	case "close":
		h.closeTunnel(tf.Tun, "peer closed")
	case "err":
		h.closeTunnel(tf.Tun, tf.Err)
	}
}

func (h *AgentTunnelHub) openTunnel(tf *tunnelFrame) {
	host := strings.TrimSpace(tf.Host)
	port := tf.Port
	if host == "" || port <= 0 || port > 65535 {
		h.out <- tunnelFrame{Tun: tf.Tun, Op: "err", Err: "invalid target"}
		return
	}
	d := net.Dialer{Timeout: tunnelDialTimeout}
	conn, err := d.Dial("tcp", net.JoinHostPort(host, fmt.Sprintf("%d", port)))
	if err != nil {
		h.out <- tunnelFrame{Tun: tf.Tun, Op: "err", Err: "dial failed: " + err.Error()}
		return
	}
	t := &agentTunnel{id: tf.Tun, conn: conn}
	h.mu.Lock()
	h.tunnels[tf.Tun] = t
	h.mu.Unlock()
	h.out <- tunnelFrame{Tun: tf.Tun, Op: "open", Seq: 0}
	go h.pumpTCP(tf.Tun, conn)
}

func (h *AgentTunnelHub) openZft2Lane(tf *tunnelFrame) {
	h.mu.Lock()
	cb := h.OnZft2Open
	h.mu.Unlock()
	if cb == nil {
		h.out <- tunnelFrame{Tun: tf.Tun, Op: "err", Err: "zft2 lane unavailable", Lane: "zft2"}
		return
	}
	lane := &Zft2Lane{hub: h, id: tf.Tun, in: make(chan []byte, tunnelChannelBufSize), dead: make(chan struct{})}
	t := &agentTunnel{id: tf.Tun, conn: lane, zft2: true}
	h.mu.Lock()
	h.tunnels[tf.Tun] = t
	h.mu.Unlock()
	h.out <- tunnelFrame{Tun: tf.Tun, Op: "open", Seq: 0, Lane: "zft2"}
	cb(lane)
	go h.pumpZft2LaneToSocket(lane)
}

func (h *AgentTunnelHub) pumpTCP(id int, conn net.Conn) {
	defer h.closeTunnel(id, "tcp eof")
	buf := make([]byte, tunnelMaxDataBytes)
	var seq int64
	for {
		conn.SetReadDeadline(time.Now().Add(tunnelIdleTimeout))
		n, err := conn.Read(buf)
		if n > 0 {
			seq++
			h.out <- tunnelFrame{Tun: id, Op: "data", Seq: seq, Data: base64.StdEncoding.EncodeToString(buf[:n])}
		}
		if err != nil {
			return
		}
	}
}

func (h *AgentTunnelHub) closeTunnel(id int, reason string) {
	h.mu.Lock()
	t := h.tunnels[id]
	if t != nil {
		delete(h.tunnels, id)
	}
	h.mu.Unlock()
	if t == nil || t.closed {
		return
	}
	t.closed = true
	t.conn.Close()
	select {
	case h.out <- tunnelFrame{Tun: id, Op: "close"}:
	default:
	}
}

// ───────────────────────── Main-end side ─────────────────────────
// MainEndTunnel is the net.Conn the server's SSH stack sees. Every Write is
// sealed into an AGENT_TUNNEL data frame toward the Agent; every Read blocks on
// frames coming back. Nothing here touches the agent's file or legacy lanes.

type MainEndTunnel struct {
	hub *MainEndTunnelHub
	// session names the Agent stream this tunnel rides on. Tunnel ids are
	// only unique within one Agent, so every routing decision needs the pair.
	session string
	id      int
	rbuf    bytes.Buffer
	rmu     sync.Mutex
	in      chan tunnelFrame
	dead    chan struct{}
	once    sync.Once
	seq     int64
}

func (c *MainEndTunnel) Read(p []byte) (int, error) {
	select {
	case tf := <-c.in:
		if tf.Op == "close" || tf.Op == "err" {
			if tf.Op == "err" && tf.Err != "" {
				return 0, fmt.Errorf("tunnel: %s", tf.Err)
			}
			return 0, io.EOF
		}
		if tf.Op != "data" {
			return 0, io.EOF
		}
		data, err := base64.StdEncoding.DecodeString(tf.Data)
		if err != nil {
			return 0, errors.New("tunnel: bad frame data")
		}
		n := copy(p, data)
		if n < len(data) {
			c.rmu.Lock()
			c.rbuf.Write(data[n:])
			c.rmu.Unlock()
		}
		return n, nil
	case <-c.dead:
		// Drain any buffered bytes before reporting EOF.
		c.rmu.Lock()
		defer c.rmu.Unlock()
		if c.rbuf.Len() > 0 {
			n, _ := c.rbuf.Read(p)
			return n, nil
		}
		return 0, io.EOF
	}
}

func (c *MainEndTunnel) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		chunk := p
		if len(chunk) > tunnelMaxDataBytes {
			chunk = chunk[:tunnelMaxDataBytes]
		}
		c.seq++
		if err := c.hub.send(c.session, tunnelFrame{Tun: c.id, Op: "data", Seq: c.seq, Data: base64.StdEncoding.EncodeToString(chunk)}); err != nil {
			return total - len(p), err
		}
		p = p[len(chunk):]
	}
	return total, nil
}

func (c *MainEndTunnel) Close() error {
	c.once.Do(func() {
		close(c.dead)
		_ = c.hub.send(c.session, tunnelFrame{Tun: c.id, Op: "close"})
		c.hub.drop(c)
	})
	return nil
}

func (c *MainEndTunnel) LocalAddr() net.Addr                { return tunnelAddr("main") }
func (c *MainEndTunnel) RemoteAddr() net.Addr               { return tunnelAddr("agent") }
func (c *MainEndTunnel) SetDeadline(t time.Time) error      { return nil }
func (c *MainEndTunnel) SetReadDeadline(t time.Time) error  { return nil }
func (c *MainEndTunnel) SetWriteDeadline(t time.Time) error { return nil }

type tunnelAddr string

func (tunnelAddr) Network() string { return "zephyr-link-tunnel" }
func (a tunnelAddr) String() string { return string(a) }

// MainEndTunnelHub is embedded in zephyr-link-server. It multiplexes every
// attached Agent stream session; DialTunnel returns a connected net.Conn on
// the session the caller names.
//
// Keying by session is load-bearing. An Agent that reconnects comes back on a
// brand-new ZSL/2 session id, and a second bastion Agent is simply a second
// session. The hub used to hold one session id for the whole process and
// rejected every later attach with "hub already attached"; the Node front end
// swallowed that error and dialed anyway, which pushed onto the dead session
// and surfaced to the user as "session has no live stream".
type MainEndTunnelHub struct {
	mu   sync.Mutex
	node *Node
	// agents holds one lane table per attached Agent session. Tunnel ids are
	// only unique within a session, so every lookup takes the pair.
	agents map[string]*mainEndAgent
	// ones holds One-originated splices keyed by the One device's Link session.
	ones map[string]*oneInitiator
	// oneRelayAuth authorizes a One device to use a named Agent as a hop.
	oneRelayAuth OneRelayAuth
	// routed records that the AGENT_TUNNEL dispatch handler is installed.
	// Registering it twice would overwrite the first handler.
	routed bool
}

// mainEndAgent is one attached Agent: its live tunnels and the device the
// session was attested to at handshake.
type mainEndAgent struct {
	deviceID string
	tunnels  map[int]*MainEndTunnel
	nextID   int
}

func NewMainEndTunnelHub(node *Node) *MainEndTunnelHub {
	return &MainEndTunnelHub{
		node:   node,
		agents: make(map[string]*mainEndAgent),
		ones:   make(map[string]*oneInitiator),
	}
}

// Attach registers one Agent stream session on the hub and installs the shared
// AGENT_TUNNEL dispatch handler on first use. The Agent dials /link/stream in;
// its frames arrive through Dispatch carrying the session they arrived on, and
// the hub answers them through PushStreamFrame on that same live stream.
//
// Re-attaching a session that is already registered is a no-op, so the Node
// front end can call it before every dial without tracking state.
func (h *MainEndTunnelHub) Attach(sessionID string) error {
	if sessionID == "" {
		return errors.New("tunnel: attach needs a session id")
	}
	n := h.node
	n.mu.Lock()
	_, hasSession := n.sessions[sessionID]
	device := n.sessionDevice[sessionID]
	n.mu.Unlock()
	if !hasSession {
		return fmt.Errorf("link: agent session %s not established", sessionID)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if existing := h.agents[sessionID]; existing != nil {
		existing.deviceID = device
	} else {
		h.agents[sessionID] = &mainEndAgent{deviceID: device, tunnels: make(map[int]*MainEndTunnel)}
	}
	h.ensureRoutedLocked(n)
	return nil
}

// EnsureRouted installs the AGENT_TUNNEL dispatcher so One-originated
// one-relay opens are handled even before any Agent has attached.
func (h *MainEndTunnelHub) EnsureRouted() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.ensureRoutedLocked(h.node)
}

func (h *MainEndTunnelHub) ensureRoutedLocked(n *Node) {
	if !h.routed {
		h.routed = true
		n.Dispatcher().Register(codec.KindAgentTunnel, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
			var tf tunnelFrame
			if err := codec.Decode(fr.Body, &tf); err != nil {
				return 0, nil, false, err
			}
			// A One-originated open asks the main end to splice this session
			// onto an Agent bastion. Authorization lives in Node; Go only
			// splices after AuthorizeOneRelay returns an Agent session.
			if tf.Op == "open" && tf.Lane == "one-relay" {
				go h.openOneRelay(ctx.SessionID, &tf)
				return codec.KindAgentTunnel, map[string]any{"tun": tf.Tun, "ok": true}, false, nil
			}
			if h.isOneInitiator(ctx.SessionID) {
				h.deliverOne(ctx.SessionID, &tf)
				return codec.KindAgentTunnel, map[string]any{"tun": tf.Tun, "ok": true}, false, nil
			}
			// ctx.SessionID is the attested session the frame arrived on, so
			// one Agent can never address another Agent's tunnel ids.
			h.deliver(ctx.SessionID, &tf)
			// Tunnels are fire-and-forget per frame; the ack carries nothing.
			return codec.KindAgentTunnel, map[string]any{"tun": tf.Tun, "ok": true}, false, nil
		})
	}
}

// OneRelayAuth is the Node-side check that a One device may use a given Agent
// as a bastion hop. Returning ("", err) refuses the open.
type OneRelayAuth func(oneDeviceID, agentID, host string, port int) (agentSessionID string, err error)

// SetOneRelayAuth installs the authorization callback used by one-relay opens.
func (h *MainEndTunnelHub) SetOneRelayAuth(fn OneRelayAuth) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.oneRelayAuth = fn
}

type oneInitiator struct {
	deviceID string
	tunnels  map[int]*oneRelayTunnel
}

// oneRelayTunnel is one spliced hop: frames from One ride the Agent tunnel,
// and Agent bytes are pushed back onto the One stream.
type oneRelayTunnel struct {
	hub       *MainEndTunnelHub
	oneSess   string
	agentSess string
	oneTun    int
	agentConn net.Conn
	dead      chan struct{}
	once      sync.Once
}

func (h *MainEndTunnelHub) isOneInitiator(sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ones[sessionID] != nil
}

func (h *MainEndTunnelHub) deliverOne(sessionID string, tf *tunnelFrame) {
	h.mu.Lock()
	one := h.ones[sessionID]
	var t *oneRelayTunnel
	if one != nil {
		t = one.tunnels[tf.Tun]
	}
	h.mu.Unlock()
	if t == nil {
		return
	}
	if tf.Op == "close" || tf.Op == "err" {
		t.close()
		return
	}
	if tf.Op != "data" || t.agentConn == nil {
		return
	}
	data, err := base64.StdEncoding.DecodeString(tf.Data)
	if err != nil {
		t.close()
		return
	}
	if _, err := t.agentConn.Write(data); err != nil {
		t.close()
	}
}

func (h *MainEndTunnelHub) openOneRelay(oneSessionID string, tf *tunnelFrame) {
	refuse := func(msg string) {
		_ = h.node.PushStreamFrame(oneSessionID, codec.KindAgentTunnel, tunnelFrame{
			Tun: tf.Tun, Op: "err", Err: msg, Lane: "one-relay",
		}, false)
	}
	deviceID := h.node.sessionDeviceGet(oneSessionID)
	if deviceID == "" {
		refuse("one session has no attested device")
		return
	}
	h.mu.Lock()
	auth := h.oneRelayAuth
	h.mu.Unlock()
	if auth == nil {
		refuse("one-relay is not authorized on this server")
		return
	}
	agentSession, err := auth(deviceID, tf.AgentID, tf.Host, tf.Port)
	if err != nil {
		refuse(err.Error())
		return
	}
	if err := h.Attach(agentSession); err != nil {
		refuse(err.Error())
		return
	}
	agentConn, err := h.DialTunnel(agentSession, tf.Host, tf.Port)
	if err != nil {
		refuse(err.Error())
		return
	}
	t := &oneRelayTunnel{
		hub:       h,
		oneSess:   oneSessionID,
		agentSess: agentSession,
		oneTun:    tf.Tun,
		agentConn: agentConn,
		dead:      make(chan struct{}),
	}
	h.mu.Lock()
	one := h.ones[oneSessionID]
	if one == nil {
		one = &oneInitiator{deviceID: deviceID, tunnels: make(map[int]*oneRelayTunnel)}
		h.ones[oneSessionID] = one
	}
	one.tunnels[tf.Tun] = t
	h.mu.Unlock()
	if err := h.node.PushStreamFrame(oneSessionID, codec.KindAgentTunnel, tunnelFrame{
		Tun: tf.Tun, Op: "open", Lane: "one-relay",
	}, false); err != nil {
		t.close()
		return
	}
	go t.pumpAgentToOne()
}

func (t *oneRelayTunnel) pumpAgentToOne() {
	defer t.close()
	buf := make([]byte, tunnelMaxDataBytes)
	seq := int64(0)
	for {
		n, err := t.agentConn.Read(buf)
		if n > 0 {
			seq++
			if err := t.hub.node.PushStreamFrame(t.oneSess, codec.KindAgentTunnel, tunnelFrame{
				Tun: t.oneTun, Op: "data", Seq: seq,
				Data: base64.StdEncoding.EncodeToString(buf[:n]),
				Lane: "one-relay",
			}, false); err != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (t *oneRelayTunnel) close() {
	t.once.Do(func() {
		close(t.dead)
		if t.agentConn != nil {
			_ = t.agentConn.Close()
		}
		t.hub.mu.Lock()
		if one := t.hub.ones[t.oneSess]; one != nil {
			delete(one.tunnels, t.oneTun)
			if len(one.tunnels) == 0 {
				delete(t.hub.ones, t.oneSess)
			}
		}
		t.hub.mu.Unlock()
		_ = t.hub.node.PushStreamFrame(t.oneSess, codec.KindAgentTunnel, tunnelFrame{
			Tun: t.oneTun, Op: "close", Lane: "one-relay",
		}, false)
	})
}

// Detach drops one Agent session and kills the tunnels riding it. Other
// sessions keep running.
func (h *MainEndTunnelHub) Detach(sessionID string) {
	h.mu.Lock()
	agent := h.agents[sessionID]
	delete(h.agents, sessionID)
	h.mu.Unlock()
	if agent == nil {
		return
	}
	h.killAgent(agent)
}

// Attached reports whether a session is registered on the hub.
func (h *MainEndTunnelHub) Attached(sessionID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agents[sessionID] != nil
}

// Sessions lists the attached Agent sessions.
func (h *MainEndTunnelHub) Sessions() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.agents))
	for id := range h.agents {
		out = append(out, id)
	}
	return out
}

// DeviceID reports the attested device behind one attached session.
func (h *MainEndTunnelHub) DeviceID(sessionID string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if agent := h.agents[sessionID]; agent != nil {
		return agent.deviceID
	}
	return ""
}

func (h *MainEndTunnelHub) deliver(sessionID string, tf *tunnelFrame) {
	h.mu.Lock()
	agent := h.agents[sessionID]
	var c *MainEndTunnel
	if agent != nil {
		c = agent.tunnels[tf.Tun]
	}
	h.mu.Unlock()
	if c == nil {
		return
	}
	if tf.Op == "close" || tf.Op == "err" {
		c.once.Do(func() { close(c.dead) })
		h.drop(c)
		return
	}
	select {
	case c.in <- *tf:
	default:
		// Slow consumer: treat as fatal for this tunnel; SSH reconnects.
		c.once.Do(func() { close(c.dead) })
		h.drop(c)
	}
}

func (h *MainEndTunnelHub) drop(c *MainEndTunnel) {
	h.mu.Lock()
	if agent := h.agents[c.session]; agent != nil && agent.tunnels[c.id] == c {
		delete(agent.tunnels, c.id)
	}
	h.mu.Unlock()
}

// killSession tears down every tunnel on one Agent session without touching
// the others. The session stays attached: the Agent may re-dial its stream.
func (h *MainEndTunnelHub) killSession(sessionID string) {
	h.mu.Lock()
	agent := h.agents[sessionID]
	h.mu.Unlock()
	if agent == nil {
		return
	}
	h.killAgent(agent)
}

func (h *MainEndTunnelHub) killAgent(agent *mainEndAgent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, c := range agent.tunnels {
		c.once.Do(func() { close(c.dead) })
		delete(agent.tunnels, id)
	}
}

func (h *MainEndTunnelHub) send(sessionID string, tf tunnelFrame) error {
	h.mu.Lock()
	attached := h.agents[sessionID] != nil
	h.mu.Unlock()
	if !attached {
		return fmt.Errorf("tunnel: session %s is not attached", sessionID)
	}
	if err := h.node.PushStreamFrame(sessionID, codec.KindAgentTunnel, tf, false); err != nil {
		h.killSession(sessionID)
		return err
	}
	return nil
}

// DialTunnel opens a plain TCP tunnel to host:port through the Agent behind
// the named session and returns it as a net.Conn once the Agent acknowledges.
func (h *MainEndTunnelHub) DialTunnel(sessionID, host string, port int) (net.Conn, error) {
	return h.dial(sessionID, tunnelFrame{Op: "open", Host: host, Port: port})
}

// DialZft2Lane opens a zft2-lane tunnel: bytes written to the returned conn
// reach the Agent host's ZFT2 dispatcher instead of a TCP dial. This is the
// file-protocol lane on the single encrypted Link channel.
func (h *MainEndTunnelHub) DialZft2Lane(sessionID string) (net.Conn, error) {
	return h.dial(sessionID, tunnelFrame{Op: "open", Lane: "zft2"})
}

func (h *MainEndTunnelHub) dial(sessionID string, open tunnelFrame) (net.Conn, error) {
	h.mu.Lock()
	agent := h.agents[sessionID]
	if agent == nil {
		h.mu.Unlock()
		return nil, fmt.Errorf("tunnel: session %s is not attached", sessionID)
	}
	agent.nextID++
	id := agent.nextID
	open.Tun = id
	c := &MainEndTunnel{hub: h, session: sessionID, id: id, in: make(chan tunnelFrame, tunnelChannelBufSize), dead: make(chan struct{})}
	agent.tunnels[id] = c
	h.mu.Unlock()
	if err := h.send(sessionID, open); err != nil {
		h.drop(c)
		return nil, err
	}
	// Wait for the Agent's open ack or error with a bounded deadline.
	deadline := time.After(tunnelDialTimeout)
	for {
		select {
		case tf := <-c.in:
			if tf.Op == "err" {
				h.drop(c)
				return nil, fmt.Errorf("tunnel: agent refused: %s", tf.Err)
			}
			if tf.Op == "close" {
				h.drop(c)
				return nil, errors.New("tunnel: agent closed during open")
			}
			if tf.Op == "data" {
				// Early data: stash for the first Read.
				c.in <- tf
				return c, nil
			}
			return c, nil
		case <-c.dead:
			h.drop(c)
			return nil, errors.New("tunnel: stream died during open")
		case <-deadline:
			h.drop(c)
			return nil, errors.New("tunnel: open timeout")
		}
	}
}

// InitiatorHub is the One-side counterpart of AgentTunnelHub. It attaches
// /link/stream on an established One session and dials one-relay tunnels
// through the main end, which splices them onto an Agent bastion.
type InitiatorHub struct {
	mu         sync.Mutex
	node       *Node
	peerURL    string
	sessionID  string
	generation uint64
	tunnels    map[int]*initiatorTunnel
	nextID     int
	stream     *tunnelStreamConn
	ep         *Endpoint
	out        chan tunnelFrame
	ctx        context.Context
	cancel     context.CancelFunc
}

type initiatorTunnel struct {
	hub  *InitiatorHub
	id   int
	in   chan tunnelFrame
	dead chan struct{}
	once sync.Once
	rbuf bytes.Buffer
	rmu  sync.Mutex
}

func NewInitiatorHub(node *Node) *InitiatorHub {
	return &InitiatorHub{
		node:    node,
		tunnels: make(map[int]*initiatorTunnel),
		out:     make(chan tunnelFrame, tunnelChannelBufSize),
	}
}

// Start attaches /link/stream on an established One session. Restartable.
func (h *InitiatorHub) Start(peerURL, sessionID string) error {
	stream, ep, err := h.node.dialTunnelStream(peerURL, sessionID)
	if err != nil {
		return err
	}
	h.mu.Lock()
	prevStream, prevCancel := h.stream, h.cancel
	h.generation++
	generation := h.generation
	h.stream = stream
	h.ep = ep
	h.peerURL = peerURL
	h.sessionID = sessionID
	h.ctx, h.cancel = context.WithCancel(context.Background())
	h.mu.Unlock()
	if prevCancel != nil {
		prevCancel()
	}
	if prevStream != nil {
		prevStream.Close()
	}
	go h.writeLoop(generation)
	go h.readLoop(generation)
	go h.pingLoop(generation)
	return nil
}

func (h *InitiatorHub) readLoop(generation uint64) {
	for {
		h.mu.Lock()
		stream, ep := h.stream, h.ep
		current := h.generation
		h.mu.Unlock()
		if stream == nil || ep == nil || current != generation {
			return
		}
		payload, err := stream.readEnvelope()
		if err != nil {
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
		if frame.Kind != codec.KindAgentTunnel {
			continue
		}
		var tf tunnelFrame
		if err := codec.Decode(frame.Body, &tf); err != nil {
			continue
		}
		h.mu.Lock()
		t := h.tunnels[tf.Tun]
		h.mu.Unlock()
		if t == nil {
			continue
		}
		if tf.Op == "" {
			// Dispatcher ack {tun, ok:true} is not a tunnel frame.
			continue
		}
		if tf.Op == "close" || tf.Op == "err" {
			t.once.Do(func() { close(t.dead) })
			select {
			case t.in <- tf:
			default:
			}
			continue
		}
		select {
		case t.in <- tf:
		default:
			t.once.Do(func() { close(t.dead) })
		}
	}
}

func (h *InitiatorHub) writeLoop(generation uint64) {
	for {
		h.mu.Lock()
		ctx, stream, ep := h.ctx, h.stream, h.ep
		current := h.generation
		h.mu.Unlock()
		if ctx == nil || stream == nil || ep == nil || current != generation {
			return
		}
		select {
		case <-ctx.Done():
			return
		case tf := <-h.out:
			env, err := ep.Send(codec.KindAgentTunnel, tf, false)
			if err != nil {
				return
			}
			raw, _ := json.Marshal(env)
			if err := stream.writeEnvelope(raw); err != nil {
				return
			}
		}
	}
}

func (h *InitiatorHub) pingLoop(generation uint64) {
	ticker := time.NewTicker(tunnelPingInterval)
	defer ticker.Stop()
	for {
		h.mu.Lock()
		ctx, stream := h.ctx, h.stream
		current := h.generation
		h.mu.Unlock()
		if ctx == nil || stream == nil || current != generation {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := stream.ping(); err != nil {
				return
			}
		}
	}
}

func (h *InitiatorHub) send(tf tunnelFrame) error {
	select {
	case h.out <- tf:
		return nil
	case <-time.After(tunnelWriteTimeout):
		return errors.New("tunnel: initiator write timeout")
	}
}

// DialRelay opens a TCP tunnel to host:port through the named Agent, via the
// main end. The One device never sees the Agent's Link session.
func (h *InitiatorHub) DialRelay(agentID, host string, port int) (net.Conn, error) {
	h.mu.Lock()
	if h.stream == nil || h.ep == nil {
		h.mu.Unlock()
		return nil, errors.New("tunnel: initiator stream is not started")
	}
	h.nextID++
	id := h.nextID
	t := &initiatorTunnel{hub: h, id: id, in: make(chan tunnelFrame, tunnelChannelBufSize), dead: make(chan struct{})}
	h.tunnels[id] = t
	h.mu.Unlock()
	if err := h.send(tunnelFrame{
		Tun: id, Op: "open", Host: host, Port: port,
		Lane: "one-relay", AgentID: agentID,
	}); err != nil {
		h.drop(t)
		return nil, err
	}
	deadline := time.After(tunnelDialTimeout)
	for {
		select {
		case tf := <-t.in:
			if tf.Op == "err" {
				h.drop(t)
				return nil, fmt.Errorf("tunnel: relay refused: %s", tf.Err)
			}
			if tf.Op == "close" {
				h.drop(t)
				return nil, errors.New("tunnel: relay closed during open")
			}
			if tf.Op == "data" {
				t.in <- tf
				return t, nil
			}
			if tf.Op == "open" {
				return t, nil
			}
		case <-t.dead:
			h.drop(t)
			return nil, errors.New("tunnel: stream died during open")
		case <-deadline:
			h.drop(t)
			return nil, errors.New("tunnel: relay open timeout")
		}
	}
}

func (h *InitiatorHub) drop(t *initiatorTunnel) {
	h.mu.Lock()
	if h.tunnels[t.id] == t {
		delete(h.tunnels, t.id)
	}
	h.mu.Unlock()
}

func (t *initiatorTunnel) Read(p []byte) (int, error) {
	t.rmu.Lock()
	if t.rbuf.Len() > 0 {
		n, _ := t.rbuf.Read(p)
		t.rmu.Unlock()
		return n, nil
	}
	t.rmu.Unlock()
	select {
	case tf := <-t.in:
		if tf.Op == "close" || tf.Op == "err" {
			if tf.Op == "err" && tf.Err != "" {
				return 0, fmt.Errorf("tunnel: %s", tf.Err)
			}
			return 0, io.EOF
		}
		if tf.Op != "data" {
			return 0, io.EOF
		}
		data, err := base64.StdEncoding.DecodeString(tf.Data)
		if err != nil {
			return 0, errors.New("tunnel: bad frame data")
		}
		n := copy(p, data)
		if n < len(data) {
			t.rmu.Lock()
			t.rbuf.Write(data[n:])
			t.rmu.Unlock()
		}
		return n, nil
	case <-t.dead:
		t.rmu.Lock()
		defer t.rmu.Unlock()
		if t.rbuf.Len() > 0 {
			n, _ := t.rbuf.Read(p)
			return n, nil
		}
		return 0, io.EOF
	}
}

func (t *initiatorTunnel) Write(p []byte) (int, error) {
	total := len(p)
	for len(p) > 0 {
		chunk := p
		if len(chunk) > tunnelMaxDataBytes {
			chunk = chunk[:tunnelMaxDataBytes]
		}
		if err := t.hub.send(tunnelFrame{
			Tun: t.id, Op: "data",
			Data: base64.StdEncoding.EncodeToString(chunk),
			Lane: "one-relay",
		}); err != nil {
			return total - len(p), err
		}
		p = p[len(chunk):]
	}
	return total, nil
}

func (t *initiatorTunnel) Close() error {
	t.once.Do(func() {
		close(t.dead)
		_ = t.hub.send(tunnelFrame{Tun: t.id, Op: "close", Lane: "one-relay"})
		t.hub.drop(t)
	})
	return nil
}

func (t *initiatorTunnel) LocalAddr() net.Addr                { return tunnelAddr("one") }
func (t *initiatorTunnel) RemoteAddr() net.Addr               { return tunnelAddr("agent") }
func (t *initiatorTunnel) SetDeadline(time.Time) error        { return nil }
func (t *initiatorTunnel) SetReadDeadline(time.Time) error    { return nil }
func (t *initiatorTunnel) SetWriteDeadline(time.Time) error   { return nil }
