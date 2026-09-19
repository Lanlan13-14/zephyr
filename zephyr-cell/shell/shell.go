// Package shell implements persistent shell session management (§6.2 rule 2).
//
// Key behaviors:
//   - Commands run in a long-lived shell process; cwd/env persist across calls
//   - Prompt regex detection determines command completion
//   - Shell death → auto-rebuild + bind mount restore + audit record
//   - Env snapshot injection: full snapshot each exec; deleted keys are unset
//   - Generation tracking prevents stale shell references
package shell

import (
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

// PromptDetector detects shell prompt patterns to determine when a command
// has completed in a persistent shell session.
type PromptDetector struct {
	patterns []*regexp.Regexp
}

// DefaultPromptPatterns returns the standard prompt detection patterns.
// These cover common sh/bash/zsh/ash prompts in the Alpine guest.
func DefaultPromptPatterns() []string {
	return []string{
		`(?m)^[\w.-]+@[\w.-]+[#$%>]\s*$`, // user@host# or user@host$
		`(?m)^/ #\s*$`,                     // Alpine ash root
		`(?m)^~ #\s*$`,                     // Alpine ash home
		`(?m)^[\w/.-]+ #\s*$`,             // path #
		`(?m)^[\w/.-]+ \$\s*$`,            // path $
		`(?m)^\([\w.-]+\)\s*[\w/.-]+[#$]\s*$`, // (venv) path$
		`(?m)^[\w.-]+[#$]\s*$`,            // hostname# or hostname$
	}
}

// NewPromptDetector creates a detector with the given regex patterns.
func NewPromptDetector(patterns []string) (*PromptDetector, error) {
	d := &PromptDetector{
		patterns: make([]*regexp.Regexp, 0, len(patterns)),
	}
	for _, p := range patterns {
		re, err := regexp.Compile(p)
		if err != nil {
			return nil, fmt.Errorf("shell: invalid prompt pattern %q: %w", p, err)
		}
		d.patterns = append(d.patterns, re)
	}
	return d, nil
}

// Detect returns true if the given output chunk ends with a recognized prompt.
func (d *PromptDetector) Detect(output []byte) bool {
	for _, re := range d.patterns {
		if re.Match(output) {
			return true
		}
	}
	return false
}

// PersistentShell manages a long-lived shell process within a session.
type PersistentShell struct {
	mu sync.Mutex

	sessionID  string
	generation atomic.Uint64
	alive      atomic.Bool
	startedAt  time.Time
	rebuildCount atomic.Int64

	// Env tracking for snapshot injection
	lastEnvKeys map[string]struct{}

	// Prompt detection
	promptDetector *PromptDetector
}

// NewPersistentShell creates a new persistent shell manager.
func NewPersistentShell(sessionID string) (*PersistentShell, error) {
	detector, err := NewPromptDetector(DefaultPromptPatterns())
	if err != nil {
		return nil, err
	}

	ps := &PersistentShell{
		sessionID:      sessionID,
		lastEnvKeys:    make(map[string]struct{}),
		promptDetector: detector,
	}
	ps.generation.Store(1)
	return ps, nil
}

// Generation returns the current shell generation number.
// Incremented each time the shell is rebuilt.
func (ps *PersistentShell) Generation() uint64 {
	return ps.generation.Load()
}

// IsAlive reports whether the shell process is running.
func (ps *PersistentShell) IsAlive() bool {
	return ps.alive.Load()
}

// RebuildCount returns how many times the shell has been rebuilt.
func (ps *PersistentShell) RebuildCount() int64 {
	return ps.rebuildCount.Load()
}

// MarkAlive marks the shell as running.
func (ps *PersistentShell) MarkAlive() {
	ps.alive.Store(true)
	ps.startedAt = time.Now()
}

// MarkDead marks the shell as dead and increments the generation.
// Returns the new generation number.
func (ps *PersistentShell) MarkDead() uint64 {
	ps.alive.Store(false)
	newGen := ps.generation.Add(1)
	ps.rebuildCount.Add(1)
	return newGen
}

// EnvDiff computes the environment changes needed to synchronize the shell
// with a new env snapshot (§3.3 discipline: deleted keys must be unset).
//
// Returns:
//   - toSet: key=value pairs to export
//   - toUnset: keys to unset (were in previous snapshot but not in current)
func (ps *PersistentShell) EnvDiff(newEnv map[string]string) (toSet map[string]string, toUnset []string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()

	toSet = make(map[string]string, len(newEnv))
	for k, v := range newEnv {
		toSet[k] = v
	}

	// Find keys that were previously set but are now gone
	for k := range ps.lastEnvKeys {
		if _, exists := newEnv[k]; !exists {
			toUnset = append(toUnset, k)
		}
	}

	// Update tracking
	ps.lastEnvKeys = make(map[string]struct{}, len(newEnv))
	for k := range newEnv {
		ps.lastEnvKeys[k] = struct{}{}
	}

	return toSet, toUnset
}

// BuildEnvCommands generates shell commands to synchronize the environment.
// This produces export and unset commands for a persistent shell.
func BuildEnvCommands(toSet map[string]string, toUnset []string) string {
	var cmd string
	for _, k := range toUnset {
		cmd += fmt.Sprintf("unset %s; ", k)
	}
	for k, v := range toSet {
		cmd += fmt.Sprintf("export %s=%q; ", k, v)
	}
	return cmd
}

// IsPrompt checks if the output ends with a recognized shell prompt.
func (ps *PersistentShell) IsPrompt(output []byte) bool {
	return ps.promptDetector.Detect(output)
}

// StripEcho removes the echoed command from PTY output.
// In a PTY, the shell echoes the command back; this strips it for clean output.
func StripEcho(output []byte, cmd string) []byte {
	cmdBytes := []byte(cmd)
	// Check if output starts with the command (possibly with \r\n)
	if len(output) >= len(cmdBytes) {
		prefix := output[:len(cmdBytes)]
		if string(prefix) == cmd {
			output = output[len(cmdBytes):]
			// Strip leading \r\n
			for len(output) > 0 && (output[0] == '\r' || output[0] == '\n') {
				output = output[1:]
			}
		}
	}
	return output
}
