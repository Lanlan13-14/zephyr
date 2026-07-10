//go:build js && wasm

// rdpel.go — MS-RDPEL (Location Redirection) DVC plugin for WASM
//
// Implements the location virtual channel per [MS-RDPEL].
// Browser Geolocation API coordinates are forwarded to the Windows RDP server.
//
// DVC channel name: "Microsoft::Windows::RDS::Location"
//
// Protocol (simplified):
//   Server → Client: CYCLELOCATION_VERSION (version negotiation)
//   Client → Server: CYCLELOCATION_VERSION (version response)
//   Server → Client: CYCLELOCATION_SUBSCRIBE (request location updates)
//   Client → Server: CYCLELOCATION_LOCATION (lat/lon/alt/accuracy data)

package main

import (
	"bytes"
	"encoding/binary"
	"log/slog"
	"math"
	"sync"
	"syscall/js"
)

// MS-RDPEL message types
const (
	CYCLELOCATION_VERSION   = 0x01
	CYCLELOCATION_SUBSCRIBE = 0x02
	CYCLELOCATION_LOCATION  = 0x03
	CYCLELOCATION_ERROR     = 0x04
)

// Protocol version
const RDPEL_VERSION uint32 = 0x00000001

// Location field flags
const (
	RDPEL_FIELD_LATITUDE  = 0x0001
	RDPEL_FIELD_LONGITUDE = 0x0002
	RDPEL_FIELD_ALTITUDE  = 0x0004
	RDPEL_FIELD_SPEED     = 0x0008
	RDPEL_FIELD_HEADING   = 0x0010
	RDPEL_FIELD_ACCURACY  = 0x0020
)

// RdpelHandler implements drdynvc.DvcChannelHandler for the location channel.
type RdpelHandler struct {
	mu       sync.Mutex
	sendFunc func([]byte)
	enabled  bool
	watching bool
}

func NewRdpelHandler(enabled bool) *RdpelHandler {
	return &RdpelHandler{enabled: enabled}
}

func (h *RdpelHandler) SetSendFunc(fn func([]byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendFunc = fn
}

func (h *RdpelHandler) OnChannelCreated() {
	slog.Debug("rdpel: channel created")
}

// Process handles incoming RDPEL PDUs from the server.
func (h *RdpelHandler) Process(data []byte) {
	if len(data) < 1 {
		return
	}
	switch data[0] {
	case CYCLELOCATION_VERSION:
		h.processVersion(data)
	case CYCLELOCATION_SUBSCRIBE:
		h.processSubscribe(data)
	default:
		slog.Debug("rdpel: unknown msg", "type", data[0])
	}
}

func (h *RdpelHandler) processVersion(data []byte) {
	slog.Debug("rdpel: VERSION received")
	buf := &bytes.Buffer{}
	buf.WriteByte(CYCLELOCATION_VERSION)
	binary.Write(buf, binary.LittleEndian, RDPEL_VERSION)
	h.send(buf.Bytes())
}

func (h *RdpelHandler) processSubscribe(data []byte) {
	slog.Debug("rdpel: SUBSCRIBE received")

	h.mu.Lock()
	enabled := h.enabled
	h.mu.Unlock()

	if !enabled {
		slog.Debug("rdpel: location disabled, sending error")
		h.sendError(0x80004001) // E_NOTIMPL
		return
	}

	// Tell JS to start watching geolocation
	h.mu.Lock()
	h.watching = true
	h.mu.Unlock()

	js.Global().Call("rdpLocationStart")
}

// SendLocation sends a location update to the server.
// Called from JS when geolocation data is available.
func (h *RdpelHandler) SendLocation(latitude, longitude, altitude, accuracy, speed, heading float64) {
	h.mu.Lock()
	watching := h.watching
	h.mu.Unlock()
	if !watching {
		return
	}

	buf := &bytes.Buffer{}
	buf.WriteByte(CYCLELOCATION_LOCATION)

	// Build field flags based on which values are valid
	var flags uint16 = RDPEL_FIELD_LATITUDE | RDPEL_FIELD_LONGITUDE | RDPEL_FIELD_ACCURACY
	if !math.IsNaN(altitude) && altitude != 0 {
		flags |= RDPEL_FIELD_ALTITUDE
	}
	if !math.IsNaN(speed) && speed >= 0 {
		flags |= RDPEL_FIELD_SPEED
	}
	if !math.IsNaN(heading) && heading >= 0 {
		flags |= RDPEL_FIELD_HEADING
	}

	binary.Write(buf, binary.LittleEndian, flags)
	binary.Write(buf, binary.LittleEndian, math.Float64bits(latitude))
	binary.Write(buf, binary.LittleEndian, math.Float64bits(longitude))

	if flags&RDPEL_FIELD_ALTITUDE != 0 {
		binary.Write(buf, binary.LittleEndian, math.Float64bits(altitude))
	}
	if flags&RDPEL_FIELD_SPEED != 0 {
		binary.Write(buf, binary.LittleEndian, math.Float64bits(speed))
	}
	if flags&RDPEL_FIELD_HEADING != 0 {
		binary.Write(buf, binary.LittleEndian, math.Float64bits(heading))
	}
	binary.Write(buf, binary.LittleEndian, math.Float64bits(accuracy))

	h.send(buf.Bytes())
	slog.Debug("rdpel: location sent", "lat", latitude, "lon", longitude, "acc", accuracy)
}

func (h *RdpelHandler) sendError(code uint32) {
	buf := &bytes.Buffer{}
	buf.WriteByte(CYCLELOCATION_ERROR)
	binary.Write(buf, binary.LittleEndian, code)
	h.send(buf.Bytes())
}

func (h *RdpelHandler) send(data []byte) {
	h.mu.Lock()
	fn := h.sendFunc
	h.mu.Unlock()
	if fn != nil {
		fn(data)
	}
}

func (h *RdpelHandler) Close() {
	h.mu.Lock()
	h.watching = false
	h.mu.Unlock()
	js.Global().Call("rdpLocationStop")
}
