package rdpgfx

import (
	"encoding/binary"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/nakagami/grdp/plugin"
)

// regionPool reuses byte slices for progressive codec rectangle extraction,
// avoiding per-rectangle allocations that cause GC pressure.
var regionPool = sync.Pool{
	New: func() any { return []byte(nil) },
}

const (
	ChannelName = plugin.RDPGFX_DVC_CHANNEL_NAME
)

// suspendFrameAcknowledge is the queueDepth value defined in MS-RDPEGFX
// 2.2.2.8 that instructs the server to suspend sending new frames until
// the client sends a subsequent FRAME_ACKNOWLEDGE with a different value.
const suspendFrameAcknowledge uint32 = 0xFFFFFFFF

// RDPGFX Command IDs (MS-RDPEGFX 2.2.2)
const (
	cmdidWireToSurface1             uint16 = 0x0001
	cmdidWireToSurface2             uint16 = 0x0002
	cmdidDeleteEncodingContext      uint16 = 0x0003
	cmdidSolidFill                  uint16 = 0x0004
	cmdidSurfaceToSurface           uint16 = 0x0005
	cmdidSurfaceToCache             uint16 = 0x0006
	cmdidCacheToSurface             uint16 = 0x0007
	cmdidEvictCacheEntry            uint16 = 0x0008
	cmdidCreateSurface              uint16 = 0x0009
	cmdidDeleteSurface              uint16 = 0x000A
	cmdidStartFrame                 uint16 = 0x000B
	cmdidEndFrame                   uint16 = 0x000C
	cmdidFrameAcknowledge           uint16 = 0x000D
	cmdidResetGraphics              uint16 = 0x000E
	cmdidMapSurfaceToOutput         uint16 = 0x000F
	cmdidCacheImportOffer           uint16 = 0x0010
	cmdidCacheImportReply           uint16 = 0x0011
	cmdidCapsAdvertise              uint16 = 0x0012
	cmdidCapsConfirm                uint16 = 0x0013
	cmdidMapSurfaceToScaledOutput   uint16 = 0x0015
	cmdidMapSurfaceToScaledWindow   uint16 = 0x0016
	cmdidMapSurfaceToScaledOutputV2 uint16 = 0x0017 // v10.6+
	cmdidMapSurfaceToWindow         uint16 = 0x0018
)

// Pixel Formats
const (
	pixelFormatXRGB8888 uint8 = 0x20
	pixelFormatARGB8888 uint8 = 0x21
)

// Codec IDs (MS-RDPEGFX 2.2.2.1 / FreeRDP rdpgfx.h)
const (
	codecUncompressed uint16 = 0x0000
	codecCaVideo      uint16 = 0x0003 // RDPGFX_CODECID_CAVIDEO (RemoteFX tiles)
	codecPlanar       uint16 = 0x0004
	codecProgressive  uint16 = 0x0009
	codecAVC420       uint16 = 0x000B
	codecAVC444       uint16 = 0x000E
	codecAVC444v2     uint16 = 0x000F
)

// Capability versions and flags
const (
	capVersion8          uint32 = 0x00080004
	capVersion81         uint32 = 0x00080105
	capVersion10         uint32 = 0x000A0002
	capVersion101        uint32 = 0x000A0100
	capVersion102        uint32 = 0x000A0200
	capVersion103        uint32 = 0x000A0301
	capVersion104        uint32 = 0x000A0400
	capVersion105        uint32 = 0x000A0502
	capVersion106        uint32 = 0x000A0600
	capVersion1061       uint32 = 0x000A0601
	capVersion107        uint32 = 0x000A0701
	capFlagThinClient    uint32 = 0x00000001
	capFlagSmallCache    uint32 = 0x00000002
	capFlagAVC420Enabled uint32 = 0x00000010 // v8.1: explicitly enable AVC420
	capFlagAVCDisabled   uint32 = 0x00000020 // v10+: disable AVC
)

const headerSize = 8

// BitmapUpdate represents a rendered bitmap region.
//
// Lifecycle: Data is borrowed from an internal buffer pool and is only
// valid for the duration of the synchronous onBitmap callback.  After the
// callback returns, the slice may be returned to the pool and overwritten
// by subsequent updates.  Callers that need to retain the pixels (e.g. to
// hand them to an asynchronous paint goroutine) MUST copy the bytes
// before the callback returns.
type BitmapUpdate struct {
	DestLeft, DestTop, DestRight, DestBottom int
	Width, Height                            int
	Bpp                                      int    // bytes per pixel (always 4)
	Data                                     []byte // BGRA pixel data — see lifecycle note above
}

// bitmapBufPool reuses BGRA byte slices used to back BitmapUpdate.Data.
// Buffers are acquired with acquireBitmapBuf, handed to the onBitmap
// callback, and released with releaseBitmapBuf once the (synchronous)
// callback returns.  This eliminates per-rectangle allocations on the
// hot CaVideo / AVC partial-blit paths.
var bitmapBufPool = sync.Pool{
	New: func() any { return []byte(nil) },
}

// decodePkt is the message type for the async decode channel.
// pooled is true when data was acquired from bitmapBufPool; the receiver
// must call releaseBitmapBuf(data) after processing.
type decodePkt struct {
	data   []byte
	pooled bool
}

func acquireBitmapBuf(size int) []byte {
	if size <= 0 {
		return nil
	}
	b := bitmapBufPool.Get().([]byte)
	if cap(b) < size {
		return make([]byte, size)
	}
	return b[:size]
}

func releaseBitmapBuf(b []byte) {
	if b == nil {
		return
	}
	//nolint:staticcheck // intentional pool of byte slices
	bitmapBufPool.Put(b[:cap(b)])
}

// emitAndReleaseUpdates calls the onBitmap callback and then returns the
// pooled Data buffers of the supplied updates back to bitmapBufPool.  All
// updates passed in must have Data acquired via acquireBitmapBuf.
func (g *GfxHandler) emitAndReleaseUpdates(updates []BitmapUpdate) {
	if g.onBitmap != nil && len(updates) > 0 {
		g.onBitmap(updates)
	}
	for i := range updates {
		releaseBitmapBuf(updates[i].Data)
		updates[i].Data = nil
	}
}

type surface struct {
	width, height uint16
	format        uint8
	data          []byte // BGRA, 4 bytes per pixel
	outputX       uint32
	outputY       uint32
	mapped        bool
	// shadowStale is true when the CPU surface shadow (data) may not match the
	// pixels currently shown on the GPU display.  It is set when an AVC frame
	// advances the GPU display (onNV12/onI420) without a corresponding BGRA
	// shadow update (decoded == nil), and cleared by a full-surface blit.  While
	// stale, the region-only shadow blit fast path is bypassed in favour of a
	// full blit so the shadow is fully repaired before the next partial update.
	// Initialised true so the first frame on a fresh (zero-filled) surface always
	// takes the full-blit path.
	shadowStale bool
}

type vBarEntry struct {
	pixels []byte // BGR data, 3 bytes per pixel
	count  int
}

type clearCodecCtx struct {
	vBarStorage      []vBarEntry
	shortVBarStorage []vBarEntry
	vBarCursor       int
	shortVBarCursor  int
}

func newClearCodecCtx() *clearCodecCtx {
	return &clearCodecCtx{
		vBarStorage:      make([]vBarEntry, 32768),
		shortVBarStorage: make([]vBarEntry, 16384),
	}
}

type cacheEntry struct {
	data          []byte // BGRA pixel data
	width, height int
}

// GfxHandler implements the RDPGFX (MS-RDPEGFX) protocol.
type GfxHandler struct {
	surfaces     map[uint16]*surface
	cacheEntries map[uint16]cacheEntry
	clearCtx     *clearCodecCtx
	zgfx         *zgfxContext
	rfx          *rfxDecoder
	progressive  *rfxProgressiveDecoder
	h264dec      H264Decoder
	// h264dec2 is the auxiliary H.264 decoder used for AVC444v2 LC=2 chroma-upgrade
	// frames.  It decodes stream2, which carries chroma values for positions not
	// covered by stream1's 4:2:0 quantiser.  The decoded I420 planes are combined
	// with the luma and chroma planes cached from the most recent LC=0/1 main-stream
	// decode to reconstruct full 4:4:4 YUV before converting to BGRA.
	h264dec2 H264Decoder
	// avc444YPlane caches the luma (Y) and half-res chroma (U/V) planes from the
	// last main-stream AVC444 decode, for use when an LC=2 chroma-upgrade frame arrives.
	avc444YPlane avc444YPlane
	// avc444IDRYPlane caches the luma and half-res chroma planes from the most
	// recently decoded stream1 IDR frame.  When a standalone LC=2 packet carries
	// a stream2 IDR, it should be combined with the matching stream1 IDR luma
	// (not the latest P-frame luma stored in avc444YPlane), so we keep this
	// separate snapshot.
	avc444IDRYPlane avc444YPlane
	// lc2SampleLogged is set after the first LC=2 combine output has been
	// sampled for green/pink colour diagnostics.  Reset on each stream1 IDR so
	// we can observe the combine quality at every GOP boundary.
	lc2SampleLogged       bool
	lc2PFrameSampleLogged bool // logged first P-frame LC=2 combine after IDR
	lc0SampleLogged       bool // logged first LC=0 IDR frame pixel samples
	// framesDecoded is accessed from both read and decode goroutines.
	framesDecoded atomic.Uint32
	sendFn        func(data []byte)
	onBitmap      func([]BitmapUpdate)
	// decodeCh receives decompressed PDU data for asynchronous decode.
	decodeCh chan decodePkt
	// ackCh is a buffered channel of serialized ACK PDUs.  Every
	// EndFrame ACK is enqueued here and the writeLoop goroutine sends
	// each one to the server.  The server tracks outstanding frames
	// individually, so skipping ACKs causes it to stop sending.
	ackCh chan []byte
	// doneCh is closed by Close() to signal decodeLoop and writeLoop to exit.
	doneCh    chan struct{}
	closeOnce sync.Once
	// onDecoderBroken is called once when the H.264 decoder becomes permanently
	// unrecoverable (all soft resets exhausted).  The caller should reconnect
	// the RDP session to create a fresh decoder.
	onDecoderBroken       func()
	decoderBrokenNotified bool
	// watchdogCh receives signals from background timers inside ffmpegDecoder
	// when stall-probe or IDR-wait timeouts expire independently of server
	// frame rate.  decodeLoop selects on this channel so it calls
	// maybeNotifyDecoderBroken even when no server frames are arriving.
	watchdogCh chan struct{}
	// lastDecodedFrame records when a visible AVC frame was last produced.
	// Local-input watchdogs compare against this timestamp so recovery does
	// not wait for a subsequent H.264 packet to arrive.
	lastDecodedFrame atomic.Int64
	inputWatchdogMu  sync.Mutex
	inputWatchdog    *time.Timer
	inputWatchdogNS  int64
	// lastLC2RecvTime records when the most recent AVC444 LC=2 frame arrived,
	// regardless of whether it could be decoded.  Used to detect the
	// "server sending LC=2 only, aux decoder absent" deadlock.
	lastLC2RecvTime atomic.Int64
	// auxDecoderBrokenTimer fires after auxDecoderBrokenTimeout when h264dec2
	// is nil.  When it fires it signals watchdogCh so that decodeLoop can call
	// maybeRenegotiateCapabilities and break the LC=2-only deadlock.
	auxDecoderBrokenTimer   *time.Timer
	auxDecoderBrokenTimerMu sync.Mutex
	// onKeyframeRequest is called to ask the server to send a fresh IDR
	// keyframe.  Optional: if nil, the decoder will wait for the next
	// server-initiated keyframe.
	onKeyframeRequest func()
	// lastKeyframeRequest is the wall-clock time of the most recent keyframe
	// request sent to the server.  Used to rate-limit repeat requests.
	lastKeyframeRequest time.Time
	// softResetCount tracks how many in-place decoder resets have been
	// attempted since the last server-triggered RESET_GRAPHICS.
	softResetCount int
	// noIDRSoftResetCount tracks soft resets triggered specifically by the
	// no-IDR broken reason.  This counter is kept separate from softResetCount
	// so that a prior HW-stall reset (which increments softResetCount) does not
	// consume the no-IDR recovery budget.  Reset on RESET_GRAPHICS and on a
	// successful frame decode.
	noIDRSoftResetCount int
	// usingSWFallback is set after a HW stall forces a switch to software
	// decoding.  Both h264dec and h264dec2 are created SW-only while this
	// flag is true, avoiding repeated VideoToolbox stalls that would
	// otherwise trigger a full RDP reconnect.
	usingSWFallback bool
	// swFallbackPrimed is set after a SW fallback decoder has been primed
	// with the cached (stale) stream1 IDR.  It stays armed for the whole SW
	// fallback window — until a genuine fresh IDR resyncs the decoder
	// (maybeCacheStream1IDR) or RESET_GRAPHICS — so that consecutive dropped
	// frames caused by the stale prime can be detected and escalated to a
	// reconnect instead of producing endless green/zero-UV frames.  It is NOT
	// cleared by a single successful decode: stale-prime corruption only
	// appears once the following P-frames diverge from the missing reference.
	swFallbackPrimed bool
	// swFallbackDroppedCount counts dropped frames since the SW fallback
	// decoder was primed.  If it exceeds swFallbackDropLimit the decoder is
	// declared broken and onDecoderBroken is fired.
	swFallbackDroppedCount int
	// swFallbackFirstDropTime records when the current run of consecutive
	// stale-prime drops started.  It bounds how long corruption may persist
	// before escalating to a reconnect, giving the ForceRefresh resync IDR a
	// chance to heal the picture first.  Reset whenever a clean frame decodes.
	swFallbackFirstDropTime time.Time
	// lc2EverDecoded is set to true after the first successful AVC444 LC=2
	// chroma-upgrade decode.  maybeRenegotiateCapabilities uses this to
	// distinguish "LC=2 was working and then broke" (reconnect needed) from
	// "LC=2 never worked this session" (server may not support stream2 priming;
	// gracefully degrade to LC=0 only without reconnecting).
	lc2EverDecoded bool
	// auxDecoderNoIDRRetries counts how many times maybeRenegotiateCapabilities
	// has been called in the "stream2EverSeen but lc2EverDecoded=false" case
	// this session.  Each attempt sends a ForceRefresh; after
	// auxDecoderMaxIDRRetries consecutive attempts the session degrades to LC=0
	// only (no reconnect — the server consistently omits stream2 IDRs).
	// Reset on RESET_GRAPHICS, when LC=2 successfully decodes, and whenever
	// maybeRenegotiateCapabilities returns early due to no recent LC=2 activity
	// (e.g. during a HW-decoder GOP-boundary stall) so a resumed burst gets
	// fresh retries rather than inheriting the previous count.
	auxDecoderNoIDRRetries int
	// lc2PermanentlyDegraded is set when the server has not delivered a stream2
	// IDR despite repeated keyframe requests and lc2EverDecoded is still false.
	// Once set, LC=2 frames are silently skipped for the remainder of the session
	// without arming the renegotiation timer — avoiding an endless reconnect loop.
	// Cleared on RESET_GRAPHICS so a fresh AVC444 sequence gets a clean slate.
	// Cleared in primeAuxDecoder on a stream2 IDR to allow late recovery.
	lc2PermanentlyDegraded bool
	// stream2EverSeen is set when a non-empty stream2 payload is observed inside
	// an LC=0 packet.  VirtualBox VRDE never includes stream2 in LC=0 packets,
	// so stream2EverSeen stays false for the whole session.  Windows does include
	// stream2 in LC=0 IDRs, so stream2EverSeen becomes true as soon as the first
	// LC=0 AVC444 packet arrives.  maybeRenegotiateCapabilities uses this to
	// distinguish "server never sends stream2" (VirtualBox → permanent degrade)
	// from "stream2 seen but aux decoder not yet primed" (Windows, Chrome just
	// launched → transient, wait for IDR rather than logging a WARN).
	// Reset on RESET_GRAPHICS since the server starts a fresh AVC444 sequence.
	stream2EverSeen bool
	// lastStream1IDR caches the most recent stream1 H.264 IDR NAL data in
	// Annex B format.  When VideoToolbox stalls and the decoder falls back to
	// software, this data is fed immediately to the new SW decoder so it can
	// decode subsequent P-frames without waiting for the server to send a fresh
	// IDR via ForceRefresh (which some servers, e.g. VirtualBox VRDE, ignore).
	// Cleared on RESET_GRAPHICS to avoid feeding a stale IDR to a new pipeline.
	lastStream1IDR []byte
	// lastStream1IDRTime is the wall-clock time when the most recent stream1 IDR
	// was cached, logged for diagnostics (e.g. how stale the priming IDR was).
	// lastStream1IDRFrame is framesDecoded at the same instant, logged for diagnostics.
	lastStream1IDRTime  time.Time
	lastStream1IDRFrame uint32
	// avc444Disabled, when true, limits the CAPS_ADVERTISE to v8.0 and v8.1
	// (AVC420 only).  The server will never send AVC444/AVC444v2 frames, which
	// avoids the LC=2 colour degradation seen with VirtualBox VRDE.
	avc444Disabled bool
	// queueDepthHint is a minimum queueDepth to report in FRAME_ACKNOWLEDGE
	// PDUs.  A higher value makes the server believe the client has a larger
	// decode backlog, causing it to slow down or reduce encoding quality.
	// 0 means "report the real queue length" (default, no throttling).
	// See SetQueueDepthHint.
	queueDepthHint atomic.Uint32
	// singleUpdate is a pre-allocated one-element slice reused by emitBitmap
	// and emitBitmapPooled to avoid a heap allocation on every BGRA frame.
	// Safe: all emitBitmap* calls run on the single decode goroutine.
	singleUpdate [1]BitmapUpdate
	// updatesBuf is a pre-allocated slice reused by emitCaVideoRects and
	// blitAndEmitAVCRegions to avoid make() on every multi-region frame.
	// Safe: both functions run on the single decode goroutine and never call
	// each other.
	updatesBuf []BitmapUpdate
	// avcStream1 and avcStream2 are pre-allocated AVC stream structs reused by
	// fillAVC444Stream and the decode methods to avoid a heap allocation for
	// the stream header (struct + regions slice) on every H.264 frame.
	// Safe: all AVC decode calls run on the single decode goroutine.
	avcStream1 avc420Stream
	avcStream2 avc420Stream
	// regionHintBuf is a pre-allocated slice reused by the SetRegionHint call
	// sites to avoid a make([][4]uint16, ...) on every H.264 frame that carries
	// dirty region metadata.
	// Safe: used only on the single decode goroutine.
	regionHintBuf [][4]uint16
	// onH264Raw is called with raw H.264 NAL unit data when h264dec is nil
	// (e.g. WASM builds without CGo).  The caller can forward the data to a
	// JavaScript WebCodecs VideoDecoder instead.
	// destX, destY are the top-left canvas coordinates.
	onH264Raw func(destX, destY, w, h int, isKey bool, data []byte)
	// onI420 is called after a successful H.264 decode when I420 planar data
	// is available.  The caller can upload the planes to an SDL2 IYUV texture
	// for GPU-accelerated YUV→RGB conversion, bypassing the CPU colour path.
	// destX, destY are absolute canvas coordinates.
	onI420 func(destX, destY, w, h int, y []byte, yStride int, u []byte, uStride int, v []byte, vStride int)
	// onNV12 is like onI420 but receives native NV12 output.  It is preferred
	// by SDL2 clients when available because VideoToolbox commonly outputs
	// NV12 and SDL_UpdateNVTexture can upload it directly.
	onNV12 func(destX, destY, w, h int, y []byte, yStride int, uv []byte, uvStride int)
}

// NewGfxHandler creates a new RDPGFX handler.
func NewGfxHandler(onBitmap func([]BitmapUpdate)) *GfxHandler {
	g := &GfxHandler{
		surfaces:     make(map[uint16]*surface),
		cacheEntries: make(map[uint16]cacheEntry),
		clearCtx:     newClearCodecCtx(),
		zgfx:         newZgfxContext(),
		rfx:          newRfxDecoder(),
		progressive:  newRfxProgressiveDecoder(),
		// h264dec2 starts nil; primeAuxDecoder creates it on the first stream2 IDR
		// so it is always primed before decoding LC=2 P-frames.
		onBitmap:   onBitmap,
		decodeCh:   make(chan decodePkt, 1024),
		ackCh:      make(chan []byte, 512),
		doneCh:     make(chan struct{}),
		watchdogCh: make(chan struct{}, 4),
	}
	g.h264dec = newH264DecoderWithWatchdog(g.watchdogCh)
	go g.decodeLoop()
	go g.writeLoop()
	return g
}

// inputStallSilentThreshold is the minimum time without a decoded frame before
// the local-input watchdog considers the HW decoder potentially stalled.
// Kept in the non-build-tagged file so both normal and !h264 builds compile.
// Must be kept in sync with avcHWReadyFreezeThreshold in h264_ffmpeg.go.
const inputStallSilentThreshold = 7 * time.Second

const localInputRecoveryGrace = 750 * time.Millisecond

// auxDecoderBrokenTimeout is the maximum time we wait for an LC=0 stream2 IDR
// to arrive and recreate the aux decoder (h264dec2) after it has been torn down.
// If LC=2 frames keep arriving beyond this window without an LC=0 IDR, the RDPGFX
// capabilities are re-advertised to force the server to issue RESET_GRAPHICS and
// restart the video pipeline with a fresh LC=0 IDR for both streams.
const auxDecoderBrokenTimeout = 10 * time.Second

// auxDecoderMaxIDRRetries is the maximum number of ForceRefresh keyframe
// requests sent while waiting for a stream2 IDR before giving up and
// reconnecting.  Each attempt is spaced by auxDecoderBrokenTimeout (10 s).
// Windows servers typically begin a new GOP every 30–60 s, so 5 attempts
// (≤50 s) provides enough coverage for at least one natural IDR boundary.
const auxDecoderMaxIDRRetries = 5

// Close shuts down the GfxHandler's background goroutines.
// Safe to call multiple times; subsequent calls are no-ops.
//
// h264dec is intentionally NOT freed here: decodeLoop (goroutine 21) may be
// in the middle of avcodec_send_packet when Close is called from the transport
// goroutine, which would cause a use-after-free SIGSEGV.  Instead, decodeLoop
// defers cleanup of h264dec so it always runs after the last Decode call.
func (g *GfxHandler) Close() {
	g.closeOnce.Do(func() {
		g.stopInputWatchdog()
		g.stopAuxDecoderBrokenTimer()
		close(g.doneCh)
	})
}

// NotifyLocalInput tells the graphics pipeline that a real local input event
// was just sent to the server. If the decoder has already been silent longer
// than the HW stall threshold, arm a short watchdog so recovery no longer
// depends on the next H.264 packet arriving.
func (g *GfxHandler) NotifyLocalInput() {
	if g.h264dec == nil {
		return
	}
	// Don't arm the watchdog when the decoder is waiting for an IDR after a
	// reset: it is already in a known recovery state, and arming the watchdog
	// here would force-break the newly reset decoder 750 ms later when the IDR
	// hasn't arrived yet, causing rapid cascading soft resets.
	if g.h264dec.NeedsIDR() {
		return
	}
	lastDecodedNS := g.lastDecodedFrame.Load()
	if lastDecodedNS == 0 {
		return
	}
	now := time.Now()
	silentFor := now.Sub(time.Unix(0, lastDecodedNS))
	if silentFor < inputStallSilentThreshold {
		return
	}
	// Only arm the watchdog if the server has been actively sending video
	// packets recently.  A genuinely static screen (server sends nothing) is
	// not a decoder stall and should not trigger a force-break.
	if recvTime := g.h264dec.LastReceiveTime(); recvTime.IsZero() ||
		time.Since(recvTime) >= inputStallSilentThreshold {
		return
	}

	inputNS := now.UnixNano()
	g.inputWatchdogMu.Lock()
	g.inputWatchdogNS = inputNS
	if g.inputWatchdog == nil {
		g.inputWatchdog = time.AfterFunc(localInputRecoveryGrace, func() {
			g.fireInputWatchdog(inputNS)
		})
	} else {
		g.inputWatchdog.Reset(localInputRecoveryGrace)
	}
	g.inputWatchdogMu.Unlock()

	slog.Debug("H.264: local input armed stall watchdog",
		"silentFor", silentFor.Round(time.Millisecond))
}

func (g *GfxHandler) fireInputWatchdog(inputNS int64) {
	g.inputWatchdogMu.Lock()
	if g.inputWatchdogNS != inputNS {
		g.inputWatchdogMu.Unlock()
		return
	}
	g.inputWatchdog = nil
	g.inputWatchdogMu.Unlock()

	select {
	case g.watchdogCh <- struct{}{}:
	default:
	}
}

func (g *GfxHandler) stopInputWatchdog() {
	g.inputWatchdogMu.Lock()
	if g.inputWatchdog != nil {
		g.inputWatchdog.Stop()
		g.inputWatchdog = nil
	}
	g.inputWatchdogNS = 0
	g.inputWatchdogMu.Unlock()
}

// startAuxDecoderBrokenTimer arms a one-shot timer.  If it fires before
// stopAuxDecoderBrokenTimer cancels it, it signals watchdogCh so that
// decodeLoop calls maybeRenegotiateCapabilities.
// Idempotent: only the first call while h264dec2 is nil takes effect.
func (g *GfxHandler) startAuxDecoderBrokenTimer() {
	g.auxDecoderBrokenTimerMu.Lock()
	defer g.auxDecoderBrokenTimerMu.Unlock()
	if g.auxDecoderBrokenTimer == nil {
		g.auxDecoderBrokenTimer = time.AfterFunc(auxDecoderBrokenTimeout, func() {
			// Clear the pointer so startAuxDecoderBrokenTimer can re-arm
			// the timer for subsequent retry attempts (e.g. after a
			// ForceRefresh in case 2 of maybeRenegotiateCapabilities).
			g.auxDecoderBrokenTimerMu.Lock()
			g.auxDecoderBrokenTimer = nil
			g.auxDecoderBrokenTimerMu.Unlock()
			select {
			case g.watchdogCh <- struct{}{}:
			default:
			}
		})
	}
}

func (g *GfxHandler) stopAuxDecoderBrokenTimer() {
	g.auxDecoderBrokenTimerMu.Lock()
	if g.auxDecoderBrokenTimer != nil {
		g.auxDecoderBrokenTimer.Stop()
		g.auxDecoderBrokenTimer = nil
	}
	g.auxDecoderBrokenTimerMu.Unlock()
}

// maybeRenegotiateCapabilities is called from decodeLoop when watchdogCh fires.
// If h264dec2 has been nil since the timer was armed AND the server has been
// actively sending LC=2 frames, we either reconnect (if LC=2 was previously
// working) or degrade gracefully to LC=0 only (if LC=2 never worked this session).
// Reconnecting mid-session when LC=2 never worked would just produce another
// identical cycle, since the server appears to not include stream2 in LC=0 IDRs.
func (g *GfxHandler) maybeRenegotiateCapabilities() {
	if g.h264dec2 != nil {
		return // aux decoder recovered while timer was in flight
	}
	if g.decoderBrokenNotified {
		return // reconnect already in flight
	}
	if g.lc2PermanentlyDegraded {
		return // already degraded to LC=0 only; buffered watchdog signals must not re-enter
	}
	// Only act when the server has recently been sending LC=2 frames —
	// a genuinely idle server needs no intervention.
	lastLC2NS := g.lastLC2RecvTime.Load()
	if lastLC2NS == 0 || time.Since(time.Unix(0, lastLC2NS)) >= auxDecoderBrokenTimeout {
		// No recent LC=2 activity (server idle, or HW-decoder GOP-boundary
		// stall).  Reset the retry counter so that when LC=2 resumes the
		// next burst gets fresh ForceRefresh attempts rather than inheriting
		// a stale count from a previous burst.
		g.auxDecoderNoIDRRetries = 0
		return
	}
	if !g.stream2EverSeen {
		// stream2 has never appeared in any LC=0 packet this session.  The server
		// (e.g. VirtualBox VRDE) does not include stream2 in LC=0 IDRs and does
		// not send standalone LC=2 IDR frames, so the aux decoder can never be
		// primed.  Reconnecting would reproduce the same failure.  Degrade
		// gracefully: LC=2 is silently skipped for the remainder of this session.
		slog.Warn("H.264: server never sent stream2 in LC=0, LC=2 degraded to LC=0 only (no reconnect)")
		g.lc2PermanentlyDegraded = true
		return
	}
	if !g.lc2EverDecoded {
		// stream2 has been seen in LC=0 packets (server supports LC=2), but
		// the aux decoder has not yet produced a combined frame.  The server
		// may be sending only P-frame stream2 data in LC=0 packets — no IDR
		// means primeAuxDecoder can never initialise h264dec2.
		//
		// Send a ForceRefresh keyframe request on each attempt so the server
		// hopefully includes a stream2 IDR in the next LC=0 IDR packet.
		// Windows servers typically begin a new GOP every 30–60 s; with
		// auxDecoderMaxIDRRetries=5 (×10 s = 50 s) we cover at least one
		// natural boundary before falling back to a reconnect.
		//
		// The retry counter is reset when the early-return above fires (no
		// recent LC=2 activity, e.g. HW-decoder stall), so resumed bursts
		// always start from attempt 1.
		g.auxDecoderNoIDRRetries++
		if g.auxDecoderNoIDRRetries <= auxDecoderMaxIDRRetries {
			slog.Debug("H.264: aux decoder not primed — requesting keyframe to get stream2 IDR",
				"attempt", g.auxDecoderNoIDRRetries, "maxRetries", auxDecoderMaxIDRRetries)
			g.lastKeyframeRequest = time.Time{} // allow immediate send
			g.maybeRequestKeyframe()
			return
		}
		// The server has not delivered a stream2 IDR despite repeated ForceRefresh
		// requests and LC=2 has never decoded successfully this session.  Reconnecting
		// reproduces the same failure because the server consistently omits stream2
		// IDRs in LC=0 IDR packets.  Degrade gracefully to LC=0-only instead.
		slog.Warn("H.264: aux decoder never primed despite keyframe request — degrading to LC=0 only (no reconnect)",
			"retries", g.auxDecoderNoIDRRetries)
		g.lc2PermanentlyDegraded = true
		return
	}
	// The timer firing is itself the auxDecoderBrokenTimeout signal.  Do not
	// gate on lastDecodedFrame: the main decoder (h264dec) may still be active
	// and continuously updating lastDecodedFrame even while the aux decoder
	// (h264dec2) is broken, which would prevent this function from ever
	// triggering a reconnect and permanently lose LC=2 chroma enhancement.
	slog.Debug("H.264: aux decoder absent, server sending LC=2 — triggering reconnect")
	g.decoderBrokenNotified = true
	if g.onDecoderBroken != nil {
		go g.onDecoderBroken()
	}
}

func (g *GfxHandler) noteSuccessfulDecode() {
	g.lastDecodedFrame.Store(time.Now().UnixNano())
	g.noIDRSoftResetCount = 0
	// A single clean decode resets the *consecutive* drop counter, but does NOT
	// disarm swFallbackPrimed.  After a HW stall the SW decoder is primed with a
	// stale cached IDR; the corruption it causes only manifests as the following
	// P-frames diverge from the (missing) reference, so the very first frame can
	// decode cleanly and then the picture rots into green/zero-chroma output.
	// Clearing swFallbackPrimed here would permanently disable
	// trackSWFallbackDroppedFrame's escalation and let that corruption persist.
	// swFallbackPrimed is instead cleared only on a genuine fresh IDR resync
	// (maybeCacheStream1IDR) or on RESET_GRAPHICS.
	g.swFallbackDroppedCount = 0
	g.swFallbackFirstDropTime = time.Time{}
	g.stopInputWatchdog()
}

func (g *GfxHandler) maybeTriggerInputStall() {
	g.inputWatchdogMu.Lock()
	inputNS := g.inputWatchdogNS
	g.inputWatchdogNS = 0
	g.inputWatchdog = nil
	g.inputWatchdogMu.Unlock()

	if inputNS == 0 || g.h264dec == nil || g.h264dec.IsBroken() {
		return
	}
	// Don't force-break a decoder that is already in IDR-wait state (e.g.
	// after a soft reset).  It is in a known recovery path; breaking it again
	// would restart the soft-reset cycle unnecessarily.
	if g.h264dec.NeedsIDR() {
		return
	}
	// Don't force-break when the server has been idle (no video packets
	// arriving).  A static screen produces no frames but the decoder is
	// healthy; only break when packets are flowing but output is absent.
	if recvTime := g.h264dec.LastReceiveTime(); recvTime.IsZero() ||
		time.Since(recvTime) >= inputStallSilentThreshold {
		return
	}
	lastDecodedNS := g.lastDecodedFrame.Load()
	if lastDecodedNS == 0 || lastDecodedNS >= inputNS {
		return
	}
	silentFor := time.Since(time.Unix(0, lastDecodedNS))
	if silentFor < inputStallSilentThreshold {
		return
	}
	g.h264dec.ForceBroken(H264BrokenReasonHWStall)
	slog.Debug("H.264: local input produced no new frame, marking decoder broken",
		"silentFor", silentFor.Round(time.Millisecond),
		"inputAgo", time.Since(time.Unix(0, inputNS)).Round(time.Millisecond))
}

// SetSendFunc sets the function used to send RDPGFX responses via DVC.
func (g *GfxHandler) SetSendFunc(fn func([]byte)) {
	g.sendFn = fn
}

// SetDecoderBrokenCallback registers a function that is called once when the
// H.264 decoder becomes permanently unrecoverable (all soft resets exhausted).
// The callback should reconnect the RDP session so a fresh decoder can be
// created from scratch.
func (g *GfxHandler) SetDecoderBrokenCallback(fn func()) {
	g.onDecoderBroken = fn
}

// SetKeyframeRequestFunc registers a function that is called after each
// soft decoder reset to ask the server for a fresh IDR keyframe.  This
// speeds up recovery: without it the decoder waits for the server to
// spontaneously send a keyframe.  A typical implementation calls
// pdu.SendRefreshRect with the current screen dimensions.
func (g *GfxHandler) SetKeyframeRequestFunc(fn func()) {
	g.onKeyframeRequest = fn
}

// SetH264RawCallback registers a function that receives raw H.264 NAL unit
// data when the built-in decoder is unavailable (h264dec == nil).  This
// allows the caller to hand off decoding to an external engine such as the
// browser WebCodecs VideoDecoder API.
//
// destX and destY are the top-left canvas coordinates of the decoded frame.
// isKey is true when the NAL data starts a new GOP (IDR frame).
func (g *GfxHandler) SetH264RawCallback(fn func(destX, destY, w, h int, isKey bool, data []byte)) {
	g.onH264Raw = fn
}

// SetI420Callback registers a callback that receives I420 planar data when an
// H.264 frame is decoded and the underlying decoder supports I420 extraction.
// When set, H264 frames are NOT emitted via the normal OnBitmap path; the
// caller is responsible for rendering the I420 data directly (e.g. via an
// SDL2 IYUV texture).  When the I420 fast path is used, the BGRA surface
// backing store is not updated for that frame.
// Set fn to nil to disable and revert to normal OnBitmap delivery.
func (g *GfxHandler) SetI420Callback(fn func(destX, destY, w, h int, y []byte, yStride int, u []byte, uStride int, v []byte, vStride int)) {
	g.onI420 = fn
}

// SetNV12Callback registers a callback that receives native NV12 planar data
// when H.264 decoding produces NV12.  When set for AVC420 frames, the normal
// OnBitmap path is bypassed for frames that can be delivered as NV12; callers
// should upload the Y and UV planes directly (for example with SDL2
// SDL_UpdateNVTexture).  Set fn to nil to disable.
func (g *GfxHandler) SetNV12Callback(fn func(destX, destY, w, h int, y []byte, yStride int, uv []byte, uvStride int)) {
	g.onNV12 = fn
}

// SetAVC444Disabled controls whether AVC444/AVC444v2 is advertised to the
// server.  When disabled, CAPS_ADVERTISE only includes v8.0 and v8.1, so the
// server will encode frames using AVC420 (4:2:0) only and never send LC=2
// chroma-upgrade data.  This avoids the colour degradation caused by servers
// (e.g. VirtualBox VRDE) that send LC=2 frames without including stream2 in
// LC=0 IDR packets.  Must be called before the channel is opened.
func (g *GfxHandler) SetAVC444Disabled(v bool) {
	g.avc444Disabled = v
}

// OnChannelCreated is called after the DVC CREATE_RSP has been sent.
// It sends CAPS_ADVERTISE to the server to initiate the RDPGFX pipeline.
func (g *GfxHandler) OnChannelCreated() {
	g.sendCapsAdvertise()
}

// sendCapsAdvertise sends RDPGFX_CAPS_ADVERTISE_PDU to the server.
// The client must advertise its capabilities before the server will
// send any graphics data (MS-RDPEGFX 2.2.3.1).
func (g *GfxHandler) sendCapsAdvertise() {
	p := pduBufPool.Get().([]byte)[:0]
	defer pduBufPool.Put(p[:0])

	// AVC capsets are advertised when we can deliver decoded frames either
	// in-process (h264dec) or by handing the raw NALs off to the embedder
	// (onH264Raw, used by the WASM build to forward to WebCodecs). Without
	// either, the v8.0+AVCDisabled fallback below forces the server to
	// reject RDPGFX and use legacy bitmap PDUs.
	if g.h264dec != nil || g.onH264Raw != nil {
		if g.avc444Disabled {
			// AVC444 disabled: advertise only v8.0 and v8.1 so the server
			// uses AVC420 (4:2:0) exclusively and never sends LC=2 data.
			p = binary.LittleEndian.AppendUint16(p, 2) // capsSetCount

			// v8.0 — baseline fallback (no AVC)
			p = binary.LittleEndian.AppendUint32(p, capVersion8)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagThinClient)

			// v8.1 — AVC420 via explicit flag
			p = binary.LittleEndian.AppendUint32(p, capVersion81)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache|capFlagAVC420Enabled)

			g.sendPdu(cmdidCapsAdvertise, p)
			slog.Debug("RDPGFX: sent CAPS_ADVERTISE (v8.1..v8.0, AVC444 disabled)")
		} else {
			// Advertise capsets in ascending order (v8.0 → v10.7), matching
			// rdpyqt / FreeRDP layout so servers pick the highest common version.
			p = binary.LittleEndian.AppendUint16(p, 11) // capsSetCount

			// v8.0 — baseline fallback (no AVC)
			p = binary.LittleEndian.AppendUint32(p, capVersion8)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagThinClient)

			// v8.1 — AVC420 via explicit flag
			p = binary.LittleEndian.AppendUint32(p, capVersion81)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache|capFlagAVC420Enabled)

			// v10.0
			p = binary.LittleEndian.AppendUint32(p, capVersion10)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.1 — 16-byte capsData (12 zero bytes after flags)
			p = binary.LittleEndian.AppendUint32(p, capVersion101)
			p = binary.LittleEndian.AppendUint32(p, 16)
			p = binary.LittleEndian.AppendUint32(p, 0)
			p = binary.LittleEndian.AppendUint32(p, 0)
			p = binary.LittleEndian.AppendUint32(p, 0)
			p = binary.LittleEndian.AppendUint32(p, 0)

			// v10.2
			p = binary.LittleEndian.AppendUint32(p, capVersion102)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.3
			p = binary.LittleEndian.AppendUint32(p, capVersion103)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, 0)

			// v10.4
			p = binary.LittleEndian.AppendUint32(p, capVersion104)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.5
			p = binary.LittleEndian.AppendUint32(p, capVersion105)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.6
			p = binary.LittleEndian.AppendUint32(p, capVersion106)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.6.1
			p = binary.LittleEndian.AppendUint32(p, capVersion1061)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			// v10.7
			p = binary.LittleEndian.AppendUint32(p, capVersion107)
			p = binary.LittleEndian.AppendUint32(p, 4)
			p = binary.LittleEndian.AppendUint32(p, capFlagSmallCache)

			g.sendPdu(cmdidCapsAdvertise, p)
			slog.Debug("RDPGFX: sent CAPS_ADVERTISE (v10.7..v8.0, AVC enabled)")
		}
	} else {
		p = binary.LittleEndian.AppendUint16(p, 1) // capsSetCount
		p = binary.LittleEndian.AppendUint32(p, capVersion8)
		p = binary.LittleEndian.AppendUint32(p, 4) // capsDataLength
		// Use flags that intentionally cause servers to reject the RDPGFX
		// channel, forcing fallback to surface bitmap commands (NSCodec /
		// RemoteFX). We do not yet support ClearCodec (0x0008) or Planar
		// (0x0009) which servers send over RDPGFX when it stays open.
		p = binary.LittleEndian.AppendUint32(p, capFlagThinClient|capFlagSmallCache|capFlagAVCDisabled)
		g.sendPdu(cmdidCapsAdvertise, p)
		slog.Debug("RDPGFX: sent CAPS_ADVERTISE (v8.0)")
	}
}

// ZGFX segment descriptors (MS-RDPEGFX 2.2.4)
const (
	zgfxSingle    = 0xE0
	zgfxMultipart = 0xE1

	zgfxCompressedRDP8 = 0x04
)

// Process handles a complete RDPGFX payload (may contain multiple PDUs).
// Data arrives wrapped in ZGFX (RDP8 Bulk Compression) segments (MS-RDPEGFX 2.2.4).
//
// Called on the network read goroutine.  Decompression happens here;
// the decompressed payload is then queued for asynchronous processing
// (including frame ACKs and decode) on the decode goroutine.
// This keeps the read goroutine free from any socket.Write calls that
// could cause TCP deadlock when both sides try to write simultaneously.
func (g *GfxHandler) Process(data []byte) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("RDPGFX: panic in Process", "err", r)
		}
	}()
	if len(data) < 1 {
		return
	}

	var decompressed []byte
	var decompPooled bool

	descriptor := data[0]
	switch descriptor {
	case zgfxSingle:
		if len(data) < 2 {
			return
		}
		decompressed, decompPooled = g.decompressSegment(data[1:])
	case zgfxMultipart:
		decompressed, decompPooled = g.decompressMultipart(data[1:])
	default:
		slog.Warn("RDPGFX: unknown ZGFX descriptor", "descriptor", descriptor)
		decompressed = data
	}

	if len(decompressed) == 0 {
		return
	}

	// decompressSegment / decompressMultipart already return owned
	// buffers (freshly allocated or copied from input) so we can hand
	// the slice directly to the async decode goroutine.
	pkt := decodePkt{data: decompressed, pooled: decompPooled}
	select {
	case g.decodeCh <- pkt:
	default:
		// Channel full — video decode is dropped, but we must still
		// ACK any EndFrame PDUs so the server's outstanding-frame
		// count stays accurate and it keeps sending.
		slog.Warn("RDPGFX: decodeCh full, dropping frame (ACKs preserved)", "queueCap", cap(g.decodeCh))
		g.ackDroppedFrames(pkt)
	}
}

// ackDroppedFrames scans decompressed PDU data for EndFrame commands
// and sends ACKs for them.  Called on the read goroutine when decodeCh
// is full and the message is being dropped.  Without this, dropped
// EndFrames would leave the server's outstanding-frame count stuck,
// eventually causing it to stop sending entirely.
//
// queueDepth is set to suspendFrameAcknowledge (0xFFFFFFFF) so the
// server suspends sending new frames.  As the decodeLoop drains the
// existing queue and sends ACKs with lower queueDepth values, the server
// will automatically resume (MS-RDPEGFX 2.2.2.8).
func (g *GfxHandler) ackDroppedFrames(pkt decodePkt) {
	data := pkt.data
	defer func() {
		if pkt.pooled {
			releaseBitmapBuf(data)
		}
	}()
	for offset := 0; offset+headerSize <= len(data); {
		cmdId := binary.LittleEndian.Uint16(data[offset:])
		pduLength := binary.LittleEndian.Uint32(data[offset+4:])
		if pduLength < uint32(headerSize) || int(pduLength) > len(data)-offset {
			break
		}
		if cmdId == cmdidEndFrame {
			pduData := data[offset+headerSize : offset+int(pduLength)]
			if len(pduData) >= 4 {
				g.sendFrameAck(binary.LittleEndian.Uint32(pduData), suspendFrameAcknowledge)
			}
		}
		offset += int(pduLength)
	}
}

// decompressSegment handles a single ZGFX segment (after the descriptor byte).
// First byte is RDP8_BULK_ENCODED_DATA header:
//
//	bits 0-3: compression type (0x04 = RDP8)
//	bit 5: PACKET_COMPRESSED (0x20)
//
// Always returns pooled=true: the returned slice was acquired from
// bitmapBufPool (directly or via Decompress) and must be released with
// releaseBitmapBuf once the caller is done with it.
func (g *GfxHandler) decompressSegment(seg []byte) ([]byte, bool) {
	if len(seg) < 1 {
		return nil, false
	}
	header := seg[0]
	payload := seg[1:]
	if header&0x20 != 0 {
		// Acquire a pool buffer as the initial backing for Decompress output.
		// Decompress may grow beyond it; the returned slice (not buf) must be
		// released by the caller.  Any over-small buf that gets replaced is
		// abandoned to GC — the pool converges to the right size over time.
		buf := acquireBitmapBuf(len(payload) * 3)
		return g.zgfx.Decompress(payload, buf), true
	}
	g.zgfx.historyWrite(payload)
	// Return a pooled copy: payload aliases the caller's network buffer, which
	// will be reused on the next read. Callers hand the slice off to the async
	// decode goroutine and must own the memory.
	buf := acquireBitmapBuf(len(payload))
	copy(buf, payload)
	return buf, true
}

// decompressMultipart handles ZGFX multipart segments and returns the
// concatenated decompressed data (without processing PDUs).
// Returns a slice acquired from bitmapBufPool; caller must release it.
func (g *GfxHandler) decompressMultipart(data []byte) ([]byte, bool) {
	if len(data) < 6 {
		return nil, false
	}
	// Direct slice indexing — avoids bytes.NewReader and per-field io.ReadFull.
	segCount := binary.LittleEndian.Uint16(data[0:])
	uncompSize := binary.LittleEndian.Uint32(data[2:])
	offset := 6

	// Pre-allocate to the advertised uncompressed size to avoid repeated
	// buffer growths as each segment is appended.
	buf := acquireBitmapBuf(int(uncompSize))
	result := buf[:0]
	for range segCount {
		if offset+4 > len(data) {
			break
		}
		segSize := int(binary.LittleEndian.Uint32(data[offset:]))
		offset += 4
		if offset+segSize > len(data) {
			break
		}
		segData := data[offset : offset+segSize]
		offset += segSize
		raw, rawPooled := g.decompressSegment(segData)
		if raw != nil {
			result = append(result, raw...)
			if rawPooled {
				releaseBitmapBuf(raw)
			}
		}
	}
	if len(result) == 0 {
		releaseBitmapBuf(buf)
		return nil, false
	}
	// If result grew beyond buf, buf was abandoned; result is the new owner.
	return result, true
}

// decodeLoop runs in a dedicated goroutine, reading decompressed PDU data
// from decodeCh and dispatching all processing — including frame ACKs and
// heavy decode work.  Keeping socket.Write calls off the read goroutine
// avoids TCP deadlock (where both sides try to write while neither reads).
// It automatically restarts on panic, unless Close() has been called.
//
// decodeLoop owns the h264dec lifecycle: it is the sole caller of Decode()
// and it frees h264dec on final exit (when doneCh is closed) to avoid a
// use-after-free race with Close() freeing the AVCodecContext from a
// different goroutine while Decode() holds it.
func (g *GfxHandler) decodeLoop() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("RDPGFX: panic in decodeLoop, restarting", "err", r)
			select {
			case <-g.doneCh:
				// Shutting down — free h264dec resources on this final exit.
				if g.h264dec != nil {
					g.h264dec.Close()
					g.h264dec = nil
				}
				if g.h264dec2 != nil {
					g.h264dec2.Close()
					g.h264dec2 = nil
				}
			default:
				go g.decodeLoop()
			}
			return
		}
		// Normal exit triggered by doneCh being closed.
		if g.h264dec != nil {
			g.h264dec.Close()
			g.h264dec = nil
		}
		if g.h264dec2 != nil {
			g.h264dec2.Close()
			g.h264dec2 = nil
		}
	}()
	slog.Debug("RDPGFX: decodeLoop started")
	for {
		select {
		case <-g.doneCh:
			return
		case pkt := <-g.decodeCh:
			g.decodePDUs(pkt.data)
			if pkt.pooled {
				releaseBitmapBuf(pkt.data)
			}
		case <-g.watchdogCh:
			// A background timer in ffmpegDecoder fired because the stall-probe
			// or IDR-wait timeout expired while the server was sending no frames
			// (static screen → near-0 fps), or because local input produced no
			// new frame while the decoder had already been silent too long.
			slog.Debug("H.264: watchdog triggered, checking decoder state")
			g.maybeTriggerInputStall()
			g.maybeRenegotiateCapabilities()
			g.maybeNotifyDecoderBroken()
		}
	}
}

// skipHeavyThreshold controls when CaVideo/progressive decode is skipped.
// When the queue has more items than this, heavy decode is skipped to drain
// the backlog quickly.  A small threshold means we decode almost every frame
// during normal playback, only skipping under severe backpressure.
const skipHeavyThreshold = 16

// decodePDUs processes all PDUs in decompressed data.
// Frame ACKs (EndFrame) are ALWAYS processed so the server gets timely
// acknowledgements.  Heavy CaVideo/progressive decode is skipped when
// the queue is significantly backed up.
func (g *GfxHandler) decodePDUs(data []byte) {
	skipHeavy := len(g.decodeCh) > skipHeavyThreshold

	for offset := 0; offset+headerSize <= len(data); {
		cmdId := binary.LittleEndian.Uint16(data[offset:])
		pduLength := binary.LittleEndian.Uint32(data[offset+4:])
		if pduLength < uint32(headerSize) || int(pduLength) > len(data)-offset {
			break
		}
		pduData := data[offset+headerSize : offset+int(pduLength)]
		g.dispatchDecode(cmdId, pduData, skipHeavy)
		offset += int(pduLength)
	}
}

// dispatchDecode routes a single PDU.  When skipHeavy is true, CaVideo
// and progressive decode are skipped to drain the queue quickly.
// EndFrame (frame ACK) is always processed regardless of skipHeavy.
func (g *GfxHandler) dispatchDecode(cmdId uint16, data []byte, skipHeavy bool) {
	switch cmdId {
	case cmdidCapsConfirm:
		g.onCapsConfirm(data)
	case cmdidResetGraphics:
		g.onResetGraphics(data)
	case cmdidCreateSurface:
		g.onCreateSurface(data)
	case cmdidDeleteSurface:
		g.onDeleteSurface(data)
	case cmdidMapSurfaceToOutput:
		g.onMapSurfaceToOutput(data)
	case cmdidStartFrame:
		// nothing to do
	case cmdidSurfaceToSurface:
		g.onSurfaceToSurface(data)
	case cmdidEndFrame:
		g.onEndFrame(data) // always ACK, even when skipHeavy
	case cmdidWireToSurface1:
		g.onWireToSurface1Decode(data, skipHeavy)
	case cmdidWireToSurface2:
		g.onWireToSurface2Decode(data, skipHeavy)
	case cmdidSolidFill:
		g.onSolidFill(data)
	case cmdidCacheToSurface:
		g.onCacheToSurface(data)
	case cmdidEvictCacheEntry:
		g.onEvictCacheEntry(data)
	case cmdidCacheImportOffer:
		g.onCacheImportOffer()
	case cmdidMapSurfaceToWindow, cmdidMapSurfaceToScaledWindow:
		// ignored — we don't support per-window mapping
	case cmdidMapSurfaceToScaledOutput, cmdidMapSurfaceToScaledOutputV2:
		g.onMapSurfaceToScaledOutput(data)
	default:
		slog.Debug("RDPGFX: unhandled cmd", "cmdId", cmdId)
	}
}

// writeLoop runs in a dedicated goroutine.  It reads serialized ACK
// PDUs from ackCh and sends each one via sendFn.  Every ACK must reach
// the server — the server tracks outstanding frames individually and
// stops sending if ACKs are missing.  Automatically restarts on panic,
// unless Close() has been called.
func (g *GfxHandler) writeLoop() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("RDPGFX: panic in writeLoop, restarting", "err", r)
			select {
			case <-g.doneCh:
				// Shut down; do not restart.
			default:
				go g.writeLoop()
			}
		}
	}()
	for {
		select {
		case <-g.doneCh:
			return
		case pdu := <-g.ackCh:
			if g.sendFn != nil {
				g.sendFn(pdu)
			}
			ackPDUPool.Put(pdu)
		}
	}
}

// sendPdu sends a PDU synchronously.  Used for rare control messages
// (CapsAdvertise, CacheImportReply) that must not be dropped.
// pduBufPool reuses scratch byte slices for assembling outbound PDU frames,
// avoiding per-call heap allocations on the sendPdu hot path.
var pduBufPool = sync.Pool{
	New: func() any { return make([]byte, 0, headerSize+256) },
}

// ackPDUPool reuses the fixed-size 20-byte slices used for FRAME_ACKNOWLEDGE
// PDUs (~60/s during video), eliminating per-frame heap allocations.
var ackPDUPool = sync.Pool{
	New: func() any { return make([]byte, 20) },
}

func (g *GfxHandler) sendPdu(cmdId uint16, payload []byte) {
	if g.sendFn == nil {
		return
	}
	buf := pduBufPool.Get().([]byte)
	buf = buf[:0]
	buf = binary.LittleEndian.AppendUint16(buf, cmdId)
	buf = binary.LittleEndian.AppendUint16(buf, 0) // flags
	buf = binary.LittleEndian.AppendUint32(buf, uint32(headerSize+len(payload)))
	buf = append(buf, payload...)
	g.sendFn(buf)
	pduBufPool.Put(buf[:0])
}

// --- Command Handlers ---

func (g *GfxHandler) onCapsConfirm(data []byte) {
	if len(data) < 12 {
		slog.Debug("RDPGFX: CAPS_CONFIRM received (short)")
		return
	}
	version := binary.LittleEndian.Uint32(data[0:])
	dataLen := binary.LittleEndian.Uint32(data[4:])
	flags := uint32(0)
	if dataLen >= 4 {
		flags = binary.LittleEndian.Uint32(data[8:])
	}
	slog.Debug("RDPGFX: CAPS_CONFIRM", "version", version, "flags", flags)
}

func (g *GfxHandler) onResetGraphics(data []byte) {
	if len(data) < 12 {
		return
	}
	w := binary.LittleEndian.Uint32(data[0:])
	h := binary.LittleEndian.Uint32(data[4:])
	slog.Debug("RDPGFX: RESET_GRAPHICS", "w", w, "h", h)
	g.surfaces = make(map[uint16]*surface)
	g.clearCtx = newClearCodecCtx()
	g.framesDecoded.Store(0)
	g.softResetCount = 0
	g.noIDRSoftResetCount = 0
	g.decoderBrokenNotified = false
	g.lc2EverDecoded = false
	g.stream2EverSeen = false
	g.auxDecoderNoIDRRetries = 0
	g.lc2PermanentlyDegraded = false
	g.lastKeyframeRequest = time.Time{}
	g.lastStream1IDR = g.lastStream1IDR[:0]
	g.lastStream1IDRTime = time.Time{}
	g.lastStream1IDRFrame = 0
	g.swFallbackPrimed = false
	g.swFallbackDroppedCount = 0
	g.swFallbackFirstDropTime = time.Time{}
	g.lastDecodedFrame.Store(0)
	g.stopInputWatchdog()
	if g.h264dec != nil {
		g.h264dec.Close()
		g.h264dec = newH264DecoderWithWatchdog(g.watchdogCh)
	}
	if g.h264dec2 != nil {
		g.h264dec2.Close()
		// Keep h264dec2 nil; primeAuxDecoder will recreate it on the next stream2 IDR
		// so the fresh decoder is always primed before receiving LC=2 P-frames.
		g.h264dec2 = nil
	}
	g.avc444YPlane = avc444YPlane{}
	g.avc444IDRYPlane = avc444YPlane{}
	g.progressive.Reset()
}

func (g *GfxHandler) onCreateSurface(data []byte) {
	if len(data) < 7 {
		return
	}
	id := binary.LittleEndian.Uint16(data[0:])
	w := binary.LittleEndian.Uint16(data[2:])
	h := binary.LittleEndian.Uint16(data[4:])
	f := data[6]
	slog.Debug("RDPGFX: CREATE_SURFACE", "id", id, "w", w, "h", h)
	g.surfaces[id] = &surface{
		width: w, height: h, format: f,
		data:        make([]byte, int(w)*int(h)*4),
		shadowStale: true,
	}
}

func (g *GfxHandler) onDeleteSurface(data []byte) {
	if len(data) < 2 {
		return
	}
	id := binary.LittleEndian.Uint16(data)
	delete(g.surfaces, id)
}

func (g *GfxHandler) onMapSurfaceToOutput(data []byte) {
	if len(data) < 12 {
		return
	}
	id := binary.LittleEndian.Uint16(data[0:])
	// data[2:4] = reserved
	ox := binary.LittleEndian.Uint32(data[4:])
	oy := binary.LittleEndian.Uint32(data[8:])
	slog.Debug("RDPGFX: MAP_SURFACE", "id", id, "ox", ox, "oy", oy)
	if s, ok := g.surfaces[id]; ok {
		s.outputX = ox
		s.outputY = oy
		s.mapped = true
	}
}

func (g *GfxHandler) onMapSurfaceToScaledOutput(data []byte) {
	if len(data) < 20 {
		return
	}
	id := binary.LittleEndian.Uint16(data[0:])
	// data[2:4] = reserved
	ox := binary.LittleEndian.Uint32(data[4:])
	oy := binary.LittleEndian.Uint32(data[8:])
	// data[12:16] = targetWidth, data[16:20] = targetHeight (unused)
	slog.Debug("RDPGFX: MAP_SURFACE_SCALED", "id", id, "ox", ox, "oy", oy)
	if s, ok := g.surfaces[id]; ok {
		s.outputX = ox
		s.outputY = oy
		s.mapped = true
	}
}

// sendFrameAck builds and queues a FRAME_ACKNOWLEDGE PDU.
// Safe to call from any goroutine (uses atomic framesDecoded).
// The PDU is serialized directly into a 20-byte slice to avoid
// the two bytes.Buffer allocations the previous implementation required.
//
// queueDepth is reported to the server so it can adjust encoding quality
// and frame rate based on the client's decode backlog.  Pass
// suspendFrameAcknowledge (0xFFFFFFFF) to ask the server to suspend new
// frames until a subsequent ACK with a lower value is received.
func (g *GfxHandler) sendFrameAck(frameId uint32, queueDepth uint32) {
	decoded := g.framesDecoded.Add(1)
	// 8-byte RDPGFX header + 12-byte FRAME_ACKNOWLEDGE payload = 20 bytes.
	pdu := ackPDUPool.Get().([]byte)
	binary.LittleEndian.PutUint16(pdu[0:], cmdidFrameAcknowledge)
	// pdu[2:4] = flags (0) — zero value
	binary.LittleEndian.PutUint16(pdu[2:], 0)
	binary.LittleEndian.PutUint32(pdu[4:], 20) // total PDU length
	binary.LittleEndian.PutUint32(pdu[8:], queueDepth)
	binary.LittleEndian.PutUint32(pdu[12:], frameId)
	binary.LittleEndian.PutUint32(pdu[16:], decoded)
	select {
	case g.ackCh <- pdu:
	default:
		ackPDUPool.Put(pdu)
		slog.Warn("RDPGFX: ackCh full, ACK dropped")
	}
}

func (g *GfxHandler) onEndFrame(data []byte) {
	if len(data) < 4 {
		return
	}
	realDepth := uint32(len(g.decodeCh))
	if hint := g.queueDepthHint.Load(); hint > realDepth {
		realDepth = hint
	}
	g.sendFrameAck(binary.LittleEndian.Uint32(data), realDepth)
}

// SetQueueDepthHint sets a minimum queueDepth to report in FRAME_ACKNOWLEDGE
// PDUs (MS-RDPEGFX 2.2.2.8).  The server uses this value to pace its frame
// rate and encoding quality: a larger value signals that the client's decode
// queue is full, causing the server to slow down or reduce quality.
//
// A hint of 0 (the default) means "report the real queue length".
// Values in the range 10–100 are typical for moderate throttling.
// Use suspendFrameAcknowledge (0xFFFFFFFF) to pause the stream entirely
// (the stream resumes automatically when the hint is cleared).
func (g *GfxHandler) SetQueueDepthHint(depth uint32) {
	g.queueDepthHint.Store(depth)
}

// onWireToSurface1Decode handles RDPGFX_WIRE_TO_SURFACE_PDU_1 (MS-RDPEGFX 2.2.2.1).
func (g *GfxHandler) onWireToSurface1Decode(data []byte, skipHeavy bool) {
	if len(data) < 17 {
		return
	}
	// Parse fixed header fields via direct binary indexing (avoids bytes.NewReader
	// and per-field io.ReadFull overhead on the hot H.264 path).
	surfId := binary.LittleEndian.Uint16(data[0:])
	codecId := binary.LittleEndian.Uint16(data[2:])
	pixFmt := data[4]
	left := binary.LittleEndian.Uint16(data[5:])
	top := binary.LittleEndian.Uint16(data[7:])
	right := binary.LittleEndian.Uint16(data[9:])
	bottom := binary.LittleEndian.Uint16(data[11:])
	bmpLen := binary.LittleEndian.Uint32(data[13:])
	if int(bmpLen) > len(data)-17 {
		return
	}
	bmpData := data[17 : 17+int(bmpLen)]

	if slog.Default().Enabled(nil, slog.LevelDebug) {
		slog.Debug("RDPGFX: WTS1", "surfId", surfId, "codecId", codecId,
			"w", right-left, "h", bottom-top, "bmpLen", bmpLen)
	}

	w := int(right - left)
	h := int(bottom - top)
	if w <= 0 || h <= 0 {
		return
	}

	s, ok := g.surfaces[surfId]
	if !ok {
		return
	}

	// CaVideo (0x0003) carries RFX tile-encoded data; decode onto the
	// persistent surface buffer like the progressive codec in WTS2.
	if codecId == codecCaVideo {
		if skipHeavy {
			return
		}
		rects := g.rfx.Decode(bmpData, int(left), int(top), s.data, int(s.width), int(s.height))
		g.emitCaVideoRects(s, rects)
		return
	}

	var decoded []byte
	var avcRegions []avcRect
	owned := false // true ⇒ decoded buffer is from bitmapBufPool and must be released
	switch codecId {
	case codecUncompressed:
		decoded = decodeUncompressed(bmpData, w, h, pixFmt)
		owned = true
	case codecPlanar:
		decoded = decodePlanar(bmpData, w, h)
		owned = true
	case codecAVC420:
		destX := int(s.outputX) + int(left)
		destY := int(s.outputY) + int(top)
		if g.onNV12 != nil {
			var ownedAVC bool
			var nv12 *H264FrameNV12
			decoded, nv12, avcRegions, ownedAVC = g.decodeAVC420WithNV12(bmpData, destX, destY, w, h)
			owned = ownedAVC
			if nv12 != nil {
				if decoded != nil {
					blitToSurface(s, int(left), int(top), w, h, decoded)
					if owned {
						releaseBitmapBuf(decoded)
					}
				} else {
					// Display advanced without a shadow update; mark stale so a
					// later full-surface (WTS2) frame fully repairs the shadow.
					s.shadowStale = true
				}
				g.onNV12(destX, destY, w, h, nv12.Y, nv12.YStride, nv12.UV, nv12.UVStride)
				return
			}
			// NV12 unavailable; fall through to BGRA emit.
		} else if g.onI420 != nil {
			var ownedAVC bool
			var i420 *H264FrameI420
			decoded, i420, avcRegions, ownedAVC = g.decodeAVC420WithI420(bmpData, destX, destY, w, h)
			owned = ownedAVC
			if i420 != nil {
				if decoded != nil {
					blitToSurface(s, int(left), int(top), w, h, decoded)
					if owned {
						releaseBitmapBuf(decoded)
					}
				} else {
					s.shadowStale = true
				}
				g.onI420(destX, destY, w, h, i420.Y, i420.YStride, i420.U, i420.UStride, i420.V, i420.VStride)
				return
			}
			// I420 unavailable (nil frame or unsupported format); fall through to BGRA emit.
		} else {
			var ownedAVC bool
			decoded, avcRegions, ownedAVC = g.decodeAVC420(bmpData, destX, destY, w, h)
			owned = ownedAVC
		}
	case codecAVC444, codecAVC444v2:
		destX := int(s.outputX) + int(left)
		destY := int(s.outputY) + int(top)
		if g.onNV12 != nil {
			var ownedAVC bool
			var nv12 *H264FrameNV12
			decoded, nv12, avcRegions, ownedAVC = g.decodeAVC444WithNV12(bmpData, destX, destY, w, h)
			owned = ownedAVC
			if nv12 != nil {
				if decoded != nil {
					blitToSurface(s, int(left), int(top), w, h, decoded)
					if owned {
						releaseBitmapBuf(decoded)
					}
				} else {
					// Display advanced without a shadow update; mark stale so a
					// later full-surface frame fully repairs the shadow.
					s.shadowStale = true
				}
				g.onNV12(destX, destY, w, h, nv12.Y, nv12.YStride, nv12.UV, nv12.UVStride)
				return
			}
			// nv12 == nil: LC=2 chroma frame or decoder stall.
			// decoded may contain combined BGRA; fall through to emit it.
		} else if g.onI420 != nil {
			var ownedAVC bool
			var i420 *H264FrameI420
			decoded, i420, avcRegions, ownedAVC = g.decodeAVC444WithI420(bmpData, destX, destY, w, h)
			owned = ownedAVC
			if i420 != nil {
				if decoded != nil {
					blitToSurface(s, int(left), int(top), w, h, decoded)
					if owned {
						releaseBitmapBuf(decoded)
					}
				} else {
					s.shadowStale = true
				}
				g.onI420(destX, destY, w, h, i420.Y, i420.YStride, i420.U, i420.UStride, i420.V, i420.VStride)
				return
			}
			// i420 == nil: LC=2 or decoder unavailable; decoded may contain BGRA.
		} else {
			var ownedAVC bool
			decoded, avcRegions, ownedAVC = g.decodeAVC444(bmpData, destX, destY, w, h)
			owned = ownedAVC
		}
	default:
		slog.Warn("RDPGFX: unsupported codec in WTS1", "codecId", codecId, "surfId", surfId, "w", w, "h", h, "bmpLen", bmpLen)
		return
	}
	if decoded == nil {
		return
	}

	if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
		g.blitAndEmitAVCRegions(s, int(left), int(top), w, h, decoded, avcRegions)
		if owned {
			releaseBitmapBuf(decoded)
		}
		return
	}

	blitToSurface(s, int(left), int(top), w, h, decoded)
	if owned {
		g.emitBitmapPooled(s, int(left), int(top), w, h, decoded)
	} else {
		g.emitBitmap(s, int(left), int(top), w, h, decoded)
	}
}

// onWireToSurface2Decode handles RDPGFX_WIRE_TO_SURFACE_PDU_2 (MS-RDPEGFX 2.2.2.2).
func (g *GfxHandler) onWireToSurface2Decode(data []byte, skipHeavy bool) {
	if len(data) < 13 {
		return
	}
	// Parse fixed header fields via direct binary indexing (avoids bytes.NewReader
	// and per-field io.ReadFull overhead on the hot H.264 path).
	surfId := binary.LittleEndian.Uint16(data[0:])
	codecId := binary.LittleEndian.Uint16(data[2:])
	codecCtxId := binary.LittleEndian.Uint32(data[4:])
	pixFmt := data[8]
	bmpLen := binary.LittleEndian.Uint32(data[9:])
	if int(bmpLen) > len(data)-13 {
		return
	}
	bmpData := data[13 : 13+int(bmpLen)]

	s, ok := g.surfaces[surfId]
	if !ok {
		return
	}

	w := int(s.width)
	h := int(s.height)

	if slog.Default().Enabled(nil, slog.LevelDebug) {
		slog.Debug("RDPGFX: WTS2", "surfId", surfId, "codecId", codecId,
			"w", w, "h", h, "bmpLen", bmpLen)
	}

	var decoded []byte
	switch codecId {
	case codecUncompressed:
		decoded = decodeUncompressed(bmpData, w, h, pixFmt)
		blitToSurface(s, 0, 0, w, h, decoded)
		g.emitBitmapPooled(s, 0, 0, w, h, decoded)
	case codecPlanar:
		decoded = decodePlanar(bmpData, w, h)
		blitToSurface(s, 0, 0, w, h, decoded)
		g.emitBitmapPooled(s, 0, 0, w, h, decoded)
	case codecCaVideo:
		if skipHeavy {
			break // frame drop
		}
		rects := g.rfx.Decode(bmpData, 0, 0, s.data, w, h)
		g.emitCaVideoRects(s, rects)
	case codecAVC420:
		destX := int(s.outputX)
		destY := int(s.outputY)
		if g.onNV12 != nil {
			decoded, nv12, avcRegions, ownedAVC := g.decodeAVC420WithNV12(bmpData, destX, destY, w, h)
			if nv12 != nil {
				if decoded != nil {
					// GPU drives the display via onNV12; the CPU shadow only needs
					// the dirty regions when it is already in sync.  A full blit is
					// forced when the shadow is stale (a prior GPU-only frame
					// advanced the display without updating it).
					if !s.shadowStale && len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
						g.blitAVCRegionsToSurface(s, 0, 0, w, h, decoded, avcRegions)
					} else {
						blitToSurface(s, 0, 0, w, h, decoded)
						s.shadowStale = false
					}
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					// Display advanced (onNV12) without a BGRA shadow update; mark
					// the shadow stale so the next decoded frame fully repairs it.
					s.shadowStale = true
				}
				g.onNV12(destX, destY, w, h, nv12.Y, nv12.YStride, nv12.UV, nv12.UVStride)
			} else if decoded != nil {
				// NV12 unavailable; fall back to BGRA emit.
				if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
					g.blitAndEmitAVCRegions(s, 0, 0, w, h, decoded, avcRegions)
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					blitToSurface(s, 0, 0, w, h, decoded)
					if ownedAVC {
						g.emitBitmapPooled(s, 0, 0, w, h, decoded)
					} else {
						g.emitBitmap(s, 0, 0, w, h, decoded)
					}
				}
			}
		} else if g.onI420 != nil {
			decoded, i420, avcRegions, ownedAVC := g.decodeAVC420WithI420(bmpData, destX, destY, w, h)
			if i420 != nil {
				if decoded != nil {
					if !s.shadowStale && len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
						g.blitAVCRegionsToSurface(s, 0, 0, w, h, decoded, avcRegions)
					} else {
						blitToSurface(s, 0, 0, w, h, decoded)
						s.shadowStale = false
					}
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					s.shadowStale = true
				}
				g.onI420(destX, destY, w, h, i420.Y, i420.YStride, i420.U, i420.UStride, i420.V, i420.VStride)
			} else if decoded != nil {
				// I420 unavailable; fall back to BGRA emit.
				if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
					g.blitAndEmitAVCRegions(s, 0, 0, w, h, decoded, avcRegions)
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					blitToSurface(s, 0, 0, w, h, decoded)
					if ownedAVC {
						g.emitBitmapPooled(s, 0, 0, w, h, decoded)
					} else {
						g.emitBitmap(s, 0, 0, w, h, decoded)
					}
				}
			}
		} else {
			decoded, avcRegions, ownedAVC := g.decodeAVC420(bmpData, destX, destY, w, h)
			if decoded != nil {
				if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
					g.blitAndEmitAVCRegions(s, 0, 0, w, h, decoded, avcRegions)
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					blitToSurface(s, 0, 0, w, h, decoded)
					if ownedAVC {
						g.emitBitmapPooled(s, 0, 0, w, h, decoded)
					} else {
						g.emitBitmap(s, 0, 0, w, h, decoded)
					}
				}
			}
		}
	case codecAVC444, codecAVC444v2:
		destX := int(s.outputX)
		destY := int(s.outputY)
		if g.onI420 != nil {
			decoded, i420, avcRegions, ownedAVC := g.decodeAVC444WithI420(bmpData, destX, destY, w, h)
			if i420 != nil {
				if decoded != nil {
					if !s.shadowStale && len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
						g.blitAVCRegionsToSurface(s, 0, 0, w, h, decoded, avcRegions)
					} else {
						blitToSurface(s, 0, 0, w, h, decoded)
						s.shadowStale = false
					}
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					s.shadowStale = true
				}
				g.onI420(destX, destY, w, h, i420.Y, i420.YStride, i420.U, i420.UStride, i420.V, i420.VStride)
			} else if decoded != nil {
				if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
					g.blitAndEmitAVCRegions(s, 0, 0, w, h, decoded, avcRegions)
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					blitToSurface(s, 0, 0, w, h, decoded)
					if ownedAVC {
						g.emitBitmapPooled(s, 0, 0, w, h, decoded)
					} else {
						g.emitBitmap(s, 0, 0, w, h, decoded)
					}
				}
			}
		} else {
			decoded, avcRegions, ownedAVC := g.decodeAVC444(bmpData, destX, destY, w, h)
			if decoded != nil {
				if len(avcRegions) > 0 && shouldUseAVCRegions(avcRegions, w, h) {
					g.blitAndEmitAVCRegions(s, 0, 0, w, h, decoded, avcRegions)
					if ownedAVC {
						releaseBitmapBuf(decoded)
					}
				} else {
					blitToSurface(s, 0, 0, w, h, decoded)
					if ownedAVC {
						g.emitBitmapPooled(s, 0, 0, w, h, decoded)
					} else {
						g.emitBitmap(s, 0, 0, w, h, decoded)
					}
				}
			}
		}
	case codecProgressive:
		if skipHeavy {
			break // frame drop
		}
		// Decode tiles directly onto the persistent surface buffer.
		rects := g.progressive.Decode(bmpData, s.data, w, h)
		for _, rc := range rects {
			needed := rc.w * rc.h * 4
			region := regionPool.Get().([]byte)
			if cap(region) < needed {
				region = make([]byte, needed)
			} else {
				region = region[:needed]
			}
			stride := w * 4
			rowBytes := rc.w * 4
			for row := 0; row < rc.h; row++ {
				srcOff := (rc.y+row)*stride + rc.x*4
				dstOff := row * rowBytes
				if srcOff+rowBytes <= len(s.data) {
					copy(region[dstOff:dstOff+rowBytes], s.data[srcOff:srcOff+rowBytes])
				}
			}
			g.emitBitmap(s, rc.x, rc.y, rc.w, rc.h, region)
			regionPool.Put(region)
		}
	default:
		slog.Debug("RDPGFX: WTS2 unsupported codec", "codecId", codecId, "ctxId", codecCtxId)
		return
	}
}

func (g *GfxHandler) onSolidFill(data []byte) {
	if len(data) < 8 {
		return
	}
	surfId := binary.LittleEndian.Uint16(data[0:])
	cb := data[2]
	cg := data[3]
	cr := data[4]
	// data[5] = XA (ignored)
	fillCount := binary.LittleEndian.Uint16(data[6:])

	s, ok := g.surfaces[surfId]
	if !ok {
		return
	}

	stride := int(s.width) * 4
	// Pre-compose a single BGRA pixel as a uint32 for one-shot writes.
	pixelU32 := uint32(cb) | uint32(cg)<<8 | uint32(cr)<<16 | uint32(0xFF)<<24

	offset := 8
	for range fillCount {
		if offset+8 > len(data) {
			break
		}
		left := binary.LittleEndian.Uint16(data[offset:])
		top := binary.LittleEndian.Uint16(data[offset+2:])
		right := binary.LittleEndian.Uint16(data[offset+4:])
		bottom := binary.LittleEndian.Uint16(data[offset+6:])
		offset += 8
		w := int(right - left)
		h := int(bottom - top)
		if w <= 0 || h <= 0 {
			continue
		}

		// Clamp to surface bounds
		yEnd := min(int(bottom), int(s.height))
		xEnd := min(int(right), int(s.width))

		// Fill the first row with PutUint32 (single 32-bit store per pixel),
		// then replicate it to subsequent rows with copy().
		rowStart := int(top)*stride + int(left)*4
		rowBytes := (xEnd - int(left)) * 4
		if rowStart+rowBytes <= len(s.data) {
			row := s.data[rowStart : rowStart+rowBytes]
			for x := 0; x+4 <= rowBytes; x += 4 {
				binary.LittleEndian.PutUint32(row[x:], pixelU32)
			}
			for y := int(top) + 1; y < yEnd; y++ {
				dst := y*stride + int(left)*4
				if dst+rowBytes <= len(s.data) {
					copy(s.data[dst:dst+rowBytes], row)
				}
			}
		}

		if s.mapped && g.onBitmap != nil {
			// Build fill data: fill first row, then replicate (doubling).
			fillData := acquireBitmapBuf(w * h * 4)
			rowW := w * 4
			for x := 0; x+4 <= rowW; x += 4 {
				binary.LittleEndian.PutUint32(fillData[x:], pixelU32)
			}
			// Doubling copy: O(log h) memmoves instead of h linear copies.
			filled := rowW
			total := rowW * h
			for filled*2 <= total {
				copy(fillData[filled:filled*2], fillData[:filled])
				filled *= 2
			}
			if filled < total {
				copy(fillData[filled:total], fillData[:total-filled])
			}
			destL := int(s.outputX) + int(left)
			destT := int(s.outputY) + int(top)
			g.singleUpdate[0] = BitmapUpdate{
				DestLeft: destL, DestTop: destT,
				DestRight: destL + w - 1, DestBottom: destT + h - 1,
				Width: w, Height: h, Bpp: 4, Data: fillData,
			}
			g.emitAndReleaseUpdates(g.singleUpdate[:])
		}
	}
}

// onSurfaceToSurface handles RDPGFX_SURFACE_TO_SURFACE_PDU (MS-RDPEGFX 2.2.2.5).
// It blits one or more source rectangles from srcSurface to destSurface.
// For each rect r, pixels at (r.left, r.top, r.right, r.bottom) in the source
// are copied to (destPt.x+r.left, destPt.y+r.top) in the destination.
func (g *GfxHandler) onSurfaceToSurface(data []byte) {
	// Header: srcSurfaceId(2) + destSurfaceId(2) + destPt.x(2) + destPt.y(2) + rectCount(2) = 10 bytes
	if len(data) < 10 {
		return
	}
	srcId := binary.LittleEndian.Uint16(data[0:])
	dstId := binary.LittleEndian.Uint16(data[2:])
	destPtX := int(binary.LittleEndian.Uint16(data[4:]))
	destPtY := int(binary.LittleEndian.Uint16(data[6:]))
	rectCount := int(binary.LittleEndian.Uint16(data[8:]))

	src, srcOk := g.surfaces[srcId]
	dst, dstOk := g.surfaces[dstId]
	if !srcOk || !dstOk {
		return
	}

	srcStride := int(src.width) * 4
	dstStride := int(dst.width) * 4
	offset := 10
	for i := 0; i < rectCount; i++ {
		if offset+8 > len(data) {
			break
		}
		left := int(binary.LittleEndian.Uint16(data[offset:]))
		top := int(binary.LittleEndian.Uint16(data[offset+2:]))
		right := int(binary.LittleEndian.Uint16(data[offset+4:]))
		bottom := int(binary.LittleEndian.Uint16(data[offset+6:]))
		offset += 8

		w := right - left
		h := bottom - top
		if w <= 0 || h <= 0 {
			continue
		}
		dstX := destPtX + left
		dstY := destPtY + top
		rowBytes := w * 4
		for row := 0; row < h; row++ {
			srcRow := top + row
			dstRow := dstY + row
			if srcRow < 0 || srcRow >= int(src.height) ||
				dstRow < 0 || dstRow >= int(dst.height) {
				continue
			}
			srcOff := srcRow*srcStride + left*4
			dstOff := dstRow*dstStride + dstX*4
			if srcOff < 0 || srcOff+rowBytes > len(src.data) ||
				dstOff < 0 || dstOff+rowBytes > len(dst.data) {
				continue
			}
			copy(dst.data[dstOff:dstOff+rowBytes], src.data[srcOff:srcOff+rowBytes])
		}
		g.emitBitmap(dst, dstX, dstY, w, h, dst.data)
	}
}

func (g *GfxHandler) onCacheToSurface(data []byte) {
	if len(data) < 6 {
		return
	}
	cacheSlot := binary.LittleEndian.Uint16(data[0:])
	surfId := binary.LittleEndian.Uint16(data[2:])
	destCount := binary.LittleEndian.Uint16(data[4:])

	ce, hasCE := g.cacheEntries[cacheSlot]
	s, hasSurf := g.surfaces[surfId]

	offset := 6
	for range destCount {
		if offset+4 > len(data) {
			break
		}
		dx := binary.LittleEndian.Uint16(data[offset:])
		dy := binary.LittleEndian.Uint16(data[offset+2:])
		offset += 4
		if hasCE && hasSurf {
			blitToSurface(s, int(dx), int(dy), ce.width, ce.height, ce.data)
			g.emitBitmap(s, int(dx), int(dy), ce.width, ce.height, ce.data)
		}
	}
}

func (g *GfxHandler) onEvictCacheEntry(data []byte) {
	if len(data) < 2 {
		return
	}
	slot := binary.LittleEndian.Uint16(data)
	delete(g.cacheEntries, slot)
}

func (g *GfxHandler) onCacheImportOffer() {
	var p [2]byte // importedEntriesCount = 0 (little-endian zero)
	g.sendPdu(cmdidCacheImportReply, p[:])
}

// --- Helpers ---

// emitCaVideoRects copies decoded RemoteFX tile regions from the surface
// pixel buffer into individual BitmapUpdate slices and emits them.
// Used by both onWireToSurface1Decode and onWireToSurface2Decode.
func (g *GfxHandler) emitCaVideoRects(s *surface, rects []rfxRect) {
	if !s.mapped || g.onBitmap == nil || len(rects) == 0 {
		return
	}
	g.updatesBuf = g.updatesBuf[:0]
	stride := int(s.width) * 4
	for _, rc := range rects {
		needed := rc.w * rc.h * 4
		region := acquireBitmapBuf(needed)
		rowBytes := rc.w * 4
		for row := 0; row < rc.h; row++ {
			srcOff := (rc.y+row)*stride + rc.x*4
			dstOff := row * rowBytes
			if srcOff+rowBytes <= len(s.data) {
				copy(region[dstOff:dstOff+rowBytes], s.data[srcOff:srcOff+rowBytes])
			}
		}
		destL := int(s.outputX) + rc.x
		destT := int(s.outputY) + rc.y
		g.updatesBuf = append(g.updatesBuf, BitmapUpdate{
			DestLeft: destL, DestTop: destT,
			DestRight: destL + rc.w - 1, DestBottom: destT + rc.h - 1,
			Width: rc.w, Height: rc.h, Bpp: 4, Data: region,
		})
	}
	g.emitAndReleaseUpdates(g.updatesBuf)
}

func blitToSurface(s *surface, x, y, w, h int, src []byte) {
	stride := int(s.width) * 4
	// Full-width fast path: when x==0 and w==surface.width the entire region
	// is contiguous in both src and s.data — replace h row-copies with one.
	if x == 0 && w == int(s.width) && y >= 0 && y+h <= int(s.height) {
		dstOff := y * stride
		n := h * stride
		if n <= len(src) && dstOff+n <= len(s.data) {
			copy(s.data[dstOff:dstOff+n], src[:n])
			return
		}
	}
	for row := range h {
		dy := y + row
		if dy < 0 || dy >= int(s.height) {
			continue
		}
		srcOff := row * w * 4
		dstOff := dy*stride + x*4
		n := w * 4
		if dstOff >= 0 && dstOff+n <= len(s.data) && srcOff+n <= len(src) {
			copy(s.data[dstOff:dstOff+n], src[srcOff:srcOff+n])
		}
	}
}

// emitBitmapPooled is like emitBitmap but releases `decoded` back to
// bitmapBufPool after the synchronous onBitmap callback returns.  Use this
// for codec output buffers that the GfxHandler owns end-to-end (currently
// uncompressed and planar).
func (g *GfxHandler) emitBitmapPooled(s *surface, x, y, w, h int, decoded []byte) {
	if !s.mapped || g.onBitmap == nil {
		releaseBitmapBuf(decoded)
		return
	}
	destL := int(s.outputX) + x
	destT := int(s.outputY) + y
	g.singleUpdate[0] = BitmapUpdate{
		DestLeft: destL, DestTop: destT,
		DestRight: destL + w - 1, DestBottom: destT + h - 1,
		Width: w, Height: h, Bpp: 4, Data: decoded,
	}
	g.emitAndReleaseUpdates(g.singleUpdate[:])
}

func (g *GfxHandler) emitBitmap(s *surface, x, y, w, h int, decoded []byte) {
	if !s.mapped || g.onBitmap == nil {
		return
	}
	destL := int(s.outputX) + x
	destT := int(s.outputY) + y
	g.singleUpdate[0] = BitmapUpdate{
		DestLeft: destL, DestTop: destT,
		DestRight: destL + w - 1, DestBottom: destT + h - 1,
		Width: w, Height: h, Bpp: 4, Data: decoded,
	}
	g.onBitmap(g.singleUpdate[:])
	g.singleUpdate[0].Data = nil // release reference; decoded is not pooled
}

// --- Codec: Uncompressed ---

func decodeUncompressed(data []byte, w, h int, pixFmt uint8) []byte {
	out := acquireBitmapBuf(w * h * 4)
	n := w * h * 4
	if len(data) >= n {
		copy(out, data[:n])
	} else {
		copy(out[:len(data)], data)
		// Zero the unfilled tail in case the slice was reused from the pool.
		clear(out[len(data):n])
	}
	return out
}

// --- Codec: Planar (RDP 6.0 Bitmap Codec, MS-RDPEGDI 2.2.2.5) ---

func decodePlanar(data []byte, w, h int) []byte {
	if len(data) < 1 {
		return acquireBitmapBuf(w * h * 4)
	}
	header := data[0]
	rle := (header >> 5) & 1
	noAlpha := (header >> 6) & 1
	planeSize := w * h
	offset := 1

	var alphaPlane, redPlane, greenPlane, bluePlane []byte
	defer func() {
		releasePlaneBuf(alphaPlane)
		releasePlaneBuf(redPlane)
		releasePlaneBuf(greenPlane)
		releasePlaneBuf(bluePlane)
	}()
	if rle == 0 {
		if noAlpha == 0 {
			alphaPlane, offset = readRawPlane(data, offset, planeSize)
		}
		redPlane, offset = readRawPlane(data, offset, planeSize)
		greenPlane, offset = readRawPlane(data, offset, planeSize)
		bluePlane, offset = readRawPlane(data, offset, planeSize)
	} else {
		if noAlpha == 0 {
			alphaPlane, offset = decodeNRLE(data, offset, planeSize)
		}
		redPlane, offset = decodeNRLE(data, offset, planeSize)
		greenPlane, offset = decodeNRLE(data, offset, planeSize)
		bluePlane, offset = decodeNRLE(data, offset, planeSize)
	}
	_ = offset

	applyDelta(alphaPlane, w, h)
	applyDelta(redPlane, w, h)
	applyDelta(greenPlane, w, h)
	applyDelta(bluePlane, w, h)

	out := acquireBitmapBuf(planeSize * 4)
	// Hoist the per-pixel nil/length checks: clamp each plane to
	// `planeSize` (zero-fill missing planes) so the inner loop has no
	// branches and the bounds checks are eliminated.
	rp := planeOrZero(redPlane, planeSize)
	gp := planeOrZero(greenPlane, planeSize)
	bp := planeOrZero(bluePlane, planeSize)
	ap := alphaPlane
	hasAlpha := ap != nil && len(ap) >= planeSize
	if hasAlpha {
		ap = ap[:planeSize]
		for i := range planeSize {
			j := i * 4
			out[j] = bp[i]
			out[j+1] = gp[i]
			out[j+2] = rp[i]
			out[j+3] = ap[i]
		}
	} else {
		for i := range planeSize {
			j := i * 4
			out[j] = bp[i]
			out[j+1] = gp[i]
			out[j+2] = rp[i]
			out[j+3] = 0xFF
		}
	}
	return out
}

// planeOrZero returns a slice of exactly `size` bytes, either the input
// plane (truncated if longer) or a zero-filled buffer when the plane is
// nil or short.  Used to drop per-pixel nil/bounds checks in decodePlanar.
func planeOrZero(plane []byte, size int) []byte {
	if len(plane) >= size {
		return plane[:size]
	}
	out := make([]byte, size)
	copy(out, plane)
	return out
}

func readRawPlane(data []byte, offset, size int) ([]byte, int) {
	plane := acquirePlaneBuf(size)
	end := min(offset+size, len(data))
	if offset < end {
		copy(plane, data[offset:end])
		if end-offset < size {
			clear(plane[end-offset:])
		}
	} else {
		clear(plane)
	}
	return plane, offset + size
}

func decodeNRLE(data []byte, offset, planeSize int) ([]byte, int) {
	out := acquirePlaneBuf(planeSize)
	pos := 0
	for pos < planeSize && offset < len(data) {
		ctrl := data[offset]
		offset++
		runLen := int((ctrl >> 4) & 0x0F)
		rawLen := int(ctrl & 0x0F)

		if runLen == 15 {
			if offset >= len(data) {
				break
			}
			ext := int(data[offset])
			offset++
			runLen += ext
			if ext == 0xFF {
				if offset+1 >= len(data) {
					break
				}
				runLen += int(binary.LittleEndian.Uint16(data[offset:]))
				offset += 2
			}
		}
		// Bulk-zero the run (clear is a runtime intrinsic; much faster than byte-by-byte).
		end := min(pos+runLen, planeSize)
		clear(out[pos:end])
		pos = end

		if rawLen == 15 {
			if offset >= len(data) {
				break
			}
			ext := int(data[offset])
			offset++
			rawLen += ext
			if ext == 0xFF {
				if offset+1 >= len(data) {
					break
				}
				rawLen += int(binary.LittleEndian.Uint16(data[offset:]))
				offset += 2
			}
		}
		// Bulk-copy the raw run (copy is a runtime intrinsic; much faster than byte-by-byte).
		n := min(rawLen, min(planeSize-pos, len(data)-offset))
		copy(out[pos:pos+n], data[offset:offset+n])
		pos += n
		offset += n
	}
	return out, offset
}

func applyDelta(plane []byte, w, h int) {
	if plane == nil || len(plane) < w*h {
		return
	}
	// Process row-by-row: previous row XORs into current row using
	// fixed-length slices so the compiler eliminates per-element
	// bounds checks and the index multiplications hoist.
	for y := 1; y < h; y++ {
		base := y * w
		prev := plane[base-w : base : base]
		cur := plane[base : base+w : base+w]
		for x := range w {
			cur[x] ^= prev[x]
		}
	}
}

// --- Codec: ClearCodec (MS-RDPEGFX 2.2.4) ---

func (ctx *clearCodecCtx) decode(data []byte, w, h int) []byte {
	if len(data) < 12 {
		return make([]byte, w*h*4)
	}
	// Direct binary indexing — avoids bytes.NewReader and per-field interface dispatch.
	residualLen := int(binary.LittleEndian.Uint32(data[0:]))
	bandsLen := int(binary.LittleEndian.Uint32(data[4:]))
	subcodecLen := int(binary.LittleEndian.Uint32(data[8:]))
	off := 12

	out := make([]byte, w*h*4)
	if residualLen > 0 && off+residualLen <= len(data) {
		decodeResidual(data[off:off+residualLen], w, h, out)
	}
	off += residualLen
	if bandsLen > 0 && off >= 0 && off+bandsLen <= len(data) {
		ctx.decodeBands(data[off:off+bandsLen], w, out)
	}
	off += bandsLen
	if subcodecLen > 0 && off >= 0 && off+subcodecLen <= len(data) {
		decodeSubcodec(data[off:off+subcodecLen], w, out)
	}
	return out
}

func decodeResidual(data []byte, w, h int, out []byte) {
	for y := range h {
		rowDstStart := y * w * 4
		rowSrcStart := y * w * 3
		rowDstEnd := rowDstStart + w*4
		rowSrcEnd := rowSrcStart + w*3
		if rowDstEnd > len(out) || rowSrcEnd > len(data) {
			return
		}
		dst := out[rowDstStart:rowDstEnd:rowDstEnd]
		src := data[rowSrcStart:rowSrcEnd:rowSrcEnd]
		for x := range w {
			si := x * 3
			di := x * 4
			dst[di] = src[si]
			dst[di+1] = src[si+1]
			dst[di+2] = src[si+2]
			dst[di+3] = 0xFF
		}
	}
}

func (ctx *clearCodecCtx) decodeBands(data []byte, surfW int, out []byte) {
	// Direct slice indexing — avoids bytes.NewReader and per-field interface dispatch.
	off := 0
	for off+11 <= len(data) {
		xStart := binary.LittleEndian.Uint16(data[off:])
		yStart := binary.LittleEndian.Uint16(data[off+2:])
		xEnd := binary.LittleEndian.Uint16(data[off+4:])
		yEnd := binary.LittleEndian.Uint16(data[off+6:])
		blueBg := data[off+8]
		greenBg := data[off+9]
		redBg := data[off+10]
		off += 11

		bandHeight := int(yEnd - yStart)
		colCount := int(xEnd - xStart)
		if bandHeight <= 0 || colCount <= 0 {
			continue
		}

		for col := range colCount {
			if off+2 > len(data) {
				return
			}
			vBarHeader := binary.LittleEndian.Uint16(data[off:])
			off += 2
			x := int(xStart) + col

			if (vBarHeader & 0xC000) == 0xC000 {
				// SHORT_VBAR_CACHE_HIT
				idx := int(vBarHeader & 0x3FFF)
				if idx < len(ctx.shortVBarStorage) {
					entry := ctx.shortVBarStorage[idx]
					paintColumnBg(out, surfW, x, int(yStart), bandHeight, redBg, greenBg, blueBg)
					paintVBarPixels(out, surfW, x, int(yStart), 0, entry)
				}
			} else if (vBarHeader & 0xC000) == 0x4000 {
				// SHORT_VBAR_CACHE_MISS
				pixCount := int(vBarHeader & 0x3FFF)
				if off >= len(data) {
					return
				}
				yOn := data[off]
				off++
				n := pixCount * 3
				pixels := make([]byte, n)
				available := min(n, len(data)-off)
				copy(pixels, data[off:off+available])
				off += available
				entry := vBarEntry{pixels: pixels, count: pixCount}
				if ctx.shortVBarCursor < len(ctx.shortVBarStorage) {
					ctx.shortVBarStorage[ctx.shortVBarCursor] = entry
				}
				ctx.shortVBarCursor = (ctx.shortVBarCursor + 1) % len(ctx.shortVBarStorage)
				paintColumnBg(out, surfW, x, int(yStart), bandHeight, redBg, greenBg, blueBg)
				paintVBarPixels(out, surfW, x, int(yStart), int(yOn), entry)
			} else if (vBarHeader & 0x8000) == 0x8000 {
				// VBAR_CACHE_HIT
				idx := int(vBarHeader & 0x7FFF)
				if idx < len(ctx.vBarStorage) {
					entry := ctx.vBarStorage[idx]
					paintVBarPixels(out, surfW, x, int(yStart), 0, entry)
				}
			} else {
				// VBAR_CACHE_MISS
				pixCount := int(vBarHeader & 0x7FFF)
				n := pixCount * 3
				pixels := make([]byte, n)
				available := min(n, len(data)-off)
				copy(pixels, data[off:off+available])
				off += available
				entry := vBarEntry{pixels: pixels, count: pixCount}
				if ctx.vBarCursor < len(ctx.vBarStorage) {
					ctx.vBarStorage[ctx.vBarCursor] = entry
				}
				ctx.vBarCursor = (ctx.vBarCursor + 1) % len(ctx.vBarStorage)
				paintVBarPixels(out, surfW, x, int(yStart), 0, entry)
			}
		}
	}
}

func paintColumnBg(out []byte, surfW, x, yStart, height int, r, g, b uint8) {
	if x < 0 || surfW <= 0 || x >= surfW {
		return
	}
	for y := range height {
		dy := yStart + y
		idx := (dy*surfW + x) * 4
		if idx < 0 || idx+4 > len(out) {
			continue
		}
		px := out[idx : idx+4 : idx+4]
		px[0] = b
		px[1] = g
		px[2] = r
		px[3] = 0xFF
	}
}

func paintVBarPixels(out []byte, surfW, x, yStart, yOn int, entry vBarEntry) {
	if x < 0 || surfW <= 0 || x >= surfW {
		return
	}
	pixels := entry.pixels
	for y := 0; y < entry.count; y++ {
		si := y * 3
		dy := yStart + yOn + y
		di := (dy*surfW + x) * 4
		if si+3 > len(pixels) || di < 0 || di+4 > len(out) {
			continue
		}
		src := pixels[si : si+3 : si+3]
		px := out[di : di+4 : di+4]
		px[0] = src[0]
		px[1] = src[1]
		px[2] = src[2]
		px[3] = 0xFF
	}
}

func decodeSubcodec(data []byte, surfW int, out []byte) {
	// Direct slice indexing — avoids bytes.NewReader and per-field interface dispatch.
	off := 0
	for off+13 <= len(data) {
		xStart := binary.LittleEndian.Uint16(data[off:])
		yStart := binary.LittleEndian.Uint16(data[off+2:])
		width := binary.LittleEndian.Uint16(data[off+4:])
		height := binary.LittleEndian.Uint16(data[off+6:])
		bmpLen := int(binary.LittleEndian.Uint32(data[off+8:]))
		subcodecId := data[off+12]
		off += 13
		if off+bmpLen > len(data) {
			break
		}
		bmpData := data[off : off+bmpLen]
		off += bmpLen

		if subcodecId == 0 {
			// RAW BGR
			rowSrc := int(width) * 3
			rowDst := surfW * 4
			for y := 0; y < int(height); y++ {
				srcStart := y * rowSrc
				srcEnd := srcStart + rowSrc
				dy := int(yStart) + y
				dstStart := dy*rowDst + int(xStart)*4
				dstEnd := dstStart + int(width)*4
				if srcEnd > len(bmpData) || dstStart < 0 || dstEnd > len(out) {
					continue
				}
				src := bmpData[srcStart:srcEnd:srcEnd]
				dst := out[dstStart:dstEnd:dstEnd]
				for x := 0; x < int(width); x++ {
					si := x * 3
					di := x * 4
					dst[di] = src[si]
					dst[di+1] = src[si+1]
					dst[di+2] = src[si+2]
					dst[di+3] = 0xFF
				}
			}
		}
		// Skip NSCodec (1) and glyph (2) subcodecs
	}
}
