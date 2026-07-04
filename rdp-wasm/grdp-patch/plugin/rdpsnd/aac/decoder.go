// Package aac provides AAC-to-PCM decoding for RDPSND audio streams.
package aac

import "github.com/nakagami/grdp/plugin/rdpsnd"

// Decoder decodes MPEG-4 AAC packets into signed 16-bit little-endian PCM.
type Decoder interface {
	// Decode decodes one raw AAC packet.  Returns nil, nil for empty input.
	Decode(data []byte) ([]byte, error)
	// Close releases all resources held by the decoder.
	Close()
}

// New creates a Decoder for the given RDPSND AudioFormat.
// Returns an error on platforms where AAC decoding is not supported.
func New(format rdpsnd.AudioFormat) (Decoder, error) {
	return newDecoder(format)
}
