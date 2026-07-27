package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

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
	messages := []provider.Message{{Role: provider.RoleUser, Content: "text"}, {Role: provider.RoleUser, Parts: []provider.ContentPart{{Type: "image_url", ImageURL: "data:image/png;base64,AA=="}}}}
	out := withoutVisualParts(messages)
	if len(out) != 1 || out[0].Content != "text" { t.Fatalf("unexpected messages: %#v", out) }
}

func TestCaptureStoreOwnsExactBinding(t *testing.T) {
	store := NewCaptureStore(t.TempDir())
	png := append([]byte("\x89PNG\r\n\x1a\n"), []byte("test")...)
	asset, err := store.Put("u", "r", "c", "image/png", png)
	if err != nil { t.Fatal(err) }
	if !store.Owns(asset.ID, "u", "r", "c") { t.Fatal("expected exact owner binding") }
	if store.Owns(asset.ID, "u2", "r", "c") || store.Owns(asset.ID, "u", "r2", "c") || store.Owns(asset.ID, "u", "r", "c2") { t.Fatal("binding must be exact") }
}
