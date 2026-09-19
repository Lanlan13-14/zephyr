package protocol

import (
	"bytes"
	"io"
	"testing"
)

func TestFrameRoundtrip(t *testing.T) {
	cases := []Frame{
		{Type: FrameExecReq, Payload: []byte(`{"cmd":"echo hello"}`)},
		{Type: FrameExecLine, Payload: []byte("hello world")},
		{Type: FrameExecResult, Payload: []byte(`{"exit_code":0}`)},
		{Type: FramePing, Payload: nil},
		{Type: FramePong, Payload: nil},
		{Type: FrameError, Payload: []byte("something went wrong")},
		{Type: FramePTYIn, Payload: []byte("ls\n")},
		{Type: FramePTYOut, Payload: []byte("file1  file2\r\n")},
		{Type: FramePTYResize, Payload: []byte(`{"rows":24,"cols":80}`)},
		{Type: FrameFSReq, Payload: []byte(`{"op":"read","path":"/cell/workspace/data.csv"}`)},
		{Type: FrameFSResp, Payload: []byte(`{"ok":true}`)},
		{Type: FrameOffloadReq, Payload: []byte(`{"command":"zc-calendar"}`)},
		{Type: FrameOffloadResp, Payload: []byte(`{"exit_code":0,"stdout":"done"}`)},
		{Type: FrameMetrics, Payload: []byte(`{"cpu_cumulative_ms":1234}`)},
		{Type: FrameAuditPull, Payload: []byte(`{"since":"2026-01-01T00:00:00Z"}`)},
		{Type: FrameAuditData, Payload: []byte(`[{"ts":"2026-01-01T00:00:01Z"}]`)},
		{Type: FrameAttach, Payload: []byte(`{"session_id":"abc-123"}`)},
		{Type: FrameDetach, Payload: nil},
		{Type: FrameReset, Payload: []byte(`{"session_id":"abc-123"}`)},
		{Type: FrameResetResult, Payload: []byte(`{"ok":true}`)},
	}

	for _, tc := range cases {
		t.Run(tc.Type.String(), func(t *testing.T) {
			var buf bytes.Buffer
			if err := Encode(&buf, tc); err != nil {
				t.Fatalf("Encode: %v", err)
			}

			got, err := Decode(&buf)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}

			if got.Type != tc.Type {
				t.Errorf("type: want %s, got %s", tc.Type, got.Type)
			}
			if !bytes.Equal(got.Payload, tc.Payload) {
				t.Errorf("payload: want %q, got %q", tc.Payload, got.Payload)
			}
		})
	}
}

func TestFrameRoundtrip_EmptyPayload(t *testing.T) {
	var buf bytes.Buffer
	f := Frame{Type: FramePing, Payload: nil}
	if err := Encode(&buf, f); err != nil {
		t.Fatalf("Encode: %v", err)
	}
	// Should be exactly 5 bytes: 4 for length (0) + 1 for type
	if buf.Len() != headerSize {
		t.Errorf("empty frame: want %d bytes, got %d", headerSize, buf.Len())
	}
	got, err := Decode(&buf)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if got.Type != FramePing {
		t.Errorf("type: want PING, got %s", got.Type)
	}
	if len(got.Payload) != 0 {
		t.Errorf("payload: want empty, got %d bytes", len(got.Payload))
	}
}

func TestFrameRoundtrip_MultipleFrames(t *testing.T) {
	var buf bytes.Buffer
	frames := []Frame{
		NewPing(),
		{Type: FrameExecReq, Payload: []byte("cmd1")},
		{Type: FrameExecLine, Payload: []byte("output line")},
		{Type: FrameExecResult, Payload: []byte("done")},
		NewPong(),
	}
	for _, f := range frames {
		if err := Encode(&buf, f); err != nil {
			t.Fatalf("Encode: %v", err)
		}
	}
	for i, expected := range frames {
		got, err := Decode(&buf)
		if err != nil {
			t.Fatalf("Decode frame %d: %v", i, err)
		}
		if got.Type != expected.Type {
			t.Errorf("frame %d: type want %s, got %s", i, expected.Type, got.Type)
		}
		if !bytes.Equal(got.Payload, expected.Payload) {
			t.Errorf("frame %d: payload mismatch", i)
		}
	}
	// Next decode should EOF
	_, err := Decode(&buf)
	if err != io.EOF {
		t.Errorf("expected EOF after all frames, got %v", err)
	}
}

func TestDecode_TooLargeFrame(t *testing.T) {
	var buf bytes.Buffer
	// Write a header claiming 5MB payload
	header := [headerSize]byte{}
	header[0] = 0x00
	header[1] = 0x50 // ~5MB
	header[2] = 0x00
	header[3] = 0x00
	header[4] = byte(FrameExecReq)
	buf.Write(header[:])

	_, err := Decode(&buf)
	if err == nil {
		t.Fatal("expected error for oversized frame")
	}
}

func TestDecode_UnknownFrameType(t *testing.T) {
	var buf bytes.Buffer
	header := [headerSize]byte{}
	// length = 0
	header[4] = 0xAA // unknown type
	buf.Write(header[:])

	_, err := Decode(&buf)
	if err == nil {
		t.Fatal("expected error for unknown frame type")
	}
}

func TestEncode_TooLargePayload(t *testing.T) {
	var buf bytes.Buffer
	f := Frame{Type: FrameExecReq, Payload: make([]byte, MaxPayloadSize+1)}
	err := Encode(&buf, f)
	if err == nil {
		t.Fatal("expected error for oversized payload")
	}
}

func TestFrameType_String(t *testing.T) {
	cases := map[FrameType]string{
		FrameExecReq:     "EXEC_REQ",
		FrameExecLine:    "EXEC_LINE",
		FrameExecResult:  "EXEC_RESULT",
		FramePTYIn:       "PTY_IN",
		FramePTYOut:      "PTY_OUT",
		FramePTYResize:   "PTY_RESIZE",
		FramePTYOpen:     "PTY_OPEN",
		FramePTYClose:    "PTY_CLOSE",
		FrameFSReq:       "FS_REQ",
		FrameFSResp:      "FS_RESP",
		FrameFSChunk:     "FS_CHUNK",
		FrameOffloadReq:  "OFFLOAD_REQ",
		FrameOffloadResp: "OFFLOAD_RESP",
		FrameMetrics:     "METRICS",
		FrameAuditPull:   "AUDIT_PULL",
		FrameAuditData:   "AUDIT_DATA",
		FrameAttach:      "ATTACH",
		FrameDetach:      "DETACH",
		FrameReset:       "RESET",
		FrameResetResult: "RESET_RESULT",
		FramePing:        "PING",
		FramePong:        "PONG",
		FrameError:       "ERROR",
	}
	for ft, name := range cases {
		if ft.String() != name {
			t.Errorf("FrameType 0x%02x: want %s, got %s", byte(ft), name, ft.String())
		}
	}
}

func TestFrameType_IsValid(t *testing.T) {
	valid := []FrameType{
		FrameExecReq, FrameExecLine, FrameExecResult,
		FramePTYIn, FramePTYOut, FramePTYResize, FramePTYOpen, FramePTYClose,
		FrameFSReq, FrameFSResp, FrameFSChunk,
		FrameOffloadReq, FrameOffloadResp,
		FrameMetrics, FrameAuditPull, FrameAuditData,
		FrameAttach, FrameDetach, FrameReset, FrameResetResult,
		FramePing, FramePong,
		FrameError,
	}
	for _, ft := range valid {
		if !ft.IsValid() {
			t.Errorf("FrameType 0x%02x should be valid", byte(ft))
		}
	}
	invalid := []FrameType{0x00, 0x04, 0x15, 0x25, 0x35, 0x45, 0x55, 0xAA, 0xFE}
	for _, ft := range invalid {
		if ft.IsValid() {
			t.Errorf("FrameType 0x%02x should not be valid", byte(ft))
		}
	}
}
