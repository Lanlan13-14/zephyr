// Package link combines the ZSL/2 secure channel with the wire codec into a
// usable peer endpoint. One Endpoint implementation is shared by the server,
// the desktop shell and the embedded mobile runtime — that is what makes the
// three ends interoperable by construction rather than by parallel ports.
package link

import (
	"errors"
	"fmt"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/zsl"
)

// Envelope is a sealed frame as it travels on any transport (WSS, HTTP POST).
type Envelope struct {
	Seq uint64 `json:"seq" cbor:"seq"`
	IV  []byte `json:"iv" cbor:"iv"`
	CT  []byte `json:"ct" cbor:"ct"`
	Tag []byte `json:"tag" cbor:"tag"`
}

// Endpoint is one keyed peer of a Link v2 session.
type Endpoint struct {
	sess *zsl.Session
}

// NewEndpoint wraps a keyed ZSL session.
func NewEndpoint(sess *zsl.Session) *Endpoint { return &Endpoint{sess: sess} }

// Exporter binds application capabilities to this channel.
func (e *Endpoint) Exporter() []byte { return e.sess.Exporter() }

// Send packs a business frame and seals it for the peer.
func (e *Endpoint) Send(kind int, body any, secret bool) (*Envelope, error) {
	packed, err := codec.Pack(kind, body, secret)
	if err != nil {
		return nil, err
	}
	f, err := e.sess.Seal(packed)
	if err != nil {
		return nil, err
	}
	return &Envelope{Seq: f.Seq, IV: f.IV, CT: f.CT, Tag: f.Tag}, nil
}

// Receive opens a sealed envelope and unpacks the business frame.
func (e *Endpoint) Receive(env *Envelope) (*codec.Frame, error) {
	if env == nil {
		return nil, errors.New("link: nil envelope")
	}
	plain, err := e.sess.Open(&zsl.Frame{Seq: env.Seq, IV: env.IV, CT: env.CT, Tag: env.Tag})
	if err != nil {
		return nil, err
	}
	fr, err := codec.Unpack(plain)
	if err != nil {
		return nil, fmt.Errorf("link: %w", err)
	}
	return fr, nil
}

// Pair performs a full handshake between a device (initiator) and a host
// (responder) entirely in-process. Real transports carry the two hellos over
// HTTP; the key schedule is identical either way.
func Pair() (device, host *Endpoint, err error) {
	init, err := zsl.HandshakeInitiator()
	if err != nil {
		return nil, nil, err
	}
	hello, hostSess, err := zsl.HandshakeResponder(init.X25519Public, init.MLKEMPublic)
	if err != nil {
		return nil, nil, err
	}
	devSess, err := init.HandshakeFinish(hello)
	if err != nil {
		return nil, nil, err
	}
	return NewEndpoint(devSess), NewEndpoint(hostSess), nil
}
