// Package rootfs manages rootfs layers — content-addressed, integrity-verified,
// and platform-uniform (§3.1).
//
// Layer hierarchy:
//
//	base      (<30MB) — Alpine minirootfs aarch64 + busybox + Cell bootstrap + zc-* stubs
//	toolchain (<80MB) — python3+pip, node, git, curl, jq, sqlite, ca-certificates
//	media     (<60MB) — ffmpeg, imagemagick (optional)
//	user      (unlimited) — apk/pip/npm install results
//
// All layers are content-addressed (SHA-256), manifests are signed, and
// layers are verified before mounting. The base layer is byte-identical
// across all six platforms. x86_64 hosts use a separate rootfs variant;
// alignment is enforced by contract tests (§10.3).
package rootfs

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// LayerKind identifies the type of rootfs layer.
type LayerKind string

const (
	LayerBase      LayerKind = "base"
	LayerToolchain LayerKind = "toolchain"
	LayerMedia     LayerKind = "media"
	LayerUser      LayerKind = "user"
)

// Layer represents a single rootfs layer in the content-addressed store.
type Layer struct {
	// Digest is the SHA-256 digest of the layer content.
	Digest string

	// Kind is the layer type (base, toolchain, media, user).
	Kind LayerKind

	// Arch is the target architecture (aarch64 or x86_64).
	Arch string

	// SizeBytes is the compressed layer size.
	SizeBytes int64

	// CreatedAt is when the layer was built.
	CreatedAt time.Time
}

// Manifest describes a complete rootfs image (ordered layer stack + signature).
type Manifest struct {
	// Version is the manifest schema version.
	Version int

	// Layers lists the layers in mount order (base first).
	Layers []Layer

	// Arch is the target architecture.
	Arch string

	// Signature is the detached signature over the canonical manifest bytes.
	Signature []byte

	// SignedBy is the key ID that produced the signature.
	SignedBy string

	// CreatedAt is the manifest creation time.
	CreatedAt time.Time
}

// TotalSize returns the total compressed size of all layers.
func (m *Manifest) TotalSize() int64 {
	var total int64
	for _, l := range m.Layers {
		total += l.SizeBytes
	}
	return total
}

// BaseLayer returns the base layer, or nil if not present.
func (m *Manifest) BaseLayer() *Layer {
	for i := range m.Layers {
		if m.Layers[i].Kind == LayerBase {
			return &m.Layers[i]
		}
	}
	return nil
}

// DigestBytes computes the SHA-256 digest of raw data.
func DigestBytes(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// VerifyDigest checks that data matches the expected SHA-256 digest.
func VerifyDigest(data []byte, expected string) error {
	actual := DigestBytes(data)
	if actual != expected {
		return fmt.Errorf("rootfs: digest mismatch: expected %s, got %s", expected, actual)
	}
	return nil
}

// Size budget constants (§3.1, §9.1).
const (
	MaxBaseSizeBytes      = 30 * 1024 * 1024  // <30MB
	MaxToolchainSizeBytes = 80 * 1024 * 1024  // <80MB
	MaxMediaSizeBytes     = 60 * 1024 * 1024  // <60MB
	MaxDockerImageBytes   = 150 * 1024 * 1024 // <150MB (Web Docker image)
)
