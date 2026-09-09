package link

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"
)

const (
	// HandshakeProofPrefix is the NUL-delimited proof payload prefix. The
	// signed bytes are prefix || 0x00 || deviceId || 0x00 || transcript.
	HandshakeProofPrefix = "zephyr-zsl2-handshake-v1"
	// HandshakeChallengeBytes is a 256-bit single-use nonce.
	HandshakeChallengeBytes = 32
	// HandshakePendingTTL is how long a half-open hello may wait for finish.
	HandshakePendingTTL = 30 * time.Second
	p1363Bytes          = 64
)

var (
	errProofInvalid     = errors.New("link: handshake proof invalid")
	errProofRequired    = errors.New("link: handshake proof required")
	errChallengeReplay  = errors.New("link: handshake challenge already consumed")
	errChallengeExpired = errors.New("link: handshake challenge expired")
	errDeviceKeyMissing = errors.New("link: enrolled device has no ES256 public key")
	errDeviceKeyInvalid = errors.New("link: enrolled device ES256 public key is invalid")
)

// DeviceRecord is the enrollment-approved identity the handshake verifier uses.
type DeviceRecord struct {
	DeviceID   string
	SigningJWK json.RawMessage
}

// DeviceDirectory looks up a consumed enrollment. Tests and the server process
// both implement this; a missing record is indistinguishable from an unenrolled
// device so the size-check oracle stays closed.
type DeviceDirectory interface {
	Lookup(deviceID string) (*DeviceRecord, bool)
}

type mapDirectory map[string]*DeviceRecord

func (m mapDirectory) Lookup(deviceID string) (*DeviceRecord, bool) {
	rec, ok := m[deviceID]
	return rec, ok
}

func newHandshakeChallenge() ([]byte, error) {
	out := make([]byte, HandshakeChallengeBytes)
	if _, err := rand.Read(out); err != nil {
		return nil, fmt.Errorf("link: challenge: %w", err)
	}
	return out, nil
}

func handshakeProofPayload(deviceID string, transcript []byte) []byte {
	out := make([]byte, 0, len(HandshakeProofPrefix)+1+len(deviceID)+1+len(transcript))
	out = append(out, HandshakeProofPrefix...)
	out = append(out, 0)
	out = append(out, deviceID...)
	out = append(out, 0)
	out = append(out, transcript...)
	return out
}

func decodeP1363(value string) ([]byte, error) {
	encoded := strings.TrimSpace(value)
	if encoded == "" {
		return nil, errProofInvalid
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) != p1363Bytes {
		return nil, errProofInvalid
	}
	if base64.StdEncoding.EncodeToString(raw) != encoded {
		return nil, errProofInvalid
	}
	return raw, nil
}

func parseES256JWK(raw json.RawMessage) (*ecdsa.PublicKey, error) {
	if len(raw) == 0 {
		return nil, errDeviceKeyMissing
	}
	var jwk struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}
	if err := json.Unmarshal(raw, &jwk); err != nil {
		return nil, errDeviceKeyInvalid
	}
	if jwk.Kty != "EC" || jwk.Crv != "P-256" || jwk.X == "" || jwk.Y == "" {
		return nil, errDeviceKeyInvalid
	}
	x, err := decodeJWKCoord(jwk.X)
	if err != nil {
		return nil, errDeviceKeyInvalid
	}
	y, err := decodeJWKCoord(jwk.Y)
	if err != nil {
		return nil, errDeviceKeyInvalid
	}
	curve := elliptic.P256()
	if !curve.IsOnCurve(x, y) {
		return nil, errDeviceKeyInvalid
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func decodeJWKCoord(value string) (*big.Int, error) {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		std, stdErr := base64.StdEncoding.DecodeString(value)
		if stdErr != nil {
			return nil, err
		}
		raw = std
	}
	if len(raw) == 0 || len(raw) > 32 {
		return nil, errors.New("bad coord")
	}
	padded := make([]byte, 32)
	copy(padded[32-len(raw):], raw)
	return new(big.Int).SetBytes(padded), nil
}

func verifyHandshakeProof(pub *ecdsa.PublicKey, deviceID string, transcript []byte, proof string) error {
	sig, err := decodeP1363(proof)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(handshakeProofPayload(deviceID, transcript))
	r := new(big.Int).SetBytes(sig[:32])
	s := new(big.Int).SetBytes(sig[32:])
	if r.Sign() <= 0 || s.Sign() <= 0 {
		return errProofInvalid
	}
	if !ecdsa.Verify(pub, sum[:], r, s) {
		return errProofInvalid
	}
	return nil
}

// SignHandshakeProof produces the standard-Base64 P1363 proof a device posts
// on /handshake/finish. Tests and the in-process Dial signer use this; Android
// Keystore signs the same payload on the host.
func SignHandshakeProof(priv *ecdsa.PrivateKey, deviceID string, transcript []byte) (string, error) {
	return signHandshakeProof(priv, deviceID, transcript)
}

func signHandshakeProof(priv *ecdsa.PrivateKey, deviceID string, transcript []byte) (string, error) {
	sum := sha256.Sum256(handshakeProofPayload(deviceID, transcript))
	r, s, err := ecdsa.Sign(rand.Reader, priv, sum[:])
	if err != nil {
		return "", err
	}
	out := make([]byte, p1363Bytes)
	r.FillBytes(out[:32])
	s.FillBytes(out[32:])
	return base64.StdEncoding.EncodeToString(out), nil
}

// JWKFromPublic encodes an ES256 public key as a P-256 JWK object.
func JWKFromPublic(pub *ecdsa.PublicKey) json.RawMessage { return jwkFromPublic(pub) }

func jwkFromPublic(pub *ecdsa.PublicKey) json.RawMessage {
	coord := func(n *big.Int) string {
		raw := n.FillBytes(make([]byte, 32))
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	body, _ := json.Marshal(map[string]string{
		"kty": "EC", "crv": "P-256",
		"x": coord(pub.X), "y": coord(pub.Y),
	})
	return body
}
