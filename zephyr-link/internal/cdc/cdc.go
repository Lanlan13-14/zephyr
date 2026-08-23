// Package cdc implements content-defined chunking (FastCDC-style GEAR) plus
// account-keyed chunk IDs and a Merkle root, byte-compatible with
// link-v2-cdc.js so a blob deduplicates identically on every runtime.
package cdc

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math"
)

// Options controls chunk boundaries.
type Options struct {
	MinChunk int
	AvgChunk int
	MaxChunk int
	mask     uint32
}

// Defaults mirror the Node frozen defaults.
var Defaults = Options{MinChunk: 8 * 1024, AvgChunk: 16 * 1024, MaxChunk: 64 * 1024}

var gearTable [256]uint32

func init() {
	seed := []byte("zephyr-link-v2-cdc-gear-v1")
	for i := 0; i < 256; i++ {
		h := sha256.New()
		h.Write(seed)
		h.Write([]byte{byte(i)})
		sum := h.Sum(nil)
		gearTable[i] = binary.BigEndian.Uint32(sum[:4]) | 1
	}
}

func maskForAvg(avg int) uint32 {
	bits := int(math.Round(math.Log2(float64(avg)))) - 1
	if bits < 8 {
		bits = 13
	}
	if bits > 20 {
		bits = 20
	}
	return (uint32(1) << bits) - 1
}

// Normalize applies the same clamping rules as the Node normalizeOptions.
func Normalize(o Options) Options {
	if o.MinChunk <= 0 {
		o.MinChunk = Defaults.MinChunk
	}
	if o.MinChunk < 1024 {
		o.MinChunk = 1024
	}
	if o.AvgChunk <= 0 {
		o.AvgChunk = Defaults.AvgChunk
	}
	if o.AvgChunk < o.MinChunk {
		o.AvgChunk = o.MinChunk
	}
	if o.MaxChunk <= 0 {
		o.MaxChunk = Defaults.MaxChunk
	}
	if o.MaxChunk < o.AvgChunk {
		o.MaxChunk = o.AvgChunk
	}
	o.mask = maskForAvg(o.AvgChunk)
	return o
}

func rotateLeft(v uint32, bits uint) uint32 { return (v << bits) | (v >> (32 - bits)) }

// Chunk splits body into content-defined chunks.
func Chunk(body []byte, o Options) [][]byte {
	opt := Normalize(o)
	if len(body) == 0 {
		return nil
	}
	modulus := opt.AvgChunk - opt.MinChunk
	if modulus < 2 {
		modulus = 2
	}
	var chunks [][]byte
	start := 0
	var hash uint32
	for i := 0; i < len(body); i++ {
		hash = rotateLeft(hash, 1) ^ gearTable[body[i]]
		size := i - start + 1
		if size < opt.MinChunk {
			continue
		}
		if int(hash%uint32(modulus)) == 0 || size >= opt.MaxChunk || i == len(body)-1 {
			chunks = append(chunks, body[start:i+1])
			start = i + 1
			hash = 0
		}
	}
	if start < len(body) {
		chunks = append(chunks, body[start:])
	}
	return chunks
}

// SHA256Hex hashes bytes to lowercase hex.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// KeyedChunkID is HMAC-SHA256(accountKey, chunk) in hex.
func KeyedChunkID(accountKey, chunk []byte) (string, error) {
	if len(accountKey) == 0 {
		return "", errors.New("accountKey is required for keyed chunk IDs")
	}
	mac := hmac.New(sha256.New, accountKey)
	mac.Write(chunk)
	return hex.EncodeToString(mac.Sum(nil)), nil
}

// MerkleRoot folds leaf hashes (hex) into a single root, duplicating the last
// leaf on odd levels exactly like the Node reference.
func MerkleRoot(leaves []string) string {
	if len(leaves) == 0 {
		return SHA256Hex(nil)
	}
	level := make([][]byte, len(leaves))
	for i, leaf := range leaves {
		raw, _ := hex.DecodeString(leaf)
		level[i] = raw
	}
	for len(level) > 1 {
		next := make([][]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			left := level[i]
			right := left
			if i+1 < len(level) {
				right = level[i+1]
			}
			h := sha256.New()
			h.Write(left)
			h.Write(right)
			next = append(next, h.Sum(nil))
		}
		level = next
	}
	return hex.EncodeToString(level[0])
}

// ChunkInfo describes one content-defined chunk.
type ChunkInfo struct {
	Index   int    `json:"index"`
	Size    int    `json:"size"`
	SHA256  string `json:"sha256"`
	KeyedID string `json:"keyedId"`
}

// Manifest is the blob descriptor exchanged between peers.
type Manifest struct {
	V         int         `json:"v"`
	Algorithm string      `json:"algorithm"`
	Size      int         `json:"size"`
	SHA256    string      `json:"sha256"`
	Merkle    string      `json:"merkle"`
	MinChunk  int         `json:"minChunk"`
	AvgChunk  int         `json:"avgChunk"`
	MaxChunk  int         `json:"maxChunk"`
	Chunks    []ChunkInfo `json:"chunks"`
}

// BuildManifest chunks body and describes it.
func BuildManifest(body []byte, accountKey []byte, o Options) (*Manifest, error) {
	opt := Normalize(o)
	parts := Chunk(body, opt)
	chunks := make([]ChunkInfo, len(parts))
	leaves := make([]string, len(parts))
	for i, part := range parts {
		keyed, err := KeyedChunkID(accountKey, part)
		if err != nil {
			return nil, err
		}
		sum := SHA256Hex(part)
		chunks[i] = ChunkInfo{Index: i, Size: len(part), SHA256: sum, KeyedID: keyed}
		leaves[i] = sum
	}
	return &Manifest{
		V:         2,
		Algorithm: "fastcdc-gear-v1",
		Size:      len(body),
		SHA256:    SHA256Hex(body),
		Merkle:    MerkleRoot(leaves),
		MinChunk:  opt.MinChunk,
		AvgChunk:  opt.AvgChunk,
		MaxChunk:  opt.MaxChunk,
		Chunks:    chunks,
	}, nil
}

// MissingChunks returns the chunks whose keyed IDs are not in known.
func MissingChunks(m *Manifest, known map[string]struct{}) []ChunkInfo {
	var out []ChunkInfo
	for _, c := range m.Chunks {
		if _, ok := known[c.KeyedID]; !ok {
			out = append(out, c)
		}
	}
	return out
}
