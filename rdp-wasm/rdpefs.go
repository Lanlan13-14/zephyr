//go:build js && wasm

// rdpefs.go — MS-RDPEFS (File System Virtual Channel Extension) over rdpdr
//
// Implements the rdpdr static virtual channel to expose browser-selected
// files/directories to the remote Windows desktop as a redirected drive.
//
// Protocol flow:
//   Server → Client: Server Announce Request
//   Client → Server: Client Announce Reply
//   Client → Server: Client Name Request
//   Server → Client: Server Core Capability Request
//   Client → Server: Client Core Capability Response
//   Client → Server: Client Device List Announce
//   Server → Client: Server Device Announce Response
//   Server → Client: Device I/O Request (IRP)
//   Client → Server: Device I/O Response
//
// Supported IRP types:
//   IRP_MJ_CREATE, IRP_MJ_CLOSE, IRP_MJ_READ,
//   IRP_MJ_QUERY_INFORMATION, IRP_MJ_QUERY_DIRECTORY

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
	PAKID_CORE_SERVER_ANNOUNCE    = 0x496E // Server Announce
	PAKID_CORE_CLIENTID_CONFIRM   = 0x4343 // Client Announce Reply
	PAKID_CORE_CLIENT_NAME        = 0x434E // Client Name
	PAKID_CORE_DEVICELIST_ANNOUNCE = 0x4441 // Device List Announce
	PAKID_CORE_DEVICE_REPLY       = 0x6452 // Server Device Announce Response
	PAKID_CORE_DEVICE_IOREQUEST   = 0x4952 // Device I/O Request
	PAKID_CORE_DEVICE_IOCOMPLETION = 0x4943 // Device I/O Completion
	PAKID_CORE_SERVER_CAPABILITY   = 0x5350 // Server Core Capability
	PAKID_CORE_CLIENT_CAPABILITY   = 0x4350 // Client Core Capability
	PAKID_CORE_USER_LOGGEDON       = 0x554C // Server User Logged On ("UL")
	PAKID_CORE_DEVICELIST_REMOVE   = 0x444D // Client Drive Device List Remove
)

// rdpdr version minor
const (
	RDPDR_VERSION_MINOR_RDP51 = 0x0005
)

// Device types
const (
	RDPDR_DTYP_FILESYSTEM = 0x00000008
)

// IRP major functions
const (
	IRP_MJ_CREATE          = 0x00000000
	IRP_MJ_CLOSE           = 0x00000002
	IRP_MJ_READ            = 0x00000003
	IRP_MJ_WRITE           = 0x00000004
	IRP_MJ_DEVICE_CONTROL  = 0x0000000E
	IRP_MJ_QUERY_VOLUME    = 0x0000000A
	IRP_MJ_SET_VOLUME      = 0x0000000B
	IRP_MJ_QUERY_INFORMATION = 0x00000005
	IRP_MJ_SET_INFORMATION   = 0x00000006
	IRP_MJ_DIRECTORY_CONTROL = 0x0000000C
	IRP_MJ_LOCK_CONTROL     = 0x00000011
)

// IRP minor functions for IRP_MJ_DIRECTORY_CONTROL
const (
	IRP_MN_QUERY_DIRECTORY  = 0x00000001
	IRP_MN_NOTIFY_CHANGE_DIRECTORY = 0x00000002
)

// File information classes
const (
	FileBasicInformation       = 4
	FileStandardInformation    = 5
	FileAttributeTagInformation = 35
	FileBothDirectoryInformation = 3
	FileDirectoryInformation   = 1
	FileFullDirectoryInformation = 2
	FileNamesInformation       = 12
)

// NT status codes
const (
	STATUS_SUCCESS           = 0x00000000
	STATUS_NO_MORE_FILES     = 0x80000006
	STATUS_NOT_IMPLEMENTED   = 0xC0000002
	STATUS_NO_SUCH_FILE      = 0xC000000F
	STATUS_OBJECT_NAME_NOT_FOUND = 0xC0000034
	STATUS_ACCESS_DENIED     = 0xC0000022
	STATUS_NOT_SUPPORTED     = 0xC00000BB
	STATUS_INVALID_PARAMETER = 0xC000000D
	STATUS_UNSUCCESSFUL      = 0xC0000001
	STATUS_INVALID_DEVICE_REQUEST = 0xC0000010
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
	CAP_GENERAL_TYPE  = 0x0001
	CAP_PRINTER_TYPE  = 0x0002
	CAP_PORT_TYPE     = 0x0003
	CAP_DRIVE_TYPE    = 0x0004
	CAP_SMARTCARD_TYPE = 0x0005
)

// VirtualFile represents a file from the browser FileSystem API
type VirtualFile struct {
	Name     string
	IsDir    bool
	Size     int64
	ModTime  time.Time
	Data     []byte // file content (loaded lazily from JS)
	Children map[string]*VirtualFile
}

// RdpefsHandler implements plugin.ChannelTransport for the rdpdr SVC
type RdpefsHandler struct {
	mu          sync.Mutex
	sender      func(string, []byte) (int, error)
	enabled     bool
	deviceID    uint32
	clientID    uint32
	versionMajor uint16
	versionMinor uint16

	// File handle management
	nextFileID  uint32
	openFiles   map[uint32]*VirtualFile // fileID → file
	openPaths   map[uint32]string       // fileID → path

	// Virtual filesystem root
	root        *VirtualFile
	driveName   string

	// Protocol state
	userLoggedOn bool
	announced    bool

	// Directory enumeration state keyed by fileID (not on VirtualFile,
	// so concurrent queries on the same directory don't clobber each other).
	dirEnum map[uint32]*dirEnumState
}

type dirEnumState struct {
	entries []*VirtualFile
	index   int
}

func NewRdpefsHandler(enabled bool) *RdpefsHandler {
	return &RdpefsHandler{
		enabled:   enabled,
		deviceID:  1,
		nextFileID: 1,
		openFiles: make(map[uint32]*VirtualFile),
		openPaths: make(map[uint32]string),
		dirEnum:   make(map[uint32]*dirEnumState),
		driveName: "WEBRDP",
		root: &VirtualFile{
			Name:     "",
			IsDir:    true,
			Children: make(map[string]*VirtualFile),
		},
	}
}

func (h *RdpefsHandler) GetType() (string, uint32) {
	return "rdpdr", 0x80000000 | 0x40000000 | 0x00400000 // INITIALIZED | ENCRYPT_RDP | COMPRESS_RDP
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

// Process handles incoming rdpdr PDUs
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
	binary.Write(buf, binary.LittleEndian, uint16(1)) // versionMajor
	binary.Write(buf, binary.LittleEndian, uint16(12)) // versionMinor (RDP 6.0)
	binary.Write(buf, binary.LittleEndian, h.clientID)
	h.send(buf.Bytes())

	// Send Client Name Request
	nameBuf := &bytes.Buffer{}
	binary.Write(nameBuf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(nameBuf, binary.LittleEndian, uint16(PAKID_CORE_CLIENT_NAME))
	binary.Write(nameBuf, binary.LittleEndian, uint32(1)) // unicodeFlag
	binary.Write(nameBuf, binary.LittleEndian, uint32(0)) // codePage
	computerName := encodeUTF16LE("WEBRDP")
	binary.Write(nameBuf, binary.LittleEndian, uint32(len(computerName)))
	nameBuf.Write(computerName)
	h.send(nameBuf.Bytes())
}

func (h *RdpefsHandler) processServerCapability(data []byte) {
	slog.Debug("rdpefs: server capability received")

	// Refresh file list from JS before announcing drive
	h.refreshFileList()

	// Send Client Core Capability Response
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_CLIENT_CAPABILITY))
	binary.Write(buf, binary.LittleEndian, uint16(1))  // numCapabilities
	binary.Write(buf, binary.LittleEndian, uint16(0))  // padding

	// General capability set
	binary.Write(buf, binary.LittleEndian, uint16(CAP_GENERAL_TYPE))
	binary.Write(buf, binary.LittleEndian, uint16(44))  // capabilityLength
	binary.Write(buf, binary.LittleEndian, uint32(1))   // version
	binary.Write(buf, binary.LittleEndian, uint32(2))   // osType (Windows)
	binary.Write(buf, binary.LittleEndian, uint32(0))   // osVersion
	binary.Write(buf, binary.LittleEndian, uint16(1))   // protocolMajor
	binary.Write(buf, binary.LittleEndian, uint16(12))  // protocolMinor
	binary.Write(buf, binary.LittleEndian, uint32(0xFFFF)) // ioCode1
	binary.Write(buf, binary.LittleEndian, uint32(0))   // ioCode2
	binary.Write(buf, binary.LittleEndian, uint32(7))   // extendedPDU (RDPDR_DEVICE_REMOVE|USER_LOGGEDON|CLIENT_DISPLAY_NAME)
	binary.Write(buf, binary.LittleEndian, uint32(0))   // extraFlags1
	binary.Write(buf, binary.LittleEndian, uint32(0))   // extraFlags2
	binary.Write(buf, binary.LittleEndian, uint32(0))   // specialTypeDeviceCap
	h.send(buf.Bytes())

	// Refresh file list from JS.
	h.refreshFileList()

	// Device announce timing (MS-RDPEFS + FreeRDP rdpdr_main.c:1399):
	//   - RDP 5.1 servers (versionMinor 0x0005) don't send USER_LOGGEDON,
	//     so we must announce immediately.
	//   - Modern Windows sends PAKID_CORE_USER_LOGGEDON; we must wait for it
	//     before announcing, otherwise the drive is rejected as invalid.
	if h.enabled && h.versionMinor == RDPDR_VERSION_MINOR_RDP51 {
		h.announceDevice()
	}
}

// processUserLoggedOn is sent by modern Windows after the user session is
// established. This is the correct point to announce redirected drives.
func (h *RdpefsHandler) processUserLoggedOn() {
	slog.Debug("rdpefs: user logged on")
	h.mu.Lock()
	h.userLoggedOn = true
	already := h.announced
	h.mu.Unlock()
	if h.enabled && !already {
		h.announceDevice()
	}
}

func (h *RdpefsHandler) announceDevice() {
	h.mu.Lock()
	h.announced = true
	h.mu.Unlock()

	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICELIST_ANNOUNCE))
	binary.Write(buf, binary.LittleEndian, uint32(1)) // deviceCount

	// Device entry
	binary.Write(buf, binary.LittleEndian, uint32(RDPDR_DTYP_FILESYSTEM)) // deviceType
	binary.Write(buf, binary.LittleEndian, h.deviceID)                    // deviceId

	// PreferredDosName — exactly 8 bytes, null-padded ASCII (MS-RDPEFS
	// 2.2.1.3). Windows uses this verbatim as the share name (\\tsclient\NAME).
	// Must be ≤7 chars + null, uppercase; non-ASCII bytes become '_'.
	dosName := make([]byte, 8)
	name := strings.ToUpper(h.driveName)
	for i := 0; i < 7 && i < len(name); i++ {
		c := name[i]
		if c > 0x7F {
			c = '_'
		}
		dosName[i] = c
	}
	// byte 7 stays 0 (null terminator)
	buf.Write(dosName)

	// DeviceDataLength — 0 for a filesystem drive (name is in PreferredDosName).
	binary.Write(buf, binary.LittleEndian, uint32(0))

	h.send(buf.Bytes())
	slog.Debug("rdpefs: announced filesystem device", "name", h.driveName, "id", h.deviceID)
}

func (h *RdpefsHandler) processDeviceReply(data []byte) {
	if len(data) < 8 {
		return
	}
	deviceID := binary.LittleEndian.Uint32(data[0:4])
	status := binary.LittleEndian.Uint32(data[4:8])
	slog.Debug("rdpefs: device reply", "deviceID", deviceID, "status", status)
}

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

	_ = deviceID

	switch majorFunction {
	case IRP_MJ_CREATE:
		h.handleCreate(completionID, payload)
	case IRP_MJ_CLOSE:
		h.handleClose(completionID, fileID)
	case IRP_MJ_READ:
		h.handleRead(completionID, fileID, payload)
	case IRP_MJ_QUERY_INFORMATION:
		h.handleQueryInformation(completionID, fileID, payload)
	case IRP_MJ_DIRECTORY_CONTROL:
		h.handleDirectoryControl(completionID, fileID, minorFunction, payload)
	case IRP_MJ_QUERY_VOLUME:
		h.handleQueryVolume(completionID, payload)
	default:
		slog.Debug("rdpefs: unsupported IRP", "major", majorFunction, "minor", minorFunction)
		h.sendIOCompletion(completionID, STATUS_NOT_SUPPORTED, nil)
	}
}

func (h *RdpefsHandler) handleCreate(completionID uint32, data []byte) {
	if len(data) < 32 {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	desiredAccess := binary.LittleEndian.Uint32(data[0:4])
	_ = desiredAccess
	// allocationSize := binary.LittleEndian.Uint64(data[4:12])
	// fileAttributes := binary.LittleEndian.Uint32(data[12:16])
	// sharedAccess := binary.LittleEndian.Uint32(data[16:20])
	createDisposition := binary.LittleEndian.Uint32(data[20:24])
	createOptions := binary.LittleEndian.Uint32(data[24:28])
	pathLen := binary.LittleEndian.Uint32(data[28:32])
	pathBytes := data[32:]
	if uint32(len(pathBytes)) < pathLen {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	path := decodeUTF16LE(pathBytes[:pathLen])
	path = strings.TrimRight(path, "\x00")
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "/")

	slog.Debug("rdpefs: CREATE", "path", path, "disp", createDisposition, "opts", createOptions, "completionID", completionID)

	const (
		FILE_DIRECTORY_FILE     = 0x00000001
		FILE_NON_DIRECTORY_FILE = 0x00000040
		FILE_SUPERSEDE          = 0x00000000
		FILE_OPEN               = 0x00000001
		FILE_CREATE             = 0x00000002
		FILE_OPEN_IF            = 0x00000003
		FILE_OVERWRITE          = 0x00000004
		FILE_OVERWRITE_IF       = 0x00000005
		// Information response values
		FILE_SUPERSEDED = 0x00000000
		FILE_OPENED     = 0x00000001
		FILE_OVERWRITTEN = 0x00000003
	)

	h.mu.Lock()
	file := h.resolvePath(path)
	if file == nil {
		h.mu.Unlock()
		// Read-only virtual drive: we don't create new files/dirs.
		if createDisposition == FILE_CREATE || createDisposition == FILE_OPEN_IF ||
			createDisposition == FILE_OVERWRITE_IF || createDisposition == FILE_SUPERSEDE {
			h.sendIOCompletion(completionID, STATUS_ACCESS_DENIED, nil)
			return
		}
		h.sendIOCompletion(completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	// Validate directory/file expectation against createOptions.
	if createOptions&FILE_DIRECTORY_FILE != 0 && !file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletion(completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}
	if createOptions&FILE_NON_DIRECTORY_FILE != 0 && file.IsDir {
		h.mu.Unlock()
		h.sendIOCompletion(completionID, STATUS_ACCESS_DENIED, nil)
		return
	}

	fid := h.nextFileID
	h.nextFileID++
	h.openFiles[fid] = file
	h.openPaths[fid] = path
	h.mu.Unlock()

	// Send success with fileID + Information (FILE_OPENED for existing objects).
	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, fid)             // FileId (4)
	binary.Write(resp, binary.LittleEndian, uint8(FILE_OPENED)) // Information (1)
	h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
}

func (h *RdpefsHandler) handleClose(completionID uint32, fileID uint32) {
	h.mu.Lock()
	delete(h.openFiles, fileID)
	delete(h.openPaths, fileID)
	delete(h.dirEnum, fileID)
	h.mu.Unlock()
	// DR_CLOSE_RSP: Padding (5 bytes) per MS-RDPEFS 2.2.1.5.2.
	h.sendIOCompletion(completionID, STATUS_SUCCESS, make([]byte, 5))
}

func (h *RdpefsHandler) handleRead(completionID uint32, fileID uint32, data []byte) {
	if len(data) < 12 {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	length := binary.LittleEndian.Uint32(data[0:4])
	offset := binary.LittleEndian.Uint64(data[4:12])

	h.mu.Lock()
	file := h.openFiles[fileID]
	h.mu.Unlock()

	if file == nil || file.IsDir {
		h.sendIOCompletion(completionID, STATUS_INVALID_DEVICE_REQUEST, nil)
		return
	}

	// Load file data from JS if not yet loaded
	if file.Data == nil {
		h.loadFileData(file)
	}

	start := int(offset)
	if start >= len(file.Data) {
		// EOF
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(0)) // length
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
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
	h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
}

func (h *RdpefsHandler) handleQueryInformation(completionID uint32, fileID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	h.mu.Lock()
	file := h.openFiles[fileID]
	h.mu.Unlock()

	if file == nil {
		h.sendIOCompletion(completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	var info []byte
	switch infoClass {
	case FileBasicInformation:
		info = h.buildBasicInfo(file)
	case FileStandardInformation:
		info = h.buildStandardInfo(file)
	case FileAttributeTagInformation:
		info = h.buildAttributeTagInfo(file)
	default:
		slog.Debug("rdpefs: unsupported info class", "class", infoClass)
		h.sendIOCompletion(completionID, STATUS_NOT_SUPPORTED, nil)
		return
	}

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, uint32(len(info)))
	resp.Write(info)
	h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
}

func (h *RdpefsHandler) handleDirectoryControl(completionID uint32, fileID uint32, minorFunction uint32, data []byte) {
	if minorFunction == IRP_MN_NOTIFY_CHANGE_DIRECTORY {
		// Silently ignore change notifications
		return
	}
	if minorFunction != IRP_MN_QUERY_DIRECTORY {
		h.sendIOCompletion(completionID, STATUS_NOT_SUPPORTED, nil)
		return
	}
	if len(data) < 9 {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}

	infoClass := binary.LittleEndian.Uint32(data[0:4])
	initialQuery := data[4]
	pathLen := binary.LittleEndian.Uint32(data[5:9])
	var pattern string
	if pathLen > 0 && len(data) >= 9+int(pathLen) {
		pattern = decodeUTF16LE(data[9 : 9+pathLen])
		pattern = strings.TrimRight(pattern, "\x00")
	}

	h.mu.Lock()
	dir := h.openFiles[fileID]
	h.mu.Unlock()

	if dir == nil || !dir.IsDir {
		h.sendIOCompletion(completionID, STATUS_NO_SUCH_FILE, nil)
		return
	}

	_ = infoClass // We always return FileBothDirectoryInformation format

	if initialQuery != 0 {
		// Build list of entries: "." + ".." + children
		entries := make([]*VirtualFile, 0)
		entries = append(entries, &VirtualFile{Name: ".", IsDir: true, ModTime: dir.ModTime})
		entries = append(entries, &VirtualFile{Name: "..", IsDir: true, ModTime: dir.ModTime})
		for _, child := range dir.Children {
			if pattern == "" || pattern == "*" || pattern == "*.*" || matchPattern(pattern, child.Name) {
				entries = append(entries, child)
			}
		}

		if len(entries) == 0 {
			h.sendIOCompletion(completionID, STATUS_NO_MORE_FILES, nil)
			return
		}

		// Send the first entry; stash the rest keyed by fileID.
		entryBuf := h.buildDirectoryEntry(entries[0], infoClass)
		h.mu.Lock()
		h.dirEnum[fileID] = &dirEnumState{entries: entries[1:], index: 0}
		h.mu.Unlock()

		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(entryBuf)))
		resp.Write(entryBuf)
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
	} else {
		// Continue enumeration for this fileID.
		h.mu.Lock()
		st := h.dirEnum[fileID]
		h.mu.Unlock()

		if st == nil || st.index >= len(st.entries) {
			h.sendIOCompletion(completionID, STATUS_NO_MORE_FILES, nil)
			return
		}

		entry := st.entries[st.index]
		h.mu.Lock()
		st.index++
		h.mu.Unlock()

		entryBuf := h.buildDirectoryEntry(entry, infoClass)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(len(entryBuf)))
		resp.Write(entryBuf)
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())
	}
}

func (h *RdpefsHandler) handleQueryVolume(completionID uint32, data []byte) {
	if len(data) < 4 {
		h.sendIOCompletion(completionID, STATUS_INVALID_PARAMETER, nil)
		return
	}
	infoClass := binary.LittleEndian.Uint32(data[0:4])

	switch infoClass {
	case 1: // FileFsVolumeInformation
		label := encodeUTF16LENoNull(h.driveName)
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, int64(0))           // VolumeCreationTime
		binary.Write(info, binary.LittleEndian, uint32(0x12345678)) // VolumeSerialNumber
		binary.Write(info, binary.LittleEndian, uint32(len(label))) // VolumeLabelLength
		binary.Write(info, binary.LittleEndian, uint8(0))           // SupportsObjects
		binary.Write(info, binary.LittleEndian, uint8(0))           // Reserved
		info.Write(label)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())

	case 3: // FileFsSizeInformation
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, int64(1024*1024))  // TotalAllocationUnits
		binary.Write(info, binary.LittleEndian, int64(512*1024))   // AvailableAllocationUnits
		binary.Write(info, binary.LittleEndian, uint32(1))          // SectorsPerAllocationUnit
		binary.Write(info, binary.LittleEndian, uint32(4096))      // BytesPerSector
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())

	case 4: // FileFsDeviceInformation — required for the drive to initialise
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, uint32(0x00000007)) // DeviceType = FILE_DEVICE_DISK
		binary.Write(info, binary.LittleEndian, uint32(0x00000020)) // Characteristics = FILE_REMOTE_DEVICE
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())

	case 5: // FileFsAttributeInformation
		fsName := encodeUTF16LENoNull("FAT32")
		info := &bytes.Buffer{}
		binary.Write(info, binary.LittleEndian, uint32(0x00000003)) // FileSystemAttributes (CASE_SENSITIVE|UNICODE)
		binary.Write(info, binary.LittleEndian, uint32(255))         // MaxComponentNameLen
		binary.Write(info, binary.LittleEndian, uint32(len(fsName))) // FileSystemNameLength
		info.Write(fsName)
		resp := &bytes.Buffer{}
		binary.Write(resp, binary.LittleEndian, uint32(info.Len()))
		resp.Write(info.Bytes())
		h.sendIOCompletion(completionID, STATUS_SUCCESS, resp.Bytes())

	default:
		h.sendIOCompletion(completionID, STATUS_NOT_SUPPORTED, nil)
	}
}

// sendIOCompletion sends a Device I/O Completion PDU
func (h *RdpefsHandler) sendIOCompletion(completionID, status uint32, payload []byte) {
	buf := &bytes.Buffer{}
	binary.Write(buf, binary.LittleEndian, uint16(RDPDR_CTYP_CORE))
	binary.Write(buf, binary.LittleEndian, uint16(PAKID_CORE_DEVICE_IOCOMPLETION))
	binary.Write(buf, binary.LittleEndian, h.deviceID)
	binary.Write(buf, binary.LittleEndian, completionID)
	binary.Write(buf, binary.LittleEndian, status)
	if payload != nil {
		buf.Write(payload)
	}
	h.send(buf.Bytes())
}

// ─── File info builders ───

func (h *RdpefsHandler) buildBasicInfo(f *VirtualFile) []byte {
	buf := &bytes.Buffer{}
	ft := windowsFileTime(f.ModTime)
	binary.Write(buf, binary.LittleEndian, ft)   // CreationTime
	binary.Write(buf, binary.LittleEndian, ft)   // LastAccessTime
	binary.Write(buf, binary.LittleEndian, ft)   // LastWriteTime
	binary.Write(buf, binary.LittleEndian, ft)   // ChangeTime
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if f.IsDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	binary.Write(buf, binary.LittleEndian, attrs) // FileAttributes
	binary.Write(buf, binary.LittleEndian, uint32(0)) // Reserved
	return buf.Bytes()
}

func (h *RdpefsHandler) buildStandardInfo(f *VirtualFile) []byte {
	buf := &bytes.Buffer{}
	size := int64(f.Size)
	if f.Data != nil {
		size = int64(len(f.Data))
	}
	binary.Write(buf, binary.LittleEndian, size)  // AllocationSize
	binary.Write(buf, binary.LittleEndian, size)  // EndOfFile
	binary.Write(buf, binary.LittleEndian, uint32(1)) // NumberOfLinks
	deletePending := uint8(0)
	directory := uint8(0)
	if f.IsDir {
		directory = 1
	}
	binary.Write(buf, binary.LittleEndian, deletePending)
	binary.Write(buf, binary.LittleEndian, directory)
	return buf.Bytes()
}

func (h *RdpefsHandler) buildAttributeTagInfo(f *VirtualFile) []byte {
	buf := &bytes.Buffer{}
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if f.IsDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	binary.Write(buf, binary.LittleEndian, attrs) // FileAttributes
	binary.Write(buf, binary.LittleEndian, uint32(0)) // ReparseTag
	return buf.Bytes()
}

func (h *RdpefsHandler) buildDirectoryEntry(f *VirtualFile, infoClass uint32) []byte {
	name := encodeUTF16LE(f.Name)
	// encodeUTF16LE appends a null terminator; directory entries must NOT
	// include it in the name field, so strip the trailing 2 bytes.
	if len(name) >= 2 {
		name = name[:len(name)-2]
	}
	buf := &bytes.Buffer{}
	ft := windowsFileTime(f.ModTime)
	attrs := uint32(FILE_ATTRIBUTE_ARCHIVE)
	if f.IsDir {
		attrs = FILE_ATTRIBUTE_DIRECTORY
	}
	size := int64(f.Size)
	if f.Data != nil {
		size = int64(len(f.Data))
	}

	switch infoClass {
	case FileNamesInformation:
		// NextEntryOffset(4) FileIndex(4) FileNameLength(4) FileName
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(0))
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		buf.Write(name)

	case FileDirectoryInformation:
		binary.Write(buf, binary.LittleEndian, uint32(0)) // NextEntryOffset
		binary.Write(buf, binary.LittleEndian, uint32(0)) // FileIndex
		binary.Write(buf, binary.LittleEndian, ft)        // CreationTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastAccessTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastWriteTime
		binary.Write(buf, binary.LittleEndian, ft)        // ChangeTime
		binary.Write(buf, binary.LittleEndian, size)      // EndOfFile
		binary.Write(buf, binary.LittleEndian, size)      // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)     // FileAttributes
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		buf.Write(name)

	case FileFullDirectoryInformation:
		binary.Write(buf, binary.LittleEndian, uint32(0)) // NextEntryOffset
		binary.Write(buf, binary.LittleEndian, uint32(0)) // FileIndex
		binary.Write(buf, binary.LittleEndian, ft)        // CreationTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastAccessTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastWriteTime
		binary.Write(buf, binary.LittleEndian, ft)        // ChangeTime
		binary.Write(buf, binary.LittleEndian, size)      // EndOfFile
		binary.Write(buf, binary.LittleEndian, size)      // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)     // FileAttributes
		binary.Write(buf, binary.LittleEndian, uint32(len(name)))
		binary.Write(buf, binary.LittleEndian, uint32(0)) // EaSize
		buf.Write(name)

	default: // FileBothDirectoryInformation (3)
		binary.Write(buf, binary.LittleEndian, uint32(0)) // NextEntryOffset
		binary.Write(buf, binary.LittleEndian, uint32(0)) // FileIndex
		binary.Write(buf, binary.LittleEndian, ft)        // CreationTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastAccessTime
		binary.Write(buf, binary.LittleEndian, ft)        // LastWriteTime
		binary.Write(buf, binary.LittleEndian, ft)        // ChangeTime
		binary.Write(buf, binary.LittleEndian, size)      // EndOfFile
		binary.Write(buf, binary.LittleEndian, size)      // AllocationSize
		binary.Write(buf, binary.LittleEndian, attrs)     // FileAttributes
		binary.Write(buf, binary.LittleEndian, uint32(len(name))) // FileNameLength
		binary.Write(buf, binary.LittleEndian, uint32(0)) // EaSize
		binary.Write(buf, binary.LittleEndian, uint8(0))  // ShortNameLength
		binary.Write(buf, binary.LittleEndian, uint8(0))  // Reserved
		buf.Write(make([]byte, 24))                        // ShortName (24 bytes)
		buf.Write(name)
	}
	return buf.Bytes()
}

// ─── Path resolution ───

func (h *RdpefsHandler) resolvePath(path string) *VirtualFile {
	if path == "" || path == "/" || path == "." {
		return h.root
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	current := h.root
	for _, part := range parts {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			continue // stay at root
		}
		child, ok := current.Children[strings.ToLower(part)]
		if !ok {
			return nil
		}
		current = child
	}
	return current
}

// ─── JS interop ───

func (h *RdpefsHandler) refreshFileList() {
	// Call JS to get the current file list
	result := js.Global().Call("rdpStorageGetFiles")
	if result.IsNull() || result.IsUndefined() {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	h.root.Children = make(map[string]*VirtualFile)
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
		h.root.Children[strings.ToLower(name)] = f
	}
	slog.Debug("rdpefs: refreshed file list", "count", length)
}

func (h *RdpefsHandler) loadFileData(f *VirtualFile) {
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

// ─── Utility ───

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
	// Windows FILETIME: 100-nanosecond intervals since Jan 1, 1601
	const epoch = 116444736000000000
	if t.IsZero() {
		return epoch
	}
	return t.UnixNano()/100 + epoch
}

func matchPattern(pattern, name string) bool {
	if pattern == "*" || pattern == "*.*" {
		return true
	}
	pattern = strings.ToLower(pattern)
	name = strings.ToLower(name)
	return strings.Contains(name, strings.ReplaceAll(pattern, "*", ""))
}
