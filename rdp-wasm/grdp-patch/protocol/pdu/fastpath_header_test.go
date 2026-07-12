package pdu

import "testing"

func TestDecodeFastPathUpdateHeaderCompressed(t *testing.T) {
	// updateCode=BITMAP(1), fragmentation=FIRST(2), compression=USED(2)
	header := byte(FASTPATH_UPDATETYPE_BITMAP) | byte(FASTPATH_FRAGMENT_FIRST) | byte(FASTPATH_OUTPUT_COMPRESSION_USED<<6)
	code, fragmentation, compression := decodeFastPathUpdateHeader(header)
	if code != FASTPATH_UPDATETYPE_BITMAP {
		t.Fatalf("code=%x", code)
	}
	if fragmentation != FASTPATH_FRAGMENT_FIRST {
		t.Fatalf("fragmentation=%x", fragmentation)
	}
	if compression != FASTPATH_OUTPUT_COMPRESSION_USED {
		t.Fatalf("compression=%x", compression)
	}
}

func TestDecodeFastPathUpdateHeaderUncompressedSingle(t *testing.T) {
	header := byte(FASTPATH_UPDATETYPE_SURFCMDS) | byte(FASTPATH_FRAGMENT_SINGLE)
	code, fragmentation, compression := decodeFastPathUpdateHeader(header)
	if code != FASTPATH_UPDATETYPE_SURFCMDS || fragmentation != FASTPATH_FRAGMENT_SINGLE || compression != 0 {
		t.Fatalf("code=%x fragmentation=%x compression=%x", code, fragmentation, compression)
	}
}

func TestCompressionMaskRegression(t *testing.T) {
	header := byte(FASTPATH_UPDATETYPE_BITMAP) | byte(FASTPATH_OUTPUT_COMPRESSION_USED<<6)
	if header&0xC0 == FASTPATH_OUTPUT_COMPRESSION_USED {
		t.Fatal("regression fixture invalid: shifted mask unexpectedly equals unshifted constant")
	}
	_, _, compression := decodeFastPathUpdateHeader(header)
	if compression != FASTPATH_OUTPUT_COMPRESSION_USED {
		t.Fatalf("compression flag lost: %x", compression)
	}
}
