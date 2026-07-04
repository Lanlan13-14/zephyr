package rdpgfx

// AVC420 / AVC444 bitmap stream parsing (MS-RDPEGFX 2.2.4.6 / 2.2.4.7).

import (
	"encoding/binary"
	"fmt"
	"log/slog"
	"runtime"
	"sync"
	"time"
)

type avcRect struct {
	left, top, right, bottom uint16
}

type avc420Stream struct {
	regions  []avcRect
	h264Data []byte
}

// fillAVC420Stream parses data into out in-place, reusing out.regions if its
// capacity is sufficient.  This avoids a heap allocation for the regions slice
// on every AVC frame when called with a pre-allocated GfxHandler field.
func fillAVC420Stream(data []byte, out *avc420Stream) error {
	if len(data) < 4 {
		return fmt.Errorf("avc420 stream too short (%d bytes)", len(data))
	}

	numRegions := binary.LittleEndian.Uint32(data[:4])
	if numRegions > 65536 {
		return fmt.Errorf("avc420: too many regions: %d", numRegions)
	}

	// 4 bytes header + 10 bytes per region (8-byte rect + 2-byte quant/quality)
	metaSize := 4 + int(numRegions)*10
	if metaSize > len(data) {
		return fmt.Errorf("avc420: metadata truncated (need %d, have %d)", metaSize, len(data))
	}

	if cap(out.regions) >= int(numRegions) {
		out.regions = out.regions[:numRegions]
	} else {
		out.regions = make([]avcRect, numRegions)
	}
	off := 4
	for i := range numRegions {
		out.regions[i] = avcRect{
			left:   binary.LittleEndian.Uint16(data[off:]),
			top:    binary.LittleEndian.Uint16(data[off+2:]),
			right:  binary.LittleEndian.Uint16(data[off+4:]),
			bottom: binary.LittleEndian.Uint16(data[off+6:]),
		}
		off += 8
	}
	out.h264Data = data[metaSize:]
	return nil
}

// parseAVC420Stream parses RDPGFX_AVC420_BITMAP_STREAM into a new struct.
// Callers that run on the decode goroutine should prefer fillAVC420Stream with
// a pre-allocated GfxHandler field to avoid per-frame heap allocations.
func parseAVC420Stream(data []byte) (*avc420Stream, error) {
	var out avc420Stream
	if err := fillAVC420Stream(data, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// parseAVC444Stream parses RDPGFX_AVC444_BITMAP_STREAM.
// Returns the main AVC420 stream, the auxiliary AVC420 stream, and the LC
// (luma-chroma) field.
//
//	LC=0: both streams present; stream1 = main (YUV420), stream2 = chroma upgrade.
//	LC=1: main stream only; stream2 is nil.
//	LC=2: auxiliary only (chroma upgrade); stream1 is nil.
func parseAVC444Stream(data []byte) (stream1, stream2 *avc420Stream, lc uint8, err error) {
	if len(data) < 4 {
		return nil, nil, 0, fmt.Errorf("avc444 stream too short")
	}

	cbField := binary.LittleEndian.Uint32(data[:4])
	lc = uint8((cbField >> 30) & 0x03)
	cbStream1 := int(cbField & 0x3FFFFFFF)
	rest := data[4:]

	switch lc {
	case 0: // Both streams present
		if cbStream1 > len(rest) {
			return nil, nil, lc, fmt.Errorf("avc444: stream1 size %d exceeds data %d", cbStream1, len(rest))
		}
		stream1, err = parseAVC420Stream(rest[:cbStream1])
		if err != nil {
			return nil, nil, lc, err
		}
		if cbStream1 < len(rest) {
			stream2, err = parseAVC420Stream(rest[cbStream1:])
			if err != nil {
				slog.Debug("RDPGFX: AVC444 stream2 parse error (LC=0)", "err", err)
				stream2 = nil
				err = nil
			}
		}
		return stream1, stream2, lc, nil
	case 1: // Main stream only
		streamData := rest
		if cbStream1 > 0 && cbStream1 <= len(rest) {
			streamData = rest[:cbStream1]
		}
		stream1, err = parseAVC420Stream(streamData)
		return stream1, nil, lc, err
	case 2: // Auxiliary only (chroma upgrade)
		streamData := rest
		if cbStream1 > 0 && cbStream1 <= len(rest) {
			streamData = rest[:cbStream1]
		}
		stream2, err = parseAVC420Stream(streamData)
		return nil, stream2, lc, err
	default:
		return nil, nil, lc, fmt.Errorf("avc444: invalid LC=%d", lc)
	}
}

// fillAVC444Stream parses data into g.avcStream1 and g.avcStream2, reusing
// their regions slices to avoid per-frame heap allocations.
// Safe: always called on the single decode goroutine.
func (g *GfxHandler) fillAVC444Stream(data []byte) (stream1, stream2 *avc420Stream, lc uint8, err error) {
	if len(data) < 4 {
		return nil, nil, 0, fmt.Errorf("avc444 stream too short")
	}

	cbField := binary.LittleEndian.Uint32(data[:4])
	lc = uint8((cbField >> 30) & 0x03)
	cbStream1 := int(cbField & 0x3FFFFFFF)
	rest := data[4:]

	switch lc {
	case 0: // Both streams present
		if cbStream1 > len(rest) {
			return nil, nil, lc, fmt.Errorf("avc444: stream1 size %d exceeds data %d", cbStream1, len(rest))
		}
		if err = fillAVC420Stream(rest[:cbStream1], &g.avcStream1); err != nil {
			return nil, nil, lc, err
		}
		stream1 = &g.avcStream1
		if cbStream1 < len(rest) {
			if err2 := fillAVC420Stream(rest[cbStream1:], &g.avcStream2); err2 != nil {
				slog.Debug("RDPGFX: AVC444 stream2 parse error (LC=0)", "err", err2)
			} else {
				stream2 = &g.avcStream2
			}
		}
		return stream1, stream2, lc, nil
	case 1: // Main stream only
		streamData := rest
		if cbStream1 > 0 && cbStream1 <= len(rest) {
			streamData = rest[:cbStream1]
		}
		if err = fillAVC420Stream(streamData, &g.avcStream1); err != nil {
			return nil, nil, lc, err
		}
		return &g.avcStream1, nil, lc, nil
	case 2: // Auxiliary only (chroma upgrade)
		streamData := rest
		if cbStream1 > 0 && cbStream1 <= len(rest) {
			streamData = rest[:cbStream1]
		}
		if err = fillAVC420Stream(streamData, &g.avcStream2); err != nil {
			return nil, nil, lc, err
		}
		return nil, &g.avcStream2, lc, nil
	default:
		return nil, nil, lc, fmt.Errorf("avc444: invalid LC=%d", lc)
	}
}

// avc444YPlane caches the tightly-packed luma plane (stride = Width) from the
// most recently decoded AVC444 main stream.  It is used to combine with the
// auxiliary chroma stream when LC=2 frames arrive.
type avc444YPlane struct {
	data      []byte // luma Y, tight-packed, stride = w
	u         []byte // Cb (U) plane from stream1, half-res, stride = (w+1)/2
	v         []byte // Cr (V) plane from stream1, half-res, stride = (w+1)/2
	stride    int    // = w
	uvStride  int    // = (w+1)/2
	w, h      int
	fullRange bool
	updatedAt time.Time // last time the cache was refreshed from a live main-stream decode
}

// avc444YStaleness is the maximum age of the Y-plane cache before LC=2
// combines are suppressed.  When the main decoder (h264dec) stalls, the
// Y-plane is frozen while incoming LC=2 frames carry fresh chroma — combining
// stale luma with fresh chroma produces wrong colours.  500 ms is well above
// the inter-frame interval at typical RDP frame rates (≥2 fps) yet much lower
// than the 7-second hard stall threshold, so normal operation is unaffected.
const avc444YStaleness = 500 * time.Millisecond

// avcHWStallQueueDepthHint is the queueDepth value reported in
// FRAME_ACKNOWLEDGE PDUs while the HW decoder is stalling (Y cache stale).
// Reporting a depth of 10 signals to the Windows RDP server that the client's
// decode backlog is growing, prompting it to reduce encoding quality and
// bitrate.  This reduces the stream of LC=2 frames that accumulate during a
// VideoToolbox null-frame period and gives VT more headroom to flush its
// pipeline.  The hint is cleared when the Y cache is refreshed (stall over).
const avcHWStallQueueDepthHint uint32 = 10

// isH264Keyframe returns true when data contains an IDR NAL unit (type 5),
// which marks the start of a new GOP (key frame).  The scan handles both
// 3-byte (00 00 01) and 4-byte (00 00 00 01) Annex-B start codes.
func isH264Keyframe(data []byte) bool {
	for i := 0; i+4 <= len(data); i++ {
		// Look for Annex-B start code: 00 00 01 or 00 00 00 01.
		if data[i] == 0x00 && data[i+1] == 0x00 {
			var nalByte byte
			if data[i+2] == 0x01 && i+3 < len(data) {
				nalByte = data[i+3]
				i += 2
			} else if data[i+2] == 0x00 && i+3 < len(data) && data[i+3] == 0x01 && i+4 < len(data) {
				nalByte = data[i+4]
				i += 3
			} else {
				continue
			}
			nalType := nalByte & 0x1F
			if nalType == 5 { // IDR slice
				return true
			}
		}
	}
	return false
}

// firstNALType returns the NAL unit type byte of the first Annex-B NAL in
// data, or 0xFF if none found.  Useful for diagnosing decoder "buffering".
func firstNALType(data []byte) byte {
	for i := 0; i+4 <= len(data); i++ {
		if data[i] == 0x00 && data[i+1] == 0x00 {
			if data[i+2] == 0x01 && i+3 < len(data) {
				return data[i+3] & 0x1F
			} else if data[i+2] == 0x00 && i+3 < len(data) && data[i+3] == 0x01 && i+4 < len(data) {
				return data[i+4] & 0x1F
			}
		}
	}
	return 0xFF
}


// decoded frame plus the dirty rectangle list reported in the AVC420 stream
// header (in decoded-frame coordinates).  When regions is non-empty callers
// can blit only those regions instead of the whole frame, which dramatically
// reduces per-frame copying for typical desktop video where most of the
// frame is unchanged from the previous frame.
// The pooled return value is true when the returned slice was acquired from
// bitmapBufPool; the caller must then call releaseBitmapBuf on it.
func (g *GfxHandler) decodeAVC420(data []byte, destX, destY, destW, destH int) ([]byte, []avcRect, bool) {
	// Parse the stream header once and reuse for both the raw-NAL callback and
	// the actual decode path, avoiding a redundant walk of the metadata.
	parseErr := fillAVC420Stream(data, &g.avcStream1)
	stream := &g.avcStream1
	// Compute isKF once — shared between the onH264Raw forwarding path and the
	// maybeCacheStream1IDR call below, avoiding two linear scans of the NAL data.
	var isKF bool
	if parseErr == nil && len(stream.h264Data) > 0 {
		isKF = isH264Keyframe(stream.h264Data)
	}
	if g.onH264Raw != nil && parseErr == nil && len(stream.h264Data) > 0 {
		nalData := make([]byte, len(stream.h264Data))
		copy(nalData, stream.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if g.h264dec == nil {
		return nil, nil, false
	}
	if parseErr != nil {
		slog.Warn("RDPGFX: AVC420 parse error", "err", parseErr)
		return nil, nil, false
	}
	if len(stream.h264Data) == 0 {
		return nil, nil, false
	}
	if isKF {
		g.maybeCacheStream1IDR(stream.h264Data)
	}
	// For frames where only a small dirty area changed, pass region hints so
	// the decoder can skip converting pixels outside those rectangles.  This
	// is safe here because decodeAVC420 uses blitAndEmitAVCRegions (which only
	// reads dirty pixels) when shouldUseAVCRegions returns true.
	if rh, ok := g.h264dec.(RegionHinter); ok &&
		len(stream.regions) > 0 && shouldUseAVCRegions(stream.regions, destW, destH) {
		if cap(g.regionHintBuf) >= len(stream.regions) {
			g.regionHintBuf = g.regionHintBuf[:len(stream.regions)]
		} else {
			g.regionHintBuf = make([][4]uint16, len(stream.regions))
		}
		for i, r := range stream.regions {
			g.regionHintBuf[i] = [4]uint16{r.left, r.top, r.right, r.bottom}
		}
		rh.SetRegionHint(g.regionHintBuf)
	}
	frame, err := g.h264dec.Decode(stream.h264Data)
	if err != nil {
		slog.Warn("RDPGFX: H.264 decode error", "err", err)
		return nil, nil, false
	}
	if frame == nil {
		g.maybeRequestKeyframe()
		g.maybeNotifyDecoderBroken()
		slog.Debug("RDPGFX: H.264 decode returned nil frame (buffering?)")
		return nil, nil, false
	}
	if frame.Dropped {
		slog.Debug("RDPGFX: AVC420 frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		return nil, nil, false
	}
	if slog.Default().Enabled(nil, slog.LevelDebug) {
		slog.Debug("RDPGFX: AVC420 decoded", "frameW", frame.Width, "frameH", frame.Height, "destW", destW, "destH", destH, "regions", len(stream.regions), "h264Len", len(stream.h264Data))
	}
	g.noteSuccessfulDecode()
	decoded, pooled := cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)
	return decoded, stream.regions, pooled
}

// decodeAVC444 decodes AVC444 bitmap data to BGRA pixels.
// LC=0 and LC=1 decode the main YUV420 stream and cache the luma plane for
// potential LC=2 combine.  LC=2 combines the cached luma with the auxiliary
// chroma stream decoded by the secondary decoder.
// The pooled return value is true when the returned slice was acquired from
// bitmapBufPool; the caller must then call releaseBitmapBuf on it.
func (g *GfxHandler) decodeAVC444(data []byte, destX, destY, destW, destH int) ([]byte, []avcRect, bool) {
	// Parse the stream header once and reuse for both the raw-NAL callback and
	// the actual decode path, avoiding a redundant walk of the metadata.
	stream1, stream2, lc, parseErr := g.fillAVC444Stream(data)
	// Compute isKF once — shared between the onH264Raw forwarding path and the
	// maybeCacheStream1IDR call below, avoiding two linear scans of the NAL data.
	var isKF bool
	if parseErr == nil && stream1 != nil && len(stream1.h264Data) > 0 {
		isKF = isH264Keyframe(stream1.h264Data)
	}
	if g.onH264Raw != nil && parseErr == nil && stream1 != nil && len(stream1.h264Data) > 0 {
		nalData := make([]byte, len(stream1.h264Data))
		copy(nalData, stream1.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if g.h264dec == nil {
		return nil, nil, false
	}
	if parseErr != nil {
		slog.Warn("RDPGFX: AVC444 parse error", "err", parseErr)
		return nil, nil, false
	}
	if lc == 2 {
		return g.decodeAVC444LC2(stream2, destW, destH)
	}
	if stream1 == nil || len(stream1.h264Data) == 0 {
		return nil, nil, false
	}

	// Pass region hints so the decoder skips converting pixels outside the
	// dirty rectangles.  Safe here because decodeAVC444 also uses
	// blitAndEmitAVCRegions when shouldUseAVCRegions returns true.
	if rh, ok := g.h264dec.(RegionHinter); ok &&
		len(stream1.regions) > 0 && shouldUseAVCRegions(stream1.regions, destW, destH) {
		if cap(g.regionHintBuf) >= len(stream1.regions) {
			g.regionHintBuf = g.regionHintBuf[:len(stream1.regions)]
		} else {
			g.regionHintBuf = make([][4]uint16, len(stream1.regions))
		}
		for i, r := range stream1.regions {
			g.regionHintBuf[i] = [4]uint16{r.left, r.top, r.right, r.bottom}
		}
		rh.SetRegionHint(g.regionHintBuf)
	}

	var frame *H264Frame
	var i420out *H264FrameI420
	var err error
	isKeyFrame := isKF
	if isKeyFrame {
		// Cache IDR NAL data so the SW fallback decoder can be primed
		// immediately after a VideoToolbox stall without waiting for VBox.
		g.maybeCacheStream1IDR(stream1.h264Data)
	}
	isIDR := g.h264dec2 != nil && isKeyFrame
	if isIDR {
		// Reset per-GOP diagnostic flags so the LC=0 IDR and LC=2 combine
		// after this IDR are sampled again for colour diagnostics.
		g.lc2SampleLogged = false
		g.lc2PFrameSampleLogged = false
		g.lc0SampleLogged = false
	}
	if g.h264dec2 != nil {
		// Cache luma for future LC=2 combine.
		if i420dec, ok := g.h264dec.(I420Decoder); ok {
			frame, i420out, err = i420dec.DecodeWithI420(stream1.h264Data)
			if err != nil {
				slog.Warn("RDPGFX: H.264 decode error (AVC444)", "err", err)
				return nil, nil, false
			}
			if i420out != nil {
				g.updateAVC444YCache(i420out)
				if isIDR {
					// Snapshot the IDR luma separately.  When a standalone
					// LC=2 packet carries a stream2 IDR, the chroma data
					// belongs to this GOP's first frame, so we must combine
					// it with the IDR luma — not with a later P-frame's luma
					// that has since overwritten avc444YPlane.
					g.copyAVC444YToIDRCache()
				}
			}
		} else {
			frame, err = g.h264dec.Decode(stream1.h264Data)
		}
	} else {
		frame, err = g.h264dec.Decode(stream1.h264Data)
	}
	if err != nil {
		slog.Warn("RDPGFX: H.264 decode error (AVC444)", "err", err)
		return nil, nil, false
	}
	// Prime the aux decoder before any nil/drop checks so the stream2 IDR is
	// never lost.  On macOS, VideoToolbox returns nil frames for 1–3 s during
	// initial warm-up; without this early call the stream2 IDR carried by the
	// first LC=0 packet would be discarded (h264dec2 never created) and the
	// renegotiation timer would degrade LC=2 to LC=0-only after retrying.
	if lc == 0 && stream2 != nil && len(stream2.h264Data) > 0 {
		g.primeAuxDecoder(stream2.h264Data)
	}
	if frame == nil {
		if i420out == nil {
			g.maybeRequestKeyframe()
			g.maybeNotifyDecoderBroken()
			return nil, nil, false
		}
		// I420 fast path: HW decoder returned planar I420 instead of BGRA.
		// Convert to BGRA using BT.709 (AVC444 standard encoding) so the
		// BGRA rendering path can continue normally.
		bgra, _ := i420ToBGRA(i420out)
		if bgra == nil {
			return nil, nil, false
		}
		frame = &H264Frame{Data: bgra, Width: i420out.Width, Height: i420out.Height}
	}
	if frame.Dropped {
		slog.Debug("RDPGFX: AVC444 frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		// Touch Y cache timestamp so LC=2 can still combine with last valid luma
		// while the server delivers a recovery IDR.
		if g.avc444YPlane.w > 0 && !g.avc444YPlane.updatedAt.IsZero() {
			g.avc444YPlane.updatedAt = time.Now()
		}
		return nil, nil, false
	}
	if !g.lc0SampleLogged && isIDR {
		g.lc0SampleLogged = true
		bgraData := frame.Data
		w, h := frame.Width, frame.Height
		for _, p := range [][2]int{{960, 400}, {480, 400}, {1440, 400}, {960, 600}, {100, 100}} {
			px, py := p[0], p[1]
			if px >= w || py >= h {
				continue
			}
			off := (py*w + px) * 4
			if off+3 < len(bgraData) {
				var rawY, rawU, rawV byte
				if i420out != nil && py < i420out.Height && px < i420out.Width {
					rawY = i420out.Y[py*i420out.YStride+px]
					rawU = i420out.U[(py/2)*i420out.UStride+(px/2)]
					rawV = i420out.V[(py/2)*i420out.VStride+(px/2)]
				}
				slog.Debug("H.264: pixel sample (LC=0 IDR frame)",
					"x", px, "y", py,
					"rawY", rawY, "rawU", rawU, "rawV", rawV,
					"fullRange", i420out != nil && i420out.FullRange,
					"B", bgraData[off], "G", bgraData[off+1], "R", bgraData[off+2])
			}
		}
	}
	if slog.Default().Enabled(nil, slog.LevelDebug) {
		slog.Debug("RDPGFX: AVC444 decoded", "frameW", frame.Width, "frameH", frame.Height,
			"destW", destW, "destH", destH, "h264Len", len(stream1.h264Data))
	}
	g.noteSuccessfulDecode()
	decoded, pooled := cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)

	return decoded, stream1.regions, pooled
}

// decodeAVC420WithI420 decodes AVC420 bitmap data, returning BGRA pixels for
// the surface backing store and, when the underlying decoder supports I420
// output, an optional H264FrameI420 for GPU-accelerated IYUV texture upload.
// i420 is nil when I420 extraction is unsupported or the frame dimensions are
// smaller than destW×destH.  Callers must fall back to BGRA rendering when
// i420 is nil.
func (g *GfxHandler) decodeAVC420WithI420(data []byte, destX, destY, destW, destH int) (decoded []byte, i420 *H264FrameI420, regions []avcRect, pooled bool) {
	if err := fillAVC420Stream(data, &g.avcStream1); err != nil {
		slog.Warn("RDPGFX: AVC420 parse error", "err", err)
		return
	}
	stream := &g.avcStream1
	if g.onH264Raw != nil && len(stream.h264Data) > 0 {
		isKF := isH264Keyframe(stream.h264Data)
		nalData := make([]byte, len(stream.h264Data))
		copy(nalData, stream.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if g.h264dec == nil || len(stream.h264Data) == 0 {
		return
	}
	if isH264Keyframe(stream.h264Data) {
		g.maybeCacheStream1IDR(stream.h264Data)
	}
	var frame *H264Frame
	var err error
	i420dec, hasI420 := g.h264dec.(I420Decoder)
	if hasI420 {
		var i420out *H264FrameI420
		frame, i420out, err = i420dec.DecodeWithI420(stream.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error", "err", err)
			return
		}
		if i420out != nil && i420out.Width >= destW && i420out.Height >= destH {
			i420 = i420out
		}
	} else {
		frame, err = g.h264dec.Decode(stream.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error", "err", err)
			return
		}
	}
	// I420 fast path: frame is nil but i420 is non-nil — decoder produced output
	// via the direct NV12/YUV420P copy path.  Still counts as a successful decode.
	if frame == nil && i420 == nil {
		g.maybeRequestKeyframe()
		g.maybeNotifyDecoderBroken()
		slog.Debug("RDPGFX: H.264 decode returned nil frame (buffering?)")
		return
	}
	if frame != nil && frame.Dropped {
		slog.Debug("RDPGFX: AVC420 (WithI420) frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		return
	}
	g.noteSuccessfulDecode()
	if frame != nil {
		if slog.Default().Enabled(nil, slog.LevelDebug) {
			slog.Debug("RDPGFX: AVC420 decoded (WithI420)", "frameW", frame.Width, "frameH", frame.Height,
				"destW", destW, "destH", destH, "hasI420", i420 != nil,
				"regions", len(stream.regions), "h264Len", len(stream.h264Data))
		}
		decoded, pooled = cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)
	}
	regions = stream.regions
	return
}

// decodeAVC420WithNV12 decodes AVC420 bitmap data, returning native NV12
// planes when the underlying decoder produces NV12 (typically VideoToolbox).
// If NV12 is unavailable, decoded may contain a BGRA fallback frame.
func (g *GfxHandler) decodeAVC420WithNV12(data []byte, destX, destY, destW, destH int) (decoded []byte, nv12 *H264FrameNV12, regions []avcRect, pooled bool) {
	if err := fillAVC420Stream(data, &g.avcStream1); err != nil {
		slog.Warn("RDPGFX: AVC420 parse error", "err", err)
		return
	}
	stream := &g.avcStream1
	// Compute isKF once — shared between the onH264Raw forwarding path and the
	// maybeCacheStream1IDR call below, avoiding two linear scans of the NAL data.
	var isKF bool
	if len(stream.h264Data) > 0 {
		isKF = isH264Keyframe(stream.h264Data)
	}
	if g.onH264Raw != nil && len(stream.h264Data) > 0 {
		nalData := make([]byte, len(stream.h264Data))
		copy(nalData, stream.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if g.h264dec == nil || len(stream.h264Data) == 0 {
		return
	}
	if isKF {
		g.maybeCacheStream1IDR(stream.h264Data)
	}
	var frame *H264Frame
	var err error
	nv12dec, hasNV12 := g.h264dec.(NV12Decoder)
	if hasNV12 {
		var nv12out *H264FrameNV12
		frame, nv12out, err = nv12dec.DecodeWithNV12(stream.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error", "err", err)
			return
		}
		if nv12out != nil && nv12out.Width >= destW && nv12out.Height >= destH {
			nv12 = nv12out
		}
	} else {
		frame, err = g.h264dec.Decode(stream.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error", "err", err)
			return
		}
	}
	if frame == nil && nv12 == nil {
		g.maybeRequestKeyframe()
		g.maybeNotifyDecoderBroken()
		slog.Debug("RDPGFX: H.264 decode returned nil frame (buffering?)")
		return
	}
	if frame != nil && frame.Dropped {
		slog.Debug("RDPGFX: AVC420 (WithNV12) frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		return
	}
	g.noteSuccessfulDecode()
	if frame != nil {
		if slog.Default().Enabled(nil, slog.LevelDebug) {
			slog.Debug("RDPGFX: AVC420 decoded (WithNV12)", "frameW", frame.Width, "frameH", frame.Height,
				"destW", destW, "destH", destH, "hasNV12", nv12 != nil,
				"regions", len(stream.regions), "h264Len", len(stream.h264Data))
		}
		decoded, pooled = cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)
	}
	regions = stream.regions
	return
}

// decodeAVC444WithI420 decodes AVC444 bitmap data, returning BGRA pixels and
// an optional I420 frame.  LC=0 and LC=1 decode the main stream and cache the
// luma plane.  LC=2 decodes the auxiliary chroma stream and combines it with
// the cached luma to produce BGRA; i420 is nil for LC=2 frames (GPU path falls
// back to BGRA).
func (g *GfxHandler) decodeAVC444WithI420(data []byte, destX, destY, destW, destH int) (decoded []byte, i420 *H264FrameI420, regions []avcRect, pooled bool) {
	stream1, stream2, lc, err := g.fillAVC444Stream(data)
	// Compute isKF once — shared between the onH264Raw forwarding path and the
	// maybeCacheStream1IDR call below, avoiding two linear scans of the NAL data.
	var isKF bool
	if stream1 != nil && len(stream1.h264Data) > 0 {
		isKF = isH264Keyframe(stream1.h264Data)
	}
	if g.onH264Raw != nil && stream1 != nil && len(stream1.h264Data) > 0 {
		nalData := make([]byte, len(stream1.h264Data))
		copy(nalData, stream1.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if err != nil {
		slog.Warn("RDPGFX: AVC444 parse error", "err", err)
		return
	}
	if lc == 2 {
		decoded, regions, pooled = g.decodeAVC444LC2(stream2, destW, destH)
		return
	}
	if g.h264dec == nil || stream1 == nil || len(stream1.h264Data) == 0 {
		return
	}
	if isKF {
		g.maybeCacheStream1IDR(stream1.h264Data)
	}
	var frame *H264Frame
	i420dec, hasI420 := g.h264dec.(I420Decoder)
	if hasI420 {
		var i420out *H264FrameI420
		frame, i420out, err = i420dec.DecodeWithI420(stream1.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error (AVC444)", "err", err)
			return
		}
		if i420out != nil {
			if g.h264dec2 != nil {
				g.updateAVC444YCache(i420out)
			}
			if i420out.Width >= destW && i420out.Height >= destH {
				i420 = i420out
			}
		}
	} else {
		frame, err = g.h264dec.Decode(stream1.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error (AVC444)", "err", err)
			return
		}
	}
	// Prime the aux decoder before checking frame.Dropped: stream2 IDR data
	// must not be lost when the main frame is discarded due to zero-fill.
	if lc == 0 && stream2 != nil && len(stream2.h264Data) > 0 {
		g.primeAuxDecoder(stream2.h264Data)
	}
	// I420 fast path: frame is nil but i420 is non-nil — decoder produced output
	// via the direct NV12/YUV420P copy path.  Still counts as a successful decode.
	if frame == nil && i420 == nil {
		g.maybeRequestKeyframe()
		g.maybeNotifyDecoderBroken()
		return
	}
	if frame != nil && frame.Dropped {
		slog.Debug("RDPGFX: AVC444 (WithI420) frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		if g.avc444YPlane.w > 0 && !g.avc444YPlane.updatedAt.IsZero() {
			g.avc444YPlane.updatedAt = time.Now()
		}
		return
	}
	g.noteSuccessfulDecode()
	if frame != nil {
		if slog.Default().Enabled(nil, slog.LevelDebug) {
			slog.Debug("RDPGFX: AVC444 decoded (WithI420)", "frameW", frame.Width, "frameH", frame.Height,
				"destW", destW, "destH", destH, "hasI420", i420 != nil, "h264Len", len(stream1.h264Data))
		}
		decoded, pooled = cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)
		regions = stream1.regions
	}

	return
}

// decodeAVC444WithNV12 decodes AVC444 bitmap data, returning native NV12 planes
// for LC=0/LC=1 frames and BGRA for LC=2 chroma-combination frames.
// nv12 is non-nil only when the hardware decoder (VideoToolbox) produced NV12
// output for a LC=0/LC=1 stream1 packet.  LC=2 frames always return decoded
// BGRA with nv12==nil because the chroma supplement requires a CPU combine step.
func (g *GfxHandler) decodeAVC444WithNV12(data []byte, destX, destY, destW, destH int) (decoded []byte, nv12 *H264FrameNV12, regions []avcRect, pooled bool) {
	stream1, stream2, lc, err := g.fillAVC444Stream(data)
	var isKF bool
	if stream1 != nil && len(stream1.h264Data) > 0 {
		isKF = isH264Keyframe(stream1.h264Data)
	}
	if g.onH264Raw != nil && stream1 != nil && len(stream1.h264Data) > 0 {
		nalData := make([]byte, len(stream1.h264Data))
		copy(nalData, stream1.h264Data)
		g.onH264Raw(destX, destY, destW, destH, isKF, nalData)
	}
	if err != nil {
		slog.Warn("RDPGFX: AVC444 parse error", "err", err)
		return
	}
	if lc == 2 {
		decoded, regions, pooled = g.decodeAVC444LC2(stream2, destW, destH)
		return
	}
	if g.h264dec == nil || stream1 == nil || len(stream1.h264Data) == 0 {
		return
	}
	if isKF {
		g.maybeCacheStream1IDR(stream1.h264Data)
	}
	isIDR := g.h264dec2 != nil && isKF
	if isIDR {
		g.lc2SampleLogged = false
		g.lc2PFrameSampleLogged = false
		g.lc0SampleLogged = false
	}
	var frame *H264Frame
	nv12dec, hasNV12 := g.h264dec.(NV12Decoder)
	if hasNV12 {
		var nv12out *H264FrameNV12
		frame, nv12out, err = nv12dec.DecodeWithNV12(stream1.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error (AVC444 WithNV12)", "err", err)
			return
		}
		if nv12out != nil && nv12out.Width >= destW && nv12out.Height >= destH {
			nv12 = nv12out
			if g.h264dec2 != nil {
				g.updateAVC444YCacheFromNV12(nv12out)
				if isIDR {
					g.copyAVC444YToIDRCache()
				}
			}
		}
	} else {
		frame, err = g.h264dec.Decode(stream1.h264Data)
		if err != nil {
			slog.Warn("RDPGFX: H.264 decode error (AVC444 WithNV12 fallback)", "err", err)
			return
		}
	}
	// When the NV12 decoder returned a BGRA frame but no NV12 planes (e.g. the
	// software decoder produced YUV420P instead of NV12), recover I420 from the
	// decoder's side channel for Y cache update so LC=2 frames are not stalled.
	if hasNV12 && nv12 == nil && frame != nil && g.h264dec2 != nil {
		type i420LastDecoder interface {
			LastI420() *H264FrameI420
		}
		if p, ok := g.h264dec.(i420LastDecoder); ok {
			if i420out := p.LastI420(); i420out != nil {
				g.updateAVC444YCache(i420out)
				if isIDR {
					g.copyAVC444YToIDRCache()
				}
			}
		}
	}
	// Prime aux decoder before nil/dropped checks so stream2 IDR data is never lost.
	if lc == 0 && stream2 != nil && len(stream2.h264Data) > 0 {
		g.primeAuxDecoder(stream2.h264Data)
	}
	if frame == nil && nv12 == nil {
		g.maybeRequestKeyframe()
		g.maybeNotifyDecoderBroken()
		slog.Debug("RDPGFX: H.264 decode returned nil frame/nv12 (buffering?)")
		return
	}
	if frame != nil && frame.Dropped {
		slog.Debug("RDPGFX: AVC444 (WithNV12) frame intentionally dropped (zero-fill)")
		g.trackSWFallbackDroppedFrame()
		g.maybeRequestKeyframe()
		if g.avc444YPlane.w > 0 && !g.avc444YPlane.updatedAt.IsZero() {
			g.avc444YPlane.updatedAt = time.Now()
		}
		return
	}
	g.noteSuccessfulDecode()
	if frame != nil {
		if slog.Default().Enabled(nil, slog.LevelDebug) {
			slog.Debug("RDPGFX: AVC444 decoded (WithNV12)", "frameW", frame.Width, "frameH", frame.Height,
				"destW", destW, "destH", destH, "hasNV12", nv12 != nil, "h264Len", len(stream1.h264Data))
		}
		decoded, pooled = cropBGRA(frame.Data, frame.Width, frame.Height, destW, destH)
	}
	regions = stream1.regions
	return
}

// updateAVC444YCache copies the Y, U, and V planes from stream1's i420 into
// g.avc444YPlane for use when combining with an LC=2 auxiliary chroma frame.
// The U/V planes are stored half-res (stride = (w+1)/2) and provide the B2/B3
// chroma values (even column, even row positions) that stream2 does not cover.
func (g *GfxHandler) updateAVC444YCache(i420 *H264FrameI420) {
	w, h := i420.Width, i420.Height
	uvStride := (w + 1) / 2
	uvH := (h + 1) / 2
	neededY := w * h
	neededUV := uvStride * uvH
	if cap(g.avc444YPlane.data) < neededY {
		g.avc444YPlane.data = make([]byte, neededY)
	} else {
		g.avc444YPlane.data = g.avc444YPlane.data[:neededY]
	}
	if cap(g.avc444YPlane.u) < neededUV {
		g.avc444YPlane.u = make([]byte, neededUV)
	} else {
		g.avc444YPlane.u = g.avc444YPlane.u[:neededUV]
	}
	if cap(g.avc444YPlane.v) < neededUV {
		g.avc444YPlane.v = make([]byte, neededUV)
	} else {
		g.avc444YPlane.v = g.avc444YPlane.v[:neededUV]
	}
	// i420 planes are already tight-packed (strides == width/height from extractI420fromSrc).
	// Run Y, U, V copies in parallel for large frames: each slice is an independent
	// allocation so there is no aliasing between the goroutines' writes.
	totalBytes := neededY + neededUV*2
	if totalBytes >= parallelConvertMinPixels*4 {
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); copy(g.avc444YPlane.data, i420.Y) }()
		go func() { defer wg.Done(); copy(g.avc444YPlane.u, i420.U) }()
		go func() { defer wg.Done(); copy(g.avc444YPlane.v, i420.V) }()
		wg.Wait()
	} else {
		copy(g.avc444YPlane.data, i420.Y)
		copy(g.avc444YPlane.u, i420.U)
		copy(g.avc444YPlane.v, i420.V)
	}
	g.avc444YPlane.stride = w
	g.avc444YPlane.uvStride = uvStride
	g.avc444YPlane.w = w
	g.avc444YPlane.h = h
	g.avc444YPlane.fullRange = i420.FullRange
	g.avc444YPlane.updatedAt = time.Now()
	// HW decoder is producing real frames again — clear any stall throttle so
	// the server resumes its normal quality/bitrate.
	g.SetQueueDepthHint(0)
}

// updateAVC444YCacheFromNV12 updates the AVC444 Y/UV cache from a native NV12
// frame produced by the hardware decoder (VideoToolbox on macOS).  The NV12
// interleaved UV plane is de-interleaved into separate U/V planes so that the
// cache layout matches what combineAVC444v2BGRA expects.
//
// fullRange is forced to false regardless of nv12.FullRange.  VideoToolbox
// expands the H.264 limited-range chroma to full range when it outputs
// kCVPixelFormatType_420YpCbCr8BiPlanarFullRange, but the SDL2 Metal renderer
// applies limited-range BT.709 coefficients to the NV12 texture (SDL2 auto-
// selects BT.709 for HD resolutions).  The LC=2 auxiliary-chroma stream is
// decoded by the SW decoder and keeps limited-range values.  By always using
// fullRange=false here, combineAVC444v2BGRA applies the same limited-range
// BT.709 formula that SDL2 uses for the NV12 texture, eliminating the colour
// shift that was visible when the display alternated between LC=0 NV12 frames
// (SDL2 limited BT.709) and LC=2 BGRA overlay frames (previously BT.709 full-
// range).
func (g *GfxHandler) updateAVC444YCacheFromNV12(nv12 *H264FrameNV12) {
	w, h := nv12.Width, nv12.Height
	uvStride := (w + 1) / 2
	uvH := (h + 1) / 2
	neededY := w * h
	neededUV := uvStride * uvH
	if cap(g.avc444YPlane.data) < neededY {
		g.avc444YPlane.data = make([]byte, neededY)
	} else {
		g.avc444YPlane.data = g.avc444YPlane.data[:neededY]
	}
	if cap(g.avc444YPlane.u) < neededUV {
		g.avc444YPlane.u = make([]byte, neededUV)
	} else {
		g.avc444YPlane.u = g.avc444YPlane.u[:neededUV]
	}
	if cap(g.avc444YPlane.v) < neededUV {
		g.avc444YPlane.v = make([]byte, neededUV)
	} else {
		g.avc444YPlane.v = g.avc444YPlane.v[:neededUV]
	}
	// Copy Y rows, respecting the source stride.
	srcYStride := nv12.YStride
	if srcYStride <= 0 {
		srcYStride = w
	}
	for row := range h {
		copy(g.avc444YPlane.data[row*w:row*w+w], nv12.Y[row*srcYStride:row*srcYStride+w])
	}
	// De-interleave NV12 UV (interleaved UVUVUV…) into separate U/V planes.
	srcUVStride := nv12.UVStride
	if srcUVStride <= 0 {
		srcUVStride = w
	}
	for row := range uvH {
		srcRow := nv12.UV[row*srcUVStride : row*srcUVStride+w]
		dstU := g.avc444YPlane.u[row*uvStride : row*uvStride+uvStride]
		dstV := g.avc444YPlane.v[row*uvStride : row*uvStride+uvStride]
		for col := range uvStride {
			dstU[col] = srcRow[col*2]
			dstV[col] = srcRow[col*2+1]
		}
	}
	g.avc444YPlane.stride = w
	g.avc444YPlane.uvStride = uvStride
	g.avc444YPlane.w = w
	g.avc444YPlane.h = h
	// Force limited-range so combineAVC444v2BGRA uses the same BT.709 limited-
	// range coefficients as the SDL2 Metal renderer (see comment above).
	g.avc444YPlane.fullRange = false
	g.avc444YPlane.updatedAt = time.Now()
	g.SetQueueDepthHint(0)
}

// copyAVC444YToIDRCache copies the current avc444YPlane content into
// avc444IDRYPlane.  Called immediately after updating avc444YPlane from a
// stream1 IDR decode, so the IDR luma snapshot stays separate from any
// subsequent P-frame luma updates.
func (g *GfxHandler) copyAVC444YToIDRCache() {
	src := &g.avc444YPlane
	dst := &g.avc444IDRYPlane
	if cap(dst.data) < len(src.data) {
		dst.data = make([]byte, len(src.data))
	} else {
		dst.data = dst.data[:len(src.data)]
	}
	if cap(dst.u) < len(src.u) {
		dst.u = make([]byte, len(src.u))
	} else {
		dst.u = dst.u[:len(src.u)]
	}
	if cap(dst.v) < len(src.v) {
		dst.v = make([]byte, len(src.v))
	} else {
		dst.v = dst.v[:len(src.v)]
	}
	// Parallel copy for large frames: each slice is a separate allocation.
	totalBytes := len(src.data) + len(src.u) + len(src.v)
	if totalBytes >= parallelConvertMinPixels*4 {
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); copy(dst.data, src.data) }()
		go func() { defer wg.Done(); copy(dst.u, src.u) }()
		go func() { defer wg.Done(); copy(dst.v, src.v) }()
		wg.Wait()
	} else {
		copy(dst.data, src.data)
		copy(dst.u, src.u)
		copy(dst.v, src.v)
	}
	dst.stride = src.stride
	dst.uvStride = src.uvStride
	dst.w = src.w
	dst.h = src.h
	dst.fullRange = src.fullRange
	dst.updatedAt = src.updatedAt
}

// maybeCacheStream1IDR stores h264Data as the latest stream1 IDR NAL data for
// later use when priming the SW fallback decoder after a VideoToolbox stall.
// The data is copied so the caller's buffer may be reused freely.
// Only call when isH264Keyframe(h264Data) is true.
func (g *GfxHandler) maybeCacheStream1IDR(h264Data []byte) {
	g.lastStream1IDR = append(g.lastStream1IDR[:0], h264Data...)
	g.lastStream1IDRTime = time.Now()
	g.lastStream1IDRFrame = g.framesDecoded.Load()
	if g.usingSWFallback {
		// A natural IDR from the server arrived while in SW fallback mode.
		// From this frame onwards the SW decoder has a fresh reference point and
		// error concealment (block noise) should stop.  This is the genuine
		// resync point after a stale-IDR prime, so disarm the stale-prime
		// corruption tracking: the primed frames were only suspect until a real
		// IDR healed the picture.
		g.swFallbackPrimed = false
		g.swFallbackDroppedCount = 0
		slog.Debug("H.264: natural IDR received during SW fallback — block noise should stop",
			"idrLen", len(h264Data),
			"framesDecoded", g.lastStream1IDRFrame)
	} else {
		slog.Debug("H.264: stream1 IDR cached for SW fallback priming",
			"idrLen", len(h264Data),
			"framesDecoded", g.lastStream1IDRFrame)
	}
}

// isPlaneRegionBlank samples a 3×3 grid inside a rectangular region of a
// single plane and returns true when a majority of the samples are either
// near-zero (< loThreshold) or near-saturated (>= hiThreshold).  It is used
// to detect the uninitialised/corrupt chroma states that produce green or
// pink overlays in AVC444v2 reconstruction.
func isPlaneRegionBlank(data []byte, stride, x0, y0, w, h int) bool {
	if len(data) == 0 || w <= 0 || h <= 0 {
		return false
	}
	const (
		loThreshold = 72  // below this: abnormally low (green monochrome)
		hiThreshold = 235 // at or above this: near-saturation (pink overlay)
	)
	nearZero, nearSat, total := 0, 0, 0
	for i := range 3 {
		row := y0 + (i+1)*h/4
		if row < y0 || row >= y0+h {
			continue
		}
		for j := range 3 {
			col := x0 + (j+1)*w/4
			if col < x0 || col >= x0+w {
				continue
			}
			total++
			v := data[row*stride+col]
			if v < loThreshold {
				nearZero++
			} else if v >= hiThreshold {
				nearSat++
			}
		}
	}
	if total == 0 {
		return false
	}
	return nearZero*2 > total || nearSat*2 > total
}

// isAuxChromaBlank returns true when any of the chroma-carrying planes in the
// stream2 auxiliary frame looks uninitialised or corrupt.  In AVC444v2 the Y
// plane carries Cb (left half) and Cr (right half) for odd columns, while the
// U and V planes carry the remaining chroma positions for even columns on odd
// rows.  Near-zero values in any of these planes produce a bright green frame;
// near-saturated values produce a pink/magenta overlay.  Detecting this early
// lets decodeAVC444LC2 skip the combine and wait for real data.
//
// Two failure modes are detected:
//   - Near-zero (< 20): codec not yet initialised; Windows Server initialises
//     stream2 IDR with Cb≈0, Cr≈0 and sometimes emits sparse artefact pixels
//     (Cb≈9–12) that a threshold of 8 would pass.  Raising to 20 keeps those
//     from triggering a combine that produces bright green blocks.
//   - Near-saturation (≥ 235): indicates DPB mismatch or corruption in the aux
//     decoder (h264dec2); a P-frame decoded against the wrong reference can
//     produce near-maximal values, which encode Cb≈255/Cr≈255 and result in a
//     pink/magenta overlay when combined with any luma.
func isAuxChromaBlank(f *H264FrameI420) bool {
	if f == nil || f.Width < 16 || f.Height < 4 || len(f.Y) == 0 || len(f.U) == 0 || len(f.V) == 0 {
		return false
	}
	w, h := f.Width, f.Height
	halfW := w / 2
	uvW := halfW / 2
	uvH := (h + 1) / 2
	// Y plane left half: Cb for odd columns.
	if isPlaneRegionBlank(f.Y, f.YStride, 0, 0, halfW, h) {
		return true
	}
	// Y plane right half: Cr for odd columns.
	if isPlaneRegionBlank(f.Y, f.YStride, halfW, 0, halfW, h) {
		return true
	}
	// U plane: Cb/Cr for even columns on odd rows.
	if isPlaneRegionBlank(f.U, f.UStride, 0, 0, uvW, uvH) {
		return true
	}
	// V plane: Cb/Cr for even columns on odd rows.
	if isPlaneRegionBlank(f.V, f.VStride, 0, 0, uvW, uvH) {
		return true
	}
	return false
}

// isAVC444YPlaneChromaBlank returns true when the cached stream1 chroma (U/V)
// looks corrupt.  Green monochrome requires both Cb and Cr to collapse to
// near-zero, so the grid check requires both U and V at a sample point to be
// low.  Near-saturation in both planes produces a pink/magenta overlay.
//
// The threshold (72) matches the low-chroma guard in the ffmpeg decoder plugin
// so a frame that poisoned the cache would also have been dropped there.
func isAVC444YPlaneChromaBlank(yp *avc444YPlane) bool {
	if yp == nil || yp.w < 16 || yp.h < 4 || len(yp.u) == 0 || len(yp.v) == 0 {
		return false
	}
	uvH := (yp.h + 1) / 2
	const (
		loThreshold = 72  // below this: near-zero (green monochrome)
		hiThreshold = 235 // at or above this: near-saturation (pink overlay)
	)
	nearZero, nearSat, total := 0, 0, 0
	for i := range 3 {
		row := (i + 1) * uvH / 4
		if row >= uvH {
			continue
		}
		for j := range 3 {
			col := (j + 1) * yp.uvStride / 4
			if col >= yp.uvStride {
				continue
			}
			total++
			u := yp.u[row*yp.uvStride+col]
			v := yp.v[row*yp.uvStride+col]
			if u < loThreshold && v < loThreshold {
				nearZero++
			} else if u >= hiThreshold && v >= hiThreshold {
				nearSat++
			}
		}
	}
	if total == 0 {
		return false
	}
	return nearZero*2 > total || nearSat*2 > total
}

// combineAVC444v2BGRA implements the AVC444v2 chroma reconstruction defined in
// [MS-RDPEGFX 3.3.8.3.3] ("YUV420p Stream Combination for YUV444v2 mode").
//
// Stream2 encodes the missing chroma positions that stream1's 4:2:0 quantiser
// discards, split across three "Bx areas" of the auxiliary I420 frame:
//
//	B4/B5 — stream2 Y plane, each row:
//	  bytes [0,   w/2)  = Cb at all odd-x columns  (U444[2k+1, y]  for k=0..w/2-1)
//	  bytes [w/2, w)    = Cr at all odd-x columns  (V444[2k+1, y]  for k=0..w/2-1)
//
//	B6/B7 — stream2 U plane, each half-height row j:
//	  bytes [0,    w/4) = Cb at even-x multiples of 4  (U444[4k,   2j+1])
//	  bytes [w/4,  w/2) = Cr at even-x multiples of 4  (V444[4k,   2j+1])
//
//	B8/B9 — stream2 V plane, each half-height row j:
//	  bytes [0,    w/4) = Cb at even-x offset-2 cols   (U444[4k+2, 2j+1])
//	  bytes [w/4,  w/2) = Cr at even-x offset-2 cols   (V444[4k+2, 2j+1])
//
// Positions not covered by stream2 (even-x, even-y) use stream1's half-res
// B2/B3 chroma values from the cached cachedU/cachedV planes.
//
// Parameters:
//
//	yPlane/yStride       – luma Y from stream1, tight-packed (stride=w)
//	cachedU/cachedV      – Cb/Cr from stream1, half-res (stride=uvStride=(w+1)/2)
//	i420aux              – I420 output from decoding stream2
//	fullRange            – true for PC-range [0-255], false for video [16-235]
// maxConvertWorkers caps the number of goroutines used to parallelise the
// per-row YCbCr→BGRA conversions.  Beyond ~8 workers the conversion is limited
// by memory bandwidth rather than CPU, so additional workers only add
// scheduling overhead without speeding up the conversion.
const maxConvertWorkers = 8

// parallelConvertMinPixels is the frame-area threshold below which conversion
// runs serially: for small frames the goroutine spawn/join overhead exceeds the
// work saved by splitting the rows across cores.
const parallelConvertMinPixels = 256 * 256

// parallelRows splits the row range [0,h) into up to maxConvertWorkers
// contiguous chunks and runs fn(y0,y1) for each chunk concurrently, returning
// only once every chunk has finished.  Each chunk writes a disjoint set of
// output rows and reads the shared input planes read-only, so the chunks are
// data-race free and the combined result is identical to a serial run.
//
// For small frames (area < parallelConvertMinPixels) fn is invoked once over
// the full range on the calling goroutine, avoiding goroutine overhead.
func parallelRows(w, h int, fn func(y0, y1 int)) {
	workers := runtime.GOMAXPROCS(0)
	if workers > maxConvertWorkers {
		workers = maxConvertWorkers
	}
	if workers <= 1 || h < 2 || w*h < parallelConvertMinPixels {
		fn(0, h)
		return
	}
	if workers > h {
		workers = h
	}
	chunk := (h + workers - 1) / workers
	var wg sync.WaitGroup
	for y0 := 0; y0 < h; y0 += chunk {
		y1 := y0 + chunk
		if y1 > h {
			y1 = h
		}
		wg.Add(1)
		go func(a, b int) {
			defer wg.Done()
			fn(a, b)
		}(y0, y1)
	}
	wg.Wait()
}

// combineAVC444v2BGRA combines luma from stream1 with per-pixel chroma from
// stream1 and stream2 to produce a BGRA frame.  The fullRange branch is hoisted
// outside the inner loop; row-level offsets are computed once per row.  The row
// range is split across cores via parallelRows for large frames.
//
// When dirtyRegions is non-nil, only rows covered by at least one region are
// converted; all other rows in the output buffer are left as pool garbage.
// Callers must only pass non-nil dirtyRegions when shouldUseAVCRegions is true,
// because in that case blitAndEmitAVCRegions reads only within the dirty rects
// and never accesses the uninitialised rows.
func combineAVC444v2BGRA(
	yPlane []byte, yStride int,
	cachedU, cachedV []byte, uvStride int,
	i420aux *H264FrameI420,
	fullRange bool,
	w, h int,
	dirtyRegions []avcRect,
) (out []byte, pooled bool) {
	if len(yPlane) == 0 || len(cachedU) == 0 || len(cachedV) == 0 || w <= 0 || h <= 0 {
		return nil, false
	}
	if i420aux == nil || len(i420aux.Y) == 0 || len(i420aux.U) == 0 || len(i420aux.V) == 0 {
		return nil, false
	}
	out = acquireBitmapBuf(w * h * 4)
	halfW := w / 2
	quarterW := w / 4
	auxYStride := i420aux.YStride
	auxUStride := i420aux.UStride
	auxVStride := i420aux.VStride

	// Build per-row dirty mask when only partial conversion is needed.  Rows not
	// covered by any dirty region are skipped inside rowFn; the corresponding
	// output bytes remain as pool-buffer data that blitAndEmitAVCRegions never
	// reads (it only accesses pixels within the dirty rectangles).
	var rowDirty []bool
	if len(dirtyRegions) > 0 {
		rowDirty = make([]bool, h)
		for _, r := range dirtyRegions {
			r0 := max(0, int(r.top))
			r1 := min(h, int(r.bottom))
			for y := r0; y < r1; y++ {
				rowDirty[y] = true
			}
		}
	}

	// Split on fullRange once so the inner loop body is branch-free for the
	// YCbCr→BGRA conversion coefficients.  Each output row is independent, so
	// parallelRows splits the rows across cores for large frames.
	var rowFn func(y0, y1 int)
	if fullRange {
		rowFn = func(y0, y1 int) {
			for row := y0; row < y1; row++ {
				if rowDirty != nil && !rowDirty[row] {
					continue
				}
				yRowOff := row * yStride
				uvRow := row >> 1
				uvRowOff := uvRow * uvStride
				auxYRowOff := row * auxYStride
				auxURowOff := uvRow * auxUStride
				auxVRowOff := uvRow * auxVStride
				outIdx := row * w * 4
				for col := range w {
					Y := yPlane[yRowOff+col]
					var Cb, Cr byte
					if col&1 == 1 {
						k := col >> 1
						Cb = i420aux.Y[auxYRowOff+k]
						Cr = i420aux.Y[auxYRowOff+halfW+k]
					} else if row&1 == 0 {
						k := col >> 1
						Cb = cachedU[uvRowOff+k]
						Cr = cachedV[uvRowOff+k]
					} else {
						k := col >> 2
						if col&2 == 0 {
							Cb = i420aux.U[auxURowOff+k]
							Cr = i420aux.U[auxURowOff+quarterW+k]
						} else {
							Cb = i420aux.V[auxVRowOff+k]
							Cr = i420aux.V[auxVRowOff+quarterW+k]
						}
					}
					y := int(Y)
					u := int(Cb) - 128
					v := int(Cr) - 128
					out[outIdx] = clampByte((256*y + 475*u + 128) >> 8)
					out[outIdx+1] = clampByte((256*y - 48*u - 120*v + 128) >> 8)
					out[outIdx+2] = clampByte((256*y + 403*v + 128) >> 8)
					out[outIdx+3] = 255
					outIdx += 4
				}
			}
		}
	} else {
		rowFn = func(y0, y1 int) {
			for row := y0; row < y1; row++ {
				if rowDirty != nil && !rowDirty[row] {
					continue
				}
				yRowOff := row * yStride
				uvRow := row >> 1
				uvRowOff := uvRow * uvStride
				auxYRowOff := row * auxYStride
				auxURowOff := uvRow * auxUStride
				auxVRowOff := uvRow * auxVStride
				outIdx := row * w * 4
				for col := range w {
					Y := yPlane[yRowOff+col]
					var Cb, Cr byte
					if col&1 == 1 {
						k := col >> 1
						Cb = i420aux.Y[auxYRowOff+k]
						Cr = i420aux.Y[auxYRowOff+halfW+k]
					} else if row&1 == 0 {
						k := col >> 1
						Cb = cachedU[uvRowOff+k]
						Cr = cachedV[uvRowOff+k]
					} else {
						k := col >> 2
						if col&2 == 0 {
							Cb = i420aux.U[auxURowOff+k]
							Cr = i420aux.U[auxURowOff+quarterW+k]
						} else {
							Cb = i420aux.V[auxVRowOff+k]
							Cr = i420aux.V[auxVRowOff+quarterW+k]
						}
					}
					c := int(Y) - 16
					u := int(Cb) - 128
					v := int(Cr) - 128
					out[outIdx] = clampByte((298*c + 541*u + 128) >> 8)
					out[outIdx+1] = clampByte((298*c - 55*u - 136*v + 128) >> 8)
					out[outIdx+2] = clampByte((298*c + 459*v + 128) >> 8)
					out[outIdx+3] = 255
					outIdx += 4
				}
			}
		}
	}
	parallelRows(w, h, rowFn)
	return out, true
}

// i420ToBGRA converts a planar I420 frame to a packed BGRA buffer using BT.709
// coefficients (matching AVC444 content encoding). Used when the I420 fast path
// is active and a BGRA output is required by the rendering path.
//
// Optimised: the fullRange branch is hoisted outside both loops so the inner
// loop body is branch-free, row offsets are computed once per row, and outIdx
// advances by 4 instead of recomputing col*4 per pixel.
func i420ToBGRA(src *H264FrameI420) ([]byte, bool) {
	if src == nil || src.Width <= 0 || src.Height <= 0 {
		return nil, false
	}
	w, h := src.Width, src.Height
	out := acquireBitmapBuf(w * h * 4)
	var rowFn func(y0, y1 int)
	if src.FullRange {
		rowFn = func(yStart, yEnd int) {
			for row := yStart; row < yEnd; row++ {
				yOff := row * src.YStride
				uvOff := (row >> 1) * src.UStride
				uvOffV := (row >> 1) * src.VStride
				outIdx := row * w * 4
				for col := range w {
					y := int(src.Y[yOff+col])
					uv := col >> 1
					u := int(src.U[uvOff+uv]) - 128
					v := int(src.V[uvOffV+uv]) - 128
					out[outIdx] = clampByte((256*y + 475*u + 128) >> 8)
					out[outIdx+1] = clampByte((256*y - 48*u - 120*v + 128) >> 8)
					out[outIdx+2] = clampByte((256*y + 403*v + 128) >> 8)
					out[outIdx+3] = 255
					outIdx += 4
				}
			}
		}
	} else {
		rowFn = func(yStart, yEnd int) {
			for row := yStart; row < yEnd; row++ {
				yOff := row * src.YStride
				uvOffU := (row >> 1) * src.UStride
				uvOffV := (row >> 1) * src.VStride
				outIdx := row * w * 4
				for col := range w {
					c := int(src.Y[yOff+col]) - 16
					uv := col >> 1
					u := int(src.U[uvOffU+uv]) - 128
					v := int(src.V[uvOffV+uv]) - 128
					out[outIdx] = clampByte((298*c + 541*u + 128) >> 8)
					out[outIdx+1] = clampByte((298*c - 55*u - 136*v + 128) >> 8)
					out[outIdx+2] = clampByte((298*c + 459*v + 128) >> 8)
					out[outIdx+3] = 255
					outIdx += 4
				}
			}
		}
	}
	parallelRows(w, h, rowFn)
	return out, true
}

// avc444bt709BGRA converts one YCbCr pixel to BGRA using BT.709 coefficients,
// matching FreeRDP's general_YUV444ToBGRX implementation.
// Windows AVC444v2 content is encoded in BT.709; using BT.601 here was the
// cause of red color bleeding on LC=2 chroma-upgrade frames.
// Cb and Cr are raw (0-255); the function subtracts 128 internally.
//
// Full range  (Y∈[0,255]):   R = Y + 1.5748*(Cr-128)   ≈ (256y + 403v) >> 8
// Limited range (Y∈[16,235]): R = 1.164*(Y-16) + 1.793*(Cr-128) ≈ (298c + 459v) >> 8
func avc444bt709BGRA(Y, Cb, Cr byte, fullRange bool, dst []byte) {
	u := int(Cb) - 128
	v := int(Cr) - 128
	var r, g, b int
	if fullRange {
		y := int(Y)
		r = (256*y + 403*v + 128) >> 8
		g = (256*y - 48*u - 120*v + 128) >> 8
		b = (256*y + 475*u + 128) >> 8
	} else {
		c := int(Y) - 16
		r = (298*c + 459*v + 128) >> 8
		g = (298*c - 55*u - 136*v + 128) >> 8
		b = (298*c + 541*u + 128) >> 8
	}
	dst[0] = clampByte(b)
	dst[1] = clampByte(g)
	dst[2] = clampByte(r)
	dst[3] = 255
}

// clampByte clamps an integer to [0, 255] using branchless min/max built-ins.
func clampByte(v int) byte {
	return byte(max(0, min(255, v)))
}

// primeAuxDecoder feeds stream2 data from an LC=0 packet to h264dec2 so that
// the decoder's decoded-picture buffer (DPB) stays in sync with the full
// stream2 H.264 sequence.  Stream2 frames are always part of one continuous
// H.264 sequence: the IDR is carried in LC=0 (and duplicated in a standalone
// LC=2 packet), and subsequent P-frames arrive via BOTH LC=0 packets and
// standalone LC=2 packets.  If primeAuxDecoder only decoded IDRs, h264dec2's
// DPB would be stuck at the IDR while the server advanced the sequence through
// several LC=0 P-frames; the first standalone LC=2 P-frame would then be
// decoded against the wrong reference, producing all-zero chroma (Cb=0,
// Cr=0) and a full-screen green tint.  By decoding ALL stream2 frames here
// (output discarded), h264dec2's DPB is always at the correct reference when
// primeH264dec2KeepDPB feeds stream2 data to h264dec2 and discards the
// output.  Call this whenever decodeAVC444LC2 must skip the combine step
// (Y cache empty or stale) so that h264dec2's decoded-picture buffer stays
// in sync with the stream2 H.264 sequence.  Without this, the next
// standalone LC=2 P-frame would reference a DPB state that is behind
// the expected position, causing FFmpeg to produce all-zero chroma
// (Cb=0, Cr=0) and a full-screen green tint.
func (g *GfxHandler) primeH264dec2KeepDPB(h264Data []byte) {
	if g.h264dec2 == nil {
		return
	}
	i420dec, ok := g.h264dec2.(I420Decoder)
	if !ok {
		return
	}
	_, _, err := i420dec.DecodeWithI420(h264Data)
	if err != nil {
		slog.Debug("RDPGFX: LC=2 DPB prime error", "err", err)
	}
	if g.h264dec2 != nil && g.h264dec2.IsBroken() {
		g.h264dec2.Close()
		g.h264dec2 = nil
		g.startAuxDecoderBrokenTimer()
	}
}

// decodeAVC444LC2 decodes a standalone LC=2 P-frame.
func (g *GfxHandler) primeAuxDecoder(h264Data []byte) {
	// Mark that stream2 data has appeared in an LC=0 packet.  VirtualBox VRDE
	// never includes stream2, so this flag distinguishes VirtualBox from Windows.
	g.stream2EverSeen = true
	isIDR := h264PacketHasIDR(h264Data)
	if g.h264dec2 == nil {
		if !isIDR {
			// No aux decoder yet; wait for the stream2 IDR to create one.
			return
		}
		// A stream2 IDR arrived — clear any permanent-degrade state so LC=2
		// can recover (e.g. after a server-side GOP reset much later in the session).
		if g.lc2PermanentlyDegraded {
			slog.Debug("H.264: stream2 IDR received after LC=2 degrade — recovering aux decoder")
			g.lc2PermanentlyDegraded = false
			g.auxDecoderNoIDRRetries = 0
		}
		// Recreate aux decoder on a stream2 IDR so it starts with a clean
		// reference frame.  This avoids the rapid create/destroy cycle that
		// can destabilise the decoder.
		slog.Debug("H.264: recreating aux decoder on stream2 IDR")
		g.h264dec2 = newH264DecoderSW()
		g.stopAuxDecoderBrokenTimer() // LC=0 IDR arrived; cancel recovery timer
		// Fall through to prime the freshly-created decoder with this IDR.
	}
	// If the aux decoder is broken, reset it only on an IDR (P-frames cannot
	// start a new decode sequence).
	if g.h264dec2.IsBroken() {
		if !isIDR {
			return
		}
		// Stream2 IDR received while aux decoder is broken — recreate it now
		// and fall through to prime the fresh decoder with this IDR.
		// (Previously this closed and waited for a *second* IDR which often
		// never arrived, permanently losing LC=2 quality for the session.)
		slog.Debug("H.264: recreating broken aux decoder on stream2 IDR")
		g.h264dec2.Close()
		g.h264dec2 = newH264DecoderSW()
		g.stopAuxDecoderBrokenTimer()
	}
	i420dec, ok := g.h264dec2.(I420Decoder)
	if !ok {
		return
	}
	_, i420primed, err := i420dec.DecodeWithI420(h264Data)
	if err != nil {
		slog.Debug("RDPGFX: AVC444 aux prime error", "err", err)
	}
	// The pre-flight stall detector inside DecodeWithI420 can set broken=true
	// and return nil,nil without an error (broken state invisible to caller).
	// Check IsBroken() after the call to catch this case.
	if g.h264dec2.IsBroken() {
		slog.Debug("H.264: aux decoder broken after prime, waiting for IDR to recreate")
		g.h264dec2.Close()
		g.h264dec2 = nil
		g.startAuxDecoderBrokenTimer()
		return
	}
	// For P-frames, validate the decoded output.  If the primed output looks
	// blank (near-zero or near-saturated chroma), the DPB is likely corrupted
	// (e.g. due to a dropped LC=0 PDU that left h264dec2 out of sync).
	// Reset h264dec2 immediately so the DPB corruption does not cascade into
	// the subsequent LC=2 standalone decode.  The IDR case is excluded because
	// near-zero output is expected during codec initialisation.
	if !isIDR && i420primed != nil && isAuxChromaBlank(i420primed) {
		slog.Debug("H.264: aux decoder DPB desynced during priming (P-frame blank chroma), resetting")
		g.h264dec2.Close()
		g.h264dec2 = nil
		g.startAuxDecoderBrokenTimer()
	}
}

// decodeAVC444LC2 decodes an AVC444 LC=2 chroma-upgrade frame.
// It decodes stream2 via the auxiliary decoder, then combines the cached luma
// (Y plane) with the auxiliary chroma (Y2 = U/Cb channel, U2 = V/Cr channel)
// to produce a BGRA frame.
func (g *GfxHandler) decodeAVC444LC2(stream2 *avc420Stream, destW, destH int) (decoded []byte, regions []avcRect, pooled bool) {
	// Record LC=2 arrival unconditionally so maybeRenegotiateCapabilities can
	// distinguish an active-LC=2-only server from a truly idle server.
	g.lastLC2RecvTime.Store(time.Now().UnixNano())
	if g.h264dec2 == nil {
		if g.lc2PermanentlyDegraded {
			// Server has proven it won't deliver stream2 IDRs; skip silently
			// without arming the timer to avoid an endless renegotiation loop.
			return
		}
		// If this standalone LC=2 frame carries an IDR, use it to create and
		// prime h264dec2 directly.  Some servers deliver the ForceRefresh IDR
		// response as LC=1 (luma only) rather than LC=0 (both streams), so the
		// IDR in the "duplicate" standalone LC=2 packet is the only opportunity
		// to initialise the aux decoder without a full reconnect.
		if stream2 != nil && len(stream2.h264Data) > 0 && isH264Keyframe(stream2.h264Data) {
			slog.Debug("H.264: creating aux decoder from standalone LC=2 IDR")
			g.h264dec2 = newH264DecoderSW()
			g.stopAuxDecoderBrokenTimer()
			g.auxDecoderNoIDRRetries = 0
			// Fall through to the decode path below.
		} else {
			slog.Debug("RDPGFX: AVC444 LC=2 skipped (no aux decoder)")
			// Arm the renegotiation timer so maybeRenegotiateCapabilities fires if
			// no stream2 IDR arrives to prime h264dec2 within auxDecoderBrokenTimeout.
			// This is idempotent — subsequent calls are no-ops while the timer runs.
			g.startAuxDecoderBrokenTimer()
			return
		}
	}
	if stream2 == nil || len(stream2.h264Data) == 0 {
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (empty aux stream)")
		return
	}
	// If the main decoder is broken (e.g. HW stall or no IDR received), trigger
	// soft reset so it can recover even when only LC=2 (chroma-only) frames are
	// arriving and the LC=0/1 decode path never gets called.
	if g.h264dec != nil && g.h264dec.IsBroken() {
		g.maybeNotifyDecoderBroken()
		return
	}
	if g.avc444YPlane.w == 0 {
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (no cached luma)")
		// Still advance h264dec2's DPB so the next standalone LC=2 P-frame
		// finds the correct reference.  Without this the DPB falls behind and
		// FFmpeg outputs all-zero chroma (green tiles) on the next LC=2 decode.
		g.primeH264dec2KeepDPB(stream2.h264Data)
		g.maybeRequestKeyframe()
		return
	}
	// Skip the combine when the Y cache is stale: the main decoder is likely
	// stalling (VideoToolbox null frames).  Combining old luma with fresh chroma
	// produces visible colour artefacts.  We suppress LC=2 output until h264dec
	// delivers a fresh frame and refreshes the cache.
	if !g.avc444YPlane.updatedAt.IsZero() && time.Since(g.avc444YPlane.updatedAt) > avc444YStaleness {
		age := time.Since(g.avc444YPlane.updatedAt).Round(time.Millisecond)
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (Y cache stale, main decoder likely stalling)",
			"age", age)
		// Advance h264dec2's DPB even though we skip the combine, so that it
		// stays in sync with the stream2 sequence and recovers cleanly once the
		// main decoder exits its stall.
		g.primeH264dec2KeepDPB(stream2.h264Data)
		// Signal the server to reduce encoding quality/bitrate while the HW
		// decoder is stalling.  This throttles the stream of LC=2 frames that
		// accumulate during VideoToolbox null-frame periods and gives VT more
		// headroom to flush its pipeline.  The hint is cleared in
		// updateAVC444YCache when the HW decoder resumes real-frame output.
		g.SetQueueDepthHint(avcHWStallQueueDepthHint)
		// During a VideoToolbox stall h264dec.NeedsKeyframe() is false (the
		// decoder has not been reset) so maybeRequestKeyframe() returns early.
		// Request a keyframe directly here, reusing the shared rate-limiter, so
		// the server delivers a fresh IDR that can help break the VT stall.
		const keyframeRequestInterval = 2 * time.Second
		if g.onKeyframeRequest != nil && time.Since(g.lastKeyframeRequest) >= keyframeRequestInterval {
			g.lastKeyframeRequest = time.Now()
			go g.onKeyframeRequest()
		}
		return
	}
	i420dec, ok := g.h264dec2.(I420Decoder)
	if !ok {
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (aux decoder lacks I420 support)")
		return
	}
	_, i420aux, err := i420dec.DecodeWithI420(stream2.h264Data)
	if err != nil {
		slog.Warn("RDPGFX: AVC444 LC=2 aux decode error", "err", err)
		if g.h264dec2.IsBroken() {
			g.h264dec2.Close()
			g.h264dec2 = nil
			g.startAuxDecoderBrokenTimer()
		}
		return
	}
	if i420aux == nil {
		slog.Debug("RDPGFX: AVC444 LC=2 aux decode buffering",
			"h264Len", len(stream2.h264Data),
			"firstNAL", firstNALType(stream2.h264Data),
			"isIDR", isH264Keyframe(stream2.h264Data))
		// The pre-flight stall detector inside Decode() may have set broken=true
		// and returned nil without an error.  Detect and tear down here; the
		// decoder will be recreated by primeAuxDecoder when the next stream2
		// IDR arrives, avoiding a rapid VT session create/destroy cycle.
		if g.h264dec2 != nil && g.h264dec2.IsBroken() {
			slog.Debug("H.264: aux decoder broken during LC=2 decode, waiting for IDR to recreate")
			g.h264dec2.Close()
			g.h264dec2 = nil
			// Do NOT call maybeRequestKeyframe() here: ForceRefresh only delivers
			// LC=1 luma IDR, not a stream2/chroma IDR.  h264dec2 will be re-primed
			// naturally when the next LC=0 frame arrives via primeAuxDecoder.
			// The aux decoder broken timer will escalate to caps renegotiation if
			// no LC=0 IDR arrives within auxDecoderBrokenTimeout.
			g.startAuxDecoderBrokenTimer()
		}
		return
	}
	// Detect invalid aux chroma: two failure modes trigger this check.
	//   1. Near-zero (Cb≈0, Cr≈0): Windows Server initialises stream2 IDR with
	//      Y≈0 and only refreshes regions that change; combining zero chroma with
	//      any luma produces BGRA(0,135,0,255) — a bright green screen.
	//   2. Near-saturation (Cb≈255 or Cr≈255): DPB mismatch or aux decoder
	//      corruption that produces near-maximal stream2 Y values; these encode
	//      as extreme chroma and produce a pink/magenta overlay when combined.
	// Determine IDR status before the blank-chroma check so it can drive the
	// h264dec2 reset decision below.
	stream2IsIDR := isH264Keyframe(stream2.h264Data)
	if isAuxChromaBlank(i420aux) {
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (stream2 chroma invalid: near-zero or near-saturated)")
		// For P-frames, corrupt chroma means h264dec2's DPB has diverged from
		// the server's reference (typically from a dropped LC=0 PDU).  Decoding
		// further P-frames against this wrong DPB would produce equally wrong
		// output on every subsequent LC=2, perpetuating the pink/green artefact.
		// Reset h264dec2 now so the DPB corruption does not cascade; recovery
		// will happen automatically on the next stream2 IDR arriving in an LC=0.
		// IDRs are excluded because near-zero chroma is expected at GOP start
		// during stream2 codec initialisation and should not trigger a reset.
		if !stream2IsIDR && g.h264dec2 != nil {
			slog.Debug("H.264: aux decoder reset after P-frame blank chroma (DPB cascade prevention)")
			g.h264dec2.Close()
			g.h264dec2 = nil
			g.startAuxDecoderBrokenTimer()
		}
		return
	}
	// Select the luma plane for the combine.  When stream2 carries an IDR its
	// chroma data corresponds to the GOP-boundary frame, not to the latest
	// P-frame.  Using avc444IDRYPlane (a snapshot of the luma at the moment
	// stream1's IDR was decoded) avoids combining mismatched luma/chroma planes
	// and eliminates the transient green tint that appears at GOP boundaries
	// when the server delivers the stream2 IDR as a standalone LC=2 packet.
	// Fall back to avc444YPlane when no IDR snapshot is available (e.g. the
	// VideoToolbox pipeline delayed the IDR output past the P-frame boundary).
	yp := &g.avc444YPlane
	if stream2IsIDR && g.avc444IDRYPlane.w > 0 {
		yp = &g.avc444IDRYPlane
		slog.Debug("RDPGFX: AVC444 LC=2 IDR combine using IDR luma snapshot")
	}
	w, h := yp.w, yp.h
	if i420aux.Width < w || i420aux.Height < h {
		slog.Debug("RDPGFX: AVC444 LC=2 aux frame too small",
			"auxW", i420aux.Width, "auxH", i420aux.Height, "lumaW", w, "lumaH", h)
		return
	}
	// Guard against corrupt cached stream1 chroma.  A frame that slipped past
	// the decoder's low-chroma guard can poison the U/V cache; combining that
	// with any stream2 chroma produces green/pink artefacts on the even-column,
	// even-row pixels.  Skip the combine and ask for a fresh IDR.
	if isAVC444YPlaneChromaBlank(yp) {
		slog.Debug("RDPGFX: AVC444 LC=2 skipped (cached stream1 chroma blank/corrupt)")
		g.primeH264dec2KeepDPB(stream2.h264Data)
		g.maybeRequestKeyframe()
		return
	}
	// Pass dirty regions to combineAVC444v2BGRA so it can skip unchanged rows
	// (significant savings for frames where only a small area updates).
	// Only do this when shouldUseAVCRegions is true: in that case the caller
	// (decodeAVC444 / decodeAVC444WithI420) routes the output through
	// blitAndEmitAVCRegions, which reads only within the dirty rectangles, so
	// any uninitialized rows in the output buffer are never accessed.
	//
	// Use destW/destH (surface dimensions) for the shouldUseAVCRegions check,
	// not w/h (decoded frame dimensions).  The region coordinates are in surface
	// space, and the callers (WTS1/WTS2) also call shouldUseAVCRegions with
	// surface dimensions.  Using different dimensions here could cause
	// combineRegions to be set (skipping rows, leaving stale pool garbage) while
	// the caller falls through to blitToSurface (reading all rows) — writing
	// that garbage to the display.  Using destW/destH keeps the two decisions
	// in sync and is more correct since the regions are in surface coordinate space.
	var combineRegions []avcRect
	if len(stream2.regions) > 0 && shouldUseAVCRegions(stream2.regions, destW, destH) {
		combineRegions = stream2.regions
	}
	combined, _ := combineAVC444v2BGRA(
		yp.data, yp.stride,
		yp.u, yp.v, yp.uvStride,
		i420aux,
		yp.fullRange,
		w, h,
		combineRegions,
	)
	if combined == nil {
		return
	}
	// Mark that LC=2 has produced at least one frame this session.
	// maybeRenegotiateCapabilities uses this to distinguish "was working then broke"
	// (needs reconnect) from "never worked" (graceful LC=0 degradation).
	g.lc2EverDecoded = true
	g.auxDecoderNoIDRRetries = 0 // reset so a future break starts retries from scratch
	// lc2Sample logs the actual Cb/Cr values used by combineAVC444v2BGRA for
	// position (px,py), which depend on the B-area that pixel falls into.
	halfW := w / 2
	quarterW := w / 4
	lc2Sample := func(px, py int) {
		if px >= w || py >= h {
			return
		}
		off := (py*w + px) * 4
		if off+3 >= len(combined) {
			return
		}
		uvRow := py >> 1
		var actualCb, actualCr byte
		var barea string
		if px&1 == 1 {
			// B4/B5: odd column — Cb/Cr packed in stream2 Y plane.
			barea = "B4/B5"
			k := px >> 1
			auxYRow := i420aux.Y[py*i420aux.YStride:]
			actualCb = auxYRow[k]
			actualCr = auxYRow[halfW+k]
		} else if py&1 == 0 {
			// B2/B3: even column, even row — from stream1 cached chroma.
			barea = "B2/B3"
			actualCb = yp.u[uvRow*yp.uvStride+(px>>1)]
			actualCr = yp.v[uvRow*yp.uvStride+(px>>1)]
		} else {
			k2 := px >> 2
			if px&2 == 0 {
				// B6/B7: even column (col%4==0), odd row.
				barea = "B6/B7"
				actualCb = i420aux.U[uvRow*i420aux.UStride+k2]
				actualCr = i420aux.U[uvRow*i420aux.UStride+quarterW+k2]
			} else {
				// B8/B9: even column (col%4==2), odd row.
				barea = "B8/B9"
				actualCb = i420aux.V[uvRow*i420aux.VStride+k2]
				actualCr = i420aux.V[uvRow*i420aux.VStride+quarterW+k2]
			}
		}
		slog.Debug("H.264: pixel sample (LC=2 combine)",
			"x", px, "y", py,
			"area", barea,
			"isIDR", stream2IsIDR,
			"usedIDRSnapshot", yp == &g.avc444IDRYPlane,
			"Y1", yp.data[py*yp.stride+px],
			"Cb", actualCb, "Cr", actualCr,
			"B", combined[off], "G", combined[off+1], "R", combined[off+2])
	}
	if !g.lc2SampleLogged {
		g.lc2SampleLogged = true
		// B2/B3 (even col, even row)
		lc2Sample(100, 50)
		lc2Sample(500, 50)
		// B4/B5 (odd col) — most important for diagnosing tint artifacts
		lc2Sample(101, 50)
		lc2Sample(501, 50)
		lc2Sample(961, 50)
		// B6/B7 (col%4==0, odd row)
		lc2Sample(100, 51)
		lc2Sample(500, 51)
		// B8/B9 (col%4==2, odd row)
		lc2Sample(102, 51)
		lc2Sample(502, 51)
		// video area — all four B-areas near the same spot
		lc2Sample(960, 600)
		lc2Sample(961, 600)
		lc2Sample(960, 601)
		lc2Sample(962, 601)
	} else if !g.lc2PFrameSampleLogged && !stream2IsIDR {
		g.lc2PFrameSampleLogged = true
		lc2Sample(100, 50)
		lc2Sample(101, 50)
		lc2Sample(100, 51)
		lc2Sample(102, 51)
		lc2Sample(500, 50)
		lc2Sample(501, 50)
		lc2Sample(960, 400)
		lc2Sample(961, 400)
		lc2Sample(960, 401)
		lc2Sample(962, 401)
		lc2Sample(960, 600)
		lc2Sample(961, 600)
	}
	decoded, pooled = cropBGRA(combined, w, h, destW, destH)
	if w == destW && h == destH {
		// cropBGRA returned combined unchanged; mark as pooled so caller releases it.
		pooled = true
	} else {
		// cropBGRA created a new buffer; release the intermediate combined buffer.
		releaseBitmapBuf(combined)
	}
	regions = stream2.regions
	slog.Debug("RDPGFX: AVC444 LC=2 decoded", "w", w, "h", h,
		"destW", destW, "destH", destH, "h264Len", len(stream2.h264Data))
	g.noteSuccessfulDecode()
	return
}

// softResetLimit is the number of in-place decoder recreations attempted
// before escalating to a full RDP reconnect.
const softResetLimit = 5

// maybeRequestKeyframe sends a keyframe request to the server when either
// decoder needs a fresh IDR.  Requests are rate-limited to once per 2 seconds
// so that repeated nil-frame callbacks (e.g. while waiting for the IDR) don't
// flood the server.  This covers both post-flush and post-soft-reset cases,
// including the case where h264dec2 was reset independently of h264dec.
//
// Proactive stall recovery: even when NeedsKeyframe()==false (decoder has not
// yet been reset), we send ForceRefresh early when the HW decoder appears to be
// stalling — packets are arriving but no real frame has been produced for longer
// than avc444YStaleness.  This gives the server a ~1 second head-start to
// prepare an IDR before the stall detector fires and triggers SW fallback,
// reducing the visible freeze from ~18 s to a few seconds.
func (g *GfxHandler) maybeRequestKeyframe() {
	if g.onKeyframeRequest == nil {
		return
	}
	if g.h264dec == nil || g.h264dec.IsBroken() {
		return
	}
	dec1NeedsKF := g.h264dec.NeedsKeyframe()
	// Do NOT include h264dec2 here: ForceRefresh only triggers an LC=1 luma IDR
	// from the server.  The stream2/chroma IDR is never delivered via
	// ForceRefresh — it arrives naturally as an LC=0 frame via primeAuxDecoder.
	// Requesting ForceRefresh because h264dec2.NeedsIDR()=true spams the server
	// with keyframe requests, causes the server to repeatedly send LC=1 IDRs,
	// and can deadlock the main VideoToolbox decoder.
	if !dec1NeedsKF {
		// Proactive early request: if packets are flowing in but no real frame
		// has been produced for avc444YStaleness, the HW decoder is likely
		// producing null frames.  Request a keyframe now so the server has time
		// to respond before the stall detector escalates to SW fallback.
		recvTime := g.h264dec.LastReceiveTime()
		if recvTime.IsZero() || time.Since(recvTime) >= avc444YStaleness {
			// No packets arriving — server is idle, not a HW stall.
			return
		}
		lastNS := g.lastDecodedFrame.Load()
		if lastNS == 0 || time.Since(time.Unix(0, lastNS)) < avc444YStaleness {
			// Frames are still being produced recently — not stalling.
			return
		}
	}
	const keyframeRequestInterval = 2 * time.Second
	if time.Since(g.lastKeyframeRequest) < keyframeRequestInterval {
		return
	}
	g.lastKeyframeRequest = time.Now()
	go g.onKeyframeRequest()
}

// maybeNotifyDecoderBroken is called whenever the H.264 decoder returns a
// nil frame.  It first tries up to softResetLimit in-place decoder resets
// (cheap: just recreate the FFmpeg/VideoToolbox context and ask the server
// for a fresh IDR).  Only after all soft resets are exhausted does it call
// onDecoderBroken, which triggers a full RDP reconnect.
func (g *GfxHandler) maybeNotifyDecoderBroken() {
	if g.decoderBrokenNotified {
		return
	}
	if g.h264dec == nil || !g.h264dec.IsBroken() {
		return
	}
	reason := g.h264dec.BrokenReason()
	if reason == H264BrokenReasonNoIDR && g.h264dec.LastReceiveTime().IsZero() {
		// The H.264 decoder's keyframe-wait timer fired, but the decoder has
		// never received any data (LastReceiveTime is zero).  This means the
		// server is using a non-H.264 codec (e.g. CA Progressive / codecId=9)
		// for the entire session and will never send H.264 frames.
		// Sending ForceRefresh or reconnecting would disrupt the session
		// unnecessarily — Ubuntu GNOME Remote Desktop responds to ForceRefresh
		// with DEACTIVATEALLPDU followed by a disconnect.
		// Disable the H.264 decoder so the watchdog can never fire again.
		slog.Debug("H.264: watchdog fired but no H.264 data received — server uses non-H.264 codec, disabling H.264 decoder")
		g.h264dec.Close()
		g.h264dec = nil
		return
	}
	if reason == H264BrokenReasonNoIDR {
		// Allow one no-IDR soft reset before escalating to reconnect, unless
		// we are already in SW fallback mode (after a HW stall).  In the SW
		// fallback case ForceRefresh was already sent multiple times during the
		// VT stall and the server has not responded; another retry just prolongs
		// the freeze by another keyframeWaitTimeoutSWFallback seconds.  Skip
		// straight to reconnect so the server can deliver a fresh IDR via the
		// normal session-start path, which it reliably does.
		//
		// For the non-fallback path: ForceRefresh (SuppressOutput toggle) often
		// fails to trigger a new AVC444 IDR from Windows servers; repeatedly
		// retrying just prolongs the freeze.  One attempt gives the server a
		// fair chance; after that a full reconnect is faster.
		//
		// noIDRSoftResetCount is kept separate from softResetCount so that a
		// prior HW-stall reset does not consume this budget — after an HW stall
		// the SW fallback decoder skips retries (see above); for a pure SW
		// session one no-IDR retry is still allowed.
		const softResetLimitNoIDR = 1
		if !g.usingSWFallback && g.noIDRSoftResetCount < softResetLimitNoIDR {
			g.noIDRSoftResetCount++
			slog.Debug("H.264: soft decoder reset (no-IDR)",
				"attempt", g.noIDRSoftResetCount, "limit", softResetLimitNoIDR,
				"reason", reason.String())
			g.h264dec.Close()
			g.h264dec = newH264DecoderWithWatchdog(g.watchdogCh)
			if g.h264dec2 != nil && g.h264dec2.IsBroken() {
				slog.Debug("H.264: aux decoder also broken on soft reset, waiting for IDR to recreate")
				g.h264dec2.Close()
				g.h264dec2 = nil
			}
			g.lastKeyframeRequest = time.Time{}
			g.maybeRequestKeyframe()
			return
		}
		slog.Debug("H.264: escalating to reconnect after no-IDR soft reset exhausted",
			"reason", reason.String())
		g.decoderBrokenNotified = true
		if g.onDecoderBroken != nil {
			go g.onDecoderBroken()
		}
		return
	}
	if g.softResetCount < softResetLimit {
		g.softResetCount++
		if reason == H264BrokenReasonHWStall && !g.usingSWFallback {
			// Switch to software (FFmpeg) decoding when VideoToolbox stalls.
			// Even if a proactive ForceRefresh was already sent, the server
			// typically delivers the IDR within ~1-2 s; the SW decoder will
			// pick it up and the session continues without a full reconnect.
			slog.Debug("H.264: HW stall — falling back to software decoding",
				"attempt", g.softResetCount, "limit", softResetLimit)
			g.usingSWFallback = true
		} else {
			slog.Debug("H.264: soft decoder reset",
				"attempt", g.softResetCount, "limit", softResetLimit,
				"reason", reason.String())
		}
		g.h264dec.Close()
		if g.usingSWFallback {
			g.h264dec = newH264DecoderSWWithWatchdog(g.watchdogCh)
		} else {
			g.h264dec = newH264DecoderWithWatchdog(g.watchdogCh)
		}
		// Prime the SW fallback decoder with the last cached stream1 IDR so it
		// can decode subsequent P-frames immediately, without waiting for the
		// server to send a fresh IDR via ForceRefresh.
		//
		// We always prime when an IDR is cached, regardless of its age.  A stale
		// IDR is missing the reference frames decoded since then, so moving
		// regions may show transient block noise until the next P-frames refresh
		// them (or a fresh IDR fully heals the picture) — but for a mostly-static
		// desktop the stale IDR is a close approximation and the artifacts are
		// minor.  Crucially this avoids the alternative: AVC444 servers only send
		// an IDR at session start, so the cached IDR is essentially always "stale"
		// at stall time; gating priming on freshness meant the SW decoder waited
		// for a fresh IDR that never arrives, the watchdog fired, and the whole
		// RDP session reconnected.  Continuing with a primed SW decoder is far
		// less disruptive than a reconnect.  maybeRequestKeyframe() below still
		// asks the server for a fresh IDR to clean up any residual artifacts.
		idrAge := time.Since(g.lastStream1IDRTime)
		idrFrameAge := g.framesDecoded.Load() - g.lastStream1IDRFrame
		if g.usingSWFallback && len(g.lastStream1IDR) > 0 &&
			!g.lastStream1IDRTime.IsZero() {
			slog.Debug("H.264: priming SW fallback with cached stream1 IDR to avoid IDR wait",
				"idrLen", len(g.lastStream1IDR),
				"idrAge", idrAge.Round(time.Millisecond),
				"idrFrameAge", idrFrameAge,
			)
			g.swFallbackPrimed = true
			g.swFallbackDroppedCount = 0
			g.swFallbackFirstDropTime = time.Time{}
			if _, err := g.h264dec.Decode(g.lastStream1IDR); err != nil {
				slog.Debug("H.264: cached IDR prime failed, watchdog will wait for natural IDR",
					"err", err)
			}
		} else if g.usingSWFallback {
			slog.Debug("H.264: no cached stream1 IDR to prime SW fallback — watchdog will wait for a natural IDR",
				"idrAge", idrAge.Round(time.Millisecond),
				"idrFrameAge", idrFrameAge,
			)
		}
		// Keep h264dec2 if healthy; tear it down if already broken so
		// primeAuxDecoder can recreate it when the next stream2 IDR arrives,
		// rather than spinning up a new VT session only to have it break again.
		// Always keep avc444YPlane so that LC=2 frames can continue to display
		// stale-but-reasonable content during recovery.
		if g.h264dec2 != nil && g.h264dec2.IsBroken() {
			slog.Debug("H.264: aux decoder also broken on soft reset, waiting for IDR to recreate")
			g.h264dec2.Close()
			g.h264dec2 = nil
		}
		// Reset rate-limiter so keyframe request fires immediately after reset.
		g.lastKeyframeRequest = time.Time{}
		g.maybeRequestKeyframe()
		return
	}
	// All soft resets exhausted — escalate to full reconnect.
	g.decoderBrokenNotified = true
	if g.onDecoderBroken != nil {
		go g.onDecoderBroken()
	}
}

// swFallbackDropLimit is the minimum number of consecutive dropped frames,
// and swFallbackResyncTimeout the minimum elapsed time, that must accumulate
// after priming the SW fallback decoder with a stale cached IDR before we give
// up and reconnect.  Both conditions must hold: a large frame count alone (a
// fast stall burst) should not reconnect before the ForceRefresh resync IDR has
// had a realistic chance to arrive, and a long idle gap alone should not
// reconnect if only one or two frames were bad.  While corruption persists the
// frames are dropped (screen holds the last good frame) rather than shown, and
// maybeRequestKeyframe keeps asking the server for a fresh IDR; only when the
// server fails to heal within the timeout do we fall back to a full reconnect.
const swFallbackDropLimit = 3
const swFallbackResyncTimeout = 2 * time.Second

// trackSWFallbackDroppedFrame counts a dropped frame after a SW fallback IDR
// prime.  When corruption from a stale prime persists past swFallbackDropLimit
// consecutive drops AND swFallbackResyncTimeout — i.e. the ForceRefresh resync
// IDR did not arrive in time — it marks the decoder broken so the application
// reconnects instead of showing a frozen/green screen.  A genuine fresh IDR
// (maybeCacheStream1IDR) or any clean decode (noteSuccessfulDecode) clears the
// run before it reaches the escalation threshold.
func (g *GfxHandler) trackSWFallbackDroppedFrame() {
	if !g.usingSWFallback || !g.swFallbackPrimed {
		return
	}
	if g.swFallbackDroppedCount == 0 {
		g.swFallbackFirstDropTime = time.Now()
	}
	g.swFallbackDroppedCount++
	if g.swFallbackDroppedCount >= swFallbackDropLimit &&
		!g.swFallbackFirstDropTime.IsZero() &&
		time.Since(g.swFallbackFirstDropTime) >= swFallbackResyncTimeout {
		slog.Warn("H.264: SW fallback stale IDR prime did not resync in time, escalating to reconnect",
			"dropped", g.swFallbackDroppedCount,
			"persistedFor", time.Since(g.swFallbackFirstDropTime).Round(time.Millisecond))
		g.swFallbackPrimed = false
		g.swFallbackDroppedCount = 0
		g.swFallbackFirstDropTime = time.Time{}
		g.decoderBrokenNotified = true
		if g.onDecoderBroken != nil {
			go g.onDecoderBroken()
		}
	}
}

// cropBGRA crops or pads BGRA pixel data to the target dimensions.
// When srcW == dstW and srcH == dstH the input slice is returned unchanged
// and pooled is false.  Otherwise a new buffer is acquired from bitmapBufPool
// (pooled == true) and the caller must call releaseBitmapBuf on it.
func cropBGRA(src []byte, srcW, srcH, dstW, dstH int) ([]byte, bool) {
	if srcW == dstW && srcH == dstH {
		return src, false
	}
	out := acquireBitmapBuf(dstW * dstH * 4)
	copyW := min(dstW, srcW)
	copyH := min(dstH, srcH)
	srcStride := srcW * 4
	dstStride := dstW * 4
	rowBytes := copyW * 4
	for y := range copyH {
		copy(out[y*dstStride:y*dstStride+rowBytes], src[y*srcStride:y*srcStride+rowBytes])
	}
	return out, true
}

// avcRegionUseThresholdPercent is the upper bound on the *fraction* of the
// decoded frame area that the union of dirty rects can cover before we give
// up and just blit the whole frame.  When the dirty area approaches the
// total area, the per-rect bookkeeping (allocation per rect, separate
// BitmapUpdate per rect) costs more than the bytes-copied savings.
const avcRegionUseThresholdPercent = 60

// shouldUseAVCRegions returns true when the per-region partial blit path is
// expected to be cheaper than a single full-frame blit.  A single region
// covering everything is treated as "no win"; many tiny regions covering
// most of the frame are similarly bypassed.
func shouldUseAVCRegions(regions []avcRect, frameW, frameH int) bool {
	if frameW <= 0 || frameH <= 0 {
		return false
	}
	total := frameW * frameH
	if total == 0 {
		return false
	}
	// Sum (with overlap double-counting) — overlap is uncommon in practice
	// and the threshold leaves slack for it.
	sum := 0
	for _, r := range regions {
		if r.right <= r.left || r.bottom <= r.top {
			continue
		}
		w := int(r.right - r.left)
		h := int(r.bottom - r.top)
		sum += w * h
		if sum*100 >= total*avcRegionUseThresholdPercent {
			return false
		}
	}
	return sum > 0
}

// blitAndEmitAVCRegions copies only the dirty rectangles of a decoded AVC
// frame into the persistent surface and emits a BitmapUpdate per region.
// All region coordinates are in decoded-frame space (i.e. relative to
// (left, top) on the surface).
//
// The emitted Data buffers are borrowed from bitmapBufPool and are returned
// to the pool once the synchronous onBitmap callback completes — see the
// BitmapUpdate lifecycle note.
func (g *GfxHandler) blitAndEmitAVCRegions(s *surface, left, top, frameW, frameH int, decoded []byte, regions []avcRect) {
	frameStride := frameW * 4
	surfStride := int(s.width) * 4
	g.updatesBuf = g.updatesBuf[:0]
	for _, rc := range regions {
		if rc.right <= rc.left || rc.bottom <= rc.top {
			continue
		}
		rx, ry := int(rc.left), int(rc.top)
		rw, rh := int(rc.right-rc.left), int(rc.bottom-rc.top)
		if rx+rw > frameW {
			rw = frameW - rx
		}
		if ry+rh > frameH {
			rh = frameH - ry
		}
		if rw <= 0 || rh <= 0 {
			continue
		}
		rowBytes := rw * 4
		region := acquireBitmapBuf(rw * rh * 4)
		for row := 0; row < rh; row++ {
			srcOff := (ry+row)*frameStride + rx*4
			if srcOff+rowBytes > len(decoded) {
				break
			}
			copy(region[row*rowBytes:row*rowBytes+rowBytes],
				decoded[srcOff:srcOff+rowBytes])

			// Mirror the same row into the persistent surface so any
			// subsequent codec (RFX progressive etc.) operating on the
			// same surface starts from the up-to-date pixels.
			dy := top + ry + row
			if dy < 0 || dy >= int(s.height) {
				continue
			}
			dstOff := dy*surfStride + (left+rx)*4
			if dstOff < 0 || dstOff+rowBytes > len(s.data) {
				continue
			}
			copy(s.data[dstOff:dstOff+rowBytes],
				decoded[srcOff:srcOff+rowBytes])
		}
		if !s.mapped || g.onBitmap == nil {
			releaseBitmapBuf(region)
			continue
		}
		destL := int(s.outputX) + left + rx
		destT := int(s.outputY) + top + ry
		g.updatesBuf = append(g.updatesBuf, BitmapUpdate{
			DestLeft: destL, DestTop: destT,
			DestRight: destL + rw - 1, DestBottom: destT + rh - 1,
			Width: rw, Height: rh, Bpp: 4, Data: region,
		})
	}
	g.emitAndReleaseUpdates(g.updatesBuf)
}

// blitAVCRegionsToSurface copies only the dirty rectangles of a decoded AVC
// frame into the persistent CPU surface shadow (s.data), without allocating
// per-region buffers or emitting BitmapUpdates.  It is the shadow-only
// counterpart to blitAndEmitAVCRegions, used on the GPU display path
// (onNV12/onI420) where the display is driven directly from the YUV planes and
// only the CPU shadow needs maintaining for later surface-to-surface / cache /
// mixed-codec operations.
//
// The caller must ensure the shadow is not stale (surface.shadowStale == false)
// before using this partial update; otherwise a full blitToSurface is required
// to repair regions that earlier GPU-only frames advanced without a shadow
// update.  Region coordinates are in decoded-frame space (relative to
// (left, top) on the surface); both source and destination are bounds-clamped.
func (g *GfxHandler) blitAVCRegionsToSurface(s *surface, left, top, frameW, frameH int, decoded []byte, regions []avcRect) {
	frameStride := frameW * 4
	surfStride := int(s.width) * 4
	for _, rc := range regions {
		if rc.right <= rc.left || rc.bottom <= rc.top {
			continue
		}
		rx, ry := int(rc.left), int(rc.top)
		rw, rh := int(rc.right-rc.left), int(rc.bottom-rc.top)
		if rx+rw > frameW {
			rw = frameW - rx
		}
		if ry+rh > frameH {
			rh = frameH - ry
		}
		if rw <= 0 || rh <= 0 {
			continue
		}
		rowBytes := rw * 4
		for row := 0; row < rh; row++ {
			srcOff := (ry+row)*frameStride + rx*4
			if srcOff+rowBytes > len(decoded) {
				break
			}
			dy := top + ry + row
			if dy < 0 || dy >= int(s.height) {
				continue
			}
			dstOff := dy*surfStride + (left+rx)*4
			if dstOff < 0 || dstOff+rowBytes > len(s.data) {
				continue
			}
			copy(s.data[dstOff:dstOff+rowBytes], decoded[srcOff:srcOff+rowBytes])
		}
	}
}