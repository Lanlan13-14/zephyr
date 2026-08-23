package link

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

// Node is a Link v2 participant that can both host and dial encrypted sessions
// over plain HTTP. The same Node runs as the server peer, the desktop peer and
// the embedded mobile peer; only the listen address differs.
type Node struct {
	mux *http.ServeMux

	mu       sync.Mutex
	sessions map[string]*Endpoint // by session id
}

// NewNode builds a node with the transport routes mounted.
func NewNode() *Node {
	n := &Node{mux: http.NewServeMux(), sessions: make(map[string]*Endpoint)}
	n.mux.HandleFunc("/link/handshake", n.handleHandshake)
	n.mux.HandleFunc("/link/frame", n.handleFrame)
	// Embedded hosts (Android/desktop) drive outbound dials through this local
	// endpoint, so the device side also runs the shared Go core.
	n.mux.HandleFunc("/link/dial", n.handleDial)
	return n
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
		"exporter": base64.StdEncoding.EncodeToString(ep.Exporter()),
	})
}

// Handler exposes the node's HTTP routes.
func (n *Node) Handler() http.Handler { return n.mux }

type handshakeRequest struct {
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

func b64d(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

func (n *Node) handleHandshake(w http.ResponseWriter, r *http.Request) {
	var req handshakeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	x25519Public, err := b64d(req.X25519Public)
	if err != nil {
		http.Error(w, "bad x25519", http.StatusBadRequest)
		return
	}
	mlkemPublic, err := b64d(req.MLKEMPublic)
	if err != nil {
		http.Error(w, "bad mlkem", http.StatusBadRequest)
		return
	}
	hello, sess, err := zsl.HandshakeResponder(x25519Public, mlkemPublic)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	sessionID := base64.StdEncoding.EncodeToString(sess.Exporter()[:16])
	n.mu.Lock()
	n.sessions[sessionID] = NewEndpoint(sess)
	n.mu.Unlock()
	writeJSON(w, handshakeResponse{
		SessionID:       sessionID,
		X25519Public:    base64.StdEncoding.EncodeToString(hello.X25519Public),
		MLKEMCiphertext: base64.StdEncoding.EncodeToString(hello.MLKEMCiphertext),
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
		writeJSON(w, frameResponse{OK: false, Error: "session_unknown"})
		return
	}
	iv, _ := b64d(req.IV)
	ct, _ := b64d(req.CT)
	tag, _ := b64d(req.Tag)
	fr, err := ep.Receive(&Envelope{Seq: req.Seq, IV: iv, CT: ct, Tag: tag})
	if err != nil {
		writeJSON(w, frameResponse{OK: false, Error: err.Error()})
		return
	}
	// Echo the received kind back as an ack, sealed on the same channel.
	ack, err := ep.Send(2 /* SYNC_ACK */, map[string]any{"receivedKind": fr.Kind, "ok": true}, false)
	if err != nil {
		writeJSON(w, frameResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, frameResponse{
		OK:  true,
		Seq: ack.Seq,
		IV:  base64.StdEncoding.EncodeToString(ack.IV),
		CT:  base64.StdEncoding.EncodeToString(ack.CT),
		Tag: base64.StdEncoding.EncodeToString(ack.Tag),
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
		X25519Public: base64.StdEncoding.EncodeToString(init.X25519Public),
		MLKEMPublic:  base64.StdEncoding.EncodeToString(init.MLKEMPublic),
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
		IV:        base64.StdEncoding.EncodeToString(env.IV),
		CT:        base64.StdEncoding.EncodeToString(env.CT),
		Tag:       base64.StdEncoding.EncodeToString(env.Tag),
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
