package cell

import "time"

// Metrics holds runtime resource usage statistics for a cell (§8.2).
type Metrics struct {
	// CPUCumulative is the total CPU time consumed (user + system).
	CPUCumulative time.Duration

	// MemoryCurrent is the current resident memory in bytes.
	MemoryCurrent int64

	// MemoryPeak is the peak resident memory in bytes.
	MemoryPeak int64

	// IOReadBytes is the cumulative I/O read bytes.
	IOReadBytes int64

	// IOWriteBytes is the cumulative I/O write bytes.
	IOWriteBytes int64

	// ExecCount is the total number of exec calls in this cell.
	ExecCount int64

	// ExecDurationP50 is the 50th percentile exec duration.
	ExecDurationP50 time.Duration

	// ExecDurationP99 is the 99th percentile exec duration.
	ExecDurationP99 time.Duration

	// OffloadCount is the total number of offload calls.
	OffloadCount int64

	// NetEgressBytes is the cumulative network egress bytes.
	NetEgressBytes int64

	// --- Web/Cell-Server specific (zero on other engines) ---

	// WSFrameCount is the total WebSocket frames sent/received.
	WSFrameCount int64

	// ContainerStartCount is the number of container (re)starts.
	ContainerStartCount int64

	// WarmPoolHit indicates whether this session hit the container warm pool.
	WarmPoolHit bool
}
