// gxui.go
package main

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"io"
	"log/slog"
	"net"
	"os"
	"strings"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ebitengine/oto/v3"
	"github.com/google/gxui"
	"github.com/google/gxui/drivers/gl"
	"github.com/google/gxui/drivers/gl/platform"
	"github.com/google/gxui/samples/flags"
	"github.com/google/gxui/themes/light"
	"golang.design/x/clipboard"

	"github.com/nakagami/grdp"
	"github.com/nakagami/grdp/plugin/rdpsnd"
	"github.com/nakagami/grdp/plugin/rdpsnd/aac"
)

// audioStream is a thread-safe buffer that bridges the RDPSND OnAudio
// callback (producer) and the oto audio player (consumer).
//
// Unlike a blocking io.Reader, Read returns silence (zeros) when the buffer
// is empty.  This keeps the oto player running continuously and avoids
// audio-device stalls that would cause clicks/pops when data resumes.
// Short cross-fades are applied at underrun boundaries (like rdpyqt).
type audioStream struct {
	mu          sync.Mutex
	buf         bytes.Buffer
	closed      bool
	wasUnderrun bool
	primed      bool // true once initial prebuffer has filled
}

// maxAudioBuf is the soft cap on the audioStream buffer (≈1 s of PCM
// 44100 Hz / 2 ch / 16-bit).  When exceeded, incoming audio is dropped
// rather than buffering ever-growing stale data.
const maxAudioBuf = 176400

// prebufferBytes is the amount of PCM that must accumulate before Read
// starts returning real audio.  Until then Read returns silence so the
// oto player stays running but the actual audio is not yet drained,
// giving incoming RDPSND chunks a chance to build up a healthy backlog.
// 70560 B = 70560 / (44100 * 2 * 2) = 400 ms — close to rdpyqt's 500 ms
// _AudioRingBuffer prebuffer (rdpsnd.py:124-212).
const prebufferBytes = 70560

// fadeFrames is the number of stereo frames used for fade-in/fade-out at
// underrun boundaries (~1.5 ms at 44100 Hz).  Each stereo frame is 4 bytes
// (2 × int16).
const fadeFrames = 64

// fadeOutThreshold is the buffered byte count at or below which we apply
// a fade-out tail to the last fadeFrames returned, so the imminent
// transition from audio→silence does not produce a click.  Mirrors
// rdpyqt's _AudioRingBuffer crossfade behaviour.  ~10 ms worth of stereo
// PCM (44100 * 2ch * 2bytes * 0.01 = 1764) is a comfortable trigger.
const fadeOutThreshold = 1764

func newAudioStream() *audioStream {
	return &audioStream{}
}

func (s *audioStream) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Drop incoming data when the buffer is too full rather than
	// accumulating a growing backlog that would delay playback.
	if s.buf.Len() >= maxAudioBuf {
		return len(p), nil
	}
	n, err := s.buf.Write(p)
	// Once we have at least prebufferBytes queued, mark primed so Read
	// starts draining real audio.  Until then Read keeps returning silence
	// so the player has a healthy backlog before it begins consumption.
	if !s.primed && s.buf.Len() >= prebufferBytes {
		s.primed = true
	}
	return n, err
}

// Read fills p with audio data.  If the internal buffer is empty (or not
// yet primed) the slice is zero-filled (silence) so the oto player never
// stalls.  A short fade-in is applied after an underrun so the transition
// from silence to audio does not produce an audible click; conversely,
// when the buffer is about to drain we apply a fade-out to the trailing
// frames returned, so the next zero-filled Read does not click either.
func (s *audioStream) Read(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.closed && s.buf.Len() == 0 {
		return 0, io.EOF
	}

	if !s.primed || s.buf.Len() == 0 {
		// Either still pre-buffering for the first time, or underrun.
		s.wasUnderrun = true
		clear(p)
		return len(p), nil
	}

	n, err := s.buf.Read(p)

	if s.wasUnderrun {
		// Fade in the first fadeFrames stereo frames to mask the
		// silence→audio click.
		s.wasUnderrun = false
		applyFadeIn(p[:n])
	}

	// If the buffer is now nearly empty, fade out the tail of this read
	// so the upcoming silence transition is clickless.  This mirrors
	// rdpyqt's _AudioRingBuffer crossfade-out behaviour.
	if s.buf.Len() <= fadeOutThreshold {
		applyFadeOut(p[:n])
		// Force re-prime: wait for fresh data before resuming playback.
		// Without re-priming the player would keep ping-ponging between
		// 1-2 ms of audio and silence at every chunk boundary.
		s.primed = false
	}

	return n, err
}

// applyFadeIn applies a linear gain ramp from 0→1 over the first fadeFrames
// stereo frames of PCM 16-bit little-endian data in buf.
func applyFadeIn(buf []byte) {
	const bytesPerFrame = 4 // 2 ch × 2 bytes
	frames := len(buf) / bytesPerFrame
	if frames > fadeFrames {
		frames = fadeFrames
	}
	for i := 0; i < frames; i++ {
		gain := float32(i) / float32(fadeFrames)
		off := i * bytesPerFrame
		for ch := 0; ch < 2; ch++ {
			o := off + ch*2
			v := int16(buf[o]) | int16(buf[o+1])<<8
			v = int16(float32(v) * gain)
			buf[o] = byte(v)
			buf[o+1] = byte(v >> 8)
		}
	}
}

// applyFadeOut applies a linear gain ramp from 1→0 over the LAST fadeFrames
// stereo frames of PCM 16-bit little-endian data in buf.  Used right before
// an expected underrun so the silence transition is clickless.
func applyFadeOut(buf []byte) {
	const bytesPerFrame = 4
	totalFrames := len(buf) / bytesPerFrame
	frames := fadeFrames
	if totalFrames < frames {
		frames = totalFrames
	}
	tailStart := (totalFrames - frames) * bytesPerFrame
	for i := 0; i < frames; i++ {
		gain := float32(frames-1-i) / float32(fadeFrames)
		off := tailStart + i*bytesPerFrame
		for ch := 0; ch < 2; ch++ {
			o := off + ch*2
			v := int16(buf[o]) | int16(buf[o+1])<<8
			v = int16(float32(v) * gain)
			buf[o] = byte(v)
			buf[o+1] = byte(v >> 8)
		}
	}
}

func (s *audioStream) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// Reset flushes all buffered audio data. Called when the server closes the
// audio channel (e.g. media seek) so stale audio does not keep playing.
func (s *audioStream) Reset() {
	s.mu.Lock()
	s.buf.Reset()
	s.primed = false
	s.wasUnderrun = true
	s.mu.Unlock()
}

// --- System clipboard helpers (golang.design/x/clipboard) ------------------

func readSystemClipboard() string {
	b := clipboard.Read(clipboard.FmtText)
	if b == nil {
		return ""
	}
	return string(b)
}

func writeSystemClipboard(text string) {
	clipboard.Write(clipboard.FmtText, []byte(text))
}

// clipboardWatcher polls the system clipboard and notifies the RDP server
// when the local clipboard changes.
func clipboardWatcher(client *grdp.RdpClient, stopCh <-chan struct{}) {
	lastText := readSystemClipboard()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			text := readSystemClipboard()
			if text != lastText {
				lastText = text
				client.NotifyClipboardChanged()
			}
		}
	}
}

// timedBitmap pairs a set of decoded bitmap regions with the earliest wall-
// clock time at which they should be composited on screen.  When
// avSyncVideoDelay is zero displayAt is the zero value and the frame is
// rendered immediately.
type timedBitmap struct {
	frames    []grdp.Bitmap
	displayAt time.Time
}

// audioDelayItem is a chunk of decoded PCM audio together with the earliest
// wall-clock time at which it should be written to the audio output stream.
type audioDelayItem struct {
	data   []byte
	playAt time.Time
}

var (
	rdpClient              *grdp.RdpClient
	driverc                gxui.Driver
	screenImage            *image.RGBA
	screenMu               sync.Mutex
	img                    gxui.Image
	layoutImg              gxui.LinearLayout
	bitmapCH               chan timedBitmap
	lastMouseX, lastMouseY int
	resizeTimer            *time.Timer
	audioStr               *audioStream
	audioDelayCh           chan audioDelayItem // non-nil when avSyncAudioDelay > 0
	otoCtx                 *oto.Context
	otoPlayer              *oto.Player
	clipStopCh             chan struct{}
	// lastServerActivity tracks the last time any data arrived from the server
	// (bitmap, audio, pointer update).  Used by the video-stall watchdog to
	// distinguish a truly stuck stream from a legitimately idle desktop.
	// Stored as UnixNano; zero means no activity yet (watchdog disarmed).
	lastServerActivity atomic.Int64

	// avSyncAudioDelay / avSyncVideoDelay are set from GRDP_AUDIO_DELAY_MS /
	// GRDP_VIDEO_DELAY_MS.  A positive audio delay shifts audio output later
	// in time (use when audio is perceived as leading video).  A positive
	// video delay shifts video display later (use when video leads audio).
	avSyncAudioDelay time.Duration
	avSyncVideoDelay time.Duration

	// aacDec is the active AAC decoder; recreated whenever the server switches
	// to a different AAC format.  Accessed only from the OnAudio callback.
	aacDec       aac.Decoder
	aacDecFormat aacFormatKey
)

func uiRdp(hostPort, domain, user, password string, width, height int, keyboardType, keyboardLayout string) (error, *grdp.RdpClient) {
	bitmapCH = make(chan timedBitmap, 500)
	g := grdp.NewRdpClient(hostPort, width, height, func(hp string) (net.Conn, error) {
		return net.DialTimeout("tcp", hp, 30*time.Second)
	})
	if keyboardType != "" {
		g.SetKeyboardType(keyboardType)
	}
	if keyboardLayout != "" {
		g.SetKeyboardLayout(keyboardLayout)
	}

	g.OnAudio(func(af rdpsnd.AudioFormat, data []byte) {
		lastServerActivity.Store(time.Now().UnixNano())
		pcm := data
		if af.IsAAC() {
			decoded, err := aacDecodeChunk(af, data)
			if err != nil {
				slog.Warn("AAC decode error", "err", err)
				return
			}
			pcm = decoded
		}
		if len(pcm) == 0 {
			return
		}
		if audioDelayCh != nil {
			d := make([]byte, len(pcm))
			copy(d, pcm)
			audioDelayCh <- audioDelayItem{data: d, playAt: time.Now().Add(avSyncAudioDelay)}
		} else {
			audioStr.Write(pcm)
		}
	})

	g.OnAudioReset(func() {
		slog.Debug("Audio reset: flushing playback buffer")
		audioStr.Reset()
	})

	g.OnClipboard(
		func(text string) {
			slog.Debug("clipboard: remote → local", "len", len(text))
			writeSystemClipboard(text)
		},
		func() string {
			text := readSystemClipboard()
			slog.Debug("clipboard: local → remote", "len", len(text))
			return text
		},
	)

	err := g.Login(domain, user, password)
	if err != nil {
		slog.Error("Login", "err", err)
		return err, nil
	}

	g.OnError(func(e error) {
		slog.Debug("on error", "err", e)
	}).OnClose(func() {
		slog.Debug("on close")
	}).OnSuccess(func() {
		slog.Debug("on success")
	}).OnReady(func() {
		slog.Debug("on ready")
	}).OnPointerHide(func() {
		lastServerActivity.Store(time.Now().UnixNano())
		slog.Debug("on pointer_hide")
	}).OnPointerCached(func(idx uint16) {
		lastServerActivity.Store(time.Now().UnixNano())
		slog.Debug("on pointer_cached", "idx", idx)
	}).OnPointerUpdate(func(idx uint16, bpp uint16, x uint16, y uint16, width uint16, height uint16, mask []byte, data []byte) {
		lastServerActivity.Store(time.Now().UnixNano())
		slog.Debug("on pointer_update", "idx", idx)
	}).OnDecoderBroken(func() {
		// All internal recovery attempts (SW fallback + keyframe requests) have
		// been exhausted.  Reconnect so the server sends a fresh IDR.
		slog.Warn("decoder broken; reconnecting")
		sz := layoutImg.Size()
		w, h := sz.W, sz.H
		if err := rdpClient.Reconnect(w, h); err != nil {
			slog.Error("Reconnect (decoder broken) failed", "err", err)
			return
		}
		screenMu.Lock()
		screenImage = image.NewRGBA(image.Rect(0, 0, w, h))
		screenMu.Unlock()
	}).OnBitmap(func(bs []grdp.Bitmap) {
		lastServerActivity.Store(time.Now().UnixNano())
		// Bitmap.Data for compressed bitmaps is borrowed from an internal
		// pool and only valid for the duration of this callback.  Copy the
		// pixel data before sending it to the asynchronous paint goroutine.
		for i := range bs {
			d := make([]byte, len(bs[i].Data))
			copy(d, bs[i].Data)
			bs[i].Data = d
		}
		// Non-blocking send: drop frames if the paint goroutine can't
		// keep up.  This prevents the decode goroutine from blocking on
		// downstream rendering, which would stall frame ACKs.
		select {
		case bitmapCH <- timedBitmap{frames: bs, displayAt: time.Now().Add(avSyncVideoDelay)}:
		default:
		}
	})

	return nil, g
}

func appMain(driver gxui.Driver) {
	hostPort := strings.Join([]string{os.Getenv("GRDP_HOST"), os.Getenv("GRDP_PORT")}, ":")
	domain := os.Getenv("GRDP_DOMAIN")
	user := os.Getenv("GRDP_USER")
	password := os.Getenv("GRDP_PASSWORD")

	var width, height int
	_, err := fmt.Sscanf(os.Getenv("GRDP_WINDOW_SIZE"), "%dx%d", &width, &height)
	if err != nil {
		width, height = 1280, 800
	}
	keyboardType := os.Getenv("GRDP_KEYBOARD_TYPE")
	keyboardLayout := os.Getenv("GRDP_KEYBOARD_LAYOUT")

	// A/V sync offset — positive values delay the named medium.
	audioDelayMs := 0
	if s := os.Getenv("GRDP_AUDIO_DELAY_MS"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			audioDelayMs = v
		}
	}
	videoDelayMs := 700
	if s := os.Getenv("GRDP_VIDEO_DELAY_MS"); s != "" {
		if v, err := strconv.Atoi(s); err == nil {
			videoDelayMs = v
		}
	}
	if audioDelayMs > 0 {
		avSyncAudioDelay = time.Duration(audioDelayMs) * time.Millisecond
	}
	if videoDelayMs > 0 {
		avSyncVideoDelay = time.Duration(videoDelayMs) * time.Millisecond
	}

	audioStr = newAudioStream()
	if avSyncAudioDelay > 0 {
		startAudioDelayLoop(audioStr)
	}

	if err := clipboard.Init(); err != nil {
		slog.Error("Clipboard init failed", "err", err)
	}

	err, rdpClient = uiRdp(hostPort, domain, user, password, width, height, keyboardType, keyboardLayout)
	if err != nil {
		fmt.Println(err.Error())
		driver.Terminate()
		return
	}

	// Start clipboard watcher goroutine
	clipStopCh = make(chan struct{})
	go clipboardWatcher(rdpClient, clipStopCh)

	// Initialize audio output (PCM 44100Hz stereo 16-bit)
	otoOp := &oto.NewContextOptions{
		SampleRate:   44100,
		ChannelCount: 2,
		Format:       oto.FormatSignedInt16LE,
		// 300 ms hardware buffer.  Together with the prebuffer (400 ms)
		// and the larger player read-ahead this is enough headroom to
		// absorb the typical 32 KB / ~187 ms RDPSND chunk cadence without
		// underruns.  Lip-sync drift of ~150 ms vs video is imperceptible.
		BufferSize: 300 * time.Millisecond,
	}
	ctx, readyCh, otoErr := oto.NewContext(otoOp)
	if otoErr != nil {
		slog.Error("Audio output init failed", "err", otoErr)
	} else {
		<-readyCh
		otoCtx = ctx
		otoPlayer = otoCtx.NewPlayer(audioStr)
		// 32768 bytes ≈ 186 ms of PCM stereo 16-bit at 44.1 kHz.
		// Combined with the audioStream prebuffer this matches rdpyqt's
		// hardware-buffer behaviour and keeps playback smooth across
		// chunk boundaries.
		otoPlayer.SetBufferSize(32768)
		otoPlayer.Play()
		slog.Debug("Audio output initialized")
	}

	theme := light.CreateTheme(driver)
	window := theme.CreateWindow(width, height, "MSTSC")
	window.SetScale(flags.DefaultScaleFactor)

	img = theme.CreateImage()

	layoutImg = theme.CreateLinearLayout()
	layoutImg.SetSizeMode(gxui.Fill)
	layoutImg.SetHorizontalAlignment(gxui.AlignCenter)
	layoutImg.AddChild(img)
	layoutImg.SetVisible(true)
	screenImage = image.NewRGBA(image.Rect(0, 0, width, height))

	layoutImg.OnMouseDown(func(e gxui.MouseEvent) {
		if rdpClient == nil {
			return
		}
		rdpClient.MouseDown(int(e.Button), e.Point.X, e.Point.Y)
	})
	layoutImg.OnMouseUp(func(e gxui.MouseEvent) {
		if rdpClient == nil {
			return
		}
		rdpClient.MouseUp(int(e.Button), lastMouseX, lastMouseY)
		//		rdpClient.MouseUp(int(e.Button), e.Point.X, e.Point.Y)
	})
	layoutImg.OnMouseMove(func(e gxui.MouseEvent) {
		if rdpClient == nil {
			return
		}
		rdpClient.MouseMove(e.Point.X, e.Point.Y)
		lastMouseX = e.Point.X
		lastMouseY = e.Point.Y
	})
	layoutImg.OnMouseScroll(func(e gxui.MouseEvent) {
		if rdpClient == nil {
			return
		}
		// Normalize gxui scroll units to notch counts (1.0 per physical notch).
		// gxui multiplies the raw GLFW yoff by platform.ScrollSpeed, so we
		// divide it back out.  MouseWheel handles the RDP WHEEL_DELTA scaling.
		rdpClient.MouseWheel(float64(e.ScrollY) / platform.ScrollSpeed)
	})
	window.OnKeyDown(func(e gxui.KeyboardEvent) {
		if rdpClient == nil {
			return
		}
		key := transKey(e.Key)
		rdpClient.KeyDown(key)
	})
	window.OnKeyUp(func(e gxui.KeyboardEvent) {
		if rdpClient == nil {
			return
		}
		key := transKey(e.Key)
		rdpClient.KeyUp(key)
	})

	driverc = driver
	layoutImg.SetVisible(true)
	window.AddChild(layoutImg)
	window.OnClose(func() {
		if clipStopCh != nil {
			close(clipStopCh)
		}
		if resizeTimer != nil {
			resizeTimer.Stop()
		}
		if otoPlayer != nil {
			otoPlayer.Pause()
		}
		if audioStr != nil {
			audioStr.Close()
		}
		if rdpClient != nil {
			rdpClient.Close()
		}

		driver.Terminate()
	})
	window.OnResize(func() {
		sz := layoutImg.Size()
		w, h := sz.W, sz.H
		if w <= 0 || h <= 0 {
			return
		}
		if w == rdpClient.Width() && h == rdpClient.Height() {
			return
		}
		if resizeTimer != nil {
			resizeTimer.Stop()
		}
		resizeTimer = time.AfterFunc(500*time.Millisecond, func() {
			slog.Debug("Window resized, reconnecting", "width", w, "height", h)
			if err := rdpClient.Reconnect(w, h); err != nil {
				slog.Error("Reconnect failed", "err", err)
				return
			}
			// Only replace the screen buffer after a successful reconnect
			// so the display keeps the last good frame on failure.
			screenMu.Lock()
			screenImage = image.NewRGBA(image.Rect(0, 0, w, h))
			screenMu.Unlock()
		})
	})
	update()
	startVideoStallWatchdog()
}

// videoStallTimeout is the maximum time without any server-originated traffic
// (bitmap, audio, pointer) before treating the session as stalled and
// reconnecting.  This mirrors the SDL2 frontend's watchdog and recovers from
// VideoToolbox / H.264 decoder hangs without requiring user interaction.
//
// 10 s is generous enough to survive a normal HW-decoder soft-reset cycle
// (stall detection → soft reset → IDR request → first new frame ≈ 5–8 s)
// while still catching a truly frozen session.
const videoStallTimeout = 10 * time.Second

// --- AAC helpers ------------------------------------------------------------

// aacFormatKey is a comparable key derived from an AudioFormat, used to
// detect format changes without comparing the non-comparable ExtraData slice.
type aacFormatKey struct {
	Tag           uint16
	Channels      uint16
	SamplesPerSec uint32
}

// aacDecodeChunk decodes one raw AAC packet using the process-global aacDec,
// recreating it whenever the format changes.  The oto player is fixed at
// 44100 Hz / 2 ch / 16-bit; a warning is logged if the AAC stream differs.
func aacDecodeChunk(af rdpsnd.AudioFormat, data []byte) ([]byte, error) {
	key := aacFormatKey{af.Tag, af.Channels, af.SamplesPerSec}
	if aacDec == nil || aacDecFormat != key {
		if aacDec != nil {
			aacDec.Close()
			aacDec = nil
		}
		dec, err := aac.New(af)
		if err != nil {
			return nil, err
		}
		if af.SamplesPerSec != 44100 || af.Channels != 2 {
			slog.Warn("AAC format differs from oto player config",
				"rate", af.SamplesPerSec, "channels", af.Channels,
				"otoRate", 44100, "otoChannels", 2)
		}
		aacDec = dec
		aacDecFormat = key
	}
	return aacDec.Decode(data)
}



// startAudioDelayLoop starts a background goroutine that drains audioDelayCh
// and writes each chunk to dst at its scheduled playAt time.  Items are
// processed strictly in order so sequential Wave2 blocks are never reordered.
func startAudioDelayLoop(dst *audioStream) {
	audioDelayCh = make(chan audioDelayItem, 64)
	go func() {
		for item := range audioDelayCh {
			if delay := time.Until(item.playAt); delay > 0 {
				time.Sleep(delay)
			}
			dst.Write(item.data)
		}
	}()
}



func startVideoStallWatchdog() {
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if rdpClient == nil {
				continue
			}
			lastNS := lastServerActivity.Load()
			if lastNS == 0 {
				continue
			}
			elapsed := time.Since(time.Unix(0, lastNS))
			if elapsed <= videoStallTimeout {
				continue
			}
			slog.Warn("Video stalled", "stalled", elapsed.Round(time.Millisecond))
		}
	}()
}

func update() {
	go func() {
		// pending holds a frame consumed from bitmapCH whose displayAt is
		// still in the future at the time the drain loop encountered it.
		// It is processed first on the next outer-loop iteration.
		var pending *timedBitmap
		for {
			var tb timedBitmap
			if pending != nil {
				tb = *pending
				pending = nil
			} else {
				var ok bool
				tb, ok = <-bitmapCH
				if !ok {
					return
				}
			}

			if delay := time.Until(tb.displayAt); delay > 0 {
				time.Sleep(delay)
			}
			screenMu.Lock()
			paintBitmapsLocked(tb.frames)

			// Drain any frames that are already due.  If we encounter a
			// frame whose displayAt is in the future, save it as pending
			// and repaint now — sleeping inside the drain loop would keep
			// the channel filling up indefinitely.
		drain:
			for {
				select {
				case more := <-bitmapCH:
					if time.Until(more.displayAt) > 0 {
						pending = &more
						break drain
					}
					paintBitmapsLocked(more.frames)
				default:
					break drain
				}
			}

			// Deep-copy screenImage while still holding screenMu so that the
			// GL thread gets an independent pixel buffer.
			//
			// driverc.Call is non-blocking (it enqueues to a channel).
			// CreateTexture stores the image pointer without calling
			// gl.TexImage2D; the actual upload happens lazily during the
			// GL thread's next render pass.  Without the copy, the paint
			// goroutine can loop back and write to screenImage.Pix while
			// the GL thread is still reading the same backing array, which
			// causes pixel corruption and occasional display freezes.
			snap := cloneRGBA(screenImage)
			screenMu.Unlock()

			driverc.Call(func() {
				texture := driverc.CreateTexture(snap, 1)
				img.SetTexture(texture)
			})

			// Flow control: when a video delay is configured we have a
			// known-size display buffer.  Report bitmapCH occupancy as
			// queueDepthHint so the server adjusts its send rate to match
			// our actual consumption rate.
			// • bitmapCH full  → large hint → server slows down / drops quality
			// • bitmapCH empty → hint 0    → server sends freely
			// When no delay is set we leave the hint at 0 (server uses real
			// decoder queue depth reported by GfxHandler).
			if avSyncVideoDelay > 0 && rdpClient != nil {
				rdpClient.SetQueueDepthHint(uint32(len(bitmapCH)))
			}
		}
	}()
}

// cloneRGBA returns a new *image.RGBA with the same bounds and a fresh copy
// of the pixel data.  Used to give the GL upload goroutine an independent
// buffer so that subsequent writes to screenImage.Pix do not race with the
// lazy gl.TexImage2D read on the driver thread.
func cloneRGBA(src *image.RGBA) *image.RGBA {
	dst := image.NewRGBA(src.Bounds())
	copy(dst.Pix, src.Pix)
	return dst
}

func paintBitmapsLocked(bs []grdp.Bitmap) {
	for _, bm := range bs {
		m := bm.RGBA()
		destRect := image.Rect(bm.DestLeft, bm.DestTop, bm.DestRight+1, bm.DestBottom+1)
		draw.Draw(screenImage, destRect, m, image.Pt(0, 0), draw.Src)
	}
}

func transKey(in gxui.KeyboardKey) int {
	var KeyMap = map[gxui.KeyboardKey]int{
		gxui.KeyUnknown:      0x0000,
		gxui.KeyEscape:       0x0001,
		gxui.Key1:            0x0002,
		gxui.Key2:            0x0003,
		gxui.Key3:            0x0004,
		gxui.Key4:            0x0005,
		gxui.Key5:            0x0006,
		gxui.Key6:            0x0007,
		gxui.Key7:            0x0008,
		gxui.Key8:            0x0009,
		gxui.Key9:            0x000A,
		gxui.Key0:            0x000B,
		gxui.KeyMinus:        0x000C,
		gxui.KeyEqual:        0x000D,
		gxui.KeyBackspace:    0x000E,
		gxui.KeyTab:          0x000F,
		gxui.KeyQ:            0x0010,
		gxui.KeyW:            0x0011,
		gxui.KeyE:            0x0012,
		gxui.KeyR:            0x0013,
		gxui.KeyT:            0x0014,
		gxui.KeyY:            0x0015,
		gxui.KeyU:            0x0016,
		gxui.KeyI:            0x0017,
		gxui.KeyO:            0x0018,
		gxui.KeyP:            0x0019,
		gxui.KeyLeftBracket:  0x001A,
		gxui.KeyRightBracket: 0x001B,
		gxui.KeyEnter:        0x001C,
		gxui.KeyLeftControl:  0x001D,
		gxui.KeyA:            0x001E,
		gxui.KeyS:            0x001F,
		gxui.KeyD:            0x0020,
		gxui.KeyF:            0x0021,
		gxui.KeyG:            0x0022,
		gxui.KeyH:            0x0023,
		gxui.KeyJ:            0x0024,
		gxui.KeyK:            0x0025,
		gxui.KeyL:            0x0026,
		gxui.KeySemicolon:    0x0027,
		gxui.KeyApostrophe:   0x0028,
		gxui.KeyGraveAccent:  0x0029,
		gxui.KeyLeftShift:    0x002A,
		gxui.KeyBackslash:    0x002B,
		gxui.KeyZ:            0x002C,
		gxui.KeyX:            0x002D,
		gxui.KeyC:            0x002E,
		gxui.KeyV:            0x002F,
		gxui.KeyB:            0x0030,
		gxui.KeyN:            0x0031,
		gxui.KeyM:            0x0032,
		gxui.KeyComma:        0x0033,
		gxui.KeyPeriod:       0x0034,
		gxui.KeySlash:        0x0035,
		gxui.KeyRightShift:   0x0036,
		gxui.KeyKpMultiply:   0x0037,
		gxui.KeyLeftAlt:      0x0038,
		gxui.KeySpace:        0x0039,
		gxui.KeyCapsLock:     0x003A,
		gxui.KeyF1:           0x003B,
		gxui.KeyF2:           0x003C,
		gxui.KeyF3:           0x003D,
		gxui.KeyF4:           0x003E,
		gxui.KeyF5:           0x003F,
		gxui.KeyF6:           0x0040,
		gxui.KeyF7:           0x0041,
		gxui.KeyF8:           0x0042,
		gxui.KeyF9:           0x0043,
		gxui.KeyF10:          0x0044,
		//gxui.KeyPause:        0x0045,
		gxui.KeyScrollLock:   0x0046,
		gxui.KeyKp7:          0x0047,
		gxui.KeyKp8:          0x0048,
		gxui.KeyKp9:          0x0049,
		gxui.KeyKpSubtract:   0x004A,
		gxui.KeyKp4:          0x004B,
		gxui.KeyKp5:          0x004C,
		gxui.KeyKp6:          0x004D,
		gxui.KeyKpAdd:        0x004E,
		gxui.KeyKp1:          0x004F,
		gxui.KeyKp2:          0x0050,
		gxui.KeyKp3:          0x0051,
		gxui.KeyKp0:          0x0052,
		gxui.KeyKpDecimal:    0x0053,
		gxui.KeyF11:          0x0057,
		gxui.KeyF12:          0x0058,
		gxui.KeyKpEqual:      0x0059,
		gxui.KeyKpEnter:      0xE01C,
		gxui.KeyRightControl: 0xE01D,
		gxui.KeyKpDivide:     0xE035,
		gxui.KeyPrintScreen:  0xE037,
		gxui.KeyRightAlt:     0xE038,
		gxui.KeyNumLock:      0xE045,
		gxui.KeyPause:        0xE046,
		gxui.KeyHome:         0xE047,
		gxui.KeyUp:           0xE048,
		gxui.KeyPageUp:       0xE049,
		gxui.KeyLeft:         0xE04B,
		gxui.KeyRight:        0xE04D,
		gxui.KeyEnd:          0xE04F,
		gxui.KeyDown:         0xE050,
		gxui.KeyPageDown:     0xE051,
		gxui.KeyInsert:       0xE052,
		gxui.KeyDelete:       0xE053,
		gxui.KeyMenu:         0xE05D,
	}
	if v, ok := KeyMap[in]; ok {
		return v
	}
	return 0
}

func main() {
	// handler := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug})
	// slog.SetDefault(slog.New(handler))
	gl.StartDriver(appMain)
}
