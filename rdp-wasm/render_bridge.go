//go:build js && wasm

package main

import (
	"log/slog"
	"runtime"
	"sync"
	"syscall/js"
	"unsafe"

	"github.com/nakagami/grdp/plugin/rdpgfx"
)

var renderEventCallback js.Value
var wasmBitmapCallback js.Value
var rendererExternalVideoDecode bool
var rendererConfigMu sync.RWMutex

func jsConfigureRenderer(_ js.Value, args []js.Value) any {
	if len(args) < 3 || args[0].Type() != js.TypeFunction || args[1].Type() != js.TypeFunction {
		return "usage: rdpConfigureRenderer(renderEventCallback, wasmBitmapCallback, externalVideoDecode)"
	}
	rendererConfigMu.Lock()
	renderEventCallback = args[0]
	wasmBitmapCallback = args[1]
	rendererExternalVideoDecode = args[2].Bool()
	rendererConfigMu.Unlock()
	return nil
}

func configuredRenderer() (js.Value, js.Value, bool, bool) {
	rendererConfigMu.RLock()
	defer rendererConfigMu.RUnlock()
	return renderEventCallback, wasmBitmapCallback, rendererExternalVideoDecode, renderEventCallback.Type() == js.TypeFunction
}

func renderRectValue(rect rdpgfx.RenderRect) map[string]any {
	return map[string]any{"left": int(rect.Left), "top": int(rect.Top), "right": int(rect.Right), "bottom": int(rect.Bottom)}
}

func renderStreamValue(stream *rdpgfx.RenderVideoStream) any {
	if stream == nil {
		return nil
	}
	regions := make([]any, len(stream.Regions))
	for i, region := range stream.Regions {
		regions[i] = renderRectValue(region)
	}
	data := js.Global().Get("Uint8Array").New(len(stream.Data))
	if len(stream.Data) > 0 {
		js.CopyBytesToJS(data, stream.Data)
	}
	return map[string]any{"role": int(stream.Role), "key": stream.Key, "regions": regions, "data": data}
}

func forwardRenderEvent(event rdpgfx.RenderEvent) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("forwardRenderEvent panic", "err", r, "kind", event.Kind)
		}
	}()
	renderCallback, bitmapCallback, _, configured := configuredRenderer()
	if !configured {
		slog.Warn("forwardRenderEvent: renderer not configured", "kind", event.Kind)
		return
	}
	if (event.Kind == rdpgfx.RenderBitmap || event.Kind == rdpgfx.RenderClassicBitmap) && len(event.Data) > 0 && bitmapCallback.Type() == js.TypeFunction {
		// Pass the linear-memory offset as float64, NOT int. On go/wasm,
		// int is 32-bit; casting a uintptr ≥ 2^31 yields a negative int,
		// and JS then builds Uint8Array(buffer, negativeOffset) → wrong
		// bytes / empty views → full-screen garbage tiles. float64 can
		// represent every wasm32 address exactly.
		pointer := float64(uintptr(unsafe.Pointer(unsafe.SliceData(event.Data))))
		bitmapCallback.Invoke(js.ValueOf(map[string]any{
			"kind": int(event.Kind), "frameId": int(event.FrameID), "surfaceId": int(event.SurfaceID),
			"rect": renderRectValue(event.Rect), "pointer": pointer,
			"length": len(event.Data), "stride": int(event.Stride),
		}))
		runtime.KeepAlive(event.Data)
		return
	}
	value := map[string]any{
		"kind": int(event.Kind), "frameId": int(event.FrameID), "timestamp": int(event.Timestamp),
		"surfaceId": int(event.SurfaceID), "surfaceId2": int(event.SurfaceID2),
		"codecId": int(event.CodecID), "pixelFormat": int(event.PixelFormat), "lc": int(event.LC),
		"outputX": int(event.OutputX), "outputY": int(event.OutputY), "width": int(event.Width), "height": int(event.Height),
		"rect": renderRectValue(event.Rect), "colorBGRA": int(event.ColorBGRA), "stride": int(event.Stride),
	}
	if len(event.Data) > 0 {
		data := js.Global().Get("Uint8Array").New(len(event.Data))
		js.CopyBytesToJS(data, event.Data)
		value["data"] = data
	}
	if event.Stream1 != nil {
		value["stream1"] = renderStreamValue(event.Stream1)
	}
	if event.Stream2 != nil {
		value["stream2"] = renderStreamValue(event.Stream2)
	}
	renderCallback.Invoke(js.ValueOf(value))
}

func forwardClassicBitmap(x, y, width, height int, data []byte) {
	forwardRenderEvent(rdpgfx.RenderEvent{
		Kind:  rdpgfx.RenderClassicBitmap,
		Rect:  rdpgfx.RenderRect{Left: uint16(x), Top: uint16(y), Right: uint16(x + width), Bottom: uint16(y + height)},
		Width: uint32(width), Height: uint32(height), Data: data, Stride: uint32(width * 4),
	})
}

func jsRequestFullRefresh(_ js.Value, _ []js.Value) any {
	clientMu.Lock()
	client := rdpClient
	clientMu.Unlock()
	if client != nil {
		client.RequestFullRefresh()
	}
	return nil
}

func jsGfxCompleteFrame(_ js.Value, args []js.Value) any {
	if len(args) < 1 {
		return nil
	}
	queueDepth := 0
	if len(args) > 1 {
		queueDepth = args[1].Int()
	}
	clientMu.Lock()
	client := rdpClient
	clientMu.Unlock()
	if client != nil {
		if err := client.CompleteGfxFrame(uint32(args[0].Int()), uint32(queueDepth)); err != nil {
			js.Global().Get("console").Call("warn", "[rdp-gfx] complete frame failed", err.Error())
		}
	}
	return nil
}
