package link

import (
	"encoding/hex"
	"encoding/json"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-link/internal/codec"
	"os"
	"os/exec"
	"testing"
)

func TestAIGoldenNodeGoCBORInterop(t *testing.T) {
	raw, err := os.ReadFile("../../../docs/zephyr-link/contracts/ai-rpc-host-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Vectors []struct {
			Name    string          `json:"name"`
			Body    json.RawMessage `json:"body"`
			Hex     string          `json:"hex"`
			BodyHex string          `json:"bodyHex"`
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
			payload, err := codec.Encode(body)
			if err != nil || hex.EncodeToString(payload) != vector.BodyHex || hex.EncodeToString(frame.Body) != vector.BodyHex {
				t.Fatal("Go/Node canonical CBOR payload bytes differ", err)
			}
			// zstd encoders need not choose identical blocks. Re-decode the Go frame and then
			// require Node to decode it too; never weaken interoperability to a prefix check.
			goFrame, err := codec.Unpack(repacked)
			if err != nil || hex.EncodeToString(goFrame.Body) != vector.BodyHex {
				t.Fatal("Go re-encode failed", err)
			}
			command := exec.Command("node", "-e", `const {unpack}=require('./link-v2-codec');const {encode}=require('./link-v2-cbor');process.stdout.write(encode(unpack(Buffer.from(process.argv[1],'hex')).body).toString('hex'));`, hex.EncodeToString(repacked))
			command.Dir = "../../.."
			got, err := command.CombinedOutput()
			if err != nil || string(got) != vector.BodyHex {
				t.Fatalf("Node cannot decode Go frame: %s %v", got, err)
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
