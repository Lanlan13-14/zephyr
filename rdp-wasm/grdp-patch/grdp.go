package grdp

import (
	"fmt"
	"image"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/nakagami/grdp/plugin"
	"github.com/nakagami/grdp/plugin/cliprdr"
	"github.com/nakagami/grdp/plugin/drdynvc"
	"github.com/nakagami/grdp/plugin/rdpedisp"
	"github.com/nakagami/grdp/plugin/rdpgfx"
	"github.com/nakagami/grdp/plugin/rdpsnd"

	"github.com/nakagami/grdp/core"
	"github.com/nakagami/grdp/protocol/nla"
	"github.com/nakagami/grdp/protocol/pdu"
	"github.com/nakagami/grdp/protocol/sec"
	"github.com/nakagami/grdp/protocol/t125"
	"github.com/nakagami/grdp/protocol/t125/gcc"
	"github.com/nakagami/grdp/protocol/tpkt"
	"github.com/nakagami/grdp/protocol/x224"
)

// mouseCoalescer holds all state for mouse-move coalescing.
// High-frequency move events are collapsed into at most one network PDU per
// mouseCoalesceInterval, with the latest position always winning.
type mouseCoalescer struct {
	mu      sync.Mutex
	pending bool
	x, y    int
	timer   *time.Timer
	lastTx  time.Time
	pdu     pdu.PointerEvent
	pduBuf  [1]pdu.InputEventsInterface
}

// wheelCoalescer holds all state for vertical-scroll coalescing.
// Rapid scroll events are accumulated over mouseCoalesceInterval and sent as
// a single PDU whose rotation value is the sum of all deltas in that window.
// wheelAccum is stored in RDP WHEEL_DELTA units (120 per physical notch).
type wheelCoalescer struct {
	mu     sync.Mutex
	accum  float64
	timer  *time.Timer
	lastTx time.Time
	pdu    pdu.PointerEvent
	pduBuf [1]pdu.InputEventsInterface
}

// stubChannel is a no-op virtual channel handler for channels the server
// expects to be present (e.g. rdpdr, cliprdr) but that we don't process.
type stubChannel struct {
	name   string
	option uint32
	sender core.ChannelSender
}

func (s *stubChannel) GetType() (string, uint32)   { return s.name, s.option }
func (s *stubChannel) Sender(f core.ChannelSender) { s.sender = f }
func (s *stubChannel) Process(data []byte)         {}

type RdpClient struct {
	hostPort        string // ip:port
	width           int
	height          int
	kbdLayout       uint32
	keyboardType    uint32
	keyboardSubType uint32
	tpkt            *tpkt.TPKT
	x224            *x224.X224
	mcs             *t125.MCSClient
	sec             *sec.Client
	pdu             *pdu.Client
	channels        *plugin.Channels
	eventReady     atomic.Bool
	decompressPool sync.Pool // pools []uint8 buffers for bitmap decompression
	flipLinePool   sync.Pool // pools line-sized []uint8 buffers for bitmap vertical flip
	closed         atomic.Bool

	// credentials stored for reconnection
	domain   string
	user     string
	password string

	// stored callbacks for re-registration on reconnect
	onErrorFn         func(e error)
	onCloseFn         func()
	onSuccessFn       func()
	onReadyFn         func()
	onBitmapPaintFn   func([]Bitmap)
	onPointerHideFn   func()
	onPointerCachedFn func(uint16)
	onPointerUpdateFn func(uint16, uint16, uint16, uint16, uint16, uint16, []byte, []byte)
	onAudioFn         func(rdpsnd.AudioFormat, []byte)
	onAudioResetFn    func()
	onH264RawFn       func(destX, destY, w, h int, isKey bool, data []byte)
	onH264I420Fn      func(destX, destY, w, h int, y []byte, yStride int, u []byte, uStride int, v []byte, vStride int)
	onH264NV12Fn      func(destX, destY, w, h int, y []byte, yStride int, uv []byte, uvStride int)
	onDecoderBrokenFn func()

	// clipboard callbacks and handler
	onClipboardFn  func(text string) // remote → local
	getClipboardFn func() string     // local → remote
	cliprdrHandler *cliprdr.CliprdrHandler

	// File clipboard callbacks (wired to cliprdr handler)
	onRemoteFilesFn func(files []cliprdr.ClipFile)
	getFilesFn      func() []cliprdr.ClipFile
	getFileDataFn   func(index int, offset uint64, length uint32) []byte

	// reconnectMu serialises concurrent Reconnect() calls.
	// reconnecting is also set during async server redirects to suppress
	// user-facing callbacks while the transport is being re-established.
	reconnectMu  sync.Mutex
	reconnecting atomic.Bool

	// mouse and wheel hold all coalescing state for pointer input.
	mouse mouseCoalescer
	wheel wheelCoalescer

	// gfxHandler is the active RDPGFX handler; nil when not connected.
	// Stored here so closeTransport() can stop its goroutines.
	gfxHandler *rdpgfx.GfxHandler

	// avc444Disabled, when true, limits CAPS_ADVERTISE to v8.1 so the server
	// uses AVC420 only.  Set via DisableAVC444() before Connect(); preserved
	// across reconnects.
	avc444Disabled bool

	// wallpaperEnabled, when true, clears PERF_DISABLE_WALLPAPER in the
	// Client Info PDU so the server streams the desktop wallpaper. Set via
	// SetWallpaperEnabled() before Login; preserved across reconnects and
	// re-applied to the freshly-created sec.Client in doLogin().
	wallpaperEnabled bool

	// dispHandler is the active MS-RDPEDISP handler; nil when not connected.
	// Used by SetResolution to send MONITOR_LAYOUT PDUs.
	dispHandler *rdpedisp.Handler

	dialer func(hostPort string) (net.Conn, error)

	// customDvcHandlers are registered by the caller via RegisterDvcHandler
	// and applied to the dvcClient during doLogin().
	customDvcHandlers map[string]drdynvc.DvcChannelHandler

	// customRdpdrHandler replaces the default rdpdr stub channel when set
	// via SetRdpdrHandler(). Used for MS-RDPEFS file system redirection.
	customRdpdrHandler plugin.ChannelTransport
}

const mouseCoalesceInterval = 16 * time.Millisecond

// Bitmap is a single rendered region delivered to the OnBitmap callback.
//
// Lifecycle: Bitmap.Data is borrowed from an internal buffer pool and is
// only valid for the duration of the synchronous OnBitmap callback.  After
// the callback returns the slice may be returned to the pool and overwritten
// by subsequent updates.  Callers that need to retain the pixels (e.g. to
// hand them to an asynchronous paint goroutine) MUST copy the bytes before
// the callback returns.
type Bitmap struct {
	DestLeft     int
	DestTop      int
	DestRight    int
	DestBottom   int
	Width        int
	Height       int
	BitsPerPixel int
	Data         []byte
}

// FillRGBA converts the bitmap's pixel data to RGBA format, writing into dst.
// If dst is nil or has the wrong dimensions a new *image.RGBA is allocated.
// Callers that process tiles of stable dimensions can reuse the same *image.RGBA
// across frames to avoid repeated heap allocations:
//
//	var tile *image.RGBA
//	tile = bm.FillRGBA(tile)
func (bm *Bitmap) FillRGBA(dst *image.RGBA) *image.RGBA {
	if dst == nil || dst.Bounds().Dx() != bm.Width || dst.Bounds().Dy() != bm.Height {
		dst = image.NewRGBA(image.Rect(0, 0, bm.Width, bm.Height))
	}
	pix := dst.Pix
	data := bm.Data

	// Per-format specialised loops avoid a per-pixel switch and let the
	// compiler hoist bounds checks and emit tight, branch-free inner code.
	switch bm.BitsPerPixel {
	case 1:
		// 16-bit RGB555 stored big-endian in two bytes.
		n := len(pix) >> 2
		if len(data) < n*2 {
			n = len(data) / 2
		}
		rgb555BatchToRGBA(pix, data, n)
	case 2:
		// 16-bit RGB565 stored big-endian in two bytes.
		n := len(pix) >> 2
		if len(data) < n*2 {
			n = len(data) / 2
		}
		rgb565BatchToRGBA(pix, data, n)
	default:
		// 24/32-bit BGR(A) → RGBA with stride = bm.BitsPerPixel.
		stride := bm.BitsPerPixel
		n := len(pix) >> 2
		if len(data) < n*stride {
			n = len(data) / stride
		}
		if stride == 4 {
			// BGRA32 is the common case; use the SIMD-accelerated path.
			bgr32BatchToRGBA(pix, data, n)
		} else {
			// BGR24 (stride==3) and any other depth: scalar fallback.
			// Write each pixel as a single 32-bit store to let the compiler
			// vectorise the loop (avoids 4 separate byte stores per pixel).
			for i := range n {
				s := i * stride
				*(*uint32)(unsafe.Pointer(&pix[i*4])) =
					uint32(data[s+2]) | uint32(data[s+1])<<8 | uint32(data[s])<<16 | 0xFF000000
			}
		}
	}
	return dst
}

// RGBA converts the bitmap pixel data to an *image.RGBA.
// A new *image.RGBA is allocated on each call.  If the caller processes tiles
// of the same dimensions across frames, prefer FillRGBA to avoid allocations.
func (bm *Bitmap) RGBA() *image.RGBA {
	return bm.FillRGBA(nil)
}

// SwapRB swaps the red and blue byte of every 32-bit pixel in p in place and
// forces the alpha byte to 0xFF, converting between RGBA and BGRA byte order
// (the operation is its own inverse).  It reuses the SIMD-accelerated batch
// converter (SSE2 on amd64, NEON on arm64), so callers that need BGRA pixels
// for an SDL_PIXELFORMAT_BGRA32 texture can convert an *image.RGBA buffer with
// a single vectorised pass instead of a scalar per-byte swap loop.  len(p) must
// be a multiple of 4; any trailing bytes are ignored.
func SwapRB(p []byte) {
	bgr32BatchToRGBA(p, p, len(p)/4)
}

// FillBGRA converts the bitmap pixel data into packed BGRA32 (4 bytes/pixel,
// B at offset 0) and writes it into dst, growing dst if necessary.  The caller
// may pass a previously returned slice to reuse the allocation across calls
// (common for tiled rendering where many same-sized bitmaps are converted in a
// loop). The returned slice has length == bm.Width * bm.Height * 4.
//
// Unlike RGBA() + SwapRB, FillBGRA avoids an intermediate *image.RGBA
// allocation and the second-pass R/B swap for BGR24/BGRA32 inputs.  For
// BGR24 the output is a single-pass direct pack; for BGRA32 it is a memcopy.
func (bm *Bitmap) FillBGRA(dst []byte) []byte {
	n := bm.Width * bm.Height
	need := n * 4
	if cap(dst) < need {
		dst = make([]byte, need)
	}
	dst = dst[:need]
	data := bm.Data

	switch bm.BitsPerPixel {
	case 2:
		// 16-bit RGB565: convert to RGBA then swap R↔B in-place → BGRA.
		if len(data) < n*2 {
			n = len(data) / 2
		}
		rgb565BatchToRGBA(dst, data, n)
		bgr32BatchToRGBA(dst, dst, n)
	default:
		stride := bm.BitsPerPixel
		if stride < 3 {
			stride = 4 // treat unknown as BGRA32
		}
		if stride == 4 {
			// BGRA32 source — already in the target format; bulk copy.
			if len(data) < n*4 {
				n = len(data) / 4
			}
			copy(dst[:n*4], data[:n*4])
		} else {
			// BGR24 source — pack B,G,R directly with A=0xFF; no R/B swap.
			if len(data) < n*3 {
				n = len(data) / 3
			}
			for i := range n {
				s := i * 3
				*(*uint32)(unsafe.Pointer(&dst[i*4])) =
					uint32(data[s]) | uint32(data[s+1])<<8 | uint32(data[s+2])<<16 | 0xFF000000
			}
		}
	}
	return dst
}

func NewRdpClient(host string, width, height int, dialer func(string) (net.Conn, error)) *RdpClient {
	g := &RdpClient{
		hostPort:        host,
		width:           width,
		height:          height,
		kbdLayout:       uint32(gcc.US),
		keyboardType:    uint32(gcc.KT_IBM_101_102_KEYS),
		keyboardSubType: 0,
		dialer:          dialer,
		decompressPool: sync.Pool{
			New: func() any { return []uint8(nil) },
		},
		flipLinePool: sync.Pool{
			New: func() any { return []uint8(nil) },
		},
	}
	// Point the cached single-element slices at the cached PDU fields so
	// sendMouseMoveLocked / sendWheelLocked need no per-call allocations.
	g.mouse.pduBuf[0] = &g.mouse.pdu
	g.wheel.pduBuf[0] = &g.wheel.pdu
	return g
}

var keyboardLayoutMap = map[string]uint32{
	"ARABIC":              uint32(gcc.ARABIC),
	"BULGARIAN":           uint32(gcc.BULGARIAN),
	"CHINESE_US_KEYBOARD": uint32(gcc.CHINESE_US_KEYBOARD),
	"CZECH":               uint32(gcc.CZECH),
	"DANISH":              uint32(gcc.DANISH),
	"GERMAN":              uint32(gcc.GERMAN),
	"GREEK":               uint32(gcc.GREEK),
	"US":                  uint32(gcc.US),
	"SPANISH":             uint32(gcc.SPANISH),
	"FINNISH":             uint32(gcc.FINNISH),
	"FRENCH":              uint32(gcc.FRENCH),
	"HEBREW":              uint32(gcc.HEBREW),
	"HUNGARIAN":           uint32(gcc.HUNGARIAN),
	"ICELANDIC":           uint32(gcc.ICELANDIC),
	"ITALIAN":             uint32(gcc.ITALIAN),
	"JAPANESE":            uint32(gcc.JAPANESE),
	"KOREAN":              uint32(gcc.KOREAN),
	"DUTCH":               uint32(gcc.DUTCH),
	"NORWEGIAN":           uint32(gcc.NORWEGIAN),
}

var keyboardTypeMap = map[string]uint32{
	"IBM_PC_XT_83_KEY": uint32(gcc.KT_IBM_PC_XT_83_KEY),
	"OLIVETTI":         uint32(gcc.KT_OLIVETTI),
	"IBM_PC_AT_84_KEY": uint32(gcc.KT_IBM_PC_AT_84_KEY),
	"IBM_101_102_KEYS": uint32(gcc.KT_IBM_101_102_KEYS),
	"NOKIA_1050":       uint32(gcc.KT_NOKIA_1050),
	"NOKIA_9140":       uint32(gcc.KT_NOKIA_9140),
	"JAPANESE":         uint32(gcc.KT_JAPANESE),
}

// SetKeyboardLayout sets the keyboard layout by name (e.g. "US", "FRENCH").
// Must be called before Login.
func (g *RdpClient) SetKeyboardLayout(layout string) {
	if v, ok := keyboardLayoutMap[strings.ToUpper(layout)]; ok {
		g.kbdLayout = v
	} else {
		slog.Warn("Unknown keyboard layout, falling back to US", "layout", layout)
		g.kbdLayout = uint32(gcc.US)
	}
}

// SetKeyboardType sets the keyboard type by name (e.g. "IBM_101_102_KEYS").
// Must be called before Login.
func (g *RdpClient) SetKeyboardType(keyboardType string) {
	if v, ok := keyboardTypeMap[strings.ToUpper(keyboardType)]; ok {
		g.keyboardType = v
	} else {
		slog.Warn("Unknown keyboard type, falling back to IBM_101_102_KEYS", "keyboardType", keyboardType)
		g.keyboardType = uint32(gcc.KT_IBM_101_102_KEYS)
	}
}

// DisableAVC444 prevents the client from advertising AVC444/AVC444v2 support.
// When called before Login, the RDPGFX CAPS_ADVERTISE is limited to v8.1
// (AVC420 only), so the server will never send LC=2 chroma-upgrade frames.
// This avoids the colour distortion seen with VirtualBox VRDE, which sends
// LC=2 data but does not include stream2 in LC=0 IDR packets.
// The setting is preserved across automatic reconnects.
func (g *RdpClient) DisableAVC444() *RdpClient {
	g.avc444Disabled = true
	return g
}

// SetWallpaperEnabled controls whether the server streams the desktop
// wallpaper. By default (false) the client sends PERF_DISABLE_WALLPAPER to
// save bandwidth, matching classic RDP behaviour. Pass true (e.g. in a
// "quality" mode) to clear that bit so the real wallpaper is shown. Must be
// called before Login; the setting is preserved across automatic reconnects
// and re-applied to the sec.Client created in doLogin().
func (g *RdpClient) SetWallpaperEnabled(enabled bool) *RdpClient {
	g.wallpaperEnabled = enabled
	if g.sec != nil {
		g.sec.SetWallpaperEnabled(enabled)
	}
	return g
}

// RegisterDvcHandler registers a custom Dynamic Virtual Channel handler
// that will be attached to the DVC client during connection setup.
// Must be called before Login(). The handler implements drdynvc.DvcChannelHandler.
func (g *RdpClient) RegisterDvcHandler(channelName string, handler drdynvc.DvcChannelHandler) *RdpClient {
	if g.customDvcHandlers == nil {
		g.customDvcHandlers = make(map[string]drdynvc.DvcChannelHandler)
	}
	g.customDvcHandlers[channelName] = handler
	return g
}

// SetRdpdrHandler replaces the default no-op rdpdr stub with a real
// device redirection handler (e.g. MS-RDPEFS file system).
// Must be called before Login().
func (g *RdpClient) SetRdpdrHandler(handler plugin.ChannelTransport) *RdpClient {
	g.customRdpdrHandler = handler
	return g
}

func bpp(BitsPerPixel uint16) int {
	switch BitsPerPixel {
	case 15, 16:
		return 2
	case 24:
		return 3
	case 32:
		return 4
	default:
		slog.Error("invalid bitmap data format")
		return 0
	}
}

// mouseButtonFlag returns the PTRFLAGS constant for button index 0/1/2.
func mouseButtonFlag(button int) uint16 {
	switch button {
	case 0:
		return pdu.PTRFLAGS_BUTTON1
	case 2:
		return pdu.PTRFLAGS_BUTTON2
	case 1:
		return pdu.PTRFLAGS_BUTTON3
	default:
		return pdu.PTRFLAGS_MOVE
	}
}

func (g *RdpClient) Login(domain string, user string, password string) error {
	slog.Debug("Login", "Host", g.hostPort, "domain", domain, "user", user)

	g.domain = domain
	g.user = user
	g.password = password

	return g.doLogin(nil)
}

// doLogin establishes an RDP connection.
// When routingToken is non-nil it replaces the username cookie in the
// x224 Connection Request (required for Server Redirection).
func (g *RdpClient) doLogin(routingToken []byte) error {
	conn, err := g.dialer(g.hostPort)
	if err != nil {
		return fmt.Errorf("[dial err] %v", err)
	}

	host, _, _ := net.SplitHostPort(g.hostPort)
	g.tpkt = tpkt.New(core.NewSocketLayer(conn, host), nla.NewNTLMv2(g.domain, g.user, g.password))
	g.x224 = x224.New(g.tpkt)
	g.mcs = t125.NewMCSClient(g.x224, g.kbdLayout, g.keyboardType, g.keyboardSubType)
	g.sec = sec.NewClient(g.mcs)
	// Re-apply the wallpaper preference to the freshly-created sec client so
	// it survives reconnects (doLogin runs on every connect attempt).
	g.sec.SetWallpaperEnabled(g.wallpaperEnabled)
	g.pdu = pdu.NewClient(g.sec)
	g.channels = plugin.NewChannels(g.sec)

	// Wire user-registered callbacks now that g.pdu is initialised.
	// This allows callers to invoke On* methods before Login.
	g.reregisterCallbacks()

	// Wire RemoteFX surface decoder so the pdu layer can decode
	// codecID=3 in surface bitmap commands without importing rdpgfx.
	pdu.DecodeRemoteFX = rdpgfx.DecodeSurfaceRFX

	g.mcs.SetClientDesktop(uint16(g.width), uint16(g.height))

	// Register channels in order: rdpdr, rdpsnd, cliprdr, drdynvc
	// (matching the channel order that Windows servers expect)

	// rdpdr (Device Redirection) — use custom handler if set, otherwise stub
	if g.customRdpdrHandler != nil {
		g.channels.Register(g.customRdpdrHandler)
	} else {
		g.channels.Register(&stubChannel{name: "rdpdr",
			option: plugin.CHANNEL_OPTION_INITIALIZED | plugin.CHANNEL_OPTION_ENCRYPT_RDP | plugin.CHANNEL_OPTION_COMPRESS_RDP})
	}
	g.mcs.SetClientDeviceRedirection()

	// RDPSND (Audio Output) handler — static virtual channel + DVC paths
	rdpsndHandler := rdpsnd.NewHandler(func(format rdpsnd.AudioFormat, data []byte) {
		if g.onAudioFn != nil {
			g.onAudioFn(format, data)
		}
	})
	rdpsndHandler.SetAudioResetCallback(func() {
		if g.onAudioResetFn != nil {
			g.onAudioResetFn()
		}
	})
	g.channels.Register(rdpsndHandler)
	g.mcs.SetClientSoundProtocol()

	// cliprdr (Clipboard) — cross-platform text clipboard handler
	cliprdrHandler := cliprdr.NewHandler(
		func(text string) {
			if g.onClipboardFn != nil {
				g.onClipboardFn(text)
			}
		},
		func() string {
			if g.getClipboardFn != nil {
				return g.getClipboardFn()
			}
			return ""
		},
	)
	g.cliprdrHandler = cliprdrHandler
	if g.onRemoteFilesFn != nil || g.getFilesFn != nil {
		cliprdrHandler.SetFileCallbacks(g.onRemoteFilesFn, g.getFilesFn, g.getFileDataFn)
	}
	g.channels.Register(cliprdrHandler)
	g.mcs.SetClientClipboard()

	// drdynvc (Dynamic Virtual Channels)
	dvcClient := drdynvc.NewDvcClient()
	g.channels.Register(dvcClient)
	g.mcs.SetClientDynvcProtocol()

	// RDPGFX (Graphics Pipeline) handler
	gfxHandler := rdpgfx.NewGfxHandler(func(updates []rdpgfx.BitmapUpdate) {
		if g.onBitmapPaintFn == nil {
			return
		}
		bs := make([]Bitmap, len(updates))
		for i, u := range updates {
			bs[i] = Bitmap{
				DestLeft:     u.DestLeft,
				DestTop:      u.DestTop,
				DestRight:    u.DestRight,
				DestBottom:   u.DestBottom,
				Width:        u.Width,
				Height:       u.Height,
				BitsPerPixel: u.Bpp,
				Data:         u.Data,
			}
		}
		g.onBitmapPaintFn(bs)
	})
	gfxHandler.SetDecoderBrokenCallback(func() {
		slog.Debug("H.264 decoder broken")
		if g.onDecoderBrokenFn != nil {
			g.onDecoderBrokenFn()
		}
	})
	gfxHandler.SetKeyframeRequestFunc(func() {
		slog.Debug("H.264: requesting keyframe via force refresh")
		if g.pdu != nil {
			// SendRefreshRect is silently ignored by Windows servers while
			// an H.264 video stream is active.  Use the suppress→allow
			// toggle (SendForceRefresh) which mstsc/FreeRDP rely on to
			// reliably trigger a fresh IDR.  See protocol/pdu/pdu.go.
			g.pdu.SendForceRefresh(uint16(g.width), uint16(g.height))
		}
	})
	if g.onH264RawFn != nil {
		gfxHandler.SetH264RawCallback(g.onH264RawFn)
	}
	if g.onH264I420Fn != nil {
		gfxHandler.SetI420Callback(g.onH264I420Fn)
	}
	if g.onH264NV12Fn != nil {
		gfxHandler.SetNV12Callback(g.onH264NV12Fn)
	}
	if g.avc444Disabled {
		gfxHandler.SetAVC444Disabled(true)
	}
	g.gfxHandler = gfxHandler
	dvcClient.RegisterHandler(rdpgfx.ChannelName, gfxHandler)

	// RDPEDISP (Display Update Virtual Channel) handler — allows requesting
	// a resolution change while connected (MS-RDPEDISP).  Pass the desired
	// dimensions so the handler sends an initial MONITOR_LAYOUT PDU as soon
	// as the channel opens, prompting the server to resize to g.width×g.height.
	dispHandler := rdpedisp.NewHandler(uint32(g.width), uint32(g.height))
	g.dispHandler = dispHandler
	dvcClient.RegisterHandler(rdpedisp.ChannelName, dispHandler)

	// Reject Video Optimized Remoting (VOR) channels so the server keeps
	// sending video through the RDPGFX pipeline which we do handle.
	// Without this, the server detects video playback (e.g. YouTube) and
	// switches to VOR channels that we don't implement, causing the video
	// to freeze while audio continues.
	dvcClient.RegisterRejectedChannel("Microsoft::Windows::RDS::Video::Control::v08.01")
	dvcClient.RegisterRejectedChannel("Microsoft::Windows::RDS::Video::Data::v08.01")
	dvcClient.RegisterRejectedChannel("Microsoft::Windows::RDS::Geometry::v08.01")

	// Register DVC audio handlers for both the lossless and lossy variants.
	// gnome-remote-desktop requests AUDIO_PLAYBACK_LOSSY_DVC first; if it is
	// rejected, gnome-remote-desktop triggers its SVC fallback path which also
	// sets prevent_dvc_initialization=true, silently blocking AUDIO_PLAYBACK_DVC
	// as well — leaving the client with no audio at all.
	// By accepting both channels with the same rdpsnd handler, format negotiation
	// (which only advertises PCM) ensures PCM is used regardless of which channel
	// gnome-remote-desktop chooses.
	dvcClient.RegisterHandler("AUDIO_PLAYBACK_DVC", rdpsnd.NewDvcAdapter(rdpsndHandler))
	dvcClient.RegisterHandler("AUDIO_PLAYBACK_LOSSY_DVC", rdpsnd.NewDvcAdapter(rdpsndHandler))

	// Apply custom DVC handlers registered by the caller via RegisterDvcHandler.
	for name, handler := range g.customDvcHandlers {
		dvcClient.RegisterHandler(name, handler)
	}

	g.sec.SetUser(g.user)
	g.sec.SetPwd(g.password)
	g.sec.SetDomain(g.domain)

	g.tpkt.SetFastPathListener(g.sec)
	g.sec.SetFastPathListener(g.pdu)
	g.sec.SetChannelSender(g.mcs)
	g.channels.SetChannelSender(g.sec)

	// Wire fast-path output: pdu → sec → tpkt.  This enables the much
	// shorter Fast-Path Client Input PDU framing for mouse/keyboard events
	// (MS-RDPBCGR §2.2.8.1.2).  Use is gated at runtime both by capability
	// negotiation in the PDU layer and by sec.SendFastPath itself, which
	// refuses when legacy RDP encryption is in effect.
	g.sec.SetFastPathSender(g.tpkt)
	g.pdu.SetFastPathSender(g.sec)

	g.x224.SetRequestedProtocol(x224.PROTOCOL_SSL | x224.PROTOCOL_HYBRID)
	if routingToken != nil {
		g.x224.SetRoutingToken(routingToken)
	} else {
		g.x224.SetUsername(g.user)
	}

	err = g.x224.Connect()
	if err != nil {
		return fmt.Errorf("[x224 connect err] %v", err)
	}

	// Wait for the RDP handshake to complete or fail.
	// Events arrive asynchronously from the TPKT read goroutine.
	type connResult struct {
		err      error
		redirect *pdu.ServerRedirectionPDU
	}

	ch := make(chan connResult, 4)
	send := func(r connResult) {
		select {
		case ch <- r:
		default:
		}
	}

	// readyFired is set by the "ready" callback. All emitter callbacks
	// run synchronously on the TPKT read goroutine, so no mutex needed.
	readyFired := false

	g.pdu.On("ready", func() {
		g.eventReady.Store(true)
		readyFired = true
		send(connResult{})
	})

	g.pdu.On("error", func(err error) {
		if !readyFired {
			send(connResult{err: err})
		} else {
			// Mid-session error: stop accepting input so we don't
			// try to write to the now-dead transport.
			g.eventReady.Store(false)
		}
	})

	// Redirect may arrive before or after "ready".
	// Before ready: send to channel for synchronous handling.
	// After ready: launch async goroutine (GNOME Remote Desktop
	// sends redirect ~5s after the GFX retry's "ready").
	g.pdu.Once("redirect", func(redir *pdu.ServerRedirectionPDU) {
		if !readyFired {
			send(connResult{redirect: redir})
		} else {
			go g.handleRedirect(redir)
		}
	})

	// DeactivateAllPDU during an active session means the server is
	// reactivating (e.g. desktop resize). Pause input until "ready"
	// fires again after the reactivation handshake completes.
	g.pdu.On("deactivateAll", func() {
		g.eventReady.Store(false)
	})

	select {
	case r := <-ch:
		if r.err != nil {
			g.tpkt.Close()
			return fmt.Errorf("[connection err] %v", r.err)
		}
		if r.redirect != nil {
			slog.Debug("Server redirect", "loadBalanceInfo", string(r.redirect.LoadBalanceInfo))
			g.tpkt.Close()
			g.eventReady.Store(false)
			return g.doLogin(r.redirect.LoadBalanceInfo)
		}
		// "ready" received — session established.
		return nil
	case <-time.After(30 * time.Second):
		g.tpkt.Close()
		return fmt.Errorf("[connection timeout]")
	}
}

// handleRedirect handles a Server Redirection PDU that arrives after
// "ready" (e.g. GNOME Remote Desktop). Runs asynchronously.
func (g *RdpClient) handleRedirect(redir *pdu.ServerRedirectionPDU) {
	slog.Debug("Async server redirect", "loadBalanceInfo", string(redir.LoadBalanceInfo))
	g.reconnecting.Store(true)
	g.tpkt.Close()
	g.eventReady.Store(false)

	err := g.doLogin(redir.LoadBalanceInfo)
	g.reconnecting.Store(false)
	if err != nil {
		slog.Error("handleRedirect: login failed", "err", err)
		if g.onErrorFn != nil {
			g.onErrorFn(err)
		}
		return
	}
	g.reregisterCallbacks()
}

func (g *RdpClient) Width() int {
	return g.width
}

func (g *RdpClient) Height() int {
	return g.height
}

func (g *RdpClient) OnError(f func(e error)) *RdpClient {
	g.onErrorFn = f
	if g.pdu != nil {
		g.pdu.On("error", func(e error) {
			if !g.reconnecting.Load() {
				f(e)
			}
		})
	}
	return g
}

func (g *RdpClient) OnClose(f func()) *RdpClient {
	g.onCloseFn = f
	if g.pdu != nil {
		g.pdu.On("close", func() {
			if !g.reconnecting.Load() {
				f()
			}
		})
	}
	return g
}

func (g *RdpClient) OnSuccess(f func()) *RdpClient {
	g.onSuccessFn = f
	if g.sec != nil {
		g.sec.On("success", f)
	}
	return g
}

func (g *RdpClient) OnReady(f func()) *RdpClient {
	g.onReadyFn = f
	if g.pdu != nil {
		g.pdu.On("ready", f)
	}
	return g
}

// OnBitmap registers a callback for bitmap update events.
// For compressed bitmaps, Bitmap.Data is borrowed from an internal pool and
// is valid only for the duration of the paint call. If you need to retain
// the raw pixel data beyond paint, copy it or call bm.RGBA() inside paint.
func (g *RdpClient) OnBitmap(paint func([]Bitmap)) *RdpClient {
	g.onBitmapPaintFn = paint
	if g.pdu == nil {
		return g
	}
	g.pdu.On("bitmap", func(rectangles []pdu.BitmapData) {
		bs := make([]Bitmap, 0, len(rectangles))
		var pooled [][]uint8 // track buffers borrowed from pool

		for _, v := range rectangles {
			data := v.BitmapDataStream
			Bpp := bpp(v.BitsPerPixel)

			if v.Flags&pdu.BITMAP_NO_PROCESSING != 0 {
				// Surface command: data is already decoded top-down BGRA
			} else if v.IsCompress() {
				buf := g.decompressPool.Get().([]uint8)
				buf = core.DecompressInto(v.BitmapDataStream, buf, int(v.Width), int(v.Height), Bpp)
				data = buf
				pooled = append(pooled, buf)
			} else {
				// Uncompressed bitmaps are bottom-up; flip to top-down.
				stride := int(v.Width) * Bpp
				h := int(v.Height)
				tmp := g.flipLinePool.Get().([]byte)
				if cap(tmp) < stride {
					tmp = make([]byte, stride)
				} else {
					tmp = tmp[:stride]
				}
				for y := 0; y < h/2; y++ {
					top := y * stride
					bot := (h - 1 - y) * stride
					copy(tmp, data[top:top+stride])
					copy(data[top:top+stride], data[bot:bot+stride])
					copy(data[bot:bot+stride], tmp)
				}
				g.flipLinePool.Put(tmp[:cap(tmp)])
			}

			b := Bitmap{int(v.DestLeft), int(v.DestTop), int(v.DestRight), int(v.DestBottom),
				int(v.Width), int(v.Height), Bpp, data}
			bs = append(bs, b)
		}
		paint(bs)

		for _, buf := range pooled {
			g.decompressPool.Put(buf[:cap(buf)])
		}
	})
	return g
}

func (g *RdpClient) OnPointerHide(f func()) *RdpClient {
	g.onPointerHideFn = f
	if g.pdu != nil {
		g.pdu.On("pointer_hide", f)
	}
	return g
}

func (g *RdpClient) OnPointerCached(f func(uint16)) *RdpClient {
	g.onPointerCachedFn = f
	if g.pdu != nil {
		g.pdu.On("pointer_cached", f)
	}
	return g
}

func (g *RdpClient) OnPointerUpdate(f func(uint16, uint16, uint16, uint16, uint16, uint16, []byte, []byte)) *RdpClient {
	g.onPointerUpdateFn = f
	if g.pdu != nil {
		g.pdu.On("pointer_update", func(p *pdu.FastPathUpdatePointerPDU) {
			w := int(p.Width)
			h := int(p.Height)

			// XOR mask data is stored bottom-up per MS-RDPBCGR spec; flip to top-down.
			// Stride is padded to a 2-byte boundary.
			var xorData []byte
			if len(p.Data) > 0 && h > 0 && w > 0 {
				xorBpp := int(p.XorBpp)
				if xorBpp == 0 {
					xorBpp = 1
				}
				xorStride := ((w*xorBpp + 15) / 16) * 2
				xorData = make([]byte, len(p.Data))
				copy(xorData, p.Data)
				tmp := make([]byte, xorStride)
				for y := 0; y < h/2; y++ {
					top := y * xorStride
					bot := (h - 1 - y) * xorStride
					if top+xorStride <= len(xorData) && bot+xorStride <= len(xorData) {
						copy(tmp, xorData[top:top+xorStride])
						copy(xorData[top:top+xorStride], xorData[bot:bot+xorStride])
						copy(xorData[bot:bot+xorStride], tmp)
					}
				}
			} else {
				xorData = p.Data
			}

			// AND mask data is also bottom-up; flip to top-down.
			// Stride is 1-bpp padded to a 2-byte boundary.
			var andMask []byte
			if len(p.Mask) > 0 && h > 0 && w > 0 {
				andStride := ((w + 15) / 16) * 2
				andMask = make([]byte, len(p.Mask))
				copy(andMask, p.Mask)
				tmp := make([]byte, andStride)
				for y := 0; y < h/2; y++ {
					top := y * andStride
					bot := (h - 1 - y) * andStride
					if top+andStride <= len(andMask) && bot+andStride <= len(andMask) {
						copy(tmp, andMask[top:top+andStride])
						copy(andMask[top:top+andStride], andMask[bot:bot+andStride])
						copy(andMask[bot:bot+andStride], tmp)
					}
				}
			} else {
				andMask = p.Mask
			}

			f(p.CacheIdx, p.XorBpp, p.X, p.Y, p.Width, p.Height, andMask, xorData)
		})
	}
	return g
}

// OnAudio registers a callback for server audio data.
// The callback receives the AudioFormat describing the PCM data and the raw audio bytes.
// Must be called before Login.
func (g *RdpClient) OnAudio(f func(rdpsnd.AudioFormat, []byte)) *RdpClient {
	g.onAudioFn = f
	return g
}

// OnAudioReset registers a callback that is called when the server closes the
// audio channel (e.g. media seek or stream restart). The application should
// flush its audio playback buffer so that stale audio does not keep playing.
// Must be called before Login.
func (g *RdpClient) OnAudioReset(f func()) *RdpClient {
	g.onAudioResetFn = f
	return g
}

// OnH264Raw registers a callback that receives raw H.264 NAL unit data when
// the built-in decoder is unavailable (e.g. WASM builds without CGo).
// destX, destY are the top-left canvas coordinates; isKey flags an IDR frame.
// The caller owns data and may retain it beyond the callback.
func (g *RdpClient) OnH264Raw(fn func(destX, destY, w, h int, isKey bool, data []byte)) *RdpClient {
	g.onH264RawFn = fn
	return g
}

// OnH264I420 registers a callback that receives decoded H.264 frames in I420
// planar format (Y, U, V planes with associated strides).  When set, the
// decoded frame is NOT delivered via OnBitmap; the caller is responsible for
// rendering it directly (e.g. via an SDL2 IYUV texture for GPU-accelerated
// YUV→RGB conversion).  When I420 extraction is unavailable for a frame
// (e.g. non-YUV420P/NV12 formats), grdp falls back to OnBitmap delivery.
// destX, destY are top-left canvas coordinates; w, h are frame dimensions.
// The plane slices are only valid for the duration of the callback; copy them
// if they need to be retained beyond the callback's return.
func (g *RdpClient) OnH264I420(fn func(destX, destY, w, h int, y []byte, yStride int, u []byte, uStride int, v []byte, vStride int)) *RdpClient {
	g.onH264I420Fn = fn
	if g.gfxHandler != nil {
		g.gfxHandler.SetI420Callback(fn)
	}
	return g
}

// OnH264NV12 registers a callback that receives decoded H.264 frames in NV12
// format (Y plane plus interleaved UV plane).  This is the fastest SDL2 path
// on platforms whose hardware decoder already outputs NV12 (notably macOS
// VideoToolbox), because callers can upload the planes directly with an NV12
// texture and avoid NV12->I420 deinterleaving in grdp.  When NV12 extraction
// is unavailable for a frame, grdp falls back to OnBitmap delivery.
// destX, destY are top-left canvas coordinates; w, h are frame dimensions.
// The plane slices are only valid for the duration of the callback; copy them
// if they need to be retained beyond the callback's return.
func (g *RdpClient) OnH264NV12(fn func(destX, destY, w, h int, y []byte, yStride int, uv []byte, uvStride int)) *RdpClient {
	g.onH264NV12Fn = fn
	if g.gfxHandler != nil {
		g.gfxHandler.SetNV12Callback(fn)
	}
	return g
}

// OnDecoderBroken registers a callback that is invoked when the H.264 decoder
// enters an unrecoverable state (all hard-reset attempts exhausted).  When
// this callback is set, grdp does NOT automatically call Reconnect; the
// application is responsible for deciding when to reconnect (e.g. via its
// own stall watchdog).  If no callback is registered, grdp falls back to
// the previous behaviour of reconnecting immediately.
func (g *RdpClient) OnDecoderBroken(f func()) *RdpClient {
	g.onDecoderBrokenFn = f
	return g
}

// OnClipboard registers callbacks for bidirectional clipboard sharing.
//
//   - onRemote is called with the text when the RDP server's clipboard
//     content is received (server → client).
//   - getLocal is called to retrieve the current local clipboard text
//     when the server requests it (client → server).
//
// Must be called before Login.
func (g *RdpClient) OnClipboard(onRemote func(text string), getLocal func() string) *RdpClient {
	g.onClipboardFn = onRemote
	g.getClipboardFn = getLocal
	return g
}

// OnFileClipboard sets callbacks for file clipboard operations.
// onRemoteFiles is called when the server advertises files on the clipboard.
// getFiles returns the list of local files available for the server.
// getFileData returns file content for a given file index, offset, and length.
func (g *RdpClient) OnFileClipboard(
	onRemoteFiles func(files []cliprdr.ClipFile),
	getFiles func() []cliprdr.ClipFile,
	getFileData func(index int, offset uint64, length uint32) []byte,
) *RdpClient {
	g.onRemoteFilesFn = onRemoteFiles
	g.getFilesFn = getFiles
	g.getFileDataFn = getFileData
	if g.cliprdrHandler != nil {
		g.cliprdrHandler.SetFileCallbacks(onRemoteFiles, getFiles, getFileData)
	}
	return g
}

// NotifyLocalFilesChanged tells the server that local files are available
// on the clipboard (triggers FORMAT_LIST with FileGroupDescriptorW).
func (g *RdpClient) NotifyLocalFilesChanged() {
	if g.cliprdrHandler != nil {
		g.cliprdrHandler.SendLocalFilesFormatList()
	}
}

// DownloadServerFile downloads a file from the server's clipboard by index.
func (g *RdpClient) DownloadServerFile(index int) []byte {
	if g.cliprdrHandler != nil {
		return g.cliprdrHandler.DownloadServerFile(index)
	}
	return nil
}

// GetServerClipboardFiles returns the server's advertised file list.
func (g *RdpClient) GetServerClipboardFiles() []cliprdr.ClipFile {
	if g.cliprdrHandler != nil {
		return g.cliprdrHandler.GetServerFiles()
	}
	return nil
}

// NotifyClipboardChanged tells the server that the local clipboard has
// changed.  The UI should call this when it detects a system clipboard
// change (e.g. via polling or a platform clipboard-change signal).
func (g *RdpClient) NotifyClipboardChanged() {
	if g.cliprdrHandler != nil {
		g.cliprdrHandler.OnLocalClipboardChanged()
	}
}

func (g *RdpClient) notifyGfxLocalInput() {
	if gfx := g.gfxHandler; gfx != nil {
		gfx.NotifyLocalInput()
	}
}

func (g *RdpClient) KeyUp(sc int) {
	if !g.eventReady.Load() {
		return
	}
	slog.Debug("KeyUp", "sc", sc)
	g.flushMouseMove()
	g.flushWheel()

	p := &pdu.ScancodeKeyEvent{}
	p.KeyCode = uint16(sc)
	p.KeyboardFlags |= pdu.KBDFLAGS_RELEASE
	g.pdu.SendInputEvents(pdu.INPUT_EVENT_SCANCODE, []pdu.InputEventsInterface{p})
	g.notifyGfxLocalInput()
}

func (g *RdpClient) KeyDown(sc int) {
	if !g.eventReady.Load() {
		return
	}
	slog.Debug("KeyDown", "sc", sc)
	g.flushMouseMove()
	g.flushWheel()

	p := &pdu.ScancodeKeyEvent{}
	p.KeyCode = uint16(sc)
	g.pdu.SendInputEvents(pdu.INPUT_EVENT_SCANCODE, []pdu.InputEventsInterface{p})
	g.notifyGfxLocalInput()
}

// MouseMove queues a mouse-move event.  Successive moves within
// mouseCoalesceInterval are collapsed: only the latest (x,y) is sent.  The
// first move in a burst is sent immediately so the server sees no extra
// latency for a single isolated motion.
func (g *RdpClient) MouseMove(x, y int) {
	if !g.eventReady.Load() {
		return
	}

	g.mouse.mu.Lock()
	g.mouse.x = x
	g.mouse.y = y
	g.mouse.pending = true

	now := time.Now()
	since := now.Sub(g.mouse.lastTx)
	if since >= mouseCoalesceInterval {
		// Throttle window has elapsed — send right away.
		g.sendMouseMoveLocked(now)
		g.mouse.mu.Unlock()
		return
	}

	// Within throttle window: schedule a flush for the remainder of it
	// (unless one is already scheduled).
	if g.mouse.timer == nil {
		delay := mouseCoalesceInterval - since
		g.mouse.timer = time.AfterFunc(delay, g.flushMouseMoveTimer)
	}
	g.mouse.mu.Unlock()
}

// flushMouseMove sends any pending mouse-move event synchronously.  Called
// before any non-move input event to preserve server-side ordering.
func (g *RdpClient) flushMouseMove() {
	g.mouse.mu.Lock()
	if g.mouse.timer != nil {
		g.mouse.timer.Stop()
		g.mouse.timer = nil
	}
	if g.mouse.pending {
		g.sendMouseMoveLocked(time.Now())
	}
	g.mouse.mu.Unlock()
}

// flushMouseMoveTimer is the time.AfterFunc callback.  Acquires the lock
// itself and sends whatever's pending.
func (g *RdpClient) flushMouseMoveTimer() {
	g.mouse.mu.Lock()
	g.mouse.timer = nil
	if g.mouse.pending && g.eventReady.Load() {
		g.sendMouseMoveLocked(time.Now())
	}
	g.mouse.mu.Unlock()
}

// sendMouseMoveLocked must be called with mouse.mu held.
func (g *RdpClient) sendMouseMoveLocked(now time.Time) {
	g.mouse.pdu.PointerFlags = pdu.PTRFLAGS_MOVE
	g.mouse.pdu.XPos = uint16(g.mouse.x)
	g.mouse.pdu.YPos = uint16(g.mouse.y)
	g.mouse.pending = false
	g.mouse.lastTx = now
	g.pdu.SendInputEvents(pdu.INPUT_EVENT_MOUSE, g.mouse.pduBuf[:])
}

// MouseWheel sends a vertical scroll event to the remote desktop.
// delta is the rotation amount in physical notches (1.0 = one click of a
// scroll wheel = Windows WHEEL_DELTA).  Fractional values are accepted for
// smooth / high-resolution input devices such as trackpads.
// Positive values scroll up (away from the user); negative values scroll down.
func (g *RdpClient) MouseWheel(delta float64) {
	if !g.eventReady.Load() {
		return
	}
	slog.Debug("MouseWheel", "delta", delta)
	g.flushMouseMove()

	// Convert notch count to RDP WHEEL_DELTA units (120 per notch).
	const wheelDelta = 120
	g.wheel.mu.Lock()
	g.wheel.accum += delta * wheelDelta
	if g.wheel.accum == 0 {
		// Opposite deltas cancelled out; nothing to send.
		g.wheel.mu.Unlock()
		return
	}

	now := time.Now()
	since := now.Sub(g.wheel.lastTx)
	if since >= mouseCoalesceInterval {
		g.sendWheelLocked(now)
		g.wheel.mu.Unlock()
		return
	}

	if g.wheel.timer == nil {
		delay := mouseCoalesceInterval - since
		g.wheel.timer = time.AfterFunc(delay, g.flushWheelTimer)
	}
	g.wheel.mu.Unlock()
}

// flushWheel sends any pending wheel event synchronously.  Called before any
// non-wheel input event to preserve server-side ordering.
func (g *RdpClient) flushWheel() {
	g.wheel.mu.Lock()
	if g.wheel.timer != nil {
		g.wheel.timer.Stop()
		g.wheel.timer = nil
	}
	if g.wheel.accum != 0 {
		g.sendWheelLocked(time.Now())
	}
	g.wheel.mu.Unlock()
}

// flushWheelTimer is the time.AfterFunc callback for wheel coalescing.
func (g *RdpClient) flushWheelTimer() {
	g.wheel.mu.Lock()
	g.wheel.timer = nil
	if g.wheel.accum != 0 && g.eventReady.Load() {
		g.sendWheelLocked(time.Now())
	}
	g.wheel.mu.Unlock()
}

// sendWheelLocked must be called with wheel.mu held.
// Modelled on FreeRDP's send_mouse_wheel in client/SDL/SDL2/sdl_touch.cpp.
func (g *RdpClient) sendWheelLocked(now time.Time) {
	// Truncate the accumulated float to a whole WHEEL_DELTA integer; keep the
	// fractional remainder so sub-notch trackpad movements aren't discarded.
	iaccum := int(g.wheel.accum)
	g.wheel.accum -= float64(iaccum)
	g.wheel.lastTx = now

	if iaccum == 0 {
		return
	}

	negative := iaccum < 0
	if negative {
		iaccum = -iaccum
	}

	baseFlags := uint16(pdu.PTRFLAGS_WHEEL)
	if negative {
		baseFlags |= uint16(pdu.PTRFLAGS_WHEEL_NEGATIVE)
	}

	// The WheelRotation field is 9 bits.  Bits 0–7 hold the unsigned
	// magnitude (max 0xFF per event); bit 8 is the sign (PTRFLAGS_WHEEL_NEGATIVE).
	// For negative values the receiver computes -(0x100 - bits[0:7]), so we
	// must store the 9-bit two's-complement form, not the raw magnitude.
	// Send as many 0xFF-capped events as needed (same loop as FreeRDP).
	for iaccum > 0 {
		cval := min(iaccum, 0xFF)
		iaccum -= cval

		if negative {
			// 9-bit two's complement: keep flags in bits 8–15, set bits 0–7
			// to (0x100 - cval) so the receiver recovers the correct magnitude.
			g.wheel.pdu.PointerFlags = (baseFlags & 0xFF00) | uint16(0x100-cval)
		} else {
			g.wheel.pdu.PointerFlags = baseFlags | uint16(cval)
		}
		g.pdu.SendInputEvents(pdu.INPUT_EVENT_MOUSE, g.wheel.pduBuf[:])
	}
	g.notifyGfxLocalInput()
}

func (g *RdpClient) MouseUp(button int, x, y int) {
	if !g.eventReady.Load() {
		return
	}
	slog.Debug("MouseUp", "x", x, "y", y, "button", button)
	g.flushMouseMove()
	g.flushWheel()
	p := &pdu.PointerEvent{}
	p.PointerFlags = mouseButtonFlag(button)
	p.XPos = uint16(x)
	p.YPos = uint16(y)
	g.pdu.SendInputEvents(pdu.INPUT_EVENT_MOUSE, []pdu.InputEventsInterface{p})
	g.notifyGfxLocalInput()
}

func (g *RdpClient) MouseDown(button int, x, y int) {
	if !g.eventReady.Load() {
		return
	}
	slog.Debug("MouseDown", "x", x, "y", y, "button", button)
	g.flushMouseMove()
	g.flushWheel()
	p := &pdu.PointerEvent{}
	p.PointerFlags = pdu.PTRFLAGS_DOWN | mouseButtonFlag(button)
	p.XPos = uint16(x)
	p.YPos = uint16(y)
	g.pdu.SendInputEvents(pdu.INPUT_EVENT_MOUSE, []pdu.InputEventsInterface{p})
	g.notifyGfxLocalInput()
}

// SetResolution requests a desktop resolution change via the MS-RDPEDISP
// Display Update Virtual Channel.  The server will reshape the desktop to the
// given dimensions and send a fresh RDPGFX ResetGraphics command.
//
// width must be even and both width and height must be >= 200.
// This method is a no-op when the RDPEDISP channel has not been established
// (e.g. when the server does not support it).
func (g *RdpClient) SetResolution(width, height int) {
	if g.dispHandler == nil {
		slog.Warn("SetResolution: RDPEDISP channel not available")
		return
	}
	w := uint32(width)
	if w%2 != 0 {
		w++
	}
	w = max(w, 200)
	h := uint32(height)
	h = max(h, 200)
	g.dispHandler.SendMonitorLayout([]rdpedisp.Monitor{
		{
			Flags:              rdpedisp.MonitorFlagPrimary,
			Left:               0,
			Top:                0,
			Width:              w,
			Height:             h,
			PhysicalWidth:      0,
			PhysicalHeight:     0,
			Orientation:        0,
			DesktopScaleFactor: 100,
			DeviceScaleFactor:  100,
		},
	})
	slog.Debug("SetResolution", "width", w, "height", h)
}

// SetQueueDepthHint controls the frame-rate and encoding quality reported to
// the server via the RDPGFX FRAME_ACKNOWLEDGE queueDepth field
// (MS-RDPEGFX 2.2.2.8).
//
// A higher value signals a larger client decode backlog, causing the server to
// slow down or reduce H.264/RFX encoding quality.  0 (default) means "report
// the real decode-queue length" — no artificial throttling.
//
// Typical values: 0 = off, 10–50 = moderate throttle, 100+ = heavy throttle.
// Use 0xFFFFFFFF to pause new frames entirely (the stream resumes when hint is
// reduced or cleared).
func (g *RdpClient) SetQueueDepthHint(depth uint32) {
	if g.gfxHandler != nil {
		g.gfxHandler.SetQueueDepthHint(depth)
	}
}

func (g *RdpClient) Reconnect(width, height int) error {
	if g.closed.Load() {
		return fmt.Errorf("client is closed")
	}

	g.reconnectMu.Lock()
	defer g.reconnectMu.Unlock()

	g.reconnecting.Store(true)
	defer func() { g.reconnecting.Store(false) }()

	slog.Debug("Reconnect", "width", width, "height", height)
	g.closeTransport()
	g.width = width
	g.height = height
	g.eventReady.Store(false)

	const maxRetries = 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		// No delay on the first attempt: the transport was already closed above
		// so the server has already started session teardown.  Use exponential
		// backoff (1s, 2s) only for retries after a failed login.
		delay := time.Duration(0)
		if attempt > 1 {
			delay = time.Duration(1<<uint(attempt-2)) * time.Second
		}
		slog.Debug("Reconnect: waiting before attempt", "attempt", attempt, "delay", delay)
		time.Sleep(delay)

		err := g.Login(g.domain, g.user, g.password)
		if err != nil {
			slog.Warn("Reconnect: login failed", "attempt", attempt, "err", err)
			if attempt < maxRetries {
				g.closeTransport()
				continue
			}
			return fmt.Errorf("[reconnect err] %v", err)
		}

		slog.Debug("Reconnect: succeeded", "attempt", attempt)
		return nil
	}

	return fmt.Errorf("[reconnect failed after %d attempts]", maxRetries)
}

func (g *RdpClient) reregisterCallbacks() {
	if g.onErrorFn != nil {
		g.OnError(g.onErrorFn)
	}
	if g.onCloseFn != nil {
		g.OnClose(g.onCloseFn)
	}
	if g.onSuccessFn != nil {
		g.OnSuccess(g.onSuccessFn)
	}
	if g.onReadyFn != nil {
		g.OnReady(g.onReadyFn)
	}
	if g.onBitmapPaintFn != nil {
		g.OnBitmap(g.onBitmapPaintFn)
	}
	if g.onPointerHideFn != nil {
		g.OnPointerHide(g.onPointerHideFn)
	}
	if g.onPointerCachedFn != nil {
		g.OnPointerCached(g.onPointerCachedFn)
	}
	if g.onPointerUpdateFn != nil {
		g.OnPointerUpdate(g.onPointerUpdateFn)
	}
	if g.onAudioResetFn != nil {
		g.OnAudioReset(g.onAudioResetFn)
	}
	if g.onDecoderBrokenFn != nil {
		g.OnDecoderBroken(g.onDecoderBrokenFn)
	}
}

// closeTransport closes the underlying transport and stops any active GFX handler.
func (g *RdpClient) closeTransport() {
	if g.gfxHandler != nil {
		g.gfxHandler.Close()
		g.gfxHandler = nil
	}
	if g.tpkt != nil {
		g.tpkt.Close()
	}
}

func (g *RdpClient) Close() {
	slog.Debug("Close()")
	g.closed.Store(true)
	g.closeTransport()
}
