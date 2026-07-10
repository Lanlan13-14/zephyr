package rdpgfx

import "time"

// H264BrokenReason describes why a decoder became unrecoverable.
type H264BrokenReason int

const (
	H264BrokenReasonNone H264BrokenReason = iota
	H264BrokenReasonInitFailure
	H264BrokenReasonHWStall
	H264BrokenReasonNoIDR
)

func (r H264BrokenReason) String() string {
	switch r {
	case H264BrokenReasonInitFailure:
		return "init-failure"
	case H264BrokenReasonHWStall:
		return "hw-stall"
	case H264BrokenReasonNoIDR:
		return "no-idr"
	default:
		return "none"
	}
}

// H264Frame holds a decoded H.264 frame in BGRA pixel format.
type H264Frame struct {
	Data          []byte // BGRA pixel data, 4 bytes per pixel (nil when Dropped)
	Width, Height int
	// Dropped is true when the decoder intentionally discarded this frame
	// (e.g. zero-filled VideoToolbox IOSurface) rather than experiencing a
	// genuine codec stall.  Callers must skip bitmap updates but must NOT
	// request a keyframe or flag the decoder as broken.
	Dropped bool
}

// H264FrameI420 holds a decoded H.264 frame in planar I420 (YUV420P) format.
// SDL2 can render I420 natively via hardware-accelerated YUV→RGB shaders using
// a PIXELFORMAT_IYUV texture, eliminating CPU-side colour conversion.
// Plane slices borrow ring-buffer memory; the caller must copy all slices
// before the next Decode call.
type H264FrameI420 struct {
	Y, U, V                   []byte
	YStride, UStride, VStride int
	Width, Height             int
	FullRange                 bool // true when the source used full-range (JPEG/PC) YUV
}

// H264FrameNV12 holds a decoded H.264 frame in NV12 format (Y plane plus
// interleaved UV plane).  VideoToolbox commonly transfers hardware-decoded
// H.264 frames as NV12; SDL2 can upload NV12 directly, avoiding the CPU-side
// NV12->I420 deinterleave needed by the I420 path.
type H264FrameNV12 struct {
	Y, UV     []byte
	YStride   int
	UVStride  int
	Width     int
	Height    int
	FullRange bool
}

// I420Decoder is an optional interface that an H264Decoder may implement to
// produce I420 output alongside the normal BGRA frame.  Callers detect support
// via a type assertion.
type I420Decoder interface {
	// DecodeWithI420 decodes H.264 NAL data and returns both a BGRA frame
	// and an optional I420 frame for GPU-accelerated rendering.  The I420
	// frame is nil when the pixel format is not directly convertible;
	// callers must fall back to the BGRA frame in that case.
	DecodeWithI420(h264Data []byte) (*H264Frame, *H264FrameI420, error)
}

// NV12Decoder is an optional interface for decoders that can expose native
// NV12 output.  Callers should fall back to I420 or BGRA when the returned
// NV12 frame is nil.
type NV12Decoder interface {
	DecodeWithNV12(h264Data []byte) (*H264Frame, *H264FrameNV12, error)
}

// RegionHinter is an optional interface implemented by decoders that support
// region-aware YUV→BGRA conversion.  When SetRegionHint is called immediately
// before Decode, the decoder only converts pixels within the specified dirty
// rectangles, skipping unchanged areas of the frame.
// Each element of rects is [left, top, right, bottom].
type RegionHinter interface {
	SetRegionHint(rects [][4]uint16)
}

// H264Decoder decodes H.264 Annex B bitstream data into BGRA frames.
type H264Decoder interface {
	// Decode decodes H.264 NAL units and returns a decoded frame.
	// Returns nil frame (no error) when the decoder needs more input data.
	Decode(h264Data []byte) (*H264Frame, error)
	// NeedsKeyframe reports whether the decoder is waiting for a keyframe.
	NeedsKeyframe() bool
	// NeedsIDR reports whether the decoder is explicitly waiting for an IDR frame.
	NeedsIDR() bool
	// IsBroken reports whether the decoder is permanently unrecoverable.
	IsBroken() bool
	// BrokenReason reports why the decoder became unrecoverable.
	BrokenReason() H264BrokenReason
	// ForceBroken marks the decoder unrecoverable for the given reason.
	ForceBroken(reason H264BrokenReason)
	// HardResetCount returns the number of hard resets performed so far.
	HardResetCount() int
	// LastReceiveTime returns the wall-clock time of the most recent Decode() call.
	LastReceiveTime() time.Time
	// Close releases all resources held by the decoder.
	Close()
}

// H264DecoderBackend holds factory functions for creating H264Decoder instances.
// Register a backend via SetH264Backend before starting any RDP session.
// Typically called from an init() function in the application binary.
type H264DecoderBackend struct {
	// NewHW creates a hardware-preferred decoder with an optional watchdog channel.
	// watchdogCh may be nil for the initial decoder (no watchdog).
	NewHW func(watchdogCh chan<- struct{}) H264Decoder
	// NewSW creates a software-only decoder without a watchdog (for aux decoders).
	NewSW func() H264Decoder
	// NewSWFallback creates a software-only decoder with a watchdog
	// (used as the post-VideoToolbox-stall fallback decoder).
	NewSWFallback func(watchdogCh chan<- struct{}) H264Decoder
}

var h264Backend *H264DecoderBackend

// SetH264Backend registers the H.264 decoder backend.
// Must be called before any RDP session is started.
// When the h264 build tag is set, example/h264_ffmpeg.go calls this in its init().
func SetH264Backend(b *H264DecoderBackend) { h264Backend = b }

func newH264Decoder() H264Decoder { return newH264DecoderWithWatchdog(nil) }

func newH264DecoderWithWatchdog(ch chan<- struct{}) H264Decoder {
	if h264Backend == nil || h264Backend.NewHW == nil {
		return nil
	}
	return h264Backend.NewHW(ch)
}

func newH264DecoderSW() H264Decoder {
	if h264Backend == nil || h264Backend.NewSW == nil {
		return nil
	}
	return h264Backend.NewSW()
}

func newH264DecoderSWWithWatchdog(ch chan<- struct{}) H264Decoder {
	if h264Backend == nil || h264Backend.NewSWFallback == nil {
		return nil
	}
	return h264Backend.NewSWFallback(ch)
}
