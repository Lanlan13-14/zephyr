//go:build js && wasm

package main

import (
	"bytes"
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

// TestCapabilityResponseStructure verifies the Client Core Capability
// Response mirrors back the capability types the server announced.
// Windows' RDPDR server parser rejects a mismatched Version/CapabilityLength
// (e.g. Version=1 with a 36-byte body), and sending an unannounced capset
// type (e.g. CAP_DRIVE_TYPE when the server didn't announce it) can cause
// the server to tear down the RDPDR channel entirely.
func TestCapabilityResponseStructure(t *testing.T) {
	storageGetFiles := js.FuncOf(func(this js.Value, args []js.Value) any {
		return js.Null()
	})
	defer storageGetFiles.Release()
	js.Global().Set("rdpStorageGetFiles", storageGetFiles)

	// Simulate a server capability request with General + Drive capsets.
	// Layout: numCapabilities(2) + pad(2) + [capType(2)+capLen(2)+version(4)+body]
	serverCaps := &bytes.Buffer{}
	binary.Write(serverCaps, binary.LittleEndian, uint16(2)) // numCapabilities
	binary.Write(serverCaps, binary.LittleEndian, uint16(0)) // padding
	// General capset (server side): type=1, len=44, ver=2, 36-byte body
	binary.Write(serverCaps, binary.LittleEndian, uint16(CAP_GENERAL_TYPE))
	binary.Write(serverCaps, binary.LittleEndian, uint16(44))
	binary.Write(serverCaps, binary.LittleEndian, uint32(GENERAL_CAPABILITY_VERSION_02))
	serverCaps.Write(make([]byte, 36)) // body (zeros)
	// Drive capset (server side): type=4, len=8, ver=2, no body
	binary.Write(serverCaps, binary.LittleEndian, uint16(CAP_DRIVE_TYPE))
	binary.Write(serverCaps, binary.LittleEndian, uint16(8))
	binary.Write(serverCaps, binary.LittleEndian, uint32(DRIVE_CAPABILITY_VERSION_02))

	h := NewRdpefsHandler(true)
	var sent [][]byte
	h.sender = func(_ string, data []byte) (int, error) {
		cp := append([]byte(nil), data...)
		sent = append(sent, cp)
		return len(data), nil
	}

	h.processServerCapability(serverCaps.Bytes())

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

	// numCapabilities must be 2 (General + Drive) since server announced both
	numCaps := binary.LittleEndian.Uint16(capsResp[8:10])
	if numCaps != 2 {
		t.Fatalf("numCapabilities = %d, want 2 (General + Drive)", numCaps)
	}

	off := 12 // after header(4) + numCaps(2) + pad(2)
	genType := binary.LittleEndian.Uint16(capsResp[off : off+2])
	genLen := binary.LittleEndian.Uint16(capsResp[off+2 : off+4])
	genVer := binary.LittleEndian.Uint32(capsResp[off+4 : off+8])
	if genType != CAP_GENERAL_TYPE {
		t.Fatalf("first cap type = %d, want CAP_GENERAL_TYPE=%d", genType, CAP_GENERAL_TYPE)
	}
	if genLen != 44 {
		t.Fatalf("general CapabilityLength = %d, want 44", genLen)
	}
	if genVer != GENERAL_CAPABILITY_VERSION_02 {
		t.Fatalf("general Version = %d, want GENERAL_CAPABILITY_VERSION_02=%d", genVer, GENERAL_CAPABILITY_VERSION_02)
	}
	genBodyEnd := off + 8 + 36
	if genBodyEnd > len(capsResp) {
		t.Fatalf("general caps body extends past packet: end=%d, pktLen=%d", genBodyEnd, len(capsResp))
	}

	drvType := binary.LittleEndian.Uint16(capsResp[genBodyEnd : genBodyEnd+2])
	drvLen := binary.LittleEndian.Uint16(capsResp[genBodyEnd+2 : genBodyEnd+4])
	drvVer := binary.LittleEndian.Uint32(capsResp[genBodyEnd+4 : genBodyEnd+8])
	if drvType != CAP_DRIVE_TYPE {
		t.Fatalf("second cap type = %d, want CAP_DRIVE_TYPE=%d", drvType, CAP_DRIVE_TYPE)
	}
	if drvLen != 8 {
		t.Fatalf("drive CapabilityLength = %d, want 8 (header only, no body)", drvLen)
	}
	if drvVer != DRIVE_CAPABILITY_VERSION_02 {
		t.Fatalf("drive Version = %d, want DRIVE_CAPABILITY_VERSION_02=%d", drvVer, DRIVE_CAPABILITY_VERSION_02)
	}
}

// TestCapabilityResponseNoDriveCapset verifies that when the server does NOT
// announce CAP_DRIVE_TYPE, we don't send it back.  Sending an unannounced
// capset can cause the server to reject the capability response and tear
// down the RDPDR channel, which prevents device announcement entirely.
func TestCapabilityResponseNoDriveCapset(t *testing.T) {
	storageGetFiles := js.FuncOf(func(this js.Value, args []js.Value) any {
		return js.Null()
	})
	defer storageGetFiles.Release()
	js.Global().Set("rdpStorageGetFiles", storageGetFiles)

	// Server announces ONLY General capset (no Drive)
	serverCaps := &bytes.Buffer{}
	binary.Write(serverCaps, binary.LittleEndian, uint16(1)) // numCapabilities
	binary.Write(serverCaps, binary.LittleEndian, uint16(0)) // padding
	binary.Write(serverCaps, binary.LittleEndian, uint16(CAP_GENERAL_TYPE))
	binary.Write(serverCaps, binary.LittleEndian, uint16(44))
	binary.Write(serverCaps, binary.LittleEndian, uint32(GENERAL_CAPABILITY_VERSION_02))
	serverCaps.Write(make([]byte, 36))

	h := NewRdpefsHandler(true)
	var sent [][]byte
	h.sender = func(_ string, data []byte) (int, error) {
		cp := append([]byte(nil), data...)
		sent = append(sent, cp)
		return len(data), nil
	}

	h.processServerCapability(serverCaps.Bytes())

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

	numCaps := binary.LittleEndian.Uint16(capsResp[8:10])
	if numCaps != 1 {
		t.Fatalf("numCapabilities = %d, want 1 (General only, server didn't announce Drive)", numCaps)
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

func deterministicTestTime() time.Time {
	return time.Unix(1700000000, 0).UTC()
}
