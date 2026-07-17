package rdpgfx

import (
	"encoding/binary"
	"testing"
)

func TestExportedZGFXSingleUncompressed(t *testing.T) {
	d := NewZGFXDecoder()
	out, err := d.Decompress([]byte{0xE0, 0x04, 'a', 'b', 'c'})
	if err != nil || string(out) != "abc" {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

func TestExportedZGFXMultipartUncompressed(t *testing.T) {
	data := []byte{0xE1, 2, 0, 6, 0, 0, 0}
	for _, p := range [][]byte{{0x04, 'a', 'b', 'c'}, {0x04, 'd', 'e', 'f'}} {
		var n [4]byte
		binary.LittleEndian.PutUint32(n[:], uint32(len(p)))
		data = append(data, n[:]...)
		data = append(data, p...)
	}
	d := NewZGFXDecoder()
	out, err := d.Decompress(data)
	if err != nil || string(out) != "abcdef" {
		t.Fatalf("out=%q err=%v", out, err)
	}
}

func TestExportedZGFXRejectsMultipartLengthMismatch(t *testing.T) {
	d := NewZGFXDecoder()
	_, err := d.Decompress([]byte{0xE1, 1, 0, 9, 0, 0, 0, 2, 0, 0, 0, 0x04, 'x'})
	if err == nil {
		t.Fatal("accepted bad uncompressed size")
	}
}
