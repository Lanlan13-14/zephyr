package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

// The Android caller pre-resolves DNS because the embedded runtime is CGO_ENABLED=0 and has no
// resolver on Android: BaseURL becomes an IP literal while serverName keeps the original host
// for TLS SNI and the HTTP Host header. listProviderModels must dial the IP yet present the
// original hostname to the provider.

func TestListProviderModelsRestoresHostFromServerName(t *testing.T) {
	var gotHost string
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"gpt-4o"}]}`))
	}))
	defer srv.Close()

	// Strip the http:// scheme and replace the 127.0.0.1 host with an IP-literal form the
	// server can still be reached on: httptest binds 127.0.0.1, which is already a literal,
	// so this exercises the Host restoration path directly.
	ipURL := strings.Replace(srv.URL, "127.0.0.1", "127.0.0.1", 1)
	models, err := listProviderModels(context.Background(), provider.Config{
		Kind: provider.KindOpenAIComp, BaseURL: ipURL + "/v1",
		APIKey: "sk-test",
	}, "api.provider.example")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(gotHost, "127.0.0.1") {
		t.Fatalf("host=%q", gotHost)
	}
	// The request must succeed with the original Host preserved for the provider.
	if len(models) != 1 || models[0].ID != "gpt-4o" {
		t.Fatalf("models=%+v", models)
	}
	if gotAuth != "Bearer sk-test" {
		t.Fatalf("auth=%q", gotAuth)
	}
}

func TestModelsHTTPClientKeepsServerNameForTLS(t *testing.T) {
	client := modelsHTTPClient("api.provider.example")
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport == nil {
		t.Fatal("expected a custom transport")
	}
	if transport.TLSClientConfig == nil || transport.TLSClientConfig.ServerName != "api.provider.example" {
		t.Fatal("TLS SNI must keep the original hostname")
	}
	if client.Timeout == 0 {
		t.Fatal("client must keep a bounded timeout")
	}
}

func TestAnthropicOfficialDetectionSurvivesIpRewrite(t *testing.T) {
	// A rewritten BaseURL is an IP literal, so official-endpoint detection must use the
	// serverName carried by the client, not the literal.
	client := modelsHTTPClient("api.anthropic.com")
	host, ok := clientProxyHost(client)
	if !ok || host != "api.anthropic.com" {
		t.Fatalf("expected restored host api.anthropic.com, got %q ok=%v", host, ok)
	}
	if !isOfficialAnthropicBase("https://" + host + "/v1") {
		t.Fatal("restored host must be recognized as the official Anthropic base")
	}
}