package link

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestPersistentIdentitySurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	n1 := NewNode()
	if err := n1.EnablePersistentIdentity(dir); err != nil {
		t.Fatal(err)
	}
	jwk1, err := n1.signingJWKFor("dev-1")
	if err != nil {
		t.Fatal(err)
	}
	n2 := NewNode()
	if err := n2.EnablePersistentIdentity(dir); err != nil {
		t.Fatal(err)
	}
	jwk2, err := n2.signingJWKFor("dev-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(jwk1) != string(jwk2) {
		t.Fatalf("jwk drifted across restart:\n%s\n%s", jwk1, jwk2)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "es256-*.p8"))
	if len(matches) != 1 {
		t.Fatalf("expected one key file, got %v", matches)
	}
}

func TestEnrollmentProofMatchesAndroidPayload(t *testing.T) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	proof, err := SignEnrollmentProof(priv, "bind", "device", "ab-12", "sas", "secret", "server")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(proof)
	if err != nil || len(raw) != 64 {
		t.Fatalf("proof %q is not 64-byte std base64", proof)
	}
	sum := sha256.Sum256([]byte("secret"))
	payload := strings.Join([]string{
		"zephyr-link-enrollment-v2", "bind", "device", "AB12", "sas", hex.EncodeToString(sum[:]), "server",
	}, "\x00")
	digest := sha256.Sum256([]byte(payload))
	r := new(big.Int).SetBytes(raw[:32])
	s := new(big.Int).SetBytes(raw[32:])
	if !ecdsa.Verify(&priv.PublicKey, digest[:], r, s) {
		t.Fatal("enrollment proof does not verify over the Android payload")
	}
}

func TestIdentityRoutesRequireDevice(t *testing.T) {
	n := NewNode()
	srv := httptest.NewServer(n.Handler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/link/identity/jwk")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}

func TestIdentityJWKRoundTrip(t *testing.T) {
	n := NewNode()
	if err := n.EnablePersistentIdentity(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(n.Handler())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/link/identity/jwk", "application/json", strings.NewReader(`{"deviceId":"dev-x"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body struct {
		OK  bool            `json:"ok"`
		JWK json.RawMessage `json:"jwk"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.OK || len(body.JWK) == 0 {
		t.Fatalf("body = %+v", body)
	}
	pub, err := parseES256JWK(body.JWK)
	if err != nil {
		t.Fatal(err)
	}
	if pub.Curve != elliptic.P256() {
		t.Fatal("not P-256")
	}
}

func TestDialWithPersistentIdentityFinishesWithoutHost(t *testing.T) {
	server := NewNode()
	server.RequireEnrollment()
	device := NewNode()
	if err := device.EnablePersistentIdentity(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	jwk, err := device.signingJWKFor("dev-auto")
	if err != nil {
		t.Fatal(err)
	}
	server.RegisterDeviceKey("dev-auto", jwk)

	srv := httptest.NewServer(server.Handler())
	defer srv.Close()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	dialBody := `{"serverUrl":"` + srv.URL + `","deviceId":"dev-auto"}`
	dresp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", strings.NewReader(dialBody))
	if err != nil {
		t.Fatal(err)
	}
	defer dresp.Body.Close()
	var dout struct {
		OK        bool   `json:"ok"`
		Pending   bool   `json:"pending"`
		SessionID string `json:"sessionId"`
	}
	if err := json.NewDecoder(dresp.Body).Decode(&dout); err != nil {
		t.Fatal(err)
	}
	if !dout.OK || dout.Pending || dout.SessionID == "" {
		t.Fatalf("identity dial should finish in one trip: %+v status=%d", dout, dresp.StatusCode)
	}
}

func TestDialWithoutIdentityStillReturnsPending(t *testing.T) {
	server := NewNode()
	server.RequireEnrollment()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server.RegisterDeviceKey("dev-host", JWKFromPublic(&priv.PublicKey))
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	device := NewNode()
	deviceSrv := httptest.NewServer(device.Handler())
	defer deviceSrv.Close()

	dialBody := `{"serverUrl":"` + srv.URL + `","deviceId":"dev-host"}`
	dresp, err := http.Post(deviceSrv.URL+"/link/dial", "application/json", strings.NewReader(dialBody))
	if err != nil {
		t.Fatal(err)
	}
	defer dresp.Body.Close()
	var dout struct {
		OK      bool `json:"ok"`
		Pending bool `json:"pending"`
	}
	if err := json.NewDecoder(dresp.Body).Decode(&dout); err != nil {
		t.Fatal(err)
	}
	if !dout.OK || !dout.Pending {
		t.Fatalf("android-shaped node must still return pending: %+v status=%d", dout, dresp.StatusCode)
	}
}
