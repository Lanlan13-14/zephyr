package embedded

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestEmbeddedEngineDispatch(t *testing.T) {
	dir := t.TempDir()
	cfg := Config{
		DataDir:    dir,
		AdminToken: "test_secret",
	}

	rt, err := Start(cfg)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer rt.Close()

	// 1. Create a session via in-memory dispatch
	body, _ := json.Marshal(map[string]any{
		"userId":             "u_mobile",
		"databaseGeneration": "gen_1",
		"title":              "Embedded Test Session",
	})

	resp, err := rt.Dispatch("POST", "/admin/sessions", map[string]string{
		"Content-Type": "application/json",
	}, body)
	if err != nil {
		t.Fatalf("Dispatch failed: %v", err)
	}

	if resp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(resp.Body))
	}

	var sessionResp struct {
		OK      bool `json:"ok"`
		Session struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"session"`
	}
	if err := json.Unmarshal(resp.Body, &sessionResp); err != nil {
		t.Fatalf("unmarshal session resp: %v", err)
	}
	if !sessionResp.OK || sessionResp.Session.ID == "" {
		t.Fatalf("invalid session response: %+v", sessionResp)
	}

	// 2. List sessions via in-memory dispatch
	listResp, err := rt.Dispatch("GET", "/admin/sessions?userId=u_mobile&databaseGeneration=gen_1", nil, nil)
	if err != nil {
		t.Fatalf("list sessions failed: %v", err)
	}
	if listResp.StatusCode != 200 {
		t.Fatalf("expected 200, got %d", listResp.StatusCode)
	}

	// 3. Test Global singleton functions
	initResp, err := InitGlobal(`{"dataDir":"` + dir + `","adminToken":"test_secret"}`)
	if err != nil {
		t.Fatalf("InitGlobal failed: %v", err)
	}
	var initOut struct {
		OK         bool   `json:"ok"`
		BaseURL    string `json:"baseUrl"`
		AdminToken string `json:"adminToken"`
	}
	if err := json.Unmarshal([]byte(initResp), &initOut); err != nil {
		t.Fatalf("parse init response: %v", err)
	}
	if !initOut.OK || initOut.BaseURL == "" || initOut.AdminToken != "test_secret" {
		t.Fatalf("unexpected init response: %s", initResp)
	}

	dispatchOut, err := DispatchGlobal("GET", "/admin/sessions?userId=u_mobile&databaseGeneration=gen_1", "{}", "")
	if err != nil {
		t.Fatalf("DispatchGlobal failed: %v", err)
	}
	if len(dispatchOut) == 0 {
		t.Fatalf("empty dispatch output")
	}

	// 4. The SSE loopback serves the SAME runtime instance: a session created
	// via dispatch must be visible over the HTTP endpoint it returned.
	req, _ := http.NewRequest("GET", initOut.BaseURL+"/admin/sessions?userId=u_mobile&databaseGeneration=gen_1", nil)
	req.Header.Set("X-AI-Admin", "test_secret")
	sseResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("SSE endpoint request failed: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != 200 {
		t.Fatalf("SSE endpoint status: %d", sseResp.StatusCode)
	}
	sseBody, _ := io.ReadAll(sseResp.Body)
	if !strings.Contains(string(sseBody), sessionResp.Session.ID) {
		t.Fatalf("SSE endpoint does not share runtime state: %s", string(sseBody))
	}

	CloseGlobal()
}
