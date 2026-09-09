package link

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

type handshakeHelloRequest struct {
	DeviceID     string `json:"deviceId"`
	X25519Public string `json:"x25519Public"`
	MLKEMPublic  string `json:"mlkemPublic"`
}

type handshakeHelloResponse struct {
	OK              bool   `json:"ok"`
	SessionID       string `json:"sessionId"`
	Suite           string `json:"suite"`
	X25519Public    string `json:"x25519Public"`
	MLKEMCiphertext string `json:"mlkemCiphertext"`
	Challenge       string `json:"challenge,omitempty"`
	Transcript      string `json:"transcript,omitempty"`
	ExpiresAt       int64  `json:"expiresAt,omitempty"`
}

type handshakeFinishRequest struct {
	SessionID string `json:"sessionId"`
	Proof     string `json:"proof"`
}

type handshakeFinishResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"sessionId"`
	Exporter  string `json:"exporter"`
}

type pendingHandshake struct {
	deviceID    string
	initX25519  []byte
	initMLKEM   []byte
	respX25519  []byte
	mlkemCT     []byte
	challenge   []byte
	transcript  []byte
	session     *zsl.Session
	expiresAt   time.Time
	requireAuth bool
}

type pendingDial struct {
	peerURL    string
	deviceID   string
	sessionID  string
	session    *zsl.Session
	transcript []byte
	spkiPins   []string
	insecure   bool
	serverName string
	expiresAt  time.Time
}

func randomSessionID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

// RegisterDevice marks a device ID as eligible to handshake. Without a signing
// key the hello still proceeds; finish fails closed. Prefer RegisterDeviceKey.
func (n *Node) RegisterDevice(deviceID string) {
	n.RegisterDeviceKey(deviceID, nil)
}

// RegisterDeviceKey records an enrollment-approved ES256 public key. A handshake
// on an enrolled node cannot establish a session without a valid proof under it.
func (n *Node) RegisterDeviceKey(deviceID string, jwk json.RawMessage) {
	if deviceID == "" {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.devices == nil {
		n.devices = make(map[string]*DeviceRecord)
	}
	copied := append(json.RawMessage(nil), jwk...)
	n.devices[deviceID] = &DeviceRecord{DeviceID: deviceID, SigningJWK: copied}
}

// SetDeviceSigner installs the initiator-side ES256 key used by Dial to finish
// a proof-required handshake. Production Android never uses this: Keystore
// signs and posts /link/dial/finish. Tests and a local Go peer do.
func (n *Node) SetDeviceSigner(deviceID string, priv *ecdsa.PrivateKey) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.signers == nil {
		n.signers = make(map[string]*ecdsa.PrivateKey)
	}
	n.signers[deviceID] = priv
}

func (n *Node) lookupDevice(deviceID string) (*DeviceRecord, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.devices == nil {
		return nil, true // enrollment not required
	}
	rec, ok := n.devices[deviceID]
	return rec, ok
}

func (n *Node) enrollmentRequired() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.requireAuth
}

func (n *Node) sweepPendingLocked(now time.Time) {
	for id, p := range n.pending {
		if now.After(p.expiresAt) {
			delete(n.pending, id)
		}
	}
	for id, p := range n.pendingDial {
		if now.After(p.expiresAt) {
			delete(n.pendingDial, id)
		}
	}
}

func (n *Node) handleHandshake(w http.ResponseWriter, r *http.Request) {
	var req handshakeHelloRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
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
	if len(mlkemPublic) != zsl.MLKEM768PublicKeyBytes || len(x25519Public) != zsl.X25519Bytes {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad key size")
		return
	}
	rec, enrolled := n.lookupDevice(req.DeviceID)
	if !enrolled {
		errJSON(w, http.StatusForbidden, "device_not_enrolled", "设备未完成绑定")
		return
	}
	hello, sess, err := zsl.HandshakeResponder(x25519Public, mlkemPublic)
	if err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", err.Error())
		return
	}
	sessionID, err := randomSessionID()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "handshake_failed", "challenge unavailable")
		return
	}
	requireAuth := n.enrollmentRequired()
	resp := handshakeHelloResponse{
		OK:              true,
		SessionID:       sessionID,
		Suite:           zsl.Suite,
		X25519Public:    base64.RawURLEncoding.EncodeToString(hello.X25519Public),
		MLKEMCiphertext: base64.RawURLEncoding.EncodeToString(hello.MLKEMCiphertext),
	}
	if !requireAuth {
		n.mu.Lock()
		n.sessions[sessionID] = NewEndpoint(sess)
		n.sessionDevice[sessionID] = req.DeviceID
		n.mu.Unlock()
		writeJSON(w, resp)
		return
	}
	if rec == nil || len(rec.SigningJWK) == 0 {
		errJSON(w, http.StatusForbidden, "device_key_missing", errDeviceKeyMissing.Error())
		return
	}
	if _, err := parseES256JWK(rec.SigningJWK); err != nil {
		errJSON(w, http.StatusForbidden, "device_key_missing", err.Error())
		return
	}
	challenge, err := newHandshakeChallenge()
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "handshake_failed", "challenge unavailable")
		return
	}
	transcript := zsl.TranscriptHash(req.DeviceID, x25519Public, mlkemPublic, hello.X25519Public, hello.MLKEMCiphertext, challenge)
	now := time.Now()
	n.mu.Lock()
	n.sweepPendingLocked(now)
	n.pending[sessionID] = &pendingHandshake{
		deviceID:    req.DeviceID,
		initX25519:  append([]byte{}, x25519Public...),
		initMLKEM:   append([]byte{}, mlkemPublic...),
		respX25519:  append([]byte{}, hello.X25519Public...),
		mlkemCT:     append([]byte{}, hello.MLKEMCiphertext...),
		challenge:   challenge,
		transcript:  transcript,
		session:     sess,
		expiresAt:   now.Add(HandshakePendingTTL),
		requireAuth: true,
	}
	n.mu.Unlock()
	resp.Challenge = base64.RawURLEncoding.EncodeToString(challenge)
	resp.Transcript = base64.RawURLEncoding.EncodeToString(transcript)
	resp.ExpiresAt = now.Add(HandshakePendingTTL).UnixMilli()
	writeJSON(w, resp)
}

func (n *Node) handleHandshakeFinish(w http.ResponseWriter, r *http.Request) {
	var req handshakeFinishRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "bad json")
		return
	}
	if req.SessionID == "" {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "sessionId required")
		return
	}
	now := time.Now()
	n.mu.Lock()
	n.sweepPendingLocked(now)
	pending := n.pending[req.SessionID]
	if pending != nil {
		delete(n.pending, req.SessionID)
	}
	n.mu.Unlock()
	if pending == nil {
		errJSON(w, http.StatusBadRequest, "invalid_handshake", "unknown or expired handshake")
		return
	}
	if now.After(pending.expiresAt) {
		errJSON(w, http.StatusForbidden, "challenge_expired", errChallengeExpired.Error())
		return
	}
	if req.Proof == "" {
		errJSON(w, http.StatusForbidden, "proof_required", errProofRequired.Error())
		return
	}
	rec, enrolled := n.lookupDevice(pending.deviceID)
	if !enrolled || rec == nil {
		errJSON(w, http.StatusForbidden, "device_not_enrolled", "设备未完成绑定")
		return
	}
	pub, err := parseES256JWK(rec.SigningJWK)
	if err != nil {
		errJSON(w, http.StatusForbidden, "device_key_missing", err.Error())
		return
	}
	expected := zsl.TranscriptHash(pending.deviceID, pending.initX25519, pending.initMLKEM, pending.respX25519, pending.mlkemCT, pending.challenge)
	if sha256.Sum256(expected) != sha256.Sum256(pending.transcript) {
		errJSON(w, http.StatusForbidden, "proof_invalid", errProofInvalid.Error())
		return
	}
	if err := verifyHandshakeProof(pub, pending.deviceID, expected, req.Proof); err != nil {
		errJSON(w, http.StatusForbidden, "proof_invalid", errProofInvalid.Error())
		return
	}
	if err := pending.session.BindTranscript(expected); err != nil {
		errJSON(w, http.StatusInternalServerError, "handshake_failed", err.Error())
		return
	}
	n.mu.Lock()
	n.sessions[req.SessionID] = NewEndpoint(pending.session)
	n.sessionDevice[req.SessionID] = pending.deviceID
	n.mu.Unlock()
	writeJSON(w, handshakeFinishResponse{
		OK:        true,
		SessionID: req.SessionID,
		Exporter:  base64.RawURLEncoding.EncodeToString(pending.session.Exporter()),
	})
}

func (n *Node) signerFor(deviceID string) *ecdsa.PrivateKey {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.signers[deviceID]
}

func finishURL(baseURL string) string { return baseURL + "/handshake/finish" }

func (n *Node) completePeerFinish(baseURL, sessionID, proof string, spkiPins []string, insecure bool, serverName string) error {
	reqBody, _ := json.Marshal(handshakeFinishRequest{SessionID: sessionID, Proof: proof})
	client, err := n.clientForPeer(baseURL, spkiPins, insecure, serverName)
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequest(http.MethodPost, finishURL(baseURL), bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	applyPeerHost(httpReq, baseURL, serverName)
	resp, err := client.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
		return decodeRemoteLinkError(resp.StatusCode, msg, "handshake_failed")
	}
	return nil
}
