//go:build js && wasm

package main

import (
	"encoding/binary"
	"syscall/js"
	"testing"
	"time"
)

func TestBuildBasicInfoLengths(t *testing.T) {
	if got := len(buildBasicInfo(false, deterministicTestTime())); got != 36 {
		t.Fatalf("FileBasicInformation length = %d, want 36", got)
	}
	if got := len(buildStandardInfo(false, 123)); got != 22 {
		t.Fatalf("FileStandardInformation length = %d, want 22", got)
	}
	if got := len(buildAttributeTagInfo(false)); got != 8 {
		t.Fatalf("FileAttributeTagInformation length = %d, want 8", got)
	}
	if got := len(buildNetworkOpenInfo(false, 123, deterministicTestTime())); got != 56 {
		t.Fatalf("FileNetworkOpenInformation length = %d, want 56", got)
	}
	if got := len(buildNameInfo("a.txt")); got != 4+len(encodeUTF16LENoNull("a.txt")) {
		t.Fatalf("FileNameInformation length = %d", got)
	}
	if got := len(buildAllInfo(false, 123, deterministicTestTime(), "a.txt")); got != 94+len(encodeUTF16LENoNull("a.txt")) {
		t.Fatalf("FileAllInformation length = %d", got)
	}
}

func TestBuildDirectoryEntryLengths(t *testing.T) {
	f := &VirtualFile{Name: "A.txt", IsDir: false, Size: 7, ModTime: deterministicTestTime()}
	nameLen := len(encodeUTF16LENoNull(f.Name))
	cases := []struct {
		class uint32
		want  int
	}{
		{FileNamesInformation, 12 + nameLen},
		{FileDirectoryInformation, 64 + nameLen},
		{FileFullDirectoryInformation, 68 + nameLen},
		{FileBothDirectoryInformation, 93 + nameLen},
	}
	for _, tc := range cases {
		got := buildDirectoryEntry(f, tc.class)
		if len(got) != tc.want {
			t.Fatalf("class %d entry length = %d, want %d", tc.class, len(got), tc.want)
		}
		if binary.LittleEndian.Uint32(got[:4]) != 0 {
			t.Fatalf("class %d NextEntryOffset should be zero", tc.class)
		}
	}
}

func TestBothDirectoryInformationLayout(t *testing.T) {
	f := &VirtualFile{Name: "abc", IsDir: false, Size: 9, ModTime: deterministicTestTime()}
	entry := buildDirectoryEntry(f, FileBothDirectoryInformation)
	if len(entry) != 93+len(encodeUTF16LENoNull(f.Name)) {
		t.Fatalf("FileBothDirectoryInformation length = %d", len(entry))
	}
	if got := binary.LittleEndian.Uint32(entry[60:64]); got != uint32(len(encodeUTF16LENoNull(f.Name))) {
		t.Fatalf("FileNameLength = %d", got)
	}
	if got := entry[68]; got != 0 {
		t.Fatalf("ShortNameLength = %d, want 0", got)
	}
	nameOffset := 93
	if decoded := decodeUTF16LE(entry[nameOffset:]); decoded != f.Name {
		t.Fatalf("decoded filename = %q, want %q", decoded, f.Name)
	}
}

func TestRdpdrHandshakeCapabilityBytes(t *testing.T) {
	storageGetFiles := js.FuncOf(func(this js.Value, args []js.Value) any {
		return js.Null()
	})
	defer storageGetFiles.Release()
	js.Global().Set("rdpStorageGetFiles", storageGetFiles)

	h := NewRdpefsHandler(true)
	var sent [][]byte
	h.sender = func(_ string, data []byte) (int, error) {
		cp := append([]byte(nil), data...)
		sent = append(sent, cp)
		return len(data), nil
	}

	announce := make([]byte, 8)
	binary.LittleEndian.PutUint16(announce[0:2], 1)
	binary.LittleEndian.PutUint16(announce[2:4], RDPDR_VERSION_MINOR_RDP51)
	binary.LittleEndian.PutUint32(announce[4:8], 0x11223344)
	h.processServerAnnounce(announce)

	if len(sent) != 2 {
		t.Fatalf("server announce should send client confirm + name, got %d packets", len(sent))
	}
	confirm := sent[0]
	// Original working handshake hardcodes version 1.12 in the client confirm.
	if got := binary.LittleEndian.Uint16(confirm[4:6]); got != 1 {
		t.Fatalf("client confirm major = %#x, want 1", got)
	}
	if got := binary.LittleEndian.Uint16(confirm[6:8]); got != 12 {
		t.Fatalf("client confirm minor = %#x, want 12", got)
	}
	if got := binary.LittleEndian.Uint32(confirm[8:12]); got != 0x11223344 {
		t.Fatalf("client confirm clientID = %#x", got)
	}
}

func TestNormalizeDirectoryPattern(t *testing.T) {
	cases := map[string]string{
		"*":             "*",
		"*.*":           "*.*",
		"\\*":           "*",
		"\\folder\\*.*": "*.*",
		"folder/file":   "file",
	}
	for input, want := range cases {
		if got := normalizeDirectoryPattern(input); got != want {
			t.Fatalf("normalizeDirectoryPattern(%q) = %q, want %q", input, got, want)
		}
	}
}

// TestCapabilityResponsePreservesDeviceAnnounceCompatibleBytes locks the
// capability response to the bytes that are known to allow Windows Explorer to
// show the redirected drive for this project.  Do not add Drive capsets or
// change the General capset version here without live-testing device
// announcement first; previous attempts made the drive disappear entirely.
func TestCapabilityResponsePreservesDeviceAnnounceCompatibleBytes(t *testing.T) {
	storageGetFiles := js.FuncOf(func(this js.Value, args []js.Value) any {
		return js.Null()
	})
	defer storageGetFiles.Release()
	js.Global().Set("rdpStorageGetFiles", storageGetFiles)

	h := NewRdpefsHandler(true)
	var sent [][]byte
	h.sender = func(_ string, data []byte) (int, error) {
		cp := append([]byte(nil), data...)
		sent = append(sent, cp)
		return len(data), nil
	}

	h.processServerCapability(nil)

	var capsResp []byte
	for _, pkt := range sent {
		if len(pkt) >= 4 &&
			binary.LittleEndian.Uint16(pkt[0:2]) == RDPDR_CTYP_CORE &&
			binary.LittleEndian.Uint16(pkt[2:4]) == PAKID_CORE_CLIENT_CAPABILITY {
			capsResp = pkt
			break
		}
	}
	if capsResp == nil {
		t.Fatal("no Client Core Capability Response sent")
	}
	if got := len(capsResp); got != 52 {
		t.Fatalf("capability response length = %d, want 52", got)
	}
	if got := binary.LittleEndian.Uint16(capsResp[8:10]); got != 1 {
		t.Fatalf("numCapabilities = %d, want 1", got)
	}
	// RDPDR header is 4 bytes and numCapabilities/padding is another 4;
	// therefore the first capability set starts at byte 8.
	if got := binary.LittleEndian.Uint16(capsResp[8:10]); got != CAP_GENERAL_TYPE {
		t.Fatalf("capset type = %d, want CAP_GENERAL_TYPE", got)
	}
	if got := binary.LittleEndian.Uint16(capsResp[10:12]); got != 44 {
		t.Fatalf("general CapabilityLength = %d, want 44", got)
	}
	if got := binary.LittleEndian.Uint32(capsResp[12:16]); got != 1 {
		t.Fatalf("general Version = %d, want legacy Version=1", got)
	}
	// Existing wire bytes include osType=2 and protocolMinorVersion=12.
	if got := binary.LittleEndian.Uint32(capsResp[16:20]); got != 2 {
		t.Fatalf("osType = %d, want legacy osType=2", got)
	}
	if got := binary.LittleEndian.Uint16(capsResp[26:28]); got != 12 {
		t.Fatalf("protocolMinorVersion = %d, want 12", got)
	}
}

// TestDefaultPayloadForQueryVolume verifies that a failed QUERY_VOLUME IRP
// includes a 4-byte Length=0 payload.  FreeRDP's drive_main.c always writes
// this even on the unhandled/failure path; omitting it desyncs the server's
// RDPDR stream parser by 4 bytes.
func TestDefaultPayloadForQueryVolume(t *testing.T) {
	payload := defaultPayloadFor(IRP_MJ_QUERY_VOLUME)
	if len(payload) != 4 {
		t.Fatalf("QUERY_VOLUME default payload length = %d, want 4", len(payload))
	}
	if binary.LittleEndian.Uint32(payload) != 0 {
		t.Fatalf("QUERY_VOLUME default payload = %d, want 0", binary.LittleEndian.Uint32(payload))
	}
}

func TestCreateDispositionHelpers(t *testing.T) {
	createMissing := []uint32{FILE_SUPERSEDE, FILE_CREATE, FILE_OPEN_IF, FILE_OVERWRITE_IF}
	for _, disp := range createMissing {
		if !createDispositionCanCreateMissing(disp) {
			t.Fatalf("createDispositionCanCreateMissing(%d) = false, want true", disp)
		}
	}
	noCreateMissing := []uint32{FILE_OPEN, FILE_OVERWRITE}
	for _, disp := range noCreateMissing {
		if createDispositionCanCreateMissing(disp) {
			t.Fatalf("createDispositionCanCreateMissing(%d) = true, want false", disp)
		}
	}

	truncates := []uint32{FILE_SUPERSEDE, FILE_OVERWRITE, FILE_OVERWRITE_IF}
	for _, disp := range truncates {
		if !createDispositionTruncatesExisting(disp) {
			t.Fatalf("createDispositionTruncatesExisting(%d) = false, want true", disp)
		}
	}
	nonTruncating := []uint32{FILE_OPEN, FILE_CREATE, FILE_OPEN_IF}
	for _, disp := range nonTruncating {
		if createDispositionTruncatesExisting(disp) {
			t.Fatalf("createDispositionTruncatesExisting(%d) = true, want false", disp)
		}
	}

	if !desiredAccessWantsWrite(GENERIC_WRITE_ACCESS) {
		t.Fatal("desiredAccessWantsWrite(GENERIC_WRITE_ACCESS) = false, want true")
	}
	if desiredAccessWantsWrite(0x80000000) { // GENERIC_READ
		t.Fatal("desiredAccessWantsWrite(GENERIC_READ) = true, want false")
	}
	if !isOfficeVolatilePath("Download/Telegram/~$Akari海外价格表.xlsx") {
		t.Fatal("isOfficeVolatilePath did not detect Office lock file")
	}
	volatileNames := []string{
		"Download/Telegram/.~lock.Akari海外价格表.xlsx#",
		"Download/Telegram/~WRL1234.tmp",
		"Download/Telegram/archive.zip.tmp",
		"Download/Telegram/video.mp4.lock",
		"Download/Telegram/photo.jpg.lck",
		"Download/Telegram/Thumbs.db",
		"Download/Telegram/desktop.ini",
	}
	for _, name := range volatileNames {
		if !isOfficeVolatilePath(name) {
			t.Fatalf("isOfficeVolatilePath(%q) = false, want true", name)
		}
	}
	if isOfficeVolatilePath("Download/Telegram/Akari海外价格表.xlsx") {
		t.Fatal("isOfficeVolatilePath matched normal document")
	}
	if isOfficeVolatilePath("Download/Telegram/archive.zip") {
		t.Fatal("isOfficeVolatilePath matched normal archive")
	}
	if isOfficeVolatilePath("Download/Telegram/video.mp4") {
		t.Fatal("isOfficeVolatilePath matched normal video")
	}
	if got := createResponseInformation(FILE_OPEN_IF, true); got != FILE_OPENED {
		t.Fatalf("createResponseInformation(FILE_OPEN_IF,true) = %d, want FILE_OPENED", got)
	}
	if got := createResponseInformation(FILE_OPEN_IF, false); got != FILE_CREATED {
		t.Fatalf("createResponseInformation(FILE_OPEN_IF,false) = %d, want FILE_CREATED", got)
	}
}

func deterministicTestTime() time.Time {
	return time.Unix(1700000000, 0).UTC()
}

func TestAgentReadIRPDoesNotBlockProtocolLoop(t *testing.T) {
	transfer := &fakeFileTransfer{blocked: make(chan struct{})}
	h := NewRdpefsHandler(true)
	h.SetFileTransfer(transfer)
	h.drives[1] = &DriveState{DeviceID: 1, AgentID: "agent", DriveName: "AGENT", Mode: DriveModeAgent}
	h.handles[1] = &openHandle{DriveDeviceID: 1, AgentID: "agent", Path: "file.bin", RemoteHandle: "handle"}

	request := make([]byte, 20+12)
	binary.LittleEndian.PutUint32(request[0:4], 1)
	binary.LittleEndian.PutUint32(request[4:8], 1)
	binary.LittleEndian.PutUint32(request[8:12], 99)
	binary.LittleEndian.PutUint32(request[12:16], IRP_MJ_READ)
	binary.LittleEndian.PutUint32(request[20:24], 64*1024)

	returned := make(chan struct{})
	go func() { h.processIORequest(request); close(returned) }()
	select {
	case <-returned:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("processIORequest blocked on remote file transfer")
	}
	close(transfer.blocked)
}

func TestAgentReadAheadCacheServesSequentialIRPs(t *testing.T) {
	data := make([]byte, agentReadAheadChunkBytes)
	for i := range data {
		data[i] = byte(i)
	}
	transfer := &recordingFileTransfer{readData: data}
	h := NewRdpefsHandler(true)
	h.SetFileTransfer(transfer)
	handle := &openHandle{AgentID: "agent", Path: "file.bin", RemoteHandle: "handle"}

	first := h.readAgentCached(handle, 0, 64*1024)
	second := h.readAgentCached(handle, 64*1024, 64*1024)
	if len(first) != 64*1024 || len(second) != 64*1024 {
		t.Fatalf("unexpected read lengths %d %d", len(first), len(second))
	}
	if transfer.reads != agentReadAheadParallel {
		t.Fatalf("network reads = %d, want %d", transfer.reads, agentReadAheadParallel)
	}
	if first[1] != 1 || second[1] != 1 {
		t.Fatal("cached data mismatch")
	}
}

func TestRequestAgentRetriesTransientErrors(t *testing.T) {
	transfer := &flakyFileTransfer{failCount: 2, payload: []byte{1, 2, 3}, code: "busy"}
	h := NewRdpefsHandler(true)
	h.SetFileTransfer(transfer)

	resp, err := h.requestAgent("agent", zft2Read, map[string]any{"handle": "h", "offset": 0, "length": 3}, nil)
	if err != nil {
		t.Fatalf("requestAgent after retries: %v", err)
	}
	if string(resp.Payload) != "\x01\x02\x03" {
		t.Fatalf("payload = %v", resp.Payload)
	}
	transfer.mu.Lock()
	attempts := transfer.attempts
	transfer.mu.Unlock()
	if attempts != 3 {
		t.Fatalf("attempts = %d, want 3 (2 fail + 1 success)", attempts)
	}
}

func TestRequestAgentDoesNotRetryPermanentErrors(t *testing.T) {
	transfer := &stickyErrorTransfer{err: &zft2Error{Code: "not_found", Message: "gone", Retryable: false}}
	h := NewRdpefsHandler(true)
	h.SetFileTransfer(transfer)

	_, err := h.requestAgent("agent", zft2Stat, map[string]any{"path": "/x"}, nil)
	if err == nil {
		t.Fatal("expected permanent error")
	}
	if zerr, ok := err.(*zft2Error); !ok || zerr.Code != "not_found" {
		t.Fatalf("err = %v", err)
	}
}

func TestCallAgentStatDistinguishesNotFoundFromTransient(t *testing.T) {
	h := NewRdpefsHandler(true)

	h.SetFileTransfer(&stickyErrorTransfer{err: &zft2Error{Code: "not_found", Message: "gone"}})
	stat, err := h.callAgentStat("agent", "/missing")
	if err != nil || stat != nil {
		t.Fatalf("not_found should be (nil,nil), got (%v,%v)", stat, err)
	}

	h.SetFileTransfer(&stickyErrorTransfer{err: &zft2Error{Code: "timeout", Message: "slow", Retryable: true}})
	// Exhaust retries so requestAgent surfaces the error.
	stat, err = h.callAgentStat("agent", "/flaky")
	if err == nil || stat != nil {
		t.Fatalf("transient should be (nil,err), got (%v,%v)", stat, err)
	}
}
