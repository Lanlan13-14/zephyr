// Package words extracts the local completion vocabulary.
//
// A word is a maximal run of letters, digits, '_' or '-'. At most 5000
// distinct words are kept, in first-seen order. Later duplicates do not move
// a word. This replaces the Rust HashSet, whose iteration order is not part
// of the behaviour; the ordering a user sees is first occurrence, and any
// later ranking by typed prefix belongs to the UI.
package words

import "unicode"

const maxWords = 5000

// Extract returns up to 5000 unique words in order of first appearance.
func Extract(text []rune) []string {
	seen := make(map[string]struct{}, 64)
	out := make([]string, 0)
	start := -1
	flush := func(end int) {
		if start < 0 {
			return
		}
		if len(out) < maxWords {
			word := string(text[start:end])
			if _, ok := seen[word]; !ok {
				seen[word] = struct{}{}
				out = append(out, word)
			}
		}
		start = -1
	}
	for i, ch := range text {
		if isWord(ch) {
			if start < 0 {
				start = i
			}
			continue
		}
		flush(i)
	}
	flush(len(text))
	return out
}

func isWord(ch rune) bool {
	return unicode.IsLetter(ch) || unicode.IsDigit(ch) || ch == '_' || ch == '-'
}
