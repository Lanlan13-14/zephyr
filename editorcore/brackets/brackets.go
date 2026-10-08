// Package brackets finds the partner of a bracket at a scalar offset.
//
// The search counts nested copies of the same bracket and ignores every other
// scalar, including quotes and comments. That is the CodeForge matcher: it is
// a depth counter, not a language parser.
package brackets

// Match returns the scalar offset of the partner bracket, or -1 when offset
// does not point at a bracket or the partner is missing.
func Match(text []rune, offset int) int {
	if offset < 0 || offset >= len(text) {
		return -1
	}
	start := text[offset]
	matcher, forward, ok := partner(start)
	if !ok {
		return -1
	}
	depth := 1
	if forward {
		for i := offset + 1; i < len(text); i++ {
			switch text[i] {
			case start:
				depth++
			case matcher:
				depth--
				if depth == 0 {
					return i
				}
			}
		}
		return -1
	}
	for i := offset - 1; i >= 0; i-- {
		switch text[i] {
		case start:
			depth++
		case matcher:
			depth--
			if depth == 0 {
				return i
			}
		}
	}
	return -1
}

func partner(ch rune) (rune, bool, bool) {
	switch ch {
	case '{':
		return '}', true, true
	case '[':
		return ']', true, true
	case '(':
		return ')', true, true
	case '}':
		return '{', false, true
	case ']':
		return '[', false, true
	case ')':
		return '(', false, true
	default:
		return 0, false, false
	}
}
