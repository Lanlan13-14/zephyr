// Package permission implements deny/ask/allow rule evaluation.
//
// Precedence: deny > ask > allow > mode fallback.
// Collaboration mode (plan/standard/goal) is orthogonal and filters the tool
// registry before permission runs; this package only decides per-call.
package permission

import (
	"encoding/json"
	"strings"
	"sync"
)

type Decision string

const (
	Allow Decision = "allow"
	Ask   Decision = "ask"
	Deny  Decision = "deny"
)

// Mode is the default when no rule matches.
type Mode string

const (
	ModeAsk  Mode = "ask"
	ModeAuto Mode = "auto" // allow read-only, ask writers
	ModeYolo Mode = "yolo" // allow unless deny (admin-only at control plane)
)

// Rule matches Tool or Tool(pattern) like Bash(rm -rf*).
// Pattern uses path.Match semantics against a stable args fingerprint.
type Rule string

type Policy struct {
	Mode  Mode   `json:"mode"`
	Deny  []Rule `json:"deny,omitempty"`
	Ask   []Rule `json:"ask,omitempty"`
	Allow []Rule `json:"allow,omitempty"`
}

type Request struct {
	Tool     string
	Args     json.RawMessage
	ReadOnly bool
	Risk     string
}

// Engine evaluates policies. Thread-safe.
type Engine struct {
	mu     sync.RWMutex
	policy Policy
}

func NewEngine(p Policy) *Engine {
	if p.Mode == "" {
		p.Mode = ModeAsk
	}
	return &Engine{policy: p}
}

func (e *Engine) Set(p Policy) {
	if p.Mode == "" {
		p.Mode = ModeAsk
	}
	e.mu.Lock()
	e.policy = p
	e.mu.Unlock()
}

func (e *Engine) Get() Policy {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.policy
}

func (e *Engine) Decide(req Request) Decision {
	e.mu.RLock()
	p := e.policy
	e.mu.RUnlock()

	fp := fingerprint(req.Tool, req.Args)
	if matchAny(p.Deny, req.Tool, fp) {
		return Deny
	}
	if matchAny(p.Ask, req.Tool, fp) {
		return Ask
	}
	if matchAny(p.Allow, req.Tool, fp) {
		return Allow
	}
	switch p.Mode {
	case ModeYolo:
		return Allow
	case ModeAuto:
		if req.ReadOnly {
			return Allow
		}
		return Ask
	default:
		if req.ReadOnly {
			return Allow
		}
		return Ask
	}
}

func fingerprint(tool string, args json.RawMessage) string {
	if len(args) == 0 {
		return tool
	}
	// Prefer common command-like fields for pattern matching.
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return tool + "(" + strings.TrimSpace(string(args)) + ")"
	}
	for _, k := range []string{"command", "cmd", "script", "text", "path", "url", "action"} {
		if v, ok := m[k]; ok {
			return tool + "(" + stringify(v) + ")"
		}
	}
	b, _ := json.Marshal(m)
	return tool + "(" + string(b) + ")"
}

func stringify(v any) string {
	switch t := v.(type) {
	case string:
		return t
	default:
		b, _ := json.Marshal(t)
		return string(b)
	}
}

func matchAny(rules []Rule, tool, fp string) bool {
	for _, r := range rules {
		if matchRule(string(r), tool, fp) {
			return true
		}
	}
	return false
}

// matchRule supports:
//   - "tool"           → any call of tool
//   - "tool(*)"        → any args
//   - "tool(pattern)"  → path.Match on full fingerprint after "tool("
func matchRule(rule, tool, fp string) bool {
	rule = strings.TrimSpace(rule)
	if rule == "" {
		return false
	}
	// bare tool name
	if !strings.Contains(rule, "(") {
		return strings.EqualFold(rule, tool) || rule == "*"
	}
	name, rest, ok := strings.Cut(rule, "(")
	if !ok {
		return false
	}
	name = strings.TrimSpace(name)
	if name != "*" && !strings.EqualFold(name, tool) {
		return false
	}
	pat := strings.TrimSuffix(strings.TrimSpace(rest), ")")
	if pat == "" || pat == "*" {
		return true
	}
	// Match against args portion of fingerprint: tool(args)
	argsPart := fp
	if i := strings.Index(fp, "("); i >= 0 {
		argsPart = strings.TrimSuffix(fp[i+1:], ")")
	}
	if globMatch(pat, argsPart) {
		return true
	}
	// Also try full fingerprint
	return globMatch(name+"("+pat+")", fp)
}

// globMatch supports * (any run incl. '/') and ? (single char).
// path.Match is unsuitable: * does not cross '/'.
func globMatch(pattern, s string) bool {
	return globMatchRec(pattern, s)
}

func globMatchRec(pattern, s string) bool {
	for {
		if pattern == "" {
			return s == ""
		}
		switch pattern[0] {
		case '*':
			// greedy + backtrack
			if len(pattern) == 1 {
				return true
			}
			for i := 0; i <= len(s); i++ {
				if globMatchRec(pattern[1:], s[i:]) {
					return true
				}
			}
			return false
		case '?':
			if s == "" {
				return false
			}
			pattern, s = pattern[1:], s[1:]
		default:
			if s == "" || s[0] != pattern[0] {
				return false
			}
			pattern, s = pattern[1:], s[1:]
		}
	}
}
