package embedded

import (
	"encoding/json"
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
	if initResp != `{"ok":true}` {
		t.Fatalf("unexpected init response: %s", initResp)
	}

	dispatchOut, err := DispatchGlobal("GET", "/admin/sessions?userId=u_mobile&databaseGeneration=gen_1", "{}", "")
	if err != nil {
		t.Fatalf("DispatchGlobal failed: %v", err)
	}
	if len(dispatchOut) == 0 {
		t.Fatalf("empty dispatch output")
	}

	CloseGlobal()
}
