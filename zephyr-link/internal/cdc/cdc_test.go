package cdc

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestChunkReassembles(t *testing.T) {
	body := make([]byte, 200*1024)
	rand.Read(body)
	parts := Chunk(body, Defaults)
	var reassembled []byte
	for _, p := range parts {
		reassembled = append(reassembled, p...)
	}
	if !bytes.Equal(reassembled, body) {
		t.Fatal("chunks do not reassemble to the original body")
	}
	for i, p := range parts[:len(parts)-1] {
		if len(p) < Defaults.MinChunk {
			t.Fatalf("chunk %d below min: %d", i, len(p))
		}
		if len(p) > Defaults.MaxChunk {
			t.Fatalf("chunk %d above max: %d", i, len(p))
		}
	}
}

func TestKeyedChunkIDRequiresKey(t *testing.T) {
	if _, err := KeyedChunkID(nil, []byte("x")); err == nil {
		t.Fatal("empty account key accepted")
	}
}

type manifestVector struct {
	Body       string `json:"body"`
	AccountKey string `json:"accountKey"`
	SHA256     string `json:"sha256"`
	Merkle     string `json:"merkle"`
	ChunkCount int    `json:"chunkCount"`
	FirstKeyed string `json:"firstKeyed"`
}

// TestInteropVectors proves Go CDC chunks, hashes and Merkle-folds a blob to
// the same manifest the Node reference produces.
func TestInteropVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/interop.json")
	if err != nil {
		t.Skip("no cdc vectors (run scripts/gen-cdc-vectors.mjs)")
	}
	var vectors []manifestVector
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for i, v := range vectors {
		body, _ := base64.StdEncoding.DecodeString(v.Body)
		key, _ := base64.StdEncoding.DecodeString(v.AccountKey)
		m, err := BuildManifest(body, key, Defaults)
		if err != nil {
			t.Fatal(err)
		}
		if m.SHA256 != v.SHA256 {
			t.Fatalf("vector %d: sha256 %s != %s", i, m.SHA256, v.SHA256)
		}
		if m.Merkle != v.Merkle {
			t.Fatalf("vector %d: merkle %s != %s", i, m.Merkle, v.Merkle)
		}
		if len(m.Chunks) != v.ChunkCount {
			t.Fatalf("vector %d: %d chunks != %d", i, len(m.Chunks), v.ChunkCount)
		}
		if len(m.Chunks) > 0 && m.Chunks[0].KeyedID != v.FirstKeyed {
			t.Fatalf("vector %d: first keyed id diverges", i)
		}
	}
}
