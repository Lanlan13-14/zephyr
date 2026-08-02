package rdpedisp

import (
	"encoding/binary"
	"testing"
)

func TestSendMonitorLayoutReportsChannelReadiness(t *testing.T) {
	h := NewHandler(0, 0)
	monitor := Monitor{Flags: MonitorFlagPrimary, Width: 1920, Height: 1080, DesktopScaleFactor: 100, DeviceScaleFactor: 100}
	if h.SendMonitorLayout([]Monitor{monitor}) {
		t.Fatal("closed display channel must reject the layout")
	}

	var sent []byte
	h.SetSendFunc(func(data []byte) { sent = append([]byte(nil), data...) })
	if !h.SendMonitorLayout([]Monitor{monitor}) {
		t.Fatal("open display channel must accept the layout")
	}
	if len(sent) != 56 {
		t.Fatalf("unexpected monitor layout length: %d", len(sent))
	}
	if got := binary.LittleEndian.Uint32(sent[0:4]); got != pduTypeMonitorLayout {
		t.Fatalf("unexpected PDU type: %d", got)
	}
	if got := binary.LittleEndian.Uint32(sent[12:16]); got != 1 {
		t.Fatalf("unexpected monitor count: %d", got)
	}
	if got := binary.LittleEndian.Uint32(sent[28:32]); got != 1920 {
		t.Fatalf("unexpected monitor width: %d", got)
	}
	if got := binary.LittleEndian.Uint32(sent[32:36]); got != 1080 {
		t.Fatalf("unexpected monitor height: %d", got)
	}
}
