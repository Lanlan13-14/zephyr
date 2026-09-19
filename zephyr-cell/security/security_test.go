package security

import (
	"net"
	"testing"
	"time"
)

// --- SeccompFallbackPolicy tests (§4.5.3) ---

func TestSeccomp_TriggerCodes(t *testing.T) {
	// All three conditions met: should retry
	cases := []struct {
		exit int
		name string
	}{
		{132, "SIGILL"},
		{135, "SIGBUS"},
		{139, "SIGSEGV"},
		{159, "SIGSYS"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pp := NewSeccompFallbackPolicy() // fresh for each
			if !pp.ShouldRetry("s1", "test_cmd_"+tc.name, tc.exit, 100*time.Millisecond, 0) {
				t.Errorf("exit %d should trigger retry", tc.exit)
			}
		})
	}
}

func TestSeccomp_ForbiddenCodes(t *testing.T) {
	p := NewSeccompFallbackPolicy()

	forbidden := []struct {
		exit int
		name string
	}{
		{134, "SIGABRT"},
		{137, "SIGKILL"},
		{143, "SIGTERM"},
	}
	for _, tc := range forbidden {
		t.Run(tc.name, func(t *testing.T) {
			if p.ShouldRetry("s1", "cmd", tc.exit, 100*time.Millisecond, 0) {
				t.Errorf("exit %d should be FORBIDDEN for retry", tc.exit)
			}
		})
	}
}

func TestSeccomp_SurvivedTooLong(t *testing.T) {
	p := NewSeccompFallbackPolicy()
	// Process survived 2 seconds — probably not seccomp
	if p.ShouldRetry("s1", "cmd", 139, 2*time.Second, 0) {
		t.Error("should not retry: survived > 1.5s")
	}
}

func TestSeccomp_HasOutput(t *testing.T) {
	p := NewSeccompFallbackPolicy()
	// Process produced output — probably not seccomp crash at startup
	if p.ShouldRetry("s1", "cmd", 139, 100*time.Millisecond, 42) {
		t.Error("should not retry: has output")
	}
}

func TestSeccomp_RetryExactlyOnce(t *testing.T) {
	p := NewSeccompFallbackPolicy()

	// First attempt: should retry
	if !p.ShouldRetry("s1", "same_cmd", 139, 100*time.Millisecond, 0) {
		t.Error("first attempt should retry")
	}

	// Second attempt: should NOT retry (exactly once)
	if p.ShouldRetry("s1", "same_cmd", 139, 100*time.Millisecond, 0) {
		t.Error("second attempt should NOT retry")
	}
}

func TestSeccomp_DifferentCommandCanRetry(t *testing.T) {
	p := NewSeccompFallbackPolicy()

	p.ShouldRetry("s1", "cmd_a", 139, 100*time.Millisecond, 0)

	// Different command should be allowed to retry
	if !p.ShouldRetry("s1", "cmd_b", 139, 100*time.Millisecond, 0) {
		t.Error("different command should be allowed to retry")
	}
}

func TestSeccomp_NormalExitCodes(t *testing.T) {
	p := NewSeccompFallbackPolicy()

	normal := []int{0, 1, 2, 126, 127, 255}
	for _, code := range normal {
		if p.ShouldRetry("s1", "cmd", code, 100*time.Millisecond, 0) {
			t.Errorf("exit code %d should not trigger retry", code)
		}
	}
}

func TestIsForbiddenRetry(t *testing.T) {
	if !IsForbiddenRetry(137) {
		t.Error("137 (SIGKILL) should be forbidden")
	}
	if IsForbiddenRetry(139) {
		t.Error("139 (SIGSEGV) should not be forbidden")
	}
}

func TestIsSeccompSignal(t *testing.T) {
	if !IsSeccompSignal(139) {
		t.Error("139 should be seccomp signal")
	}
	if IsSeccompSignal(0) {
		t.Error("0 should not be seccomp signal")
	}
}

// --- NetworkEnforcer tests (§3.5) ---

func TestNetworkEnforcer_DefaultDeny(t *testing.T) {
	e, err := NewNetworkEnforcer(nil, nil, true, "")
	if err != nil {
		t.Fatal(err)
	}

	if e.CheckDomain("example.com") {
		t.Error("default deny: no domains should be allowed")
	}
	if e.CheckIP(net.ParseIP("1.2.3.4")) {
		t.Error("default deny: no IPs should be allowed")
	}
}

func TestNetworkEnforcer_DomainWhitelist(t *testing.T) {
	e, err := NewNetworkEnforcer([]string{"api.example.com", "cdn.test.io"}, nil, true, "")
	if err != nil {
		t.Fatal(err)
	}

	if !e.CheckDomain("api.example.com") {
		t.Error("whitelisted domain should be allowed")
	}
	if !e.CheckDomain("API.EXAMPLE.COM") {
		t.Error("domain check should be case-insensitive")
	}
	if e.CheckDomain("evil.com") {
		t.Error("non-whitelisted domain should be denied")
	}
}

func TestNetworkEnforcer_MetadataBlackhole(t *testing.T) {
	e, err := NewNetworkEnforcer([]string{"*"}, []string{"0.0.0.0/0"}, true, "")
	if err != nil {
		t.Fatal(err)
	}

	// Metadata IP should be blocked even with open whitelist
	metaIP := net.ParseIP("169.254.169.254")
	if !e.IsMetadataIP(metaIP) {
		t.Error("169.254.169.254 should be detected as metadata IP")
	}
	if e.CheckIP(metaIP) {
		t.Error("metadata IP should be blocked")
	}

	// Non-metadata IP should be allowed with open CIDR
	if !e.CheckIP(net.ParseIP("8.8.8.8")) {
		t.Error("8.8.8.8 should be allowed with 0.0.0.0/0 whitelist")
	}
}

func TestNetworkEnforcer_CIDRWhitelist(t *testing.T) {
	e, err := NewNetworkEnforcer(nil, []string{"10.0.0.0/8"}, true, "")
	if err != nil {
		t.Fatal(err)
	}

	if !e.CheckIP(net.ParseIP("10.1.2.3")) {
		t.Error("10.1.2.3 should be allowed in 10.0.0.0/8")
	}
	if e.CheckIP(net.ParseIP("192.168.1.1")) {
		t.Error("192.168.1.1 should not be allowed")
	}
}

// --- EnvSanitizer tests (§3.3) ---

func TestEnvSanitizer_SensitiveDetection(t *testing.T) {
	s := NewEnvSanitizer()

	sensitive := []string{"API_KEY", "OPENAI_TOKEN", "MY_SECRET", "DB_PASSWORD", "AUTH_CREDENTIAL"}
	for _, k := range sensitive {
		if !s.IsSensitive(k) {
			t.Errorf("%s should be detected as sensitive", k)
		}
	}

	safe := []string{"PATH", "HOME", "LANG", "TZ", "GOARCH"}
	for _, k := range safe {
		if s.IsSensitive(k) {
			t.Errorf("%s should not be detected as sensitive", k)
		}
	}
}

func TestEnvSanitizer_HashValue(t *testing.T) {
	s := NewEnvSanitizer()

	h1 := s.HashValue("my-secret-value")
	h2 := s.HashValue("my-secret-value")
	h3 := s.HashValue("different-value")

	if h1 != h2 {
		t.Error("same value should produce same hash")
	}
	if h1 == h3 {
		t.Error("different values should produce different hashes")
	}
	if len(h1) != 16 { // 8 bytes = 16 hex chars
		t.Errorf("hash length: want 16, got %d", len(h1))
	}
}

func TestEnvSanitizer_AuditKeys(t *testing.T) {
	s := NewEnvSanitizer()
	env := map[string]string{"PATH": "/bin", "API_KEY": "secret123"}

	keys := s.SanitizeForAudit(env)
	if len(keys) != 2 {
		t.Errorf("keys: want 2, got %d", len(keys))
	}
	// Keys only, no values
	for _, k := range keys {
		if k == "secret123" || k == "/bin" {
			t.Error("audit keys should not contain values")
		}
	}
}
