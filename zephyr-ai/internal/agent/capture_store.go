package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	captureTTL      = 2 * time.Minute
	maxCaptureBytes = 8 << 20
)

type CaptureAsset struct {
	ID       string
	UserID   string
	RunID    string
	CallID   string
	MIMEType string
	Path     string
	Size     int64
	Created  time.Time
}

type CaptureStore struct {
	mu    sync.Mutex
	dir   string
	items map[string]CaptureAsset
}

func NewCaptureStore(dir string) *CaptureStore {
	return &CaptureStore{dir: dir, items: make(map[string]CaptureAsset)}
}

func (s *CaptureStore) Put(userID, runID, callID, mimeType string, data []byte) (CaptureAsset, error) {
	if s == nil || strings.TrimSpace(s.dir) == "" {
		return CaptureAsset{}, errors.New("capture store unavailable")
	}
	if len(data) == 0 || len(data) > maxCaptureBytes {
		return CaptureAsset{}, errors.New("capture image size invalid")
	}
	if mimeType != "image/png" && mimeType != "image/jpeg" && mimeType != "image/webp" {
		return CaptureAsset{}, errors.New("unsupported capture image type")
	}
	if !validCaptureMagic(mimeType, data) {
		return CaptureAsset{}, errors.New("capture image signature mismatch")
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return CaptureAsset{}, err
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return CaptureAsset{}, err
	}
	id := hex.EncodeToString(raw[:])
	path := filepath.Join(s.dir, id+".img")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return CaptureAsset{}, err
	}
	asset := CaptureAsset{ID: id, UserID: userID, RunID: runID, CallID: callID, MIMEType: mimeType, Path: path, Size: int64(len(data)), Created: time.Now()}
	s.mu.Lock()
	s.cleanupLocked(time.Now())
	for existingID, existing := range s.items {
		if existing.UserID == userID && existing.RunID == runID && existing.CallID == callID {
			delete(s.items, existingID)
			_ = os.Remove(existing.Path)
		}
	}
	s.items[id] = asset
	s.mu.Unlock()
	return asset, nil
}

func validCaptureMagic(mimeType string, data []byte) bool {
	switch mimeType {
	case "image/png":
		return len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n"
	case "image/jpeg":
		return len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff
	case "image/webp":
		return len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP"
	default:
		return false
	}
}

func (s *CaptureStore) Owns(id, userID, runID, callID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupLocked(time.Now())
	asset, ok := s.items[id]
	return ok && asset.UserID == userID && asset.RunID == runID && asset.CallID == callID
}

func (s *CaptureStore) Take(id, userID, runID, callID string) (CaptureAsset, []byte, error) {
	if s == nil {
		return CaptureAsset{}, nil, errors.New("capture store unavailable")
	}
	s.mu.Lock()
	s.cleanupLocked(time.Now())
	asset, ok := s.items[id]
	if ok && asset.UserID == userID && asset.RunID == runID && asset.CallID == callID {
		delete(s.items, id)
	} else {
		ok = false
	}
	s.mu.Unlock()
	if !ok {
		return CaptureAsset{}, nil, errors.New("capture image unavailable or expired")
	}
	data, err := os.ReadFile(asset.Path)
	_ = os.Remove(asset.Path)
	if err != nil {
		return CaptureAsset{}, nil, err
	}
	return asset, data, nil
}

func (s *CaptureStore) cleanupLocked(now time.Time) {
	for id, asset := range s.items {
		if now.Sub(asset.Created) > captureTTL {
			delete(s.items, id)
			_ = os.Remove(asset.Path)
		}
	}
}

func (s *CaptureStore) Clear() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, asset := range s.items {
		delete(s.items, id)
		_ = os.Remove(asset.Path)
	}
	_ = os.RemoveAll(s.dir)
}
