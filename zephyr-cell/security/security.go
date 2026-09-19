// Package security implements the Cell security model (§7).
//
// Key components:
//   - SeccompFallbackPolicy: Android PRoot seccomp retry logic (§4.5.3)
//   - NetworkEnforcer: egress whitelist, metadata blackhole (§3.5)
//   - EnvSanitizer: sensitive value handling (§3.3)
package security

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"strings"
	"time"
)

// SeccompFallbackPolicy implements the Android PRoot seccomp fallback (§4.5.3).
//
// Trigger signature (ALL THREE must be true):
//   - Exit code ∈ {132 (SIGILL), 135 (SIGBUS), 139 (SIGSEGV), 159 (SIGSYS)}
//   - Process survived < 1.5 seconds
//   - No output produced
//
// Action: Retry EXACTLY ONCE with PROOT_NO_SECCOMP=1.
//
// FORBIDDEN to retry on:
//   - SIGKILL (137) — external kill, may have side effects
//   - SIGTERM (143) — graceful shutdown
//   - SIGABRT (134) — intentional abort
type SeccompFallbackPolicy struct {
	// retriedCommands tracks commands that have already been retried.
	// Key: session_id + ":" + cmd hash. Value: true if already retried.
	retriedCommands map[string]bool
}

// NewSeccompFallbackPolicy creates a new policy instance.
func NewSeccompFallbackPolicy() *SeccompFallbackPolicy {
	return &SeccompFallbackPolicy{
		retriedCommands: make(map[string]bool),
	}
}

// seccompTriggerExitCodes are the exit codes that indicate a seccomp conflict.
var seccompTriggerExitCodes = map[int]string{
	132: "SIGILL",
	135: "SIGBUS",
	139: "SIGSEGV",
	159: "SIGSYS",
}

// forbiddenRetryExitCodes are exit codes where retry is forbidden.
var forbiddenRetryExitCodes = map[int]string{
	134: "SIGABRT",
	137: "SIGKILL",
	143: "SIGTERM",
}

// maxSurvivalDuration is the threshold below which a crash indicates seccomp conflict.
const maxSurvivalDuration = 1500 * time.Millisecond

// ShouldRetry determines whether a failed execution should be retried with
// PROOT_NO_SECCOMP=1. Returns true only if all three trigger conditions are met
// AND the command has not already been retried.
func (p *SeccompFallbackPolicy) ShouldRetry(sessionID, cmd string, exitCode int, duration time.Duration, outputLen int) bool {
	// Check if exit code is a seccomp trigger
	if _, ok := seccompTriggerExitCodes[exitCode]; !ok {
		return false
	}

	// Check forbidden codes (shouldn't overlap, but defensive)
	if _, forbidden := forbiddenRetryExitCodes[exitCode]; forbidden {
		return false
	}

	// All three conditions must be true
	if duration >= maxSurvivalDuration {
		return false // survived too long, probably not seccomp
	}
	if outputLen > 0 {
		return false // produced output, probably not seccomp crash at startup
	}

	// Check if already retried (retry EXACTLY ONCE)
	key := sessionID + ":" + hashCmd(cmd)
	if p.retriedCommands[key] {
		return false
	}

	// Mark as retried
	p.retriedCommands[key] = true
	return true
}

// IsForbiddenRetry checks if the exit code explicitly forbids retry.
func IsForbiddenRetry(exitCode int) bool {
	_, forbidden := forbiddenRetryExitCodes[exitCode]
	return forbidden
}

// IsSeccompSignal checks if the exit code corresponds to a seccomp-related signal.
func IsSeccompSignal(exitCode int) bool {
	_, ok := seccompTriggerExitCodes[exitCode]
	return ok
}

func hashCmd(cmd string) string {
	h := sha256.Sum256([]byte(cmd))
	return hex.EncodeToString(h[:8])
}

// NetworkEnforcer enforces egress network policy (§3.5, §7.2).
type NetworkEnforcer struct {
	allowedDomains map[string]bool
	allowedCIDRs   []*net.IPNet
	blockMetadata  bool
	forceProxy     string

	// Metadata address ranges to blackhole (§3.5)
	metadataCIDRs []*net.IPNet
}

// NewNetworkEnforcer creates an enforcer from a network policy.
func NewNetworkEnforcer(domains []string, cidrs []string, blockMeta bool, proxy string) (*NetworkEnforcer, error) {
	e := &NetworkEnforcer{
		allowedDomains: make(map[string]bool, len(domains)),
		blockMetadata:  blockMeta,
		forceProxy:     proxy,
	}

	for _, d := range domains {
		e.allowedDomains[strings.ToLower(d)] = true
	}

	for _, cidr := range cidrs {
		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			return nil, fmt.Errorf("security: invalid CIDR %q: %w", cidr, err)
		}
		e.allowedCIDRs = append(e.allowedCIDRs, ipNet)
	}

	// Cloud metadata ranges (§3.5: Web端为强制不可关)
	metaRanges := []string{
		"169.254.0.0/16", // AWS/GCP/Azure link-local metadata
		"fd00:ec2::/120", // AWS IMDSv2 IPv6
	}
	for _, mr := range metaRanges {
		_, ipNet, err := net.ParseCIDR(mr)
		if err != nil {
			continue // shouldn't happen with hardcoded ranges
		}
		e.metadataCIDRs = append(e.metadataCIDRs, ipNet)
	}

	return e, nil
}

// CheckDomain checks if a domain is allowed by the egress whitelist.
func (e *NetworkEnforcer) CheckDomain(domain string) bool {
	if len(e.allowedDomains) == 0 {
		return false // default deny: empty whitelist = no network
	}
	return e.allowedDomains[strings.ToLower(domain)]
}

// CheckIP checks if an IP address is allowed.
func (e *NetworkEnforcer) CheckIP(ip net.IP) bool {
	// Block metadata ranges
	if e.blockMetadata {
		for _, cidr := range e.metadataCIDRs {
			if cidr.Contains(ip) {
				return false
			}
		}
	}

	// Check whitelist
	if len(e.allowedCIDRs) == 0 && len(e.allowedDomains) == 0 {
		return false // default deny
	}

	for _, cidr := range e.allowedCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}

	return false
}

// IsMetadataIP checks if an IP is in the cloud metadata range.
func (e *NetworkEnforcer) IsMetadataIP(ip net.IP) bool {
	for _, cidr := range e.metadataCIDRs {
		if cidr.Contains(ip) {
			return true
		}
	}
	return false
}

// EnvSanitizer handles sensitive environment variable processing (§3.3).
type EnvSanitizer struct {
	// sensitivePatterns are substrings that indicate a sensitive env var name.
	sensitivePatterns []string
}

// NewEnvSanitizer creates a sanitizer with default sensitive patterns.
func NewEnvSanitizer() *EnvSanitizer {
	return &EnvSanitizer{
		sensitivePatterns: []string{
			"KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL",
			"AUTH", "APIKEY", "API_KEY", "PRIVATE",
		},
	}
}

// IsSensitive checks if an env var name likely contains sensitive data.
func (s *EnvSanitizer) IsSensitive(key string) bool {
	upper := strings.ToUpper(key)
	for _, pat := range s.sensitivePatterns {
		if strings.Contains(upper, pat) {
			return true
		}
	}
	return false
}

// HashValue returns a truncated SHA-256 hash of a value for audit logging.
// Audit records key names and hash, never actual values (§3.3).
func (s *EnvSanitizer) HashValue(value string) string {
	h := sha256.Sum256([]byte(value))
	return hex.EncodeToString(h[:8])
}

// SanitizeForAudit returns a copy of env keys suitable for audit logging.
// Sensitive keys get their values replaced with hashes; only key names are returned.
func (s *EnvSanitizer) SanitizeForAudit(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	return keys
}
