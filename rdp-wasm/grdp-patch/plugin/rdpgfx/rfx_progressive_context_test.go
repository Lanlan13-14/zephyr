package rdpgfx

import "testing"

func TestProgressiveContextFlagsOffset(t *testing.T) {
	d := newRfxProgressiveDecoder()
	payload := pdContextBlock(rfxSubbandDiffing)
	d.Decode(payload, nil, 0, 0)
	if d.contextFlags != rfxSubbandDiffing {
		t.Fatalf("contextFlags=%#x want %#x", d.contextFlags, rfxSubbandDiffing)
	}
}
