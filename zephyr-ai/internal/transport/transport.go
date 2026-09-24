// Package transport builds HTTP clients that dial host-resolved IP literals
// while keeping the original hostname for TLS SNI. On Android the embedded Go
// runtime is CGO_ENABLED=0 and has no DNS, so the JVM pre-resolves provider,
// OAuth and MCP hosts and hands Go a TransportTarget per the AI Contract v2
// transport-policy schema. Every outbound channel (model discovery, chat and
// responses streams, OAuth refresh, MCP HTTP) must go through this package;
// a bare http.Client with a domain URL is a latent EAI_AGAIN on device.
package transport

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DialTarget is one pre-resolved IP for the effective host.
type DialTarget struct {
	IP     string `json:"ip"`
	Family string `json:"family"`
	TTL    int    `json:"ttl"`
}

// Target mirrors contracts/ai/v2 transport-policy.schema.json#/$defs/transportTarget.
type Target struct {
	RequestURL       string       `json:"requestUrl"`
	EffectiveHost    string       `json:"effectiveHost"`
	EffectivePort    int          `json:"effectivePort"`
	DialTargets      []DialTarget `json:"dialTargets"`
	TLSServerName    string       `json:"tlsServerName"`
	ResolutionSource string       `json:"resolutionSource"`
	DialTimeoutMs    int          `json:"dialTimeoutMs"`
}

// Policy mirrors the transport-policy document (retry + TLS floor + dial budget).
type Policy struct {
	DialTimeoutMs int
	TLSMin12      bool
	MaxAttempts   int
	BaseDelayMs   int
	MaxDelayMs    int
}

// DefaultPolicy is the contract default: 8s dial, TLS 1.2 floor, bounded retries.
func DefaultPolicy() Policy {
	return Policy{DialTimeoutMs: 8000, TLSMin12: true, MaxAttempts: 3, BaseDelayMs: 200, MaxDelayMs: 5000}
}

// ParseURL splits a request URL into host and port for target construction.
func ParseURL(requestURL string) (host string, port int, err error) {
	u, err := url.Parse(requestURL)
	if err != nil {
		return "", 0, err
	}
	host = u.Hostname()
	if host == "" {
		return "", 0, fmt.Errorf("transport: url %q has no host", requestURL)
	}
	portStr := u.Port()
	if portStr == "" {
		if strings.EqualFold(u.Scheme, "http") {
			return host, 80, nil
		}
		return host, 443, nil
	}
	port, err = strconv.Atoi(portStr)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("transport: url %q has bad port", requestURL)
	}
	return host, port, nil
}

// DirectTarget builds a no-pre-resolution target for desktop/server runtimes
// where the Go resolver works. Dial falls back to the system resolver.
func DirectTarget(requestURL string) (Target, error) {
	host, port, err := ParseURL(requestURL)
	if err != nil {
		return Target{}, err
	}
	return Target{
		RequestURL:       requestURL,
		EffectiveHost:    host,
		EffectivePort:    port,
		DialTargets:      nil,
		TLSServerName:    host,
		ResolutionSource: "literal",
		DialTimeoutMs:    DefaultPolicy().DialTimeoutMs,
	}, nil
}

// Validate rejects targets that would silently downgrade security: empty dial
// lists with a mismatched SNI, unknown resolution sources, or absurd timeouts.
func (t Target) Validate() error {
	if strings.TrimSpace(t.RequestURL) == "" {
		return fmt.Errorf("transport: requestUrl required")
	}
	if strings.TrimSpace(t.EffectiveHost) == "" {
		return fmt.Errorf("transport: effectiveHost required")
	}
	if t.EffectivePort < 1 || t.EffectivePort > 65535 {
		return fmt.Errorf("transport: effectivePort out of range")
	}
	if strings.TrimSpace(t.TLSServerName) == "" {
		return fmt.Errorf("transport: tlsServerName required")
	}
	switch t.ResolutionSource {
	case "android-jvm-dns", "ios-system-dns", "desktop-system-dns", "literal":
	default:
		return fmt.Errorf("transport: unknown resolutionSource %q", t.ResolutionSource)
	}
	if t.DialTimeoutMs < 1 || t.DialTimeoutMs > 120000 {
		return fmt.Errorf("transport: dialTimeoutMs out of range")
	}
	seen := map[string]bool{}
	for _, d := range t.DialTargets {
		ip := strings.TrimSpace(d.IP)
		if ip == "" || seen[ip] {
			return fmt.Errorf("transport: bad dial target %q", d.IP)
		}
		seen[ip] = true
		if d.Family != "ipv4" && d.Family != "ipv6" {
			return fmt.Errorf("transport: bad dial family %q", d.Family)
		}
	}
	return nil
}

// RewriteRequest returns a copy of req aimed at the first dialable IP while
// keeping the original hostname in the Host field (HTTP/1.1 Host header) so a
// pre-resolved request is indistinguishable from a DNS one at the origin.
func (t Target) RewriteRequest(req *http.Request) *http.Request {
	if len(t.DialTargets) == 0 {
		return req
	}
	first := t.DialTargets[0].IP
	host := first
	if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	clone := req.Clone(req.Context())
	u := *req.URL
	u.Host = host + ":" + strconv.Itoa(t.EffectivePort)
	clone.URL = &u
	clone.Host = t.EffectiveHost
	if t.EffectivePort != 443 && t.EffectivePort != 80 {
		clone.Host += ":" + strconv.Itoa(t.EffectivePort)
	}
	return clone
}

// NewClient builds an HTTP client that dials the pre-resolved IPs in order
// (IPv4 first as handed over) and pins TLS SNI to the original hostname.
// A nil-target client is never returned: callers without a resolved target
// must pass a DirectTarget so the dial path stays explicit.
func NewClient(t Target, p Policy, timeout time.Duration) *http.Client {
	dialTimeout := time.Duration(t.DialTimeoutMs) * time.Millisecond
	if dialTimeout <= 0 {
		dialTimeout = time.Duration(p.DialTimeoutMs) * time.Millisecond
	}
	if dialTimeout <= 0 {
		dialTimeout = 8 * time.Second
	}
	targets := append([]DialTarget(nil), t.DialTargets...)
	tlsName := t.TLSServerName
	if tlsName == "" {
		tlsName = t.EffectiveHost
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if len(targets) == 0 {
				d := net.Dialer{Timeout: dialTimeout}
				return d.DialContext(ctx, network, addr)
			}
			var lastErr error
			for _, ipTarget := range targets {
				host := ipTarget.IP
				d := net.Dialer{Timeout: dialTimeout}
				conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(t.EffectivePort)))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, fmt.Errorf("transport: all %d dial targets failed for %s: %w", len(targets), t.EffectiveHost, lastErr)
		},
		TLSClientConfig: &tls.Config{
			ServerName: tlsName,
			MinVersion: tls.VersionTLS12,
		},
		ForceAttemptHTTP2: true,
		IdleConnTimeout:   90 * time.Second,
	}
	if timeout <= 0 {
		timeout = 120 * time.Second
	}
	return &http.Client{Timeout: timeout, Transport: tr}
}

// Retryable reports whether err merits a bounded retry with backoff. DNS
// blips, resets and 5xx are retryable; auth, malformed requests, SNI mismatch
// and user cancellation never are.
func Retryable(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "context canceled") || strings.Contains(msg, "context deadline") {
		return false
	}
	for _, token := range []string{"401", "403", "400", "tls", "certificate", "hostname", "cancel"} {
		if strings.Contains(msg, token) {
			return false
		}
	}
	for _, token := range []string{"dns", "reset", "timeout", "temporar", "eai_again", "no such host", "connection refused", "429", "408", "409", "500", "502", "503", "504"} {
		if strings.Contains(msg, token) {
			return true
		}
	}
	return false
}

// Backoff returns the deterministic sleep before attempt n (0-based) with the
// policy bounds applied. Sleeps are interruptible: callers must select on
// ctx.Done() rather than time.Sleep directly.
func Backoff(p Policy, n int) time.Duration {
	base := time.Duration(p.BaseDelayMs) * time.Millisecond
	if base <= 0 {
		base = 200 * time.Millisecond
	}
	max := time.Duration(p.MaxDelayMs) * time.Millisecond
	if max <= 0 {
		max = 5 * time.Second
	}
	d := base << n
	if d <= 0 || d > max {
		return max
	}
	return d
}
