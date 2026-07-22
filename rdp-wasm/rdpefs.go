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
	"encoding/json"
	"fmt"
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
	FileInternalInformation      = 6
	FileEaInformation            = 7
	FileAccessInformation        = 8
	FileNameInformation          = 9
	FilePositionInformation      = 14
	FileModeInformation          = 16
	FileAlignmentInformation     = 17
	FileAllInformation           = 18
	FileStreamInformation        = 22
	FileNetworkOpenInformation   = 34
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

// Access masks used to decide whether an existing agent file should be opened
// with a writable remote handle.  On read-only Agent shares we still allow
// opening existing files/directories even if Windows asks for a broad access
// mask; actual write/set/delete IRPs are rejected later.  This avoids common
// apps failing with ACCESS_DENIED during harmless open probes.
const (
	FILE_WRITE_DATA       = 0x00000002
	FILE_APPEND_DATA      = 0x00000004
	FILE_WRITE_EA         = 0x00000010
	FILE_WRITE_ATTRIBUTES = 0x00000100
	DELETE_ACCESS         = 0x00010000
	GENERIC_ALL_ACCESS    = 0x10000000
	GENERIC_WRITE_ACCESS  = 0x40000000
)

// Information response values
const (
	FILE_SUPERSEDED  = 0x00000000
	FILE_OPENED      = 0x00000001
	FILE_CREATED     = 0x00000002
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

const (
	// 256 KiB matches the Android MethodChannel/Binder soft cap that Agents
	// advertise as maxChunkSize. Desktop Agents still accept it; larger
	// chunks used to make Android large-file copies fail mid-transfer.
	agentReadAheadChunkBytes = 256 * 1024
	agentReadAheadParallel   = 4
	agentReadAheadWindow     = agentReadAheadChunkBytes * agentReadAheadParallel
	agentReadAheadMaxBytes   = 16 * 1024 * 1024
)

type agentReadCache struct {
	mu       sync.Mutex
	start    uint64
	data     []byte
	loading  bool
	loadFrom uint64
	ready    chan struct{}
}

// openHandle tracks an open file/directory for IRP processing
type openHandle struct {
	DriveDeviceID uint32
	AgentID       string
	Path          string
	IsDir         bool
	RemoteHandle  string // handle ID from agent (for agent mode reads)
	ReadCache     *agentReadCache
	Volatile      bool   // in-memory placeholder for Office temp/lock files on read-only Agent shares
	VolatileData  []byte // data written to the volatile placeholder during this RDP session
	// For local mode compatibility
	LocalFile *VirtualFile
}

type dirEnumState struct {
	entries []*VirtualFile
	index   int
}

// RdpefsHandler implements plugin.ChannelTransport for the rdpdr SVC
type RdpefsHandler struct {
	mu       sync.Mutex
	sendMu   sync.Mutex
	sender   func(string, []byte) (int, error)
	enabled  bool
	transfer fileTransfer

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
		h.sendMu.Lock()
		defer h.sendMu.Unlock()
		fn("rdpdr", data)
	}
}

func (h *RdpefsHandler) SetFileTransfer(transfer fileTransfer) {
	h.mu.Lock()
	h.transfer = transfer
	h.mu.Unlock()
}

func (h *RdpefsHandler) Close() {
	h.mu.Lock()
	transfer := h.transfer
	h.transfer = nil
	h.mu.Unlock()
	if transfer != nil {
		transfer.Close()
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

	// Compatibility note:
	// The previous two attempts changed the capability response to a stricter
	// FreeRDP-like shape (Version=02 and/or Drive capset). On the user's target
	// server that prevented USER_LOGGEDON/device announce entirely, so the drive
	// disappeared from Explorer.  The original bytes below are known-good for
	// the device-announcement path in this project.  Keep them stable; fix copy
	// failures in the later IRP handlers (QUERY_VOLUME/read/write payloads), not
	// in the negotiated capability bytes.
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_CLIENT_CAPABILITY))
	binary.Write(buf, binary.LittleEndian, uint16(1))
	binary.Write(buf, binary.LittleEndian, uint16(0))

	// General capability set — preserved from the last version where drives
	// appeared in Windows Explorer.
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
	payload := append([]byte(nil), data[20:]...)

	switch majorFunction {
	case IRP_MJ_CREATE:
		h.handleCreate(deviceID, completionID, payload)
	case IRP_MJ_CLOSE:
		h.handleClose(deviceID, completionID, fileID)
	case IRP_MJ_READ:
		go h.handleRead(deviceID, completionID, fileID, payload)
	case IRP_MJ_WRITE:
		go h.handleWrite(deviceID, completionID, fileID, payload)
	case IRP_MJ_QUERY_INFORMATION:
		go h.handleQueryInformation(deviceID, completionID, fileID, payload)
	case IRP_MJ_SET_INFORMATION:
		go h.handleSetInformation(deviceID, completionID, fileID, payload)
	case IRP_MJ_DIRECTORY_CONTROL:
		go h.handleDirectoryControl(deviceID, completionID, fileID, minorFunction, payload)
	case IRP_MJ_QUERY_VOLUME:
		h.handleQueryVolume(deviceID, completionID, payload)
	case IRP_MJ_CLEANUP:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CLEANUP, STATUS_SUCCESS, nil)
	case IRP_MJ_FLUSH_BUFFERS:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_FLUSH_BUFFERS, STATUS_SUCCESS, nil)
	case IRP_MJ_SHUTDOWN:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SHUTDOWN, STATUS_SUCCESS, nil)
	case IRP_MJ_SET_VOLUME:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_VOLUME, STATUS_NOT_SUPPORTED, nil)
	case IRP_MJ_QUERY_SECURITY, IRP_MJ_SET_SECURITY:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_SECURITY, STATUS_NOT_SUPPORTED, nil)
	case IRP_MJ_LOCK_CONTROL:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_LOCK_CONTROL, STATUS_SUCCESS, nil)
	case IRP_MJ_DEVICE_CONTROL:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DEVICE_CONTROL, STATUS_SUCCESS, nil)
	default:
		slog.Debug("rdpefs: unsupported IRP", "major", majorFunction, "minor", minorFunction)
		h.sendIOCompletionMajor(deviceID, completionID, majorFunction, STATUS_NOT_SUPPORTED, nil)
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_INVALID_PARAMETER, nil)
		return
	}
	desiredAccess := binary.LittleEndian.Uint32(data[0:4])
	createDisposition := binary.LittleEndian.Uint32(data[20:24])
	createOptions := binary.LittleEndian.Uint32(data[24:28])
	pathLen := binary.LittleEndian.Uint32(data[28:32])
	pathBytes := data[32:]
	if uint32(len(pathBytes)) < pathLen {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_INVALID_PARAMETER, nil)
		return
	}
	rdpPath := decodeUTF16LE(pathBytes[:pathLen])
	rdpPath = strings.TrimRight(rdpPath, "\x00")
	rdpPath = strings.ReplaceAll(rdpPath, "\\", "/")
	rdpPath = strings.TrimPrefix(rdpPath, "/")

	slog.Debug("rdpefs: CREATE", "device", deviceID, "path", rdpPath, "disp", createDisposition, "opts", createOptions)

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		go h.handleCreateAgent(drive, completionID, rdpPath, desiredAccess, createDisposition, createOptions)
	} else {
		h.handleCreateLocal(deviceID, completionID, rdpPath, desiredAccess, createDisposition, createOptions)
	}
}

func (h *RdpefsHandler) handleCreateAgent(drive *DriveState, completionID uint32, path string, desiredAccess, createDisposition, createOptions uint32) {
	deviceID := drive.DeviceID
	agentID := drive.AgentID
	readOnly := drive.ReadOnly

	// Query existence BEFORE applying read-only write rules.  Many Windows
	// apps open existing files/directories with FILE_OPEN_IF or a broad access
	// mask even when they only intend to read.  Treating FILE_OPEN_IF as a
	// write/create unconditionally causes ACCESS_DENIED on read-only Agent
	// shares when users simply double-click files.
	statResult := h.callAgentStat(agentID, path)
	exists := statResult != nil

	if !exists {
		if !createDispositionCanCreateMissing(createDisposition) {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_NO_SUCH_FILE, nil)
			return
		}
		if readOnly {
			if createOptions&FILE_DIRECTORY_FILE == 0 && isOfficeVolatilePath(path) {
				h.openVolatileAgentHandle(deviceID, completionID, agentID, path, FILE_CREATED)
				return
			}
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_ACCESS_DENIED, nil)
			return
		}

		// Create file/dir via agent for create-capable dispositions.
		if createOptions&FILE_DIRECTORY_FILE != 0 {
			mkdirResult := h.callAgentMkdir(agentID, path)
			if !mkdirResult {
				h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_UNSUCCESSFUL, nil)
				return
			}
			statResult = h.callAgentStat(agentID, path)
			if statResult == nil {
				h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_UNSUCCESSFUL, nil)
				return
			}
			exists = true
		} else {
			mode := "write"
			if createDispositionTruncatesExisting(createDisposition) {
				mode = "writeTruncate"
			}
			handle := h.callAgentOpen(agentID, path, mode)
			if handle == "" {
				h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_UNSUCCESSFUL, nil)
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
			binary.Write(resp, binary.LittleEndian, createResponseInformation(createDisposition, false))
			h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
			return
		}
	}

	if !exists || statResult == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_NO_SUCH_FILE, nil)
		return
	}

	// Existing path. FILE_CREATE means "create new" and should fail on
	// existing objects instead of opening them.
	if createDisposition == FILE_CREATE {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_OBJECT_NAME_COLLISION, nil)
		return
	}

	isDir := statResult.IsDir
	if createOptions&FILE_DIRECTORY_FILE != 0 && !isDir {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_NO_SUCH_FILE, nil)
		return
	}
	if createOptions&FILE_NON_DIRECTORY_FILE != 0 && isDir {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_ACCESS_DENIED, nil)
		return
	}

	// Destructive dispositions on an existing object are not allowed on a
	// read-only Agent share.  Non-destructive opens (FILE_OPEN/FILE_OPEN_IF),
	// even with broad desiredAccess, are allowed and mapped to a read handle.
	if readOnly && createDispositionTruncatesExisting(createDisposition) {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_ACCESS_DENIED, nil)
		return
	}

	mode := "read"
	if !readOnly && !isDir && (createDispositionTruncatesExisting(createDisposition) || desiredAccessWantsWrite(desiredAccess)) {
		mode = "write"
		if createDispositionTruncatesExisting(createDisposition) {
			mode = "writeTruncate"
		}
	}

	remoteHandle := ""
	if !isDir {
		remoteHandle = h.callAgentOpen(agentID, path, mode)
		if remoteHandle == "" && mode != "read" {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_UNSUCCESSFUL, nil)
			return
		}
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
	binary.Write(resp, binary.LittleEndian, createResponseInformation(createDisposition, true))
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

func createDispositionCanCreateMissing(createDisposition uint32) bool {
	switch createDisposition {
	case FILE_SUPERSEDE, FILE_CREATE, FILE_OPEN_IF, FILE_OVERWRITE_IF:
		return true
	default:
		return false
	}
}

func createDispositionTruncatesExisting(createDisposition uint32) bool {
	switch createDisposition {
	case FILE_SUPERSEDE, FILE_OVERWRITE, FILE_OVERWRITE_IF:
		return true
	default:
		return false
	}
}

func desiredAccessWantsWrite(desiredAccess uint32) bool {
	const writeMask = FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES |
		DELETE_ACCESS | GENERIC_WRITE_ACCESS | GENERIC_ALL_ACCESS
	return desiredAccess&writeMask != 0
}

func createResponseInformation(createDisposition uint32, existed bool) uint8 {
	if existed {
		switch createDisposition {
		case FILE_SUPERSEDE:
			return FILE_SUPERSEDED
		case FILE_OVERWRITE, FILE_OVERWRITE_IF:
			return FILE_OVERWRITTEN
		default:
			return FILE_OPENED
		}
	}
	return FILE_CREATED
}

func isOfficeVolatilePath(path string) bool {
	base := path
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	base = strings.ToLower(base)
	// Applications opening files directly from a read-only redirected drive often
	// create sidecar lock/temp files next to the real file.  Examples:
	//   Microsoft Office: ~$document.xlsx, ~WRLxxxx.tmp
	//   LibreOffice: .~lock.document.xlsx#
	//   archive/viewer/indexers: *.tmp, *.lock, *.lck, Thumbs.db, desktop.ini
	// If these creates fail, apps frequently report the *real* file or parent
	// directory as moved/deleted.  We satisfy only these volatile sidecars with
	// in-memory handles; real document/media/archive writes are still rejected.
	if strings.HasPrefix(base, "~$") || strings.HasPrefix(base, ".~lock.") {
		return true
	}
	if strings.HasSuffix(base, ".tmp") || strings.HasSuffix(base, ".temp") ||
		strings.HasSuffix(base, ".lock") || strings.HasSuffix(base, ".lck") {
		return true
	}
	if base == "thumbs.db" || base == "desktop.ini" {
		return true
	}
	return false
}

func (h *RdpefsHandler) openVolatileAgentHandle(deviceID, completionID uint32, agentID, path string, information uint8) {
	h.mu.Lock()
	fid := h.nextFileID
	h.nextFileID++
	h.handles[fid] = &openHandle{
		DriveDeviceID: deviceID,
		AgentID:       agentID,
		Path:          path,
		IsDir:         false,
		Volatile:      true,
		VolatileData:  []byte{},
	}
	h.mu.Unlock()

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, fid)
	binary.Write(resp, binary.LittleEndian, information)
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

func (h *RdpefsHandler) handleCreateLocal(deviceID, completionID uint32, path string, desiredAccess, createDisposition, createOptions uint32) {
	h.mu.Lock()
	file := h.resolveLocalPath(path)
	if file == nil {
		h.mu.Unlock()
		isWriteDisp := createDisposition == FILE_CREATE || createDisposition == FILE_OPEN_IF ||
			createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE
		if isWriteDisp {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_ACCESS_DENIED, nil)
			return
		}
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_NO_SUCH_FILE, nil)
		return
	}

	if createOptions&FILE_DIRECTORY_FILE != 0 && !file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_NO_SUCH_FILE, nil)
		return
	}
	if createOptions&FILE_NON_DIRECTORY_FILE != 0 && file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CREATE, STATUS_ACCESS_DENIED, nil)
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
	binary.Write(resp, binary.LittleEndian, createResponseInformation(createDisposition, true))
	h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
}

// ─── IRP_MJ_CLOSE ───────────────────────────────────────────────

func (h *RdpefsHandler) handleClose(deviceID, completionID, fileID uint32) {
	h.mu.Lock()
	handle := h.handles[fileID]
	delete(h.handles, fileID)
	delete(h.dirEnum, fileID)
	h.mu.Unlock()

	if handle != nil && handle.RemoteHandle != "" {
		go h.callAgentClose(handle.AgentID, handle.RemoteHandle)
	}

	h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_CLOSE, STATUS_SUCCESS, nil)
}

// ─── IRP_MJ_READ ────────────────────────────────────────────────

func (h *RdpefsHandler) handleRead(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 12 {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_INVALID_PARAMETER, nil)
		return
	}
	length := binary.LittleEndian.Uint32(data[0:4])
	offset := binary.LittleEndian.Uint64(data[4:12])

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil || handle.IsDir {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_INVALID_DEVICE_REQUEST, nil)
		return
	}

	if handle.Volatile {
		start := int(offset)
		data := handle.VolatileData
		if start >= len(data) {
			resp := &bytes.Buffer{}
			binary.Write(resp, binary.LittleEndian, uint32(0))
			h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
			return
		}
		end := start + int(length)
		if end > len(data) {
			end = len(data)
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(end-start))
		resp.Write(data[start:end])
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		// Read from remote agent
		readHandle := handle.RemoteHandle
		if readHandle == "" {
			// Try to open for read
			readHandle = h.callAgentOpen(handle.AgentID, handle.Path, "read")
			if readHandle == "" {
				h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_UNSUCCESSFUL, nil)
				return
			}
			h.mu.Lock()
			handle.RemoteHandle = readHandle
			h.mu.Unlock()
		}

		chunk := h.readAgentCached(handle, offset, length)
		resp := &bytes.Buffer{}
		if chunk == nil {
			// Agent RPC failed — must NOT pretend success with Length=0,
			// or Windows treats it as "device disconnected" (0x8007048F).
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_UNSUCCESSFUL, nil)
			return
		}
		binary.Write(resp, binary.LittleEndian, uint32(len(chunk)))
		if len(chunk) > 0 {
			resp.Write(chunk)
		}
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		// Local mode read
		file := handle.LocalFile
		if file == nil {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_READ, STATUS_NO_SUCH_FILE, nil)
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

func (h *RdpefsHandler) readAgentCached(handle *openHandle, offset uint64, length uint32) []byte {
	if length == 0 {
		return []byte{}
	}
	cache := handle.ReadCache
	if cache == nil {
		h.mu.Lock()
		if handle.ReadCache == nil {
			handle.ReadCache = &agentReadCache{}
		}
		cache = handle.ReadCache
		h.mu.Unlock()
	}
	for {
		cache.mu.Lock()
		if offset >= cache.start && offset+uint64(length) <= cache.start+uint64(len(cache.data)) {
			start := int(offset - cache.start)
			chunk := append([]byte(nil), cache.data[start:start+int(length)]...)
			cache.mu.Unlock()
			addProtocolCounter("file.cache.hit", 1)
			addProtocolCounter("file.bytes.cache", uint64(len(chunk)))
			return chunk
		}
		if cache.loading && offset >= cache.loadFrom && offset < cache.loadFrom+agentReadAheadWindow {
			ready := cache.ready
			cache.mu.Unlock()
			<-ready
			continue
		}
		cache.loading = true
		cache.loadFrom = offset
		cache.ready = make(chan struct{})
		ready := cache.ready
		cache.mu.Unlock()

		fetchLength := uint32(agentReadAheadWindow)
		if length > fetchLength {
			fetchLength = length
		}
		if fetchLength > agentReadAheadMaxBytes {
			fetchLength = agentReadAheadMaxBytes
		}
		started := time.Now()
		data := h.callAgentReadWindow(handle.AgentID, handle.RemoteHandle, offset, fetchLength)
		elapsed := time.Since(started)

		cache.mu.Lock()
		if data != nil {
			cache.start = offset
			cache.data = data
			if len(cache.data) > agentReadAheadMaxBytes {
				cache.data = cache.data[:agentReadAheadMaxBytes]
			}
		} else {
			cache.data = nil
		}
		cache.loading = false
		close(ready)
		cache.mu.Unlock()
		addProtocolCounter("file.cache.miss", 1)
		addProtocolCounter("file.bytes.network", uint64(len(data)))
		addProtocolCounter("file.read.latency_ms", uint64(elapsed.Milliseconds()))
		if data == nil {
			return nil
		}
		if uint32(len(data)) < length {
			return append([]byte(nil), data...)
		}
		return append([]byte(nil), data[:length]...)
	}
}

func invalidateAgentReadCache(handle *openHandle) {
	if handle == nil || handle.ReadCache == nil {
		return
	}
	cache := handle.ReadCache
	cache.mu.Lock()
	cache.data = nil
	cache.start = 0
	cache.mu.Unlock()
}

// ─── IRP_MJ_WRITE ───────────────────────────────────────────────

func (h *RdpefsHandler) handleWrite(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 32 {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_INVALID_PARAMETER, nil)
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_INVALID_DEVICE_REQUEST, nil)
		return
	}

	if handle.Volatile {
		h.mu.Lock()
		need := int(offset) + len(writeData)
		if need > len(handle.VolatileData) {
			grown := make([]byte, need)
			copy(grown, handle.VolatileData)
			handle.VolatileData = grown
		}
		copy(handle.VolatileData[int(offset):], writeData)
		h.mu.Unlock()
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(writeData)))
		binary.Write(resp, binary.LittleEndian, uint8(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil || drive.ReadOnly {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_ACCESS_DENIED, nil)
		return
	}

	if drive.Mode == DriveModeAgent {
		writeHandle := handle.RemoteHandle
		if writeHandle == "" {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_UNSUCCESSFUL, nil)
			return
		}
		written := h.callAgentWrite(handle.AgentID, writeHandle, offset, writeData)
		invalidateAgentReadCache(handle)
		if written == 0 && len(writeData) > 0 {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_UNSUCCESSFUL, nil)
			return
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(written))
		binary.Write(resp, binary.LittleEndian, uint8(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		// Local mode: read-only
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_WRITE, STATUS_ACCESS_DENIED, nil)
	}
}

// ─── IRP_MJ_SET_INFORMATION ─────────────────────────────────────

func (h *RdpefsHandler) handleSetInformation(deviceID, completionID, fileID uint32, data []byte) {
	// DR_SET_INFORMATION_REQ layout:
	//   FsInformationClass (4)
	//   Length (4)
	//   Padding (24)
	//   <Length bytes of information data>
	if len(data) < 32 {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])
	infoLen := binary.LittleEndian.Uint32(data[4:8])
	infoData := data[32:]
	if uint32(len(infoData)) < infoLen {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoData = infoData[:infoLen]

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_NO_SUCH_FILE, nil)
		return
	}

	if handle.Volatile {
		if infoClass == FileEndOfFileInformation && len(infoData) >= 8 {
			newSize := int(binary.LittleEndian.Uint64(infoData[0:8]))
			h.mu.Lock()
			if newSize < len(handle.VolatileData) {
				handle.VolatileData = handle.VolatileData[:newSize]
			} else if newSize > len(handle.VolatileData) {
				grown := make([]byte, newSize)
				copy(grown, handle.VolatileData)
				handle.VolatileData = grown
			}
			h.mu.Unlock()
		}
		// Office may set timestamps/delete-pending/EOF on its volatile lock file.
		// Acknowledge these in memory and do not touch the Agent share.
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_DEVICE_OFF_LINE, nil)
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
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent && len(infoData) >= 8 {
			newSize := binary.LittleEndian.Uint64(infoData[0:8])
			ok := h.callAgentTruncate(handle.AgentID, handle.Path, newSize)
			invalidateAgentReadCache(handle)
			if !ok {
				h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_UNSUCCESSFUL, nil)
				return
			}
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileDispositionInformation:
		if drive.ReadOnly {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent {
			deletePending := true
			if len(infoData) >= 1 {
				deletePending = infoData[0] != 0
			}
			if deletePending {
				ok := h.callAgentDelete(handle.AgentID, handle.Path)
				if !ok {
					h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_UNSUCCESSFUL, nil)
					return
				}
			}
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case FileRenameInformation:
		if drive.ReadOnly {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_ACCESS_DENIED, nil)
			return
		}
		if drive.Mode == DriveModeAgent && len(infoData) >= 6 {
			// FileRenameInformation: ReplaceIfExists(1) + RootDirectory(1) + FileNameLength(4) + FileName(UTF-16LE)
			fnLen := binary.LittleEndian.Uint32(infoData[2:6])
			if uint32(len(infoData)) >= 6+fnLen {
				newPath := decodeUTF16LE(infoData[6 : 6+fnLen])
				newPath = strings.TrimRight(newPath, "\x00")
				newPath = strings.ReplaceAll(newPath, "\\", "/")
				newPath = strings.TrimPrefix(newPath, "/")
				ok := h.callAgentRename(handle.AgentID, handle.Path, newPath)
				if !ok {
					h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_UNSUCCESSFUL, nil)
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_SET_INFORMATION, STATUS_NOT_SUPPORTED, nil)
	}
}

// ─── IRP_MJ_QUERY_INFORMATION ───────────────────────────────────

func (h *RdpefsHandler) handleQueryInformation(deviceID, completionID, fileID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	h.mu.Lock()
	handle := h.handles[fileID]
	h.mu.Unlock()

	if handle == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_NO_SUCH_FILE, nil)
		return
	}

	if handle.Volatile {
		var info []byte
		mtime := time.Now()
		size := int64(len(handle.VolatileData))
		switch infoClass {
		case FileBasicInformation:
			info = buildBasicInfo(false, mtime)
		case FileStandardInformation:
			info = buildStandardInfo(false, size)
		case FileAttributeTagInformation:
			info = buildAttributeTagInfo(false)
		case FileNetworkOpenInformation:
			info = buildNetworkOpenInfo(false, size, mtime)
		case FileInternalInformation:
			info = make([]byte, 8)
		case FileEaInformation, FileAccessInformation, FileModeInformation, FileAlignmentInformation:
			info = make([]byte, 4)
		case FilePositionInformation:
			info = make([]byte, 8)
		case FileNameInformation:
			info = buildNameInfo(handle.Path)
		case FileStreamInformation:
			info = []byte{}
		case FileAllInformation:
			info = buildAllInfo(false, size, mtime, handle.Path)
		default:
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_NOT_SUPPORTED, nil)
			return
		}
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(info)))
		resp.Write(info)
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_DEVICE_OFF_LINE, nil)
		return
	}

	// Get file metadata
	var isDir bool
	var size int64
	var mtime time.Time

	if drive.Mode == DriveModeAgent {
		stat := h.callAgentStat(handle.AgentID, handle.Path)
		if stat == nil {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_UNSUCCESSFUL, nil)
			return
		}
		isDir = stat.IsDir
		size = stat.Size
		mtime = time.UnixMilli(stat.Mtime)
	} else {
		file := handle.LocalFile
		if file == nil {
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_NO_SUCH_FILE, nil)
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
	case FileNetworkOpenInformation:
		info = buildNetworkOpenInfo(isDir, size, mtime)
	case FileInternalInformation:
		info = make([]byte, 8)
	case FileEaInformation:
		info = make([]byte, 4)
	case FileAccessInformation:
		info = make([]byte, 4)
	case FilePositionInformation:
		info = make([]byte, 8)
	case FileModeInformation:
		info = make([]byte, 4)
	case FileAlignmentInformation:
		info = make([]byte, 4)
	case FileNameInformation:
		info = buildNameInfo(handle.Path)
	case FileStreamInformation:
		info = []byte{}
	case FileAllInformation:
		info = buildAllInfo(isDir, size, mtime, handle.Path)
	default:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_INFORMATION, STATUS_NOT_SUPPORTED, nil)
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_NOT_SUPPORTED, nil)
		return
	}
	if minorFunction != IRP_MN_QUERY_DIRECTORY {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_NOT_SUPPORTED, nil)
		return
	}
	if len(data) < 32 {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_INVALID_PARAMETER, nil)
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_NO_SUCH_FILE, nil)
		return
	}

	drive := h.getDrive(deviceID)
	if drive == nil {
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_DEVICE_OFF_LINE, nil)
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
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_NO_MORE_FILES, nil)
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
			h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_DIRECTORY_CONTROL, STATUS_NO_MORE_FILES, nil)
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
	response, err := h.requestAgent(agentID, zft2List, map[string]any{"path": dirPath}, nil)
	if err != nil {
		return nil
	}
	entriesJSON, err := json.Marshal(response.Meta["entries"])
	if err != nil {
		return nil
	}
	var entriesRaw []struct {
		Name  string `json:"name"`
		IsDir bool   `json:"isDir"`
		Size  int64  `json:"size"`
		Mtime int64  `json:"mtime"`
	}
	if err := json.Unmarshal(entriesJSON, &entriesRaw); err != nil {
		return nil
	}

	now := time.Now()
	entries := make([]*VirtualFile, 0, len(entriesRaw)+2)
	entries = append(entries, &VirtualFile{Name: ".", IsDir: true, ModTime: now})
	entries = append(entries, &VirtualFile{Name: "..", IsDir: true, ModTime: now})
	for _, entry := range entriesRaw {
		if pattern != "" && pattern != "*" && pattern != "*.*" && !matchPattern(pattern, entry.Name) {
			continue
		}
		mt := time.UnixMilli(entry.Mtime)
		if mt.IsZero() {
			mt = now
		}
		entries = append(entries, &VirtualFile{Name: entry.Name, IsDir: entry.IsDir, Size: entry.Size, ModTime: mt})
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
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_VOLUME, STATUS_INVALID_PARAMETER, nil)
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

	case 7: // FileFsFullSizeInformation
		// http://msdn.microsoft.com/en-us/library/cc232104.aspx
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, int64(1024*1024)) // TotalAllocationUnits
		binary.Write(info, binary.LittleEndian, int64(512*1024))  // CallerAvailableAllocationUnits
		binary.Write(info, binary.LittleEndian, int64(512*1024))  // AvailableAllocationUnits
		binary.Write(info, binary.LittleEndian, uint32(1))        // SectorsPerAllocationUnit
		binary.Write(info, binary.LittleEndian, uint32(4096))     // BytesPerSector
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 2: // FileFsLabelInformation
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 6: // FileFsObjectIdInformation
		info := &bytes.Buffer{}
		info.Write(make([]byte, 48))
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	case 8: // FileFsDriverPathInformation
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0))
		h.sendIOCompletion(deviceID, completionID, STATUS_SUCCESS, resp.Bytes())

	default:
		h.sendIOCompletionMajor(deviceID, completionID, IRP_MJ_QUERY_VOLUME, STATUS_NOT_SUPPORTED, nil)
	}
}

// ─── IO Completion ───────────────────────────────────────────────

// sendIOCompletionMajor sends an IO completion with the correct minimum
// payload shape for the given IRP major function, even on failure.  MS-RDPEFS
// requires every DR_DEVICE_IOCOMPLETION to carry the response body expected by
// that IRP type; omitting it desyncs the server's RDPDR stream parser, which
// then misreads subsequent IRP responses as the missing payload and surfaces
// errors like "\\tsclient\TEST 试图访问无效的地址".
func (h *RdpefsHandler) sendIOCompletionMajor(deviceID, completionID, majorFunction, status uint32, payload []byte) {
	if payload == nil {
		payload = defaultPayloadFor(majorFunction)
	}
	h.sendIOCompletion(deviceID, completionID, status, payload)
}

// defaultPayloadFor returns the minimum mandatory body for a failed IRP of the
// given major function.  FreeRDP's drive_main.c writes these exact bytes on the
// failure path; the Windows RDPDR server parser expects exactly this much body
// per IRP type.  Any mismatch (too many or too few bytes) desyncs the stream.
func defaultPayloadFor(majorFunction uint32) []byte {
	buf := &bytes.Buffer{}
	switch majorFunction {
	case IRP_MJ_CREATE:
		// DR_CREATE_RSP: FileId(4) + Information(1) — always written
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint8(0))
	case IRP_MJ_CLOSE:
		// DR_CLOSE_RSP: Padding(5)
		buf.Write([]byte{0, 0, 0, 0, 0})
	case IRP_MJ_READ:
		// DR_READ_RSP: Length(4)=0
		binary.Write(buf, binary.LittleEndian, uint32(0))
	case IRP_MJ_WRITE:
		// DR_WRITE_RSP: Length(4)=0 + Padding(1)=0
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint8(0))
	case IRP_MJ_SET_INFORMATION:
		// DR_SET_INFORMATION_RSP: Length(4) — always written
		binary.Write(buf, binary.LittleEndian, uint32(0))
	case IRP_MJ_DIRECTORY_CONTROL:
		// DR_QUERY_DIRECTORY_RSP on failure: Length(4)=0 + Padding(1)=0
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint8(0))
	case IRP_MJ_LOCK_CONTROL, IRP_MJ_DEVICE_CONTROL:
		// silent_ignore / device_control: Length(4)=0 / OutputBufferLength(4)=0
		binary.Write(buf, binary.LittleEndian, uint32(0))
	case IRP_MJ_QUERY_VOLUME:
		// FreeRDP ALWAYS writes Length(4)=0 on failure for QUERY_VOLUME,
		// even in the default/unhandled case.  Omitting this 4-byte field
		// desyncs the server's RDPDR stream parser by 4 bytes, which
		// causes subsequent IOCOMPLETION messages to be misinterpreted
		// and the drive to be dropped with error 0x8007048F.
		binary.Write(buf, binary.LittleEndian, uint32(0))
	case IRP_MJ_QUERY_INFORMATION:
		// FreeRDP writes NO body on failure for QUERY_INFORMATION.
		// The server knows from IoStatus != STATUS_SUCCESS that there is no
		// Length/data pair to read.
	case IRP_MJ_CLEANUP, IRP_MJ_FLUSH_BUFFERS, IRP_MJ_SHUTDOWN:
		// No body expected
	default:
		// Unknown IRP — safest to write nothing.
	}
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

// ─── Agent RPC calls (ZFT2 binary WebSocket) ────────────────────

type agentFileStat struct {
	Name  string
	Path  string
	IsDir bool
	Size  int64
	Mtime int64
}

func (h *RdpefsHandler) requestAgent(agentID string, op byte, meta map[string]any, payload []byte) (fileTransferResponse, error) {
	h.mu.Lock()
	transfer := h.transfer
	h.mu.Unlock()
	if transfer == nil {
		return fileTransferResponse{}, fmt.Errorf("file transfer is unavailable")
	}
	return transfer.Request(agentID, op, meta, payload)
}

func (h *RdpefsHandler) callAgentStat(agentID, path string) *agentFileStat {
	response, err := h.requestAgent(agentID, zft2Stat, map[string]any{"path": path}, nil)
	if err != nil {
		if zerr, ok := err.(*zft2Error); ok && zerr.Code == "not_found" {
			return nil
		}
		slog.Warn("rdpefs: agent stat failed", "agent", agentID, "path", path, "err", err)
		return nil
	}
	return &agentFileStat{
		Name: stringMeta(response.Meta, "name"), Path: stringMeta(response.Meta, "path"),
		IsDir: boolMeta(response.Meta, "isDir"), Size: int64Meta(response.Meta, "size"),
		Mtime: int64Meta(response.Meta, "mtime"),
	}
}

func (h *RdpefsHandler) callAgentOpen(agentID, path, mode string) string {
	response, err := h.requestAgent(agentID, zft2Open, map[string]any{"path": path, "mode": mode}, nil)
	if err != nil {
		slog.Warn("rdpefs: agent open failed", "path", path, "err", err)
		return ""
	}
	return stringMeta(response.Meta, "handle")
}

func (h *RdpefsHandler) callAgentRead(agentID, handle string, offset uint64, length uint32) []byte {
	response, err := h.requestAgent(agentID, zft2Read, map[string]any{"handle": handle, "offset": offset, "length": length}, nil)
	if err != nil {
		slog.Warn("rdpefs: agent read failed", "handle", handle, "offset", offset, "err", err)
		return nil
	}
	return response.Payload
}

func (h *RdpefsHandler) callAgentReadWindow(agentID, handle string, offset uint64, length uint32) []byte {
	// Keep part size at agentReadAheadChunkBytes (256 KiB) so short-read
	// Agents (Android) return contiguous windows instead of four sparse 1 MiB
	// offsets that would only keep the first short part.
	const partSize = agentReadAheadChunkBytes
	if length <= partSize {
		return h.callAgentRead(agentID, handle, offset, length)
	}
	type part struct {
		index int
		data  []byte
	}
	parts := int((length + partSize - 1) / partSize)
	if parts > agentReadAheadParallel {
		parts = agentReadAheadParallel
		length = uint32(parts * partSize)
	}
	results := make(chan part, parts)
	for index := 0; index < parts; index++ {
		partOffset := offset + uint64(index*partSize)
		partLength := uint32(partSize)
		remaining := int(length) - index*partSize
		if remaining < int(partLength) {
			partLength = uint32(remaining)
		}
		go func(index int, partOffset uint64, partLength uint32) {
			results <- part{index: index, data: h.callAgentRead(agentID, handle, partOffset, partLength)}
		}(index, partOffset, partLength)
	}
	ordered := make([][]byte, parts)
	for range parts {
		result := <-results
		if result.data == nil {
			return nil
		}
		ordered[result.index] = result.data
	}
	window := make([]byte, 0, length)
	for _, data := range ordered {
		window = append(window, data...)
		if len(data) < partSize {
			break
		}
	}
	return window
}

func (h *RdpefsHandler) callAgentWrite(agentID, handle string, offset uint64, data []byte) int {
	// Split oversized writes so Android Agents advertising 256 KiB chunks
	// (Binder/MethodChannel) can accept Explorer multi-MB IRPs.
	const maxWriteChunk = 256 * 1024
	if len(data) == 0 {
		return 0
	}
	if len(data) <= maxWriteChunk {
		response, err := h.requestAgent(agentID, zft2Write, map[string]any{"handle": handle, "offset": offset}, data)
		if err != nil {
			slog.Warn("rdpefs: agent write failed", "handle", handle, "offset", offset, "err", err)
			return 0
		}
		return int(int64Meta(response.Meta, "bytesWritten"))
	}
	written := 0
	for written < len(data) {
		end := written + maxWriteChunk
		if end > len(data) {
			end = len(data)
		}
		chunk := data[written:end]
		response, err := h.requestAgent(agentID, zft2Write, map[string]any{"handle": handle, "offset": offset + uint64(written)}, chunk)
		if err != nil {
			slog.Warn("rdpefs: agent write failed", "handle", handle, "offset", offset+uint64(written), "err", err)
			return written
		}
		n := int(int64Meta(response.Meta, "bytesWritten"))
		if n <= 0 {
			return written
		}
		written += n
		if n < len(chunk) {
			return written
		}
	}
	return written
}

func (h *RdpefsHandler) callAgentClose(agentID, handle string) {
	_, err := h.requestAgent(agentID, zft2Close, map[string]any{"handle": handle}, nil)
	if err != nil {
		slog.Debug("rdpefs: agent close failed", "handle", handle, "err", err)
	}
}

func (h *RdpefsHandler) callAgentMkdir(agentID, path string) bool {
	_, err := h.requestAgent(agentID, zft2Mkdir, map[string]any{"path": path}, nil)
	return err == nil
}

func (h *RdpefsHandler) callAgentDelete(agentID, path string) bool {
	_, err := h.requestAgent(agentID, zft2Delete, map[string]any{"path": path}, nil)
	return err == nil
}

func (h *RdpefsHandler) callAgentRename(agentID, oldPath, newPath string) bool {
	_, err := h.requestAgent(agentID, zft2Rename, map[string]any{"oldPath": oldPath, "newPath": newPath}, nil)
	return err == nil
}

func (h *RdpefsHandler) callAgentTruncate(agentID, path string, size uint64) bool {
	_, err := h.requestAgent(agentID, zft2Truncate, map[string]any{"path": path, "size": size}, nil)
	return err == nil
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

func buildNetworkOpenInfo(isDir bool, size int64, mtime time.Time) []byte {
	buf := &bytes.Buffer{}
	ft := windowsFileTime(mtime)
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if isDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	binary.Write(buf, binary.LittleEndian, ft)   // CreationTime
	binary.Write(buf, binary.LittleEndian, ft)   // LastAccessTime
	binary.Write(buf, binary.LittleEndian, ft)   // LastWriteTime
	binary.Write(buf, binary.LittleEndian, ft)   // ChangeTime
	binary.Write(buf, binary.LittleEndian, size) // AllocationSize
	binary.Write(buf, binary.LittleEndian, size) // EndOfFile
	binary.Write(buf, binary.LittleEndian, attrs)
	binary.Write(buf, binary.LittleEndian, uint32(0)) // Reserved
	return buf.Bytes()
}

func buildNameInfo(path string) []byte {
	nameBytes := encodeUTF16LENoNull(path)
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint32(len(nameBytes)))
	buf.Write(nameBytes)
	return buf.Bytes()
}

func buildAllInfo(isDir bool, size int64, mtime time.Time, path string) []byte {
	buf := &bytes.Buffer{}
	buf.Write(buildBasicInfo(isDir, mtime))
	buf.Write(buildStandardInfo(isDir, size))
	buf.Write(make([]byte, 8)) // FileInternalInformation.IndexNumber
	buf.Write(make([]byte, 4)) // FileEaInformation.EaSize
	buf.Write(make([]byte, 4)) // FileAccessInformation.AccessFlags
	buf.Write(make([]byte, 8)) // FilePositionInformation.CurrentByteOffset
	buf.Write(make([]byte, 4)) // FileModeInformation.Mode
	buf.Write(make([]byte, 4)) // FileAlignmentInformation.AlignmentRequirement
	buf.Write(buildNameInfo(path))
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
		// http://msdn.microsoft.com/en-us/library/cc232095.aspx
		// Layout: NextEntryOffset(4) + FileIndex(4) +
		//   CreationTime(8) + LastAccessTime(8) + LastWriteTime(8) + ChangeTime(8) +
		//   EndOfFile(8) + AllocationSize(8) + FileAttributes(4) +
		//   FileNameLength(4) + EaSize(4) + ShortNameLength(1) + ShortName(24) + FileName
		// = 4+4+ 8*4 + 8*2 + 4 + 4+4 + 1+24 = 93 bytes + FileName
		binary.Write(buf, binary.LittleEndian, uint32(0))         // NextEntryOffset
		binary.Write(buf, binary.LittleEndian, uint32(0))         // FileIndex
		binary.Write(buf, binary.LittleEndian, ft)                // CreationTime
		binary.Write(buf, binary.LittleEndian, ft)                // LastAccessTime
		binary.Write(buf, binary.LittleEndian, ft)                // LastWriteTime
		binary.Write(buf, binary.LittleEndian, ft)                // ChangeTime
		binary.Write(buf, binary.LittleEndian, size)              // EndOfFile
		binary.Write(buf, binary.LittleEndian, size)              // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)             // FileAttributes
		binary.Write(buf, binary.LittleEndian, uint32(len(name))) // FileNameLength
		binary.Write(buf, binary.LittleEndian, uint32(0))         // EaSize
		binary.Write(buf, binary.LittleEndian, uint8(0))          // ShortNameLength
		buf.Write(make([]byte, 24))                               // ShortName (WCHAR[12])
		buf.Write(name)                                           // FileName
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
