package cell

import "time"

// FileInfo describes a file or directory in the guest filesystem (§6.1).
type FileInfo struct {
	// Name is the base name (not full path).
	Name string

	// Path is the full guest path.
	Path string

	// IsDir indicates whether this entry is a directory.
	IsDir bool

	// Size is the file size in bytes (0 for directories).
	Size int64

	// ModTime is the last modification time (UTC).
	ModTime time.Time

	// Mode is the Unix permission bits (e.g., 0644).
	Mode uint32

	// MimeType is the detected MIME type (best-effort; empty if unknown).
	MimeType string
}
