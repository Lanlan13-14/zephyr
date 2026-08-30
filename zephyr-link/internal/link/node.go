package link

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

type RemoteLinkError struct {
	Status    int
	Code      string
	Message   string
	Retryable bool
}

func (e *RemoteLinkError) Error() string { return "link peer rejected request: " + e.Code }

func decodeRemoteLinkError(status int, body []byte, fallback string) error {
	var envelope struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			Retryable bool   `json:"retryable"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && envelope.Error.Code != "" {
		return &RemoteLinkError{Status: status, Code: envelope.Error.Code,
			Message: envelope.Error.Message, Retryable: envelope.Error.Retryable}
	}
	return &RemoteLinkError{Status: status, Code: fallback, Message: "Link peer rejected request"}
}

// Node is a Link v2 participant that can both host and dial encrypted sessions
// over plain HTTP. The same Node runs as the server peer, the desktop peer and
// the embedded mobile peer; only the listen address differs.
type Node struct {
	mux *http.ServeMux
	// dialClient is used for outbound handshake/push to the peer. The default
	// http.DefaultClient has no timeout, so a peer address that accepts TCP but
	// never answers (or a DNS blackhole) blocks Dial forever and the embedding
	// app's bind flow hangs at "正在写入设备密钥并拉取镜像". Bound every call.
	dialClient *http.Client

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
	n := &Node{
		mux:           http.NewServeMux(),
		sessions:      make(map[string]*Endpoint),
		sessionDevice: make(map[string]string),
		dispatch:      NewDispatcher(),
		// Generous enough for a slow LAN server, hard enough to never hang the host.
		dialClient: &http.Client{Timeout: 15 * time.Second},
	}
	// Serve both the Go-native names (/link/...) and the mounted leaf names
	// (/handshake, /push) so a dialer can point Dial/SendFrame at either the bare Go
	// root or the main end's /api/link/v2 root with the same leaf paths.
	n.mux.HandleFunc("/link/handshake", n.handleHandshake)
	n.mux.HandleFunc("/handshake", n.handleHandshake)
	n.mux.HandleFunc("/link/frame", n.handleFrame)
	n.mux.HandleFunc("/push", n.handleFrame)
	// Embedded hosts (Android/desktop) drive outbound dials through this local
	// endpoint, so the device side also runs the shared Go core.
	n.mux.HandleFunc("/link/dial", n.handleDial)
	// And they push business frames on an established session through this local
	// endpoint: seal with the session endpoint, POST to the peer's /link/frame,
	// unseal the reply. The host never sees key material.
	n.mux.HandleFunc("/link/push", n.handlePushFrame)
	// Real-time full-duplex channel: the server upgrades to a WebSocket and relays
	// sealed frames; the proxy shuttles bytes without ever decrypting.
	n.mux.HandleFunc("/link/stream", n.handleStream)
	// Session liveness/state probe for a device; sealed so it rides the channel.
	n.mux.HandleFunc("/link/state", n.handleState)
	// Embedded hosts use these for device-identity ML-KEM-768. Kotlin never
	// implements the primitive; it posts raw keys/ciphertexts and the Go core
	// returns the result. Loopback only — the embedded process binds 127.0.0.1.
	n.mux.HandleFunc("/link/mlkem/generate", n.handleMlkemGenerate)
	n.mux.HandleFunc("/link/mlkem/encapsulate", n.handleMlkemEncapsulate)
	n.mux.HandleFunc("/link/mlkem/decapsulate", n.handleMlkemDecapsulate)
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
		ServerURL string   `json:"serverUrl"`
		DeviceID  string   `json:"deviceId"`
		SPKIPins  []string `json:"spkiPins"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.ServerURL == "" {
		http.Error(w, "serverUrl required", http.StatusBadRequest)
		return
	}
	ep, sessionID, err := n.dial(req.ServerURL, req.DeviceID, req.SPKIPins)
	if err != nil {
		var remote *RemoteLinkError
		if errors.As(err, &remote) {
			errJSONRetryable(w, http.StatusBadGateway, remote.Code, remote.Message, remote.Retryable)
		} else {
			errJSONRetryable(w, http.StatusBadGateway, "link_unavailable", "Link handshake failed", true)
		}
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

// pushFrameRequest is the embedded host's local push: which established session,
// what business kind/body, and whether it rides the secret lane. The peer URL is
// remembered from the dial so the host only names the session.
type pushFrameRequest struct {
	SessionID string   `json:"sessionId"`
	PeerURL   string   `json:"peerUrl"`
	Kind      int      `json:"kind"`
	Body      any      `json:"body"`
	Secret    bool     `json:"secret"`
	SPKIPins  []string `json:"spkiPins"`
}

// handlePushFrame is the embedded dial-side sender. The Kotlin/desktop host owns
// WHAT to send; the Go core owns sealing and the wire, so every client speaks
// byte-identical Link v2.
func (n *Node) handlePushFrame(w http.ResponseWriter, r *http.Request) {
	var req pushFrameRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad json")
		return
	}
	n.mu.Lock()
	ep := n.sessions[req.SessionID]
	n.mu.Unlock()
	if ep == nil {
		errJSON(w, http.StatusBadRequest, "session_unknown", "Link 会话不存在")
		return
	}
	if req.PeerURL == "" {
		errJSON(w, http.StatusBadRequest, "bad_request", "peerUrl required")
		return
	}
	ack, err := n.sendFrame(req.PeerURL, req.SessionID, ep, req.Kind, req.Body, req.Secret, req.SPKIPins)
	if err != nil {
		var remote *RemoteLinkError
		if errors.As(err, &remote) {
			errJSONRetryable(w, http.StatusBadGateway, remote.Code, remote.Message, remote.Retryable)
		} else {
			errJSONRetryable(w, http.StatusBadGateway, "link_unavailable", "Link push failed", true)
		}
		return
	}
	var ackBody any
	if ack != nil && len(ack.Body) > 0 {
		if err := codec.Decode(ack.Body, &ackBody); err != nil {
			errJSON(w, http.StatusBadGateway, "push_failed", "unparsable ack body")
			return
		}
		normalized, err := normalizeCBORForJSON(ackBody)
		if err != nil {
			errJSON(w, http.StatusBadGateway, "push_failed", "unencodable ack body")
			return
		}
		ackBody = normalized
	}
	ackKind := 0
	if ack != nil {
		ackKind = ack.Kind
	}
	writeJSON(w, map[string]any{"ok": true, "ackKind": ackKind, "ack": ackBody})
}

// handleMlkemGenerate returns a fresh ML-KEM-768 keypair (public key + seed).
// Loopback only — the embedded process binds 127.0.0.1.
func (n *Node) handleMlkemGenerate(w http.ResponseWriter, r *http.Request) {
	publicKey, seed, err := zsl.GenerateMLKEM768()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "mlkem_generate_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"ok":        true,
		"publicKey": base64.RawURLEncoding.EncodeToString(publicKey),
		"seed":      base64.RawURLEncoding.EncodeToString(seed),
	})
}

// handleMlkemEncapsulate derives a shared secret against a peer public key and
// returns the shared secret + the ciphertext that must reach the peer.
func (n *Node) handleMlkemEncapsulate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad json")
		return
	}
	publicKey, err := b64d(req.PublicKey)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad publicKey")
		return
	}
	if len(publicKey) != zsl.MLKEM768PublicKeyBytes {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad key size")
		return
	}
	shared, ciphertext, err := zsl.EncapsulateMLKEM768(publicKey)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "mlkem_encapsulate_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"ok":         true,
		"shared":     base64.RawURLEncoding.EncodeToString(shared),
		"ciphertext": base64.RawURLEncoding.EncodeToString(ciphertext),
	})
}

// handleMlkemDecapsulate recovers a shared secret from a ciphertext with a seed.
func (n *Node) handleMlkemDecapsulate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Seed       string `json:"seed"`
		Ciphertext string `json:"ciphertext"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad json")
		return
	}
	seed, err := b64d(req.Seed)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad seed")
		return
	}
	ciphertext, err := b64d(req.Ciphertext)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad ciphertext")
		return
	}
	if len(ciphertext) != zsl.MLKEM768CiphertextBytes {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad ciphertext size")
		return
	}
	shared, err := zsl.DecapsulateMLKEM768(seed, ciphertext)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "mlkem_decapsulate_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{
		"ok":     true,
		"shared": base64.RawURLEncoding.EncodeToString(shared),
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

func errJSONRetryable(w http.ResponseWriter, status int, code, message string, retryable bool) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": false, "error": map[string]any{
			"code": code, "message": message, "retryable": retryable,
		},
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
		errJSON(w, http.StatusBadRequest, "dispatch_failed", "Link frame dispatch failed")
		return
	}
	if replyBody == nil {
		replyKind, replyBody, replySecret = codec.KindSyncAck, map[string]any{"receivedKind": fr.Kind, "ok": true}, false
	}
	ack, err := ep.Send(replyKind, replyBody, replySecret)
	if err != nil {
		writeJSON(w, frameResponse{OK: false, Error: "reply sealing failed"})
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
// Dial runs the ZSL/2 initiator handshake against a peer. deviceID anchors the
// session to the enrolled device on the server; the embedded mobile/desktop node
// passes its bound device id. baseURL is the peer's link root: the production main
// end mounts the proxy at /api/link/v2, a Go-native peer serves /link directly, so
// the caller supplies whichever root and Dial appends the leaf.
func (n *Node) Dial(baseURL, deviceID string) (*Endpoint, string, error) {
	return n.dial(baseURL, deviceID, nil)
}

func (n *Node) dial(baseURL, deviceID string, spkiPins []string) (*Endpoint, string, error) {
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		return nil, "", err
	}
	reqBody, _ := json.Marshal(handshakeRequest{
		DeviceID:     deviceID,
		X25519Public: base64.RawURLEncoding.EncodeToString(init.X25519Public),
		MLKEMPublic:  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	client, err := n.clientForPeer(baseURL, spkiPins)
	if err != nil {
		return nil, "", err
	}
	resp, err := client.Post(baseURL+"/handshake", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, "", decodeRemoteLinkError(resp.StatusCode, msg, "handshake_failed")
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
func (n *Node) SendFrame(baseURL, sessionID string, ep *Endpoint, kind int, body any, secret bool) (*codec.Frame, error) {
	return n.sendFrame(baseURL, sessionID, ep, kind, body, secret, nil)
}

func (n *Node) sendFrame(baseURL, sessionID string, ep *Endpoint, kind int, body any, secret bool, spkiPins []string) (*codec.Frame, error) {
	env, err := ep.Send(kind, body, secret)
	if err != nil {
		return nil, err
	}
	reqBody, _ := json.Marshal(frameRequest{
		SessionID: sessionID,
		Seq:       env.Seq,
		IV:        base64.RawURLEncoding.EncodeToString(env.IV),
		CT:        base64.RawURLEncoding.EncodeToString(env.CT),
		Tag:       base64.RawURLEncoding.EncodeToString(env.Tag),
	})
	client, err := n.clientForPeer(baseURL, spkiPins)
	if err != nil {
		return nil, err
	}
	resp, err := client.Post(baseURL+"/push", "application/json", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, decodeRemoteLinkError(resp.StatusCode, msg, "push_failed")
	}
	var fr frameResponse
	if err := json.NewDecoder(resp.Body).Decode(&fr); err != nil {
		return nil, err
	}
	if !fr.OK {
		return nil, fmt.Errorf("frame rejected: %s", fr.Error)
	}
	iv, _ := b64d(fr.IV)
	ct, _ := b64d(fr.CT)
	tag, _ := b64d(fr.Tag)
	ack, err := ep.Receive(&Envelope{Seq: fr.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		return nil, fmt.Errorf("ack open: %w", err)
	}
	return ack, nil
}

func (n *Node) clientForPeer(baseURL string, spkiPins []string) (*http.Client, error) {
	if len(spkiPins) == 0 {
		return n.dialClient, nil
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return nil, errors.New("link: pinned peer must be an HTTPS URL")
	}
	pins := make(map[[32]byte]struct{}, len(spkiPins))
	for _, raw := range spkiPins {
		value := strings.TrimPrefix(strings.TrimSpace(raw), "sha256/")
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil || len(decoded) != sha256.Size {
			return nil, errors.New("link: invalid SPKI pin")
		}
		var pin [32]byte
		copy(pin[:], decoded)
		pins[pin] = struct{}{}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		ServerName:         parsed.Hostname(),
		InsecureSkipVerify: true, // verification is replaced below, never skipped
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("link: peer certificate missing")
			}
			for _, cert := range state.PeerCertificates {
				digest := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
				if _, ok := pins[digest]; ok {
					return nil
				}
			}
			return errors.New("link: SPKI pin mismatch")
		},
	}
	return &http.Client{Transport: transport, Timeout: n.dialClient.Timeout}, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	payload, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"ok":false,"error":{"code":"encode_failed","message":"Link response unencodable"}}`))
		return
	}
	w.Header().Set("content-type", "application/json")
	_, _ = w.Write(payload)
}
