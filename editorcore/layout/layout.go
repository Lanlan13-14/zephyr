// Package layout is the line-block sum tree used by CodeForge's LayoutMap.
//
// Each line contributes one to the line dimension and its character length to
// the char dimension. A folded line contributes zero height. Seeks follow
// zed-sum-tree: BiasLeft stops on the item whose end is strictly greater than
// the target; BiasRight consumes an item whose end is equal to the target.
package layout

import "math"

// Bias selects which item a seek lands on when the target is exactly on an
// item boundary.
type Bias int

const (
	BiasLeft Bias = iota
	BiasRight
)

// Block is one document line in the layout.
type Block struct {
	LenChars int     `json:"lenChars"`
	Height   float32 `json:"height"`
	Folded   bool    `json:"folded"`
}

// Summary is the additive measure of a block. A folded block still counts as
// one line and keeps its character length, but its height sums as zero.
type Summary struct {
	LenChars int     `json:"lenChars"`
	Height   float32 `json:"height"`
	Lines    int     `json:"lines"`
}

func summaryOf(b Block) Summary {
	h := b.Height
	if b.Folded {
		h = 0
	}
	return Summary{LenChars: b.LenChars, Height: h, Lines: 1}
}

func add(a, b Summary) Summary {
	return Summary{LenChars: a.LenChars + b.LenChars, Height: a.Height + b.Height, Lines: a.Lines + b.Lines}
}

const (
	branchTarget = 16
	branchMax    = 32
)

type node struct {
	leaf  bool
	sum   Summary
	items []Block
	kids  []*node
}

// Map is a copy-on-write sum tree of line blocks.
type Map struct {
	root *node
}

// New returns an empty layout.
func New() *Map { return &Map{} }

// LenLines is the number of stored lines, including folded ones.
func (m *Map) LenLines() int {
	if m == nil || m.root == nil {
		return 0
	}
	return m.root.sum.Lines
}

// TotalHeight is the summed visible height. Folded lines contribute nothing.
func (m *Map) TotalHeight() float64 {
	if m == nil || m.root == nil {
		return 0
	}
	return float64(m.root.sum.Height)
}

// Clear drops every line.
func (m *Map) Clear() { m.root = nil }

// PushLine appends a line.
func (m *Map) PushLine(lenChars int, height float32, folded bool) {
	m.InsertLine(m.LenLines(), lenChars, height, folded)
}

// InsertLine inserts at line index. An index at or past the end appends.
func (m *Map) InsertLine(line int, lenChars int, height float32, folded bool) {
	b := Block{LenChars: lenChars, Height: height, Folded: folded}
	if m.root == nil {
		m.root = &node{leaf: true, items: []Block{b}, sum: summaryOf(b)}
		return
	}
	if line >= m.LenLines() {
		line = m.LenLines()
	}
	if line < 0 {
		line = 0
	}
	m.root = insert(m.root, line, b)
	m.root = rebalance(m.root)
}

// RemoveLine deletes the line, or does nothing when the index is past the end.
func (m *Map) RemoveLine(line int) {
	if line < 0 || line >= m.LenLines() {
		return
	}
	m.root = remove(m.root, line)
	if m.root != nil {
		m.root = rebalance(m.root)
	}
}

// UpdateLine replaces one line in place. An index past the end is ignored.
func (m *Map) UpdateLine(line int, lenChars int, height float32, folded bool) {
	if line < 0 || line >= m.LenLines() {
		return
	}
	m.RemoveLine(line)
	m.InsertLine(line, lenChars, height, folded)
}

func insert(n *node, line int, b Block) *node {
	if n.leaf {
		out := append([]Block(nil), n.items...)
		out = append(out, Block{})
		copy(out[line+1:], out[line:])
		out[line] = b
		return leaf(out)
	}
	idx, local := childOfLine(n, line)
	kids := append([]*node(nil), n.kids...)
	kids[idx] = insert(kids[idx], local, b)
	return branch(kids)
}

func remove(n *node, line int) *node {
	if n.leaf {
		out := append([]Block(nil), n.items...)
		out = append(out[:line], out[line+1:]...)
		if len(out) == 0 {
			return nil
		}
		return leaf(out)
	}
	idx, local := childOfLine(n, line)
	kids := append([]*node(nil), n.kids...)
	kids[idx] = remove(kids[idx], local)
	if kids[idx] == nil {
		kids = append(kids[:idx], kids[idx+1:]...)
	}
	if len(kids) == 0 {
		return nil
	}
	if len(kids) == 1 {
		return kids[0]
	}
	return branch(kids)
}

func childOfLine(n *node, line int) (int, int) {
	seen := 0
	for i, k := range n.kids {
		if seen+k.sum.Lines > line {
			return i, line - seen
		}
		seen += k.sum.Lines
	}
	last := len(n.kids) - 1
	return last, n.kids[last].sum.Lines
}

func leaf(items []Block) *node {
	n := &node{leaf: true, items: items}
	for _, it := range items {
		n.sum = add(n.sum, summaryOf(it))
	}
	return n
}

func branch(kids []*node) *node {
	n := &node{kids: kids}
	for _, k := range kids {
		n.sum = add(n.sum, k.sum)
	}
	return n
}

func rebalance(n *node) *node {
	if n == nil {
		return nil
	}
	if n.leaf {
		if len(n.items) <= branchMax {
			return n
		}
		var kids []*node
		for len(n.items) > 0 {
			take := branchTarget
			if take > len(n.items) {
				take = len(n.items)
			}
			if len(n.items)-take == 1 && take < branchMax {
				take++
			}
			kids = append(kids, leaf(append([]Block(nil), n.items[:take]...)))
			n.items = n.items[take:]
		}
		return rebalance(branch(kids))
	}
	changed := false
	kids := n.kids
	for i, k := range kids {
		nb := rebalance(k)
		if nb != k {
			if !changed {
				kids = append([]*node(nil), kids...)
				changed = true
			}
			kids[i] = nb
		}
	}
	if len(kids) > branchMax {
		var upper []*node
		for len(kids) > 0 {
			take := branchTarget
			if take > len(kids) {
				take = len(kids)
			}
			if len(kids)-take == 1 && take < branchMax {
				take++
			}
			upper = append(upper, branch(append([]*node(nil), kids[:take]...)))
			kids = kids[take:]
		}
		return rebalance(branch(upper))
	}
	if changed {
		return branch(kids)
	}
	return n
}

// cursor is a zed-sum-tree style position: the summed measure of every item
// strictly before the current item.
type cursor struct {
	m     *Map
	index int
	chars int
	lines int
	y     float32
	ok    bool
}

func (c cursor) item() (Block, bool) {
	if !c.ok || c.m == nil || c.m.root == nil || c.index < 0 || c.index >= c.m.LenLines() {
		return Block{}, false
	}
	return blockAt(c.m.root, c.index), true
}

func blockAt(n *node, line int) Block {
	if n.leaf {
		return n.items[line]
	}
	seen := 0
	for _, k := range n.kids {
		if seen+k.sum.Lines > line {
			return blockAt(k, line-seen)
		}
		seen += k.sum.Lines
	}
	return n.kids[len(n.kids)-1].items[0]
}

// measureBefore is the sum of lines [0, line).
func measureBefore(n *node, line int) (chars, lines int, y float32) {
	if n == nil || line <= 0 {
		return 0, 0, 0
	}
	if n.leaf {
		if line > len(n.items) {
			line = len(n.items)
		}
		for i := 0; i < line; i++ {
			s := summaryOf(n.items[i])
			chars += s.LenChars
			lines += s.Lines
			y += s.Height
		}
		return chars, lines, y
	}
	remaining := line
	for _, k := range n.kids {
		if k.sum.Lines >= remaining {
			c, l, h := measureBefore(k, remaining)
			return chars + c, lines + l, y + h
		}
		chars += k.sum.LenChars
		lines += k.sum.Lines
		y += k.sum.Height
		remaining -= k.sum.Lines
	}
	return chars, lines, y
}

// DebugLines exposes per-line measures so tests can show a bad tree instead
// of only a wrong seek result.
func (m *Map) DebugLines() []Summary {
	out := make([]Summary, 0, m.LenLines())
	for i := 0; i < m.LenLines(); i++ {
		out = append(out, summaryOf(blockAt(m.root, i)))
	}
	return out
}

func (m *Map) seek(chars int, lines int, y float32, by string, bias Bias) cursor {
	if m == nil || m.root == nil || m.root.sum.Lines == 0 {
		return cursor{m: m}
	}
	total := m.root.sum.Lines
	// First line whose end is strictly past the target (BiasLeft), or the
	// first line whose end is past-or-equal (BiasRight). Past the end, the
	// cursor is exhausted and its measure is the whole tree.
	lo, hi := 0, total
	for lo < hi {
		mid := (lo + hi) / 2
		endC, endL, endY := measureEnd(m.root, mid)
		if consume(by, bias, chars, lines, y, endC, endL, endY) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo >= total {
		c, l, h := measureBefore(m.root, total)
		return cursor{m: m, index: total, chars: c, lines: l, y: h, ok: false}
	}
	c, l, h := measureBefore(m.root, lo)
	return cursor{m: m, index: lo, chars: c, lines: l, y: h, ok: true}
}

func measureEnd(n *node, line int) (int, int, float32) {
	c, l, y := measureBefore(n, line)
	b := blockAt(n, line)
	s := summaryOf(b)
	return c + s.LenChars, l + s.Lines, y + s.Height
}

func consume(by string, bias Bias, chars, lines int, y float32, endC, endL int, endY float32) bool {
	cmp := seekCompare(by, chars, lines, y, endC, endL, endY)
	// cmp is target compared with this item's end.
	// >0: target is past the item, always consume.
	// =0: the boundary. BiasLeft consumes so the next item owns the boundary;
	//     BiasRight stays on the item that ends here.
	// <0: the item extends past the target, so stop on it.
	if cmp > 0 {
		return true
	}
	if cmp < 0 {
		return false
	}
	return bias == BiasLeft
}

func compareInt(target, end int) int {
	switch {
	case target > end:
		return 1
	case target < end:
		return -1
	default:
		return 0
	}
}

func compareFloat(target, end float32) int {
	if target > end {
		return 1
	}
	if target < end {
		return -1
	}
	return 0
}

// seekCompare is target.cmp(itemEnd), the ordering zed-sum-tree uses: a
// positive result means the target lies strictly past this item.
func seekCompare(by string, chars, lines int, y float32, endC, endL int, endY float32) int {
	switch by {
	case "char":
		return compareInt(chars, endC)
	case "line":
		return compareInt(lines, endL)
	default:
		return compareFloat(y, endY)
	}
}

func (c cursor) next() cursor {
	if !c.ok {
		return c
	}
	item, ok := c.item()
	if !ok {
		c.ok = false
		return c
	}
	s := summaryOf(item)
	c.chars += s.LenChars
	c.lines += s.Lines
	c.y += s.Height
	c.index++
	if c.index >= c.m.LenLines() {
		c.ok = false
	}
	return c
}

// VisualLineFromCharOffset is the line whose character range contains offset.
// An offset exactly at a line boundary belongs to the following line
// (BiasLeft), except an offset at or past the end, which belongs to the last
// line. An empty map returns 0.
func (m *Map) VisualLineFromCharOffset(offset int) int {
	if m.LenLines() == 0 {
		return 0
	}
	if offset < 0 {
		offset = 0
	}
	c := m.seek(offset, 0, 0, "char", BiasLeft)
	if !c.ok {
		return m.LenLines() - 1
	}
	return c.index
}

// VisibleLineRange is the inclusive line window covering a vertical span.
type VisibleLineRange struct {
	FirstLine int     `json:"firstLine"`
	LastLine  int     `json:"lastLine"`
	FirstY    float64 `json:"firstLineY"`
}

// ViewportFrame is that window plus one summary per visited line.
type ViewportFrame struct {
	FirstLine int       `json:"firstLine"`
	LastLine  int       `json:"lastLine"`
	FirstY    float64   `json:"firstLineY"`
	Lines     []Summary `json:"lines"`
}

// VisibleRangeByHeight seeks the first line with BiasLeft at viewTop and the
// last line with BiasRight at viewBottom, matching LayoutMap::visible_range_by_height.
func (m *Map) VisibleRangeByHeight(viewTop, viewBottom float64) VisibleLineRange {
	if m.LenLines() == 0 {
		return VisibleLineRange{}
	}
	if viewTop < 0 {
		viewTop = 0
	}
	if viewBottom < viewTop {
		viewBottom = viewTop
	}
	start := m.seek(0, 0, float32(viewTop), "pixel", BiasLeft)
	first := start.index
	firstY := float64(start.y)
	if !start.ok {
		first = m.LenLines() - 1
		firstY = m.TotalHeight()
	}
	end := m.seek(0, 0, float32(viewBottom), "pixel", BiasRight)
	last := end.index
	if !end.ok {
		last = m.LenLines()
	}
	maxLine := m.LenLines() - 1
	if last > maxLine {
		last = maxLine
	}
	if last < first {
		last = first
	}
	return VisibleLineRange{FirstLine: first, LastLine: last, FirstY: firstY}
}

// BuildViewportFrame lists every line from viewTop until a line starts past
// viewBottom. A folded line is reported with height 0. A non-folded line whose
// stored height is not positive uses fallbackLineHeight (minimum 1).
func (m *Map) BuildViewportFrame(viewTop, viewBottom, fallbackLineHeight float64) ViewportFrame {
	if m.LenLines() == 0 {
		return ViewportFrame{Lines: []Summary{}}
	}
	visible := m.VisibleRangeByHeight(viewTop, viewBottom)
	c := m.seek(0, 0, float32(viewTop), "pixel", BiasLeft)
	bottom := float32(math.Max(viewBottom, viewTop))
	fallback := float32(fallbackLineHeight)
	if fallback < 1 {
		fallback = 1
	}
	lines := make([]Summary, 0)
	for c.ok {
		// Inclusive of a line that starts exactly at the bottom. The next line,
		// whose top is past the bottom, is the first one excluded.
		if c.y > bottom {
			break
		}
		item, _ := c.item()
		h := item.Height
		if item.Folded {
			h = 0
		} else if h <= 0 {
			h = fallback
		}
		lines = append(lines, Summary{LenChars: item.LenChars, Height: h, Lines: 1})
		c = c.next()
	}
	computedLast := visible.FirstLine
	if len(lines) > 0 {
		computedLast = visible.FirstLine + len(lines) - 1
	}
	if computedLast < visible.FirstLine {
		computedLast = visible.FirstLine
	}
	return ViewportFrame{
		FirstLine: visible.FirstLine,
		LastLine:  computedLast,
		FirstY:    visible.FirstY,
		Lines:     lines,
	}
}
