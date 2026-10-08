// Package rope is a Unicode-scalar rope with ropey 1.6 line indexing.
//
// A line is a run ending at "\n". A trailing "\n" produces one extra empty
// line (len_lines = newline_count + 1, and a rope with no newline still has
// one line). CRLF is two scalars; the line break is only the LF. Offsets are
// scalar indexes, never bytes and never UTF-16 code units.
package rope

import (
	"strings"
	"unicode/utf8"
)

const (
	leafTarget   = 512
	leafMax      = leafTarget * 2
	branchTarget = 16
	branchMax    = branchTarget * 2
)

// Rope is an immutable-node, copy-on-write scalar rope. Mutation methods
// return a new root; existing roots stay valid.
type Rope struct {
	root   *node
	leaves int
}

type node struct {
	leaf  bool
	text  string
	runes int
	nls   int
	kids  []node
	// crunes[i], cnls[i] are the exclusive prefix sums of kids[:i+1].
	crunes []int
	cnls   []int
}

// New builds a rope from a UTF-8 string. Invalid bytes are replaced with
// U+FFFD, one scalar each, so every offset stays addressable.
func New(text string) Rope {
	if !utf8.ValidString(text) {
		text = string([]rune(text))
	}
	if text == "" {
		return Rope{}
	}
	leaves := splitLeaves(text)
	kids := make([]node, len(leaves))
	for i, leaf := range leaves {
		kids[i] = node{leaf: true, text: leaf, runes: utf8.RuneCountInString(leaf), nls: strings.Count(leaf, "\n")}
	}
	return Rope{root: build(kids), leaves: len(leaves)}
}

func splitLeaves(text string) []string {
	out := make([]string, 0, utf8.RuneCountInString(text)/leafTarget+1)
	for text != "" {
		if utf8.RuneCountInString(text) <= leafMax {
			out = append(out, text)
			break
		}
		cut := scalarIndexToByte(text, leafTarget)
		out = append(out, text[:cut])
		text = text[cut:]
	}
	return out
}

func build(items []node) *node {
	if len(items) == 1 {
		n := items[0]
		return &n
	}
	next := make([]node, 0, (len(items)+branchTarget-1)/branchTarget)
	for len(items) > 0 {
		n := branchTarget
		if len(items) < n {
			n = len(items)
		}
		// Keep the last internal node from holding a single child when the
		// previous node can absorb it without passing the hard maximum.
		if len(items)-n == 1 && n < branchMax {
			n++
		}
		group := append([]node(nil), items[:n]...)
		next = append(next, summarize(group))
		items = items[n:]
	}
	return build(next)
}

func summarize(kids []node) node {
	n := node{kids: kids, crunes: make([]int, len(kids)), cnls: make([]int, len(kids))}
	runes, nls := 0, 0
	for i, k := range kids {
		runes += k.runes
		nls += k.nls
		n.crunes[i] = runes
		n.cnls[i] = nls
	}
	n.runes = runes
	n.nls = nls
	return n
}

// LenChars is the number of Unicode scalars.
func (r Rope) LenChars() int {
	if r.root == nil {
		return 0
	}
	return r.root.runes
}

// LenLines matches ropey: at least 1, plus one per "\n".
func (r Rope) LenLines() int {
	if r.root == nil {
		return 1
	}
	return r.root.nls + 1
}

// String returns the document as UTF-8.
func (r Rope) String() string {
	if r.root == nil {
		return ""
	}
	var b strings.Builder
	b.Grow(r.root.runes)
	writeNode(&b, r.root)
	return b.String()
}

func writeNode(b *strings.Builder, n *node) {
	if n.leaf {
		b.WriteString(n.text)
		return
	}
	for i := range n.kids {
		writeNode(b, &n.kids[i])
	}
}

// Char returns the scalar at offset, or -1 when offset is out of range.
func (r Rope) Char(offset int) int32 {
	if r.root == nil || offset < 0 || offset >= r.root.runes {
		return -1
	}
	s := scalarAt(r.root, offset)
	return int32(s)
}

func scalarAt(n *node, offset int) rune {
	if n.leaf {
		return runeAt(n.text, offset)
	}
	i := childIndex(n.crunes, offset)
	base := 0
	if i > 0 {
		base = n.crunes[i-1]
	}
	return scalarAt(&n.kids[i], offset-base)
}

func runeAt(s string, offset int) rune {
	for i, r := range s {
		_ = i
		if offset == 0 {
			return r
		}
		offset--
	}
	return utf8.RuneError
}

// Slice returns the UTF-8 of the half-open scalar range [start, end).
// The range is clamped to the document.
func (r Rope) Slice(start, end int) string {
	if r.root == nil {
		return ""
	}
	if start < 0 {
		start = 0
	}
	if end > r.root.runes {
		end = r.root.runes
	}
	if start >= end {
		return ""
	}
	var b strings.Builder
	sliceNode(&b, r.root, start, end)
	return b.String()
}

func sliceNode(b *strings.Builder, n *node, start, end int) {
	if start >= n.runes || end <= 0 {
		return
	}
	if start < 0 {
		start = 0
	}
	if end > n.runes {
		end = n.runes
	}
	if n.leaf {
		b.WriteString(scalarSlice(n.text, start, end))
		return
	}
	for i := range n.kids {
		base := 0
		if i > 0 {
			base = n.crunes[i-1]
		}
		sliceNode(b, &n.kids[i], start-base, end-base)
	}
}

func scalarSlice(s string, start, end int) string {
	byteStart, byteEnd := -1, len(s)
	i := 0
	for bi := range s {
		if i == start {
			byteStart = bi
		}
		if i == end {
			byteEnd = bi
			break
		}
		i++
	}
	if byteStart < 0 {
		byteStart = len(s)
	}
	return s[byteStart:byteEnd]
}

func scalarIndexToByte(s string, offset int) int {
	i := 0
	for bi := range s {
		if i == offset {
			return bi
		}
		i++
	}
	return len(s)
}

// CharToLine returns the 0-based line containing offset. An offset equal to
// the document length addresses the final (possibly empty) line.
func (r Rope) CharToLine(offset int) int {
	if r.root == nil {
		return 0
	}
	if offset < 0 {
		offset = 0
	}
	if offset > r.root.runes {
		offset = r.root.runes
	}
	if offset == r.root.runes {
		return r.LenLines() - 1
	}
	return newlinesBefore(r.root, offset)
}

func newlinesBefore(n *node, offset int) int {
	if n.leaf {
		return strings.Count(scalarSlice(n.text, 0, offset), "\n")
	}
	i := childIndex(n.crunes, offset)
	base, nls := 0, 0
	if i > 0 {
		base = n.crunes[i-1]
		nls = n.cnls[i-1]
	}
	return nls + newlinesBefore(&n.kids[i], offset-base)
}

// LineToChar returns the scalar offset of the first character of line.
// line is clamped to the last line.
func (r Rope) LineToChar(line int) int {
	if r.root == nil || line <= 0 {
		return 0
	}
	last := r.LenLines() - 1
	if line > last {
		line = last
	}
	return offsetOfNewline(r.root, line)
}

// offsetOfNewline returns the scalar offset just after the n-th newline
// (n is 1-based). The result is clamped to the node length.
func offsetOfNewline(n *node, nNewlines int) int {
	if n.leaf {
		seen := 0
		for i, r := range n.text {
			if r == '\n' {
				seen++
				if seen == nNewlines {
					return utf8.RuneCountInString(n.text[:i]) + 1
				}
			}
		}
		return n.runes
	}
	i := childByNewlines(n.cnls, nNewlines)
	base, prev := 0, 0
	if i > 0 {
		base = n.crunes[i-1]
		prev = n.cnls[i-1]
	}
	return base + offsetOfNewline(&n.kids[i], nNewlines-prev)
}

// Line returns line with its trailing line break removed. A CRLF break loses
// both scalars; a LF break loses the LF. The final line has no break to strip.
func (r Rope) Line(line int) string {
	raw := r.lineRaw(line)
	if strings.HasSuffix(raw, "\r\n") {
		return raw[:len(raw)-2]
	}
	if strings.HasSuffix(raw, "\n") {
		return raw[:len(raw)-1]
	}
	return raw
}

func (r Rope) lineRaw(line int) string {
	if line < 0 {
		line = 0
	}
	start := r.LineToChar(line)
	var end int
	if line >= r.LenLines()-1 {
		end = r.LenChars()
	} else {
		end = r.LineToChar(line + 1)
	}
	return r.Slice(start, end)
}

// Lines returns every line with breaks stripped, from start inclusive to end
// exclusive. The range is clamped.
func (r Rope) Lines(start, end int) []string {
	total := r.LenLines()
	if start < 0 {
		start = 0
	}
	if end > total {
		end = total
	}
	if start > end {
		start = end
	}
	out := make([]string, 0, end-start)
	for i := start; i < end; i++ {
		out = append(out, r.Line(i))
	}
	return out
}

// Insert returns a rope with text inserted at the scalar offset. The offset
// is clamped to the document.
func (r Rope) Insert(offset int, text string) Rope {
	if !utf8.ValidString(text) {
		text = string([]rune(text))
	}
	if text == "" {
		return r
	}
	if offset < 0 {
		offset = 0
	}
	if offset > r.LenChars() {
		offset = r.LenChars()
	}
	return New(r.Slice(0, offset) + text + r.Slice(offset, r.LenChars()))
}

// Remove returns a rope with the half-open scalar range deleted. The range is
// clamped and swapped when end < start.
func (r Rope) Remove(start, end int) Rope {
	if start < 0 {
		start = 0
	}
	if end > r.LenChars() {
		end = r.LenChars()
	}
	if end < start {
		start, end = end, start
	}
	if start == end {
		return r
	}
	return New(r.Slice(0, start) + r.Slice(end, r.LenChars()))
}

// Replace returns a rope with [start, end) replaced by text. The range is
// clamped the same way as Remove, then text is inserted at the clamped start.
func (r Rope) Replace(start, end int, text string) Rope {
	if !utf8.ValidString(text) {
		text = string([]rune(text))
	}
	if start < 0 {
		start = 0
	}
	if end > r.LenChars() {
		end = r.LenChars()
	}
	if end < start {
		start, end = end, start
	}
	return New(r.Slice(0, start) + text + r.Slice(end, r.LenChars()))
}

func clampOffset(offset, length int) int {
	if offset < 0 {
		return 0
	}
	if offset > length {
		return length
	}
	return offset
}

// Chars walks every scalar. The callback returning false stops the walk.
func (r Rope) Chars(fn func(int, rune) bool) {
	if r.root == nil {
		return
	}
	walkChars(r.root, 0, fn)
}

func walkChars(n *node, base int, fn func(int, rune) bool) bool {
	if n.leaf {
		i := base
		for _, r := range n.text {
			if !fn(i, r) {
				return false
			}
			i++
		}
		return true
	}
	for i := range n.kids {
		b := base
		if i > 0 {
			b = base + n.crunes[i-1]
		}
		if !walkChars(&n.kids[i], b, fn) {
			return false
		}
	}
	return true
}

// childIndex is the first child whose exclusive prefix sum is > offset.
func childIndex(prefix []int, offset int) int {
	lo, hi := 0, len(prefix)
	for lo < hi {
		mid := (lo + hi) / 2
		if prefix[mid] <= offset {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo >= len(prefix) {
		return len(prefix) - 1
	}
	return lo
}

// childByNewlines is the first child whose newline prefix sum is >= n.
func childByNewlines(prefix []int, n int) int {
	lo, hi := 0, len(prefix)
	for lo < hi {
		mid := (lo + hi) / 2
		if prefix[mid] < n {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo >= len(prefix) {
		return len(prefix) - 1
	}
	return lo
}

// LeafCount reports how many leaf chunks the rope uses. Tests use it to prove
// the structure is a rope rather than one string.
func (r Rope) LeafCount() int { return r.leaves }
