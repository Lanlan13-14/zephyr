package protocol

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Frame is a single protocol frame (§6.3).
//
// Wire layout (big-endian):
//
//	[4 bytes: payload length (u32)] [1 byte: type] [N bytes: payload]
//
// Total frame size = 5 + len(Payload).
type Frame struct {
	Type    FrameType
	Payload []byte
}

// Header size: 4 bytes length + 1 byte type.
const headerSize = 5

// MaxFrameSize is the maximum total frame size (4 MB, §6.3).
// Frames exceeding this limit must use the FS chunked channel.
const MaxFrameSize = 4 * 1024 * 1024

// MaxPayloadSize is MaxFrameSize minus the header.
const MaxPayloadSize = MaxFrameSize - headerSize

// Encode writes a Frame to the writer in wire format.
func Encode(w io.Writer, f Frame) error {
	if len(f.Payload) > MaxPayloadSize {
		return fmt.Errorf("protocol: payload size %d exceeds max %d", len(f.Payload), MaxPayloadSize)
	}

	var header [headerSize]byte
	binary.BigEndian.PutUint32(header[:4], uint32(len(f.Payload)))
	header[4] = byte(f.Type)

	if _, err := w.Write(header[:]); err != nil {
		return fmt.Errorf("protocol: write header: %w", err)
	}
	if len(f.Payload) > 0 {
		if _, err := w.Write(f.Payload); err != nil {
			return fmt.Errorf("protocol: write payload: %w", err)
		}
	}
	return nil
}

// Decode reads a single Frame from the reader.
func Decode(r io.Reader) (Frame, error) {
	var header [headerSize]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return Frame{}, io.EOF
		}
		return Frame{}, fmt.Errorf("protocol: read header: %w", err)
	}

	length := binary.BigEndian.Uint32(header[:4])
	ft := FrameType(header[4])

	if length > uint32(MaxPayloadSize) {
		return Frame{}, fmt.Errorf("protocol: frame size %d exceeds max %d", length, MaxPayloadSize)
	}

	if !ft.IsValid() {
		return Frame{}, fmt.Errorf("protocol: unknown frame type 0x%02x", byte(ft))
	}

	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			return Frame{}, fmt.Errorf("protocol: read payload: %w", err)
		}
	}

	return Frame{Type: ft, Payload: payload}, nil
}

// NewPing creates a PING frame.
func NewPing() Frame {
	return Frame{Type: FramePing}
}

// NewPong creates a PONG frame.
func NewPong() Frame {
	return Frame{Type: FramePong}
}

// NewError creates an ERROR frame with the given message.
func NewError(msg string) Frame {
	return Frame{Type: FrameError, Payload: []byte(msg)}
}
