package permission

import (
	"encoding/json"
	"testing"
)

func TestDecidePrecedence(t *testing.T) {
	e := NewEngine(Policy{
		Mode:  ModeAsk,
		Deny:  []Rule{`remote_execute(rm -rf*)`},
		Allow: []Rule{`remote_execute(systemctl status*)`, `list_connections`},
		Ask:   []Rule{`remote_write_file(*)`},
	})

	allow := e.Decide(Request{Tool: "list_connections", ReadOnly: true, Args: json.RawMessage(`{}`)})
	if allow != Allow {
		t.Fatalf("list_connections want allow got %s", allow)
	}

	deny := e.Decide(Request{Tool: "remote_execute", Args: json.RawMessage(`{"command":"rm -rf /"}`)})
	if deny != Deny {
		t.Fatalf("rm want deny got %s", deny)
	}

	ok := e.Decide(Request{Tool: "remote_execute", Args: json.RawMessage(`{"command":"systemctl status nginx"}`)})
	if ok != Allow {
		t.Fatalf("systemctl status want allow got %s", ok)
	}

	ask := e.Decide(Request{Tool: "remote_write_file", Args: json.RawMessage(`{"path":"/etc/x"}`), ReadOnly: false})
	if ask != Ask {
		t.Fatalf("write want ask got %s", ask)
	}
}

func TestModeAuto(t *testing.T) {
	e := NewEngine(Policy{Mode: ModeAuto})
	if e.Decide(Request{Tool: "x", ReadOnly: true}) != Allow {
		t.Fatal("readonly should allow in auto")
	}
	if e.Decide(Request{Tool: "y", ReadOnly: false}) != Ask {
		t.Fatal("writer should ask in auto")
	}
}

func TestModeYolo(t *testing.T) {
	e := NewEngine(Policy{Mode: ModeYolo, Deny: []Rule{"boom"}})
	if e.Decide(Request{Tool: "anything"}) != Allow {
		t.Fatal("yolo allows")
	}
	if e.Decide(Request{Tool: "boom"}) != Deny {
		t.Fatal("deny still wins")
	}
}
