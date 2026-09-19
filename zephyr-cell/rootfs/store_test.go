package rootfs

import (
	"testing"
	"time"
)

func TestStore_AddAndGetLayer(t *testing.T) {
	s := NewStore("/tmp/rootfs")

	data := []byte("hello rootfs")
	digest := DigestBytes(data)

	layer := Layer{
		Digest:    digest,
		Kind:      LayerBase,
		Arch:      "aarch64",
		SizeBytes: int64(len(data)),
		CreatedAt: time.Now(),
	}

	if err := s.AddLayer(layer, data); err != nil {
		t.Fatalf("AddLayer: %v", err)
	}

	got := s.GetLayer(digest)
	if got == nil {
		t.Fatal("GetLayer: want non-nil")
	}
	if got.Kind != LayerBase {
		t.Errorf("Kind: want base, got %s", got.Kind)
	}
}

func TestStore_IntegrityReject(t *testing.T) {
	s := NewStore("/tmp/rootfs")

	layer := Layer{
		Digest:    "0000000000000000000000000000000000000000000000000000000000000000",
		Kind:      LayerBase,
		Arch:      "aarch64",
		SizeBytes: 5,
	}

	err := s.AddLayer(layer, []byte("wrong"))
	if err == nil {
		t.Error("should reject mismatched digest")
	}
}

func TestStore_SizeBudget(t *testing.T) {
	s := NewStore("/tmp/rootfs")
	data := []byte("x")
	digest := DigestBytes(data)

	layer := Layer{
		Digest:    digest,
		Kind:      LayerBase,
		Arch:      "aarch64",
		SizeBytes: int64(MaxBaseSizeBytes) + 1, // over budget
	}

	err := s.AddLayer(layer, data)
	if err == nil {
		t.Error("should reject over-budget layer")
	}
}

func TestStore_ManifestLifecycle(t *testing.T) {
	s := NewStore("/tmp/rootfs")

	data := []byte("layer data")
	digest := DigestBytes(data)
	layer := Layer{Digest: digest, Kind: LayerBase, Arch: "aarch64", SizeBytes: int64(len(data))}
	s.AddLayer(layer, data)

	m := &Manifest{
		Version: 1,
		Layers:  []Layer{layer},
		Arch:    "aarch64",
	}

	if err := s.SetActiveManifest(m); err != nil {
		t.Fatalf("SetActiveManifest: %v", err)
	}

	active := s.ActiveManifest()
	if active == nil {
		t.Fatal("ActiveManifest should not be nil")
	}
	if len(active.Layers) != 1 {
		t.Errorf("manifest layers: want 1, got %d", len(active.Layers))
	}
}

func TestStore_ManifestMissingLayer(t *testing.T) {
	s := NewStore("/tmp/rootfs")

	m := &Manifest{
		Version: 1,
		Layers:  []Layer{{Digest: "nonexistent", Kind: LayerBase}},
		Arch:    "aarch64",
	}

	if err := s.SetActiveManifest(m); err == nil {
		t.Error("should reject manifest with missing layers")
	}
}

func TestStore_NeedsUpdate(t *testing.T) {
	s := NewStore("/tmp/rootfs")

	data := []byte("existing")
	digest := DigestBytes(data)
	s.AddLayer(Layer{Digest: digest, Kind: LayerBase, Arch: "aarch64", SizeBytes: int64(len(data))}, data)

	m := &Manifest{
		Layers: []Layer{
			{Digest: digest, Kind: LayerBase},
			{Digest: "missing_digest", Kind: LayerToolchain},
		},
	}

	missing := s.NeedsUpdate(m)
	if len(missing) != 1 {
		t.Errorf("missing layers: want 1, got %d", len(missing))
	}
	if len(missing) > 0 && missing[0].Kind != LayerToolchain {
		t.Errorf("missing layer kind: want toolchain, got %s", missing[0].Kind)
	}
}

func TestHostArch(t *testing.T) {
	arch := HostArch()
	if arch != "aarch64" && arch != "x86_64" {
		// On this ARM64 device it should be aarch64
		t.Logf("host arch: %s (non-standard but ok for testing)", arch)
	}
}

func TestVerifyManifestArch(t *testing.T) {
	m := &Manifest{
		Arch: "aarch64",
		Layers: []Layer{
			{Digest: "a", Arch: "aarch64"},
			{Digest: "b", Arch: "aarch64"},
		},
	}

	if err := VerifyManifestArch(m, "aarch64"); err != nil {
		t.Errorf("should pass: %v", err)
	}

	if err := VerifyManifestArch(m, "x86_64"); err == nil {
		t.Error("should fail for arch mismatch")
	}
}

func TestComputeManifestDigest(t *testing.T) {
	m := &Manifest{
		Version: 1,
		Arch:    "aarch64",
		Layers: []Layer{
			{Digest: "abc", Kind: LayerBase, SizeBytes: 100},
		},
	}

	d1 := ComputeManifestDigest(m)
	d2 := ComputeManifestDigest(m)
	if d1 != d2 {
		t.Error("same manifest should produce same digest")
	}
	if len(d1) != 64 {
		t.Errorf("digest length: want 64, got %d", len(d1))
	}
}
