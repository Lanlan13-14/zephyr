package cell

// Guest path constants (§3.2 unified file layout).
// All paths are absolute guest paths. Host-side paths are managed by the SDK
// and MUST NOT be hard-coded by application code — use MapPath().

const (
	// GuestWorkspace is the current session's working directory.
	// Lifecycle: session-level persistent.
	GuestWorkspace = "/cell/workspace"

	// GuestInbox is where input files are delivered to the guest.
	// Lifecycle: session-level.
	GuestInbox = "/cell/inbox"

	// GuestOutbox is where large outputs and offload results are written.
	// Lifecycle: session-level.
	GuestOutbox = "/cell/outbox"

	// GuestTmp is the session-scoped temporary directory.
	// Lifecycle: cleared on session end.
	GuestTmp = "/cell/tmp"

	// GuestSharedMemory is the cross-session memory store.
	// Lifecycle: global persistent.
	GuestSharedMemory = "/cell/shared/memory"

	// GuestSharedSkills is the cross-session skills directory.
	// Lifecycle: global persistent.
	GuestSharedSkills = "/cell/shared/skills"

	// GuestSharedCache is the cross-session package cache.
	// Lifecycle: global, clearable.
	GuestSharedCache = "/cell/shared/cache"
)

// GuestPaths returns all standard guest mount points for validation and
// bind mount setup.
func GuestPaths() []string {
	return []string{
		GuestWorkspace,
		GuestInbox,
		GuestOutbox,
		GuestTmp,
		GuestSharedMemory,
		GuestSharedSkills,
		GuestSharedCache,
	}
}
