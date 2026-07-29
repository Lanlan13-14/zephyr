package openai

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func collectUsage(t *testing.T, chunks <-chan provider.Chunk) *provider.Usage {
	t.Helper()
	for chunk := range chunks {
		if chunk.Err != nil {
			t.Fatal(chunk.Err)
		}
		if chunk.Usage != nil {
			return chunk.Usage
		}
	}
	t.Fatal("usage chunk missing")
	return nil
}

func TestChatUsageIncludesCachedTokens(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		f := bufio.NewWriter(w)
		fmt.Fprint(f, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
		fmt.Fprint(f, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":8,\"total_tokens\":128,\"prompt_tokens_details\":{\"cached_tokens\":70}}}\n\n")
		fmt.Fprint(f, "data: [DONE]\n\n")
		f.Flush()
	}))
	defer upstream.Close()
	p := New(provider.Config{BaseURL: upstream.URL, APIMode: "chat_completions"})
	chunks, err := p.Stream(context.Background(), provider.Request{Model: "m", Messages: []provider.Message{{Role: provider.RoleUser, Content: "hi"}}, Stream: true})
	if err != nil {
		t.Fatal(err)
	}
	usage := collectUsage(t, chunks)
	if usage.InputTokens != 50 || usage.OutputTokens != 8 || usage.CacheReadTokens != 70 || usage.LatestContextTokens != 120 {
		t.Fatalf("unexpected usage: %+v", usage)
	}
}
