// Package folds finds bracket regions that span more than one line.
//
// A fold runs from the line of an opening '{', '[' or '(' to the line of its
// matching closer. Closers that do not match the current opener pop the stack
// without producing a fold, which is the CodeForge scan: it does not rescan
// for another partner. A pair on one line is not a fold.
package folds

// Range is an inclusive line pair. EndLine is the line of the closer.
type Range struct {
	StartLine int `json:"startLine"`
	EndLine   int `json:"endLine"`
}

// Compute walks scalars once. Offsets are not returned; only line spans are.
func Compute(text []rune) []Range {
	type frame struct {
		open rune
		line int
	}
	var stack []frame
	var out []Range
	line := 0
	for _, ch := range text {
		if ch == '\n' {
			line++
		}
		switch ch {
		case '{', '[', '(':
			stack = append(stack, frame{ch, line})
		case '}', ']', ')':
			if len(stack) == 0 {
				continue
			}
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if matches(top.open, ch) && top.line < line {
				out = append(out, Range{StartLine: top.line, EndLine: line})
			}
		}
	}
	return out
}

func matches(open, close rune) bool {
	switch open {
	case '{':
		return close == '}'
	case '[':
		return close == ']'
	case '(':
		return close == ')'
	default:
		return false
	}
}
