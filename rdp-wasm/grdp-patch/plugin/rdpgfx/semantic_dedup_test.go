package rdpgfx

import "testing"

func TestSemanticBitmapSinkSuppressesCompatibilityBitmapCallback(t *testing.T) {
	called := false
	g := NewGfxHandler(func([]BitmapUpdate) { called = true })
	g.SetRenderEventSink(func(RenderEvent) {})
	s := &surface{id: 1, width: 1, height: 1, mapped: true, data: make([]byte, 4)}
	g.emitBitmap(s, 0, 0, 1, 1, []byte{1, 2, 3, 4})
	if called {
		t.Fatal("semantic bitmap was emitted through compatibility callback")
	}
}

func TestClassicBitmapEventKindIsDistinct(t *testing.T) {
	if RenderClassicBitmap == RenderBitmap {
		t.Fatal("classic and RDPGFX bitmap kinds must differ")
	}
}
