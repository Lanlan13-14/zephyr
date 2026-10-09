// Package bidi classifies Unicode scalars and splits a run into directional
// segments.
//
// Classification follows Unicode Bidirectional Algorithm classes, derived from
// unicode.Bidi_Class. Only strong L and the RTL-writing classes R, AL and AN
// produce a segment direction; every other class (including European numbers)
// is neutral and never splits a segment. This is the same grouping CodeForge
// uses, but every scalar is classified. There is no length cache and no rule
// that a run of 32 scalars or fewer is LTR.
package bidi

import (
	"unicode"

	"golang.org/x/text/unicode/bidi"
)

// Direction is the writing direction of a strong scalar or a segment.
type Direction int

const (
	Neutral Direction = iota
	LTR
	RTL
	Mixed
)

func (d Direction) String() string {
	switch d {
	case LTR:
		return "ltr"
	case RTL:
		return "rtl"
	case Mixed:
		return "mixed"
	default:
		return "neutral"
	}
}

// MarshalText encodes a direction with the host-facing names.
func (d Direction) MarshalText() ([]byte, error) { return []byte(d.String()), nil }

// ClassOf returns the directional class of one scalar.
func ClassOf(r rune) Direction {
	props, _ := bidi.LookupRune(r)
	switch props.Class() {
	case bidi.L:
		return LTR
	case bidi.R, bidi.AL, bidi.AN:
		return RTL
	default:
		return Neutral
	}
}

// Segment is a half-open scalar range [Start, End) inside the original text
// with one strong direction. Neutral scalars between two strong scalars of the
// same direction belong to that segment. A run with no strong scalar produces
// no segment.
type Segment struct {
	Start     int       `json:"start"`
	End       int       `json:"end"`
	Direction Direction `json:"direction"`
}

// Segments scans scalars in order. start is added to every returned offset,
// so a caller can pass a line-relative slice and get document offsets back.
func Segments(text []rune, start int) []Segment {
	out := make([]Segment, 0)
	current := Neutral
	segStart := 0
	for i, r := range text {
		class := ClassOf(r)
		if class == Neutral {
			continue
		}
		if current == Neutral {
			current = class
			segStart = i
			continue
		}
		if class != current {
			out = append(out, Segment{Start: start + segStart, End: start + i, Direction: current})
			current = class
			segStart = i
		}
	}
	if current != Neutral {
		out = append(out, Segment{Start: start + segStart, End: start + len(text), Direction: current})
	}
	return out
}

// DocumentDirection reports LTR when no RTL strong scalar exists, RTL when no
// LTR strong scalar exists, and Mixed when both exist. A document with neither
// is LTR.
func DocumentDirection(text []rune) Direction {
	hasL, hasR := false, false
	for _, r := range text {
		switch ClassOf(r) {
		case LTR:
			hasL = true
		case RTL:
			hasR = true
		}
		if hasL && hasR {
			return Mixed
		}
	}
	if hasR && !hasL {
		return RTL
	}
	return LTR
}

// PrimaryDirection is the majority strong direction. Ties and documents with
// no strong scalar are LTR.
func PrimaryDirection(text []rune) Direction {
	ltr, rtl := 0, 0
	for _, r := range text {
		switch ClassOf(r) {
		case LTR:
			ltr++
		case RTL:
			rtl++
		}
	}
	if rtl > ltr {
		return RTL
	}
	return LTR
}

// IsStrongASCII reports whether r is an ASCII scalar with a strong class.
// Tests use it to show the classifier is not an ASCII special case.
func IsStrongASCII(r rune) bool {
	return r <= unicode.MaxASCII && ClassOf(r) != Neutral
}
