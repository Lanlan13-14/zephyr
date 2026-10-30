package security

import "testing"

func TestCommandAllowlist_DefaultDenyUnknown(t *testing.T) {
	list := NewCommandAllowlist(DefaultCellCommands)
	if list.Allow("rm") { t.Fatal("rm must be denied") }
	if list.Allow("bash -c id") { t.Fatal("argv soup must be denied") }
	if list.Allow("/bin/ls") { t.Fatal("absolute path is not implicitly allowlisted") }
	if !list.Allow("ls") { t.Fatal("ls should be allowed") }
	if !list.Allow("  cat") { t.Fatal("leading space should still match cat") }
	if list.Allow("cat file.txt") { t.Fatal("arguments need a structured argv contract") }
}

func TestCommandAllowlist_DeniesEntireShellString(t *testing.T) {
	list := NewCommandAllowlist(DefaultCellCommands)
	for _, command := range []string{
		"echo safe; rm -rf target",
		"echo safe && sh",
		"cat file > target",
		"cat /etc/passwd",
		"echo $(id)",
		"echo `id`",
		"ls|sh",
		"env rm target",
		"env -S sh",
		"env SHELL=sh",
		"echo\nrm target",
		"ls\\\nrm",
	} {
		if list.Allow(command) { t.Errorf("full shell string must be denied: %q", command) }
	}
}

func TestCommandAllowlist_EmptyIsDeny(t *testing.T) {
	list := NewCommandAllowlist(nil)
	if list.Allow("ls") { t.Fatal("empty list must deny everything") }
	if list.Allow("") { t.Fatal("empty argv must deny") }
}
