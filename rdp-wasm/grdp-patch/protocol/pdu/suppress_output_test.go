package pdu

import (
	"testing"

	"github.com/lunixbochs/struc"
)

func TestSuppressOutputUsesProtocolConditionalLength(t *testing.T) {
	suppressLen, err := struc.Sizeof(&SuppressOutputPDU{})
	if err != nil {
		t.Fatal(err)
	}
	allowLen, err := struc.Sizeof(&AllowOutputPDU{})
	if err != nil {
		t.Fatal(err)
	}
	if suppressLen != 4 {
		t.Fatalf("SUPPRESS_DISPLAY_UPDATES payload length = %d, want 4", suppressLen)
	}
	if allowLen != 12 {
		t.Fatalf("ALLOW_DISPLAY_UPDATES payload length = %d, want 12", allowLen)
	}
}
