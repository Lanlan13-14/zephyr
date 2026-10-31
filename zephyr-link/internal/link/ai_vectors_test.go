package link

import (
	"encoding/hex"
	"encoding/json"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"os"
	"testing"
)

func TestAIGoldenNodeGoCBORInterop(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/zephyr-link/contracts/ai-rpc-host-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Vectors []struct {
			Name string          `json:"name"`
			Body json.RawMessage `json:"body"`
			Hex  string          `json:"hex"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Vectors) != 6 {
		t.Fatal("missing AI vectors")
	}
	for _, vector := range golden.Vectors {
		t.Run(vector.Name, func(t *testing.T) {
			encoded, err := hex.DecodeString(vector.Hex)
			if err != nil {
				t.Fatal(err)
			}
			frame, err := codec.Unpack(encoded)
			if err != nil {
				t.Fatal(err)
			}
			if frame.Kind != codec.KindAI {
				t.Fatal(frame.Kind)
			}
			var body map[string]any
			if err := codec.Decode(frame.Body, &body); err != nil {
				t.Fatal(err)
			}
			repacked, err := codec.Pack(codec.KindAI, body, false)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(repacked) != vector.Hex {
				t.Fatal("Go/Node CBOR bytes differ")
			}
			var want map[string]any
			if err := json.Unmarshal(vector.Body, &want); err != nil {
				t.Fatal(err)
			}
			if body["op"] != want["op"] {
				t.Fatal(body)
			}
		})
	}
}
