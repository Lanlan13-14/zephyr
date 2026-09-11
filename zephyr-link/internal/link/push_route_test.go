package link

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
)

// The Android host never sees CBOR. It POSTs JSON to the embedded /link/push
// route and json-decodes the unsealed ack. A CBOR any that json cannot marshal
// used to yield an empty 200, which kotlinx then threw as a process crash.
func TestEmbeddedPushFrameReturnsJSONEncodableAck(t *testing.T) {
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":   true,
			"kind": codec.KindSyncAck,
			"body": map[string]any{
				"ok":             true,
				"bootstrapId":    "bs-1",
				"snapshotCursor": 7,
				"complete":       true,
				"entities": []any{
					map[string]any{
						"changeSeq":  1,
						"entityType": "note",
						"entityId":   "n1",
						"action":     "upsert",
						"revision":   1,
						"changedAt":  1,
						"fieldMask":  []any{"title"},
						"payload":    map[string]any{"title": "hi"},
					},
				},
			},
		})
	}))
	defer bridge.Close()

	server := NewNode()
	server.RegisterDevice("dev-push")
	server.RegisterSyncBridge(SyncBridgeConfig{URL: bridge.URL, AdminToken: "tok-1234567890abcdef"})
	serverSrv := httptest.NewServer(server.Handler())
	defer serverSrv.Close()

	device := NewNode()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	dialBody, _ := json.Marshal(map[string]any{
		"serverUrl": serverSrv.URL, "deviceId": "dev-push",
	})
	dialResp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", bytes.NewReader(dialBody))
	if err != nil {
		t.Fatal(err)
	}
	defer dialResp.Body.Close()
	var dial struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(dialResp.Body).Decode(&dial); err != nil {
		t.Fatal(err)
	}
	if !dial.OK || dial.SessionID == "" {
		t.Fatalf("dial failed: %+v", dial)
	}

	pushBody, _ := json.Marshal(map[string]any{
		"sessionId": dial.SessionID,
		"peerUrl":   serverSrv.URL,
		"kind":      codec.KindSyncOp,
		"body":      map[string]any{"op": "bootstrap"},
		"secret":    false,
	})
	pushResp, err := http.Post(deviceSrv.URL+"/link/push", "application/json", bytes.NewReader(pushBody))
	if err != nil {
		t.Fatal(err)
	}
	defer pushResp.Body.Close()
	raw := new(bytes.Buffer)
	if _, err := raw.ReadFrom(pushResp.Body); err != nil {
		t.Fatal(err)
	}
	if pushResp.StatusCode != http.StatusOK {
		t.Fatalf("push status %d body %s", pushResp.StatusCode, raw.String())
	}
	if raw.Len() == 0 {
		t.Fatal("embedded push returned an empty 200; Android kotlinx crashes on that")
	}
	var out struct {
		OK      bool            `json:"ok"`
		AckKind int             `json:"ackKind"`
		Ack     json.RawMessage `json:"ack"`
	}
	if err := json.Unmarshal(raw.Bytes(), &out); err != nil {
		t.Fatalf("push reply is not JSON: %v body=%s", err, raw.String())
	}
	if !out.OK || out.AckKind != codec.KindSyncAck {
		t.Fatalf("unexpected push envelope: %+v body=%s", out, raw.String())
	}
	var ack map[string]any
	if err := json.Unmarshal(out.Ack, &ack); err != nil {
		t.Fatalf("ack is not a JSON object: %v %s", err, string(out.Ack))
	}
	if ack["bootstrapId"] != "bs-1" {
		t.Fatalf("bootstrap payload lost: %s", string(out.Ack))
	}
	entities, _ := ack["entities"].([]any)
	if len(entities) != 1 {
		t.Fatalf("entities lost: %s", string(out.Ack))
	}
	entity, _ := entities[0].(map[string]any)
	payload, _ := entity["payload"].(map[string]any)
	if payload["title"] != "hi" {
		t.Fatalf("nested payload lost: %s", string(out.Ack))
	}
}
