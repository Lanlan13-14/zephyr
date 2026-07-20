package provider

import (
	"fmt"
	"strings"
	"sync"
)

var (
	regMu     sync.RWMutex
	factories = map[Kind]Factory{}
)

// Register adds a factory for a kind. Safe for init().
func Register(kind Kind, f Factory) {
	if f == nil {
		panic("provider: nil factory")
	}
	regMu.Lock()
	defer regMu.Unlock()
	factories[kind] = f
}

// New instantiates a provider by kind.
func New(cfg Config) (Provider, error) {
	kind := NormalizeKind(cfg.Kind)
	cfg.Kind = kind
	regMu.RLock()
	f, ok := factories[kind]
	regMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("provider: unknown kind %q", kind)
	}
	return f(cfg)
}

// NormalizeKind maps aliases to canonical kinds.
func NormalizeKind(k Kind) Kind {
	s := strings.ToLower(strings.TrimSpace(string(k)))
	switch s {
	case "openai", "openai-compatible", "openai_compatible", "ollama":
		if s == "ollama" {
			return KindOllama
		}
		if s == "openai" {
			return KindOpenAI
		}
		return KindOpenAIComp
	case "anthropic", "claude":
		return KindAnthropic
	case "gemini", "google", "google-gemini":
		return KindGemini
	default:
		if s == "" {
			return KindOpenAIComp
		}
		return Kind(s)
	}
}

// KnownKinds returns registered kinds.
func KnownKinds() []Kind {
	regMu.RLock()
	defer regMu.RUnlock()
	out := make([]Kind, 0, len(factories))
	for k := range factories {
		out = append(out, k)
	}
	return out
}
