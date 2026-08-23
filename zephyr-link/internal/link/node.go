package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

// Node is a Link v2 participant that can both host and dial encrypted sessions
// over plain HTTP. The same Node runs as the server peer, the desktop peer and
// the embedded mobile peer; only the listen address differs.
type Node struct {
	mux *http.ServeMux

	mu       sync.Mutex
	sessions map[string]*Endpoint // by session id
	// devices, when non-nil, gates handshakes to enrolled device IDs. nil accepts
	// any handshake (tests and the embedded node); the server populates it from the
	// enrollment consume path so a session only anchors to an enrolled device.
	devices map[string]bool
	// sessionDevice records which enrolled device a session was anchored to at
	// handshake, so a business handler can attest the caller's device without the
	// frame carrying a forgeable deviceId.
	sessionDevice map[string]string
	// dispatch routes unsealed business frames to per-kind handlers. It is what
	// turns the node from a pipe into the Link channel.
	dispatch *Dispatcher
}

// RegisterDevice marks a device ID as eligible to handshake.
func (n *Node) RegisterDevice(deviceID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.devices == nil {
		n.devices = make(map[string]bool)
	}
	n.devices[deviceID] = true
}

// RequireEnrollment makes the handshake reject unregistered devices.
func (n *Node) RequireEnrollment() {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.devices == nil {
		n.devices = make(map[string]bool)
	}
}

// NewNode builds a node with the transport routes mounted.
func NewNode() *Node {
	n := &Node{mux: http.NewServeMux(), sessions: make(map[string]*Endpoint), sessionDevice: make(map[string]string), dispatch: NewDispatcher()}
	n.mux.HandleFunc("/link/handshake", n.handleHandshake)
	n.mux.HandleFunc("/link/frame", n.handleFrame)
	// Embedded hosts (Android/desktop) drive outbound dials through this local
	// endpoint, so the device side also runs the shared Go core.
	n.mux.HandleFunc("/link/dial", n.handleDial)
	// Real-time full-duplex channel: the server upgrades to a WebSocket and relays
	// sealed frames; the proxy shuttles bytes without ever decrypting.
	n.mux.HandleFunc("/link/stream", n.handleStream)
	// Session liveness/state probe for a device; sealed so it rides the channel.
	n.mux.HandleFunc("/link/state", n.handleState)
	n.registerBuiltinHandlers()
	return n
}

// Dispatcher exposes the node's business-frame router so hosts (server, mobile,
// desktop) register their per-kind handlers.
func (n *Node) Dispatcher() *Dispatcher { return n.dispatch }

// sessionDevice returns the device id a session was anchored to, or "" when the
// session is unknown (an embedded dial endpoint may not record one).
func (n *Node) sessionDeviceGet(sessionID string) string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.sessionDevice[sessionID]
}

// RegisterSyncBridge wires the owned-sync lane to the single Node sync business
// core over loopback. The server calls this once at startup; the embedded mobile
// node does not (it is the dial side, not the business side).
func (n *Node) RegisterSyncBridge(cfg SyncBridgeConfig) { n.registerSyncBridge(cfg) }

// registerBuiltinHandlers installs the handlers the node serves itself: the
// control-channel wake/state probe. Business lanes (sync, blob, shared, …) are
// registered by the embedding host, because they need account data the node
// does not own.
func (n *Node) registerBuiltinHandlers() {
	n.dispatch.Register(codec.KindWake, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		return codec.KindWake, map[string]any{"state": "ready", "serverTime": time.Now().UnixMilli()}, false, nil
	})
}

// handleState answers a session liveness probe. The reply is sealed under the
// session so the proxy only ever shuttles ciphertext.
func (n *Node) handleState(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("sessionId")
	n.mu.Lock()
	ep := n.sessions[sessionID]
	n.mu.Unlock()
	if ep == nil {
		errJSON(w, http.StatusUnauthorized, "session_unknown", "Link 会话不存在")
		return
	}
	env, err := ep.Send(6 /* WAKE */, map[string]any{"state": "ready", "serverTime": time.Now().UnixMilli()}, false)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "seal_failed", "seal failed")
		return
	}
	writeJSON(w, env)
}

// handleDial lets an embedded host establish an outbound ZSL/2 channel to a
// remote Link server without implementing the handshake itself.
func (n *Node) handleDial(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ServerURL string `json:"serverUrl"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.ServerURL == "" {
		http.Error(w, "serverUrl required", http.StatusBadRequest)
		return
	}
	ep, sessionID, err := n.Dial(req.ServerURL)
	if err != nil {
		http.Error(w, "dial failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	n.mu.Lock()
	n.sessions[sessionID] = ep
	n.mu.Unlock()
	writeJSON(w, map[string]any{
		"ok": true, "sessionId": sessionID,
		"exporter": base64.RawURLEncoding.EncodeToString(ep.Exporter()),
	})
}

// Handler exposes the node's HTTP routes.
func (n *Node) Handler() http.Handler { return n.mux }

type handshakeRequest struct {
	DeviceID     string `json:"deviceId"`
	X25519Public string `json:"x25519Public"`
	MLKEMPublic  string `json:"mlkemPublic"`
}

type handshakeResponse struct {
	SessionID       string `json:"sessionId"`
	X25519Public    string `json:"x25519Public"`
	MLKEMCiphertext string `json:"mlkemCiphertext"`
}

type frameRequest struct {
	SessionID string `json:"sessionId"`
	Seq       uint64 `json:"seq"`
	IV        string `json:"iv"`
	CT        string `json:"ct"`
	Tag       string `json:"tag"`
	// Reply carries the server's sealed response frame, when the handler produced one.
}

type frameResponse struct {
	OK    bool   `json:"ok"`
	Seq   uint64 `json:"seq"`
	IV    string `json:"iv"`
	CT    string `json:"ct"`
	Tag   string `json:"tag"`
	Error string `json:"error,omitempty"`
}

func b64d(s string) ([]byte, error) { return base64.RawURLEncoding.DecodeString(s) }

// errJSON answers in the same {ok:false,error:{code,message}} envelope the Node
// link-v2-transport used, so clients see one contract regardless of which
// transport served them.
func errJSON(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":    false,
		"error": map[string]any{"code": code, "message": message},
	})
}

func (n *Node) handleHandshake(w http.ResponseWriter, r *http.Request) {
	var req handshakeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad json")
		return
	}
	x25519Public, err := b64d(req.X25519Public)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad x25519")
		return
	}
	mlkemPublic, err := b64d(req.MLKEMPublic)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad mlkem")
		return
	}
	// Fail closed on bad key sizes before any enrollment lookup, so a malformed key
	// is not an oracle for whether a deviceId is enrolled. Only then, when the
	// server runs a device table, require the device to be enrolled.
	if len(mlkemPublic) != zsl.MLKEM768PublicKeyBytes || len(x25519Public) != zsl.X25519Bytes {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad key size")
		return
	}
	n.mu.Lock()
	enrolled := n.devices == nil || n.devices[req.DeviceID]
	n.mu.Unlock()
	if !enrolled {
		errJSON(w, http.StatusForbidden, "device_not_enrolled", "设备未完成绑定")
		return
	}
	hello, sess, err := zsl.HandshakeResponder(x25519Public, mlkemPublic)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", err.Error())
		return
	}
	sessionID := base64.RawURLEncoding.EncodeToString(sess.Exporter()[:16])
	n.mu.Lock()
	n.sessions[sessionID] = NewEndpoint(sess)
	n.sessionDevice[sessionID] = req.DeviceID
	n.mu.Unlock()
	writeJSON(w, handshakeResponse{
		SessionID:       sessionID,
		X25519Public:    base64.RawURLEncoding.EncodeToString(hello.X25519Public),
		MLKEMCiphertext: base64.RawURLEncoding.EncodeToString(hello.MLKEMCiphertext),
	})
}

func (n *Node) handleFrame(w http.ResponseWriter, r *http.Request) {
	var req frameRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	n.mu.Lock()
	ep := n.sessions[req.SessionID]
	n.mu.Unlock()
	if ep == nil {
		errJSON(w, http.StatusBadRequest, "session_unknown", "Link 会话不存在")
		return
	}
	iv, _ := b64d(req.IV)
	ct, _ := b64d(req.CT)
	tag, _ := b64d(req.Tag)
	fr, err := ep.Receive(&Envelope{Seq: req.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_frame", err.Error())
		return
	}
	// Route the business frame to its per-kind handler instead of echoing the
	// kind. An unhandled or unknown kind is a hard failure, not a silent ack.
	replyKind, replyBody, replySecret, derr := n.dispatch.Dispatch(&FrameContext{SessionID: req.SessionID}, fr)
	if derr != nil {
		errJSON(w, http.StatusBadRequest, "dispatch_failed", derr.Error())
		return
	}
	if replyBody == nil {
		replyKind, replyBody, replySecret = codec.KindSyncAck, map[string]any{"receivedKind": fr.Kind, "ok": true}, false
	}
	ack, err := ep.Send(replyKind, replyBody, replySecret)
	if err != nil {
		writeJSON(w, frameResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, frameResponse{
		OK:  true,
		Seq: ack.Seq,
		IV:  base64.RawURLEncoding.EncodeToString(ack.IV),
		CT:  base64.RawURLEncoding.EncodeToString(ack.CT),
		Tag: base64.RawURLEncoding.EncodeToString(ack.Tag),
	})
}

// Dial performs a handshake against a peer node and returns the keyed endpoint
// plus the session id to address frames to.
func (n *Node) Dial(baseURL string) (*Endpoint, string, error) {
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		return nil, "", err
	}
	reqBody, _ := json.Marshal(handshakeRequest{
		X25519Public: base64.RawURLEncoding.EncodeToString(init.X25519Public),
		MLKEMPublic:  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	resp, err := http.Post(baseURL+"/link/handshake", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(resp.Body)
		return nil, "", fmt.Errorf("handshake: %s: %s", resp.Status, msg)
	}
	var hr handshakeResponse
	if err := json.NewDecoder(resp.Body).Decode(&hr); err != nil {
		return nil, "", err
	}
	x25519Public, err := b64d(hr.X25519Public)
	if err != nil {
		return nil, "", err
	}
	kemCt, err := b64d(hr.MLKEMCiphertext)
	if err != nil {
		return nil, "", err
	}
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: x25519Public, MLKEMCiphertext: kemCt})
	if err != nil {
		return nil, "", err
	}
	return NewEndpoint(sess), hr.SessionID, nil
}

// SendFrame seals a business frame and posts it to the peer, returning the
// peer's unsealed ack frame.
func (n *Node) SendFrame(baseURL, sessionID string, ep *Endpoint, kind int, body any, secret bool) (int, error) {
	env, err := ep.Send(kind, body, secret)
	if err != nil {
		return 0, err
	}
	reqBody, _ := json.Marshal(frameRequest{
		SessionID: sessionID,
		Seq:       env.Seq,
		IV:        base64.RawURLEncoding.EncodeToString(env.IV),
		CT:        base64.RawURLEncoding.EncodeToString(env.CT),
		Tag:       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	resp, err := http.Post(baseURL+"/link/frame", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var fr frameResponse
	if err := json.NewDecoder(resp.Body).Decode(&fr); err != nil {
		return 0, err
	}
	if !fr.OK {
		return 0, fmt.Errorf("frame rejected: %s", fr.Error)
	}
	iv, _ := b64d(fr.IV)
	ct, _ := b64d(fr.CT)
	tag, _ := b64d(fr.Tag)
	ack, err := ep.Receive(&Envelope{Seq: fr.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		return 0, fmt.Errorf("ack open: %w", err)
	}
	return ack.Kind, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
