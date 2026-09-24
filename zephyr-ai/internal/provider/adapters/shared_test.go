package adapters

import "testing"


func TestEmptyOptionValuesAreOmitted(t *testing.T) {
	payload := map[string]any{}
	ApplyOptions(payload, map[string]any{
		"temperature":     -1,
		"top_p":           "",
		"max_tokens":      0,
		"reasoning_effort": "",
	}, "chat")
	for _, k := range []string{"temperature", "top_p", "reasoning_effort"} {
		if _, present := payload[k]; present {
			t.Fatalf("%q should be omitted for empty/-1 value: %#v", k, payload[k])
		}
	}
	// max_tokens:0 is a legitimate explicit value (not -1/empty), keep it.
	if v, ok := payload["max_tokens"]; !ok {
		t.Fatalf("max_tokens 0 should be kept, got absent: %#v", payload)
	} else if n, _ := v.(int); n != 0 {
		if f, _ := v.(float64); f != 0 {
			t.Fatalf("max_tokens 0 should be kept, got: %#v", v)
		}
	}
}
