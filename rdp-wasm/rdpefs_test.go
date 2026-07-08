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
	if got := binary.LittleEndian.Uint16(capsResp[12:14]); got != CAP_GENERAL_TYPE {
		t.Fatalf("capset type = %d, want CAP_GENERAL_TYPE", got)
	}
	if got := binary.LittleEndian.Uint16(capsResp[14:16]); got != 44 {
		t.Fatalf("general CapabilityLength = %d, want 44", got)
	}
	if got := binary.LittleEndian.Uint32(capsResp[16:20]); got != 1 {
		t.Fatalf("general Version = %d, want legacy Version=1", got)
	}
	// Existing wire bytes include osType=2 and protocolMinorVersion=12.
	if got := binary.LittleEndian.Uint32(capsResp[20:24]); got != 2 {
		t.Fatalf("osType = %d, want legacy osType=2", got)
	}
	if got := binary.LittleEndian.Uint16(capsResp[30:32]); got != 12 {
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
