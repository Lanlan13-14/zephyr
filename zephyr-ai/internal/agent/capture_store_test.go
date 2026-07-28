package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/compact"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-ai/internal/provider"
)

func TestCaptureStoreIsOneShotAndOwnerScoped(t *testing.T) {
	store := NewCaptureStore(t.TempDir())
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("test")...)
	asset, err := store.Put("u1", "run1", "call1", "image/png", png)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Take(asset.ID, "u2", "run1", "call1"); err == nil {
		t.Fatal("other user must not read capture")
	}
	got, data, err := store.Take(asset.ID, "u1", "run1", "call1")
	if err != nil {
		t.Fatal(err)
	}
	if got.MIMEType != "image/png" || !bytes.Equal(data, png) {
		t.Fatalf("unexpected capture: %#v %q", got, data)
	}
	if _, err := os.Stat(got.Path); !os.IsNotExist(err) {
		t.Fatal("capture file must be removed after use")
	}
	if _, _, err := store.Take(asset.ID, "u1", "run1", "call1"); err == nil {
		t.Fatal("capture must be one-shot")
	}
}

func TestRemoteDesktopObservationMetadataDoesNotContainImage(t *testing.T) {
	raw := json.RawMessage(`{"captureId":"cap-1","tabId":"rdp-tab","protocol":"RDP"}`)
	text := remoteDesktopObservationText(provider.ToolCall{ID: "call-1", Name: "remote_desktop_capture_v1"}, raw)
	if !strings.Contains(text, "captureId=cap-1") || strings.Contains(text, "data:image") {
		t.Fatalf("unexpected observation: %s", text)
	}
}

func TestStripCaptureImageData(t *testing.T) {
	input := map[string]any{"captureId": "cap-1", "dataUrl": "data:image/png;base64,secret", "screenshots": []any{map[string]any{"imageData": "secret", "width": float64(10)}}}
	clean := stripCaptureImageData(input).(map[string]any)
	if _, ok := clean["dataUrl"]; ok { t.Fatal("dataUrl leaked") }
	shot := clean["screenshots"].([]any)[0].(map[string]any)
	if _, ok := shot["imageData"]; ok { t.Fatal("imageData leaked") }
	if clean["captureId"] != "cap-1" || shot["width"] != float64(10) { t.Fatal("metadata lost") }
}

func TestCaptureStoreRejectsForgedImage(t *testing.T) {
	store := NewCaptureStore(t.TempDir())
	if _, err := store.Put("u", "r", "c", "image/png", []byte("not-an-image")); err == nil {
		t.Fatal("forged image must be rejected")
	}
}

func TestWithoutVisualPartsKeepsTextHistory(t *testing.T) {
	messages := []provider.Message{
		{Role: provider.RoleUser, Content: "text"},
		{Role: provider.RoleUser, Name: visualObservationName, Content: "客户端渲染的 RDP 远程桌面视觉观察。", Parts: []provider.ContentPart{{Type: "image_url", ImageURL: "data:image/png;base64,AA=="}}},
	}
	out := withoutVisualParts(messages)
	if len(out) != 1 || out[0].Content != "text" {
		t.Fatalf("unexpected messages: %#v", out)
	}
}

func TestWithoutVisualPartsKeepsUserAttachmentImages(t *testing.T) {
	// User attachments are multimodal user messages without the RDP observation name.
	messages := []provider.Message{
		{Role: provider.RoleUser, Content: "see this", Parts: []provider.ContentPart{
			{Type: "text", Text: "see this"},
			{Type: "image_url", ImageURL: "data:image/png;base64,AA=="},
		}},
		{Role: provider.RoleUser, Name: visualObservationName, Content: "客户端渲染的 RDP 远程桌面视觉观察。", Parts: []provider.ContentPart{{Type: "image_url", ImageURL: "data:image/png;base64,BB=="}}},
	}
	out := withoutVisualParts(messages)
	if len(out) != 1 || !hasImagePart(out[0]) || out[0].Content != "see this" {
		t.Fatalf("user attachment must be kept: %#v", out)
	}
}

func TestBuildModelMessagesPreservesVisualPinOrder(t *testing.T) {
	img := "data:image/png;base64,AA=="
	messages := []provider.Message{
		{Role: provider.RoleSystem, Content: "sys"},
		{Role: provider.RoleUser, Content: "屏幕上有什么"},
		{Role: provider.RoleAssistant, Content: "", ToolCalls: []provider.ToolCall{{ID: "c1", Name: "remote_desktop_capture_v1"}}},
		{Role: provider.RoleTool, Name: "remote_desktop_capture_v1", ToolCallID: "c1", Content: `{"ok":true,"captureId":"cap-1"}`},
		{Role: provider.RoleUser, Name: visualObservationName, Content: "客户端渲染的 RDP 远程桌面视觉观察。toolCallId=c1", Parts: []provider.ContentPart{
			{Type: "text", Text: "客户端渲染的 RDP 远程桌面视觉观察。toolCallId=c1"},
			{Type: "image_url", ImageURL: img},
		}},
		{Role: provider.RoleAssistant, Content: "看到记事本"},
	}
	out := buildModelMessages(messages, compact.Config{MaxChars: 180000}, true, nil)
	if len(out) != len(messages) {
		t.Fatalf("length changed: %d vs %d", len(out), len(messages))
	}
	// image must sit immediately after the capture tool result, not at the end
	toolIdx, imgIdx := -1, -1
	for i, m := range out {
		if m.Role == provider.RoleTool && m.ToolCallID == "c1" {
			toolIdx = i
		}
		if hasImagePart(m) {
			imgIdx = i
		}
	}
	if toolIdx < 0 || imgIdx != toolIdx+1 {
		t.Fatalf("image must follow capture tool result: tool=%d img=%d out=%#v", toolIdx, imgIdx, out)
	}
	if imgIdx == len(out)-1 && out[len(out)-2].Role != provider.RoleTool {
		t.Fatalf("image must not be moved to global end: %#v", rolesOf(out))
	}
	if !requestHasImagePart(out) {
		t.Fatal("request must contain image part")
	}
}

func TestBuildModelMessagesKeepsPinThroughAggressiveCompact(t *testing.T) {
	img := "data:image/png;base64,AA=="
	// Build a long history so compact folds older tool results.
	messages := []provider.Message{{Role: provider.RoleSystem, Content: "sys"}}
	for i := 0; i < 12; i++ {
		id := fmt.Sprintf("old-%d", i)
		messages = append(messages,
			provider.Message{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: id, Name: "remote_execute"}}},
			provider.Message{Role: provider.RoleTool, ToolCallID: id, Name: "remote_execute", Content: strings.Repeat("x", 8000)},
		)
	}
	messages = append(messages,
		provider.Message{Role: provider.RoleAssistant, ToolCalls: []provider.ToolCall{{ID: "c-cap", Name: "remote_desktop_capture_v1"}}},
		provider.Message{Role: provider.RoleTool, ToolCallID: "c-cap", Name: "remote_desktop_capture_v1", Content: `{"ok":true}`},
		provider.Message{
			Role: provider.RoleUser, Name: visualObservationName,
			Content: "客户端渲染的 RDP 远程桌面视觉观察。toolCallId=c-cap",
			Parts:   []provider.ContentPart{{Type: "text", Text: "meta"}, {Type: "image_url", ImageURL: img}},
		},
		provider.Message{Role: provider.RoleUser, Content: "点开始菜单"},
	)
	cfg := compact.Config{MaxChars: 20000, SnipRatio: 0.1, PruneRatio: 0.2, CompactRatio: 0.3, RecentChars: 4000}
	var meta *compact.Result
	out := buildModelMessages(messages, cfg, false, &meta)
	imgIdx, toolIdx := -1, -1
	for i, m := range out {
		if m.Role == provider.RoleTool && m.ToolCallID == "c-cap" {
			toolIdx = i
		}
		if hasImagePart(m) {
			imgIdx = i
		}
	}
	if imgIdx < 0 {
		t.Fatalf("image pin lost after compact: roles=%v", rolesOf(out))
	}
	// Prefer immediate adjacency; if compact folded the tool, pin must still not
	// be the sole trailing dump after unrelated assistant/user without tool.
	if toolIdx >= 0 && imgIdx < toolIdx {
		t.Fatalf("image before its tool result: tool=%d img=%d", toolIdx, imgIdx)
	}
	if !requestHasImagePart(out) {
		t.Fatal("missing image part")
	}
}

func rolesOf(msgs []provider.Message) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = string(m.Role)
		if hasImagePart(m) {
			out[i] += "+img"
		}
	}
	return out
}

func TestCaptureStoreOwnsExactBinding(t *testing.T) {
	store := NewCaptureStore(t.TempDir())
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("test")...)
	asset, err := store.Put("u", "r", "c", "image/png", png)
	if err != nil { t.Fatal(err) }
	if !store.Owns(asset.ID, "u", "r", "c") { t.Fatal("expected exact owner binding") }
	if store.Owns(asset.ID, "u2", "r", "c") || store.Owns(asset.ID, "u", "r2", "c") || store.Owns(asset.ID, "u", "r", "c2") { t.Fatal("binding must be exact") }
}
