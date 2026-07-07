//go:build js && wasm

// rdpefs.go — MS-RDPEFS (File System Virtual Channel Extension) over rdpdr
//
// Implements the rdpdr static virtual channel to expose one or more drives
// to the remote Windows desktop as redirected drives (\\tsclient\NAME).
//
// Two operating modes:
//   1. LOCAL mode (legacy): files come from browser FileSystem API via
//      rdpStorageGetFiles/rdpStorageReadFile. Single drive named "WEBRDP".
//   2. AGENT mode: files come from remote Zephyr Agents via
//      globalThis.zephyrRdpFs.* JS callbacks. Supports multiple drives,
//      hot-plug attach/detach while RDP session is running.
//
// Hot-plug protocol (AGENT mode):
//   - After user logs on, existing drives are announced.
//   - JS calls rdpFsAttachDrive(agentId, driveName, readOnly) to add a new
//     drive at runtime → Go sends DEVICELIST_ANNOUNCE for the new device.
//   - JS calls rdpFsDetachDrive(agentId) to remove a drive at runtime →
//     Go sends DEVICELIST_REMOVE and cleans up open handles.
//
// Supported IRP types:
//   IRP_MJ_CREATE, IRP_MJ_CLOSE, IRP_MJ_READ, IRP_MJ_WRITE,
//   IRP_MJ_QUERY_INFORMATION, IRP_MJ_SET_INFORMATION,
//   IRP_MJ_QUERY_DIRECTORY, IRP_MJ_QUERY_VOLUME,
//   IRP_MJ_DIRECTORY_CONTROL, IRP_MJ_LOCK_CONTROL (stub)
//   IRP_MJ_DEVICE_CONTROL (stub)

package main

import (
	"bytes"
	"encoding/binary"
	"log/slog"
	"strings"
	"sync"
	"syscall/js"
	"time"
	"unicode/utf16"

	"github.com/nakagami/grdp/core"
)

// rdpdr packet component types
const (
	RDPDR_CTYP_CORE = 0x4472 // "Dr"
	RDPDR_CTYP_PRN  = 0x5052 // "PR"
)

// rdpdr packet IDs
const (
	PAKID_CORE_SERVER_ANNOUNCE     = 0x496E
	PAKID_CORE_CLIENTID_CONFIRM    = 0x4343
	PAKID_CORE_CLIENT_NAME         = 0x434E
	PAKID_CORE_DEVICELIST_ANNOUNCE = 0x4441
	PAKID_CORE_DEVICE_REPLY        = 0x6452
	PAKID_CORE_DEVICE_IOREQUEST    = 0x4952
	PAKID_CORE_DEVICE_IOCOMPLETION = 0x4943
	PAKID_CORE_SERVER_CAPABILITY   = 0x5350
	PAKID_CORE_CLIENT_CAPABILITY   = 0x4350
	PAKID_CORE_USER_LOGGEDON       = 0x554C
	PAKID_CORE_DEVICELIST_REMOVE   = 0x444D
)

// rdpdr protocol version
const (
	RDPDR_VERSION_MAJOR        = 0x0001
	RDPDR_VERSION_MINOR_RDP51  = 0x0005
	RDPDR_VERSION_MINOR_RDP10X = 0x000D
)

// Capability set versions
const (
	GENERAL_CAPABILITY_VERSION_02 = 0x00000002
	DRIVE_CAPABILITY_VERSION_02   = 0x00000002
)

// Device types
const (
	RDPDR_DTYP_FILESYSTEM = 0x00000008
)

// IRP major functions
const (
	IRP_MJ_CREATE            = 0x00000000
	IRP_MJ_CLEANUP           = 0x00000001
	IRP_MJ_CLOSE             = 0x00000002
	IRP_MJ_READ              = 0x00000003
	IRP_MJ_WRITE             = 0x00000004
	IRP_MJ_QUERY_INFORMATION = 0x00000005
	IRP_MJ_SET_INFORMATION   = 0x00000006
	IRP_MJ_FLUSH_BUFFERS     = 0x00000009
	IRP_MJ_QUERY_VOLUME      = 0x0000000A
	IRP_MJ_SET_VOLUME        = 0x0000000B
	IRP_MJ_DIRECTORY_CONTROL = 0x0000000C
	IRP_MJ_DEVICE_CONTROL    = 0x0000000E
	IRP_MJ_SHUTDOWN          = 0x00000010
	IRP_MJ_LOCK_CONTROL      = 0x00000011
	IRP_MJ_QUERY_SECURITY    = 0x00000014
	IRP_MJ_SET_SECURITY      = 0x00000015
)

// GENERAL_CAPS_SET.ioCode1 bitmask values (not IRP major function numbers).
const (
	RDPDR_IRP_MJ_CREATE_BIT                   = 0x00000001
	RDPDR_IRP_MJ_CLEANUP_BIT                  = 0x00000002
	RDPDR_IRP_MJ_CLOSE_BIT                    = 0x00000004
	RDPDR_IRP_MJ_READ_BIT                     = 0x00000008
	RDPDR_IRP_MJ_WRITE_BIT                    = 0x00000010
	RDPDR_IRP_MJ_FLUSH_BUFFERS_BIT            = 0x00000020
	RDPDR_IRP_MJ_SHUTDOWN_BIT                 = 0x00000040
	RDPDR_IRP_MJ_DEVICE_CONTROL_BIT           = 0x00000080
	RDPDR_IRP_MJ_QUERY_VOLUME_INFORMATION_BIT = 0x00000100
	RDPDR_IRP_MJ_SET_VOLUME_INFORMATION_BIT   = 0x00000200
	RDPDR_IRP_MJ_QUERY_INFORMATION_BIT        = 0x00000400
	RDPDR_IRP_MJ_SET_INFORMATION_BIT          = 0x00000800
	RDPDR_IRP_MJ_DIRECTORY_CONTROL_BIT        = 0x00001000
	RDPDR_IRP_MJ_LOCK_CONTROL_BIT             = 0x00002000
)

const (
	RDPDR_DEVICE_REMOVE_PDUS      = 0x00000001
	RDPDR_CLIENT_DISPLAY_NAME_PDU = 0x00000002
	RDPDR_USER_LOGGEDON_PDU       = 0x00000004
	RDPDR_ENABLE_ASYNCIO          = 0x00000001
)

// IRP minor functions for IRP_MJ_DIRECTORY_CONTROL
const (
	IRP_MN_QUERY_DIRECTORY         = 0x00000001
	IRP_MN_NOTIFY_CHANGE_DIRECTORY = 0x00000002
)

// File information classes
const (
	FileBasicInformation         = 4
	FileStandardInformation      = 5
	FileAttributeTagInformation  = 35
	FileBothDirectoryInformation = 3
	FileDirectoryInformation     = 1
	FileFullDirectoryInformation = 2
	FileNamesInformation         = 12
	FileEndOfFileInformation     = 20
	FileDispositionInformation   = 13
	FileRenameInformation        = 10
	FileAllocationInformation    = 19
)

// NT status codes
const (
	STATUS_SUCCESS                = 0x00000000
	STATUS_NO_MORE_FILES          = 0x80000006
	STATUS_NOT_IMPLEMENTED        = 0xC0000002
	STATUS_NO_SUCH_FILE           = 0xC000000F
	STATUS_END_OF_FILE            = 0xC0000011
	STATUS_OBJECT_NAME_NOT_FOUND  = 0xC0000034
	STATUS_ACCESS_DENIED          = 0xC0000022
	STATUS_NOT_SUPPORTED          = 0xC00000BB
	STATUS_INVALID_PARAMETER      = 0xC000000D
	STATUS_UNSUCCESSFUL           = 0xC0000001
	STATUS_INVALID_DEVICE_REQUEST = 0xC0000010
	STATUS_OBJECT_NAME_COLLISION  = 0xC0000035
	STATUS_DIRECTORY_NOT_EMPTY    = 0xC0000101
	STATUS_DEVICE_OFF_LINE        = 0x80000010
)

// File attributes
const (
	FILE_ATTRIBUTE_READONLY  = 0x00000001
	FILE_ATTRIBUTE_DIRECTORY = 0x00000010
	FILE_ATTRIBUTE_ARCHIVE   = 0x00000020
	FILE_ATTRIBUTE_NORMAL    = 0x00000080
)

// Capability types
const (
	CAP_GENERAL_TYPE   = 0x0001
	CAP_PRINTER_TYPE   = 0x0002
	CAP_PORT_TYPE      = 0x0003
	CAP_DRIVE_TYPE     = 0x0004
	CAP_SMARTCARD_TYPE = 0x0005
)

// Create disposition
const (
	FILE_SUPERSEDE    = 0x00000000
	FILE_OPEN         = 0x00000001
	FILE_CREATE       = 0x00000002
	FILE_OPEN_IF      = 0x00000003
	FILE_OVERWRITE    = 0x00000004
	FILE_OVERWRITE_IF = 0x00000005
)

// Create options
const (
	FILE_DIRECTORY_FILE     = 0x00000001
	FILE_NON_DIRECTORY_FILE = 0x00000040
)

// Information response values
const (
	FILE_SUPERSEDED  = 0x00000000
	FILE_OPENED      = 0x00000001
	FILE_OVERWRITTEN = 0x00000003
)

// ─── Drive Management ────────────────────────────────────────────

// DriveMode determines how file data is accessed
type DriveMode int

const (
	DriveModeLocal DriveMode = iota // legacy: rdpStorageGetFiles
	DriveModeAgent                  // remote: zephyrRdpFs.*
)

type DriveState struct {
	DeviceID  uint32
	AgentID   string
	DriveName string
	ReadOnly  bool
	Mode      DriveMode
	Status    string // "online", "attaching", "detaching", "removed"
}

// VirtualFile represents a file entry from local or remote provider
type VirtualFile struct {
	Name     string
	IsDir    bool
	Size     int64
	ModTime  time.Time
	Data     []byte // file content (loaded lazily)
	Children map[string]*VirtualFile
}

// openHandle tracks an open file/directory for IRP processing
type openHandle struct {
	DriveDeviceID uint32
	AgentID       string
	Path          string
	IsDir         bool
	RemoteHandle  string // handle ID from agent (for agent mode reads)
	// For local mode compatibility
	LocalFile *VirtualFile
}

type dirEnumState struct {
	entries []*VirtualFile
	index   int
}

// RdpefsHandler implements plugin.ChannelTransport for the rdpdr SVC
type RdpefsHandler struct {
	mu      sync.Mutex
	sender  func(string, []byte) (int, error)
	enabled bool

	clientID     uint32
	versionMajor uint16
	versionMinor uint16

	// Multi-drive management
	nextDeviceID uint32
	drives       map[uint32]*DriveState // deviceID → drive
	agentDrives  map[string]uint32      // agentID → deviceID

	// File handle management
	nextFileID uint32
	handles    map[uint32]*openHandle // fileID → handle
	dirEnum    map[uint32]*dirEnumState

	// Legacy local mode support
	localRoot *VirtualFile

	// Protocol state
	userLoggedOn bool
	announced    bool
}

func NewRdpefsHandler(enabled bool) *RdpefsHandler {
	return &RdpefsHandler{
		enabled:      enabled,
		nextDeviceID: 1,
		nextFileID:   1,
		drives:       make(map[uint32]*DriveState),
		agentDrives:  make(map[string]uint32),
		handles:      make(map[uint32]*openHandle),
		dirEnum:      make(map[uint32]*dirEnumState),
		localRoot: &VirtualFile{
			Name:     "",
			IsDir:    true,
			Children: make(map[string]*VirtualFile),
		},
	}
}

func (h *RdpefsHandler) GetType() (string, uint32) {
	return "rdpdr", 0x80000000 | 0x40000000 | 0x00400000
}

func (h *RdpefsHandler) Sender(cs core.ChannelSender) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sender = cs.SendToChannel
}

func (h *RdpefsHandler) send(data []byte) {
	h.mu.Lock()
	fn := h.sender
	h.mu.Unlock()
	if fn != nil {
		fn("rdpdr", data)
	}
}

// ─── Drive lifecycle (called from JS) ────────────────────────────

// AttachDrive adds a new remote agent drive. Can be called before or
// after user logon. If after logon, sends an immediate device announce.
func (h *RdpefsHandler) AttachDrive(agentID, driveName string, readOnly bool) uint32 {
	h.mu.Lock()
	// Check if already attached
	if existingID, ok := h.agentDrives[agentID]; ok {
		// Already attached — update info and return existing
		if d := h.drives[existingID]; d != nil {
			d.DriveName = driveName
			d.ReadOnly = readOnly
			d.Status = "online"
		}
		h.mu.Unlock()
		return existingID
	}

	deviceID := h.nextDeviceID
	h.nextDeviceID++

	drive := &DriveState{
		DeviceID:  deviceID,
		AgentID:   agentID,
		DriveName: driveName,
		ReadOnly:  readOnly,
		Mode:      DriveModeAgent,
		Status:    "attaching",
	}
	h.drives[deviceID] = drive
	h.agentDrives[agentID] = deviceID
	loggedOn := h.userLoggedOn
	h.mu.Unlock()

	slog.Debug("rdpefs: attach drive", "agentID", agentID, "name", driveName, "deviceID", deviceID)

	if loggedOn {
		h.announceDeviceSingle(deviceID, driveName)
		h.mu.Lock()
		drive.Status = "online"
		h.mu.Unlock()
	}

	return deviceID
}

// DetachDrive removes a drive. Closes all open handles and sends device remove.
func (h *RdpefsHandler) DetachDrive(agentID string) {
	h.mu.Lock()
	deviceID, ok := h.agentDrives[agentID]
	if !ok {
		h.mu.Unlock()
		return
	}
	drive := h.drives[deviceID]
	if drive != nil {
		drive.Status = "detaching"
	}

	// Close all handles for this device
	for fid, handle := range h.handles {
		if handle.DriveDeviceID == deviceID {
			// If agent mode handle, close remote handle
			if handle.RemoteHandle != "" {
				go h.callAgentClose(agentID, handle.RemoteHandle)
			}
			delete(h.handles, fid)
			delete(h.dirEnum, fid)
		}
	}

	delete(h.drives, deviceID)
	delete(h.agentDrives, agentID)
	loggedOn := h.userLoggedOn
	h.mu.Unlock()

	slog.Debug("rdpefs: detach drive", "agentID", agentID, "deviceID", deviceID)

	if loggedOn {
		// Send Client Drive Device List Remove
		buf := &bytes.Buffer{}
		binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
		binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICELIST_REMOVE))
		binary.Write(buf, binary.LittleEndian, uint32(1)) // deviceCount
		binary.Write(buf, binary.LittleEndian, deviceID)
		h.send(buf.Bytes())
	}
}

// ListDrives returns info about all current drives (for JS)
func (h *RdpefsHandler) ListDrives() []map[string]interface{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	result := make([]map[string]interface{}, 0, len(h.drives))
	for _, d := range h.drives {
		result = append(result, map[string]interface{}{
			"deviceId":  d.DeviceID,
			"agentId":   d.AgentID,
			"driveName": d.DriveName,
			"readOnly":  d.ReadOnly,
			"status":    d.Status,
		})
	}
	return result
}

// ─── Protocol handling ───────────────────────────────────────────

func (h *RdpefsHandler) Process(data []byte) {
	if len(data) < 4 {
		return
	}
	component := binary.LittleEndian.Uint16(data[0:2])
	packetID := binary.LittleEndian.Uint16(data[2:4])

	if component != RDPDR_CTYP_CORE {
		return
	}

	switch packetID {
	case PAKID_CORE_SERVER_ANNOUNCE:
		h.processServerAnnounce(data[4:])
	case PAKID_CORE_SERVER_CAPABILITY:
		h.processServerCapability(data[4:])
	case PAKID_CORE_DEVICE_REPLY:
		h.processDeviceReply(data[4:])
	case PAKID_CORE_DEVICE_IOREQUEST:
		h.processIORequest(data[4:])
	case PAKID_CORE_USER_LOGGEDON:
		h.processUserLoggedOn()
	default:
		slog.Debug("rdpefs: unknown packet", "component", component, "packetID", packetID)
	}
}

func (h *RdpefsHandler) processServerAnnounce(data []byte) {
	if len(data) < 8 {
		return
	}
	h.versionMajor = binary.LittleEndian.Uint16(data[0:2])
	h.versionMinor = binary.LittleEndian.Uint16(data[2:4])
	h.clientID = binary.LittleEndian.Uint32(data[4:8])
	slog.Debug("rdpefs: server announce", "major", h.versionMajor, "minor", h.versionMinor, "clientID", h.clientID)

	// Send Client Announce Reply
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_CLIENTID_CONFIRM))
	binary.Write(buf, binary.LittleEndian, uint16(1))
	binary.Write(buf, binary.LittleEndian, uint16(12))
	binary.Write(buf, binary.LittleEndian, h.clientID)
	h.send(buf.Bytes())

	// Send Client Name Request
	nameBuf := &bytes.Buffer{}
	binary.Write(nameBuf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(nameBuf, binary.LittleEndian, uint16(PAKID_CORE_CLIENT_NAME))
	binary.Write(nameBuf, binary.LittleEndian, uint32(1))
	binary.Write(nameBuf, binary.LittleEndian, uint32(0))
	computerName := encodeUTF16LE("WEBRDP")
	binary.Write(nameBuf, binary.LittleEndian, uint32(len(computerName)))
	nameBuf.Write(computerName)
	h.send(nameBuf.Bytes())
}

func (h *RdpefsHandler) processServerCapability(data []byte) {
	slog.Debug("rdpefs: server capability received")

	// Refresh local file list (legacy mode)
	h.refreshLocalFileList()

	// Send Client Core Capability Response
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_CLIENT_CAPABILITY))
	binary.Write(buf, binary.LittleEndian, uint16(1))
	binary.Write(buf, binary.LittleEndian, uint16(0))

	// General capability set
	binary.Write(buf, binary.LittleEndian, uint16(CAP_GENERAL_TYPE))
	binary.Write(buf, binary.LittleEndian, uint16(44))
	binary.Write(buf, binary.LittleEndian, uint32(1))
	binary.Write(buf, binary.LittleEndian, uint32(2))
	binary.Write(buf, binary.LittleEndian, uint32(0))
	binary.Write(buf, binary.LittleEndian, uint16(1))
	binary.Write(buf, binary.LittleEndian, uint16(12))
	binary.Write(buf, binary.LittleEndian, uint32(0xFFFF))
	binary.Write(buf, binary.LittleEndian, uint32(0))
	binary.Write(buf, binary.LittleEndian, uint32(7)) // RDPDR_DEVICE_REMOVE|USER_LOGGEDON|CLIENT_DISPLAY_NAME
	binary.Write(buf, binary.LittleEndian, uint32(0))
	binary.Write(buf, binary.LittleEndian, uint32(0))
	binary.Write(buf, binary.LittleEndian, uint32(0))
	h.send(buf.Bytes())

	// RDP 5.1 servers don't send USER_LOGGEDON — announce immediately
	if h.enabled && h.versionMinor == RDPDR_VERSION_MINOR_RDP51 {
		h.announceAllDevices()
	}
}

func (h *RdpefsHandler) processUserLoggedOn() {
	slog.Debug("rdpefs: user logged on")
	h.mu.Lock()
	h.userLoggedOn = true
	already := h.announced
	h.mu.Unlock()
	if h.enabled && !already {
		h.refreshLocalFileList()
		h.announceAllDevices()
	}
}

// announceAllDevices sends a single device list announce for all drives
func (h *RdpefsHandler) announceAllDevices() {
	h.mu.Lock()
	h.announced = true

	// Collect all drives to announce
	type devEntry struct {
		deviceID  uint32
		driveName string
	}
	var entries []devEntry

	// Always include local WEBRDP drive if it has files
	hasLocalFiles := len(h.localRoot.Children) > 0
	if hasLocalFiles {
		localDevID := uint32(0) // device 0 = local
		if _, exists := h.drives[localDevID]; !exists {
			h.drives[localDevID] = &DriveState{
				DeviceID:  localDevID,
				DriveName: "WEBRDP",
				Mode:      DriveModeLocal,
				Status:    "online",
			}
		}
		entries = append(entries, devEntry{localDevID, "WEBRDP"})
	}

	// Agent drives
	for _, d := range h.drives {
		if d.Mode == DriveModeAgent && d.Status != "removed" {
			entries = append(entries, devEntry{d.DeviceID, d.DriveName})
			d.Status = "online"
		}
	}
	h.mu.Unlock()

	if len(entries) == 0 {
		// Announce empty list
		buf := &bytes.Buffer{}
		binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
		binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICELIST_ANNOUNCE))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		h.send(buf.Bytes())
		return
	}

	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICELIST_ANNOUNCE))
	binary.Write(buf, binary.LittleEndian, uint32(len(entries)))

	for _, e := range entries {
		binary.Write(buf, binary.LittleEndian, uint32(RDPDR_DTYP_FILESYSTEM))
		binary.Write(buf, binary.LittleEndian, e.deviceID)
		dosName := makeDosName(e.driveName)
		buf.Write(dosName)
		binary.Write(buf, binary.LittleEndian, uint32(0)) // DeviceDataLength
	}

	h.send(buf.Bytes())
	slog.Debug("rdpefs: announced devices", "count", len(entries))
}

// announceDeviceSingle sends a device list announce for a single drive (hot-plug)
func (h *RdpefsHandler) announceDeviceSingle(deviceID uint32, driveName string) {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICELIST_ANNOUNCE))
	binary.Write(buf, binary.LittleEndian, uint32(1))

	binary.Write(buf, binary.LittleEndian, uint32(RDPDR_DTYP_FILESYSTEM))
	binary.Write(buf, binary.LittleEndian, deviceID)
	dosName := makeDosName(driveName)
	buf.Write(dosName)
	binary.Write(buf, binary.LittleEndian, uint32(0))

	h.send(buf.Bytes())
	slog.Debug("rdpefs: announced single device", "name", driveName, "id", deviceID)
}

func makeDosName(name string) []byte {
	dosName := make([]byte, 8)
	upper := strings.ToUpper(name)
	j := 0
	for i := 0; i < len(upper) && j < 8; i++ {
		c := upper[i]
		if c > 0x7F {
			continue
		}
		if (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '$' || c == '~' || c == '-' {
			dosName[j] = c
			j++
		}
	}
	if j == 0 {
		copy(dosName, []byte("ZEPHYR"))
	}
	return dosName
}

func (h *RdpefsHandler) processDeviceReply(data []byte) {
	if len(data) < 8 {
		return
	}
	deviceID := binary.LittleEndian.Uint32(data[0:4])
	status := binary.LittleEndian.Uint32(data[4:8])
	slog.Debug("rdpefs: device reply", "deviceID", deviceID, "status", status)
}

// ─── IRP Processing ──────────────────────────────────────────────

func (h *RdpefsHandler) processIORequest(data []byte) {
	if len(data) < 20 {
		return
	}
	deviceID := binary.LittleEndian.Uint32(data[0:4])
	fileID := binary.LittleEndian.Uint32(data[4:8])
	completionID := binary.LittleEndian.Uint32(data[8:12])
	majorFunction := binary.LittleEndian.Uint32(data[12:16])
	minorFunction := binary.LittleEndian.Uint32(data[16:20])
	payload := data[20:]

	switch majorFunction {
	case IRP_MJ_CREATE:
		h.handleCreate(deviceID, completionID, payload)
	case IRP_MJ_CLOSE:
		h.handleClose(deviceID, completionID, fileID)
	case IRP_MJ_READ:
		h.handleRead(deviceID, completionID, fileID, payload)
	case IRP_MJ_WRITE:
		h.handleWrite(deviceID, completionID, fileID, payload)
	case IRP_MJ_QUERY_INFORMATION:
		h.handleQueryInformation(deviceID, completionID, fileID, payload)
	case IRP_MJ_SET_INFORMATION:
		h.handleSetInformation(deviceID, completionID, fileID, payload)
	case IRP_MJ_DIRECTORY_CONTROL:
		h.handleDirectoryControl(deviceID, completionID, fileID, minorFunction, payload)
	case IRP_MJ_QUERY_VOLUME:
		h.handleQueryVolume(deviceID, completionID, payload)
	case IRP_MJ_CLEANUP:
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, nil)
	case IRP_MJ_FLUSH_BUFFERS:
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, nil)
	case IRP_MJ_SHUTDOWN:
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, nil)
	case IRP_MJ_SET_VOLUME:
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, zeroLengthPayload())
	case IRP_MJ_QUERY_SECURITY, IRP_MJ_SET_SECURITY:
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, zeroLengthPayload())
	case IRP_MJ_LOCK_CONTROL:
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, zeroLengthPayload())
	case IRP_MJ_DEVICE_CONTROL:
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, zeroLengthPayload())
	default:
		slog.Debug("rdpefs: unsupported IRP", "major", majorFunction, "minor", minorFunction)
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, nil)
	}
}

func (h *RdpefsHandler) getDrive(deviceID uint32) *DriveState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.drives[deviceID]
}

// ─── IRP_MJ_CREATE ───────────────────────────────────────────────

func (h *RdpefsHandler) handleCreate(deviceID, completionID uint32, data []byte) {
	if len(data) < 32 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	desiredAccess := binary.LittleEndian.Uint32(data[0:4])
	_ = desiredAccess
	createDisposition := binary.LittleEndian.Uint32(data[20:24])
	createOptions := binary.LittleEndian.Uint32(data[24:28])
	pathLen := binary.LittleEndian.Uint32(data[28:32])
	pathBytes := data[32:]
	if uint32(len(pathBytes)) < pathLen {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	rdpPath := decodeUTF16LE(pathBytes[:pathLen])
	rdpPath = strings.TrimRight(rdpPath, "\x00")
	rdpPath = strings.ReplaceAll(rdpPath, "\\", "/")
	rdpPath = strings.TrimPrefix(rdpPath, "/")

	slog.Debug("rdpefs: CREATE", "device", deviceID, "path", rdpPath, "disp", createDisposition, "opts", createOptions)

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		h.handleCreateAgent(drive, completionID, rdpPath, createDisposition, createOptions)
	} else {
		h.handleCreateLocal(deviceID, completionID, rdpPath, createDisposition, createOptions)
	}
}

func (h *RdpefsHandler) handleCreateAgent(drive *DriveState, completionID uint32, path string, createDisposition, createOptions uint32) {
	deviceID := drive.DeviceID
	agentID := drive.AgentID
	readOnly := drive.ReadOnly

	// For write operations on read-only drive
	isWriteDisp := createDisposition == FILE_CREATE || createDisposition == FILE_OPEN_IF ||
		createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE ||
		createDisposition == FILE_OVERWRITE
	if readOnly && isWriteDisp {
		h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
		return
	}

	// Call agent stat to check if path exists
	statResult := h.callAgentStat(agentID, path)
	exists := statResult != nil

	if !exists {
		if isWriteDisp && !readOnly {
			// Create file/dir via agent
			if createOptions&FILE_DIRECTORY_FILE != 0 {
				mkdirResult := h.callAgentMkdir(agentID, path)
				if !mkdirResult {
					h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
					return
				}
				statResult = h.callAgentStat(agentID, path)
				if statResult == nil {
					h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
					return
				}
			} else {
				// Open for write → open in write mode on agent
				mode := "write"
				if createDisposition == FILE_OVERWRITE || createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE {
					mode = "writeTruncate"
				}
				handle := h.callAgentOpen(agentID, path, mode)
				if handle == "" {
					h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
					return
				}
				h.mu.Lock()
				fid := h.nextFileID
				h.nextFileID++
				h.handles[fid] = &openHandle{
					DriveDeviceID: deviceID,
					AgentID:       agentID,
					Path:          path,
					IsDir:         false,
					RemoteHandle:  handle,
				}
				h.mu.Unlock()
				resp := &bytes.Buffer{}
				binary.Write(resp, binary.LittleEndian, fid)
				binary.Write(resp, binary.LittleEndian, uint8(0))
				h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
				return
			}
		} else {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
			return
		}
	}

	isDir := (*statResult).Get("isDir").Bool()
	if createOptions&FILE_DIRECTORY_FILE != 0 && !isDir {
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}
	if createOptions&FILE_NON_DIRECTORY_FILE != 0 && isDir {
		h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
		return
	}

	// Determine mode for agent open
	mode := "read"
	if isWriteDisp && !readOnly {
		mode = "write"
		if createDisposition == FILE_OVERWRITE || createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE {
			mode = "writeTruncate"
		}
	}

	remoteHandle := ""
	if !isDir {
		remoteHandle = h.callAgentOpen(agentID, path, mode)
		// It's OK if open fails for read — we'll stat-only
	}

	h.mu.Lock()
	fid := h.nextFileID
	h.nextFileID++
	h.handles[fid] = &openHandle{
		DriveDeviceID: deviceID,
		AgentID:       agentID,
		Path:          path,
		IsDir:         isDir,
		RemoteHandle:  remoteHandle,
	}
	h.mu.Unlock()

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, fid)
	binary.Write(resp, binary.LittleEndian, uint8(0))
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

func (h *RdpefsHandler) handleCreateLocal(deviceID, completionID uint32, path string, createDisposition, createOptions uint32) {
	h.mu.Lock()
	file := h.resolveLocalPath(path)
	if file == nil {
		h.mu.Unlock()
		isWriteDisp := createDisposition == FILE_CREATE || createDisposition == FILE_OPEN_IF ||
			createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE
		if isWriteDisp {
			h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
			return
		}
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	if createOptions&FILE_DIRECTORY_FILE != 0 && !file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}
	if createOptions&FILE_NON_DIRECTORY_FILE != 0 && file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
		return
	}

	fid := h.nextFileID
	h.nextFileID++
	h.handles[fid] = &openHandle{
		DriveDeviceID: deviceID,
		Path:          path,
		IsDir:         file.IsDir,
		LocalFile:     file,
	}
	h.mu.Unlock()

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, fid)
	binary.Write(resp, binary.LittleEndian, uint8(0))
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

// ─── IRP_MJ_CLOSE ───────────────────────────────────────────────

func fiveBytePaddingPayload() []byte {
	return []byte{0, 0, 0, 0, 0}
}

func (h *RdpefsHandler) handleClose(deviceID, completionID, fileID uint32) {
	h.mu.Lock()
	handle := h.handles[fileID]
	delete(h.handles, fileID)
	delete(h.dirEnum, fileID)
	h.mu.Unlock()

	if handle != nil && handle.RemoteHandle != "" {
		go h.callAgentClose(handle.AgentID, handle.RemoteHandle)
	}

	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, fiveBytePaddingPayload())
}

// ─── IRP_MJ_READ ────────────────────────────────────────────────

func (h *RdpefsHandler) handleRead(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 12 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	length := binary.LittleEndian.Uint32(data[0:4])
	offset := binary.LittleEndian.Uint64(data[4:12])

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil || handle.IsDir {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_DEVICE_REQUEST, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		// Read from remote agent
		readHandle := handle.RemoteHandle
		if readHandle == "" {
			// Try to open for read
			readHandle = h.callAgentOpen(handle.AgentID, handle.Path, "read")
			if readHandle == "" {
				h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
				return
			}
			h.mu.Lock()
			handle.RemoteHandle = readHandle
			h.mu.Unlock()
		}

		chunk := h.callAgentRead(handle.AgentID, readHandle, offset, length)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(chunk)))
		if len(chunk) > 0 {
			resp.Write(chunk)
		}
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		// Local mode read
		file := handle.LocalFile
		if file == nil {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
			return
		}
		if file.Data == nil {
			h.loadLocalFileData(file)
		}
		start := int(offset)
		if start >= len(file.Data) {
			resp := &bytes.Buffer{}
			binary.Write(resp, binary.LittleEndian, uint32(0))
			h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
			return
		}
		end := start + int(length)
		if end > len(file.Data) {
			end = len(file.Data)
		}
		chunk := file.Data[start:end]
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(chunk)))
		resp.Write(chunk)
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	}
}

// ─── IRP_MJ_WRITE ───────────────────────────────────────────────

func (h *RdpefsHandler) handleWrite(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 32 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	length := binary.LittleEndian.Uint32(data[0:4])
	offset := binary.LittleEndian.Uint64(data[4:12])
	// data[12:32] = padding (20 bytes)
	writeData := data[32:]
	if uint32(len(writeData)) < length {
		writeData = writeData[:len(writeData)]
	} else {
		writeData = writeData[:length]
	}

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil || handle.IsDir {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_DEVICE_REQUEST, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil || drive.ReadOnly {
		h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		writeHandle := handle.RemoteHandle
		if writeHandle == "" {
			h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
			return
		}
		written := h.callAgentWrite(handle.AgentID, writeHandle, offset, writeData)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(written))
		binary.Write(resp, binary.LittleEndian, uint8(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		// Local mode: read-only
		h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
	}
}

// ─── IRP_MJ_SET_INFORMATION ─────────────────────────────────────

func (h *RdpefsHandler) handleSetInformation(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	switch infoClass {
	case FileBasicInformation:
		// Set timestamps — acknowledge without action
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileEndOfFileInformation:
		if drive.ReadOnly {
			h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent && len(data) >= 12 {
			newSize := binary.LittleEndian.Uint64(data[4:12])
			ok := h.callAgentTruncate(handle.AgentID, handle.Path, newSize)
			if !ok {
				h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
				return
			}
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileDispositionInformation:
		if drive.ReadOnly {
			h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent {
			ok := h.callAgentDelete(handle.AgentID, handle.Path)
			if !ok {
				h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
				return
			}
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileRenameInformation:
		if drive.ReadOnly {
			h.sendIOCompletion(deviceID, completionID, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent && len(data) >= 14 {
			// Parse rename info: replaceIfExists(1) + rootDir(1) + fileNameLen(4) + fileName(UTF-16LE)
			fnLen := binary.LittleEndian.Uint32(data[10:14])
			if uint32(len(data)) >= 14+fnLen {
				newPath := decodeUTF16LE(data[14 : 14+fnLen])
				newPath = strings.TrimRight(newPath, "\x00")
				newPath = strings.ReplaceAll(newPath, "\\", "/")
				newPath = strings.TrimPrefix(newPath, "/")
				ok := h.callAgentRename(handle.AgentID, handle.Path, newPath)
				if !ok {
					h.sendIOCompletion(deviceID, completionID, STATUS_UNSUCCESSFUL, nil)
					return
				}
				h.mu.Lock()
				handle.Path = newPath
				h.mu.Unlock()
			}
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileAllocationInformation:
		// Acknowledge without action
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	default:
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, nil)
	}
}

// ─── IRP_MJ_QUERY_INFORMATION ───────────────────────────────────

func (h *RdpefsHandler) handleQueryInformation(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	// Get file metadata
	var isDir bool
	var size int64
	var mtime time.Time

	if drive.Mode == DriveModeAgent {
		stat := h.callAgentStat(handle.AgentID, handle.Path)
		if stat == nil {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
			return
		}
		isDir = (*stat).Get("isDir").Bool()
		size = int64((*stat).Get("size").Int())
		mtime = time.UnixMilli(int64((*stat).Get("mtime").Float()))
	} else {
		file := handle.LocalFile
		if file == nil {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
			return
		}
		isDir = file.IsDir
		size = file.Size
		if file.Data != nil {
			size = int64(len(file.Data))
		}
		mtime = file.ModTime
	}

	var info []byte
	switch infoClass {
	case FileBasicInformation:
		info = buildBasicInfo(isDir, mtime)
	case FileStandardInformation:
		info = buildStandardInfo(isDir, size)
	case FileAttributeTagInformation:
		info = buildAttributeTagInfo(isDir)
	default:
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, nil)
		return
	}

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, uint32(len(info)))
	resp.Write(info)
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

// ─── IRP_MJ_DIRECTORY_CONTROL ───────────────────────────────────

func (h *RdpefsHandler) handleDirectoryControl(deviceID, completionID, fileID, minorFunction uint32, data []byte) {
	if minorFunction == IRP_MN_NOTIFY_CHANGE_DIRECTORY {
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, zeroLengthPayload())
		return
	}
	if minorFunction != IRP_MN_QUERY_DIRECTORY {
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, zeroLengthPayload())
		return
	}
	if len(data) < 32 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}

	infoClass := binary.LittleEndian.Uint32(data[0:4])
	initialQuery := data[4]
	pathLen := binary.LittleEndian.Uint32(data[5:9])
	var pattern string
	if pathLen > 0 && len(data) >= 32+int(pathLen) {
		pattern = decodeUTF16LE(data[32 : 32+pathLen])
		pattern = normalizeDirectoryPattern(pattern)
	}

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil || !handle.IsDir {
		h.sendIOCompletion(deviceID, completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletion(deviceID, completionID, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	if initialQuery != 0 {
		// Build entry list
		var entries []*VirtualFile

		if drive.Mode == DriveModeAgent {
			entries = h.listAgentDir(handle.AgentID, handle.Path, pattern)
		} else {
			entries = h.listLocalDir(handle, pattern)
		}

		if len(entries) == 0 {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_MORE_FILES, zeroLengthWithPaddingPayload())
			return
		}

		entryBuf := buildDirectoryEntry(entries[0], infoClass)
		h.mu.Lock()
		h.dirEnum[fileID] = &dirEnumState{entries: entries[1:], index: 0}
		h.mu.Unlock()

		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(entryBuf)))
		resp.Write(entryBuf)
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		h.mu.Lock()
		st := h.dirEnum[fileID]
		h.mu.Unlock()

		if st == nil || st.index >= len(st.entries) {
			h.sendIOCompletion(deviceID, completionID, STATUS_NO_MORE_FILES, zeroLengthWithPaddingPayload())
			return
		}

		entry := st.entries[st.index]
		h.mu.Lock()
		st.index++
		h.mu.Unlock()

		entryBuf := buildDirectoryEntry(entry, infoClass)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(entryBuf)))
		resp.Write(entryBuf)
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	}
}

func (h *RdpefsHandler) listAgentDir(agentID, dirPath, pattern string) []*VirtualFile {
	result := js.Global().Call("zephyrRdpFsList", agentID, dirPath)
	if result.IsNull() || result.IsUndefined() {
		return nil
	}

	now := time.Now()
	entries := make([]*VirtualFile, 0)
	entries = append(entries, &VirtualFile{Name: ".", IsDir: true, ModTime: now})
	entries = append(entries, &VirtualFile{Name: "..", IsDir: true, ModTime: now})

	length := result.Length()
	for i := 0; i < length; i++ {
		entry := result.Index(i)
		name := entry.Get("name").String()
		if pattern != "" && pattern != "*" && pattern != "*.*" && !matchPattern(pattern, name) {
			continue
		}
		mt := time.UnixMilli(int64(entry.Get("mtime").Float()))
		if mt.IsZero() {
			mt = now
		}
		f := &VirtualFile{
			Name:    name,
			IsDir:   entry.Get("isDir").Bool(),
			Size:    int64(entry.Get("size").Float()),
			ModTime: mt,
		}
		entries = append(entries, f)
	}
	return entries
}

func (h *RdpefsHandler) listLocalDir(handle *openHandle, pattern string) []*VirtualFile {
	dir := handle.LocalFile
	if dir == nil || !dir.IsDir {
		return nil
	}
	entries := make([]*VirtualFile, 0)
	entries = append(entries, &VirtualFile{Name: ".", IsDir: true, ModTime: dir.ModTime})
	entries = append(entries, &VirtualFile{Name: "..", IsDir: true, ModTime: dir.ModTime})
	for _, child := range dir.Children {
		if pattern == "" || pattern == "*" || pattern == "*.*" || matchPattern(pattern, child.Name) {
			entries = append(entries, child)
		}
	}
	return entries
}

// ─── IRP_MJ_QUERY_VOLUME ────────────────────────────────────────

func (h *RdpefsHandler) handleQueryVolume(deviceID, completionID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletion(deviceID, completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	drive := h.getDrive(deviceID)
	driveName := "WEBRDP"
	if drive != nil {
		driveName = drive.DriveName
	}

	switch infoClass {
	case 1: // FileFsVolumeInformation
		label := encodeUTF16LE(driveName)
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, int64(0))
		binary.Write(info, binary.LittleEndian, uint32(0x12345678))
		binary.Write(info, binary.LittleEndian, uint32(len(label)))
		binary.Write(info, binary.LittleEndian, uint8(0))
		info.Write(label)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 3: // FileFsSizeInformation
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, int64(1024*1024))
		binary.Write(info, binary.LittleEndian, int64(512*1024))
		binary.Write(info, binary.LittleEndian, uint32(1))
		binary.Write(info, binary.LittleEndian, uint32(4096))
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 4: // FileFsDeviceInformation
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, uint32(0x00000007))
		binary.Write(info, binary.LittleEndian, uint32(0x00000020))
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 5: // FileFsAttributeInformation
		fsName := encodeUTF16LE("FAT32")
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, uint32(0x00000003))
		binary.Write(info, binary.LittleEndian, uint32(255))
		binary.Write(info, binary.LittleEndian, uint32(len(fsName)))
		info.Write(fsName)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	default:
		h.sendIOCompletion(deviceID, completionID, STATUS_NOT_SUPPORTED, nil)
	}
}

// ─── IO Completion ───────────────────────────────────────────────

func zeroLengthPayload() []byte {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint32(0))
	return buf.Bytes()
}

func zeroLengthWithPaddingPayload() []byte {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint32(0))
	binary.Write(buf, binary.LittleEndian, uint8(0))
	return buf.Bytes()
}

func (h *RdpefsHandler) sendIOCompletion(deviceID, completionID, status uint32, payload []byte) {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICE_IOCOMPLETION))
	binary.Write(buf, binary.LittleEndian, deviceID)
	binary.Write(buf, binary.LittleEndian, completionID)
	binary.Write(buf, binary.LittleEndian, status)
	if payload != nil {
		buf.Write(payload)
	}
	h.send(buf.Bytes())
}

// ─── Agent RPC calls (synchronous JS interop) ───────────────────

func (h *RdpefsHandler) callAgentStat(agentID, path string) *js.Value {
	result := js.Global().Call("zephyrRdpFsStat", agentID, path)
	if result.IsNull() || result.IsUndefined() {
		return nil
	}
	return &result
}

// Wrapper to avoid returning pointer to interface
func (h *RdpefsHandler) callAgentStatChecked(agentID, path string) *js.Value {
	return h.callAgentStat(agentID, path)
}

func (h *RdpefsHandler) callAgentOpen(agentID, path, mode string) string {
	result := js.Global().Call("zephyrRdpFsOpen", agentID, path, mode)
	if result.IsNull() || result.IsUndefined() {
		return ""
	}
	return result.String()
}

func (h *RdpefsHandler) callAgentRead(agentID, handle string, offset uint64, length uint32) []byte {
	result := js.Global().Call("zephyrRdpFsRead", agentID, handle, int(offset), int(length))
	if result.IsNull() || result.IsUndefined() {
		return nil
	}
	buf := make([]byte, result.Length())
	js.CopyBytesToGo(buf, result)
	return buf
}

func (h *RdpefsHandler) callAgentWrite(agentID, handle string, offset uint64, data []byte) int {
	jsArr := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(jsArr, data)
	result := js.Global().Call("zephyrRdpFsWrite", agentID, handle, int(offset), jsArr)
	if result.IsNull() || result.IsUndefined() {
		return 0
	}
	return result.Int()
}

func (h *RdpefsHandler) callAgentClose(agentID, handle string) {
	js.Global().Call("zephyrRdpFsClose", agentID, handle)
}

func (h *RdpefsHandler) callAgentMkdir(agentID, path string) bool {
	result := js.Global().Call("zephyrRdpFsMkdir", agentID, path)
	return !result.IsNull() && !result.IsUndefined() && result.Bool()
}

func (h *RdpefsHandler) callAgentDelete(agentID, path string) bool {
	result := js.Global().Call("zephyrRdpFsDelete", agentID, path)
	return !result.IsNull() && !result.IsUndefined() && result.Bool()
}

func (h *RdpefsHandler) callAgentRename(agentID, oldPath, newPath string) bool {
	result := js.Global().Call("zephyrRdpFsRename", agentID, oldPath, newPath)
	return !result.IsNull() && !result.IsUndefined() && result.Bool()
}

func (h *RdpefsHandler) callAgentTruncate(agentID, path string, size uint64) bool {
	result := js.Global().Call("zephyrRdpFsTruncate", agentID, path, int(size))
	return !result.IsNull() && !result.IsUndefined()
}

// ─── Local mode helpers ──────────────────────────────────────────

func (h *RdpefsHandler) resolveLocalPath(path string) *VirtualFile {
	if path == "" || path == "/" || path == "." {
		return h.localRoot
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	current := h.localRoot
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			continue
		}
		child, ok := current.Children[strings.ToLower(part)]
		if !ok {
			return nil
		}
		current = child
	}
	return current
}

func (h *RdpefsHandler) refreshLocalFileList() {
	result := js.Global().Call("rdpStorageGetFiles")
	if result.IsNull() || result.IsUndefined() {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.localRoot.Children = make(map[string]*VirtualFile)
	length := result.Length()
	for i := 0; i < length; i++ {
		entry := result.Index(i)
		name := entry.Get("name").String()
		size := int64(entry.Get("size").Int())
		isDir := entry.Get("isDir").Bool()
		f := &VirtualFile{
			Name:    name,
			IsDir:   isDir,
			Size:    size,
			ModTime: time.Now(),
		}
		if isDir {
			f.Children = make(map[string]*VirtualFile)
		}
		h.localRoot.Children[strings.ToLower(name)] = f
	}
	slog.Debug("rdpefs: refreshed local file list", "count", length)
}

func (h *RdpefsHandler) loadLocalFileData(f *VirtualFile) {
	result := js.Global().Call("rdpStorageReadFile", f.Name)
	if result.IsNull() || result.IsUndefined() {
		f.Data = []byte{}
		return
	}
	buf := make([]byte, result.Length())
	js.CopyBytesToGo(buf, result)
	f.Data = buf
	f.Size = int64(len(buf))
}

// ─── File info builders (shared between modes) ──────────────────

func buildBasicInfo(isDir bool, mtime time.Time) []byte {
	buf := &bytes.Buffer{}
	ft := windowsFileTime(mtime)
	binary.Write(buf, binary.LittleEndian, ft) // CreationTime
	binary.Write(buf, binary.LittleEndian, ft) // LastAccessTime
	binary.Write(buf, binary.LittleEndian, ft) // LastWriteTime
	binary.Write(buf, binary.LittleEndian, ft) // ChangeTime
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if isDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	binary.Write(buf, binary.LittleEndian, attrs)
	return buf.Bytes()
}

func buildStandardInfo(isDir bool, size int64) []byte {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, size) // AllocationSize
	binary.Write(buf, binary.LittleEndian, size) // EndOfFile
	binary.Write(buf, binary.LittleEndian, uint32(1))
	deletePending := uint8(0)
	directory := uint8(0)
	if isDir {
		directory = 1
	}
	binary.Write(buf, binary.LittleEndian, deletePending)
	binary.Write(buf, binary.LittleEndian, directory)
	return buf.Bytes()
}

func buildAttributeTagInfo(isDir bool) []byte {
	buf := &bytes.Buffer{}
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if isDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	binary.Write(buf, binary.LittleEndian, attrs)
	binary.Write(buf, binary.LittleEndian, uint32(0))
	return buf.Bytes()
}

func buildDirectoryEntry(f *VirtualFile, infoClass uint32) []byte {
	name := encodeUTF16LENoNull(f.Name)
	buf := &bytes.Buffer{}
	ft := windowsFileTime(f.ModTime)
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if f.IsDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	size := f.Size

	switch infoClass {
	case FileNamesInformation:
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		buf.Write(name)

	case FileDirectoryInformation:
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, size) // EndOfFile
		binary.Write(buf, binary.LittleEndian, size) // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		buf.Write(name)

	case FileFullDirectoryInformation:
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, size) // EndOfFile
		binary.Write(buf, binary.LittleEndian, size) // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		binary.Write(buf, binary.LittleEndian, uint32(0)) // EaSize
		buf.Write(name)

	default: // FileBothDirectoryInformation
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, ft)
		binary.Write(buf, binary.LittleEndian, size) // EndOfFile
		binary.Write(buf, binary.LittleEndian, size) // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint8(0))
		buf.Write(make([]byte, 24))
		buf.Write(name)
	}
	return buf.Bytes()
}

// ─── Utility ─────────────────────────────────────────────────────

func encodeUTF16LE(s string) []byte {
	runes := utf16.Encode([]rune(s + "\x00"))
	buf := make([]byte, len(runes)*2)
	for i, r := range runes {
		buf[i*2] = byte(r)
		buf[i*2+1] = byte(r >> 8)
	}
	return buf
}

func encodeUTF16LENoNull(s string) []byte {
	runes := utf16.Encode([]rune(s))
	buf := make([]byte, len(runes)*2)
	for i, r := range runes {
		buf[i*2] = byte(r)
		buf[i*2+1] = byte(r >> 8)
	}
	return buf
}

func decodeUTF16LE(b []byte) string {
	if len(b) < 2 {
		return ""
	}
	u16 := make([]uint16, len(b)/2)
	for i := range u16 {
		u16[i] = uint16(b[i*2]) | uint16(b[i*2+1])<<8
	}
	return string(utf16.Decode(u16))
}

func windowsFileTime(t time.Time) int64 {
	const epoch = 116444736000000000
	if t.IsZero() {
		return epoch
	}
	return t.UnixNano()/100 + epoch
}

func normalizeDirectoryPattern(pattern string) string {
	pattern = strings.TrimRight(pattern, "\x00")
	pattern = strings.ReplaceAll(pattern, "\\", "/")
	pattern = strings.TrimPrefix(pattern, "/")
	if idx := strings.LastIndex(pattern, "/"); idx >= 0 {
		pattern = pattern[idx+1:]
	}
	return pattern
}

func matchPattern(pattern, name string) bool {
	if pattern == "*" || pattern == "*.*" {
		return true
	}
	pattern = strings.ToLower(pattern)
	name = strings.ToLower(name)
	return strings.Contains(name, strings.TrimLeft(strings.TrimRight(pattern, "*"), "*"))
}
