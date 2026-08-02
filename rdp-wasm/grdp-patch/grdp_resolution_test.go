package grdp

import (
	"encoding/binary"
	"testing"
	"time"

	"github.com/nakagami/grdp/plugin/rdpedisp"
)

func TestSetResolutionRejectsInvalidDimensionsBeforeEncoding(t *testing.T) {
	handler := rdpedisp.NewHandler(0, 0)
	sent := 0
	handler.SetSendFunc(func([]byte) { sent++ })
	client := &RdpClient{dispHandler: handler}

	for _, size := range [][2]int{{0, 1080}, {1920, 0}, {-1, 1080}, {1920, -1}} {
		if client.SetResolution(size[0], size[1]) {
			t.Fatalf("invalid resolution %dx%d was accepted", size[0], size[1])
		}
	}
	if sent != 0 {
		t.Fatalf("invalid resolutions emitted %d monitor layouts", sent)
	}
}

func TestVORRejectionDebouncesFallbackRefresh(t *testing.T) {
	events := make(chan string, 8)
	client := &RdpClient{protocolObserver: func(event string) { events <- event }}
	client.observeDvcProtocol("drdynvc.reject:Microsoft::Windows::RDS::Video::Control::v08.01:status0xc0000225")
	client.observeDvcProtocol("drdynvc.reject:Microsoft::Windows::RDS::Geometry::v08.01:status0xc0000225")
	client.observeDvcProtocol("drdynvc.reject:Microsoft::Windows::RDS::Video::Data::v08.01:status0xc0000225")

	deadline := time.After(time.Second)
	refreshes := 0
	for refreshes == 0 {
		select {
		case event := <-events:
			if event == "rdpgfx.vor-fallback.refresh" {
				refreshes++
			}
		case <-deadline:
			t.Fatal("timed out waiting for debounced VOR fallback refresh")
		}
	}
	select {
	case event := <-events:
		if event == "rdpgfx.vor-fallback.refresh" {
			t.Fatal("VOR fallback refresh was not debounced")
		}
	case <-time.After(650 * time.Millisecond):
	}
}

func TestSetResolutionNormalizesAndCommitsAcceptedSize(t *testing.T) {
	handler := rdpedisp.NewHandler(0, 0)
	var pdu []byte
	handler.SetSendFunc(func(data []byte) { pdu = append([]byte(nil), data...) })
	client := &RdpClient{dispHandler: handler}

	if !client.SetResolution(1919, 100) {
		t.Fatal("open display channel rejected a valid resolution")
	}
	if client.width != 1920 || client.height != 200 {
		t.Fatalf("committed size = %dx%d, want 1920x200", client.width, client.height)
	}
	if got := binary.LittleEndian.Uint32(pdu[28:32]); got != 1920 {
		t.Fatalf("encoded width = %d, want 1920", got)
	}
	if got := binary.LittleEndian.Uint32(pdu[32:36]); got != 200 {
		t.Fatalf("encoded height = %d, want 200", got)
	}
}
