// Package adapters hosts one independent wire-protocol adapter per
// Contract v2 ProviderAPI value. Shared HTTP/option helpers live in the
// parent adapters package; each subpackage owns exactly one wire format and
// registers exactly one ProviderAPI. No cross-protocol switch survives here.
package adapters

import (
	"net/http"
	"strings"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/transport"
)

// Base is the shared HTTP core every wire adapter embeds.
type Base struct {
	Cfg    provider.Config
	Client *http.Client
}

// NewBase builds the transport-bound client from cfg.
func NewBase(cfg provider.Config) Base {
	timeout := time.Duration(cfg.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	return Base{Cfg: cfg, Client: transport.NewClient(cfg.Transport, transport.DefaultPolicy(), timeout)}
}

// Do sends req through the pre-resolved dial target when present: the URL
// host is rewritten to the dial IP while TLS SNI and the Host header keep
// the original provider hostname.
func (b *Base) Do(req *http.Request) (*http.Response, error) {
	if len(b.Cfg.Transport.DialTargets) > 0 {
		req = b.Cfg.Transport.RewriteRequest(req)
	}
	return b.Client.Do(req)
}

// JoinURL appends suffix unless base already ends with it.
func JoinURL(base, suffix string) string {
	b := strings.TrimRight(base, "/")
	if b == "" {
		b = "https://api.openai.com/v1"
	}
	if strings.HasSuffix(b, suffix) {
		return b
	}
	s := suffix
	if !strings.HasPrefix(s, "/") {
		s = "/" + s
	}
	return b + s
}

// Headers builds the OpenAI-family headers (Bearer + org/project + extras).
func Headers(cfg provider.Config) http.Header {
	h := make(http.Header)
	h.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		h.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	if cfg.Organization != "" {
		h.Set("OpenAI-Organization", cfg.Organization)
	}
	for k, v := range cfg.ExtraHeaders {
		if k != "" && v != "" {
			h.Set(k, v)
		}
	}
	return h
}

func ApplyOptions(payload map[string]any, opts map[string]any, mode string) {
	if opts == nil {
		return
	}
	responses := mode == "responses"

	// Number-valued sampling keys shared by both modes. temperature/top_p
	// are accepted by both, but OpenAI rejects them for reasoning models;
	// callers already omit via sanitizeThinkingOptions, and -1/empty is
	// dropped here as well.
	for _, k := range []string{"temperature", "top_p"} {
		if v, ok := opts[k]; ok && !isEmptyOption(v) {
			payload[k] = v
		}
	}
	if responses {
		// Responses API uses max_output_tokens (not max_tokens /
		// max_completion_tokens).
		if v, ok := opts["max_output_tokens"]; ok && !isEmptyOption(v) {
			payload["max_output_tokens"] = v
		} else if v, ok := opts["max_tokens"]; ok && !isEmptyOption(v) {
			payload["max_output_tokens"] = v
		}
		// reasoning is an object {effort} on Responses; never a top-level
		// string.
		if v, ok := opts["reasoning"]; ok && !isEmptyOption(v) {
			if r, ok := v.(map[string]any); ok {
				payload["reasoning"] = r
			}
		}
		// seed is accepted by Responses; response_format, stop, n,
		// presence/frequency penalty, and max_completion_tokens are NOT.
		if v, ok := opts["seed"]; ok && !isEmptyOption(v) {
			payload["seed"] = v
		}
		return
	}

	// Chat Completions mode.
	for _, k := range []string{
		"max_tokens", "max_completion_tokens",
		"presence_penalty", "frequency_penalty",
		"reasoning_effort", "response_format", "seed", "stop", "n",
	} {
		if v, ok := opts[k]; ok && !isEmptyOption(v) {
			payload[k] = v
		}
	}
	if v, ok := opts["reasoning"]; ok && !isEmptyOption(v) {
		payload["reasoning"] = v
	}
	// max_output_tokens -> max_tokens alias
	if _, ok := payload["max_tokens"]; !ok {
		if v, ok := opts["max_output_tokens"]; ok && !isEmptyOption(v) {
			payload["max_tokens"] = v
		}
	}
}
func isEmptyOption(v any) bool {
	switch x := v.(type) {
	case nil:
		return true
	case string:
		return x == ""
	case float64:
		return x == -1
	case int:
		return x == -1
	case int64:
		return x == -1
	}
	return false
}
