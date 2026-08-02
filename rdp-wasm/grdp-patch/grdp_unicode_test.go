package grdp

import (
	"testing"

	"github.com/nakagami/grdp/protocol/pdu"
)

func TestUnicodeInputEventsPreserveUTF16UnitsAndReleaseOrder(t *testing.T) {
	// U+1F600 is encoded by SendUnicodeText as D83D DE00.
	units := []uint16{0x4E2D, 0xD83D, 0xDE00}
	events := unicodeInputEvents(units)
	if len(events) != len(units)*2 {
		t.Fatalf("got %d events, want %d", len(events), len(units)*2)
	}
	for index, unit := range units {
		down, ok := events[index*2].(*pdu.UnicodeKeyEvent)
		if !ok || down.Unicode != unit || down.KeyboardFlags != 0 {
			t.Fatalf("unit %d key-down = %#v", index, events[index*2])
		}
		up, ok := events[index*2+1].(*pdu.UnicodeKeyEvent)
		if !ok || up.Unicode != unit || up.KeyboardFlags&pdu.KBDFLAGS_RELEASE == 0 {
			t.Fatalf("unit %d key-up = %#v", index, events[index*2+1])
		}
	}
}

func TestUnicodeFastPathBatchLimit(t *testing.T) {
	if got := len(unicodeInputEvents(make([]uint16, maxUnicodeCodeUnitsPerBatch))); got > 15 {
		t.Fatalf("unicode batch has %d events; Fast-Path accepts at most 15", got)
	}
}
