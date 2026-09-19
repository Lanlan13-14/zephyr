package rootfs

import (
	"testing"
)

func TestDigestBytes(t *testing.T) {
	// SHA-256 of empty byte slice is well-known
	d := DigestBytes([]byte{})
	expected := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if d != expected {
		t.Errorf("DigestBytes(empty): want %s, got %s", expected, d)
	}
}

func TestVerifyDigest_Match(t *testing.T) {
	data := []byte("hello cell")
	digest := DigestBytes(data)
	if err := VerifyDigest(data, digest); err != nil {
		t.Errorf("VerifyDigest should pass: %v", err)
	}
}

func TestVerifyDigest_Mismatch(t *testing.T) {
	data := []byte("hello cell")
	if err := VerifyDigest(data, "0000000000000000000000000000000000000000000000000000000000000000"); err == nil {
		t.Error("VerifyDigest should fail on mismatch")
	}
}

func TestManifest_TotalSize(t *testing.T) {
	m := Manifest{
		Layers: []Layer{
			{Digest: "a", Kind: LayerBase, SizeBytes: 25 * 1024 * 1024},
			{Digest: "b", Kind: LayerToolchain, SizeBytes: 60 * 1024 * 1024},
		},
	}
	want := int64(85 * 1024 * 1024)
	if m.TotalSize() != want {
		t.Errorf("TotalSize: want %d, got %d", want, m.TotalSize())
	}
}

func TestManifest_BaseLayer(t *testing.T) {
	m := Manifest{
		Layers: []Layer{
			{Digest: "a", Kind: LayerBase},
			{Digest: "b", Kind: LayerToolchain},
		},
	}
	base := m.BaseLayer()
	if base == nil {
		t.Fatal("BaseLayer should not be nil")
	}
	if base.Digest != "a" {
		t.Errorf("BaseLayer digest: want a, got %s", base.Digest)
	}
}

func TestManifest_BaseLayer_Missing(t *testing.T) {
	m := Manifest{
		Layers: []Layer{
			{Digest: "b", Kind: LayerToolchain},
		},
	}
	if m.BaseLayer() != nil {
		t.Error("BaseLayer should be nil when no base layer")
	}
}

func TestSizeBudgets(t *testing.T) {
	if MaxBaseSizeBytes != 30*1024*1024 {
		t.Errorf("MaxBaseSizeBytes: want %d, got %d", 30*1024*1024, MaxBaseSizeBytes)
	}
	if MaxToolchainSizeBytes != 80*1024*1024 {
		t.Errorf("MaxToolchainSizeBytes: want %d, got %d", 80*1024*1024, MaxToolchainSizeBytes)
	}
	if MaxMediaSizeBytes != 60*1024*1024 {
		t.Errorf("MaxMediaSizeBytes: want %d, got %d", 60*1024*1024, MaxMediaSizeBytes)
	}
	if MaxDockerImageBytes != 150*1024*1024 {
		t.Errorf("MaxDockerImageBytes: want %d, got %d", 150*1024*1024, MaxDockerImageBytes)
	}
}
