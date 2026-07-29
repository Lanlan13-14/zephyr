package openai

import (
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestInternalVisualObservationNameDoesNotLeakToOpenAIWire(t *testing.T) {
	messages := toChatMessages([]provider.Message{{
		Role: provider.RoleUser,
		Name: "zephyr.visual_observation",
		Parts: []provider.ContentPart{
			{Type: "text", Text: "observe"},
			{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
		},
	}})
	if len(messages) != 1 {
		t.Fatalf("messages=%d", len(messages))
	}
	if messages[0].Name != "" {
		t.Fatalf("internal dotted message name leaked to OpenAI: %q", messages[0].Name)
	}
	parts, ok := messages[0].Content.([]map[string]any)
	if !ok || len(parts) != 2 || parts[1]["type"] != "image_url" {
		t.Fatalf("vision content missing: %#v", messages[0].Content)
	}
}
