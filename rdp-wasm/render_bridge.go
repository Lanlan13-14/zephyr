//go:build js && wasm

package main

import (
	"runtime"
	"syscall/js"
	"unsafe"

	"github.com/nakagami/grdp/plugin/rdpgfx"
)

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
	if (event.Kind == rdpgfx.RenderBitmap || event.Kind == rdpgfx.RenderClassicBitmap) && len(event.Data) > 0 && js.Global().Get("rdpOnWasmBitmap").Type() == js.TypeFunction {
		pointer := uintptr(unsafe.Pointer(unsafe.SliceData(event.Data)))
		js.Global().Call("rdpOnWasmBitmap", js.ValueOf(map[string]any{
			"kind": int(event.Kind), "frameId": int(event.FrameID), "surfaceId": int(event.SurfaceID),
			"rect": renderRectValue(event.Rect), "pointer": int(pointer),
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
	js.Global().Call("rdpOnRenderEvent", js.ValueOf(value))
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
