//go:build js && wasm

// audin.go — MS-RDPEAI (Audio Input Redirection) DVC plugin for WASM
//
// Implements the AUDIO_INPUT dynamic virtual channel per [MS-RDPEAI].
// Browser microphone audio (PCM) is captured via JS getUserMedia + ScriptProcessor
// and forwarded to the Windows RDP server as SNDIN_DATA PDUs.

package main

import (
	"bytes"
	"encoding/binary"
	"log/slog"
	"sync"
	"syscall/js"
)

// MS-RDPEAI message types
const (
	CYCLEAUDIN_VERSION  = 0x01
	SNDIN_FORMATS       = 0x02
	SNDIN_OPEN          = 0x03
	SNDIN_FORMATCHANGE  = 0x04
	SNDIN_DATA          = 0x05
	SNDIN_DATA_INCOMING = 0x06
)

// Protocol version
const SNDIN_VERSION_VALUE uint32 = 0x00000002

// WAVE_FORMAT_PCM
const WAVE_FORMAT_PCM uint16 = 0x0001

type AudinFormat struct {
	FormatTag      uint16
	Channels       uint16
	SamplesPerSec  uint32
	AvgBytesPerSec uint32
	BlockAlign     uint16
	BitsPerSample  uint16
}

// AudinHandler implements drdynvc.DvcChannelHandler for the AUDIO_INPUT channel.
type AudinHandler struct {
	mu           sync.Mutex
	sendFunc     func([]byte)
	enabled      bool
	opened       bool
	formats      []AudinFormat
	activeFormat AudinFormat
}

func NewAudinHandler(enabled bool) *AudinHandler {
	return &AudinHandler{enabled: enabled}
}

func (h *AudinHandler) SetSendFunc(fn func([]byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendFunc = fn
}

func (h *AudinHandler) OnChannelCreated() {
	slog.Debug("audin: channel created")
}

// Process handles incoming AUDIN PDUs from the server.
func (h *AudinHandler) Process(data []byte) {
	if len(data) < 1 {
		return
	}
	switch data[0] {
	case CYCLEAUDIN_VERSION:
		h.processVersion(data)
	case SNDIN_FORMATS:
		h.processFormats(data)
	case SNDIN_OPEN:
		h.processOpen(data)
	case SNDIN_FORMATCHANGE:
		h.processFormatChange(data)
	default:
		slog.Debug("audin: unknown msg", "type", data[0])
	}
}

func (h *AudinHandler) processVersion(data []byte) {
	slog.Debug("audin: VERSION received")
	buf := &bytes.Buffer{}
	buf.WriteByte(CYCLEAUDIN_VERSION)
	binary.Write(buf, binary.LittleEndian, SNDIN_VERSION_VALUE)
	h.send(buf.Bytes())
}

func (h *AudinHandler) processFormats(data []byte) {
	if len(data) < 9 {
		return
	}
	numFormats := binary.LittleEndian.Uint32(data[1:5])
	slog.Debug("audin: FORMATS", "count", numFormats)

	// Parse server formats
	offset := 9
	serverFormats := make([]AudinFormat, 0, numFormats)
	for i := uint32(0); i < numFormats && offset+18 <= len(data); i++ {
		f := AudinFormat{
			FormatTag:      binary.LittleEndian.Uint16(data[offset:]),
			Channels:       binary.LittleEndian.Uint16(data[offset+2:]),
			SamplesPerSec:  binary.LittleEndian.Uint32(data[offset+4:]),
			AvgBytesPerSec: binary.LittleEndian.Uint32(data[offset+8:]),
			BlockAlign:     binary.LittleEndian.Uint16(data[offset+12:]),
			BitsPerSample:  binary.LittleEndian.Uint16(data[offset+14:]),
		}
		cbSize := binary.LittleEndian.Uint16(data[offset+16:])
		offset += 18 + int(cbSize)
		serverFormats = append(serverFormats, f)
	}

	h.mu.Lock()
	h.formats = serverFormats
	h.mu.Unlock()

	// Reply with PCM 16-bit formats only (browser can provide these)
	supported := make([]AudinFormat, 0)
	for _, f := range serverFormats {
		if f.FormatTag == WAVE_FORMAT_PCM && f.BitsPerSample == 16 {
			supported = append(supported, f)
		}
	}
	if len(supported) == 0 {
		supported = append(supported, AudinFormat{
			FormatTag: WAVE_FORMAT_PCM, Channels: 1,
			SamplesPerSec: 44100, AvgBytesPerSec: 88200,
			BlockAlign: 2, BitsPerSample: 16,
		})
	}

	buf := &bytes.Buffer{}
	buf.WriteByte(SNDIN_FORMATS)
	binary.Write(buf, binary.LittleEndian, uint32(len(supported)))
	fmtBuf := &bytes.Buffer{}
	for _, f := range supported {
		binary.Write(fmtBuf, binary.LittleEndian, f.FormatTag)
		binary.Write(fmtBuf, binary.LittleEndian, f.Channels)
		binary.Write(fmtBuf, binary.LittleEndian, f.SamplesPerSec)
		binary.Write(fmtBuf, binary.LittleEndian, f.AvgBytesPerSec)
		binary.Write(fmtBuf, binary.LittleEndian, f.BlockAlign)
		binary.Write(fmtBuf, binary.LittleEndian, f.BitsPerSample)
		binary.Write(fmtBuf, binary.LittleEndian, uint16(0))
	}
	binary.Write(buf, binary.LittleEndian, uint32(fmtBuf.Len()))
	buf.Write(fmtBuf.Bytes())
	h.send(buf.Bytes())
	slog.Debug("audin: replied formats", "count", len(supported))
}

func (h *AudinHandler) processOpen(data []byte) {
	if len(data) < 9 {
		return
	}
	framesPerPacket := binary.LittleEndian.Uint32(data[1:5])
	formatIdx := binary.LittleEndian.Uint32(data[5:9])
	slog.Debug("audin: OPEN", "framesPerPacket", framesPerPacket, "formatIdx", formatIdx)

	h.mu.Lock()
	h.opened = true
	if int(formatIdx) < len(h.formats) {
		h.activeFormat = h.formats[formatIdx]
	} else {
		h.activeFormat = AudinFormat{
			FormatTag: WAVE_FORMAT_PCM, Channels: 1,
			SamplesPerSec: 44100, BitsPerSample: 16,
			AvgBytesPerSec: 88200, BlockAlign: 2,
		}
	}
	af := h.activeFormat
	enabled := h.enabled
	h.mu.Unlock()

	if !enabled {
		slog.Debug("audin: disabled, not starting capture")
		return
	}

	// Tell JS to start microphone capture
	js.Global().Call("rdpAudinStart",
		int(af.SamplesPerSec), int(af.Channels), int(af.BitsPerSample),
		int(framesPerPacket))
}

func (h *AudinHandler) processFormatChange(data []byte) {
	if len(data) < 5 {
		return
	}
	newIdx := binary.LittleEndian.Uint32(data[1:5])
	h.mu.Lock()
	if int(newIdx) < len(h.formats) {
		h.activeFormat = h.formats[newIdx]
	}
	h.mu.Unlock()
}

// SendAudioData sends PCM audio from browser mic to the RDP server.
func (h *AudinHandler) SendAudioData(pcmData []byte) {
	h.mu.Lock()
	opened := h.opened
	h.mu.Unlock()
	if !opened || len(pcmData) == 0 {
		return
	}

	// SNDIN_DATA_INCOMING
	incoming := []byte{SNDIN_DATA_INCOMING}
	h.send(incoming)

	// SNDIN_DATA
	buf := make([]byte, 1+len(pcmData))
	buf[0] = SNDIN_DATA
	copy(buf[1:], pcmData)
	h.send(buf)
}

func (h *AudinHandler) send(data []byte) {
	h.mu.Lock()
	fn := h.sendFunc
	h.mu.Unlock()
	if fn != nil {
		fn(data)
	}
}

func (h *AudinHandler) Close() {
	h.mu.Lock()
	h.opened = false
	h.mu.Unlock()
	js.Global().Call("rdpAudinStop")
}
