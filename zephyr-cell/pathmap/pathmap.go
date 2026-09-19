// Package pathmap implements bidirectional guest↔host path translation (§3.2).
//
// Application code MUST NOT hard-code host paths. All path mapping goes
// through this package's MapPath function. The SDK manages host-side
// directory creation and bind mount configuration.
package pathmap

import (
	"fmt"
	"path/filepath"
	"strings"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
)

// Mapper translates between guest and host paths.
// Each session has its own mapper (sessions are isolated: §3.2).
type Mapper struct {
	// sessionID identifies this session.
	sessionID string

	// hostDataDir is the base directory on the host for all cell data.
	hostDataDir string

	// guestToHost maps guest mount points to host directories.
	guestToHost map[string]string

	// hostToGuest is the reverse mapping.
	hostToGuest map[string]string
}

// NewMapper creates a path mapper for a session.
// hostDataDir is the base directory (e.g., "/var/lib/zephyr-cell" or a container volume).
func NewMapper(sessionID, hostDataDir string) *Mapper {
	m := &Mapper{
		sessionID:   sessionID,
		hostDataDir: hostDataDir,
		guestToHost: make(map[string]string),
		hostToGuest: make(map[string]string),
	}

	// Session-scoped paths
	sessionDir := filepath.Join(hostDataDir, "sessions", sessionID)
	m.addMapping(cell.GuestWorkspace, filepath.Join(sessionDir, "workspace"))
	m.addMapping(cell.GuestInbox, filepath.Join(sessionDir, "inbox"))
	m.addMapping(cell.GuestOutbox, filepath.Join(sessionDir, "outbox"))
	m.addMapping(cell.GuestTmp, filepath.Join(sessionDir, "tmp"))

	// Global persistent paths (shared across sessions)
	sharedDir := filepath.Join(hostDataDir, "shared")
	m.addMapping(cell.GuestSharedMemory, filepath.Join(sharedDir, "memory"))
	m.addMapping(cell.GuestSharedSkills, filepath.Join(sharedDir, "skills"))
	m.addMapping(cell.GuestSharedCache, filepath.Join(sharedDir, "cache"))

	return m
}

func (m *Mapper) addMapping(guestPath, hostPath string) {
	m.guestToHost[guestPath] = hostPath
	m.hostToGuest[hostPath] = guestPath
}

// ToHost translates a guest path to the corresponding host path.
// Returns an error if the guest path is not under any known mount point.
func (m *Mapper) ToHost(guestPath string) (string, error) {
	guestPath = filepath.Clean(guestPath)

	// Try exact match first
	if hostPath, ok := m.guestToHost[guestPath]; ok {
		return hostPath, nil
	}

	// Try prefix match for subdirectories
	for guestMount, hostMount := range m.guestToHost {
		if strings.HasPrefix(guestPath, guestMount+"/") {
			rel := strings.TrimPrefix(guestPath, guestMount+"/")
			return filepath.Join(hostMount, rel), nil
		}
	}

	return "", fmt.Errorf("pathmap: guest path %q is not under any known mount point", guestPath)
}

// ToGuest translates a host path to the corresponding guest path.
// Returns an error if the host path is not under any known mount point.
func (m *Mapper) ToGuest(hostPath string) (string, error) {
	hostPath = filepath.Clean(hostPath)

	// Try exact match first
	if guestPath, ok := m.hostToGuest[hostPath]; ok {
		return guestPath, nil
	}

	// Try prefix match
	for hostMount, guestMount := range m.hostToGuest {
		if strings.HasPrefix(hostPath, hostMount+"/") {
			rel := strings.TrimPrefix(hostPath, hostMount+"/")
			return filepath.Join(guestMount, rel), nil
		}
	}

	return "", fmt.Errorf("pathmap: host path %q is not under any known mount point", hostPath)
}

// BindMounts returns the guest→host bind mount map for engine configuration.
func (m *Mapper) BindMounts() map[string]string {
	result := make(map[string]string, len(m.guestToHost))
	for g, h := range m.guestToHost {
		result[g] = h
	}
	return result
}

// HostDirs returns all host directories that need to be created for this session.
func (m *Mapper) HostDirs() []string {
	dirs := make([]string, 0, len(m.guestToHost))
	for _, h := range m.guestToHost {
		dirs = append(dirs, h)
	}
	return dirs
}

// SessionDir returns the session-specific host directory.
func (m *Mapper) SessionDir() string {
	return filepath.Join(m.hostDataDir, "sessions", m.sessionID)
}

// ValidateGuestPath checks if a guest path is under a writable mount point.
// Returns an error if the path would escape the sandbox.
func ValidateGuestPath(guestPath string) error {
	guestPath = filepath.Clean(guestPath)

	// Must be absolute
	if !strings.HasPrefix(guestPath, "/") {
		return fmt.Errorf("pathmap: guest path %q must be absolute", guestPath)
	}

	// Must be under /cell/
	if !strings.HasPrefix(guestPath, "/cell/") {
		return fmt.Errorf("pathmap: guest path %q must be under /cell/", guestPath)
	}

	// Path traversal check
	if strings.Contains(guestPath, "/../") || strings.HasSuffix(guestPath, "/..") {
		return fmt.Errorf("pathmap: guest path %q contains path traversal", guestPath)
	}

	return nil
}
