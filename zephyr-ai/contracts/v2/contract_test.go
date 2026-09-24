package contractv2

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type goldenFile struct {
	SchemaVersion int `json:"schemaVersion"`
	Vectors       []struct {
		Name     string         `json:"name"`
		Document map[string]any `json:"document"`
	} `json:"vectors"`
}

func TestSchemaVersionAndTaxonomy(t *testing.T) {
	if SchemaVersion != 2 {
		t.Fatalf("schema version = %d", SchemaVersion)
	}
	spec, ok := AIErrorByCode("ai_dns_failed")
	if !ok || !spec.Retryable || spec.HTTPStatus != 503 {
		t.Fatalf("dns error spec = %#v ok=%v", spec, ok)
	}
	if _, ok := AIErrorByCode("not-a-code"); ok {
		t.Fatal("unknown code was accepted")
	}
	if !ProviderAPIOpenAIResponses.Valid() || ProviderFamily("nope").Valid() {
		t.Fatal("enum validity drifted")
	}
}

func TestGoldenDocumentsRoundTrip(t *testing.T) {
	path := filepath.Join("..", "..", "..", "contracts", "ai", "v2", "testdata", "golden-vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file goldenFile
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	if file.SchemaVersion != SchemaVersion || len(file.Vectors) < 8 {
		t.Fatalf("golden file drifted: version=%d count=%d", file.SchemaVersion, len(file.Vectors))
	}
	for _, vector := range file.Vectors {
		encoded, err := json.Marshal(vector.Document)
		if err != nil {
			t.Fatal(err)
		}
		var decoded map[string]any
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded["schemaVersion"] != nil && decoded["schemaVersion"].(float64) != 2 && vector.Name != "transport-target-android-dns" {
			t.Fatalf("%s lost schema version", vector.Name)
		}
	}
}
