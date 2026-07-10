//go:build !darwin || !cgo

package aac

import (
	"errors"

	"github.com/nakagami/grdp/plugin/rdpsnd"
)

// stubDecoder is used on platforms without AudioToolbox support.
type stubDecoder struct{}

func newDecoder(_ rdpsnd.AudioFormat) (Decoder, error) {
	return nil, errors.New("AAC decoding not supported on this platform")
}

func (d *stubDecoder) Decode(_ []byte) ([]byte, error) {
	return nil, errors.New("AAC decoding not supported on this platform")
}

func (d *stubDecoder) Close() {}
