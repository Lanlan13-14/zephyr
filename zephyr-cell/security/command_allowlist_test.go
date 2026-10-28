package security

import "testing"

func TestCommandAllowlist_DefaultDenyUnknown(t *testing.T) {
	list := NewCommandAllowlist(DefaultCellCommands)
	if list.Allow("rm") {
		t.Fatal("rm must be denied")
	}
	if list.Allow("bash -c id") {
		t.Fatal("argv soup must be denied")
	}
	if list.Allow("/bin/ls") {
		t.Fatal("absolute path is not implicitly allowlisted")
	}
	if !list.Allow("ls") {
		t.Fatal("ls should be allowed")
	}
	if !list.Allow("  cat") {
		t.Fatal("leading space should still match cat")
	}
}

func TestCommandAllowlist_EmptyIsDeny(t *testing.T) {
	list := NewCommandAllowlist(nil)
	if list.Allow("ls") {
		t.Fatal("empty list must deny everything")
	}
	if list.Allow("") {
		t.Fatal("empty argv must deny")
	}
}
