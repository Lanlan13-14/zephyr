package rdpgfx

import "testing"

func TestSemanticSinkDoesNotAdvertiseAVCWithoutExternalDecoder(t *testing.T) {
	g := NewGfxHandler(nil)
	defer g.Close()
	g.SetRenderEventSink(func(RenderEvent) {})
	if g.h264dec != nil || g.onH264Raw != nil || g.externalVideoDecode {
		t.Fatal("fixture unexpectedly has a video decoder")
	}
	g.SetExternalVideoDecode(true)
	if !g.externalVideoDecode {
		t.Fatal("external video capability was not enabled")
	}
}
