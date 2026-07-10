package grdp

import (
	"testing"

	"github.com/nakagami/grdp/protocol/pdu"
)

func TestEncodeWheelPointerFlags(t *testing.T) {
	tests := []struct {
		name     string
		axis     uint16
		rotation int
		want     uint16
	}{
		{"vertical positive", pdu.PTRFLAGS_WHEEL, 120, 0x0278},
		{"vertical negative", pdu.PTRFLAGS_WHEEL, -120, 0x0388},
		{"horizontal positive", pdu.PTRFLAGS_HWHEEL, 120, 0x0478},
		{"horizontal negative", pdu.PTRFLAGS_HWHEEL, -120, 0x0588},
		{"positive clamp", pdu.PTRFLAGS_HWHEEL, 999, 0x04FF},
		{"negative clamp", pdu.PTRFLAGS_HWHEEL, -999, 0x0501},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := encodeWheelPointerFlags(tt.axis, tt.rotation); got != tt.want {
				t.Fatalf("encodeWheelPointerFlags(%#x, %d) = %#x, want %#x", tt.axis, tt.rotation, got, tt.want)
			}
		})
	}
}
