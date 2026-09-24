package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
	atransport "github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/transport"
)

// providerModelsReq is the model-discovery payload. It carries a full provider config so the
// caller can list models for an unsaved form draft exactly as the main end's /api/ai/models does.
type providerModelsReq struct {
	Provider   provider.Config `json:"provider"`
	ServerName string          `json:"serverName"`
}

type providerModel struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}

// anthropicOfficialModels is the same fallback the main end returns when the official Anthropic
// catalog is unreachable. A custom Anthropic-compatible endpoint owns its catalog and yields an
// empty list instead, so a third-party provider never inherits official Claude names.
var anthropicOfficialModels = []providerModel{
	{ID: "claude-opus-4-6"},
	{ID: "claude-sonnet-4-6"},
	{ID: "claude-haiku-4-5-20251001"},
	{ID: "claude-sonnet-4-5-20250929"},
	{ID: "claude-opus-4-5-20251101"},
}

func (s *Server) handleProviderModels(w http.ResponseWriter, r *http.Request) {
	var req providerModelsReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"ok": false, "error": "bad json: " + err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	models, err := listProviderModels(ctx, req.Provider, req.ServerName)
	if err != nil {
		writeJSON(w, 502, map[string]any{"ok": false, "code": "models_unavailable", "error": err.Error()})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "models": models})
}

// clientProxyHost returns the original hostname a modelsHTTPClient restores for SNI/Host.
func clientProxyHost(client *http.Client) (string, bool) {
	if client == nil || client.Transport == nil {
		return "", false
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport == nil || transport.TLSClientConfig == nil {
		return "", false
	}
	name := strings.TrimSpace(transport.TLSClientConfig.ServerName)
	if name == "" {
		return "", false
	}
	return name, true
}

// listProviderModels mirrors the main end's listProviderModels: same URL rules per vendor, same
// response shapes, and the same "custom Anthropic endpoint owns its catalog" boundary.
//
// serverName carries the original hostname when the caller pre-resolved DNS for the CGO-less
// Android build: the BaseURL then dials an IP literal while TLS SNI and the HTTP Host header
// must keep the real name (same pattern as the Link core's dial route).
func listProviderModels(ctx context.Context, cfg provider.Config, serverName string) ([]providerModel, error) {
	client := modelsHTTPClient(serverName)
	switch provider.NormalizeKind(cfg.Kind) {
	case provider.KindAnthropic:
		return listAnthropicModels(ctx, cfg, client)
	default:
		return listOpenAIModels(ctx, cfg, client)
	}
}

// modelsHTTPClient returns a client that restores the original Host header and TLS SNI when the
// URL host is an IP literal rewritten by the caller's DNS pre-resolution.
// New callers should prefer transport.NewClient with an explicit TransportTarget; this stays
// for the legacy serverName-only path and delegates to the same dial logic.
func modelsHTTPClient(serverName string) *http.Client {
	name := strings.TrimSpace(serverName)
	if name == "" {
		return &http.Client{Timeout: 30 * time.Second}
	}
	return atransport.NewClient(atransport.Target{
		EffectiveHost:    name,
		EffectivePort:    443,
		TLSServerName:    name,
		ResolutionSource: "literal",
		DialTimeoutMs:    8000,
	}, atransport.DefaultPolicy(), 30*time.Second)
}

func listOpenAIModels(ctx context.Context, cfg provider.Config, client *http.Client) ([]providerModel, error) {
	base := strings.TrimRight(cfg.BaseURL, "/")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	// A base that points at the completion path lists models from its root instead.
	for _, suffix := range []string{"/chat/completions", "/responses"} {
		base = strings.TrimSuffix(base, suffix)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/models", nil)
	if err != nil {
		return nil, err
	}
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	if cfg.Organization != "" {
		if strings.HasPrefix(strings.ToLower(cfg.Organization), "proj") {
			req.Header.Set("OpenAI-Project", cfg.Organization)
		} else {
			req.Header.Set("OpenAI-Organization", cfg.Organization)
		}
	}
	for k, v := range cfg.ExtraHeaders {
		if k != "" && v != "" && !strings.EqualFold(k, "authorization") {
			req.Header.Set(k, v)
		}
	}
	body, err := doModelsRequest(ctx, client, req)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Data   []map[string]any `json:"data"`
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("models response not json: %w", err)
	}
	rows := parsed.Data
	if len(rows) == 0 {
		rows = parsed.Models
	}
	out := make([]providerModel, 0, len(rows))
	for _, row := range rows {
		id, _ := row["id"].(string)
		if id == "" {
			id, _ = row["name"].(string)
		}
		if id == "" {
			continue
		}
		label, _ := row["name"].(string)
		out = append(out, providerModel{ID: id, Label: label})
	}
	return out, nil
}

func listAnthropicModels(ctx context.Context, cfg provider.Config, client *http.Client) ([]providerModel, error) {
	// The Android caller may pre-resolve DNS and dial an IP literal; serverName keeps the real
	// host, so official-endpoint detection must consult it before the (rewritten) BaseURL.
	officialHost := cfg.BaseURL
	if target, ok := clientProxyHost(client); ok {
		officialHost = "https://" + target + "/v1"
	}
	if !isOfficialAnthropicBase(officialHost) {
		return []providerModel{}, nil
	}
	if cfg.APIKey == "" {
		return anthropicOfficialModels, nil
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.anthropic.com/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", cfg.APIKey)
	req.Header.Set("anthropic-version", "2023-06-01")
	for k, v := range cfg.ExtraHeaders {
		if k != "" && v != "" && !strings.EqualFold(k, "x-api-key") {
			req.Header.Set(k, v)
		}
	}
	body, err := doModelsRequest(ctx, client, req)
	if err != nil {
		return anthropicOfficialModels, nil
	}
	var parsed struct {
		Data []struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Data) == 0 {
		return anthropicOfficialModels, nil
	}
	out := make([]providerModel, 0, len(parsed.Data))
	for _, m := range parsed.Data {
		if m.ID == "" {
			continue
		}
		label := m.DisplayName
		if label == "" {
			label = m.ID
		}
		out = append(out, providerModel{ID: m.ID, Label: label})
	}
	if len(out) == 0 {
		return anthropicOfficialModels, nil
	}
	return out, nil
}

func isOfficialAnthropicBase(baseURL string) bool {
	raw := strings.TrimSpace(baseURL)
	if raw == "" {
		return true
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), "api.anthropic.com")
}

func doModelsRequest(ctx context.Context, client *http.Client, req *http.Request) ([]byte, error) {
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("models endpoint returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 4<<20))
}
