// Package cliprdr handler.go implements a cross-platform CLIPRDR
// (Clipboard Virtual Channel Extension, MS-RDPECLIP) handler for
// bidirectional text and file clipboard sharing between RDP client and server.
package cliprdr

import (
	"bytes"
	"encoding/binary"
	"log/slog"
	"strings"
	"unicode/utf16"

	"github.com/nakagami/grdp/core"
)

// ClipFile represents a file on the clipboard (client→server or server→client).
type ClipFile struct {
	Name string
	Size uint64
	Data []byte // only populated for client→server or after download
}

// CliprdrHandler implements plugin.ChannelTransport for the "cliprdr"
// static virtual channel.
type CliprdrHandler struct {
	channelSender core.ChannelSender

	useLongFormatNames    bool
	streamFileClipEnabled bool
	canLockClipData       bool

	serverCapsReceived bool
	monitorReady       bool

	// Text clipboard callbacks
	onRemoteClipboardChanged func(text string)
	getLocalClipboardText    func() string

	// File clipboard callbacks
	onRemoteFilesAvailable func(files []ClipFile) // server advertised files
	getLocalFiles          func() []ClipFile       // get files to send to server
	getLocalFileData       func(index int, offset uint64, length uint32) []byte

	// Track server's file list (from FileGroupDescriptor)
	serverFiles []ClipFile
	// Track pending file contents download
	fileDownloadCh chan []byte

	suppressNextLocalChange bool
	// formatID assigned by server for FileGroupDescriptorW
	fgdFormatId uint32
	// formatIDs we assign in our FORMAT_LIST for client→server file transfer
	localFGDFormatId uint32
	localFCFormatId  uint32
}

// NewHandler creates a CliprdrHandler.
//
//   - onRemote is called when the server clipboard text is received.
//   - getLocal is called to retrieve the current local clipboard text.
//
// Either callback may be nil.
func NewHandler(onRemote func(text string), getLocal func() string) *CliprdrHandler {
	return &CliprdrHandler{
		onRemoteClipboardChanged: onRemote,
		getLocalClipboardText:    getLocal,
		fileDownloadCh:           make(chan []byte, 4),
	}
}

// SetFileCallbacks sets the file clipboard callbacks. Must be called before Login.
func (h *CliprdrHandler) SetFileCallbacks(
	onRemoteFiles func(files []ClipFile),
	getFiles func() []ClipFile,
	getFileData func(index int, offset uint64, length uint32) []byte,
) {
	h.onRemoteFilesAvailable = onRemoteFiles
	h.getLocalFiles = getFiles
	h.getLocalFileData = getFileData
}

// --- plugin.ChannelTransport interface ------------------------------------

func (h *CliprdrHandler) GetType() (string, uint32) {
	return ChannelName, ChannelOption
}

func (h *CliprdrHandler) Sender(f core.ChannelSender) {
	h.channelSender = f
}

// Process handles a reassembled CLIPRDR PDU from the server.
func (h *CliprdrHandler) Process(s []byte) {
	if len(s) < 8 {
		return
	}
	r := bytes.NewReader(s)
	msgType, _ := core.ReadUint16LE(r)
	msgFlags, _ := core.ReadUint16LE(r)
	dataLen, _ := core.ReadUInt32LE(r)

	body := make([]byte, dataLen)
	if dataLen > 0 {
		n, _ := r.Read(body)
		body = body[:n]
	}

	slog.Debug("cliprdr recv", "msgType", msgType, "msgFlags", msgFlags, "dataLen", dataLen)

	switch msgType {
	case CB_CLIP_CAPS:
		h.processClipCaps(body)
	case CB_MONITOR_READY:
		h.processMonitorReady()
	case CB_FORMAT_LIST:
		h.processFormatList(body, msgFlags)
	case CB_FORMAT_LIST_RESPONSE:
		h.processFormatListResponse(msgFlags)
	case CB_FORMAT_DATA_REQUEST:
		h.processFormatDataRequest(body)
	case CB_FORMAT_DATA_RESPONSE:
		h.processFormatDataResponse(body, msgFlags)
	case CB_LOCK_CLIPDATA, CB_UNLOCK_CLIPDATA:
		// ignored
	case CB_FILECONTENTS_REQUEST:
		h.processFileContentsRequest(body)
	case CB_FILECONTENTS_RESPONSE:
		h.processFileContentsResponse(body, msgFlags)
	default:
		slog.Debug("cliprdr: unhandled msgType", "msgType", msgType)
	}
}

// --- Clipboard Capabilities (MS-RDPECLIP 2.2.2.1) -------------------------

func (h *CliprdrHandler) processClipCaps(body []byte) {
	if len(body) < 4 {
		return
	}
	cCapSets := binary.LittleEndian.Uint16(body[0:2])
	// pad1 at [2:4]
	offset := 4
	for i := 0; i < int(cCapSets); i++ {
		if offset+4 > len(body) {
			break
		}
		capType := binary.LittleEndian.Uint16(body[offset:])
		capLen := binary.LittleEndian.Uint16(body[offset+2:])
		if capType == CB_CAPSTYPE_GENERAL && capLen >= 12 {
			generalFlags := binary.LittleEndian.Uint32(body[offset+8:])
			h.useLongFormatNames = generalFlags&CB_USE_LONG_FORMAT_NAMES != 0
			h.streamFileClipEnabled = generalFlags&CB_STREAM_FILECLIP_ENABLED != 0
			h.canLockClipData = generalFlags&CB_CAN_LOCK_CLIPDATA != 0
			slog.Debug("cliprdr: server caps", "generalFlags", generalFlags, "longNames", h.useLongFormatNames, "fileClip", h.streamFileClipEnabled, "lockClip", h.canLockClipData)
		}
		offset += int(capLen)
	}
	h.serverCapsReceived = true
	// If CB_MONITOR_READY already arrived before CB_CLIP_CAPS (non-standard
	// ordering), send the FORMAT_LIST now that we have correct capabilities.
	if h.monitorReady {
		h.sendFormatList()
	}
}

func (h *CliprdrHandler) sendClipCaps() {
	b := &bytes.Buffer{}
	binary.Write(b, binary.LittleEndian, uint16(CB_CAPSTYPE_GENERAL))
	binary.Write(b, binary.LittleEndian, uint16(12))
	binary.Write(b, binary.LittleEndian, uint32(CB_CAPS_VERSION_2))
	flags := uint32(CB_USE_LONG_FORMAT_NAMES | CB_STREAM_FILECLIP_ENABLED | CB_FILECLIP_NO_FILE_PATHS)
	if h.getLocalFiles != nil || h.onRemoteFilesAvailable != nil {
		flags |= CB_HUGE_FILE_SUPPORT_ENABLED
	}
	binary.Write(b, binary.LittleEndian, flags)

	body := &bytes.Buffer{}
	binary.Write(body, binary.LittleEndian, uint16(1))
	binary.Write(body, binary.LittleEndian, uint16(0))
	body.Write(b.Bytes())

	h.sendPDU(CB_CLIP_CAPS, 0, body.Bytes())
}

// --- Monitor Ready (MS-RDPECLIP 2.2.2.2) ----------------------------------

func (h *CliprdrHandler) processMonitorReady() {
	slog.Debug("cliprdr: server Monitor Ready")
	h.monitorReady = true
	h.sendClipCaps()
	// Per MS-RDPECLIP §1.3.2.1 the server sends CB_CLIP_CAPS before
	// CB_MONITOR_READY.  Only send FORMAT_LIST after server caps are known
	// so useLongFormatNames is set correctly.  If CB_CLIP_CAPS hasn't been
	// received yet (non-standard ordering), defer until processClipCaps fires.
	if h.serverCapsReceived {
		h.sendFormatList()
	}
}

// --- Format List (MS-RDPECLIP 2.2.3.1) ------------------------------------

func (h *CliprdrHandler) sendFormatList() {
	b := &bytes.Buffer{}
	if h.useLongFormatNames {
		// Long Format Name: formatId(4) + wszFormatName(null-terminated UTF-16LE)
		binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
		b.Write([]byte{0, 0}) // empty name = standard format
	} else {
		// Short Format Name: formatId(4) + formatName[32]
		binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
		b.Write(make([]byte, 32))
	}
	h.sendPDU(CB_FORMAT_LIST, 0, b.Bytes())
}

func (h *CliprdrHandler) processFormatList(body []byte, msgFlags uint16) {
	formats := h.parseFormatList(body, msgFlags)
	slog.Debug("cliprdr: server Format List", "formats", formats)

	h.sendPDU(CB_FORMAT_LIST_RESPONSE, CB_RESPONSE_OK, nil)

	// Check for FileGroupDescriptorW first (file clipboard)
	for _, f := range formats {
		if strings.Contains(strings.ToLower(f.FormatName), "filegroupdescriptorw") || f.FormatName == "FileGroupDescriptorW" {
			h.fgdFormatId = f.FormatId
			h.sendFormatDataRequest(f.FormatId)
			slog.Debug("cliprdr: requesting FileGroupDescriptorW", "formatId", f.FormatId)
			return
		}
	}

	// Fallback: request text
	for _, f := range formats {
		if f.FormatId == CF_UNICODETEXT {
			h.sendFormatDataRequest(CF_UNICODETEXT)
			return
		}
	}
	for _, f := range formats {
		if f.FormatId == CF_TEXT {
			h.sendFormatDataRequest(CF_TEXT)
			return
		}
	}
}

func (h *CliprdrHandler) parseFormatList(body []byte, msgFlags uint16) []CliprdrFormat {
	var formats []CliprdrFormat
	if h.useLongFormatNames && (msgFlags&CB_ASCII_NAMES == 0) {
		// Long Format Names (MS-RDPECLIP 2.2.3.1.1.1)
		offset := 0
		for offset+4 <= len(body) {
			fmtId := binary.LittleEndian.Uint32(body[offset:])
			offset += 4
			// Read null-terminated UTF-16LE string
			nameEnd := offset
			for nameEnd+1 < len(body) {
				if body[nameEnd] == 0 && body[nameEnd+1] == 0 {
					break
				}
				nameEnd += 2
			}
			name := decodeUTF16LE(body[offset:nameEnd])
			offset = nameEnd + 2
			formats = append(formats, CliprdrFormat{fmtId, name})
		}
	} else {
		// Short Format Names (MS-RDPECLIP 2.2.3.1.1.2)
		offset := 0
		for offset+36 <= len(body) {
			fmtId := binary.LittleEndian.Uint32(body[offset:])
			nameBytes := body[offset+4 : offset+36]
			var name string
			if msgFlags&CB_ASCII_NAMES != 0 {
				name = strings.TrimRight(string(nameBytes), "\x00")
			} else {
				name = decodeUTF16LE(nameBytes)
				name = strings.TrimRight(name, "\x00")
			}
			formats = append(formats, CliprdrFormat{fmtId, name})
			offset += 36
		}
	}
	return formats
}

func (h *CliprdrHandler) processFormatListResponse(msgFlags uint16) {
	if msgFlags&CB_RESPONSE_OK != 0 {
		slog.Debug("cliprdr: Format List Response OK")
	} else {
		slog.Warn("cliprdr: Format List Response FAIL")
	}
}

// --- Format Data Request / Response (MS-RDPECLIP 2.2.5) --------------------

func (h *CliprdrHandler) sendFormatDataRequest(formatId uint32) {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, formatId)
	h.sendPDU(CB_FORMAT_DATA_REQUEST, 0, b)
	slog.Debug("cliprdr: sent Format Data Request", "formatId", formatId)
}

func (h *CliprdrHandler) processFormatDataRequest(body []byte) {
	if len(body) < 4 {
		h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_FAIL, nil)
		return
	}
	requestedFormat := binary.LittleEndian.Uint32(body[0:4])
	slog.Debug("cliprdr: server requests format", "formatId", requestedFormat)

	// Check if this is a FileGroupDescriptorW or FileContents format
	if h.handleFormatDataRequestFiles(requestedFormat) {
		return
	}
	// FileContents via FORMAT_DATA_REQUEST is not standard; actual file data
	// comes via CB_FILECONTENTS_REQUEST. Respond FAIL to let server use the
	// correct channel.
	if requestedFormat == h.localFCFormatId || requestedFormat == 0xC0E1 {
		h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_FAIL, nil)
		return
	}

	text := ""
	if h.getLocalClipboardText != nil {
		text = h.getLocalClipboardText()
	}

	switch requestedFormat {
	case CF_UNICODETEXT:
		encoded := encodeUTF16LE(text) // encodeUTF16LE appends null terminator
		h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_OK, encoded)
	case CF_TEXT:
		h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_OK, []byte(text+"\x00"))
	default:
		h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_FAIL, nil)
	}
}

func (h *CliprdrHandler) processFormatDataResponse(body []byte, msgFlags uint16) {
	if msgFlags&CB_RESPONSE_OK == 0 {
		slog.Warn("cliprdr: Format Data Response FAIL")
		return
	}

	// Check if this is a FileGroupDescriptorW response
	if h.fgdFormatId != 0 && len(body) >= 4 {
		cItems := binary.LittleEndian.Uint32(body[0:4])
		if cItems > 0 && len(body) >= int(4+cItems*592) {
			// Parse FileGroupDescriptorW (MS-RDPECLIP 2.2.5.2.3.1)
			// Each FILEDESCRIPTORW: 592 bytes. Offsets:
			//   0:flags  36:fileAttributes  64:sizeHigh  68:sizeLow  72:fileName(520)
			h.serverFiles = make([]ClipFile, 0, cItems)
			offset := 4
			for i := uint32(0); i < cItems; i++ {
				if offset+592 > len(body) {
					break
				}
				fd := body[offset : offset+592]
				flags := binary.LittleEndian.Uint32(fd[0:4])
				fileAttr := binary.LittleEndian.Uint32(fd[36:40])
				sizeHigh := binary.LittleEndian.Uint32(fd[64:68])
				sizeLow := binary.LittleEndian.Uint32(fd[68:72])
				nameBytes := fd[72:592]
				name := decodeUTF16LE(nameBytes)
				name = strings.TrimRight(name, "\x00")

				size := uint64(sizeHigh)<<32 | uint64(sizeLow)
				isDir := flags&FD_ATTRIBUTES != 0 && fileAttr&FILE_ATTRIBUTE_DIRECTORY != 0

				slog.Debug("cliprdr: server file", "name", name, "size", size, "isDir", isDir)
				h.serverFiles = append(h.serverFiles, ClipFile{Name: name, Size: size})
				offset += 592
			}

			if h.onRemoteFilesAvailable != nil && len(h.serverFiles) > 0 {
				h.onRemoteFilesAvailable(h.serverFiles)
			}
		} else {
			slog.Warn("cliprdr: FileGroupDescriptorW body too small", "cItems", cItems, "bodyLen", len(body))
		}
		h.fgdFormatId = 0
		return
	}

	// Text response
	text := decodeUTF16LE(body)
	text = strings.TrimRight(text, "\x00")

	if text != "" && h.onRemoteClipboardChanged != nil {
		slog.Debug("cliprdr: received text", "len", len(text))
		h.suppressNextLocalChange = true
		h.onRemoteClipboardChanged(text)
	}
}

// --- File Contents Request / Response (MS-RDPECLIP 2.2.5.3) ---------------

// processFileContentsRequest handles the server asking for file data (client→server).
func (h *CliprdrHandler) processFileContentsRequest(body []byte) {
	if len(body) < 24 {
		// Can't even parse streamId — send bare FAIL.
		h.sendPDU(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_FAIL, nil)
		return
	}
	streamId := binary.LittleEndian.Uint32(body[0:4])
	lindex := binary.LittleEndian.Uint32(body[4:8])
	dwFlags := binary.LittleEndian.Uint32(body[8:12])
	posLow := binary.LittleEndian.Uint32(body[12:16])
	posHigh := binary.LittleEndian.Uint32(body[16:20])
	cbRequested := binary.LittleEndian.Uint32(body[20:24])

	slog.Debug("cliprdr: FileContentsRequest", "streamId", streamId, "lindex", lindex, "flags", dwFlags, "pos", uint64(posHigh)<<32|uint64(posLow), "cbReq", cbRequested)

	// Helper: send FAIL with streamId so Windows can match the response.
	failResp := func() {
		fb := &bytes.Buffer{}
		binary.Write(fb, binary.LittleEndian, streamId)
		h.sendPDU(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_FAIL, fb.Bytes())
	}

	resp := &bytes.Buffer{}
	binary.Write(resp, binary.LittleEndian, streamId)

	if dwFlags == FILECONTENTS_SIZE {
		if h.getLocalFiles != nil {
			files := h.getLocalFiles()
			if int(lindex) < len(files) {
				binary.Write(resp, binary.LittleEndian, uint32(files[lindex].Size))
				binary.Write(resp, binary.LittleEndian, uint32(files[lindex].Size>>32))
				h.sendPDU(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_OK, resp.Bytes())
				return
			}
		}
		failResp()
	} else if dwFlags == FILECONTENTS_RANGE {
		offset := uint64(posHigh)<<32 | uint64(posLow)
		if h.getLocalFileData != nil {
			data := h.getLocalFileData(int(lindex), offset, cbRequested)
			if data != nil {
				resp.Write(data)
				h.sendPDU(CB_FILECONTENTS_RESPONSE, CB_RESPONSE_OK, resp.Bytes())
				return
			}
		}
		failResp()
	} else {
		failResp()
	}
}

// processFileContentsResponse handles server sending file data to us (server→client download).
func (h *CliprdrHandler) processFileContentsResponse(body []byte, msgFlags uint16) {
	if msgFlags&CB_RESPONSE_OK == 0 || len(body) < 4 {
		slog.Warn("cliprdr: FileContents Response FAIL")
		select {
		case h.fileDownloadCh <- nil:
		default:
		}
		return
	}
	// body: streamId(4) + data
	data := make([]byte, len(body)-4)
	copy(data, body[4:])
	select {
	case h.fileDownloadCh <- data:
	default:
		slog.Warn("cliprdr: fileDownloadCh full, dropping response")
	}
}

// DownloadServerFile requests file data from server and returns it synchronously.
// This blocks until the server responds. Index is into h.serverFiles.
func (h *CliprdrHandler) DownloadServerFile(index int) []byte {
	if index < 0 || index >= len(h.serverFiles) {
		return nil
	}
	f := h.serverFiles[index]
	if f.Size == 0 {
		return []byte{}
	}

	// Request FILECONTENTS_RANGE for the whole file
	b := &bytes.Buffer{}
	binary.Write(b, binary.LittleEndian, uint32(1))              // streamId
	binary.Write(b, binary.LittleEndian, uint32(index))           // lindex
	binary.Write(b, binary.LittleEndian, uint32(FILECONTENTS_RANGE))
	binary.Write(b, binary.LittleEndian, uint32(0))               // posLow
	binary.Write(b, binary.LittleEndian, uint32(0))               // posHigh
	cbReq := f.Size
	if cbReq > 64*1024*1024 {
		cbReq = 64 * 1024 * 1024 // cap at 64MB per request
	}
	binary.Write(b, binary.LittleEndian, uint32(cbReq))
	// clipDataId is only present when server advertised CB_CAN_LOCK_CLIPDATA.
	// Sending it unconditionally adds 4 extra bytes that some Windows builds
	// may misparse as the start of the next PDU.
	if h.canLockClipData {
		binary.Write(b, binary.LittleEndian, uint32(0))
	}
	h.sendPDU(CB_FILECONTENTS_REQUEST, 0, b.Bytes())

	// Wait for response
	data := <-h.fileDownloadCh
	return data
}

// GetServerFiles returns the list of files the server advertised.
func (h *CliprdrHandler) GetServerFiles() []ClipFile {
	return h.serverFiles
}

// SendLocalFilesFormatList sends a FORMAT_LIST advertising FileGroupDescriptorW
// so the server knows we have files to paste. Call after setting local files.
func (h *CliprdrHandler) SendLocalFilesFormatList() {
	if h.getLocalFiles == nil {
		return
	}
	files := h.getLocalFiles()
	if len(files) == 0 {
		h.sendFormatList() // revert to text-only
		return
	}

	// Use formatId 0xC0E0/0xC0E1 for our custom formats. These are in the
	// RegisterClipboardFormat range (0xC000-0xFFFF). The exact value doesn't
	// matter as long as it's unique within this FORMAT_LIST; the server
	// identifies the format by its name string, not the numeric ID.
	const localFGDId = uint32(0xC0E0)
	const localFCId = uint32(0xC0E1)
	h.localFGDFormatId = localFGDId
	h.localFCFormatId = localFCId

	b := &bytes.Buffer{}
	if h.useLongFormatNames {
		// CF_UNICODETEXT (standard format, empty name)
		binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
		b.Write([]byte{0, 0}) // null-terminated empty name

		// FileGroupDescriptorW
		binary.Write(b, binary.LittleEndian, localFGDId)
		b.Write(encodeUTF16LE("FileGroupDescriptorW")) // encodeUTF16LE appends null

		// FileContents
		binary.Write(b, binary.LittleEndian, localFCId)
		b.Write(encodeUTF16LE("FileContents"))
	} else {
		// Short format names (32 bytes fixed)
		binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
		b.Write(make([]byte, 32))
	}
	h.sendPDU(CB_FORMAT_LIST, 0, b.Bytes())
}

// processFormatDataRequest handles FORMAT_DATA_REQUEST for FileGroupDescriptorW.
// (overrides the text-only version when files are present)
func (h *CliprdrHandler) handleFormatDataRequestFiles(requestedFormat uint32) bool {
	if (requestedFormat != h.localFGDFormatId && requestedFormat != 0xC0E0) || h.getLocalFiles == nil {
		return false
	}
	files := h.getLocalFiles()
	if len(files) == 0 {
		return false
	}

	// Build FileGroupDescriptorW (MS-RDPECLIP 2.2.5.2.3.1)
	// Each FILEDESCRIPTORW is exactly 592 bytes:
	//   flags(4) + reserved(32) + fileAttributes(4) + reserved(16) +
	//   lastWriteTime(8) + fileSizeHigh(4) + fileSizeLow(4) + fileName(520)
	fgd := &bytes.Buffer{}
	binary.Write(fgd, binary.LittleEndian, uint32(len(files))) // cItems
	for _, f := range files {
		fd := make([]byte, 592)
		// flags: FD_FILESIZE | FD_ATTRIBUTES
		binary.LittleEndian.PutUint32(fd[0:4], FD_FILESIZE|FD_ATTRIBUTES)
		// offset 36: fileAttributes
		binary.LittleEndian.PutUint32(fd[36:40], 0x00000080) // FILE_ATTRIBUTE_NORMAL
		// offset 64: fileSizeHigh, offset 68: fileSizeLow
		binary.LittleEndian.PutUint32(fd[64:68], uint32(f.Size>>32))
		binary.LittleEndian.PutUint32(fd[68:72], uint32(f.Size))
		// offset 72: fileName (520 bytes = 260 UTF-16LE chars, null-terminated)
		nameBytes := encodeUTF16LE(f.Name)
		if len(nameBytes) > 518 { // 520 - 2 for null
			nameBytes = nameBytes[:518]
		}
		copy(fd[72:], nameBytes)
		fgd.Write(fd)
	}

	h.sendPDU(CB_FORMAT_DATA_RESPONSE, CB_RESPONSE_OK, fgd.Bytes())
	return true
}

// --- Public API for local clipboard changes --------------------------------

// OnLocalClipboardChanged notifies the server that the local clipboard
// content has changed.  Call this from the UI when the system clipboard
// changes (e.g. via polling or a platform clipboard-change signal).
func (h *CliprdrHandler) OnLocalClipboardChanged() {
	if h.suppressNextLocalChange {
		h.suppressNextLocalChange = false
		return
	}
	if h.channelSender != nil {
		h.sendFormatList()
		slog.Debug("cliprdr: local clipboard changed, sent Format List")
	}
}

// --- Send helpers ----------------------------------------------------------

func (h *CliprdrHandler) sendPDU(msgType, msgFlags uint16, body []byte) {
	if h.channelSender == nil {
		return
	}
	sendClipPDU(h.channelSender, msgType, msgFlags, body)
}

// --- UTF-16LE helpers ------------------------------------------------------

func decodeUTF16LE(b []byte) string {
	if len(b) < 2 {
		return ""
	}
	// Trim to even length
	if len(b)%2 != 0 {
		b = b[:len(b)-1]
	}
	u16 := make([]uint16, len(b)/2)
	for i := range u16 {
		u16[i] = binary.LittleEndian.Uint16(b[i*2:])
	}
	return string(utf16.Decode(u16))
}

func encodeUTF16LE(s string) []byte {
	runes := []rune(s)
	u16 := utf16.Encode(runes)
	b := make([]byte, len(u16)*2)
	for i, v := range u16 {
		binary.LittleEndian.PutUint16(b[i*2:], v)
	}
	return b
}
