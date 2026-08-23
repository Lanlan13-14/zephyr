package link

import (
	"errors"
	"fmt"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// FrameContext carries the per-frame facts a handler needs to enforce
// per-channel rules: which keyed session the frame arrived on, which isolated
// channel the kind belongs to, and whether the frame was flagged secret.
type FrameContext struct {
	// SessionID addresses the session the frame arrived on (empty for
	// in-process peers that have no transport id).
	SessionID string
	// Channel is the §15 isolated lane the frame's kind maps to.
	Channel codec.Channel
	// Secret is the frame's secret flag, asserted against the channel policy.
	Secret bool
}

// Handler processes one business frame and returns the frame to seal back as
// the reply. Returning a nil body with a nil error sends no reply (the caller
// then answers with a bare ok). A handler must not mutate the frame it was
// handed.
type Handler func(ctx *FrameContext, fr *codec.Frame) (replyKind int, replyBody any, secret bool, err error)

// Dispatcher routes unsealed business frames to the handler registered for
// their kind. It replaces the old echo-the-kind acknowledgement, which is what
// made the Link a pipe instead of a channel. An unknown kind and a registered
// kind with no handler are both hard failures, never silently acknowledged.
type Dispatcher struct {
	handlers map[int]Handler
}

// NewDispatcher builds an empty dispatcher.
func NewDispatcher() *Dispatcher {
	return &Dispatcher{handlers: make(map[int]Handler)}
}

// Register installs the handler for a kind. The kind must be a registered
// registry kind; registering an unknown kind is a programming error and
// panics, because it would only surface as frames that can never be routed.
func (d *Dispatcher) Register(kind int, h Handler) {
	if !codec.HasKind(kind) {
		panic(fmt.Sprintf("link: register of unknown kind %d", kind))
	}
	if h == nil {
		panic("link: nil handler")
	}
	d.handlers[kind] = h
}

// Dispatch routes one frame. It enforces two invariants before any handler
// runs:
//
//  1. The kind must be registered. An unknown kind is rejected outright, so a
//     peer cannot probe for unimplemented lanes by watching which frames get
//     a generic ack.
//  2. A frame flagged secret must map to the secret channel. A secret frame on
//     any other lane means the sender compressed or routed account secret
//     material outside its isolated lane, which §18/§20 forbid.
func (d *Dispatcher) Dispatch(ctx *FrameContext, fr *codec.Frame) (int, any, bool, error) {
	if fr == nil {
		return 0, nil, false, errors.New("link: nil frame")
	}
	channel, ok := codec.ChannelOf(fr.Kind)
	if !ok {
		return 0, nil, false, fmt.Errorf("link: unknown kind %d", fr.Kind)
	}
	if ctx == nil {
		ctx = &FrameContext{}
	}
	ctx.Channel = channel
	ctx.Secret = fr.Secret
	if fr.Secret && channel != codec.ChannelSecret {
		return 0, nil, false, fmt.Errorf("link: secret flag on non-secret channel %q", channel)
	}
	// The converse: a frame routed to the secret channel must carry the secret
	// flag, otherwise it shared a compression context with ordinary metadata
	// (§18/§20 forbid that). Reject before the handler runs.
	if channel == codec.ChannelSecret && !fr.Secret {
		return 0, nil, false, fmt.Errorf("link: secret-channel kind %d without the secret flag", fr.Kind)
	}
	h := d.handlers[fr.Kind]
	if h == nil {
		return 0, nil, false, fmt.Errorf("link: no handler for kind %d (%s)", fr.Kind, channel)
	}
	return h(ctx, fr)
}

// ErrUnknownKind is returned (wrapped) when a frame's kind is not in the
// registry, so transports can map it to a distinct wire error.
var ErrUnknownKind = errors.New("link: unknown kind")
