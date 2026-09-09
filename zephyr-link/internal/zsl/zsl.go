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
//
// Device authentication (P0) binds the established session to the enrollment
// transcript: after the ES256 proof verifies, both peers re-derive send/recv/
// exporter from HKDF(master || transcript, info="zsl2-bound"). An unbound
// session is a KEM-only channel and must not carry business frames on an
// enrolled device.
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

	IVBytes     = 12
	TagBytes    = 16
	KeyBytes    = 32
	X25519Bytes = 32
	// ML-KEM-768 encoded sizes, checked fail-closed before any cipher is built.
	MLKEM768PublicKeyBytes  = 1184
	MLKEM768CiphertextBytes = 1088
	maxSkip                 = 64
	hkdfSaltInput           = "zephyr-zsl2-v1"
	aadPrefix               = "zsl2-aad-v1"
	maxSeq                  = ^uint64(0)
	transcriptInfo          = "zsl2-transcript-v1"
	boundInfo               = "zsl2-bound"
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

// TranscriptHash is the canonical handshake transcript:
//
//	SHA-256("zsl2-transcript-v1" || 0x00 || deviceId || 0x00 ||
//	        initX25519 || initMLKEM || respX25519 || mlkemCT || challenge)
//
// Both peers hash the same bytes. The ES256 proof is over this digest, and
// BindTranscript mixes it into the traffic keys so a captured KEM transcript
// cannot be spliced onto another device's session.
func TranscriptHash(deviceID string, initX25519, initMLKEM, respX25519, mlkemCT, challenge []byte) []byte {
	h := sha256.New()
	h.Write([]byte(transcriptInfo))
	h.Write([]byte{0})
	h.Write([]byte(deviceID))
	h.Write([]byte{0})
	h.Write(initX25519)
	h.Write(initMLKEM)
	h.Write(respX25519)
	h.Write(mlkemCT)
	h.Write(challenge)
	return h.Sum(nil)
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

func kemMaster(xShared, pqShared []byte) []byte {
	ikm := make([]byte, 0, len(xShared)+len(pqShared))
	ikm = append(ikm, xShared...)
	ikm = append(ikm, pqShared...)
	return derive(ikm, "zsl2-master", KeyBytes)
}

func boundMaster(master, transcript []byte) []byte {
	ikm := make([]byte, 0, len(master)+len(transcript))
	ikm = append(ikm, master...)
	ikm = append(ikm, transcript...)
	return derive(ikm, boundInfo, KeyBytes)
}

// HandshakeResponder answers an initiator hello and returns the hello plus the
// responder-side session (already keyed to the unbound KEM master). Callers
// that authenticate a device MUST BindTranscript before sealing business frames.
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
	master := kemMaster(xShared, pqShared)
	hello := &ResponderHello{
		X25519Public:    x.PublicKey().Bytes(),
		MLKEMCiphertext: kemCt,
	}
	return hello, openSession(master, "responder"), nil
}

// HandshakeFinish completes the device side and returns its session keyed to
// the unbound KEM master. BindTranscript after the proof step.
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
	master := kemMaster(xShared, pqShared)
	return openSession(master, "initiator"), nil
}

func openSession(master []byte, role string) *Session {
	sendLabel, recvLabel := "zsl2-send-r", "zsl2-send-i"
	if role == "initiator" {
		sendLabel, recvLabel = "zsl2-send-i", "zsl2-send-r"
	}
	masterCopy := append([]byte{}, master...)
	return &Session{
		role:     role,
		master:   masterCopy,
		sendKey:  derive(masterCopy, sendLabel, KeyBytes),
		recvKey:  derive(masterCopy, recvLabel, KeyBytes),
		exporter: derive(masterCopy, "zsl2-exporter", KeyBytes),
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
	master   []byte
	sendKey  []byte
	recvKey  []byte
	exporter []byte
	bound    bool

	mu      sync.Mutex
	sendSeq uint64
	recvSeq uint64
	seen    map[uint64]struct{}
}

// Exporter returns the channel exporter, used to bind capabilities to this session.
func (s *Session) Exporter() []byte { return append([]byte{}, s.exporter...) }

// Bound reports whether BindTranscript has mixed the handshake proof into the
// traffic keys. Enrolled sessions must be bound before they carry frames.
func (s *Session) Bound() bool { return s.bound }

// BindTranscript re-derives send/recv/exporter from the KEM master and the
// canonical handshake transcript. It may run once; a second call with a
// different transcript is rejected so a MITM cannot rotate keys after the
// proof step.
func (s *Session) BindTranscript(transcript []byte) error {
	if len(transcript) != sha256.Size {
		return errors.New("zsl: transcript must be 32 bytes")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bound {
		return errors.New("zsl: session already bound")
	}
	if s.sendSeq != 0 || s.recvSeq != 0 || len(s.seen) != 0 {
		return errors.New("zsl: cannot bind a session that has already carried frames")
	}
	bound := boundMaster(s.master, transcript)
	sendLabel, recvLabel := "zsl2-send-r", "zsl2-send-i"
	if s.role == "initiator" {
		sendLabel, recvLabel = "zsl2-send-i", "zsl2-send-r"
	}
	s.sendKey = derive(bound, sendLabel, KeyBytes)
	s.recvKey = derive(bound, recvLabel, KeyBytes)
	s.exporter = derive(bound, "zsl2-exporter", KeyBytes)
	s.master = bound
	s.bound = true
	return nil
}

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
