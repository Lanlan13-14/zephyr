package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestListOpenAIModelsStripsCompletionSuffix(t *testing.T) {
	var gotPath, gotAuth, gotOrg string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotOrg = r.Header.Get("OpenAI-Organization")
		_ = json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{
			{"id": "gpt-4o"}, {"id": "gpt-4o-mini", "name": "GPT-4o mini"},
		}})
	}))
	defer srv.Close()

	models, err := listProviderModels(context.Background(), provider.Config{
		Kind: provider.KindOpenAIComp, BaseURL: srv.URL + "/v1/chat/completions",
		APIKey: "sk-test", Organization: "org-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("path=%s", gotPath)
	}
	if gotAuth != "Bearer sk-test" || gotOrg != "org-1" {
		t.Fatalf("auth=%q org=%q", gotAuth, gotOrg)
	}
	if len(models) != 2 || models[0].ID != "gpt-4o" || models[1].Label != "GPT-4o mini" {
		t.Fatalf("models=%+v", models)
	}
}

func TestListOpenAIModelsAcceptsModelsArray(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"models": []map[string]any{{"name": "llama3"}}})
	}))
	defer srv.Close()
	models, err := listProviderModels(context.Background(), provider.Config{Kind: provider.KindOllama, BaseURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models[0].ID != "llama3" {
		t.Fatalf("models=%+v", models)
	}
}

func TestListGeminiModelsFiltersGenerateContent(t *testing.T) {
	var gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotKey = r.URL.Query().Get("key")
		_ = json.NewEncoder(w).Encode(map[string]any{"models": []map[string]any{
			{"name": "models/gemini-2.0-flash", "displayName": "Gemini Flash", "supportedGenerationMethods": []string{"generateContent"}},
			{"name": "models/embedding", "supportedGenerationMethods": []string{"embedContent"}},
		}})
	}))
	defer srv.Close()
	models, err := listProviderModels(context.Background(), provider.Config{
		Kind: provider.KindGemini, BaseURL: srv.URL, APIKey: "gk",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotKey != "gk" {
		t.Fatalf("key=%q", gotKey)
	}
	if len(models) != 1 || models[0].ID != "gemini-2.0-flash" || models[0].Label != "Gemini Flash" {
		t.Fatalf("models=%+v", models)
	}
}

func TestListAnthropicCustomBaseYieldsEmpty(t *testing.T) {
	models, err := listAnthropicModels(context.Background(), provider.Config{
		Kind: provider.KindAnthropic, BaseURL: "https://gateway.internal/v1", APIKey: "x",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 0 {
		t.Fatalf("custom endpoint must own its catalog, got %+v", models)
	}
}

func TestListAnthropicOfficialFallbackWithoutKey(t *testing.T) {
	models, err := listAnthropicModels(context.Background(), provider.Config{Kind: provider.KindAnthropic})
	if err != nil {
		t.Fatal(err)
	}
	if len(models) == 0 || models[0].ID == "" {
		t.Fatalf("expected official fallback, got %+v", models)
	}
}
