package transport

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func itoa(n int) string { return strconv.Itoa(n) }

func TestValidateRejectsDowngrades(t *testing.T) {
	good, err := DirectTarget("https://api.openai.com/v1/chat/completions")
	if err != nil || good.Validate() != nil {
		t.Fatalf("direct target: %v", err)
	}
	bad := good
	bad.ResolutionSource = "classic-only"
	if bad.Validate() == nil {
		t.Fatal("unknown resolution source was accepted")
	}
	bad = good
	bad.TLSServerName = ""
	if bad.Validate() == nil {
		t.Fatal("empty SNI was accepted")
	}
}

func TestRewriteKeepsOriginalHost(t *testing.T) {
	target := Target{
		RequestURL:       "https://api.openai.com/v1/models",
		EffectiveHost:    "api.openai.com",
		EffectivePort:    443,
		DialTargets:      []DialTarget{{IP: "104.18.7.192", Family: "ipv4", TTL: 300}},
		TLSServerName:    "api.openai.com",
		ResolutionSource: "android-jvm-dns",
	}
	req, _ := http.NewRequest("GET", target.RequestURL, nil)
	out := target.RewriteRequest(req)
	if !strings.Contains(out.URL.Host, "104.18.7.192") {
		t.Fatalf("url host=%q", out.URL.Host)
	}
	if out.Host != "api.openai.com" {
		t.Fatalf("Host=%q", out.Host)
	}
}

func TestClientDialsIPLiteralWithOriginalSNI(t *testing.T) {
	var gotHost, gotSNI string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
		gotSNI = r.TLS.ServerName
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	host, port, err := ParseURL(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	// httptest serves TLS on an ephemeral port, so the non-default port is
	// part of the Host header. The production assertion is that the original
	// hostname (not the dial IP) is preserved, port included.
	wantHost := host + ":" + itoa(port)
	target := Target{
		RequestURL:       srv.URL,
		EffectiveHost:    host,
		EffectivePort:    port,
		DialTargets:      []DialTarget{{IP: host, Family: "ipv4", TTL: 60}},
		TLSServerName:    "api.openai.com",
		ResolutionSource: "literal",
		DialTimeoutMs:    8000,
	}
	if err := target.Validate(); err != nil {
		t.Fatal(err)
	}
	client := NewClient(target, DefaultPolicy(), 10*time.Second)
	tr := client.Transport.(*http.Transport)
	tr.TLSClientConfig.InsecureSkipVerify = true
	req, _ := http.NewRequest("GET", target.RequestURL, nil)
	resp, err := client.Do(target.RewriteRequest(req))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if gotHost != wantHost {
		t.Fatalf("Host=%q want %q", gotHost, wantHost)
	}
	// SNI travels on the TLS handshake; the test server observes the pinned name.
	if gotSNI != "api.openai.com" {
		t.Fatalf("SNI=%q", gotSNI)
	}
	if tr.TLSClientConfig.MinVersion != tls.VersionTLS12 {
		t.Fatal("TLS floor must stay 1.2")
	}
}

func TestRetryableClassification(t *testing.T) {
	for _, msg := range []string{"dial tcp: EAI_AGAIN", "connection reset by peer", "HTTP 503", "HTTP 429"} {
		if !Retryable(errMsg(msg)) {
			t.Fatalf("%q should retry", msg)
		}
	}
	for _, msg := range []string{"HTTP 401", "tls: certificate mismatch", "context canceled", "HTTP 400"} {
		if Retryable(errMsg(msg)) {
			t.Fatalf("%q must not retry", msg)
		}
	}
}

type errMsg string

func (e errMsg) Error() string { return string(e) }
