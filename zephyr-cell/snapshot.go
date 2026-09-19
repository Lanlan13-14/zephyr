package cell

// SnapshotID identifies a memory snapshot (§6.1).
// Only engines with CapSnapshot (currently CellVM) support snapshot/restore.
type SnapshotID string

// String returns the snapshot ID as a string.
func (s SnapshotID) String() string { return string(s) }

// IsEmpty reports whether the snapshot ID is unset.
func (s SnapshotID) IsEmpty() bool { return s == "" }
