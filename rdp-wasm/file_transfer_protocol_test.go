//go:build js && wasm

package main

import (
	"bytes"
	"testing"
)

func TestZft2FrameRoundTrip(t *testing.T) {
	input := zft2Frame{
		Type: zft2Write, Flags: zft2FlagResponse, RequestID: 0xfeedbeef,
		Meta:    map[string]any{"handle": "h1", "offset": float64(4294967296)},
		Payload: []byte{0, 1, 2, 253, 254, 255},
	}
	raw, err := encodeZft2Frame(input)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeZft2Frame(raw)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Type != input.Type || decoded.Flags != input.Flags || decoded.RequestID != input.RequestID {
		t.Fatalf("header mismatch: %#v", decoded)
	}
	if stringMeta(decoded.Meta, "handle") != "h1" || int64Meta(decoded.Meta, "offset") != 4294967296 {
		t.Fatalf("metadata mismatch: %#v", decoded.Meta)
	}
	if !bytes.Equal(decoded.Payload, input.Payload) {
		t.Fatalf("payload mismatch: %v", decoded.Payload)
	}
}

func TestZft2RejectsMalformedFrames(t *testing.T) {
	cases := [][]byte{nil, make([]byte, 19), append([]byte("BAD!"), make([]byte, 16)...)}
	for i, raw := range cases {
		if _, err := decodeZft2Frame(raw); err == nil {
			t.Fatalf("case %d should fail", i)
		}
	}
	valid, err := encodeZft2Frame(zft2Frame{Type: zft2Read, RequestID: 1})
	if err != nil {
		t.Fatal(err)
	}
	valid[19] = 1
	if _, err := decodeZft2Frame(valid); err == nil {
		t.Fatal("length mismatch should fail")
	}
}

func TestZft2PayloadLimit(t *testing.T) {
	_, err := encodeZft2Frame(zft2Frame{Type: zft2Write, RequestID: 1, Payload: make([]byte, zft2MaxPayloadBytes+1)})
	if err == nil {
		t.Fatal("oversized payload should fail")
	}
}
