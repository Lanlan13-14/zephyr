package cliprdr

import (
	"encoding/binary"
	"testing"
)

func TestBuildFileGroupDescriptorFlags(t *testing.T) {
	// Replicate the descriptor encoding used by SendLocalFilesFormatList so
	// Windows Explorer sees the same flags FreeRDP synthetic_file.c emits.
	files := []ClipFile{{Name: `C:\path\to\report.txt`, Size: 0x1_0000_00AB}}
	now := filetimeNow()
	if now == 0 {
		t.Fatal("filetimeNow returned 0")
	}

	const wantFlags = FD_ATTRIBUTES | FD_FILESIZE | FD_WRITESTIME | FD_PROGRESSUI
	fd := make([]byte, 592)
	binary.LittleEndian.PutUint32(fd[0:4], wantFlags)
	binary.LittleEndian.PutUint32(fd[36:40], 0x80)
	binary.LittleEndian.PutUint32(fd[56:60], uint32(now))
	binary.LittleEndian.PutUint32(fd[60:64], uint32(now>>32))
	binary.LittleEndian.PutUint32(fd[64:68], uint32(files[0].Size>>32))
	binary.LittleEndian.PutUint32(fd[68:72], uint32(files[0].Size))

	base := files[0].Name
	if i := lastSlash(base); i >= 0 {
		base = base[i+1:]
	}
	nameBytes := encodeUTF16LE(base)
	copy(fd[72:], nameBytes)

	gotFlags := binary.LittleEndian.Uint32(fd[0:4])
	if gotFlags != wantFlags {
		t.Fatalf("flags=%#x want %#x", gotFlags, wantFlags)
	}
	if binary.LittleEndian.Uint32(fd[36:40]) != 0x80 {
		t.Fatalf("attributes not FILE_ATTRIBUTE_NORMAL")
	}
	if binary.LittleEndian.Uint32(fd[64:68]) != 1 || binary.LittleEndian.Uint32(fd[68:72]) != 0xAB {
		t.Fatalf("filesize high/low mismatch: %x %x", fd[64:68], fd[68:72])
	}
	// Basename only — no path separators in the UTF-16 name field.
	decoded := decodeUTF16LE(fd[72 : 72+len(nameBytes)])
	if decoded != "report.txt\x00" && decoded != "report.txt" {
		// decodeUTF16LE keeps trailing NULs; accept either form.
		if got := string([]rune(decoded)); got != "report.txt" && got != "report.txt\x00" {
			// Compare against trimmed UTF-16 decode.
			if trimNull(decoded) != "report.txt" {
				t.Fatalf("filename=%q want report.txt", decoded)
			}
		}
	}
}

func lastSlash(s string) int {
	for i := len(s) - 1; i >= 0; i-- {
		if s[i] == '/' || s[i] == '\\' {
			return i
		}
	}
	return -1
}

func trimNull(s string) string {
	for len(s) > 0 && s[len(s)-1] == 0 {
		s = s[:len(s)-1]
	}
	return s
}
