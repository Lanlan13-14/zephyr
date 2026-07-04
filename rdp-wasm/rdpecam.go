//go:build js && wasm

// rdpecam.go — MS-RDPECAM (Camera Redirection Virtual Channel Extension)
//
// Implements camera redirection over DVC channels per [MS-RDPECAM].
// Browser camera video frames (via getUserMedia + VideoEncoder) are
// forwarded to the Windows RDP server.
//
// DVC channels:
//   "RDCamera_Device_Enumerator" — device enumeration and capability exchange
//   "RDCamera_Device_<id>_<stream>" — per-stream video data
//
// Protocol flow:
//   Client → Server: SelectVersionRequest (version 0x01)
//   Server → Client: SelectVersionResponse
//   Client → Server: DeviceAddedNotification (one virtual camera)
//   Server opens stream DVC channel
//   Server → Client: ActivateDeviceRequest
//   Client → Server: ActivateDeviceResponse (success)
//   Server → Client: MediaTypeListRequest
//   Client → Server: MediaTypeListResponse (supported formats)
//   Server → Client: CurrentMediaTypeRequest
//   Client → Server: CurrentMediaTypeResponse
//   Server → Client: StartStreamsRequest
//   Client → Server: StartStreamsResponse + SampleRequest/SampleResponse loop
//   Server → Client: StopStreamsRequest
//   Client → Server: StopStreamsResponse

package main

import (
	"bytes"
	"encoding/binary"
	"log/slog"
	"sync"
	"syscall/js"
)

// MS-RDPECAM message types (enumerator channel)
const (
	CAM_MSG_SELECT_VERSION_REQUEST  = 0x01
	CAM_MSG_SELECT_VERSION_RESPONSE = 0x02
	CAM_MSG_DEVICE_ADDED_NOTIFICATION = 0x03
	CAM_MSG_DEVICE_REMOVED_NOTIFICATION = 0x04
)

// MS-RDPECAM message types (stream channel)
const (
	CAM_MSG_ACTIVATE_DEVICE_REQUEST   = 0x01
	CAM_MSG_ACTIVATE_DEVICE_RESPONSE  = 0x02
	CAM_MSG_DEACTIVATE_DEVICE_REQUEST = 0x03
	CAM_MSG_MEDIA_TYPE_LIST_REQUEST   = 0x04
	CAM_MSG_MEDIA_TYPE_LIST_RESPONSE  = 0x05
	CAM_MSG_CURRENT_MEDIA_TYPE_REQUEST  = 0x06
	CAM_MSG_CURRENT_MEDIA_TYPE_RESPONSE = 0x07
	CAM_MSG_START_STREAMS_REQUEST     = 0x08
	CAM_MSG_START_STREAMS_RESPONSE    = 0x09
	CAM_MSG_STOP_STREAMS_REQUEST      = 0x0A
	CAM_MSG_STOP_STREAMS_RESPONSE     = 0x0B
	CAM_MSG_SAMPLE_REQUEST            = 0x0C
	CAM_MSG_SAMPLE_RESPONSE           = 0x0D
	CAM_MSG_SAMPLE_ERROR_RESPONSE     = 0x0E
	CAM_MSG_PROPERTY_LIST_REQUEST     = 0x0F
	CAM_MSG_PROPERTY_LIST_RESPONSE    = 0x10
	CAM_MSG_PROPERTY_VALUE_REQUEST    = 0x11
	CAM_MSG_PROPERTY_VALUE_RESPONSE   = 0x12
)

// Media format GUIDs (simplified as uint32 sub-types)
const (
	CAM_MEDIA_FORMAT_H264 = 0x34363248 // "H264"
	CAM_MEDIA_FORMAT_NV12 = 0x3231564E // "NV12"
	CAM_MEDIA_FORMAT_YUY2 = 0x32595559 // "YUY2"
)

// Protocol version
const CAM_PROTOCOL_VERSION uint8 = 0x01

// HRESULT codes
const (
	CAM_S_OK    = 0x00000000
	CAM_E_FAIL  = 0x80004005
)

// CamEnumeratorHandler handles the device enumerator DVC channel
type CamEnumeratorHandler struct {
	mu           sync.Mutex
	sendFunc     func([]byte)
	enabled      bool
	deviceID     string
	versionOK    bool
	streamHandler *CamStreamHandler
}

func NewCamEnumeratorHandler(enabled bool) *CamEnumeratorHandler {
	return &CamEnumeratorHandler{
		enabled:  enabled,
		deviceID: "WebCam0",
	}
}

func (h *CamEnumeratorHandler) SetSendFunc(fn func([]byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendFunc = fn
}

func (h *CamEnumeratorHandler) OnChannelCreated() {
	slog.Debug("rdpecam: enumerator channel created")
	// Send SelectVersionRequest
	h.sendSelectVersion()
}

func (h *CamEnumeratorHandler) Process(data []byte) {
	if len(data) < 1 {
		return
	}
	switch data[0] {
	case CAM_MSG_SELECT_VERSION_RESPONSE:
		h.processSelectVersionResponse(data)
	default:
		slog.Debug("rdpecam-enum: unknown msg", "type", data[0])
	}
}

func (h *CamEnumeratorHandler) sendSelectVersion() {
	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_SELECT_VERSION_REQUEST)
	buf.WriteByte(CAM_PROTOCOL_VERSION)
	h.send(buf.Bytes())
	slog.Debug("rdpecam: sent SelectVersionRequest")
}

func (h *CamEnumeratorHandler) processSelectVersionResponse(data []byte) {
	if len(data) < 2 {
		return
	}
	version := data[1]
	slog.Debug("rdpecam: SelectVersionResponse", "version", version)
	h.mu.Lock()
	h.versionOK = true
	h.mu.Unlock()

	if !h.enabled {
		return
	}

	// Send DeviceAddedNotification
	h.sendDeviceAdded()
}

func (h *CamEnumeratorHandler) sendDeviceAdded() {
	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_DEVICE_ADDED_NOTIFICATION)

	// DeviceName — null-terminated UTF-8
	deviceName := "Web Camera"
	buf.WriteString(deviceName)
	buf.WriteByte(0)

	// DeviceId — null-terminated UTF-8 (used in stream channel name)
	buf.WriteString(h.deviceID)
	buf.WriteByte(0)

	h.send(buf.Bytes())
	slog.Debug("rdpecam: sent DeviceAddedNotification", "name", deviceName, "id", h.deviceID)
}

func (h *CamEnumeratorHandler) send(data []byte) {
	h.mu.Lock()
	fn := h.sendFunc
	h.mu.Unlock()
	if fn != nil {
		fn(data)
	}
}

// CamStreamHandler handles a per-device stream DVC channel
type CamStreamHandler struct {
	mu        sync.Mutex
	sendFunc  func([]byte)
	enabled   bool
	streaming bool
	width     uint32
	height    uint32
	fps       uint32
	seqNum    uint32
}

func NewCamStreamHandler(enabled bool) *CamStreamHandler {
	return &CamStreamHandler{
		enabled: enabled,
		width:   640,
		height:  480,
		fps:     30,
	}
}

func (h *CamStreamHandler) SetSendFunc(fn func([]byte)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendFunc = fn
}

func (h *CamStreamHandler) OnChannelCreated() {
	slog.Debug("rdpecam: stream channel created")
}

func (h *CamStreamHandler) Process(data []byte) {
	if len(data) < 1 {
		return
	}
	switch data[0] {
	case CAM_MSG_ACTIVATE_DEVICE_REQUEST:
		h.processActivateDevice(data)
	case CAM_MSG_DEACTIVATE_DEVICE_REQUEST:
		h.processDeactivateDevice(data)
	case CAM_MSG_MEDIA_TYPE_LIST_REQUEST:
		h.processMediaTypeListRequest(data)
	case CAM_MSG_CURRENT_MEDIA_TYPE_REQUEST:
		h.processCurrentMediaTypeRequest(data)
	case CAM_MSG_START_STREAMS_REQUEST:
		h.processStartStreams(data)
	case CAM_MSG_STOP_STREAMS_REQUEST:
		h.processStopStreams(data)
	case CAM_MSG_SAMPLE_REQUEST:
		h.processSampleRequest(data)
	case CAM_MSG_PROPERTY_LIST_REQUEST:
		h.processPropertyListRequest(data)
	default:
		slog.Debug("rdpecam-stream: unknown msg", "type", data[0])
	}
}

func (h *CamStreamHandler) processActivateDevice(data []byte) {
	slog.Debug("rdpecam: ActivateDeviceRequest")
	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_ACTIVATE_DEVICE_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(CAM_S_OK))
	h.send(buf.Bytes())
}

func (h *CamStreamHandler) processDeactivateDevice(data []byte) {
	slog.Debug("rdpecam: DeactivateDeviceRequest")
	h.mu.Lock()
	h.streaming = false
	h.mu.Unlock()
	js.Global().Call("rdpCameraStop")
}

func (h *CamStreamHandler) processMediaTypeListRequest(data []byte) {
	slog.Debug("rdpecam: MediaTypeListRequest")

	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_MEDIA_TYPE_LIST_RESPONSE)

	// Number of media types we support
	numTypes := uint32(3)
	binary.Write(buf, binary.LittleEndian, numTypes)

	// Media type entries: H.264 at different resolutions
	resolutions := [][2]uint32{{640, 480}, {1280, 720}, {1920, 1080}}
	for _, res := range resolutions {
		// Format: subType(4) + width(4) + height(4) + fps_num(4) + fps_den(4) + flags(4)
		binary.Write(buf, binary.LittleEndian, uint32(CAM_MEDIA_FORMAT_H264))
		binary.Write(buf, binary.LittleEndian, res[0]) // width
		binary.Write(buf, binary.LittleEndian, res[1]) // height
		binary.Write(buf, binary.LittleEndian, uint32(30)) // fps numerator
		binary.Write(buf, binary.LittleEndian, uint32(1))  // fps denominator
		binary.Write(buf, binary.LittleEndian, uint32(0))  // flags
	}

	h.send(buf.Bytes())
	slog.Debug("rdpecam: sent MediaTypeListResponse", "types", numTypes)
}

func (h *CamStreamHandler) processCurrentMediaTypeRequest(data []byte) {
	slog.Debug("rdpecam: CurrentMediaTypeRequest")

	// Parse which stream index the server wants
	streamIndex := uint32(0)
	if len(data) >= 5 {
		streamIndex = binary.LittleEndian.Uint32(data[1:5])
	}
	_ = streamIndex

	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_CURRENT_MEDIA_TYPE_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(CAM_MEDIA_FORMAT_H264))
	binary.Write(buf, binary.LittleEndian, h.width)
	binary.Write(buf, binary.LittleEndian, h.height)
	binary.Write(buf, binary.LittleEndian, h.fps)
	binary.Write(buf, binary.LittleEndian, uint32(1)) // fps denominator
	binary.Write(buf, binary.LittleEndian, uint32(0)) // flags
	h.send(buf.Bytes())
}

func (h *CamStreamHandler) processStartStreams(data []byte) {
	slog.Debug("rdpecam: StartStreamsRequest")

	// Parse requested format if provided
	if len(data) >= 21 {
		// subType(4) + width(4) + height(4) + fps_num(4) + fps_den(4)
		h.width = binary.LittleEndian.Uint32(data[5:9])
		h.height = binary.LittleEndian.Uint32(data[9:13])
		h.fps = binary.LittleEndian.Uint32(data[13:17])
		if h.fps == 0 {
			h.fps = 30
		}
	}

	h.mu.Lock()
	h.streaming = true
	h.seqNum = 0
	h.mu.Unlock()

	// Send StartStreamsResponse
	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_START_STREAMS_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(CAM_S_OK))
	h.send(buf.Bytes())

	// Tell JS to start camera capture with H.264 encoding
	js.Global().Call("rdpCameraStart", int(h.width), int(h.height), int(h.fps))
	slog.Debug("rdpecam: streaming started", "width", h.width, "height", h.height, "fps", h.fps)
}

func (h *CamStreamHandler) processStopStreams(data []byte) {
	slog.Debug("rdpecam: StopStreamsRequest")
	h.mu.Lock()
	h.streaming = false
	h.mu.Unlock()

	js.Global().Call("rdpCameraStop")

	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_STOP_STREAMS_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(CAM_S_OK))
	h.send(buf.Bytes())
}

func (h *CamStreamHandler) processSampleRequest(data []byte) {
	// Server is requesting a frame — we send them asynchronously from JS
	// via SendSample(), so we just acknowledge readiness here
	h.mu.Lock()
	h.seqNum++
	h.mu.Unlock()
}

func (h *CamStreamHandler) processPropertyListRequest(data []byte) {
	slog.Debug("rdpecam: PropertyListRequest")
	// Send empty property list
	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_PROPERTY_LIST_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(0)) // numProperties
	h.send(buf.Bytes())
}

// SendSample sends an H.264 encoded frame to the server
func (h *CamStreamHandler) SendSample(frameData []byte, isKeyFrame bool) {
	h.mu.Lock()
	streaming := h.streaming
	seq := h.seqNum
	h.mu.Unlock()
	if !streaming || len(frameData) == 0 {
		return
	}

	buf := &bytes.Buffer{}
	buf.WriteByte(CAM_MSG_SAMPLE_RESPONSE)
	binary.Write(buf, binary.LittleEndian, uint32(0)) // streamIndex
	binary.Write(buf, binary.LittleEndian, seq)        // sequenceNumber

	// Flags: 1 = keyframe
	flags := uint32(0)
	if isKeyFrame {
		flags = 1
	}
	binary.Write(buf, binary.LittleEndian, flags)
	binary.Write(buf, binary.LittleEndian, uint32(len(frameData)))
	buf.Write(frameData)

	h.send(buf.Bytes())
}

func (h *CamStreamHandler) send(data []byte) {
	h.mu.Lock()
	fn := h.sendFunc
	h.mu.Unlock()
	if fn != nil {
		fn(data)
	}
}

func (h *CamStreamHandler) Close() {
	h.mu.Lock()
	h.streaming = false
	h.mu.Unlock()
	js.Global().Call("rdpCameraStop")
}
