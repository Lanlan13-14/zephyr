package core

// MppcDecompressor maintains per-connection state for RDP MPPC-64K bulk
// decompression (MS-RDPBCGR §3.1.8.4.1).  A single instance is shared
// between the fast-path and slow-path receivers of one RDP connection.
type MppcDecompressor struct {
	history [mppcHistorySize]byte
	offset  int
}

const mppcHistorySize = 65536

// mppc flag bits (mirror the constants in protocol/pdu/data.go so the core
// package has no import dependency on pdu).
const (
	mppcBig        = 0x01 // RDP_MPPC_BIG  – 64 K dictionary
	mppcCompressed = 0x20 // RDP_MPPC_COMPRESSED
	mppcReset      = 0x40 // RDP_MPPC_RESET  – compressor is at front of buffer
	mppcFlushed    = 0x80 // RDP_MPPC_FLUSH  – compressor history flushed
)

func NewMppcDecompressor() *MppcDecompressor {
	return &MppcDecompressor{}
}

// Decompress processes one MPPC block.
//
// flags is the CompressedType byte (slow-path) or compressionFlags byte
// (fast-path); it carries the RDP_MPPC_* bit flags.
//
// When RDP_MPPC_COMPRESSED is not set the payload is uncompressed; the data
// is returned as-is but the history buffer is still updated so future
// compressed blocks can reference it.
func (d *MppcDecompressor) Decompress(flags byte, data []byte) ([]byte, error) {
	if flags&mppcFlushed != 0 {
		d.history = [mppcHistorySize]byte{}
		d.offset = 0
	} else if flags&mppcReset != 0 {
		d.offset = 0
	}

	if flags&mppcCompressed == 0 {
		// Uncompressed: update history, return data unchanged.
		for _, b := range data {
			d.history[d.offset] = b
			d.offset = (d.offset + 1) & (mppcHistorySize - 1)
		}
		return data, nil
	}

	output := make([]byte, 0, len(data)*3)
	br := newMppcBitReader(data)

	// A literal token is 9 bits (1 disc + 8 data).  Refuse to start a new
	// token if fewer than 9 bits remain – those bits are end-of-stream padding.
outer:
	for br.bitsLeft >= 9 {
		if br.readBit() == 0 {
			// Literal byte
			b := byte(br.readBits(8))
			output = append(output, b)
			d.history[d.offset] = b
			d.offset = (d.offset + 1) & (mppcHistorySize - 1)
		} else {
			// Copy tuple: 2-bit offset discriminator
			sel := (br.readBit() << 1) | br.readBit()
			var copyOffset int
			switch sel {
			case 0: // 00 + 6 bits → offset 0..63
				if br.bitsLeft < 6 {
					break outer
				}
				copyOffset = br.readBits(6)
			case 1: // 01 + 8 bits → offset 64..319
				if br.bitsLeft < 8 {
					break outer
				}
				copyOffset = 64 + br.readBits(8)
			case 2: // 10 + 13 bits → offset 320..8511
				if br.bitsLeft < 13 {
					break outer
				}
				copyOffset = 320 + br.readBits(13)
			case 3: // 11 + 16 bits → offset 8192..73727
				if br.bitsLeft < 16 {
					break outer
				}
				copyOffset = 8192 + br.readBits(16)
			}

			// Copy length: unary code – count leading 1-bits then add 3.
			// A 0-bit terminates the count; minimum length is 3 (code "0").
			copyLength := 3
			for br.bitsLeft > 0 {
				if br.readBit() == 0 {
					break
				}
				copyLength++
			}

			// Resolve copy source in the circular history buffer.
			src := (d.offset - copyOffset - 1 + mppcHistorySize) & (mppcHistorySize - 1)
			for i := 0; i < copyLength; i++ {
				b := d.history[(src+i)&(mppcHistorySize-1)]
				output = append(output, b)
				d.history[d.offset] = b
				d.offset = (d.offset + 1) & (mppcHistorySize - 1)
			}
		}
	}

	return output, nil
}

// mppcBitReader reads bits MSB-first from a byte slice.
type mppcBitReader struct {
	data     []byte
	byteIdx  int
	mask     byte // bit mask within current byte; starts at 0x80
	bitsLeft int  // total bits remaining (for padding detection)
}

func newMppcBitReader(data []byte) *mppcBitReader {
	return &mppcBitReader{
		data:     data,
		mask:     0x80,
		bitsLeft: len(data) * 8,
	}
}

func (r *mppcBitReader) readBit() int {
	if r.bitsLeft == 0 {
		return 0
	}
	r.bitsLeft--
	var bit int
	if r.data[r.byteIdx]&r.mask != 0 {
		bit = 1
	}
	r.mask >>= 1
	if r.mask == 0 {
		r.mask = 0x80
		r.byteIdx++
	}
	return bit
}

func (r *mppcBitReader) readBits(n int) int {
	result := 0
	for i := 0; i < n; i++ {
		result = (result << 1) | r.readBit()
	}
	return result
}
