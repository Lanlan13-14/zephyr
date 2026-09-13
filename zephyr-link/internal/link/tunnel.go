package link

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
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
	tunnelIdleTimeout    = 5 * time.Minute
	tunnelChannelBufSize = 64
)

type tunnelFrame struct {
	Tun  int    `json:"tun"`
	Op   string `json:"op"`
	Host string `json:"host,omitempty"`
	Port int    `json:"port,omitempty"`
	Seq  int64  `json:"seq,omitempty"`
	Data string `json:"data,omitempty"`
	Err  string `json:"err,omitempty"`
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
	return writeFrame(t.conn, 0x1, env)
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
			writeFrame(t.conn, 0xA, payload)
			t.wmu.Unlock()
			continue
		case 0x1, 0x2, 0x0:
			return payload, nil
		default:
			return nil, errors.New("tunnel: bad stream opcode")
		}
	}
}

func (t *tunnelStreamConn) Close() error {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	writeFrame(t.conn, 0x8, nil)
	return t.conn.Close()
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
	var d net.Dialer
	raw, err := d.DialContext(context.Background(), "tcp", hostPort)
	if err != nil {
		return nil, nil, err
	}
	if parsed.Scheme == "https" {
		tc := &tls.Config{ServerName: parsed.Hostname(), MinVersion: tls.VersionTLS12}
		if tlsProfile.insecure {
			tc.InsecureSkipVerify = true
		}
		raw = tls.Client(raw, tc)
	}
	key := fmt.Sprintf("zephyr-link-%d", time.Now().UnixNano())
	var hdr bytes.Buffer
	hdr.WriteString("GET " + parsed.RequestURI() + " HTTP/1.1\r\n")
	hdr.WriteString("Host: " + parsed.Host + "\r\n")
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
}

type AgentTunnelHub struct {
	mu      sync.Mutex
	node    *Node
	peerURL string
	tunnels map[int]*agentTunnel
	nextID  int
	stream  *tunnelStreamConn
	ep      *Endpoint
	out     chan tunnelFrame
	ctx     context.Context
	cancel  context.CancelFunc
	// OnLinkLost fires when the stream dies so the host can re-dial.
	OnLinkLost func()
}

func NewAgentTunnelHub(node *Node) *AgentTunnelHub {
	return &AgentTunnelHub{node: node, tunnels: make(map[int]*agentTunnel), out: make(chan tunnelFrame, tunnelChannelBufSize)}
}

// Start connects the stream channel and serves tunnel frames until the stream
// dies. It blocks; the host runs it on a worker thread.
func (h *AgentTunnelHub) Start(peerURL, sessionID string) error {
	stream, ep, err := h.node.dialTunnelStream(peerURL, sessionID)
	if err != nil {
		return err
	}
	h.mu.Lock()
	h.stream = stream
	h.ep = ep
	h.peerURL = peerURL
	h.ctx, h.cancel = context.WithCancel(context.Background())
	h.mu.Unlock()
	go h.writeLoop()
	h.readLoop()
	h.closeAll("link stream closed")
	if h.OnLinkLost != nil {
		h.OnLinkLost()
	}
	return nil
}

func (h *AgentTunnelHub) closeAll(reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cancel()
	for id, t := range h.tunnels {
		t.conn.Close()
		delete(h.tunnels, id)
	}
	h.stream = nil
	h.ep = nil
}

func (h *AgentTunnelHub) readLoop() {
	for {
		h.mu.Lock()
		stream, ep := h.stream, h.ep
		h.mu.Unlock()
		if stream == nil || ep == nil {
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

func (h *AgentTunnelHub) writeLoop() {
	for {
		h.mu.Lock()
		ctx, stream, ep := h.ctx, h.stream, h.ep
		h.mu.Unlock()
		if ctx == nil || stream == nil || ep == nil {
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

func (h *AgentTunnelHub) handleFrame(tf *tunnelFrame) {
	switch tf.Op {
	case "open":
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
	hub  *MainEndTunnelHub
	id   int
	rbuf bytes.Buffer
	rmu  sync.Mutex
	in   chan tunnelFrame
	dead chan struct{}
	once sync.Once
	seq  int64
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
		if err := c.hub.send(tunnelFrame{Tun: c.id, Op: "data", Seq: c.seq, Data: base64.StdEncoding.EncodeToString(chunk)}); err != nil {
			return total - len(p), err
		}
		p = p[len(chunk):]
	}
	return total, nil
}

func (c *MainEndTunnel) Close() error {
	c.once.Do(func() {
		close(c.dead)
		_ = c.hub.send(tunnelFrame{Tun: c.id, Op: "close"})
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

// MainEndTunnelHub is embedded in zephyr-link-server. The Node front end opens
// a hub per Agent stream session; DialTunnel returns a connected net.Conn.
type MainEndTunnelHub struct {
	mu       sync.Mutex
	node     *Node
	tunnels  map[int]*MainEndTunnel
	nextID   int
	session  string
	deviceID string
	// OnAgentFrame routes Agent→main tunnel frames into the hub.
	deliverFn func(*tunnelFrame)
}

func NewMainEndTunnelHub(node *Node) *MainEndTunnelHub {
	return &MainEndTunnelHub{node: node, tunnels: make(map[int]*MainEndTunnel)}
}

// Attach registers the AGENT_TUNNEL dispatch handler for one agent session.
// The Agent dials /link/stream in; its frames arrive through Dispatch, and the
// hub answers them through PushStreamFrame on the same live stream.
func (h *MainEndTunnelHub) Attach(sessionID string) error {
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
	if h.session != "" && h.session != sessionID {
		return fmt.Errorf("tunnel: hub already attached to session %s", h.session)
	}
	h.session = sessionID
	h.deviceID = device
	if h.deliverFn == nil {
		h.deliverFn = h.deliver
		n.Dispatcher().Register(codec.KindAgentTunnel, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
			var tf tunnelFrame
			if err := codec.Decode(fr.Body, &tf); err != nil {
				return 0, nil, false, err
			}
			h.deliverFn(&tf)
			// Tunnels are fire-and-forget per frame; the ack carries nothing.
			return codec.KindAgentTunnel, map[string]any{"tun": tf.Tun, "ok": true}, false, nil
		})
	}
	return nil
}

// SessionID reports the attached agent session.
func (h *MainEndTunnelHub) SessionID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.session
}

// DeviceID reports the attested device behind the attached session.
func (h *MainEndTunnelHub) DeviceID() string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.deviceID
}

func (h *MainEndTunnelHub) deliver(tf *tunnelFrame) {
	h.mu.Lock()
	c := h.tunnels[tf.Tun]
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
	if h.tunnels[c.id] == c {
		delete(h.tunnels, c.id)
	}
	h.mu.Unlock()
}

func (h *MainEndTunnelHub) killAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for id, c := range h.tunnels {
		c.once.Do(func() { close(c.dead) })
		delete(h.tunnels, id)
	}
}

func (h *MainEndTunnelHub) send(tf tunnelFrame) error {
	h.mu.Lock()
	session := h.session
	h.mu.Unlock()
	if session == "" {
		return errors.New("tunnel: hub has no agent session")
	}
	if err := h.node.PushStreamFrame(session, codec.KindAgentTunnel, tf, false); err != nil {
		h.killAll()
		return err
	}
	return nil
}

func (h *MainEndTunnelHub) dropBySend(c *MainEndTunnel) { h.drop(c) }

// DialTunnel opens a tunnel to host:port through the Agent behind the hub's
// session and returns it as a net.Conn once the Agent acknowledges.
func (h *MainEndTunnelHub) DialTunnel(host string, port int) (net.Conn, error) {
	h.mu.Lock()
	if h.session == "" {
		h.mu.Unlock()
		return nil, errors.New("tunnel: hub not attached")
	}
	h.nextID++
	id := h.nextID
	c := &MainEndTunnel{hub: h, id: id, in: make(chan tunnelFrame, tunnelChannelBufSize), dead: make(chan struct{})}
	h.tunnels[id] = c
	h.mu.Unlock()
	if err := h.send(tunnelFrame{Tun: id, Op: "open", Host: host, Port: port}); err != nil {
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
