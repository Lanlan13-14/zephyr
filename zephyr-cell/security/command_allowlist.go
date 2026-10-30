package security

import "strings"

// CommandAllowlist is a narrow gate, not a sandbox. Session.Exec still takes
// a shell string rather than structured argv, so permit bare commands only.
type CommandAllowlist struct {
	allowed map[string]struct{}
}

// DefaultCellCommands cannot chain another command or accept shell arguments.
var DefaultCellCommands = []string{
	"ls", "pwd", "cat", "head", "tail", "echo", "date", "uname",
	"whoami", "id", "env", "printenv", "true", "false",
}

func canonicalizeCommand(raw string) string {
	command := strings.TrimSpace(raw)
	for _, r := range command {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
			(r >= '0' && r <= '9') || r == '_' || r == '-' {
			continue
		}
		return ""
	}
	return command
}

// NewCommandAllowlist builds an exact, deny-by-default command table.
func NewCommandAllowlist(names []string) *CommandAllowlist {
	allowed := make(map[string]struct{}, len(names))
	for _, name := range names {
		if key := canonicalizeCommand(name); key != "" {
			allowed[key] = struct{}{}
		}
	}
	return &CommandAllowlist{allowed: allowed}
}

func (c *CommandAllowlist) Allow(command string) bool {
	if c == nil || c.allowed == nil {
		return false
	}
	key := canonicalizeCommand(command)
	if key == "" {
		return false
	}
	_, ok := c.allowed[key]
	return ok
}
