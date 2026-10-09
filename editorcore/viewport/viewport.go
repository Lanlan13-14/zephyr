// Package viewport computes the unwrapped visible line window.
//
// This matches CodeForge's visible_line_range_unwrapped and the free function
// build_viewport_frame: a constant line height, floor for the first line and
// ceil for the last. It does not fold. Folded heights belong to layout.Map.
package viewport

import "math"

// Range is an inclusive line window and the y of its first line.
type Range struct {
	FirstLine int     `json:"firstLine"`
	LastLine  int     `json:"lastLine"`
	FirstY    float64 `json:"firstLineY"`
}

// Line is one visible line's measure. Height is the constant line height.
type Line struct {
	LenChars int     `json:"lenChars"`
	Height   float32 `json:"height"`
	Lines    int     `json:"lines"`
}

// Frame is the visible window plus one entry per line inside it.
type Frame struct {
	FirstLine int     `json:"firstLine"`
	LastLine  int     `json:"lastLine"`
	FirstY    float64 `json:"firstLineY"`
	Lines     []Line  `json:"lines"`
}

// VisibleRange returns the inclusive lines overlapping [viewTop, viewBottom]
// when every line has the same height. A non-positive height is treated as 1.
// An empty document returns the zero range.
func VisibleRange(totalLines int, viewTop, viewBottom, lineHeight float64) Range {
	if totalLines <= 0 {
		return Range{}
	}
	if lineHeight <= 0 {
		lineHeight = 1
	}
	maxLine := totalLines - 1
	first := int(math.Floor(viewTop / lineHeight))
	last := int(math.Ceil(viewBottom / lineHeight))
	if first < 0 {
		first = 0
	}
	if last < 0 {
		last = 0
	}
	if first > maxLine {
		first = maxLine
	}
	if last > maxLine {
		last = maxLine
	}
	return Range{FirstLine: first, LastLine: last, FirstY: float64(first) * lineHeight}
}

// FrameOf builds the unwrapped frame. lineLen(i) returns the scalar length of
// document line i, including its line break when the caller counts it. A nil
// lineLen reports 0.
func FrameOf(totalLines int, viewTop, viewBottom, lineHeight float64, lineLen func(int) int) Frame {
	if totalLines <= 0 {
		return Frame{Lines: []Line{}}
	}
	if lineHeight <= 0 {
		lineHeight = 1
	}
	r := VisibleRange(totalLines, viewTop, viewBottom, lineHeight)
	lines := make([]Line, 0, r.LastLine-r.FirstLine+1)
	for i := r.FirstLine; i <= r.LastLine; i++ {
		n := 0
		if lineLen != nil && i >= 0 && i < totalLines {
			n = lineLen(i)
		}
		lines = append(lines, Line{LenChars: n, Height: float32(lineHeight), Lines: 1})
	}
	return Frame{FirstLine: r.FirstLine, LastLine: r.LastLine, FirstY: r.FirstY, Lines: lines}
}
