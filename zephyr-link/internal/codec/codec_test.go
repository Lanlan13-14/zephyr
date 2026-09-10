package codec

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestDecodeAnyIsJSONMarshalable(t *testing.T) {
	body := map[string]any{
		"ok":             true,
		"bootstrapId":    "bs-1",
		"snapshotCursor": uint64(7),
		"complete":       true,
		"entities": []any{
			map[string]any{
				"changeSeq":  uint64(1),
				"entityType": "note",
				"entityId":   "n1",
				"payload":    map[string]any{"title": "hi"},
			},
		},
	}
	packed, err := Pack(KindSyncAck, body, false)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := Unpack(packed)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := Decode(fr.Body, &decoded); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		t.Fatalf("Android loopback requires a JSON-encodable ack, got %T: %v", decoded, err)
	}
	var out map[string]any
	if err := json.Unmarshal(encoded, &out); err != nil {
		t.Fatal(err)
	}
	if out["bootstrapId"] != "bs-1" {
		t.Fatalf("bootstrap id lost: %s", encoded)
	}
	entities, _ := out["entities"].([]any)
	if len(entities) != 1 {
		t.Fatalf("entities lost: %s", encoded)
	}
	entity, _ := entities[0].(map[string]any)
	payload, _ := entity["payload"].(map[string]any)
	if payload["title"] != "hi" {
		t.Fatalf("nested payload lost: %s", encoded)
	}
}

func TestPackCanonicalizesJSONNumbersToIntegers(t *testing.T) {
	cases := []any{
		json.RawMessage(`{"op":"changes","sinceCursor":59,"limit":100}`),
		json.RawMessage(`{"op":"changes","sinceCursor":59.0,"limit":100}`),
		map[string]any{"op": "changes", "sinceCursor": float64(59), "limit": float64(100)},
	}
	for i, body := range cases {
		packed, err := Pack(KindSyncOp, body, false)
		if err != nil {
			t.Fatalf("case %d pack: %v", i, err)
		}
		fr, err := Unpack(packed)
		if err != nil {
			t.Fatalf("case %d unpack: %v", i, err)
		}
		var decoded map[string]any
		if err := Decode(fr.Body, &decoded); err != nil {
			t.Fatalf("case %d decode: %v", i, err)
		}
		if decoded["op"] != "changes" {
			t.Fatalf("case %d lost op: %#v", i, decoded["op"])
		}
		if bytes.Contains(fr.Body, []byte{0xfb}) {
			t.Fatalf("case %d packed a float64 CBOR value into the body: %x", i, fr.Body)
		}
		if !bytes.Contains(fr.Body, []byte{0x18, 0x3b}) {
			t.Fatalf("case %d did not pack sinceCursor=59 as CBOR uint: %x", i, fr.Body)
		}
		switch v := decoded["sinceCursor"].(type) {
		case uint64:
			if v != 59 {
				t.Fatalf("case %d sinceCursor=%d", i, v)
			}
		case int64:
			if v != 59 {
				t.Fatalf("case %d sinceCursor=%d", i, v)
			}
		case float64:
			t.Fatalf("case %d sinceCursor stayed a float: %v", i, v)
		default:
			t.Fatalf("case %d sinceCursor type %T: %v", i, v, v)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	body := map[string]any{"op": "upsert", "entity": "note", "rev": uint64(3)}
	packed, err := Pack(KindSyncOp, body, false)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := Unpack(packed)
	if err != nil {
		t.Fatal(err)
	}
	if fr.Kind != KindSyncOp {
		t.Fatalf("kind=%d", fr.Kind)
	}
	var decoded map[string]any
	if err := Decode(fr.Body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["entity"] != "note" {
		t.Fatalf("entity=%v", decoded["entity"])
	}
}

func TestSecretNeverCompressed(t *testing.T) {
	body := map[string]any{"pad": strings.Repeat("ab", 2000), "token": "s3cr3t"}
	packed, err := Pack(KindSyncOp, body, true)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := Unpack(packed)
	if err != nil {
		t.Fatal(err)
	}
	if !fr.Secret {
		t.Fatal("secret flag lost")
	}
	if fr.Flags&FlagZstd != 0 {
		t.Fatal("secret frame was compressed")
	}
}

func TestDecompressionBombRejected(t *testing.T) {
	body := map[string]any{"pad": strings.Repeat("x", 64*1024)}
	packed, err := Pack(KindSyncOp, body, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Unpack(packed); err == nil {
		t.Fatal("decompression bomb accepted")
	}
}

type codecVector struct {
	Kind   int    `json:"kind"`
	Secret bool   `json:"secret"`
	Packed string `json:"packed"`
	Body   string `json:"body"`
}

// TestInteropVectors replays Node-packed frames. Go must unpack them and
// re-encode the body to the identical canonical bytes Node produced — that is
// what keeps Merkle roots and chunk ids equal across runtimes.
func TestInteropVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/interop.json")
	if err != nil {
		t.Skip("no codec vectors (run scripts/gen-codec-vectors.mjs)")
	}
	var vectors []codecVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		packed, _ := base64.StdEncoding.DecodeString(v.Packed)
		fr, err := Unpack(packed)
		if err != nil {
			t.Fatalf("vector %d: unpack failed: %v", i, err)
		}
		if fr.Kind != v.Kind {
			t.Fatalf("vector %d: kind=%d want %d", i, fr.Kind, v.Kind)
		}
		if fr.Secret != v.Secret {
			t.Fatalf("vector %d: secret=%v want %v", i, fr.Secret, v.Secret)
		}
		// The unpacked body bytes must equal Node's canonical re-encode.
		wantBody, _ := base64.StdEncoding.DecodeString(v.Body)
		if !bytes.Equal(fr.Body, wantBody) {
			t.Fatalf("vector %d: body bytes diverge from Node canonical encoding", i)
		}
	}
}
