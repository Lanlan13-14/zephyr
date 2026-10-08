// Package guides computes indent-guide blocks for a viewport.
//
// The scan follows CodeForge's guides_compute_viewport, including its bracket
// and opening-tag rules. Results are not cached by text length. Callers pass
// the document version they observed; a new version is a new call.
package guides

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/Lanlan13-14/zephyr-ssh/editorcore/brackets"
	"github.com/Lanlan13-14/zephyr-ssh/editorcore/rope"
)

// Block is one guide. StartLine is the opening line. EndLine is exclusive and
// is the line after the last line the guide covers.
type Block struct {
	StartLine     int `json:"startLine"`
	EndLine       int `json:"endLine"`
	IndentLevel   int `json:"indentLevel"`
	LeadingSpaces int `json:"leadingSpaces"`
}

const scanBackLimit = 500

// Compute returns guides whose opening line is inside [scanStart, last] where
// scanStart reaches at most 500 lines before firstVisible. The document is
// read only through rope; nothing is memoised here.
func Compute(doc rope.Rope, firstVisible, lastVisible, tabSize int) []Block {
	total := doc.LenLines()
	if total == 0 {
		return []Block{}
	}
	lastLine := total - 1
	if firstVisible < 0 {
		firstVisible = 0
	}
	if firstVisible > lastLine {
		firstVisible = lastLine
	}
	if lastVisible < 0 {
		lastVisible = 0
	}
	if lastVisible > lastLine {
		lastVisible = lastLine
	}
	scanStart := 0
	if firstVisible > scanBackLimit {
		scanStart = firstVisible - scanBackLimit
	}
	if lastVisible < scanStart {
		return []Block{}
	}
	out := make([]Block, 0)
	for line := scanStart; line <= lastVisible; line++ {
		raw := []rune(lineContent(doc, line))
		content := trimRightSpace(raw)
		if len(content) == 0 {
			continue
		}
		last := content[len(content)-1]
		tag := openingTagName(string(content))
		if last != '{' && last != '(' && last != '[' && last != ':' && tag == "" {
			continue
		}
		leading := leadingCols(content, tabSize)
		end := line + 1
		switch {
		case last == '{' || last == '(' || last == '[':
			lineStart := doc.LineToChar(line)
			bracketAt := lineStart + len(content) - 1
			if match := brackets.Match(runesOf(doc), bracketAt); match >= 0 {
				end = doc.CharToLine(match) + 1
			}
		case tag != "":
			if matchLine := closingTagLine(doc, line, tag); matchLine >= 0 {
				end = matchLine + 1
			}
		}
		if end <= line+1 {
			end = indentExtent(doc, line, leading, tabSize)
		}
		if end <= line+1 {
			continue
		}
		if crossed(doc, line, end, leading, tabSize) {
			continue
		}
		level := 0
		if tabSize > 0 {
			level = leading / tabSize
		}
		out = append(out, Block{
			StartLine:     line,
			EndLine:       end,
			IndentLevel:   level,
			LeadingSpaces: leading,
		})
	}
	return out
}

func lineContent(doc rope.Rope, line int) string { return doc.Line(line) }

func runesOf(doc rope.Rope) []rune { return []rune(doc.String()) }

func trimRightSpace(rs []rune) []rune {
	end := len(rs)
	for end > 0 && unicode.IsSpace(rs[end-1]) {
		end--
	}
	return rs[:end]
}

func leadingCols(rs []rune, tabSize int) int {
	cols := 0
	for _, c := range rs {
		switch c {
		case ' ':
			cols++
		case '\t':
			cols += tabWidth(cols, tabSize)
		default:
			return cols
		}
	}
	return cols
}

func tabWidth(cols, tabSize int) int {
	if tabSize <= 0 {
		return 1
	}
	rem := cols % tabSize
	if rem == 0 {
		return tabSize
	}
	return tabSize - rem
}

func indentExtent(doc rope.Rope, line, leading, tabSize int) int {
	total := doc.LenLines()
	scan := line + 1
	lastValid := line
	for scan < total {
		body := trimRightSpace([]rune(doc.Line(scan)))
		if len(body) == 0 {
			scan++
			continue
		}
		next := leadingCols(body, tabSize)
		if next <= leading {
			break
		}
		lastValid = scan
		scan++
	}
	return lastValid + 1
}

func crossed(doc rope.Rope, line, end, leading, tabSize int) bool {
	for check := line + 1; check < end-1; check++ {
		body := trimRightSpace([]rune(doc.Line(check)))
		if len(body) == 0 {
			continue
		}
		if leadingCols(body, tabSize) <= leading {
			return true
		}
	}
	return false
}

func openingTagName(line string) string {
	trimmed := strings.TrimRightFunc(line, unicode.IsSpace)
	if !strings.HasSuffix(trimmed, ">") || strings.HasSuffix(trimmed, "/>") || strings.HasSuffix(trimmed, "-->") {
		return ""
	}
	start := strings.IndexByte(trimmed, '<')
	if start < 0 || start+1 >= len(trimmed) {
		return ""
	}
	rest := trimmed[start+1:]
	r, size := utf8.DecodeRuneInString(rest)
	if r == utf8.RuneError || !isASCIILetter(r) {
		return ""
	}
	name := rest[:size]
	for _, ch := range rest[size:] {
		if isASCIILetter(ch) || isASCIIDigit(ch) || ch == ':' || ch == '_' || ch == '-' {
			name += string(ch)
			continue
		}
		break
	}
	return name
}

func closingTagLine(doc rope.Rope, start int, tag string) int {
	depth := 1
	for line := start + 1; line < doc.LenLines(); line++ {
		trimmed := strings.TrimSpace(doc.Line(line))
		if trimmed == "" {
			continue
		}
		if opensTag(trimmed, tag) {
			depth++
		}
		if strings.Contains(trimmed, "</"+tag) {
			depth--
			if depth == 0 {
				return line
			}
		}
	}
	return -1
}

func opensTag(line, tag string) bool {
	return strings.Contains(line, "<"+tag) && !strings.Contains(line, "</"+tag) && !strings.HasSuffix(line, "/>")
}

func isASCIILetter(r rune) bool { return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') }
func isASCIIDigit(r rune) bool  { return r >= '0' && r <= '9' }
