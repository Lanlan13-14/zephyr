package rdpgfx

// RenderEventKind identifies an ordered RDPGFX semantic command. Event data is
// borrowed and is valid only for the synchronous callback unless documented.
type RenderEventKind uint8

const (
	RenderResetGraphics RenderEventKind = iota + 1
	RenderBeginFrame
	RenderEndFrame
	RenderCreateSurface
	RenderDeleteSurface
	RenderMapSurface
	RenderMapSurfaceScaled
	RenderBitmap
	RenderAVC420
	RenderAVC444
	RenderSurfaceCopy
	RenderSurfaceToCache
	RenderSolidFill
	RenderCacheToSurface
	RenderCacheEvict
	RenderClassicBitmap
)

type RenderRect struct {
	Left, Top, Right, Bottom uint16
}

type RenderVideoStream struct {
	Role    uint8
	Key     bool
	Regions []RenderRect
	Data    []byte
}

type RenderEvent struct {
	Kind        RenderEventKind
	FrameID     uint32
	Timestamp   uint32
	SurfaceID   uint16
	SurfaceID2  uint16
	CodecID     uint16
	PixelFormat uint8
	LC          uint8
	OutputX     uint32
	OutputY     uint32
	Width       uint32
	Height      uint32
	Rect        RenderRect
	Rects       []RenderRect
	ColorBGRA   uint32
	Data        []byte
	Stride      uint32
	Stream1     *RenderVideoStream
	Stream2     *RenderVideoStream
}

type RenderEventSink func(RenderEvent)

func cloneAVCRegions(regions []avcRect) []RenderRect {
	if len(regions) == 0 {
		return nil
	}
	out := make([]RenderRect, len(regions))
	for i, rect := range regions {
		out[i] = RenderRect{Left: rect.left, Top: rect.top, Right: rect.right, Bottom: rect.bottom}
	}
	return out
}

func (g *GfxHandler) emitRenderEvent(event RenderEvent) {
	if g.onRenderEvent != nil {
		g.onRenderEvent(event)
	}
}

// SetRenderEventSink mirrors ordered semantic graphics commands to fn. The
// legacy software renderer remains active until external completion mode is
// explicitly enabled.
func (g *GfxHandler) SetRenderEventSink(fn RenderEventSink) { g.onRenderEvent = fn }
