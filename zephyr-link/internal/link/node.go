package link

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
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
	// sessionTLS remembers the Dial-time TLS policy so a later /link/push uses
	// the same pins / insecure flag. Without this, a public-CA host that bound
	// through OkHttp still fails on the Go push path.
	sessionTLS map[string]sessionTLS
	// devices, when non-nil, gates handshakes to enrolled device IDs and their
	// ES256 public keys. nil accepts any handshake (in-process tests and the
	// embedded node that is not itself a server). The production server
	// populates it from the enrollment consume path.
	devices map[string]*DeviceRecord
	// requireAuth, set by RequireEnrollment, demands an ES256 finish bound to
	// the handshake transcript before a session is established. Registering a
	// device id without this flag only gates the id (legacy test nodes).
	requireAuth bool
	// sessionDevice records which enrolled device a session was anchored to at
	// handshake, so a business handler can attest the caller's device without the
	// frame carrying a forgeable deviceId.
	sessionDevice map[string]string
	// pending holds half-open hellos awaiting an ES256 finish. Keys are
	// session ids. An expired or consumed challenge is deleted, never reused.
	pending map[string]*pendingHandshake
	// pendingDial holds initiator-side hellos that still need a Keystore
	// signature from the Android host before BindTranscript.
	pendingDial map[string]*pendingDial
	// signers is the optional in-process ES256 private key used by Dial when
	// the host (tests, a Go peer) can sign without leaving the process.
	signers map[string]*ecdsa.PrivateKey
	// dispatch routes unsealed business frames to per-kind handlers. It is what
	// turns the node from a pipe into the Link channel.
	dispatch *Dispatcher
	// streamWriters holds the live server-push path per stream session, so a
	// host can originate sealed frames (Agent bastion tunnels) on a stream the
	// peer dialed in with.
	streamWriters map[string]*streamPushWriter
	// agentHub is the embedded Agent tunnel hub, created on /link/tunnel/start.
	agentHub *AgentTunnelHub
}

// RequireEnrollment makes the handshake reject unregistered devices and require
// an ES256 proof bound to the handshake transcript.
func (n *Node) RequireEnrollment() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.requireAuth = true
	if n.devices == nil {
		n.devices = make(map[string]*DeviceRecord)
	}
}

// NewNode builds a node with the transport routes mounted.
func NewNode() *Node {
	n := &Node{
		mux:           http.NewServeMux(),
		sessions:      make(map[string]*Endpoint),
		sessionTLS:    make(map[string]sessionTLS),
		sessionDevice: make(map[string]string),
		pending:       make(map[string]*pendingHandshake),
		pendingDial:   make(map[string]*pendingDial),
		signers:       make(map[string]*ecdsa.PrivateKey),
		dispatch:      NewDispatcher(),
		streamWriters: make(map[string]*streamPushWriter),
		// Generous enough for a slow LAN server, hard enough to never hang the host.
		dialClient: &http.Client{Timeout: 15 * time.Second},
	}
	// Serve both the Go-native names (/link/...) and the mounted leaf names
	// (/handshake, /push) so a dialer can point Dial/SendFrame at either the bare Go
	// root or the main end's /api/link/v2 root with the same leaf paths.
	n.mux.HandleFunc("/link/handshake", n.handleHandshake)
	n.mux.HandleFunc("/handshake", n.handleHandshake)
	n.mux.HandleFunc("/link/handshake/finish", n.handleHandshakeFinish)
	n.mux.HandleFunc("/handshake/finish", n.handleHandshakeFinish)
	n.mux.HandleFunc("/link/frame", n.handleFrame)
	n.mux.HandleFunc("/push", n.handleFrame)
	// Embedded hosts (Android/desktop) drive outbound dials through this local
	// endpoint, so the device side also runs the shared Go core.
	n.mux.HandleFunc("/link/dial", n.handleDial)
	n.mux.HandleFunc("/link/dial/finish", n.handleDialFinish)
	// And they push business frames on an established session through this local
	// endpoint: seal with the session endpoint, POST to the peer's /link/frame,
	// unseal the reply. The host never sees key material.
	n.mux.HandleFunc("/link/push", n.handlePushFrame)
	// Real-time full-duplex channel: the server upgrades to a WebSocket and relays
	// sealed frames; the proxy shuttles bytes without ever decrypting. The bare
	// /stream leaf mirrors the /handshake + /push dual naming so a dialer can
	// point at either the bare Go root or a mounted sub-path root.
	n.mux.HandleFunc("/link/stream", n.handleStream)
	n.mux.HandleFunc("/stream", n.handleStream)
	// Session liveness/state probe for a device; sealed so it rides the channel.
	n.mux.HandleFunc("/link/state", n.handleState)
	// Embedded hosts use these for device-identity ML-KEM-768. Kotlin never
	// implements the primitive; it posts raw keys/ciphertexts and the Go core
	// returns the result. Loopback only — the embedded process binds 127.0.0.1.
	n.mux.HandleFunc("/link/mlkem/generate", n.handleMlkemGenerate)
	n.mux.HandleFunc("/link/mlkem/encapsulate", n.handleMlkemEncapsulate)
	n.mux.HandleFunc("/link/mlkem/decapsulate", n.handleMlkemDecapsulate)
	// Embedded Agent hosts start the bastion tunnel hub here: the Go core
	// connects /link/stream and pumps TCP bytes under the session keys. The
	// host only names the peer and session; no key material ever leaves.
	n.mux.HandleFunc("/link/tunnel/start", n.handleTunnelStart)
	// Loopback mirror of every zft2 lane for the host process (Dart). One
	// local WebSocket carries all lanes; messages prefix the lane id.
	n.mux.HandleFunc("/link/zft2/stream", n.handleZft2Local)
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
	/* KindAI is a registered lane. Leaving it unregistered made every AI
	 * frame a 500 handler_failed and poisoned the shared ZSL session that
	 * owned-sync also uses. Acknowledge here; the embedding host may replace
	 * this with a real broker bridge. */
	n.dispatch.Register(codec.KindAI, func(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
		var body map[string]any
		if len(fr.Body) > 0 {
			if err := codec.Decode(fr.Body, &body); err != nil {
				return codec.KindAI, map[string]any{
					"ok": false,
					"error": map[string]any{
						"code":      "invalid_request",
						"message":   "invalid AI frame",
						"retryable": false,
					},
				}, false, nil
			}
		}
		op, _ := body["op"].(string)
		return codec.KindAI, map[string]any{
			"ok":      true,
			"op":      op,
			"channel": string(codec.ChannelAI),
		}, false, nil
	})
}

// handleTunnelStart boots the Agent-side tunnel hub on an established dial
// session. It answers once the stream is attached; the pump itself runs in the
// background until the stream dies or the process exits.
func (n *Node) handleTunnelStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		PeerURL   string `json:"peerUrl"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.SessionID == "" || req.PeerURL == "" {
		http.Error(w, "sessionId and peerUrl required", http.StatusBadRequest)
		return
	}
	n.mu.Lock()
	hub := n.agentHub
	n.mu.Unlock()
	if hub == nil {
		hub = NewAgentTunnelHub(n)
		n.mu.Lock()
		if n.agentHub == nil {
			n.agentHub = hub
		} else {
			hub = n.agentHub
		}
		n.mu.Unlock()
	}
	if err := hub.Start(req.PeerURL, req.SessionID); err != nil {
		errJSON(w, http.StatusBadGateway, "tunnel_start_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

// handleZft2Local upgrades a loopback WebSocket that mirrors every zft2 lane:
// inbound binary = main-end frames to feed the Dart dispatcher; outbound
// binary = Dart replies sealed back onto the Link stream. One socket carries
// all lanes; frames carry the tunnel id in a tiny prefix.
func (n *Node) handleZft2Local(w http.ResponseWriter, r *http.Request) {
	n.mu.Lock()
	hub := n.agentHub
	n.mu.Unlock()
	if hub == nil {
		errJSON(w, http.StatusPreconditionFailed, "zft2_unavailable", "tunnel hub not started")
		return
	}
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "upgrade required", http.StatusUpgradeRequired)
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	key := r.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		return
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
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
	hub.ServeZft2Local(conn, rw.Reader)
}

// AgentHub exposes the embedded Agent tunnel hub, when started.
func (n *Node) AgentHub() *AgentTunnelHub {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.agentHub
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
//
// When the peer requires an ES256 finish and this process has no in-process
// signer, the response is a pending hello: {ok, pending:true, sessionId,
// transcript}. The host signs the transcript with Keystore and POSTs
// /link/dial/finish. Tests and a Go peer that installed SetDeviceSigner still
// complete in one round trip.
func (n *Node) handleDial(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ServerURL  string   `json:"serverUrl"`
		DeviceID   string   `json:"deviceId"`
		SPKIPins   []string `json:"spkiPins"`
		Insecure   bool     `json:"insecure"`
		ServerName string   `json:"serverName"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	if req.ServerURL == "" {
		http.Error(w, "serverUrl required", http.StatusBadRequest)
		return
	}
	result, err := n.dial(req.ServerURL, req.DeviceID, req.SPKIPins, req.Insecure, req.ServerName)
	if err != nil {
		var remote *RemoteLinkError
		if errors.As(err, &remote) {
			errJSONRetryable(w, http.StatusBadGateway, remote.Code, remote.Message, remote.Retryable)
		} else {
			errJSONRetryable(w, http.StatusBadGateway, "link_unavailable", "Link handshake failed", true)
		}
		return
	}
	tls := sessionTLS{
		pins:       append([]string{}, req.SPKIPins...),
		insecure:   req.Insecure,
		serverName: strings.TrimSpace(req.ServerName),
	}
	if result.pending {
		n.mu.Lock()
		n.pendingDial[result.sessionID] = &pendingDial{
			peerURL:    req.ServerURL,
			deviceID:   req.DeviceID,
			sessionID:  result.sessionID,
			session:    result.session,
			transcript: result.transcript,
			spkiPins:   tls.pins,
			insecure:   tls.insecure,
			serverName: tls.serverName,
			expiresAt:  time.Now().Add(HandshakePendingTTL),
		}
		n.sessionTLS[result.sessionID] = tls
		n.mu.Unlock()
		writeJSON(w, map[string]any{
			"ok": true, "pending": true,
			"sessionId":  result.sessionID,
			"transcript": base64.RawURLEncoding.EncodeToString(result.transcript),
		})
		return
	}
	n.mu.Lock()
	n.sessions[result.sessionID] = NewEndpoint(result.session)
	n.sessionTLS[result.sessionID] = tls
	n.mu.Unlock()
	writeJSON(w, map[string]any{
		"ok": true, "sessionId": result.sessionID,
		"exporter": base64.RawURLEncoding.EncodeToString(result.session.Exporter()),
	})
}

func (n *Node) handleDialFinish(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SessionID string `json:"sessionId"`
		Proof     string `json:"proof"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad json")
		return
	}
	now := time.Now()
	n.mu.Lock()
	n.sweepPendingLocked(now)
	pending := n.pendingDial[req.SessionID]
	if pending != nil {
		delete(n.pendingDial, req.SessionID)
	}
	n.mu.Unlock()
	if pending == nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "unknown or expired handshake")
		return
	}
	if req.Proof == "" {
		errJSON(w, http.StatusForbidden, "proof_required", errProofRequired.Error())
		return
	}
	if err := n.completePeerFinish(pending.peerURL, pending.sessionID, req.Proof, pending.spkiPins, pending.insecure, pending.serverName); err != nil {
		var remote *RemoteLinkError
		if errors.As(err, &remote) {
			errJSONRetryable(w, http.StatusBadGateway, remote.Code, remote.Message, remote.Retryable)
			return
		}
		errJSONRetryable(w, http.StatusBadGateway, "link_unavailable", "Link handshake finish failed", true)
		return
	}
	if err := pending.session.BindTranscript(pending.transcript); err != nil {
		errJSON(w, http.StatusInternalServerError, "handshake_failed", err.Error())
		return
	}
	n.mu.Lock()
	n.sessions[pending.sessionID] = NewEndpoint(pending.session)
	n.mu.Unlock()
	writeJSON(w, map[string]any{
		"ok": true, "sessionId": pending.sessionID,
		"exporter": base64.RawURLEncoding.EncodeToString(pending.session.Exporter()),
	})
}

// pushFrameRequest is the embedded host's local push: which established session,
// what business kind/body, and whether it rides the secret lane. The peer URL is
// remembered from the dial so the host only names the session.
type pushFrameRequest struct {
	SessionID  string   `json:"sessionId"`
	PeerURL    string   `json:"peerUrl"`
	Kind       int      `json:"kind"`
	Body       any      `json:"body"`
	Secret     bool     `json:"secret"`
	SPKIPins   []string `json:"spkiPins"`
	Insecure   bool     `json:"insecure"`
	ServerName string   `json:"serverName"`
}

type sessionTLS struct {
	pins       []string
	insecure   bool
	serverName string
}

// handlePushFrame is the embedded dial-side sender. The Kotlin/desktop host owns
// WHAT to send; the Go core owns sealing and the wire, so every client speaks
// byte-identical Link v2.
func (n *Node) handlePushFrame(w http.ResponseWriter, r *http.Request) {
	var req pushFrameRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	decoder.UseNumber()
	if err := decoder.Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad json")
		return
	}
	n.mu.Lock()
	ep := n.sessions[req.SessionID]
	stored := n.sessionTLS[req.SessionID]
	n.mu.Unlock()
	if ep == nil {
		errJSON(w, http.StatusBadRequest, "session_unknown", "Link 会话不存在")
		return
	}
	if req.PeerURL == "" {
		errJSON(w, http.StatusBadRequest, "bad_request", "peerUrl required")
		return
	}
	pins := req.SPKIPins
	if len(pins) == 0 {
		pins = stored.pins
	}
	insecure := req.Insecure || stored.insecure
	serverName := strings.TrimSpace(req.ServerName)
	if serverName == "" {
		serverName = stored.serverName
	}
	ack, err := n.sendFrame(req.PeerURL, req.SessionID, ep, req.Kind, req.Body, req.Secret, pins, insecure, serverName)
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
	result, err := n.dial(baseURL, deviceID, nil, false, "")
	if err != nil {
		return nil, "", err
	}
	if result.pending {
		return nil, "", errors.New("link: handshake requires a device proof this process cannot produce")
	}
	// Record the session locally so a later stream/tunnel attach on this node
	// finds it, mirroring what the handleDial HTTP path does for embedded hosts.
	n.mu.Lock()
	n.sessions[result.sessionID] = NewEndpoint(result.session)
	n.mu.Unlock()
	return NewEndpoint(result.session), result.sessionID, nil
}

type dialResult struct {
	session    *zsl.Session
	sessionID  string
	pending    bool
	transcript []byte
}

func (n *Node) dial(baseURL, deviceID string, spkiPins []string, insecure bool, serverName string) (*dialResult, error) {
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		return nil, err
	}
	reqBody, _ := json.Marshal(handshakeHelloRequest{
		DeviceID:     deviceID,
		X25519Public: base64.RawURLEncoding.EncodeToString(init.X25519Public),
		MLKEMPublic:  base64.RawURLEncoding.EncodeToString(init.MLKEMPublic),
	})
	client, err := n.clientForPeer(baseURL, spkiPins, insecure, serverName)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/handshake", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	applyPeerHost(req, baseURL, serverName)
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return nil, decodeRemoteLinkError(resp.StatusCode, msg, "handshake_failed")
	}
	var hr handshakeHelloResponse
	if err := json.NewDecoder(resp.Body).Decode(&hr); err != nil {
		return nil, err
	}
	x25519Public, err := b64d(hr.X25519Public)
	if err != nil {
		return nil, err
	}
	kemCt, err := b64d(hr.MLKEMCiphertext)
	if err != nil {
		return nil, err
	}
	sess, err := init.HandshakeFinish(&zsl.ResponderHello{X25519Public: x25519Public, MLKEMCiphertext: kemCt})
	if err != nil {
		return nil, err
	}
	if hr.Challenge == "" {
		return &dialResult{session: sess, sessionID: hr.SessionID}, nil
	}
	challenge, err := b64d(hr.Challenge)
	if err != nil {
		return nil, err
	}
	transcript := zsl.TranscriptHash(deviceID, init.X25519Public, init.MLKEMPublic, x25519Public, kemCt, challenge)
	if hr.Transcript != "" {
		claimed, err := b64d(hr.Transcript)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(claimed, transcript) {
			return nil, errors.New("link: peer transcript mismatch")
		}
	}
	if signer := n.signerFor(deviceID); signer != nil {
		proof, err := signHandshakeProof(signer, deviceID, transcript)
		if err != nil {
			return nil, err
		}
		if err := n.completePeerFinish(baseURL, hr.SessionID, proof, spkiPins, insecure, serverName); err != nil {
			return nil, err
		}
		if err := sess.BindTranscript(transcript); err != nil {
			return nil, err
		}
		return &dialResult{session: sess, sessionID: hr.SessionID}, nil
	}
	return &dialResult{session: sess, sessionID: hr.SessionID, pending: true, transcript: transcript}, nil
}

// SendFrame seals a business frame and posts it to the peer, returning the
// peer's unsealed ack frame.
func (n *Node) SendFrame(baseURL, sessionID string, ep *Endpoint, kind int, body any, secret bool) (*codec.Frame, error) {
	return n.sendFrame(baseURL, sessionID, ep, kind, body, secret, nil, false, "")
}

func (n *Node) sendFrame(baseURL, sessionID string, ep *Endpoint, kind int, body any, secret bool, spkiPins []string, insecure bool, serverName string) (*codec.Frame, error) {
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
	client, err := n.clientForPeer(baseURL, spkiPins, insecure, serverName)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/push", bytes.NewReader(reqBody))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	applyPeerHost(req, baseURL, serverName)
	resp, err := client.Do(req)
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

func (n *Node) clientForPeer(baseURL string, spkiPins []string, insecure bool, serverName string) (*http.Client, error) {
	timeout := 20 * time.Second
	if n.dialClient != nil && n.dialClient.Timeout > 0 {
		timeout = n.dialClient.Timeout
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Hostname() == "" {
		return nil, errors.New("link: peer URL is invalid")
	}
	sni := strings.TrimSpace(serverName)
	if sni == "" {
		sni = parsed.Hostname()
	}
	explicitSNI := sni != parsed.Hostname()
	needCustomTLS := insecure || len(spkiPins) > 0 || explicitSNI
	if !needCustomTLS {
		if n.dialClient != nil {
			return n.dialClient, nil
		}
		return &http.Client{Timeout: timeout}, nil
	}
	if parsed.Scheme != "https" {
		return nil, errors.New("link: custom TLS peer must be an HTTPS URL")
	}
	tlsConfig := &tls.Config{
		MinVersion: tls.VersionTLS12,
		ServerName: sni,
	}
	if insecure {
		tlsConfig.InsecureSkipVerify = true
	} else if len(spkiPins) > 0 {
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
		tlsConfig.InsecureSkipVerify = true // verification is replaced below, never skipped
		tlsConfig.VerifyConnection = func(state tls.ConnectionState) error {
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
		}
	} else if explicitSNI {
		// Replacing Transport.TLSClientConfig drops Go's default pool unless
		// RootCAs is set. Android has no /etc/ssl/certs; the host exports the
		// system store as SSL_CERT_FILE. Load it so a domain rewritten to an
		// IP literal still verifies against public CAs.
		roots, err := x509.SystemCertPool()
		if err != nil {
			return nil, fmt.Errorf("link: system CA pool: %w", err)
		}
		if roots == nil {
			roots = x509.NewCertPool()
		}
		tlsConfig.RootCAs = roots
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = tlsConfig
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

func applyPeerHost(req *http.Request, baseURL, serverName string) {
	sni := strings.TrimSpace(serverName)
	if sni == "" {
		return
	}
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return
	}
	if net.ParseIP(parsed.Hostname()) == nil {
		return
	}
	port := parsed.Port()
	if port == "" || (parsed.Scheme == "https" && port == "443") || (parsed.Scheme == "http" && port == "80") {
		req.Host = sni
		return
	}
	req.Host = net.JoinHostPort(sni, port)
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
