package cell

import "time"

// Template defines a reusable sandboxed environment configuration (§6.1).
// The ID is content-addressed: SHA-256 of (Layers + Env + Limits + Offloads + Network).
type Template struct {
	// ID is the content-addressed identifier (SHA-256 hash of the template
	// definition). Computed automatically on first use; empty means not yet
	// computed.
	ID string

	// Layers lists rootfs layer references by SHA-256 digest.
	// The base layer is always first; toolchain and media layers follow.
	Layers []string

	// Env contains additional environment variables merged on top of the
	// unified defaults (§3.3). Keys present here override defaults.
	Env map[string]string

	// Limits constrains resource consumption for cells spawned from this
	// template.
	Limits Limits

	// Offloads is the whitelist of zc-* offload commands permitted in this
	// template. An empty slice means ALL offloads are denied (default-deny).
	Offloads []string

	// Network defines the egress network policy for the guest.
	Network NetworkPolicy
}

// Limits constrains resource consumption for a cell (§6.1, §8.1).
type Limits struct {
	// Cores is the CPU core quota (fractional). Default: 2.
	Cores float64

	// MemoryMB is the memory limit in megabytes. Default: 512.
	MemoryMB int

	// WallClock is the maximum wall-clock duration for a single exec call.
	// Default: 10 minutes. Exceeded → SIGTERM → 5s grace → SIGKILL.
	WallClock time.Duration

	// IdleTimeout is the duration after which an idle cell is paused.
	// Default: 30 minutes.
	IdleTimeout time.Duration

	// MaxOutputKB is the maximum output size in kilobytes before truncation.
	// Excess output is written to /cell/outbox/<uuid>. Default: 100.
	MaxOutputKB int

	// MaxProcs is the maximum number of concurrent processes in the guest.
	// Default: 128.
	MaxProcs int

	// DiskMB is the workspace disk quota in megabytes. Default: 1024 (1 GB).
	DiskMB int
}

// DefaultLimits returns the default resource limits per §8.1.
func DefaultLimits() Limits {
	return Limits{
		Cores:       2,
		MemoryMB:    512,
		WallClock:   10 * time.Minute,
		IdleTimeout: 30 * time.Minute,
		MaxOutputKB: 100,
		MaxProcs:    128,
		DiskMB:      1024,
	}
}

// NetworkPolicy defines the egress network policy for the guest (§3.5).
type NetworkPolicy struct {
	// AllowedDomains is a whitelist of domains (and optional ports) the guest
	// may connect to. An empty slice means the guest is network-isolated
	// (default).
	AllowedDomains []string

	// AllowedIPs is a whitelist of IP CIDRs the guest may connect to.
	AllowedIPs []string

	// ForceProxy, when non-empty, forces all guest traffic through the
	// specified HTTP proxy URL (enterprise mode).
	ForceProxy string

	// BlockMetadata forces the cloud metadata address range
	// (169.254.0.0/16) to be black-holed. This is mandatory and
	// non-overridable for Cell-Server (Web) deployments (§3.5).
	BlockMetadata bool
}

// DefaultNetworkPolicy returns the default network-isolated policy.
func DefaultNetworkPolicy() NetworkPolicy {
	return NetworkPolicy{
		BlockMetadata: true,
	}
}
