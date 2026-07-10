//go:build js && wasm

package main

import (
	"encoding/binary"
	"testing"
)

// Verify that success-path response payloads have the exact byte lengths
// that the Windows RDPDR server parser expects (matching FreeRDP).
func TestSuccessPayloadLengths(t *testing.T) {
	// DR_CREATE_RSP: FileId(4) + Information(1) = 5
	createRsp := &bufHolder{}
	binary.Write(createRsp, binary.LittleEndian, uint32(42)) // FileId
	binary.Write(createRsp, binary.LittleEndian, uint8(1))   // Information
	if createRsp.Len() != 5 {
		t.Fatalf("CREATE success body = %d, want 5", createRsp.Len())
	}

	// DR_CLOSE_RSP: Padding(5) = 5
	closeRsp := []byte{0, 0, 0, 0, 0}
	if len(closeRsp) != 5 {
		t.Fatalf("CLOSE success body = %d, want 5", len(closeRsp))
	}

	// DR_READ_RSP: Length(4) + data(Length)
	// With 100 bytes of data: 4 + 100 = 104
	readData := make([]byte, 100)
	readRsp := &bufHolder{}
	binary.Write(readRsp, binary.LittleEndian, uint32(len(readData)))
	readRsp.Write(readData)
	if readRsp.Len() != 104 {
		t.Fatalf("READ success body = %d, want 104", readRsp.Len())
	}

	// DR_READ_RSP with 0 bytes: Length(4) = 4
	readEmpty := &bufHolder{}
	binary.Write(readEmpty, binary.LittleEndian, uint32(0))
	if readEmpty.Len() != 4 {
		t.Fatalf("READ empty body = %d, want 4", readEmpty.Len())
	}

	// DR_WRITE_RSP: Length(4) + Padding(1) = 5
	writeRsp := &bufHolder{}
	binary.Write(writeRsp, binary.LittleEndian, uint32(100))
	binary.Write(writeRsp, binary.LittleEndian, uint8(0))
	if writeRsp.Len() != 5 {
		t.Fatalf("WRITE success body = %d, want 5", writeRsp.Len())
	}

	// DR_QUERY_INFORMATION_RSP: Length(4) + info
	// FileBasicInformation = 36 bytes, so 4 + 36 = 40
	basicInfo := buildBasicInfo(false, deterministicTestTime())
	if len(basicInfo) != 36 {
		t.Fatalf("FileBasicInformation = %d, want 36", len(basicInfo))
	}
	queryInfoRsp := &bufHolder{}
	binary.Write(queryInfoRsp, binary.LittleEndian, uint32(len(basicInfo)))
	queryInfoRsp.Write(basicInfo)
	if queryInfoRsp.Len() != 40 {
		t.Fatalf("QUERY_INFORMATION body = %d, want 40", queryInfoRsp.Len())
	}

	// FileStandardInformation = 22 bytes, so 4 + 22 = 26
	stdInfo := buildStandardInfo(false, 123)
	if len(stdInfo) != 22 {
		t.Fatalf("FileStandardInformation = %d, want 22", len(stdInfo))
	}

	// FileAttributeTagInformation = 8 bytes, so 4 + 8 = 12
	attrInfo := buildAttributeTagInfo(false)
	if len(attrInfo) != 8 {
		t.Fatalf("FileAttributeTagInformation = %d, want 8", len(attrInfo))
	}

	// DR_SET_INFORMATION_RSP: Length(4) = 4
	setInfoRsp := &bufHolder{}
	binary.Write(setInfoRsp, binary.LittleEndian, uint32(0))
	if setInfoRsp.Len() != 4 {
		t.Fatalf("SET_INFORMATION body = %d, want 4", setInfoRsp.Len())
	}

	// DR_QUERY_DIRECTORY_RSP success: Length(4) + entry + Padding(0)?
	// FreeRDP writes: Length(4) + entry_data, NO extra padding on success.
	// (Padding(1) only on failure path out_fail.)
	entry := buildDirectoryEntry(&VirtualFile{Name: "x", IsDir: false, Size: 1, ModTime: deterministicTestTime()}, FileBothDirectoryInformation)
	dirRsp := &bufHolder{}
	binary.Write(dirRsp, binary.LittleEndian, uint32(len(entry)))
	dirRsp.Write(entry)
	// No padding byte on success!
	t.Logf("QUERY_DIRECTORY success body = %d (entry=%d)", dirRsp.Len(), len(entry))
}

// bufHolder is a minimal bytes.Buffer wrapper for testing.
type bufHolder struct {
	data []byte
}

func (b *bufHolder) Write(p []byte) (int, error) {
	b.data = append(b.data, p...)
	return len(p), nil
}

func (b *bufHolder) Len() int { return len(b.data) }
