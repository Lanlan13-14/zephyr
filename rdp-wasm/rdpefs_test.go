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
	binary.LittleEndian.PutUint16(announce[0:2], RDPDR_VERSION_MAJOR)
	binary.LittleEndian.PutUint16(announce[2:4], RDPDR_VERSION_MINOR_RDP10X)
	binary.LittleEndian.PutUint32(announce[4:8], 0x11223344)
	h.processServerAnnounce(announce)

	if len(sent) != 2 {
		t.Fatalf("server announce should send client confirm + name, got %d packets", len(sent))
	}
	confirm := sent[0]
	if got := binary.LittleEndian.Uint16(confirm[4:6]); got != RDPDR_VERSION_MAJOR {
		t.Fatalf("client confirm major = %#x", got)
	}
	if got := binary.LittleEndian.Uint16(confirm[6:8]); got != RDPDR_VERSION_MINOR_RDP10X {
		t.Fatalf("client confirm minor = %#x", got)
	}
	if got := binary.LittleEndian.Uint32(confirm[8:12]); got != 0x11223344 {
		t.Fatalf("client confirm clientID = %#x", got)
	}

	sent = nil
	h.processServerCapability(nil)
	if len(sent) != 1 {
		t.Fatalf("capability response packets = %d, want 1", len(sent))
	}
	cap := sent[0]
	if len(cap) != 60 {
		t.Fatalf("capability response length = %d, want 60", len(cap))
	}
	if got := binary.LittleEndian.Uint16(cap[4:6]); got != 2 {
		t.Fatalf("capability count = %d, want 2", got)
	}
	if got := binary.LittleEndian.Uint16(cap[8:10]); got != CAP_GENERAL_TYPE {
		t.Fatalf("first capability type = %#x", got)
	}
	if got := binary.LittleEndian.Uint16(cap[10:12]); got != 44 {
		t.Fatalf("general capability length = %d", got)
	}
	if got := binary.LittleEndian.Uint16(cap[52:54]); got != CAP_DRIVE_TYPE {
		t.Fatalf("second capability type = %#x, want drive", got)
	}
	if got := binary.LittleEndian.Uint16(cap[54:56]); got != 8 {
		t.Fatalf("drive capability length = %d", got)
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

func deterministicTestTime() time.Time {
	return time.Unix(1700000000, 0).UTC()
}
