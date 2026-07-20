package event

import (
	"encoding/json"
	"testing"
)

func TestEventEnvelope(t *testing.T) {
	ev := New("run1", 1, TypeTextDelta, TextDelta{Text: "hi"})
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if m["type"] != string(TypeTextDelta) {
		t.Fatalf("%v", m["type"])
	}
	if int(m["v"].(float64)) != ProtocolVersion {
		t.Fatalf("version")
	}
	if m["runId"] != "run1" {
		t.Fatal("runId")
	}
}
