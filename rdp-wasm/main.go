//go:build js && wasm

package main

import (
	"fmt"
	"log/slog"
	"net"
	"sync"
	"syscall/js"
	"time"

	"github.com/nakagami/grdp"
	"github.com/nakagami/grdp/plugin/cliprdr"
	"github.com/nakagami/grdp/plugin/rdpsnd"
)

var (
	rdpClient      *grdp.RdpClient
	connectGen     uint64
	clientMu       sync.Mutex
	localClipboard string
	clipMu         sync.Mutex
	swapAltMeta    bool
	audinHandler   *AudinHandler
	rdpelHandler   *RdpelHandler
	rdpefsHandler  *RdpefsHandler

	// Cache for file data read from JS — avoids re-copying the entire file
	// from JS→Go on every FILECONTENTS_RANGE chunk request.
	fileDataCache    map[string][]byte
	fileDataCacheMu  sync.Mutex
	camEnumHandler   *CamEnumeratorHandler
	camStreamHandler *CamStreamHandler
)

func isCurrentClient(gen uint64, c *grdp.RdpClient) bool {
	clientMu.Lock()
	defer clientMu.Unlock()
	return connectGen == gen && rdpClient == c
}

func currentClient() *grdp.RdpClient {
	clientMu.Lock()
	defer clientMu.Unlock()
	return rdpClient
}

func main() {
	js.Global().Set("rdpConnect", js.FuncOf(jsConnect))
	js.Global().Set("rdpDisconnect", js.FuncOf(jsDisconnect))
	js.Global().Set("rdpMouseMove", js.FuncOf(jsMouseMove))
	js.Global().Set("rdpMouseDown", js.FuncOf(jsMouseDown))
	js.Global().Set("rdpMouseUp", js.FuncOf(jsMouseUp))
	js.Global().Set("rdpMouseWheel", js.FuncOf(jsMouseWheel))
	js.Global().Set("rdpMouseHScroll", js.FuncOf(jsMouseHScroll))
	js.Global().Set("rdpKeyDown", js.FuncOf(jsKeyDown))
	js.Global().Set("rdpKeyUp", js.FuncOf(jsKeyUp))
	js.Global().Set("rdpClipboardChanged", js.FuncOf(jsClipboardChanged))
	js.Global().Set("rdpClipboardChangedSync", js.FuncOf(jsClipboardChangedSync))
	js.Global().Set("rdpNotifyFilesChanged", js.FuncOf(jsNotifyFilesChanged))
	js.Global().Set("rdpDownloadServerFile", js.FuncOf(jsDownloadServerFile))
	js.Global().Set("rdpGetServerFiles", js.FuncOf(jsGetServerFiles))
	js.Global().Set("rdpAudinData", js.FuncOf(jsAudinData))
	js.Global().Set("rdpLocationData", js.FuncOf(jsLocationData))
	js.Global().Set("rdpCameraFrame", js.FuncOf(jsCameraFrame))
	js.Global().Set("rdpGfxCompleteFrame", js.FuncOf(jsGfxCompleteFrame))
	js.Global().Set("rdpRequestFullRefresh", js.FuncOf(jsRequestFullRefresh))

	// Agent drive management (hot-plug)
	js.Global().Set("rdpFsAttachDrive", js.FuncOf(jsAttachDrive))
	js.Global().Set("rdpFsDetachDrive", js.FuncOf(jsDetachDrive))
	js.Global().Set("rdpFsListDrives", js.FuncOf(jsListDrives))

	// Block forever — JS callbacks keep things alive.
	select {}
}

// jsConnect is called from JS: rdpConnect(proxyWsURL, host, port, domain, user, password, width, height, swapAltMeta)
// jsConnect: rdpConnect(proxyWsURL, host, port, domain, user, password, width, height, swapAltMeta, micEnabled, locationEnabled, storageEnabled, cameraEnabled, wallpaper)
func jsConnect(_ js.Value, args []js.Value) any {
	if len(args) < 8 {
		return fmt.Sprintf("usage: rdpConnect(proxyWsURL, host, port, domain, user, password, width, height[, ...])")
	}
	proxyWsURL := args[0].String()
	host := args[1].String()
	port := args[2].String()
	domain := args[3].String()
	user := args[4].String()
	password := args[5].String()
	width := args[6].Int()
	height := args[7].Int()
	if len(args) >= 9 {
		swapAltMeta = args[8].Bool()
	} else {
		swapAltMeta = false
	}
	micEnabled := false
	if len(args) >= 10 {
		micEnabled = args[9].Bool()
	}
	locationEnabled := false
	if len(args) >= 11 {
		locationEnabled = args[10].Bool()
	}
	storageEnabled := false
	if len(args) >= 12 {
		storageEnabled = args[11].Bool()
	}
	cameraEnabled := false
	if len(args) >= 13 {
		cameraEnabled = args[12].Bool()
	}
	wallpaper := false
	if len(args) >= 14 {
		wallpaper = args[13].Bool()
	}

	go func() {
		if err := connect(proxyWsURL, host, port, domain, user, password, width, height, micEnabled, locationEnabled, storageEnabled, cameraEnabled, wallpaper); err != nil {
			slog.Error("connect", "err", err)
			js.Global().Call("rdpOnError", err.Error())
		}
	}()
	return nil
}

func connect(proxyWsURL, host, port, domain, user, password string, width, height int, micEnabled, locationEnabled, storageEnabled, cameraEnabled, wallpaper bool) error {
	hostPort := host + ":" + port

	// Build WebSocket URL for the proxy. flow=v2 negotiates the text control
	// messages used only for reliable high/low-water receive backpressure.
	wsURL := proxyWsURL + "/rdp-proxy?flow=v2&target=" + hostPort

	g := grdp.NewRdpClient(hostPort, width, height, func(hp string) (net.Conn, error) {
		return dialWebSocket(wsURL)
	})
	// Quality mode: when wallpaper is requested, clear PERF_DISABLE_WALLPAPER
	// so the server streams the desktop background.
	g.SetWallpaperEnabled(wallpaper)

	clientMu.Lock()
	connectGen++
	myGen := connectGen
	oldClient := rdpClient
	rdpClient = g
	clientMu.Unlock()
	if oldClient != nil {
		oldClient.Close()
	}
	// Clear file data cache on reconnect
	fileDataCacheMu.Lock()
	fileDataCache = nil
	fileDataCacheMu.Unlock()

	// Worker mode has no DOM. Rendering is owned entirely by JavaScript on the
	// page or OffscreenCanvas Worker side; the Go protocol stack is DOM-free.

	g.OnAudio(func(af rdpsnd.AudioFormat, data []byte) {
		if !isCurrentClient(myGen, g) {
			return
		}
		cp := make([]byte, len(data))
		copy(cp, data)
		playAudio(int(af.SamplesPerSec), int(af.Channels), int(af.BitsPerSample), cp)
	})

	if js.Global().Get("rdpOnRenderEvent").Type() != js.TypeFunction {
		return fmt.Errorf("semantic GPU compositor callback is unavailable")
	}
	videoDecode := js.Global().Get("rdpExternalVideoDecode").Bool()
	g.OnRenderEvent(forwardRenderEvent)
	g.SetExternalVideoDecode(videoDecode)
	g.SetExternalFrameCompletion(videoDecode)
	g.OnH264Raw(nil)

	uint8Ctor := js.Global().Get("Uint8Array")
	g.OnPointerHide(func() {
		js.Global().Call("rdpOnPointerHide")
	}).OnPointerCached(func(idx uint16) {
		js.Global().Call("rdpOnPointerCached", int(idx))
	}).OnPointerUpdate(func(idx, xorBpp, hotX, hotY, w, h uint16, andMask, xorData []byte) {
		andArr := uint8Ctor.New(len(andMask))
		if len(andMask) > 0 {
			js.CopyBytesToJS(andArr, andMask)
		}
		xorArr := uint8Ctor.New(len(xorData))
		if len(xorData) > 0 {
			js.CopyBytesToJS(xorArr, xorData)
		}
		js.Global().Call("rdpOnPointerUpdate",
			int(idx), int(xorBpp), int(hotX), int(hotY), int(w), int(h), andArr, xorArr)
	})

	// Graphics callbacks were selected before Login so CAPS_ADVERTISE sees the
	// final decoder/rendering capabilities.

	g.OnError(func(e error) {
		if !isCurrentClient(myGen, g) {
			return
		}
		slog.Debug("rdp error", "err", e)
		js.Global().Call("rdpOnError", e.Error())
	}).OnClose(func() {
		if !isCurrentClient(myGen, g) {
			return
		}
		slog.Debug("rdp close")
		js.Global().Call("rdpOnClose")
	}).OnSuccess(func() {
		slog.Debug("rdp success")
	}).OnReady(func() {
		if !isCurrentClient(myGen, g) {
			return
		}
		slog.Debug("rdp ready")
		js.Global().Call("rdpOnReady")
	}).OnBitmap(func(bs []grdp.Bitmap) {
		if !isCurrentClient(myGen, g) {
			return
		}
		// Classic bitmap/RemoteFX fallback updates feed the same GPU compositor.
		// The callback is synchronous because source bytes are pool-borrowed.
		forwardClassicBitmaps(bs)
	})

	g.OnClipboard(
		func(text string) {
			if !isCurrentClient(myGen, g) {
				return
			}
			js.Global().Call("rdpOnClipboard", text)
		},
		func() string {
			clipMu.Lock()
			defer clipMu.Unlock()
			return localClipboard
		},
	)

	// File clipboard: server→client file list + client→server file data
	g.OnFileClipboard(
		func(files []cliprdr.ClipFile) {
			if !isCurrentClient(myGen, g) {
				return
			}
			arr := make([]any, len(files))
			for i, f := range files {
				arr[i] = map[string]any{"name": f.Name, "size": f.Size}
			}
			js.Global().Call("rdpOnRemoteFiles", js.ValueOf(arr))
		},
		func() []cliprdr.ClipFile {
			result := js.Global().Call("rdpStorageGetFiles")
			if result.IsNull() || result.IsUndefined() || result.Length() == 0 {
				return nil
			}
			files := make([]cliprdr.ClipFile, result.Length())
			for i := 0; i < result.Length(); i++ {
				item := result.Index(i)
				files[i] = cliprdr.ClipFile{
					Name: item.Get("name").String(),
					Size: uint64(item.Get("size").Int()),
				}
			}
			return files
		},
		func(index int, offset uint64, length uint32) []byte {
			result := js.Global().Call("rdpStorageGetFiles")
			if result.IsNull() || result.IsUndefined() || index >= result.Length() {
				return nil
			}
			name := result.Index(index).Get("name").String()

			// Check cache first to avoid re-copying the entire file from JS
			// on every chunk request (Windows sends many small RANGE requests).
			fileDataCacheMu.Lock()
			if fileDataCache == nil {
				fileDataCache = make(map[string][]byte)
			}
			cached, ok := fileDataCache[name]
			fileDataCacheMu.Unlock()

			if !ok {
				jsData := js.Global().Call("rdpStorageReadFile", name)
				if jsData.IsNull() || jsData.IsUndefined() {
					return nil
				}
				cached = make([]byte, jsData.Length())
				js.CopyBytesToGo(cached, jsData)
				fileDataCacheMu.Lock()
				fileDataCache[name] = cached
				fileDataCacheMu.Unlock()
			}

			start := int(offset)
			if start >= len(cached) {
				return nil
			}
			end := start + int(length)
			if end > len(cached) {
				end = len(cached)
			}
			return cached[start:end]
		},
	)

	// Register AUDIN (microphone) DVC handler if enabled
	audinHandler = NewAudinHandler(micEnabled)
	g.RegisterDvcHandler("AUDIO_INPUT", audinHandler)

	// Register RDPEL (location) DVC handler if enabled
	rdpelHandler = NewRdpelHandler(locationEnabled)
	g.RegisterDvcHandler("Microsoft::Windows::RDS::Location", rdpelHandler)

	// Register RDPEFS (storage/drive redirection) if enabled
	rdpefsHandler = NewRdpefsHandler(storageEnabled)
	if storageEnabled {
		g.SetRdpdrHandler(rdpefsHandler)
	}

	// Register MS-RDPECAM (camera redirection) if enabled
	camEnumHandler = NewCamEnumeratorHandler(cameraEnabled)
	camStreamHandler = NewCamStreamHandler(cameraEnabled)
	g.RegisterDvcHandler("RDCamera_Device_Enumerator", camEnumHandler)
	g.RegisterDvcHandler("RDCamera_Device_WebCam0_0", camStreamHandler)
	camEnumHandler.streamHandler = camStreamHandler

	if err := g.Login(domain, user, password); err != nil {
		clientMu.Lock()
		if rdpClient == g {
			rdpClient = nil
		}
		clientMu.Unlock()
		g.Close()
		return err
	}

	return nil
}

var (
	bitmapBGRABuf []byte
	bitmapCropBuf []byte
)

// forwardClassicBitmaps converts classic bitmap updates to BGRA and feeds the
// same semantic compositor used by RDPGFX. Data is consumed synchronously.
func forwardClassicBitmaps(bs []grdp.Bitmap) {

	for _, bm := range bs {
		w := bm.DestRight - bm.DestLeft + 1
		if w > bm.Width {
			w = bm.Width
		}
		h := bm.DestBottom - bm.DestTop + 1
		if h > bm.Height {
			h = bm.Height
		}
		if w <= 0 || h <= 0 {
			continue
		}

		expectedBytes := bm.Width * bm.Height * bm.BitsPerPixel
		if len(bm.Data) < expectedBytes {
			slog.Warn("bitmap data too short", "expected", expectedBytes, "got", len(bm.Data),
				"w", bm.Width, "h", bm.Height, "bpp", bm.BitsPerPixel,
				"dest", fmt.Sprintf("(%d,%d)-(%d,%d)", bm.DestLeft, bm.DestTop, bm.DestRight, bm.DestBottom))
			continue
		}

		need := w * h * 4
		// Determine the full bitmap buffer size needed (may be larger than
		// need when the bitmap is clipped: w < bm.Width).
		fullNeed := bm.Width * bm.Height * 4
		bufNeed := need
		if fullNeed > bufNeed {
			bufNeed = fullNeed
		}
		if cap(bitmapBGRABuf) < bufNeed {
			bitmapBGRABuf = make([]byte, bufNeed)
		}

		if bm.BitsPerPixel == 4 && w == bm.Width {
			// Common case: 32bpp BGRA, full width.
			bgra := bm.FillBGRA(bitmapBGRABuf[:need])
			forwardClassicBitmap(bm.DestLeft, bm.DestTop, w, h, bgra)
		} else {
			// Clipped or non-32bpp: use FillBGRA on full bitmap then crop.
			// Full conversion and cropped output must use distinct buffers:
			// overlapping copy(full -> bgra) corrupts pixels on clipped tiles.
			full := bm.FillBGRA(bitmapBGRABuf[:fullNeed])
			if cap(bitmapCropBuf) < need {
				bitmapCropBuf = make([]byte, need)
			}
			bgra := bitmapCropBuf[:need]
			srcStride := bm.Width * 4
			dstStride := w * 4
			for row := 0; row < h; row++ {
				copy(bgra[row*dstStride:], full[row*srcStride:row*srcStride+dstStride])
			}
			forwardClassicBitmap(bm.DestLeft, bm.DestTop, w, h, bgra)
		}
	}
}

func jsDisconnect(_ js.Value, _ []js.Value) any {
	clientMu.Lock()
	c := rdpClient
	rdpClient = nil
	rdpefsHandler = nil
	connectGen++
	clientMu.Unlock()
	if c != nil {
		c.Close()
	}
	fileDataCacheMu.Lock()
	fileDataCache = nil
	fileDataCacheMu.Unlock()
	return nil
}

func jsMouseMove(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.MouseMove(args[0].Int(), args[1].Int())
	}
	return nil
}

func jsMouseDown(_ js.Value, args []js.Value) any {
	if len(args) < 3 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.MouseDown(args[0].Int(), args[1].Int(), args[2].Int())
	}
	return nil
}

func jsMouseUp(_ js.Value, args []js.Value) any {
	if len(args) < 3 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.MouseUp(args[0].Int(), args[1].Int(), args[2].Int())
	}
	return nil
}

func jsMouseWheel(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.MouseWheel(args[0].Float())
	}
	return nil
}

func jsMouseHScroll(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.MouseHWheel(args[0].Float())
	}
	return nil
}

func jsKeyDown(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		code := jsCodeToRDP(args[0].String(), swapAltMeta)
		if code != 0 {
			c.KeyDown(code)
		}
	}
	return nil
}

func jsKeyUp(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		code := jsCodeToRDP(args[0].String(), swapAltMeta)
		if code != 0 {
			c.KeyUp(code)
		}
	}
	return nil
}

// jsClipboardChanged is called from JS when the local clipboard text changes.
func jsClipboardChanged(_ js.Value, args []js.Value) any {
	text := ""
	if len(args) >= 1 {
		text = args[0].String()
	}
	clipMu.Lock()
	localClipboard = text
	clipMu.Unlock()

	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.NotifyClipboardChanged()
	}
	return nil
}

// jsClipboardChangedSync is like jsClipboardChanged but returns a Promise that
// resolves true when the server has confirmed receipt of the clipboard content
// (FORMAT_DATA_REQUEST processed), or false on timeout.  Used by the JS-side
// sendTextViaClipboard path to avoid sending Ctrl+V before the remote clipboard
// is actually updated.
func jsClipboardChangedSync(_ js.Value, args []js.Value) any {
	text := ""
	if len(args) >= 1 {
		text = args[0].String()
	}
	clipMu.Lock()
	localClipboard = text
	clipMu.Unlock()

	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c == nil {
		return js.Global().Get("Promise").New(js.FuncOf(func(this js.Value, promiseArgs []js.Value) any {
			promiseArgs[1].Invoke(js.ValueOf("no client"))
			return nil
		}))
	}
	c.NotifyClipboardChanged()

	handler := c.GetClipboardHandler()
	if handler == nil {
		return js.Global().Get("Promise").New(js.FuncOf(func(this js.Value, promiseArgs []js.Value) any {
			promiseArgs[1].Invoke(js.ValueOf("no clipboard handler"))
			return nil
		}))
	}

	// Return a Promise that resolves when the server confirms clipboard receipt.
	return js.Global().Get("Promise").New(js.FuncOf(func(this js.Value, promiseArgs []js.Value) any {
		resolve := promiseArgs[0]
		go func() {
			ready := handler.WaitForClipboardReady(2 * time.Second)
			resolve.Invoke(js.ValueOf(ready))
		}()
		return nil
	}))
}

// jsNotifyFilesChanged tells the server that client has files available.
func jsNotifyFilesChanged(_ js.Value, _ []js.Value) any {
	// Clear cached file data since the file list changed
	fileDataCacheMu.Lock()
	fileDataCache = nil
	fileDataCacheMu.Unlock()
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c != nil {
		c.NotifyLocalFilesChanged()
	}
	return nil
}

// jsDownloadServerFile downloads a file from the server's clipboard by index.
// Async: runs in a goroutine and calls the JS callback(uint8Array_or_null).
// Usage from JS: rdpDownloadServerFile(index, function(data) { ... })
func jsDownloadServerFile(_ js.Value, args []js.Value) any {
	if len(args) < 2 {
		return nil
	}
	idx := args[0].Int()
	callback := args[1]
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c == nil {
		callback.Invoke(js.Null())
		return nil
	}
	go func() {
		data := c.DownloadServerFile(idx)
		if data == nil {
			callback.Invoke(js.Null())
			return
		}
		arr := js.Global().Get("Uint8Array").New(len(data))
		js.CopyBytesToJS(arr, data)
		callback.Invoke(arr)
	}()
	return nil
}

// jsGetServerFiles returns the server's clipboard file list as a JS array.
func jsGetServerFiles(_ js.Value, _ []js.Value) any {
	clientMu.Lock()
	c := rdpClient
	clientMu.Unlock()
	if c == nil {
		return nil
	}
	files := c.GetServerClipboardFiles()
	if len(files) == 0 {
		return nil
	}
	result := js.Global().Get("Array").New(len(files))
	for i, f := range files {
		obj := js.Global().Get("Object").New()
		obj.Set("name", f.Name)
		obj.Set("size", f.Size)
		result.SetIndex(i, obj)
	}
	return result
}

// jsAudinData is called from JS with PCM audio data from the microphone.
// JS: rdpAudinData(uint8Array)
func jsAudinData(_ js.Value, args []js.Value) any {
	if len(args) < 1 || audinHandler == nil {
		return nil
	}
	jsArr := args[0]
	buf := make([]byte, jsArr.Length())
	js.CopyBytesToGo(buf, jsArr)
	audinHandler.SendAudioData(buf)
	return nil
}

// jsLocationData is called from JS with geolocation data.
// JS: rdpLocationData(latitude, longitude, altitude, accuracy, speed, heading)
func jsLocationData(_ js.Value, args []js.Value) any {
	if len(args) < 4 || rdpelHandler == nil {
		return nil
	}
	lat := args[0].Float()
	lon := args[1].Float()
	alt := 0.0
	if len(args) > 2 && !args[2].IsNull() && !args[2].IsUndefined() {
		alt = args[2].Float()
	}
	acc := args[3].Float()
	spd := -1.0
	if len(args) > 4 && !args[4].IsNull() && !args[4].IsUndefined() {
		spd = args[4].Float()
	}
	hdg := -1.0
	if len(args) > 5 && !args[5].IsNull() && !args[5].IsUndefined() {
		hdg = args[5].Float()
	}
	rdpelHandler.SendLocation(lat, lon, alt, acc, spd, hdg)
	return nil
}

// jsCameraFrame is called from JS with H.264 encoded camera frame data.
// JS: rdpCameraFrame(uint8Array, isKeyFrame)
func jsCameraFrame(_ js.Value, args []js.Value) any {
	if len(args) < 2 || camStreamHandler == nil {
		return nil
	}
	jsArr := args[0]
	isKey := args[1].Bool()
	buf := make([]byte, jsArr.Length())
	js.CopyBytesToGo(buf, jsArr)
	camStreamHandler.SendSample(buf, isKey)
	return nil
}

// ─── Agent Drive Management JS Functions ─────────────────────────

// jsAttachDrive: rdpFsAttachDrive(agentId, driveName, readOnly)
func jsAttachDrive(_ js.Value, args []js.Value) any {
	if len(args) < 3 || rdpefsHandler == nil {
		return nil
	}
	agentID := args[0].String()
	driveName := args[1].String()
	readOnly := args[2].Bool()
	deviceID := rdpefsHandler.AttachDrive(agentID, driveName, readOnly)
	return int(deviceID)
}

// jsDetachDrive: rdpFsDetachDrive(agentId)
func jsDetachDrive(_ js.Value, args []js.Value) any {
	if len(args) < 1 || rdpefsHandler == nil {
		return nil
	}
	agentID := args[0].String()
	rdpefsHandler.DetachDrive(agentID)
	return nil
}

// jsListDrives: rdpFsListDrives() → [{deviceId, agentId, driveName, readOnly, status}]
func jsListDrives(_ js.Value, _ []js.Value) any {
	if rdpefsHandler == nil {
		return js.ValueOf(nil)
	}
	drives := rdpefsHandler.ListDrives()
	arr := make([]any, len(drives))
	for i, d := range drives {
		arr[i] = d
	}
	return js.ValueOf(arr)
}
