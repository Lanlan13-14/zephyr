// Package codec is the Link v2 wire codec: canonical CBOR + optional zstd,
// matching link-v2-codec.js. Compression happens before encryption; secret
// frames never share a compression context with ordinary metadata.
package codec

import (
	"errors"
	"fmt"

	"github.com/fxamacker/cbor/v2"
	"github.com/klauspost/compress/zstd"
)

const (
	MinCompressBytes   = 256
	MaxFrameBytes      = 4 * 1024 * 1024
	MaxDecompressRatio = 256
)

// KIND is the registry of business frame kinds. The integers are frozen on the
// wire (they ride inside the sealed CBOR envelope); adding a kind never changes
// how existing frames encode, so peers stay byte-identical.
const (
	KindSyncOp       = 1
	KindSyncAck      = 2
	KindBlobManifest = 3
	KindBlobChunk    = 4
	KindBlobHave     = 5
	KindWake         = 6
	KindRelay        = 7
	// KindControl carries control-plane frames (diagnostics, capability
	// negotiation, epoch/rekey notices) that are not account data.
	KindControl = 8
	// KindSecret carries a sealed secret envelope on the dedicated secret
	// channel. It is always packed with FlagSecret so it never shares a
	// compression context with ordinary metadata.
	KindSecret = 9
	// KindFileBridge carries a file-bridge lease operation scoped to one device,
	// one shareProfile and one time window.
	KindFileBridge = 10
	// KindSharedTerminal carries a shared online-use terminal stream (PTY
	// semantics only; the credential never leaves the broker).
	KindSharedTerminal = 11
	// KindSharedRemote carries a shared remote-desktop (RDP/VNC) control/frame
	// stream under a strict capability.
	KindSharedRemote = 12
	// KindSharedNote carries a shared-note online viewer/editor frame.
	KindSharedNote = 13
	// KindSharedFile carries a shared-file online-use stream.
	KindSharedFile = 14
	// KindAI carries a shared-AI event/trace/confirmation frame. The provider key
	// and resolved credential stay on the broker.
	KindAI = 15
)

const (
	FlagZstd   = 0x01
	FlagSecret = 0x02
)

// Channel names are the §15 isolated capability lanes. Each business kind maps
// onto exactly one channel; the channel is what per-channel capability, flow
// control and residency rules key off. Mapping is a pure function of kind, so
// it is identical on every peer without any wire change.
type Channel string

const (
	ChannelControl        Channel = "control"
	ChannelOwnedSync      Channel = "owned-sync"
	ChannelSecret         Channel = "secret"
	ChannelBlob           Channel = "blob"
	ChannelFileBridge     Channel = "file-bridge"
	ChannelSharedTerminal Channel = "shared-terminal"
	ChannelSharedRemote   Channel = "shared-remote"
	ChannelSharedNote     Channel = "shared-note"
	ChannelSharedFile     Channel = "shared-file"
	ChannelAI             Channel = "ai"
)

// kindChannel is the single source of truth for kind→channel. A kind absent
// here is not registered and must be rejected, not defaulted.
var kindChannel = map[int]Channel{
	KindControl:        ChannelControl,
	KindSyncOp:         ChannelOwnedSync,
	KindSyncAck:        ChannelOwnedSync,
	KindWake:           ChannelControl,
	KindSecret:         ChannelSecret,
	KindBlobManifest:   ChannelBlob,
	KindBlobChunk:      ChannelBlob,
	KindBlobHave:       ChannelBlob,
	KindFileBridge:     ChannelFileBridge,
	KindRelay:          ChannelSharedTerminal,
	KindSharedTerminal: ChannelSharedTerminal,
	KindSharedRemote:   ChannelSharedRemote,
	KindSharedNote:     ChannelSharedNote,
	KindSharedFile:     ChannelSharedFile,
	KindAI:             ChannelAI,
}

// HasKind reports whether kind is a registered business frame kind.
func HasKind(kind int) bool {
	_, ok := kindChannel[kind]
	return ok
}

// ChannelOf returns the isolated channel a kind belongs to.
func ChannelOf(kind int) (Channel, bool) {
	ch, ok := kindChannel[kind]
	return ch, ok
}

// encMode is deterministic (CTAP2/core) CBOR so a frame hashes identically on
// every peer — required for Merkle/chunk-id equality across Go and Node.
var encMode cbor.EncMode

var decMode cbor.DecMode

func init() {
	opts := cbor.CoreDetEncOptions()
	opts.Time = cbor.TimeRFC3339
	m, err := opts.EncMode()
	if err != nil {
		panic(err)
	}
	encMode = m
	d, err := cbor.DecOptions{}.DecMode()
	if err != nil {
		panic(err)
	}
	decMode = d
}

// Encode marshals v to canonical CBOR.
func Encode(v any) ([]byte, error) { return encMode.Marshal(v) }

// Decode unmarshals canonical CBOR.
func Decode(data []byte, v any) error { return decMode.Unmarshal(data, v) }

var zstdEncoder *zstd.Encoder
var zstdDecoder *zstd.Decoder

func init() {
	e, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedDefault))
	if err != nil {
		panic(err)
	}
	zstdEncoder = e
	d, err := zstd.NewReader(nil)
	if err != nil {
		panic(err)
	}
	zstdDecoder = d
}

// Compress zstd-compresses b.
func Compress(b []byte) []byte { return zstdEncoder.EncodeAll(b, nil) }

// Decompress inflates b with the same size and ratio guards as Node.
func Decompress(b []byte, originalSizeHint int) ([]byte, error) {
	if originalSizeHint > 0 && originalSizeHint > MaxFrameBytes {
		return nil, errors.New("decompressed frame exceeds max size")
	}
	out, err := zstdDecoder.DecodeAll(b, nil)
	if err != nil {
		return nil, fmt.Errorf("zstd: %w", err)
	}
	if len(out) > MaxFrameBytes {
		return nil, errors.New("decompressed frame exceeds max size")
	}
	if len(b) > 0 && len(out)/len(b) > MaxDecompressRatio {
		return nil, errors.New("decompression ratio exceeds hard limit")
	}
	return out, nil
}

func shouldCompress(size, flags int) bool {
	if flags&FlagSecret != 0 {
		return false
	}
	return size >= MinCompressBytes
}

// frame is the on-the-wire envelope. Field order and types are frozen: changing
// them changes the CBOR and breaks every peer.
type frame struct {
	V int    `cbor:"v"`
	K int    `cbor:"k"`
	F int    `cbor:"f"`
	N int    `cbor:"n"`
	D []byte `cbor:"d"`
}

// Frame is an unpacked business frame.
type Frame struct {
	Kind   int
	Flags  int
	Secret bool
	Body   []byte // decoded CBOR body payload
}

// Pack encodes a business frame: CBOR body, optional zstd, then the envelope.
func Pack(kind int, body any, secret bool) ([]byte, error) {
	if kind < 1 {
		return nil, errors.New("kind must be a registry integer")
	}
	payload, err := Encode(body)
	if err != nil {
		return nil, err
	}
	if len(payload) > MaxFrameBytes {
		return nil, errors.New("frame exceeds max size")
	}
	flags := 0
	if secret {
		flags = FlagSecret
	}
	data := payload
	if shouldCompress(len(payload), flags) {
		compressed := Compress(payload)
		if len(compressed) < len(payload) {
			flags |= FlagZstd
			data = compressed
		}
	}
	return Encode(frame{V: 2, K: kind, F: flags, N: len(payload), D: data})
}

// Unpack decodes an envelope back into a business frame.
func Unpack(data []byte) (*Frame, error) {
	var fr frame
	if err := Decode(data, &fr); err != nil {
		return nil, fmt.Errorf("invalid frame: %w", err)
	}
	if fr.V != 2 {
		return nil, errors.New("unsupported Link frame version")
	}
	if fr.N > MaxFrameBytes {
		return nil, errors.New("frame exceeds max size")
	}
	payload := fr.D
	var err error
	if fr.F&FlagZstd != 0 {
		payload, err = Decompress(payload, fr.N)
		if err != nil {
			return nil, err
		}
	}
	if len(payload) != fr.N {
		return nil, errors.New("frame length mismatch")
	}
	return &Frame{
		Kind:   fr.K,
		Flags:  fr.F,
		Secret: fr.F&FlagSecret != 0,
		Body:   payload,
	}, nil
}
