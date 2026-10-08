package main

import (
	"bufio"
	"encoding/json"
	"io"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestHostOpenEditSelectionSave(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "editorcore-host")
	build := exec.Command("go", "build", "-o", bin, ".")
	build.Dir = "."
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	cmd := exec.Command(bin)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = io.WriteString(stdin, "{\"op\":\"shutdown\"}\n")
		_ = stdin.Close()
		_ = cmd.Wait()
	}()
	read := bufio.NewReader(stdout)
	call := func(payload string) map[string]any {
		t.Helper()
		if _, err := io.WriteString(stdin, payload+"\n"); err != nil {
			t.Fatal(err)
		}
		line, err := read.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var resp map[string]any
		if err := json.Unmarshal(line, &resp); err != nil {
			t.Fatalf("decode %s: %v", line, err)
		}
		if resp["ok"] != true {
			t.Fatalf("not ok: %s", line)
		}
		return resp
	}
	opened := call(`{"op":"open","text":"ab😀"}`)
	snap := opened["snapshot"].(map[string]any)
	id := snap["id"]
	if snap["lenChars"].(float64) != 3 || opened["text"] != "ab😀" {
		t.Fatalf("open scalars lost: %s", opened)
	}
	body, _ := json.Marshal(map[string]any{"op": "replace", "id": id, "start": 2, "end": 3, "text": "中", "base": 1, "extent": 1})
	_ = body
	edited := call(`{"op":"replace","id":` + jsonNumber(id) + `,"start":2,"end":3,"text":"中"}`)
	if edited["text"] != "ab中" {
		t.Fatalf("edit text %v", edited["text"])
	}
	sel := call(`{"op":"setSelection","id":` + jsonNumber(id) + `,"base":0,"extent":2}`)
	selection := sel["snapshot"].(map[string]any)["selection"].(map[string]any)
	if selection["base"].(float64) != 0 || selection["extent"].(float64) != 2 {
		t.Fatalf("selection %v", selection)
	}
	saved := call(`{"op":"text","id":` + jsonNumber(id) + `}`)
	if saved["text"] != "ab中" {
		t.Fatalf("save text %v", saved["text"])
	}
}

func jsonNumber(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
