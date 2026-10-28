package security

import (
	"strings"
	"unicode"
)

// CommandAllowlist is the Cell command gate (spec §9 / test gate 6.2).
// Unknown binaries default deny. This is not a sandbox: it only classifies
// the argv[0] token before PRoot runs.
type CommandAllowlist struct {
	allowed map[string]struct{}
}

// DefaultCellCommands is the conservative interactive/read set. Destructive
// shell metacommands are not on this list.
var DefaultCellCommands = []string{
	"ls", "pwd", "cat", "head", "tail", "echo", "date", "uname",
	"whoami", "id", "env", "printenv", "true", "false",
}

// NewCommandAllowlist builds a denylist-by-default table from exact names.
func NewCommandAllowlist(names []string) *CommandAllowlist {
	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		key := canonicalizeCommand(name)
		if key == "" {
			continue
		}
		allowed[key] = struct{}{}
	}
	return &CommandAllowlist{allowed: allowed}
}

func canonicalizeCommand(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if strings.ContainsAny(trimmed, "/\\") {
		// Paths are not allowlisted by basename; callers must pass argv[0] as a
		// bare command or explicitly add the path.
		return trimmed
	}
	var b strings.Builder
	for _, r := range trimmed {
		if unicode.IsSpace(r) {
			break
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Allow reports whether argv[0] is on the list. Empty/unknown → false.
func (c *CommandAllowlist) Allow(argv0 string) bool {
	if c == nil || c.allowed == nil {
		return false
	}
	key := canonicalizeCommand(argv0)
	if key == "" {
		return false
	}
	_, ok := c.allowed[key]
	return ok
}
