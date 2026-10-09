package editorcore

import (
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// FindLimit is the number of matches a search reports. One extra match is
// counted only so the host can show "1000+".
const FindLimit = 1000

// UndoLimit is the number of undo entries kept per document.
const UndoLimit = 1000

// CapabilityThreshold is the line count at which syntax, folding, indent
// guides and wrap switching turn off. 5800 stays full; 5801 degrades.
const CapabilityThreshold = 5800

const mergeWindow = 500 * time.Millisecond

// FindQuery is one search. Query is never trimmed: a trailing space is a
// different search from the same word without it.
type FindQuery struct {
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	Regex         bool   `json:"regex"`
	Wrap          bool   `json:"wrap"`
	From          int    `json:"from"`
}

// Match is a half-open scalar range.
type Match struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// FindResult is the reported window plus the current position inside it.
type FindResult struct {
	Query         string  `json:"query"`
	CaseSensitive bool    `json:"caseSensitive"`
	Regex         bool    `json:"regex"`
	Matches       []Match `json:"matches"`
	Current       int     `json:"current"`
	Count         int     `json:"count"`
	Total         int     `json:"total"`
	Truncated     bool    `json:"truncated"`
	Wrapped       bool    `json:"wrapped"`
	Error         string  `json:"error,omitempty"`
}

// ReplaceResult is one literal replacement. Replacement is inserted as text,
// never as a regexp expansion, so "$1" stays the two characters dollar and one.
type ReplaceResult struct {
	Replaced bool   `json:"replaced"`
	Count    int    `json:"count"`
	Start    int    `json:"start"`
	End      int    `json:"end"`
	Text     string `json:"text"`
	Next     *Match `json:"next,omitempty"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// EditResult is the text and selection a command produced.
type EditResult struct {
	Text      string    `json:"text"`
	Selection Selection `json:"selection"`
	Changed   bool      `json:"changed"`
	ReadOnly  bool      `json:"readOnly,omitempty"`
}

// ClipboardResult is the text a copy or cut wants on the host clipboard.
// The core does not touch the system clipboard.
type ClipboardResult struct {
	Text      string    `json:"text"`
	Cut       bool      `json:"cut"`
	Changed   bool      `json:"changed"`
	ReadOnly  bool      `json:"readOnly,omitempty"`
	Selection Selection `json:"selection"`
}

// HistoryState says whether undo or redo has an entry.
type HistoryState struct {
	CanUndo bool `json:"canUndo"`
	CanRedo bool `json:"canRedo"`
	Undo    int  `json:"undo"`
	Redo    int  `json:"redo"`
}

// Capabilities is the live feature set. It follows the current line count.
type Capabilities struct {
	Lines    int  `json:"lines"`
	Syntax   bool `json:"syntax"`
	Folding  bool `json:"folding"`
	Guides   bool `json:"guides"`
	Wrap     bool `json:"wrap"`
	Degraded bool `json:"degraded"`
}

// Meta is the saved baseline used for dirty. Text, encoding and EOL are
// independent: changing only the encoding or only the EOL is dirty.
type Meta struct {
	Encoding      string `json:"encoding"`
	EOL           string `json:"eol"`
	SavedText     string `json:"savedText,omitempty"`
	SavedEncoding string `json:"savedEncoding,omitempty"`
	SavedEOL      string `json:"savedEOL,omitempty"`
	Dirty         bool   `json:"dirty"`
	TextDirty     bool   `json:"textDirty"`
	EncodingDirty bool   `json:"encodingDirty"`
	EOLDirty      bool   `json:"eolDirty"`
}

type historyEntry struct {
	start    int
	deleted  string
	inserted string
	before   Selection
	after    Selection
	at       time.Time
	compound bool
	sealed   bool
	group    []historyEntry
}

func (d *Document) ensure() {
	if d.undo == nil {
		d.undo = []historyEntry{}
	}
	if d.redo == nil {
		d.redo = []historyEntry{}
	}
	if d.encoding == "" {
		d.encoding = "utf-8"
	}
	if d.eol == "" {
		d.eol = detectEOL(d.Text())
	}
	if d.savedEncoding == "" {
		d.savedEncoding = d.encoding
	}
	if d.savedEOL == "" {
		d.savedEOL = d.eol
	}
	if !d.baselineSet {
		d.savedText = d.Text()
		d.baselineSet = true
	}
}

func detectEOL(text string) string {
	if strings.Contains(text, "\r\n") {
		return "crlf"
	}
	return "lf"
}

// SetReadOnly rejects later mutations when on is true. Selection still moves.
func (d *Document) SetReadOnly(on bool) {
	d.readOnly = on
	d.version++
}

// ReadOnly reports the write lock.
func (d *Document) ReadOnly() bool { return d.readOnly }

// SetEncoding records the encoding the host will save with. It does not
// re-decode the buffer.
func (d *Document) SetEncoding(encoding string) Meta {
	d.ensure()
	next := strings.ToLower(strings.TrimSpace(encoding))
	if next == "" {
		next = d.encoding
	}
	if next != d.encoding {
		d.encoding = next
		d.version++
	}
	return d.Meta()
}

// SetEOL records LF or CRLF. The buffer itself stays as stored; the host
// normalizes bytes at save time from this value.
func (d *Document) SetEOL(eol string) Meta {
	d.ensure()
	next := strings.ToLower(strings.TrimSpace(eol))
	if next != "lf" && next != "crlf" {
		next = d.eol
	}
	if next != d.eol {
		d.eol = next
		d.version++
	}
	return d.Meta()
}

// MarkSaved copies the current text, encoding and EOL into the baseline.
func (d *Document) MarkSaved() Meta {
	d.ensure()
	d.savedText = d.Text()
	d.savedEncoding = d.encoding
	d.savedEOL = d.eol
	d.baselineSet = true
	d.version++
	return d.Meta()
}

// Meta reports dirty against the saved baseline.
func (d *Document) Meta() Meta {
	d.ensure()
	textDirty := d.Text() != d.savedText
	encDirty := d.encoding != d.savedEncoding
	eolDirty := d.eol != d.savedEOL
	return Meta{
		Encoding: d.encoding, EOL: d.eol,
		SavedEncoding: d.savedEncoding, SavedEOL: d.savedEOL,
		Dirty:     textDirty || encDirty || eolDirty,
		TextDirty: textDirty, EncodingDirty: encDirty, EOLDirty: eolDirty,
	}
}

// Capabilities follows the current line count, not the count at open.
func (d *Document) Capabilities() Capabilities {
	lines := d.LenLines()
	full := lines <= CapabilityThreshold
	return Capabilities{Lines: lines, Syntax: full, Folding: full, Guides: full, Wrap: full, Degraded: !full}
}

func (d *Document) compile(query string, caseSensitive, regex bool) (*regexp.Regexp, error) {
	pattern := query
	if !regex {
		pattern = regexp.QuoteMeta(query)
	}
	if !caseSensitive {
		pattern = "(?i)" + pattern
	}
	pattern = "(?m)" + pattern
	return regexp.Compile(pattern)
}

func (d *Document) spans(re *regexp.Regexp) ([]Match, bool) {
	text := d.Text()
	locs := re.FindAllStringIndex(text, FindLimit+1)
	if locs == nil {
		return []Match{}, false
	}
	truncated := len(locs) > FindLimit
	if truncated {
		locs = locs[:FindLimit]
	}
	out := make([]Match, 0, len(locs))
	byteAt := 0
	scalar := 0
	for _, loc := range locs {
		for byteAt < loc[0] && byteAt < len(text) {
			_, size := utf8.DecodeRuneInString(text[byteAt:])
			byteAt += size
			scalar++
		}
		start := scalar
		for byteAt < loc[1] && byteAt < len(text) {
			_, size := utf8.DecodeRuneInString(text[byteAt:])
			byteAt += size
			scalar++
		}
		out = append(out, Match{Start: start, End: scalar})
	}
	return out, truncated
}

// Find searches from the caret. An empty query clears the match list and is
// not an error. A bad regexp returns the error in the result.
func (d *Document) Find(q FindQuery) FindResult {
	res := FindResult{
		Query: q.Query, CaseSensitive: q.CaseSensitive, Regex: q.Regex,
		Matches: []Match{}, Current: -1,
	}
	if q.Query == "" {
		return res
	}
	re, err := d.compile(q.Query, q.CaseSensitive, q.Regex)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	matches, truncated := d.spans(re)
	res.Matches = matches
	res.Truncated = truncated
	res.Count = len(matches)
	if truncated {
		res.Total = FindLimit
	} else {
		res.Total = len(matches)
	}
	if len(matches) == 0 {
		return res
	}
	from := q.From
	if from < 0 {
		from = d.Selection().Extent
	}
	current := 0
	wrapped := false
	found := false
	for i, m := range matches {
		if m.Start >= from {
			current = i
			found = true
			break
		}
	}
	if !found {
		current = 0
		wrapped = q.Wrap && len(matches) > 0
	}
	res.Current = current
	res.Wrapped = wrapped
	return res
}

// FindGo moves the current match. dir +1 is next, -1 is previous. Movement
// cycles inside the reported window.
func (d *Document) FindGo(q FindQuery, dir int) FindResult {
	res := d.Find(q)
	if res.Error != "" || len(res.Matches) == 0 {
		return res
	}
	if dir == 0 {
		dir = 1
	}
	n := len(res.Matches)
	idx := res.Current
	if idx < 0 {
		idx = 0
	}
	next := idx + dir
	wrapped := false
	if next >= n {
		next = 0
		wrapped = true
	} else if next < 0 {
		next = n - 1
		wrapped = true
	}
	res.Current = next
	res.Wrapped = wrapped
	m := res.Matches[next]
	d.SetSelection(m.Start, m.End)
	return res
}

func (d *Document) literalReplace(start, end int, replacement string) {
	d.Replace(start, end, replacement, false)
}

// ReplaceOne replaces the current match, or the next match at/after the caret.
// The replacement is literal. Read-only documents change nothing.
func (d *Document) ReplaceOne(q FindQuery, replacement string) ReplaceResult {
	if d.readOnly {
		return ReplaceResult{ReadOnly: true, Text: d.Text()}
	}
	found := d.Find(q)
	if found.Error != "" || len(found.Matches) == 0 || found.Current < 0 {
		return ReplaceResult{Text: d.Text()}
	}
	m := found.Matches[found.Current]
	d.literalReplace(m.Start, m.End, replacement)
	added := utf8.RuneCountInString(replacement)
	again := d.Find(FindQuery{Query: q.Query, CaseSensitive: q.CaseSensitive, Regex: q.Regex, From: m.Start + added})
	out := ReplaceResult{Replaced: true, Count: 1, Start: m.Start, End: m.Start + added, Text: d.Text()}
	if again.Current >= 0 && len(again.Matches) > 0 {
		next := again.Matches[again.Current]
		out.Next = &next
		d.SetSelection(next.Start, next.End)
	}
	return out
}

// ReplaceAll replaces every match in the whole document, including matches
// past the 1000 reported window. The replacement is literal.
func (d *Document) ReplaceAll(q FindQuery, replacement string) ReplaceResult {
	if d.readOnly {
		return ReplaceResult{ReadOnly: true, Text: d.Text()}
	}
	if q.Query == "" {
		return ReplaceResult{Text: d.Text()}
	}
	re, err := d.compile(q.Query, q.CaseSensitive, q.Regex)
	if err != nil {
		return ReplaceResult{Text: d.Text()}
	}
	original := d.Text()
	literal := replacement
	count := 0
	next := re.ReplaceAllStringFunc(original, func(string) string {
		count++
		return literal
	})
	if count == 0 || next == original {
		return ReplaceResult{Text: original}
	}
	d.record(0, original, next, true)
	d.Replace(0, d.LenChars(), next, false)
	return ReplaceResult{Replaced: true, Count: count, Start: 0, End: d.LenChars(), Text: d.Text()}
}

func (d *Document) record(start int, deleted, inserted string, compound bool) {
	if d.applying {
		return
	}
	d.ensure()
	d.redo = d.redo[:0]
	now := d.clock()
	if d.compound > 0 {
		if d.compoundBase == "" && len(d.undo) == d.compoundAt {
			d.compoundBase = d.Text()
			d.compoundSel = d.Selection()
		}
		return
	}
	entry := historyEntry{
		start: start, deleted: deleted, inserted: inserted,
		before: d.Selection(), at: now, compound: compound,
	}
	if !compound && len(d.undo) > 0 {
		last := &d.undo[len(d.undo)-1]
		if !last.sealed && !last.compound && d.canMerge(*last, entry) {
			last.inserted += inserted
			last.at = now
			return
		}
	}
	if compound && len(d.undo) > 0 {
		d.undo[len(d.undo)-1].sealed = true
	}
	d.undo = append(d.undo, entry)
	if len(d.undo) > UndoLimit {
		d.undo = d.undo[len(d.undo)-UndoLimit:]
	}
}

func (d *Document) clock() time.Time {
	if !d.now.IsZero() {
		return d.now
	}
	return time.Now()
}

// SetClock pins undo merging to a timestamp. The zero time uses the real clock.
func (d *Document) SetClock(at time.Time) { d.now = at }

func (d *Document) canMerge(last, next historyEntry) bool {
	if next.at.Sub(last.at) > mergeWindow || last.at.Sub(next.at) > mergeWindow {
		return false
	}
	if strings.Contains(last.inserted, "\n") || strings.Contains(next.inserted, "\n") ||
		strings.Contains(last.deleted, "\n") || strings.Contains(next.deleted, "\n") {
		return false
	}
	if last.deleted == "" && next.deleted == "" && next.start == last.start+utf8.RuneCountInString(last.inserted) {
		lastSpace := strings.HasSuffix(last.inserted, " ") || strings.HasSuffix(last.inserted, "\t")
		nextSpace := strings.HasPrefix(next.inserted, " ") || strings.HasPrefix(next.inserted, "\t")
		if last.inserted != "" && next.inserted != "" && lastSpace != nextSpace {
			return false
		}
		return true
	}
	if last.inserted == "" && next.inserted == "" {
		if next.start == last.start-utf8.RuneCountInString(next.deleted) || next.start == last.start {
			return true
		}
	}
	return false
}

func (d *Document) applyForward(entry historyEntry) {
	if len(entry.group) > 0 {
		// Group members were recorded last-line-first, so forward replay
		// walks them from the bottom of the stack back to the top.
		for i := len(entry.group) - 1; i >= 0; i-- {
			op := entry.group[i]
			d.Replace(op.start, op.start+utf8.RuneCountInString(op.deleted), op.inserted, false)
		}
		return
	}
	d.Replace(entry.start, entry.start+utf8.RuneCountInString(entry.deleted), entry.inserted, false)
}

func (d *Document) applyBackward(entry historyEntry) {
	if len(entry.group) > 0 {
		for _, op := range entry.group {
			d.Replace(op.start, op.start+utf8.RuneCountInString(op.inserted), op.deleted, false)
		}
		return
	}
	d.Replace(entry.start, entry.start+utf8.RuneCountInString(entry.inserted), entry.deleted, false)
}

// Undo restores one entry and returns whether anything changed.
func (d *Document) Undo() (EditResult, bool) {
	d.ensure()
	if len(d.undo) == 0 || d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: d.readOnly}, false
	}
	entry := d.undo[len(d.undo)-1]
	d.undo = d.undo[:len(d.undo)-1]
	d.applying = true
	d.applyBackward(entry)
	d.SetSelection(entry.before.Base, entry.before.Extent)
	d.applying = false
	d.redo = append(d.redo, entry)
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}, true
}

// Redo reapplies one undone entry.
func (d *Document) Redo() (EditResult, bool) {
	d.ensure()
	if len(d.redo) == 0 || d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: d.readOnly}, false
	}
	entry := d.redo[len(d.redo)-1]
	d.redo = d.redo[:len(d.redo)-1]
	d.applying = true
	d.applyForward(entry)
	if entry.after.Base != 0 || entry.after.Extent != 0 {
		d.SetSelection(entry.after.Base, entry.after.Extent)
	} else if len(entry.group) == 0 {
		end := entry.start + utf8.RuneCountInString(entry.inserted)
		d.SetSelection(end, end)
	}
	d.applying = false
	d.undo = append(d.undo, entry)
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}, true
}

// History reports the stacks.
func (d *Document) History() HistoryState {
	d.ensure()
	return HistoryState{CanUndo: len(d.undo) > 0 && !d.readOnly, CanRedo: len(d.redo) > 0 && !d.readOnly, Undo: len(d.undo), Redo: len(d.redo)}
}

// BeginCompound starts a group. Nested begins are counted.
func (d *Document) BeginCompound() {
	d.ensure()
	if d.compound == 0 && len(d.undo) > 0 {
		d.undo[len(d.undo)-1].sealed = true
	}
	if d.compound == 0 {
		d.compoundBase = d.Text()
		d.compoundSel = d.Selection()
	}
	d.compound++
	d.compoundAt = len(d.undo)
}

// EndCompound folds every entry recorded since BeginCompound into one undo.
func (d *Document) EndCompound() {
	if d.compound == 0 {
		return
	}
	d.compound--
	if d.compound > 0 {
		return
	}
	before := d.compoundBase
	sel := d.compoundSel
	d.compoundBase = ""
	if before == "" || before == d.Text() {
		return
	}
	joined := historyEntry{
		start: 0, deleted: before, inserted: d.Text(),
		before: sel, after: d.Selection(), at: d.clock(), compound: true, sealed: true,
	}
	d.undo = append(d.undo, joined)
	if len(d.undo) > UndoLimit {
		d.undo = d.undo[len(d.undo)-UndoLimit:]
	}
}

// Indent inserts the indent unit. A selection indents every touched line.
// A caret snaps to the next tab stop.
func (d *Document) Indent() EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	unit := d.indentUnit()
	sel := d.Selection()
	if sel.Base == sel.Extent {
		lineStart := d.LineStart(sel.Extent)
		column := sel.Extent - lineStart
		n := d.tabSize - (column % d.tabSize)
		if n <= 0 {
			n = d.tabSize
		}
		spaces := strings.Repeat(" ", n)
		if !d.useSpaces {
			spaces = "\t"
		}
		d.Insert(sel.Extent, spaces, false)
		return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
	}
	return d.mapLines(sel, func(line string) (string, bool) {
		return unit + line, true
	})
}

// Outdent removes one indent unit, a leading tab, or leftover leading spaces.
func (d *Document) Outdent() EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	unit := d.indentUnit()
	return d.mapLines(d.Selection(), func(line string) (string, bool) {
		switch {
		case strings.HasPrefix(line, unit):
			return line[len(unit):], true
		case strings.HasPrefix(line, "\t"):
			return line[1:], true
		default:
			n := 0
			for n < len(line) && line[n] == ' ' {
				n++
			}
			if n == 0 {
				return line, false
			}
			return line[n:], true
		}
	})
}

func (d *Document) indentUnit() string {
	if d.tabSize <= 0 {
		d.tabSize = 2
	}
	if !d.useSpaces {
		return "\t"
	}
	return strings.Repeat(" ", d.tabSize)
}

func (d *Document) mapLines(sel Selection, fn func(string) (string, bool)) EditResult {
	start, end := ordered(sel.Base, sel.Extent)
	first := d.CharToLine(start)
	last := d.CharToLine(end)
	if end > start && last > first && end == d.LineToChar(last) {
		last--
	}
	changed := false
	d.BeginCompound()
	for line := last; line >= first; line-- {
		bodyStart := d.LineToChar(line)
		bodyEnd := d.LineEnd(bodyStart)
		body := d.Slice(bodyStart, bodyEnd)
		next, ok := fn(body)
		if !ok || next == body {
			continue
		}
		d.Replace(bodyStart, bodyEnd, next, true)
		changed = true
	}
	d.EndCompound()
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: changed}
}

// BreakLine inserts a newline plus the current indent. A line ending in
// : { [ ( gains one extra indent level, and a caret between a bracket pair
// splits onto two indented lines.
func (d *Document) BreakLine() EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	sel := d.Selection()
	start, end := ordered(sel.Base, sel.Extent)
	lineStart := d.LineStart(start)
	before := d.Slice(lineStart, start)
	indent := leadingWhitespace(before)
	if d.useSpaces {
		indent = strings.ReplaceAll(indent, "\t", strings.Repeat(" ", d.tabSizeOrDefault()))
	}
	extra := ""
	if regexp.MustCompile(`[:{(\[]\s*$`).MatchString(before) {
		extra = d.indentUnit()
	}
	insert := "\n" + indent + extra
	after := ""
	if start == end && end < d.LenChars() {
		next := d.Char(end)
		prev := rune(0)
		if start > 0 {
			prev = d.Char(start - 1)
		}
		if isOpenBracket(prev) && isCloseBracket(next) && partners(prev, next) {
			insert = "\n" + indent + extra + "\n" + indent
			after = "pair"
		}
	}
	d.Replace(start, end, insert, false)
	if after == "pair" {
		caret := start + utf8.RuneCountInString("\n"+indent+extra)
		d.SetSelection(caret, caret)
	}
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
}

func (d *Document) tabSizeOrDefault() int {
	if d.tabSize <= 0 {
		return 2
	}
	return d.tabSize
}

func leadingWhitespace(s string) string {
	i := 0
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r != ' ' && r != '\t' {
			break
		}
		i += size
	}
	return s[:i]
}

func isOpenBracket(r rune) bool  { return r == '(' || r == '{' || r == '[' }
func isCloseBracket(r rune) bool { return r == ')' || r == '}' || r == ']' }
func partners(open, close rune) bool {
	return (open == '(' && close == ')') || (open == '{' && close == '}') || (open == '[' && close == ']')
}

// ToggleLineComment comments or uncomments the selected lines. JavaScript
// uses "// "; every other language uses "# ".
func (d *Document) ToggleLineComment(language string) EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	prefix := "# "
	if isJS(language) {
		prefix = "// "
	}
	sel := d.Selection()
	start, end := ordered(sel.Base, sel.Extent)
	first := d.CharToLine(start)
	last := d.CharToLine(end)
	if end > start && last > first && end == d.LineToChar(last) {
		last--
	}
	all := true
	for line := first; line <= last; line++ {
		body := d.lineBody(line)
		trimmed := strings.TrimLeft(body, " \t")
		if trimmed == "" || (!strings.HasPrefix(trimmed, "#") && !strings.HasPrefix(trimmed, "//")) {
			all = false
			break
		}
	}
	d.BeginCompound()
	changed := false
	for line := last; line >= first; line-- {
		bodyStart := d.LineToChar(line)
		bodyEnd := d.LineEnd(bodyStart)
		body := d.Slice(bodyStart, bodyEnd)
		lead := utf8.RuneCountInString(body) - utf8.RuneCountInString(strings.TrimLeft(body, " \t"))
		if all {
			rest := body[lead:]
			remove := 0
			switch {
			case strings.HasPrefix(rest, "// "):
				remove = 3
			case strings.HasPrefix(rest, "//"):
				remove = 2
			case strings.HasPrefix(rest, "# "):
				remove = 2
			case strings.HasPrefix(rest, "#"):
				remove = 1
			}
			if remove == 0 {
				continue
			}
			d.Replace(bodyStart+lead, bodyStart+lead+remove, "", true)
			changed = true
			continue
		}
		d.Replace(bodyStart+lead, bodyStart+lead, prefix, true)
		changed = true
	}
	d.EndCompound()
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: changed}
}

func (d *Document) lineBody(line int) string {
	start := d.LineToChar(line)
	return d.Slice(start, d.LineEnd(start))
}

func isJS(language string) bool {
	switch strings.ToLower(strings.TrimSpace(language)) {
	case "javascript", "js", "typescript", "ts", "jsx", "tsx":
		return true
	default:
		return false
	}
}

// CopyText returns the selection, or the whole current line including its
// break when the selection is a caret.
func (d *Document) CopyText() ClipboardResult {
	sel := d.Selection()
	if sel.Base != sel.Extent {
		start, end := ordered(sel.Base, sel.Extent)
		return ClipboardResult{Text: d.Slice(start, end), Selection: sel}
	}
	line := d.CharToLine(sel.Extent)
	from := d.LineToChar(line)
	to := d.LenChars()
	if line+1 < d.LenLines() {
		to = d.LineToChar(line + 1)
	}
	return ClipboardResult{Text: d.Slice(from, to), Selection: sel}
}

// CutText copies the same range CopyText would, then deletes it.
func (d *Document) CutText() ClipboardResult {
	copied := d.CopyText()
	if d.readOnly {
		copied.ReadOnly = true
		copied.Text = ""
		return copied
	}
	sel := d.Selection()
	var from, to int
	if sel.Base != sel.Extent {
		from, to = ordered(sel.Base, sel.Extent)
	} else {
		line := d.CharToLine(sel.Extent)
		from = d.LineToChar(line)
		to = d.LenChars()
		if line+1 < d.LenLines() {
			to = d.LineToChar(line + 1)
		}
	}
	deleted := d.Slice(from, to)
	d.Replace(from, to, "", false)
	copied.Cut = true
	copied.Changed = deleted != ""
	copied.Text = deleted
	copied.Selection = d.Selection()
	return copied
}

// Paste inserts text, replacing the selection. Empty text changes nothing.
func (d *Document) Paste(text string) EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	if text == "" {
		return EditResult{Text: d.Text(), Selection: d.Selection()}
	}
	sel := d.Selection()
	start, end := ordered(sel.Base, sel.Extent)
	d.Replace(start, end, text, false)
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
}

// Type inserts one committed string and records it for undo. Read-only rejects it.
func (d *Document) Type(offset int, text string) EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	if offset < 0 {
		offset = d.Selection().Extent
	}
	d.Insert(offset, text, false)
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: text != ""}
}

func ordered(a, b int) (int, int) {
	if a > b {
		return b, a
	}
	return a, b
}

// BracketPair inserts the closing partner, skips a closer that is already
// there, or wraps a selection. Quote pairs use the same closer.
func (d *Document) BracketPair(open string) EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	closer, ok := pairOf(open)
	if !ok {
		return EditResult{Text: d.Text(), Selection: d.Selection()}
	}
	sel := d.Selection()
	start, end := ordered(sel.Base, sel.Extent)
	if start != end {
		wrapped := open + d.Slice(start, end) + closer
		d.Replace(start, end, wrapped, false)
		d.SetSelection(start+utf8.RuneCountInString(open), start+utf8.RuneCountInString(wrapped)-utf8.RuneCountInString(closer))
		return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
	}
	if start < d.LenChars() && string(d.Char(start)) == closer {
		d.SetSelection(start+1, start+1)
		return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: false}
	}
	d.Insert(start, open+closer, false)
	d.SetSelection(start+utf8.RuneCountInString(open), start+utf8.RuneCountInString(open))
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
}

func pairOf(open string) (string, bool) {
	switch open {
	case "(":
		return ")", true
	case "{":
		return "}", true
	case "[":
		return "]", true
	case "\"", "'", "`":
		return open, true
	default:
		return "", false
	}
}

// Format reindents every line from bracket depth and drops trailing
// whitespace. A line that starts with a closer drops one level first. A line
// that ends with an opener gains one level after it. Tabs and spaces follow
// the indent unit. One undo restores the whole document.
func (d *Document) Format() EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	unit := d.indentUnit()
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(d.Text(), "\r\n", "\n"), "\r", "\n"), "\n")
	depth := 0
	out := make([]string, 0, len(lines))
	for _, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			out = append(out, "")
			continue
		}
		closes := strings.HasPrefix(trimmed, "}") || strings.HasPrefix(trimmed, "]") || strings.HasPrefix(trimmed, ")")
		if closes {
			if depth > 0 {
				depth--
			}
		}
		out = append(out, strings.Repeat(unit, depth)+trimmed)
		opens := strings.HasSuffix(trimmed, "{") || strings.HasSuffix(trimmed, "[") || strings.HasSuffix(trimmed, "(")
		if opens && !strings.HasPrefix(trimmed, "}") {
			depth++
		}
	}
	next := strings.Join(out, "\n")
	return d.replaceWhole(next)
}

// TrimTrailingWhitespace drops trailing spaces and tabs from every line.
// The line break stays. A document with nothing to trim is unchanged.
func (d *Document) TrimTrailingWhitespace() EditResult {
	if d.readOnly {
		return EditResult{Text: d.Text(), Selection: d.Selection(), ReadOnly: true}
	}
	return d.mapLines(Selection{Base: 0, Extent: d.LenChars()}, func(line string) (string, bool) {
		next := strings.TrimRightFunc(line, func(r rune) bool { return r == ' ' || r == '\t' })
		return next, next != line
	})
}

func (d *Document) replaceWhole(next string) EditResult {
	current := d.Text()
	if next == current {
		return EditResult{Text: current, Selection: d.Selection()}
	}
	d.BeginCompound()
	d.Replace(0, d.LenChars(), next, true)
	d.EndCompound()
	return EditResult{Text: d.Text(), Selection: d.Selection(), Changed: true}
}

// SetUseSpaces chooses spaces or a tab as the indent unit.
func (d *Document) SetUseSpaces(on bool) {
	if d.useSpaces == on && d.spacesSet {
		return
	}
	d.useSpaces = on
	d.spacesSet = true
	d.version++
}

// UseSpaces reports the indent unit. The default is spaces.
func (d *Document) UseSpaces() bool {
	if !d.spacesSet {
		return true
	}
	return d.useSpaces
}

// WordMove returns the next word boundary. dir +1 is forward.
func (d *Document) WordMove(offset, dir int) int {
	rs := []rune(d.Text())
	if offset < 0 {
		offset = 0
	}
	if offset > len(rs) {
		offset = len(rs)
	}
	if dir >= 0 {
		i := offset
		for i < len(rs) && isWord(rs[i]) {
			i++
		}
		for i < len(rs) && !isWord(rs[i]) {
			i++
		}
		if i == offset && i < len(rs) {
			i++
		}
		return i
	}
	i := offset
	for i > 0 && !isWord(rs[i-1]) {
		i--
	}
	for i > 0 && isWord(rs[i-1]) {
		i--
	}
	if i == offset && i > 0 {
		i--
	}
	return i
}

func isWord(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_'
}
