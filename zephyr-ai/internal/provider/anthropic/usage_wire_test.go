package anthropic

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestUsageIncludesCacheCreationAndReadTokens(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":30,"output_tokens":5,"cache_creation_input_tokens":20,"cache_read_input_tokens":50}}`))
	}))
	defer upstream.Close()
	p := New(provider.Config{BaseURL: upstream.URL})
	chunks, err := p.Stream(context.Background(), provider.Request{Model: "m", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatal(err)
	}
	for chunk := range chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		if chunk.Usage != nil {
			u := chunk.Usage
			if u.InputTokens != 30 || u.OutputTokens != 5 || u.CacheCreationTokens != 20 || u.CacheReadTokens != 50 || u.LatestContextTokens != 30 {
				t.Fatalf("unexpected usage: %+v", u)
			}
			return
		}
	}
	t.Fatal("usage chunk missing")
}
