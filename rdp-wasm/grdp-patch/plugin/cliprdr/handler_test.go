// handler_test.go - tests for CliprdrHandler clipboard fixes
package cliprdr

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"
	"unicode/utf16"
)

// TestEncodeUTF16LENullTerminator verifies that encodeUTF16LE appends a
// UTF-16LE null terminator (0x0000).  Without it, Windows may read past
// the end of CF_UNICODETEXT data or reject the paste.
func TestEncodeUTF16LENullTerminator(t *testing.T) {
	tests := []string{
		"",
		"A",
		"Hello",
		"你好世界",
		"Mixed ABC 中文 🎉",
	}
	for _, s := range tests {
		b := encodeUTF16LE(s)
		if len(b) < 2 {
			t.Errorf("encodeUTF16LE(%q): output too short (%d bytes)", s, len(b))
			continue
		}
		// Last 2 bytes must be 0x00 0x00 (null terminator)
		if b[len(b)-2] != 0 || b[len(b)-1] != 0 {
			t.Errorf("encodeUTF16LE(%q): missing null terminator, last 2 bytes = %x %x",
				s, b[len(b)-2], b[len(b)-1])
		}
		// Verify all UTF-16 code units before the terminator, including surrogate
		// pairs for non-BMP code points such as emoji.
		expectedU16 := utf16.Encode([]rune(s))
		if len(b) != (len(expectedU16)+1)*2 {
			t.Errorf("encodeUTF16LE(%q): expected %d bytes, got %d", s, (len(expectedU16)+1)*2, len(b))
			continue
		}
		for i, v := range expectedU16 {
			got := binary.LittleEndian.Uint16(b[i*2:])
			if got != v {
				t.Errorf("encodeUTF16LE(%q): byte %d expected %x got %x", s, i, v, got)
			}
		}
	}
}

// TestEncodeUTF16LEEmptyString verifies that even an empty string gets a
// null terminator (2 zero bytes).
func TestEncodeUTF16LEEmptyString(t *testing.T) {
	b := encodeUTF16LE("")
	if len(b) != 2 {
		t.Errorf("encodeUTF16LE(\"\"): expected 2 bytes (null terminator), got %d", len(b))
	}
	if b[0] != 0 || b[1] != 0 {
		t.Errorf("encodeUTF16LE(\"\"): expected [0x00 0x00], got [%x %x]", b[0], b[1])
	}
}

// TestSuppressCountDecrement verifies that the suppress counter correctly
// absorbs local clipboard change notifications that result from remote->local
// propagation, preventing feedback loops.
func TestSuppressCountDecrement(t *testing.T) {
	h := &CliprdrHandler{
		fileDownloadCh:   make(chan []byte, 4),
		clipboardReadyCh: make(chan struct{}, 1),
	}

	// Simulate remote->local propagation: increment suppress count
	h.suppressMu.Lock()
	h.suppressCount++
	h.suppressMu.Unlock()

	// OnLocalClipboardChanged should be suppressed (no-op)
	suppressed := false
	h.channelSender = nil // ensure sendFormatList would panic if called
	h.OnLocalClipboardChanged()
	// If we reach here without panic, suppression worked
	suppressed = true

	if !suppressed {
		t.Error("OnLocalClipboardChanged should have been suppressed")
	}

	// Verify counter was decremented
	h.suppressMu.Lock()
	if h.suppressCount != 0 {
		t.Errorf("suppressCount should be 0 after one decrement, got %d", h.suppressCount)
	}
	h.suppressMu.Unlock()
}

// TestClipboardReadySignal verifies that signalClipboardReady and
// WaitForClipboardReady work together for the sendTextViaClipboard
// synchronization path.
func TestClipboardReadySignal(t *testing.T) {
	h := &CliprdrHandler{
		fileDownloadCh:   make(chan []byte, 4),
		clipboardReadyCh: make(chan struct{}, 1),
	}

	// Signal ready in a goroutine
	go func() {
		time.Sleep(10 * time.Millisecond)
		h.signalClipboardReady()
	}()

	ready := h.WaitForClipboardReady(1 * time.Second)
	if !ready {
		t.Error("WaitForClipboardReady should return true after signalClipboardReady")
	}
}

// TestClipboardReadyTimeout verifies that WaitForClipboardReady returns
// false on timeout.
func TestClipboardReadyTimeout(t *testing.T) {
	h := &CliprdrHandler{
		fileDownloadCh:   make(chan []byte, 4),
		clipboardReadyCh: make(chan struct{}, 1),
	}

	ready := h.WaitForClipboardReady(50 * time.Millisecond)
	if ready {
		t.Error("WaitForClipboardReady should return false on timeout")
	}
}

// TestSendFormatListIncludesFileFormats verifies that sendFormatList
// includes FileGroupDescriptorW format when local files are available.
func TestSendFormatListIncludesFileFormats(t *testing.T) {
	h := &CliprdrHandler{
		fileDownloadCh:     make(chan []byte, 4),
		clipboardReadyCh:   make(chan struct{}, 1),
		useLongFormatNames: true,
		localFGDFormatId:   0xC0E0,
		localFCFormatId:    0xC0E1,
		getLocalFiles: func() []ClipFile {
			return []ClipFile{{Name: "test.txt", Size: 100}}
		},
	}

	// Capture the PDU that would be sent
	var sentPDU []byte
	h.channelSender = &testSender{onSend: func(data []byte) {
		sentPDU = make([]byte, len(data))
		copy(sentPDU, data)
	}}

	h.sendFormatList()

	if len(sentPDU) < 8 {
		t.Fatal("sendFormatList produced no output")
	}

	// Parse the FORMAT_LIST PDU
	// Header: msgType(2) + msgFlags(2) + dataLen(4) = 8 bytes
	body := sentPDU[8:]

	// Should contain at least 3 format entries:
	// 1. CF_UNICODETEXT (formatId=13, empty name)
	// 2. FileGroupDescriptorW (formatId=0xC0E0)
	// 3. FileContents (formatId=0xC0E1)
	foundUnicodeText := false
	foundFGD := false
	foundFC := false

	offset := 0
	for offset+4 <= len(body) {
		fmtId := binary.LittleEndian.Uint32(body[offset:])
		offset += 4

		// Read null-terminated UTF-16LE name
		nameEnd := offset
		for nameEnd+1 < len(body) {
			if body[nameEnd] == 0 && body[nameEnd+1] == 0 {
				break
			}
			nameEnd += 2
		}
		name := decodeUTF16LE(body[offset:nameEnd])
		offset = nameEnd + 2

		if fmtId == CF_UNICODETEXT {
			foundUnicodeText = true
		}
		if name == "FileGroupDescriptorW" {
			foundFGD = true
		}
		if name == "FileContents" {
			foundFC = true
		}
	}

	if !foundUnicodeText {
		t.Error("FORMAT_LIST should contain CF_UNICODETEXT")
	}
	if !foundFGD {
		t.Error("FORMAT_LIST should contain FileGroupDescriptorW when files are available")
	}
	if !foundFC {
		t.Error("FORMAT_LIST should contain FileContents when files are available")
	}
}

// testSender implements core.ChannelSender for testing
type testSender struct {
	onSend func([]byte)
}

func (ts *testSender) SendToChannel(name string, data []byte) (int, error) {
	if ts.onSend != nil {
		ts.onSend(data)
	}
	return len(data), nil
}

// Ensure testSender satisfies the interface by having bytes import used
var _ = bytes.MinRead
