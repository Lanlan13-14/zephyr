// Package selection maps a base/extent selection across a replacement the way
// RopeBridge::replace_range_and_update_selection does.
package selection

// State is a directed selection. Base and extent are Unicode scalar offsets.
// They are equal for a caret.
type State struct {
	Base   int `json:"base"`
	Extent int `json:"extent"`
}

// Clamp limits both ends to [0, length].
func (s State) Clamp(length int) State {
	return State{Base: clamp(s.Base, length), Extent: clamp(s.Extent, length)}
}

// Replace maps the selection across deleting [start, end) and inserting
// replacementChars scalars at start.
//
// preserve reports whether the old caret should be mapped (true) or collapsed
// to the end of the replacement (false). old is the selection from before the
// edit; length is the document length after the edit.
func Replace(start, end int, replacementChars int, preserve bool, old State, length int) State {
	if !preserve {
		caret := start + replacementChars
		if caret > length {
			caret = length
		}
		if caret < 0 {
			caret = 0
		}
		return State{Base: caret, Extent: caret}
	}
	delta := replacementChars - (end - start)
	mapOffset := func(offset int) int {
		switch {
		case offset <= start:
			return offset
		case offset >= end:
			mapped := offset + delta
			if mapped < 0 {
				return 0
			}
			if mapped > length {
				return length
			}
			return mapped
		default:
			relative := offset - start
			if relative < 0 {
				relative = 0
			}
			if relative > replacementChars {
				relative = replacementChars
			}
			mapped := start + relative
			if mapped > length {
				return length
			}
			return mapped
		}
	}
	return State{Base: mapOffset(old.Base), Extent: mapOffset(old.Extent)}
}

func clamp(v, length int) int {
	if v < 0 {
		return 0
	}
	if v > length {
		return length
	}
	return v
}
