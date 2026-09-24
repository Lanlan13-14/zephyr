package provider

import (
	"fmt"
	"strings"
	"sync"
)

var (
	regMu     sync.RWMutex
	factories = map[Kind]Factory{}

	adapterMu        sync.RWMutex
	adapterFactories = map[API]Factory{}
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
//
// Compat shim over NewAdapter: legacy callers pass only a kind, so the mode
// defaults to auto (chat for OpenAI-family, messages for Anthropic). New code
// must call NewAdapter with an explicit APIMode.
func New(cfg Config) (Provider, error) {
	return NewAdapter(cfg)
}

// NormalizeKind maps aliases to canonical kinds.
func NormalizeKind(k Kind) Kind {
	s := strings.ToLower(strings.TrimSpace(string(k)))
	switch s {
	case "openai", "openai-compatible", "openai_compatible":
		if s == "openai" {
			return KindOpenAI
		}
		return KindOpenAIComp
	case "anthropic", "claude":
		return KindAnthropic
	default:
		if s == "" {
			return KindOpenAIComp
		}
		return Kind(s)
	}
}

// API is one Contract v2 wire protocol. Each adapter package registers
// exactly one API; the kind+apiMode switch is gone.
type API string

const (
	APIOpenAIChat        API = "openai-chat-completions"
	APIOpenAIResponses   API = "openai-responses"
	APIAnthropicMessages API = "anthropic-messages"
)

// RegisterAdapter adds a factory for one wire protocol. Safe for init().
func RegisterAdapter(api API, f Factory) {
	if f == nil {
		panic("provider: nil adapter factory")
	}
	adapterMu.Lock()
	defer adapterMu.Unlock()
	adapterFactories[api] = f
}

// ResolveAPI maps kind+apiMode to exactly one wire adapter. No fallback
// chain: an explicit apiMode that names no adapter is a config error, never
// a silent downgrade to another protocol.
func ResolveAPI(kind Kind, apiMode string) (API, error) {
	k := NormalizeKind(kind)
	mode := strings.ToLower(strings.TrimSpace(apiMode))
	switch k {
	case KindAnthropic:
		if mode != "" && mode != "auto" && mode != "native" && mode != "messages" {
			return "", fmt.Errorf("provider: apiMode %q is not an Anthropic wire protocol", apiMode)
		}
		return APIAnthropicMessages, nil
	case KindOpenAI, KindOpenAIComp:
		switch mode {
		case "", "auto", "chat":
			return APIOpenAIChat, nil
		case "responses":
			return APIOpenAIResponses, nil
		default:
			return "", fmt.Errorf("provider: apiMode %q is not an OpenAI wire protocol", apiMode)
		}
	default:
		return "", fmt.Errorf("provider: unknown kind %q", kind)
	}
}

// NewAdapter instantiates exactly one wire adapter for kind+apiMode.
func NewAdapter(cfg Config) (Provider, error) {
	api, err := ResolveAPI(cfg.Kind, cfg.APIMode)
	if err != nil {
		return nil, err
	}
	adapterMu.RLock()
	f, ok := adapterFactories[api]
	adapterMu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("provider: no adapter registered for %q", api)
	}
	return f(cfg)
}

// KnownAPIs returns registered wire protocols.
func KnownAPIs() []API {
	adapterMu.RLock()
	defer adapterMu.RUnlock()
	out := make([]API, 0, len(adapterFactories))
	for k := range adapterFactories {
		out = append(out, k)
	}
	return out
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
