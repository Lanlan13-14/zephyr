package rdpgfx

import "bytes"

// ScanResult holds the IDR-presence flag and SPS/PPS NAL boundaries (offsets
// into the original packet, including Annex B start code) discovered during a
// single linear walk of an Annex B H.264 packet.
type ScanResult struct {
	HasKeyFrame      bool
	SPSStart, SPSEnd int
	PPSStart, PPSEnd int
}

// ScanH264Packet walks an Annex B H.264 packet exactly once, returning
// whether it contains any IDR slice (NAL type 5) or SPS (NAL type 7) NAL
// unit and recording the byte ranges for the most recent SPS/PPS NALs found.
func ScanH264Packet(data []byte) ScanResult {
	var r ScanResult
	startCode := []byte{0, 0, 1}
	pos := 0
	for pos < len(data) {
		off := bytes.Index(data[pos:], startCode)
		if off < 0 {
			break
		}
		i := pos + off
		scLen := 3
		if i > 0 && data[i-1] == 0 {
			i--
			scLen = 4
		}
		if i+scLen >= len(data) {
			break
		}
		nalType := data[i+scLen] & 0x1F
		if nalType == 5 || nalType == 7 {
			r.HasKeyFrame = true
		}
		if nalType == 7 || nalType == 8 {
			searchFrom := i + scLen + 1
			j := len(data)
			if searchFrom < len(data) {
				if next := bytes.Index(data[searchFrom:], startCode); next >= 0 {
					j = searchFrom + next
					if j > 0 && data[j-1] == 0 {
						j--
					}
				}
			}
			if nalType == 7 {
				r.SPSStart, r.SPSEnd = i, j
			} else {
				r.PPSStart, r.PPSEnd = i, j
			}
			pos = j
			continue
		}
		pos = i + scLen + 1
	}
	return r
}

// h264PacketHasIDR reports whether an Annex B H.264 packet contains an IDR
// (keyframe) NAL unit.
func h264PacketHasIDR(data []byte) bool {
	return ScanH264Packet(data).HasKeyFrame
}
