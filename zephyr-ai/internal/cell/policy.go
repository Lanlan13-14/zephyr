package cell

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrLeaseExpired      = errors.New("execution lease expired")
	ErrLeaseConflict     = errors.New("execution lease epoch conflict")
	ErrAuthorityMismatch = errors.New("cell authority device mismatch")
	ErrCellUnavailable   = errors.New("cell runtime unavailable")
)

// ModelRoute represents the chosen routing strategy for model completion.
type ModelRoute string

const (
	ModelRouteAuto        ModelRoute = "auto"
	ModelRouteLocalDirect ModelRoute = "local-direct"
	ModelRouteMainRelay   ModelRoute = "main-relay"
)

// CellRoute represents the execution location preference for cell tools.
type CellRoute string

const (
	CellRouteAsk             CellRoute = "ask"
	CellRouteLocalPreferred  CellRoute = "local-preferred"
	CellRouteLocalOnly       CellRoute = "local-only"
	CellRouteRemotePreferred CellRoute = "remote-preferred"
	CellRouteRemoteOnly      CellRoute = "remote-only"
)

// FallbackPolicy determines behavior when preferred route is unreachable.
type FallbackPolicy string

const (
	FallbackAsk       FallbackPolicy = "ask"
	FallbackDeny      FallbackPolicy = "deny"
	FallbackAutomatic FallbackPolicy = "automatic"
)

// ExecutionPolicy governs per-conversation execution placement.
type ExecutionPolicy struct {
	ModelRoute ModelRoute     `json:"modelRoute"`
	CellRoute  CellRoute      `json:"cellRoute"`
	Fallback   FallbackPolicy `json:"fallback"`
}

func DefaultExecutionPolicy() ExecutionPolicy {
	return ExecutionPolicy{
		ModelRoute: ModelRouteAuto,
		CellRoute:  CellRouteLocalPreferred,
		Fallback:   FallbackAsk,
	}
}

// Scope determines cell instance isolation boundary.
type Scope string

const (
	ScopeConversation Scope = "conversation"
	ScopeGroup        Scope = "group"
)

// CellBinding establishes a stable binding between a conversation/group and a sandboxed Cell.
type CellBinding struct {
	BindingID       string    `json:"bindingId"`
	Scope           Scope     `json:"scope"`
	ConversationID  string    `json:"conversationId,omitempty"`
	GroupID         string    `json:"groupId,omitempty"`
	CellID          string    `json:"cellId"`
	Generation      string    `json:"generation"`
	ProfileID       string    `json:"profileId"`
	CreatedAt       time.Time `json:"createdAt"`
	LastActiveAt    time.Time `json:"lastActiveAt"`
	RetentionPolicy string    `json:"retentionPolicy"`
	Status          string    `json:"status"` // active, paused, destroyed
}

// ExecutionLease fixes the Cell authority for a single run to prevent file split-brain.
type ExecutionLease struct {
	RunID                 string    `json:"runId"`
	ConversationID        string    `json:"conversationId"`
	BindingID             string    `json:"bindingId"`
	CellAuthorityDeviceID string    `json:"cellAuthorityDeviceId"`
	LeaseEpoch            int64     `json:"leaseEpoch"`
	ExpiresAt             time.Time `json:"expiresAt"`
	IdempotencyKey        string    `json:"idempotencyKey"`
}

// Validate checks whether an operation under this lease is allowed.
func (l *ExecutionLease) Validate(targetDeviceID string, currentEpoch int64) error {
	if time.Now().After(l.ExpiresAt) {
		return ErrLeaseExpired
	}
	if currentEpoch != l.LeaseEpoch {
		return fmt.Errorf("%w: expected epoch %d, got %d", ErrLeaseConflict, l.LeaseEpoch, currentEpoch)
	}
	if targetDeviceID != "" && l.CellAuthorityDeviceID != "" && !strings.EqualFold(targetDeviceID, l.CellAuthorityDeviceID) {
		return fmt.Errorf("%w: run authority belongs to %s, rejected call on %s", ErrAuthorityMismatch, l.CellAuthorityDeviceID, targetDeviceID)
	}
	return nil
}
