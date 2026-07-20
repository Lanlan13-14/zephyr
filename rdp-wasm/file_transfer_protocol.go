//go:build js && wasm

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

const (
	zft2Version         = 2
	zft2HeaderBytes     = 20
	zft2FlagError       = 0x0001
	zft2FlagResponse    = 0x0002
	zft2MaxMetaBytes    = 256 * 1024
	zft2MaxPayloadBytes = 1024 * 1024
)

const (
	zft2Open     byte = 0x01
	zft2Read     byte = 0x02
	zft2Write    byte = 0x03
	zft2Close    byte = 0x04
	zft2Stat     byte = 0x05
	zft2List     byte = 0x06
	zft2Mkdir    byte = 0x07
	zft2Delete   byte = 0x08
	zft2Rename   byte = 0x09
	zft2Truncate byte = 0x0a
	zft2Cancel   byte = 0x0b
	zft2Ping     byte = 0x0c
)

type zft2Frame struct {
	Type      byte
	Flags     uint16
	RequestID uint32
	Meta      map[string]any
	Payload   []byte
}

type zft2Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *zft2Error) Error() string {
	if e == nil {
		return "file transfer failed"
	}
	return e.Message
}

func encodeZft2Frame(frame zft2Frame) ([]byte, error) {
	meta := frame.Meta
	if meta == nil {
		meta = map[string]any{}
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return nil, fmt.Errorf("encode ZFT2 metadata: %w", err)
	}
	if len(metaBytes) > zft2MaxMetaBytes {
		return nil, errors.New("ZFT2 metadata exceeds limit")
	}
	if len(frame.Payload) > zft2MaxPayloadBytes {
		return nil, errors.New("ZFT2 payload exceeds limit")
	}
	out := make([]byte, zft2HeaderBytes+len(metaBytes)+len(frame.Payload))
	copy(out[:4], []byte("ZFT2"))
	out[4] = zft2Version
	out[5] = frame.Type
	binary.BigEndian.PutUint16(out[6:8], frame.Flags)
	binary.BigEndian.PutUint32(out[8:12], frame.RequestID)
	binary.BigEndian.PutUint32(out[12:16], uint32(len(metaBytes)))
	binary.BigEndian.PutUint32(out[16:20], uint32(len(frame.Payload)))
	copy(out[zft2HeaderBytes:], metaBytes)
	copy(out[zft2HeaderBytes+len(metaBytes):], frame.Payload)
	return out, nil
}

func decodeZft2Frame(raw []byte) (zft2Frame, error) {
	if len(raw) < zft2HeaderBytes {
		return zft2Frame{}, errors.New("truncated ZFT2 header")
	}
	if string(raw[:4]) != "ZFT2" {
		return zft2Frame{}, errors.New("invalid ZFT2 magic")
	}
	if raw[4] != zft2Version {
		return zft2Frame{}, fmt.Errorf("unsupported ZFT2 version %d", raw[4])
	}
	metaLen := int(binary.BigEndian.Uint32(raw[12:16]))
	payloadLen := int(binary.BigEndian.Uint32(raw[16:20]))
	if metaLen > zft2MaxMetaBytes || payloadLen > zft2MaxPayloadBytes {
		return zft2Frame{}, errors.New("ZFT2 frame exceeds limit")
	}
	if len(raw) != zft2HeaderBytes+metaLen+payloadLen {
		return zft2Frame{}, errors.New("ZFT2 frame length mismatch")
	}
	meta := map[string]any{}
	if metaLen > 0 {
		if err := json.Unmarshal(raw[zft2HeaderBytes:zft2HeaderBytes+metaLen], &meta); err != nil {
			return zft2Frame{}, fmt.Errorf("invalid ZFT2 metadata: %w", err)
		}
	}
	payload := append([]byte(nil), raw[zft2HeaderBytes+metaLen:]...)
	return zft2Frame{
		Type: raw[5], Flags: binary.BigEndian.Uint16(raw[6:8]),
		RequestID: binary.BigEndian.Uint32(raw[8:12]), Meta: meta, Payload: payload,
	}, nil
}

type fileTransferResponse struct {
	Meta    map[string]any
	Payload []byte
}

type fileTransfer interface {
	Request(agentID string, op byte, meta map[string]any, payload []byte) (fileTransferResponse, error)
	CloseAgent(agentID string)
	Close()
}
