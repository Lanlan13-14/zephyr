package link

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"testing"
)

func maskedFrame(fin bool, opcode byte, payload []byte) []byte {
	first := opcode
	if fin {
		first |= 0x80
	}
	mask := [4]byte{1, 2, 3, 4}
	out := []byte{first}
	if len(payload) < 126 {
		out = append(out, 0x80|byte(len(payload)))
	} else {
		out = append(out, 0x80|126, byte(len(payload)>>8), byte(len(payload)))
	}
	out = append(out, mask[:]...)
	for i, b := range payload {
		out = append(out, b^mask[i%4])
	}
	return out
}

func TestReadFrameRejectsInvalidRFC6455Frames(t *testing.T) {
	tests := []struct {
		name  string
		frame []byte
	}{
		{"unmasked", []byte{0x81, 0x00}},
		{"rsv1", append([]byte{0xC1, 0x80, 1, 2, 3, 4}, 0)},
		{"fragmented", maskedFrame(false, 0x1, []byte("x"))},
		{"fragmented ping", maskedFrame(false, 0x9, nil)},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := readClientFrame(bufio.NewReader(bytes.NewReader(tc.frame))); err == nil {
				t.Fatal("invalid frame accepted")
			}
		})
	}
}

func TestReadFrameAcceptsMaskedPayload(t *testing.T) {
	frame := maskedFrame(true, 0x1, []byte("hello"))
	op, got, err := readClientFrame(bufio.NewReader(bytes.NewReader(frame)))
	if err != nil {
		t.Fatal(err)
	}
	if op != 1 || string(got) != "hello" {
		t.Fatalf("got opcode=%d payload=%q", op, got)
	}
}

func TestReadFrameRejectsHighBit64BitLength(t *testing.T) {
	var b bytes.Buffer
	b.Write([]byte{0x82, 0xFF})
	b.Write(make([]byte, 8))
	binary.BigEndian.PutUint64(b.Bytes()[2:], 1<<63)
	if _, _, err := readClientFrame(bufio.NewReader(&b)); err == nil {
		t.Fatal("invalid 64-bit length accepted")
	}
}
