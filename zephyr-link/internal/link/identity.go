package link

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const enrollmentProofPrefix = "zephyr-link-enrollment-v2"

var identityDeviceSafe = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// EnablePersistentIdentity stores ES256 device keys under dir and uses them
// as Dial signers. Desktop and Apple Agent hosts call this so they do not
// re-implement Keystore signing; Android never does — it keeps signing in
// the host and posts /link/dial/finish itself.
func (n *Node) EnablePersistentIdentity(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return errors.New("link: identity dir required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("link: identity dir: %w", err)
	}
	n.mu.Lock()
	n.identityDir = dir
	n.mu.Unlock()
	return nil
}

func (n *Node) identityEnabled() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.identityDir != ""
}

func (n *Node) ensureDeviceSigner(deviceID string) (*ecdsa.PrivateKey, error) {
	if deviceID == "" {
		return nil, errors.New("link: deviceId required")
	}
	n.mu.Lock()
	if n.signers != nil {
		if priv := n.signers[deviceID]; priv != nil {
			n.mu.Unlock()
			return priv, nil
		}
	}
	dir := n.identityDir
	n.mu.Unlock()
	if dir == "" {
		return nil, errors.New("link: persistent identity is not enabled")
	}
	priv, err := loadOrCreateDeviceKey(dir, deviceID)
	if err != nil {
		return nil, err
	}
	n.SetDeviceSigner(deviceID, priv)
	return priv, nil
}

func identityKeyPath(dir, deviceID string) string {
	safe := identityDeviceSafe.ReplaceAllString(deviceID, "_")
	if safe == "" {
		safe = "device"
	}
	return filepath.Join(dir, "es256-"+safe+".p8")
}

func loadOrCreateDeviceKey(dir, deviceID string) (*ecdsa.PrivateKey, error) {
	path := identityKeyPath(dir, deviceID)
	raw, err := os.ReadFile(path)
	if err == nil {
		key, parseErr := x509.ParseECPrivateKey(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("link: identity key: %w", parseErr)
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return nil, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, der, 0o600); err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	return priv, nil
}

func (n *Node) signingJWKFor(deviceID string) (json.RawMessage, error) {
	priv, err := n.ensureDeviceSigner(deviceID)
	if err != nil {
		return nil, err
	}
	return JWKFromPublic(&priv.PublicKey), nil
}

func (n *Node) handleIdentityJWK(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	deviceID := strings.TrimSpace(r.URL.Query().Get("deviceId"))
	if deviceID == "" && r.Method == http.MethodPost {
		var req struct {
			DeviceID string `json:"deviceId"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<12)).Decode(&req); err == nil {
			deviceID = strings.TrimSpace(req.DeviceID)
		}
	}
	if deviceID == "" {
		errJSON(w, http.StatusBadRequest, "bad_request", "deviceId required")
		return
	}
	jwk, err := n.signingJWKFor(deviceID)
	if err != nil {
		errJSON(w, http.StatusBadGateway, "identity_unavailable", err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "jwk": json.RawMessage(jwk)})
}

func (n *Node) handleEnrollmentProof(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		BindID           string `json:"bindId"`
		DeviceID         string `json:"deviceId"`
		UserCode         string `json:"userCode"`
		SAS              string `json:"sas"`
		EnrollmentSecret string `json:"enrollmentSecret"`
		ServerID         string `json:"serverId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		errJSON(w, http.StatusBadRequest, "bad_request", "bad json")
		return
	}
	if req.DeviceID == "" || req.BindID == "" {
		errJSON(w, http.StatusBadRequest, "bad_request", "bindId and deviceId required")
		return
	}
	priv, err := n.ensureDeviceSigner(req.DeviceID)
	if err != nil {
		errJSON(w, http.StatusBadGateway, "identity_unavailable", err.Error())
		return
	}
	proof, err := SignEnrollmentProof(priv, req.BindID, req.DeviceID, req.UserCode, req.SAS, req.EnrollmentSecret, req.ServerID)
	if err != nil {
		errJSON(w, http.StatusInternalServerError, "sign_failed", err.Error())
		return
	}
	writeJSON(w, map[string]any{"ok": true, "proof": proof})
}

// SignEnrollmentProof matches the Android host: SHA-256 ECDSA over
// prefix\0bindId\0deviceId\0userCode\0sas\0sha256hex(secret)\0serverId,
// encoded as standard-Base64 P1363.
func SignEnrollmentProof(priv *ecdsa.PrivateKey, bindID, deviceID, userCode, sas, enrollmentSecret, serverID string) (string, error) {
	if priv == nil {
		return "", errors.New("link: nil signer")
	}
	sum := sha256.Sum256([]byte(enrollmentSecret))
	secretHash := hex.EncodeToString(sum[:])
	payload := strings.Join([]string{
		enrollmentProofPrefix,
		bindID,
		deviceID,
		enrollmentUserCode(userCode),
		sas,
		secretHash,
		serverID,
	}, "\x00")
	digest := sha256.Sum256([]byte(payload))
	r, s, err := ecdsa.Sign(rand.Reader, priv, digest[:])
	if err != nil {
		return "", err
	}
	out := make([]byte, p1363Bytes)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return base64.StdEncoding.EncodeToString(out), nil
}

func enrollmentUserCode(userCode string) string {
	up := strings.ToUpper(userCode)
	var b strings.Builder
	for _, r := range up {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}
