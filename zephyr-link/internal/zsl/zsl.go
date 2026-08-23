// Package zsl implements ZSL/2: an X25519 + ML-KEM-768 hybrid KEM with
// HKDF-SHA256 key schedule and AES-256-GCM AEAD, byte-compatible with the
// reference Node implementation in link-v2-zsl.js. One suite, one wire format,
// shared by the server, desktop and mobile runtimes.
//
// Byte-compatibility contract (must match link-v2-zsl.js exactly):
//   - HKDF salt = sha256("zephyr-zsl2-v1")
//   - master    = HKDF(x25519_shared || mlkem_shared, info="zsl2-master")
//   - send keys = HKDF(master, info="zsl2-send-i" | "zsl2-send-r")
//   - exporter  = HKDF(master, info="zsl2-exporter")
//   - AAD       = "zsl2-aad-v1" || exporter || direction || seq(padded to 20)
package zsl

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"sync"
)

const (
	// Suite names the single frozen ZSL/2 construction.
	Suite = "ZSL/2-X25519+ML-KEM-768-HKDF-SHA256-AES-256-GCM"

	IVBytes    = 12
	TagBytes   = 16
	KeyBytes   = 32
	X25519Bytes = 32
	// ML-KEM-768 encoded sizes, checked fail-closed before any cipher is built.
	MLKEM768PublicKeyBytes     = 1184
	MLKEM768CiphertextBytes    = 1088
	maxSkip                    = 64
	hkdfSaltInput              = "zephyr-zsl2-v1"
	aadPrefix                  = "zsl2-aad-v1"
	maxSeq                     = ^uint64(0)
)

var hkdfSalt = sha256.Sum256([]byte(hkdfSaltInput))

// derive runs HKDF-SHA256 with the frozen salt, matching Node's crypto.hkdfSync.
func derive(ikm []byte, info string, length int) []byte {
	out, err := hkdf.Key(sha256.New, ikm, hkdfSalt[:], info, length)
	if err != nil {
		// hkdf.Key only errors on absurd lengths; treat as a hard failure.
		panic(fmt.Sprintf("zsl: hkdf %s: %v", info, err))
	}
	return out
}

// Initiator is the device side's half of a handshake: fresh X25519 + ML-KEM
// keypairs whose public halves go to the responder.
type Initiator struct {
	X25519Public  []byte
	x25519Private *ecdh.PrivateKey
	MLKEMPublic   []byte
	mlkemPrivate  *mlkem.DecapsulationKey768
}

// GenerateMLKEM768 returns a raw ML-KEM-768 public key and the 64-byte seed
// that reconstructs the matching decapsulation key. The seed is what a device
// persists; the public key is what the server seals secret envelopes to.
func GenerateMLKEM768() (publicKey, seed []byte, err error) {
	dk, err := mlkem.GenerateKey768()
	if err != nil {
		return nil, nil, err
	}
	return dk.EncapsulationKey().Bytes(), dk.Bytes(), nil
}

// EncapsulateMLKEM768 seals a shared secret to a raw 1184-byte public key.
func EncapsulateMLKEM768(publicKey []byte) (shared, ciphertext []byte, err error) {
	ek, err := mlkem.NewEncapsulationKey768(publicKey)
	if err != nil {
		return nil, nil, err
	}
	shared, ciphertext = ek.Encapsulate()
	return shared, ciphertext, nil
}

// DecapsulateMLKEM768 opens a ciphertext with a 64-byte seed.
func DecapsulateMLKEM768(seed, ciphertext []byte) ([]byte, error) {
	dk, err := mlkem.NewDecapsulationKey768(seed)
	if err != nil {
		return nil, err
	}
	return dk.Decapsulate(ciphertext)
}

// HandshakeInitiator generates the device-side hello.
func HandshakeInitiator() (*Initiator, error) {
	x, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("zsl: x25519 keygen: %w", err)
	}
	pq, err := mlkem.GenerateKey768()
	if err != nil {
		return nil, fmt.Errorf("zsl: mlkem keygen: %w", err)
	}
	return &Initiator{
		X25519Public:  x.PublicKey().Bytes(),
		x25519Private: x,
		MLKEMPublic:   pq.EncapsulationKey().Bytes(),
		mlkemPrivate:  pq,
	}, nil
}

// ResponderHello is what the responder returns to the initiator.
type ResponderHello struct {
	X25519Public    []byte
	MLKEMCiphertext []byte
}

// HandshakeResponder answers an initiator hello and returns the hello plus the
// responder-side session (already keyed).
func HandshakeResponder(x25519Public, mlkemPublic []byte) (*ResponderHello, *Session, error) {
	if len(mlkemPublic) != MLKEM768PublicKeyBytes {
		return nil, nil, fmt.Errorf("zsl: ML-KEM-768 public key must be %d bytes", MLKEM768PublicKeyBytes)
	}
	peerX, err := ecdh.X25519().NewPublicKey(x25519Public)
	if err != nil {
		return nil, nil, fmt.Errorf("zsl: bad x25519 public key: %w", err)
	}
	x, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("zsl: x25519 keygen: %w", err)
	}
	xShared, err := x.ECDH(peerX)
	if err != nil {
		return nil, nil, fmt.Errorf("zsl: x25519 shared: %w", err)
	}
	ek, err := mlkem.NewEncapsulationKey768(mlkemPublic)
	if err != nil {
		return nil, nil, fmt.Errorf("zsl: bad mlkem public key: %w", err)
	}
	pqShared, kemCt := ek.Encapsulate()
	master := derive(append(append([]byte{}, xShared...), pqShared...), "zsl2-master", KeyBytes)
	hello := &ResponderHello{
		X25519Public:    x.PublicKey().Bytes(),
		MLKEMCiphertext: kemCt,
	}
	return hello, openSession(master, "responder"), nil
}

// HandshakeFinish completes the device side and returns its session.
func (i *Initiator) HandshakeFinish(hello *ResponderHello) (*Session, error) {
	if len(hello.MLKEMCiphertext) != MLKEM768CiphertextBytes {
		return nil, fmt.Errorf("zsl: ML-KEM-768 ciphertext must be %d bytes", MLKEM768CiphertextBytes)
	}
	peerX, err := ecdh.X25519().NewPublicKey(hello.X25519Public)
	if err != nil {
		return nil, fmt.Errorf("zsl: bad responder x25519 key: %w", err)
	}
	xShared, err := i.x25519Private.ECDH(peerX)
	if err != nil {
		return nil, fmt.Errorf("zsl: x25519 shared: %w", err)
	}
	pqShared, err := i.mlkemPrivate.Decapsulate(hello.MLKEMCiphertext)
	if err != nil {
		return nil, fmt.Errorf("zsl: mlkem decapsulate: %w", err)
	}
	master := derive(append(append([]byte{}, xShared...), pqShared...), "zsl2-master", KeyBytes)
	return openSession(master, "initiator"), nil
}

func openSession(master []byte, role string) *Session {
	sendLabel, recvLabel := "zsl2-send-r", "zsl2-send-i"
	if role == "initiator" {
		sendLabel, recvLabel = "zsl2-send-i", "zsl2-send-r"
	}
	return &Session{
		role:     role,
		sendKey:  derive(master, sendLabel, KeyBytes),
		recvKey:  derive(master, recvLabel, KeyBytes),
		exporter: derive(master, "zsl2-exporter", KeyBytes),
		seen:     make(map[uint64]struct{}),
	}
}

// Frame is a sealed ZSL/2 message on the wire.
type Frame struct {
	Seq uint64
	IV  []byte
	CT  []byte
	Tag []byte
}

// Session is a keyed ZSL/2 channel with replay protection.
type Session struct {
	role     string
	sendKey  []byte
	recvKey  []byte
	exporter []byte

	mu      sync.Mutex
	sendSeq uint64
	recvSeq uint64
	seen    map[uint64]struct{}
}

// Exporter returns the channel exporter, used to bind capabilities to this session.
func (s *Session) Exporter() []byte { return append([]byte{}, s.exporter...) }

func (s *Session) aad(direction byte, seq uint64) []byte {
	out := make([]byte, 0, len(aadPrefix)+KeyBytes+1+20)
	out = append(out, aadPrefix...)
	out = append(out, s.exporter...)
	out = append(out, direction)
	padded := strconv.FormatUint(seq, 10)
	for len(padded) < 20 {
		padded = "0" + padded
	}
	out = append(out, padded...)
	return out
}

// Seal encrypts and authenticates a plaintext business frame.
func (s *Session) Seal(plaintext []byte) (*Frame, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sendSeq == maxSeq {
		return nil, errors.New("zsl: send sequence exhausted; rekey required")
	}
	seq := s.sendSeq
	s.sendSeq++
	iv := make([]byte, IVBytes)
	if _, err := rand.Read(iv); err != nil {
		return nil, fmt.Errorf("zsl: iv: %w", err)
	}
	block, err := aes.NewCipher(s.sendKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, IVBytes)
	if err != nil {
		return nil, err
	}
	aad := s.aad('s', seq)
	sealed := gcm.Seal(nil, iv, plaintext, aad)
	ct, tag := sealed[:len(sealed)-TagBytes], sealed[len(sealed)-TagBytes:]
	return &Frame{Seq: seq, IV: iv, CT: ct, Tag: tag}, nil
}

// Open decrypts a frame and enforces the replay window.
func (s *Session) Open(f *Frame) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seq := f.Seq
	if seq < s.recvSeq && s.recvSeq-seq > maxSkip {
		return nil, errors.New("zsl: replay rejected (sequence too old)")
	}
	if _, dup := s.seen[seq]; dup {
		return nil, errors.New("zsl: replay rejected (duplicate sequence)")
	}
	block, err := aes.NewCipher(s.recvKey)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCMWithNonceSize(block, IVBytes)
	if err != nil {
		return nil, err
	}
	aad := s.aad('s', seq)
	sealed := append(append([]byte{}, f.CT...), f.Tag...)
	plain, err := gcm.Open(nil, f.IV, sealed, aad)
	if err != nil {
		return nil, errors.New("zsl: authentication failed")
	}
	s.seen[seq] = struct{}{}
	if seq >= s.recvSeq {
		s.recvSeq = seq + 1
	}
	if len(s.seen) > maxSkip*4 {
		min := uint64(0)
		if s.recvSeq > maxSkip {
			min = s.recvSeq - maxSkip
		}
		for k := range s.seen {
			if k < min {
				delete(s.seen, k)
			}
		}
	}
	return plain, nil
}
