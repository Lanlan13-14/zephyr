package rootfs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"runtime"
	"sync"
)

// Store manages rootfs layers on the host filesystem (§3.1).
// It handles content-addressed storage, integrity verification,
// and atomic layer switching.
type Store struct {
	mu      sync.RWMutex
	baseDir string
	layers  map[string]*Layer // digest → layer

	// Current active manifest
	active *Manifest
}

// NewStore creates a new rootfs store at the given base directory.
func NewStore(baseDir string) *Store {
	return &Store{
		baseDir: baseDir,
		layers:  make(map[string]*Layer),
	}
}

// AddLayer registers a layer in the store after verifying its digest.
func (s *Store) AddLayer(layer Layer, data []byte) error {
	// Verify content-addressed integrity (§3.1)
	if err := VerifyDigest(data, layer.Digest); err != nil {
		return fmt.Errorf("rootfs: layer %s integrity check failed: %w", shortDigest(layer.Digest), err)
	}

	// Check size budgets
	if err := s.checkSizeBudget(layer); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.layers[layer.Digest] = &layer
	return nil
}

// GetLayer returns a layer by digest.
func (s *Store) GetLayer(digest string) *Layer {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.layers[digest]
}

// HasLayer checks if a layer exists in the store.
func (s *Store) HasLayer(digest string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.layers[digest]
	return ok
}

func shortDigest(digest string) string {
	if len(digest) > 12 {
		return digest[:12]
	}
	return digest
}

// SetActiveManifest atomically switches the active rootfs manifest.
// The old manifest's layers are retained until no sessions reference them.
func (s *Store) SetActiveManifest(m *Manifest) error {
	// Verify all layers exist
	for _, l := range m.Layers {
		if !s.HasLayer(l.Digest) {
			return fmt.Errorf("rootfs: manifest references unknown layer %s", shortDigest(l.Digest))
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.active = m
	return nil
}

// ActiveManifest returns the current active manifest.
func (s *Store) ActiveManifest() *Manifest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.active
}

func (s *Store) checkSizeBudget(layer Layer) error {
	switch layer.Kind {
	case LayerBase:
		if layer.SizeBytes > int64(MaxBaseSizeBytes) {
			return fmt.Errorf("rootfs: base layer %d bytes exceeds budget %d", layer.SizeBytes, MaxBaseSizeBytes)
		}
	case LayerToolchain:
		if layer.SizeBytes > int64(MaxToolchainSizeBytes) {
			return fmt.Errorf("rootfs: toolchain layer %d bytes exceeds budget %d", layer.SizeBytes, MaxToolchainSizeBytes)
		}
	case LayerMedia:
		if layer.SizeBytes > int64(MaxMediaSizeBytes) {
			return fmt.Errorf("rootfs: media layer %d bytes exceeds budget %d", layer.SizeBytes, MaxMediaSizeBytes)
		}
	}
	return nil
}

// NeedsUpdate checks if any layers in the manifest need downloading.
func (s *Store) NeedsUpdate(m *Manifest) []Layer {
	var missing []Layer
	for _, l := range m.Layers {
		if !s.HasLayer(l.Digest) {
			missing = append(missing, l)
		}
	}
	return missing
}

// DetectCorruption re-verifies all layers against their recorded digests.
// Returns corrupted layers that should be re-downloaded.
func (s *Store) DetectCorruption(getData func(digest string) ([]byte, error)) []Layer {
	s.mu.RLock()
	layers := make(map[string]*Layer, len(s.layers))
	for k, v := range s.layers {
		layers[k] = v
	}
	s.mu.RUnlock()

	var corrupted []Layer
	for digest, layer := range layers {
		data, err := getData(digest)
		if err != nil {
			corrupted = append(corrupted, *layer)
			continue
		}
		if err := VerifyDigest(data, digest); err != nil {
			corrupted = append(corrupted, *layer)
		}
	}
	return corrupted
}

// HostArch returns the current host architecture for rootfs variant selection.
func HostArch() string {
	switch runtime.GOARCH {
	case "arm64":
		return "aarch64"
	case "amd64":
		return "x86_64"
	default:
		return runtime.GOARCH
	}
}

// VerifyManifestArch checks if the manifest matches the expected architecture.
func VerifyManifestArch(m *Manifest, expectedArch string) error {
	if m.Arch != expectedArch {
		return fmt.Errorf("rootfs: manifest arch %q does not match expected %q", m.Arch, expectedArch)
	}
	for _, l := range m.Layers {
		if l.Arch != expectedArch {
			return fmt.Errorf("rootfs: layer %s arch %q does not match expected %q", l.Digest[:12], l.Arch, expectedArch)
		}
	}
	return nil
}

// ComputeManifestDigest calculates the digest of a manifest's canonical form
// (for signature verification).
func ComputeManifestDigest(m *Manifest) string {
	// Canonical form: sorted layers by digest, arch, version
	h := sha256.New()
	fmt.Fprintf(h, "v%d:%s:", m.Version, m.Arch)
	for _, l := range m.Layers {
		fmt.Fprintf(h, "%s:%s:%d;", l.Digest, l.Kind, l.SizeBytes)
	}
	return hex.EncodeToString(h.Sum(nil))
}
