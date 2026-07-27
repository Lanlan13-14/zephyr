package openai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestChatCompletionSerializesImageParts(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()
	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o"})
	req := provider.Request{Messages: []provider.Message{{
		Role:    provider.RoleUser,
		Content: "观察图片",
		Parts: []provider.ContentPart{
			{Type: "text", Text: "观察图片"},
			{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
		},
	}}}
	ch, err := c.Stream(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for range ch {
	}
	msgs, ok := body["messages"].([]any)
	if !ok || len(msgs) != 1 {
		t.Fatalf("messages missing: %v", body)
	}
	msg, _ := msgs[0].(map[string]any)
	content, ok := msg["content"].([]any)
	if !ok {
		t.Fatalf("content should be array for image parts: %v", msg)
	}
	foundImage := false
	for _, part := range content {
		pm, _ := part.(map[string]any)
		if pm["type"] == "image_url" {
			foundImage = true
		}
	}
	if !foundImage {
		t.Fatalf("image_url part missing: %v", content)
	}
}

func TestResponsesSerializesImageParts(t *testing.T) {
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\nevent: response.completed\ndata: {}\n\n"))
	}))
	defer srv.Close()
	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o", APIMode: "responses"})
	req := provider.Request{Messages: []provider.Message{{
		Role:    provider.RoleUser,
		Content: "观察图片",
		Parts: []provider.ContentPart{
			{Type: "text", Text: "观察图片"},
			{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
		},
	}}}
	ch, err := c.Stream(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	for range ch {
	}
	input, ok := body["input"].([]any)
	if !ok || len(input) != 1 {
		t.Fatalf("input missing: %v", body)
	}
	item, _ := input[0].(map[string]any)
	content, ok := item["content"].([]any)
	if !ok {
		t.Fatalf("content should be array: %v", item)
	}
	foundImage := false
	for _, part := range content {
		pm, _ := part.(map[string]any)
		if pm["type"] == "input_image" {
			foundImage = true
		}
	}
	if !foundImage {
		t.Fatalf("input_image part missing: %v", content)
	}
}

func TestVisionRequestEndsStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()
	c := New(provider.Config{BaseURL: srv.URL, APIKey: "k", DefaultModel: "gpt-4o"})
	ch, err := c.Stream(context.Background(), provider.Request{Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatal(err)
	}
	var texts []string
	for chunk := range ch {
		if chunk.Text != "" {
			texts = append(texts, chunk.Text)
		}
	}
	if !strings.Contains(strings.Join(texts, ""), "ok") {
		t.Fatalf("expected ok, got %v", texts)
	}
}
