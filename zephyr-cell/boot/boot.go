// Package boot implements the first-boot and engine selection flow (§9.3).
//
// Flow:
//   1. Detect host (OS/arch/capabilities)
//   2. Select engine and rootfs variant
//   3. Verify/download rootfs
//   4. Boot engine
//   5. Smoke test: exec("echo ok")
//   6. Report Capabilities
//   7. Ready
//
// Any step failure produces structured diagnostics — never just "init failed".
package boot

import (
	"context"
	"fmt"
	"runtime"
	"time"

	cell "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
	"github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
)

// HostInfo describes the detected host platform.
type HostInfo struct {
	OS       string // runtime.GOOS
	Arch     string // runtime.GOARCH
	Features []string // detected host features (user_ns, wsl2, vf, etc.)
}

// DetectHost gathers information about the current host platform.
func DetectHost() HostInfo {
	info := HostInfo{
		OS:   runtime.GOOS,
		Arch: runtime.GOARCH,
	}
	// Feature detection would probe for specific capabilities
	// (user namespace support, WSL2 availability, VF entitlement, etc.)
	// This is the skeleton; actual probes are platform-specific.
	return info
}

// SelectRootfsVariant returns the appropriate rootfs architecture variant
// for the current host (§4.7, ADR-001).
func SelectRootfsVariant(host HostInfo) string {
	switch host.Arch {
	case "arm64":
		return "aarch64"
	case "amd64":
		return "x86_64" // x86_64 rootfs variant
	default:
		return "aarch64" // default to ARM64, QEMU-user will translate
	}
}

// Diagnostic describes a boot failure with structured detail.
type Diagnostic struct {
	Step    string // which boot step failed
	Engine  string // which engine was being tried
	Error   error
	Hint    string // actionable suggestion for the user
}

func (d Diagnostic) String() string {
	s := fmt.Sprintf("boot: step %q", d.Step)
	if d.Engine != "" {
		s += fmt.Sprintf(" (engine %s)", d.Engine)
	}
	s += ": " + d.Error.Error()
	if d.Hint != "" {
		s += " [hint: " + d.Hint + "]"
	}
	return s
}

// Result holds the outcome of the boot sequence.
type Result struct {
	// Engine is the selected and booted engine (nil if boot failed).
	Engine engine.Engine

	// Caps is the capability set of the selected engine.
	Caps cell.CapabilitySet

	// Host is the detected host info.
	Host HostInfo

	// RootfsArch is the selected rootfs variant.
	RootfsArch string

	// Diagnostics contains details about any failures during boot.
	Diagnostics []Diagnostic

	// Duration is the total boot time.
	Duration time.Duration
}

// Run executes the full boot sequence (§9.3).
func Run(ctx context.Context, registry *engine.Registry, cfg engine.Config) Result {
	start := time.Now()
	result := Result{}

	// Step 1: Detect host
	result.Host = DetectHost()
	result.RootfsArch = SelectRootfsVariant(result.Host)

	// Step 2: Select engine (tries each in priority order)
	eng, diag := registry.Select(ctx, cfg)
	for name, err := range diag {
		hint := engineHint(name, err)
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Step:   "engine_boot",
			Engine: name,
			Error:  err,
			Hint:   hint,
		})
	}

	if eng == nil {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Step:  "engine_select",
			Error: fmt.Errorf("no engine available on %s/%s", result.Host.OS, result.Host.Arch),
			Hint:  "check system requirements for your platform",
		})
		result.Duration = time.Since(start)
		return result
	}

	result.Engine = eng

	// Step 3: Smoke test (§9.3: exec("echo ok"))
	smokeResult, err := eng.Exec(ctx, "__smoke__", "echo ok", engine.ExecLimits{
		WallClockSeconds: 30,
		MaxOutputBytes:   1024,
		MaxProcs:         4,
	})
	if err != nil {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Step:   "smoke_test",
			Engine: eng.Name(),
			Error:  err,
			Hint:   "engine booted but cannot execute commands",
		})
		result.Duration = time.Since(start)
		return result
	}
	if smokeResult.ExitCode != 0 {
		result.Diagnostics = append(result.Diagnostics, Diagnostic{
			Step:   "smoke_test",
			Engine: eng.Name(),
			Error:  fmt.Errorf("smoke test exit code %d", smokeResult.ExitCode),
			Hint:   "rootfs may be corrupt or incompatible",
		})
	}

	// Step 4: Determine capabilities based on engine
	result.Caps = engineCaps(eng.Name())

	result.Duration = time.Since(start)
	return result
}

// engineCaps returns the capability set for a known engine name.
func engineCaps(name string) cell.CapabilitySet {
	switch name {
	case "direct":
		return cell.CapsDirect
	case "cellvm":
		return cell.CapsCellVM
	case "wsl2":
		return cell.CapsWSL2
	case "proot":
		return cell.CapsPRoot
	case "asbestos":
		return cell.CapsAsbestos
	case "cellserver":
		return cell.CapsCellServer
	default:
		return cell.CapsDefault
	}
}

// engineHint returns a user-facing hint for why an engine failed.
func engineHint(name string, _ error) string {
	switch name {
	case "direct":
		return "enable user namespaces: sysctl kernel.unprivileged_userns_clone=1"
	case "cellvm":
		return "requires macOS 11+ on Apple Silicon with Virtualization.framework entitlement"
	case "wsl2":
		return "install WSL2: wsl --install (Windows 10 1903+)"
	case "proot":
		return "PRoot requires a working ptrace implementation"
	case "asbestos":
		return "Asbestos interpreter requires iOS deployment target"
	case "cellserver":
		return "ensure Docker is running and accessible"
	default:
		return ""
	}
}

// HealthCheck runs the smoke test against a booted engine (§9.3 /healthz).
func HealthCheck(ctx context.Context, eng engine.Engine) error {
	result, err := eng.Exec(ctx, "__healthz__", "echo ok", engine.ExecLimits{
		WallClockSeconds: 10,
		MaxOutputBytes:   1024,
		MaxProcs:         4,
	})
	if err != nil {
		return fmt.Errorf("healthcheck: exec failed: %w", err)
	}
	if result.ExitCode != 0 {
		return fmt.Errorf("healthcheck: exit code %d", result.ExitCode)
	}
	return nil
}
