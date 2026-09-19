package cell

import "fmt"

// Capability represents a single engine capability bit.
// Upper layers branch on capabilities, never on platform names (§2.3).
type Capability uint16

const (
	// CapSnapshot indicates the engine supports memory snapshot and restore.
	// Only CellVM (macOS ARM Virtualization.framework) exposes this in v1.
	CapSnapshot Capability = 1 << iota

	// CapPersistShell indicates persistent shell sessions across exec calls.
	// All engines support this.
	CapPersistShell

	// CapCgroupLimits indicates hard CPU/memory limits via cgroup v2.
	// PRoot and Asbestos report partial (engine-internal soft limits).
	CapCgroupLimits

	// CapNetFilter indicates guest-level network egress filtering.
	CapNetFilter

	// CapPTY indicates interactive terminal (PTY) support.
	CapPTY

	// CapOffload indicates native offload (zc-*) handler support.
	CapOffload

	// CapBrowserOffload indicates browser-side capability forwarding
	// via WebSocket frames. Only Cell-Server (Web/Docker) exposes this.
	CapBrowserOffload
)

// CapabilitySet is a bitmask of engine capabilities.
// SDK exposes this via Cell.Capabilities(); upper layers degrade by capability,
// never by platform (§2.3 rule).
type CapabilitySet uint16

// Has reports whether the set includes all of the given capabilities.
func (s CapabilitySet) Has(caps ...Capability) bool {
	for _, c := range caps {
		if uint16(s)&uint16(c) == 0 {
			return false
		}
	}
	return true
}

// Set returns a new CapabilitySet with the given capabilities added.
func (s CapabilitySet) Set(caps ...Capability) CapabilitySet {
	v := uint16(s)
	for _, c := range caps {
		v |= uint16(c)
	}
	return CapabilitySet(v)
}

// String returns a human-readable representation listing all set capabilities.
func (s CapabilitySet) String() string {
	names := []struct {
		c Capability
		n string
	}{
		{CapSnapshot, "SNAPSHOT"},
		{CapPersistShell, "PERSIST_SHELL"},
		{CapCgroupLimits, "CGROUP_LIMITS"},
		{CapNetFilter, "NET_FILTER"},
		{CapPTY, "PTY"},
		{CapOffload, "OFFLOAD"},
		{CapBrowserOffload, "BROWSER_OFFLOAD"},
	}
	var out string
	for _, n := range names {
		if s.Has(n.c) {
			if out != "" {
				out += "|"
			}
			out += n.n
		}
	}
	if out == "" {
		return "NONE"
	}
	return fmt.Sprintf("CapabilitySet(%s)", out)
}

// Pre-defined capability sets for each engine (§2.3 matrix).

// CapsDefault is the empty capability set.
const CapsDefault CapabilitySet = 0

// CapsDirect is the capability set for the Direct (Linux) engine.
var CapsDirect = CapsDefault.
	Set(CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload)

// CapsCellVM is the capability set for the CellVM (macOS ARM) engine.
var CapsCellVM = CapsDefault.
	Set(CapSnapshot, CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload)

// CapsWSL2 is the capability set for the WSL2-bridge (Windows) engine.
var CapsWSL2 = CapsDefault.
	Set(CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload)

// CapsPRoot is the capability set for the PRoot (Android) engine.
// CgroupLimits and NetFilter are partial (engine-internal soft limits).
var CapsPRoot = CapsDefault.
	Set(CapPersistShell, CapPTY, CapOffload)

// CapsAsbestos is the capability set for the Asbestos (iOS) engine.
// CgroupLimits and NetFilter are partial (engine-internal soft limits).
var CapsAsbestos = CapsDefault.
	Set(CapPersistShell, CapPTY, CapOffload)

// CapsCellServer is the capability set for Cell-Server (Web/Docker).
var CapsCellServer = CapsDefault.
	Set(CapPersistShell, CapCgroupLimits, CapNetFilter, CapPTY, CapOffload, CapBrowserOffload)
