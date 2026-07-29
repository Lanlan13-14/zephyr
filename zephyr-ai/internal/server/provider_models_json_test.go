package server

import (
	"encoding/json"
	"testing"
)

func TestStartRunProviderModelsAcceptStringIDs(t *testing.T) {
	raw := []byte(`{"userId":"u1","sessionId":"s1","provider":{"id":"p1","kind":"openai-compatible","models":["vision-a","text-b"]},"model":"vision-a"}`)
	var req startRunReq
	if err := json.Unmarshal(raw, &req); err != nil {
		t.Fatal(err)
	}
	if len(req.Provider.Models) != 2 || req.Provider.Models[0] != "vision-a" || req.Provider.Models[1] != "text-b" {
		t.Fatalf("models=%v", req.Provider.Models)
	}
}

func TestStartRunProviderModelsRejectObjects(t *testing.T) {
	raw := []byte(`{"userId":"u1","sessionId":"s1","provider":{"id":"p1","kind":"openai-compatible","models":[{"id":"vision-a"}]},"model":"vision-a"}`)
	var req startRunReq
	if err := json.Unmarshal(raw, &req); err == nil {
		t.Fatalf("object ModelEntry must not cross Node-Go boundary: %+v", req.Provider.Models)
	}
}
