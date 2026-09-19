# Zephyr Cell

> **One SDK, six platforms.** A real, secure, everywhere-available computer for AI.

Zephyr Cell is the unified sandboxed Linux execution environment for Zephyr AI agents. It replaces the legacy L2 restricted exec with a complete Linux user-space (Alpine aarch64 rootfs) that runs identically across six platforms through platform-specific engines behind one SDK API.

This README is the **complete API reference**: every public interface and how to call it.

## Platforms

| Platform | Engine | Key |
|----------|--------|-----|
| Linux arm64 | Direct (user ns + seccomp + cgroup v2) | Native performance |
| macOS ARM | CellVM (Virtualization.framework) | VM boundary + snapshot |
| Windows | WSL2-bridge | VM boundary via Hyper-V |
| Android | PRoot (ptrace user-space chroot) | No root required |
| iOS | Asbestos (threaded-code interpreter) | W^X compliant, App Store safe |
| Web | Cell-Server (Docker + Direct nesting) | Double sandbox + WS transport |

## Architecture

```
L5  Application / Agent (depends only on Cell SDK)
L4  Cell SDK (Go / Kotlin / Swift / C# / C / TypeScript — API identical)
L3  Cell Core (engine routing, session coordination, quotas, audit, framing)
L2  Engine (Direct / CellVM / WSL2 / PRoot / Asbestos / QEMU / Cell-Server)
L1  Guest (Alpine Linux aarch64 rootfs — byte-identical across platforms)
L0  Native Offload Handlers (zc-* stubs → host platform APIs)
```

## Status

**Foundation merged (code-only, no engine wiring):** SDK interfaces frozen, frame protocol, audit schema, engine abstraction, Cell Core coordinator, quota/security/offload/shell/pathmap/boot/mcp/rootfs logic — 137 tests across 12 packages, all green. `Spawn()` currently returns `ENGINE_UNAVAILABLE`; wiring engines is a separate milestone.

## Installation

```bash
go get github.com/Lanlan13-14/zephyr-ssh/zephyr-cell
```

Module path: `github.com/Lanlan13-14/zephyr-ssh/zephyr-cell` (Go ≥ 1.23, single dependency: `github.com/google/uuid`).

---

# 目录

1. [Quick Start — 完整调用示例](#quick-start--完整调用示例)
2. [`cell` — SDK 根包](#cell--sdk-根包) — Spawn / Cell / Template / Exec / PTY / Files / Snapshot / Metrics / Audit / Errors / Capabilities / Env / Paths / Offload
3. [`engine` — 引擎接口与注册表](#engine--引擎接口与注册表)
4. [`protocol` — 帧协议](#protocol--帧协议)
5. [`core` — 会话协调器](#core--会话协调器)
6. [`shell` — 持久 shell](#shell--持久-shell)
7. [`security` — 安全模型](#security--安全模型)
8. [`offload` — Native Offload 网关](#offload--native-offload-网关)
9. [`quota` — 三层配额](#quota--三层配额)
10. [`pathmap` — 路径映射](#pathmap--路径映射)
11. [`boot` — 首启流程](#boot--首启流程)
12. [`mcp` — MCP 工具](#mcp--mcp-工具)
13. [`rootfs` — rootfs 层管理](#rootfs--rootfs-层管理)
14. [错误码总表](#错误码总表)
15. [附录：常量表](#附录常量表)

---

# Quick Start — 完整调用示例

```go
package main

import (
    "context"
    "fmt"

    "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell"
)

func main() {
    ctx := context.Background()

    // 1. 定义沙箱模板（limits/offload 白名单/网络策略）
    tpl := cell.Template{
        Env:     map[string]string{"MY_TOKEN_HASH": "abc123"},
        Limits:  cell.DefaultLimits(), // 2核/512MB/10min/100KB 输出
        Offloads: []string{"zc-device", "zc-calendar"}, // 默认全拒绝
        Network: cell.DefaultNetworkPolicy(),           // 默认断网
    }

    // 2. 启动沙箱（当前返回 ENGINE_UNAVAILABLE，等引擎接线后可用）
    c, err := cell.Spawn(ctx, tpl,
        cell.WithSessionID("my-session-001"), // 可选：固定会话 ID
    )
    if err != nil {
        // 结构化错误：cell: ENGINE_UNAVAILABLE: engine could not start
        fmt.Println("spawn failed:", err)
        return
    }
    defer c.Kill()

    // 3. 查询引擎能力（上层按能力降级，绝不按平台名分支）
    caps := c.Capabilities()
    if caps.Has(cell.CapPTY) {
        fmt.Println("PTY available")
    }

    // 4. 执行命令（同 cell 内自动串行）
    res, err := c.Exec(ctx, "echo hello",
        cell.WithCwd("/cell/workspace"),
        cell.WithEnv(map[string]string{"DEBUG": "1"}),
        cell.WithWallClock(60e9), // 60s
        cell.WithPersistentShell(), // cwd/env 跨调用保持
    )
    if err == nil {
        fmt.Printf("exit=%d stdout=%s truncated=%v\n",
            res.ExitCode, res.Stdout, res.Truncated)
    }

    // 5. 流式执行
    _, _ = c.ExecStream(ctx, "python3 train.py", func(line cell.StreamLine) {
        fmt.Printf("[%s] %s\n", line.Stream, line.Data)
    })

    // 6. 文件操作
    _ = c.WriteFile("/cell/workspace/data.csv", strings.NewReader("a,b\n1,2"))
    rc, _ := c.ReadFile("/cell/workspace/data.csv")
    infos, _ := c.ListDir("/cell/workspace")

    // 7. 装包（六端统一 apk）
    _ = c.InstallPackage("jq", "python3")

    // 8. 生命周期：暂停/恢复/重置/终止
    _ = c.Pause()
    _ = c.Resume()
    _ = c.Reset()  // 破坏性重建会话本地状态，保留 /cell/shared/*，ID 不变
    _ = c.Kill()   // 幂等

    // 9. 观测
    m, _ := c.Metrics()
    entries, _ := c.AuditLog(time.Now().Add(-time.Hour))

    // 10. offload 预检（触发系统弹窗）
    results := c.Preflight([]string{"zc-calendar", "zc-photos"})
}
```

---

# `cell` — SDK 根包

## 生命周期总览

```
Spawn ──▶ Exec/ExecStream/PTY/Files/InstallPackage/Offload
              │
              ├─ Pause ──▶ Resume
              ├─ Reset（破坏性重建，ID 不变，保留 /cell/shared）
              └─ Kill（终结，幂等）
```

## `Spawn` — 创建沙箱

```go
func Spawn(ctx context.Context, tpl Template, opts ...Option) (*Cell, error)
```

引擎按宿主平台自动选择。无可用引擎时返回 `ENGINE_UNAVAILABLE`。`ctx` 只管 spawn 本身；cell 活到 `Kill()` 或 idle 超时。

**Spawn 选项：**

| Option | 作用 |
|---|---|
| `cell.WithSessionID(id string)` | 固定会话 ID（默认自动生成 UUID） |
| `cell.WithEndpoint(url string)` | Web 部署的 Cell-Server `wss://` 端点 |
| `cell.WithToken(token string)` | Cell-Server bearer 认证 token |

## `Cell` — 沙箱句柄（全部 19 个方法）

| 方法 | 签名 | 说明 |
|---|---|---|
| ID | `func (c *Cell) ID() string` | cell 唯一标识 |
| SessionID | `func (c *Cell) SessionID() string` | ZEPHYR_SESSION_ID |
| Exec | `func (c *Cell) Exec(ctx context.Context, cmd string, opts ...ExecOption) (*ExecResult, error)` | 执行命令，同 cell 内串行 |
| ExecStream | `func (c *Cell) ExecStream(ctx context.Context, cmd string, onLine func(StreamLine)) (*ExecResult, error)` | 逐行流式输出 |
| PTY | `func (c *Cell) PTY(rows, cols int) (*PTYSession, error)` | 交互终端（需 CapPTY） |
| WriteFile | `func (c *Cell) WriteFile(guestPath string, r io.Reader) error` | 写 guest 文件（须在可写挂载内） |
| ReadFile | `func (c *Cell) ReadFile(guestPath string) (io.ReadCloser, error)` | 读 guest 文件（调用方负责 Close） |
| ListDir | `func (c *Cell) ListDir(guestPath string) ([]FileInfo, error)` | 列目录 |
| InstallPackage | `func (c *Cell) InstallPackage(pkgs ...string) error` | apk 装包（六端统一） |
| Snapshot | `func (c *Cell) Snapshot() (SnapshotID, error)` | 内存快照（需 CapSnapshot，当前仅 CellVM） |
| Restore | `func (c *Cell) Restore(id SnapshotID) error` | 从快照恢复 |
| Metrics | `func (c *Cell) Metrics() (*Metrics, error)` | 资源用量统计 |
| Capabilities | `func (c *Cell) Capabilities() CapabilitySet` | 引擎能力位 |
| AuditLog | `func (c *Cell) AuditLog(since time.Time) ([]AuditEntry, error)` | 审计查询（append-only） |
| Pause | `func (c *Cell) Pause() error` | 挂起（保留状态） |
| Resume | `func (c *Cell) Resume() error` | 恢复挂起 |
| **Reset** | `func (c *Cell) Reset() error` | **破坏性重建到模板态**（见下） |
| Kill | `func (c *Cell) Kill() error` | 终结并释放资源（幂等） |
| Preflight | `func (c *Cell) Preflight(offloads []string) map[string]error` | offload 权限预申请 |

### `Reset()` 语义（标准沙箱重置 API）

| 方面 | 行为 |
|---|---|
| 会话本地状态（进程/持久 shell/`workspace`/`inbox`/`outbox`/`tmp`） | **销毁并按模板重建** |
| 跨会话共享路径（`/cell/shared/{memory,skills,cache}`） | **保留**（§3.2 全局生命周期） |
| Cell ID 与 Session ID | **不变** |
| 重复调用 | 幂等 |
| 并发 | 与 Exec 用同一把会话互斥锁串行 |
| 审计 | 成功/失败均追加 `AuditReset` 条目 |
| 失败 | 返回结构化错误 `RESET_FAILED` |
| 引擎不支持 | 返回 `ENGINE_UNSUPPORTED` |
| 无引擎/未接线 | 返回 `ENGINE_UNAVAILABLE` |

```go
if err := c.Reset(); err != nil {
    if ce, ok := err.(*cell.CellError); ok && ce.Code == cell.ErrCodeResetFailed {
        // 处理重置失败（cause 里是引擎错误）
    }
}
```

## `ExecOption` — 执行选项

```go
func WithPersistentShell() ExecOption          // 持久 shell：cwd/env 跨调用保持
func WithEnv(env map[string]string) ExecOption  // 追加/覆盖本次执行的环境变量
func WithCwd(path string) ExecOption            // 本次执行的工作目录
func WithWallClock(d time.Duration) ExecOption  // 覆盖 wall-clock 超时
```

## `ExecResult` — 执行结果

```go
type ExecResult struct {
    Stdout    []byte          // 截断于 Limits.MaxOutputKB；超出写入 /cell/outbox/<uuid>
    Stderr    []byte          // 同样截断规则
    ExitCode  int             // offload 标准码：124=超时 125=拒权 126=不可用 127=未知
    Duration  time.Duration   // wall-clock 耗时
    Truncated bool            // true 时完整输出在 /cell/outbox/
    Engine    string          // 执行引擎名（诊断用）
}
```

## `StreamLine` — 流式输出行

```go
type StreamLine struct {
    Stream string // "stdout" | "stderr"
    Data   []byte // 行内容（不含换行）
    Seq    uint64 // 本次 exec 内单调递增序号
}
```

## `PTYSession` — 交互终端

```go
type PTYSession struct {
    ID     string
    Reader io.Reader // guest → 客户端
    Writer io.Writer // 客户端 → guest
}
func (p *PTYSession) Resize(rows, cols int) error // 须为正数
func (p *PTYSession) Close() error
```

## `FileInfo` — 文件元信息

```go
type FileInfo struct {
    Name     string    // basename
    Path     string    // guest 全路径
    IsDir    bool
    Size     int64
    ModTime  time.Time // UTC
    Mode     uint32    // Unix 权限位（如 0644）
    MimeType string    // 尽力检测；未知为空
}
```

## `SnapshotID` — 快照标识

```go
type SnapshotID string
func (s SnapshotID) String() string
func (s SnapshotID) IsEmpty() bool
```

## `Metrics` — 资源用量

```go
type Metrics struct {
    CPUCumulative      time.Duration // 累计 CPU（user+sys）
    MemoryCurrent      int64         // 当前驻留内存（字节）
    MemoryPeak         int64         // 峰值驻留内存
    IOReadBytes        int64
    IOWriteBytes       int64
    ExecCount          int64
    ExecDurationP50    time.Duration
    ExecDurationP99    time.Duration
    OffloadCount       int64
    NetEgressBytes     int64
    // Web/Cell-Server 专属（其他引擎为 0）
    WSFrameCount       int64
    ContainerStartCount int64
    WarmPoolHit        bool
}
```

## `Template` — 沙箱模板

```go
type Template struct {
    ID       string            // 内容寻址 ID：SHA-256(Layers+Env+Limits+Offloads+Network)
    Layers   []string          // rootfs 层 digest（base 在前）
    Env      map[string]string // 叠加在统一默认值之上
    Limits   Limits
    Offloads []string          // zc-* 白名单；空 = 全拒绝（default-deny）
    Network  NetworkPolicy
}

func ComputeTemplateID(tpl *Template) string  // 计算内容寻址 ID
func (t *Template) EnsureID()                 // 空则计算并填充
func L2CompatTemplate() Template              // L2 兼容模板（256KB 输出，offload 全拒）
func FullTemplate() Template                  // 全能力模板（所有 offload + 开放网络）
```

## `Limits` — 资源限额（§8.1 默认值）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| Cores | float64 | 2 | CPU 核配额（可分数） |
| MemoryMB | int | 512 | 内存上限 |
| WallClock | time.Duration | 10min | 单次 exec 上限（超时 SIGTERM→5s→SIGKILL） |
| IdleTimeout | time.Duration | 30min | 空闲自动暂停 |
| MaxOutputKB | int | 100 | 输出截断上限（超出进 outbox） |
| MaxProcs | int | 128 | guest 内最大并发进程 |
| DiskMB | int | 1024 | workspace 磁盘配额 |

```go
func DefaultLimits() Limits
```

## `NetworkPolicy` — 出网策略

```go
type NetworkPolicy struct {
    AllowedDomains []string // 域名白名单；空 = 断网（默认）
    AllowedIPs     []string // IP CIDR 白名单
    ForceProxy     string   // 企业模式：强制 HTTP 代理 URL
    BlockMetadata  bool     // 黑洞 169.254.0.0/16（Web 端强制不可关）
}
func DefaultNetworkPolicy() NetworkPolicy // {BlockMetadata: true}
```

## `CapabilitySet` — 能力位

```go
type Capability uint16
type CapabilitySet uint16

const CapsDefault CapabilitySet = 0

func (s CapabilitySet) Has(caps ...Capability) bool      // 是否含全部给定能力
func (s CapabilitySet) Set(caps ...Capability) CapabilitySet // 返回叠加后的新集合
func (s CapabilitySet) String() string                    // "CapabilitySet(PTY|OFFLOAD)"
```

**7 个能力位：** `CapSnapshot` / `CapPersistShell` / `CapCgroupLimits` / `CapNetFilter` / `CapPTY` / `CapOffload` / `CapBrowserOffload`

**6 引擎预设：** `CapsDirect` / `CapsCellVM` / `CapsWSL2` / `CapsPRoot` / `CapsAsbestos` / `CapsCellServer`

| Capability | Direct | CellVM | WSL2 | PRoot | Asbestos | Cell-Server |
|---|---|---|---|---|---|---|
| SNAPSHOT | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| PERSIST_SHELL | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| CGROUP_LIMITS | ✓ | ✓ | ✓ | ✗* | ✗* | ✓ |
| NET_FILTER | ✓ | ✓ | ✓ | ✗* | ✗* | ✓ |
| PTY | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| OFFLOAD | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| BROWSER_OFFLOAD | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

\* 移动端为引擎内软限制（partial）。

## `CellError` / `ErrorCode` — 结构化错误

```go
type CellError struct {
    Code       ErrorCode  // 机器可读错误码
    Message    string     // 人类可读描述
    Suggestion string     // LLM 可读恢复提示（可为空）
    Engine     string     // 产生错误的引擎（可为空）
    Cause      error      // 底层错误（可为 nil）
}
func (e *CellError) Error() string  // "cell: CODE: message[: cause]"
func (e *CellError) Unwrap() error

func NewError(code ErrorCode, msg string, cause error) *CellError
func NewErrorf(code ErrorCode, format string, args ...any) *CellError
```

**哨兵错误**（可用 `==` 比较）：

```go
var ErrEngineUnsupported = ...  // 当前引擎不支持该操作
var ErrEngineUnavailable = ...  // 引擎无法启动
var ErrSessionNotFound   = ...  // 会话不存在
var ErrQuotaExceeded     = ...  // 配额超限
var ErrResetFailed       = ...  // 沙箱重置失败
```

判定方式：

```go
if err == cell.ErrEngineUnsupported { ... }                 // 哨兵比较
if ce, ok := err.(*cell.CellError); ok && ce.Code == cell.ErrCodeTimeout { ... } // 码判定
```

## 环境与路径常量

```go
func DefaultEnv(sessionID, engineName, cellVersion string) map[string]string
func EnvKeys() []string   // 排序后的默认环境变量名（审计只记名不记值）
func GuestPaths() []string // 全部 7 个标准挂载点
```

**18 个统一环境变量**（六端逐字节一致）：`PATH` `HOME` `TERM` `CHARSET` `LANG` `LC_ALL` `TZ` `NO_COLOR` `PYTHONDONTWRITEBYTECODE` `PIP_DISABLE_PIP_VERSION_CHECK` `npm_config_update_notifier` `GOMAXPROCS=2` `ZEPHYR_CELL=1` `ZEPHYR_CELL_VERSION` `ZEPHYR_SESSION_ID` `ZEPHYR_ENGINE` `BROWSER=/usr/local/bin/zc-open` `ENV=/etc/profile`

**7 个 guest 路径**：

| 常量 | 值 | 生命周期 |
|---|---|---|
| `GuestWorkspace` | `/cell/workspace` | 会话级持久 |
| `GuestInbox` | `/cell/inbox` | 会话级 |
| `GuestOutbox` | `/cell/outbox` | 会话级 |
| `GuestTmp` | `/cell/tmp` | 会话结束即清 |
| `GuestSharedMemory` | `/cell/shared/memory` | 全局持久 |
| `GuestSharedSkills` | `/cell/shared/skills` | 全局持久 |
| `GuestSharedCache` | `/cell/shared/cache` | 全局可清 |

## Offload 类型与退出码

```go
const (
    OffloadExitSuccess          = 0
    OffloadExitTimeout          = 124
    OffloadExitPermissionDenied = 125
    OffloadExitUnavailable      = 126
    OffloadExitUnknown          = 127
)

var OffloadCommands = []string{ /* 14 个 zc-* 命令 */ }

type OffloadRequest struct {
    Command   string            // "zc-calendar" 等
    Args      []string          // argv[1:]
    Env       map[string]string // execve 时的 guest 环境
    Cwd       string
    SessionID string            // 权限作用域
}

type OffloadResult struct {
    ExitCode  int          `json:"exit_code"`
    Stdout    string       `json:"stdout"`
    Stderr    string       `json:"stderr,omitempty"`
    Files     []OffloadFile `json:"files,omitempty"` // 大结果落在 /cell/outbox/
    Truncated bool         `json:"truncated"`
}

type OffloadFile struct {
    GuestPath string `json:"guest_path"` // 总在 /cell/outbox/ 下
    Mime      string `json:"mime"`
    Bytes     int64  `json:"bytes"`
}
```

## `AuditEntry` / `AuditKind` — 审计

```go
type AuditEntry struct {
    TS       time.Time      `json:"ts"`
    Session  string         `json:"session"`
    Kind     AuditKind      `json:"kind"`
    Cmd      string         `json:"cmd,omitempty"`
    ExitCode int            `json:"exit_code,omitempty"`
    Duration time.Duration  `json:"duration,omitempty"`
    BytesOut int            `json:"bytes_out,omitempty"`
    Offloads []string       `json:"offloads,omitempty"`
    NetPeers []string       `json:"net_peers,omitempty"`
    EnvKeys  []string       `json:"env_keys,omitempty"` // 只记名，不记值
    Engine   string         `json:"engine,omitempty"`
    Error    string         `json:"error,omitempty"`
    UserID   string         `json:"user_id,omitempty"`
}
```

**11 种事件类型：** `AuditExec` `AuditOffload` `AuditFileRead` `AuditFileWrite` `AuditNetwork` `AuditPTY` `AuditSnapshot` `AuditLifecycle` `AuditSeccompFallback` `AuditReset` `AuditInstall`

---

# `engine` — 引擎接口与注册表

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/engine"
```

## `Engine` 接口（13 个方法）

每端引擎必须实现的契约（§4.1）。未实现的 primitive 返回 `engine.ErrUnsupported`。

```go
type Engine interface {
    Name() string
    Boot(ctx context.Context, cfg Config) error
    SpawnSession(ctx context.Context, cfg SessionConfig) error
    Exec(ctx context.Context, sessionID string, cmd string, limits ExecLimits) (*ExecResult, error)
    ExecStream(ctx context.Context, sessionID string, cmd string, limits ExecLimits, onLine func(StreamLine)) (*ExecResult, error)
    SpawnPTY(ctx context.Context, sessionID string, rows, cols int) (*PTYHandle, error)
    Signal(ctx context.Context, sessionID string, sig int) error
    Mount(ctx context.Context, sessionID string, guestPath, hostPath string) error
    Unmount(ctx context.Context, sessionID string, guestPath string) error
    InterceptExecve(ctx context.Context, path string) error
    ResetSession(ctx context.Context, cfg SessionConfig) error   // 重建会话到模板态
    Teardown(ctx context.Context, sessionID string) error
    Shutdown(ctx context.Context) error
}
```

**引擎 ID：** `direct` `cellvm` `wsl2` `proot` `asbestos` `qemu` `cellserver`

## `Config` — 引擎启动配置

```go
type Config struct {
    RootfsPath  string // rootfs 层目录（宿主侧）
    DataDir     string // 持久数据目录（会话/审计/缓存）
    CellVersion string // Cell SDK 版本串
}
```

## `SessionConfig` — 会话配置

```go
type SessionConfig struct {
    SessionID  string            // ZEPHYR_SESSION_ID
    Env        map[string]string // 完整环境快照（§3.3）
    BindMounts map[string]string // guest 路径 → 宿主路径
    Limits     ExecLimits
}
```

## `ExecLimits` / `ExecResult` / `StreamLine` / `PTYHandle`

```go
type ExecLimits struct {
    WallClockSeconds int
    MaxOutputBytes   int
    MaxProcs         int
}

type ExecResult struct {
    Stdout     []byte
    Stderr     []byte
    ExitCode   int
    DurationMs int64
    Truncated  bool
}

type StreamLine struct {
    Stream string // "stdout" | "stderr"
    Data   []byte
    Seq    uint64
}

type PTYHandle struct {
    ID     string
    Reader io.Reader
    Writer io.Writer
    Close  func() error
    Resize func(rows, cols int) error
}
```

## `Registry` — 引擎注册与选择

```go
func NewRegistry() *Registry
func (r *Registry) Register(e Engine)                          // 按注册顺序形成优先级
func (r *Registry) Get(name string) Engine                     // 按名取，无则 nil
func (r *Registry) Names() []string                            // 优先级序的全部引擎名
func (r *Registry) Select(ctx context.Context, cfg Config) (Engine, map[string]error)
// 依次探测注册引擎，返回第一个 Boot 成功的；失败记录在诊断 map

func DefaultEngineOrder() []string  // 按 GOOS/GOARCH 的推荐注册顺序
func PlatformInfo() string          // "GOOS=linux GOARCH=arm64"
```

调用示例：

```go
reg := engine.NewRegistry()
reg.Register(directEngine)   // 本平台最优
reg.Register(qemuEngine)     // 兜底

eng, diag := reg.Select(ctx, engine.Config{RootfsPath: "/var/lib/zephyr-cell/rootfs", ...})
if eng == nil {
    for name, err := range diag {
        log.Printf("engine %s failed: %v", name, err)
    }
}
```

## `EngineError` / `ErrUnsupported`

```go
var ErrUnsupported = &EngineError{Code: "ENGINE_UNSUPPORTED", Message: "not supported by this engine"}

type EngineError struct {
    Code    string
    Message string
    Cause   error
}
func (e *EngineError) Error() string   // "engine: CODE: message[: cause]"
func (e *EngineError) Unwrap() error
```

---

# `protocol` — 帧协议

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/protocol"
```

传输无关的统一帧格式（§6.3）：函数调用 / unix socket / abstract socket / vsock / WebSocket 语义完全相同。

## 帧布局

```
┌──────────────┬──────────┬──────────────────┐
│ u32 length   │ u8 type  │ payload (bytes)  │
│ (big-endian) │          │                  │
└──────────────┴──────────┴──────────────────┘
总帧大小 = 5 + len(payload)，上限 MaxFrameSize = 4MB
```

## `Frame` 与编解码

```go
type Frame struct {
    Type    FrameType
    Payload []byte
}

func Encode(w io.Writer, f Frame) error   // 写入线上格式
func Decode(r io.Reader) (Frame, error)   // 读一帧；流尽返回 io.EOF

func NewPing() Frame
func NewPong() Frame
func NewError(msg string) Frame

const MaxFrameSize   = 4 * 1024 * 1024  // 4MB 总帧上限
const MaxPayloadSize = MaxFrameSize - 5 // payload 上限
```

调用示例：

```go
var buf bytes.Buffer
err := protocol.Encode(&buf, protocol.Frame{
    Type:    protocol.FrameExecReq,
    Payload: []byte(`{"cmd":"echo hi"}`),
})
frame, err := protocol.Decode(&buf)
fmt.Println(frame.Type) // "EXEC_REQ"
```

## 23 种帧类型

| 常量 | 值 | 名称 | 方向/用途 |
|---|---|---|---|
| `FrameExecReq` | 0x01 | EXEC_REQ | 客户端→引擎：请求执行 |
| `FrameExecLine` | 0x02 | EXEC_LINE | 引擎→客户端：流式输出行 |
| `FrameExecResult` | 0x03 | EXEC_RESULT | 引擎→客户端：最终结果 |
| `FramePTYIn` | 0x10 | PTY_IN | →PTY 输入 |
| `FramePTYOut` | 0x11 | PTY_OUT | PTY→ 输出 |
| `FramePTYResize` | 0x12 | PTY_RESIZE | 调整终端尺寸 |
| `FramePTYOpen` | 0x13 | PTY_OPEN | 开 PTY 会话 |
| `FramePTYClose` | 0x14 | PTY_CLOSE | 关 PTY 会话 |
| `FrameFSReq` | 0x20 | FS_REQ | 文件操作请求（读/写/列/stat） |
| `FrameFSResp` | 0x21 | FS_RESP | 文件操作响应 |
| `FrameFSChunk` | 0x22 | FS_CHUNK | 大文件分块通道 |
| `FrameOffloadReq` | 0x30 | OFFLOAD_REQ | offload 执行请求 |
| `FrameOffloadResp` | 0x31 | OFFLOAD_RESP | offload 结果 |
| `FrameMetrics` | 0x40 | METRICS | 用量数据 |
| `FrameAuditPull` | 0x41 | AUDIT_PULL | 拉取审计（since 时间戳） |
| `FrameAuditData` | 0x42 | AUDIT_DATA | 审计条目 |
| `FrameAttach` | 0x50 | ATTACH | 重连附到既有会话 |
| `FrameDetach` | 0x51 | DETACH | 脱离会话（不杀） |
| `FrameReset` | 0x52 | RESET | 重置会话到模板态 |
| `FrameResetResult` | 0x53 | RESET_RESULT | 重置结果 |
| `FramePing` | 0xF0 | PING | 保活 |
| `FramePong` | 0xF1 | PONG | 保活应答 |
| `FrameError` | 0xFF | ERROR | 错误 |

```go
func (t FrameType) String() string  // "EXEC_REQ" 等
func (t FrameType) IsValid() bool   // 是否已知类型
```

---

# `core` — 会话协调器

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/core"
```

L3 会话协调器：生命周期、每会话串行、配额护栏、审计、引擎路由。

## `Coordinator`

```go
func NewCoordinator(eng engine.Engine, caps cell.CapabilitySet, version string, audit AuditSink) *Coordinator

func (c *Coordinator) SpawnSession(ctx context.Context, tpl cell.Template, sessionID string) (*Session, error)
// sessionID 为空自动生成 UUID；重复 ID 返回错误

func (c *Coordinator) GetSession(id string) *Session   // 无则 nil
func (c *Coordinator) KillSession(ctx context.Context, sessionID string) error // 幂等；不存在返回 ErrSessionNotFound
func (c *Coordinator) ResetSession(ctx context.Context, sessionID string) error
func (c *Coordinator) ActiveSessions() int
func (c *Coordinator) SessionIDs() []string
func (c *Coordinator) RunIdleReaper(ctx context.Context, checkInterval time.Duration)
// 周期检查空闲会话并暂停（§6.2 规则 3）；ctx 取消即退出
```

调用示例：

```go
audit := core.NewMemoryAuditStore()
coord := core.NewCoordinator(eng, cell.CapsDirect, "0.1.0", audit)

sess, err := coord.SpawnSession(ctx, tpl, "")
defer coord.KillSession(ctx, sess.ID)

go coord.RunIdleReaper(ctx, time.Minute)
```

## `Session`

```go
type Session struct {
    ID        string
    CellID    string
    Template  cell.Template
    Engine    engine.Engine
    Caps      cell.CapabilitySet
    CreatedAt time.Time
}

func (s *Session) Exec(ctx context.Context, cmd string, limits engine.ExecLimits) (*engine.ExecResult, error)
// 每会话互斥锁串行（§6.2 规则 1）；已杀会话返回 SESSION_DEAD

func (s *Session) IsKilled() bool
func (s *Session) LastActivity() time.Time
func (s *Session) IdleDuration() time.Duration
```

## `AuditSink` / `MemoryAuditStore`

```go
type AuditSink interface {
    Record(entry cell.AuditEntry) // append-only、goroutine-safe、不无限阻塞
}

func NewMemoryAuditStore() *MemoryAuditStore
func (s *MemoryAuditStore) Record(entry cell.AuditEntry)               // 实现 AuditSink
func (s *MemoryAuditStore) Query(sessionID string, since time.Time, limit int) []cell.AuditEntry
// sessionID 为空查全部；limit<=0 不限
func (s *MemoryAuditStore) Export(sessionID string) ([]byte, error)    // NDJSON 导出（L2 双写格式）
func (s *MemoryAuditStore) SessionIDs() []string
func (s *MemoryAuditStore) Count() int
```

## `QuotaTracker` / `RateLimiter` / `CrashScene`

```go
func NewQuotaTracker(limits cell.Limits) *QuotaTracker
func (q *QuotaTracker) RecordExec(outputBytes int, duration time.Duration)
func (q *QuotaTracker) CheckOutput(sizeBytes int) (allowed int, truncated bool)

func NewRateLimiter(maxCount int, window time.Duration) *RateLimiter
func (r *RateLimiter) Allow() bool  // 允许则记账并 true
func (r *RateLimiter) Count() int

func CaptureCrashScene(sessionID, engineName, rootfsVer string, recentCmds []string, err error) CrashScene
type CrashScene struct { /* 崩溃时间/会话/引擎/最近命令/层版本/错误/进程数 */ }
```

---

# `shell` — 持久 shell

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/shell"
```

持久 shell 会话管理（§6.2 规则 2）：长驻 shell 进程、prompt 正则判定完成、死亡自动重建、env 快照注入/删除。

## `PersistentShell`

```go
func NewPersistentShell(sessionID string) (*PersistentShell, error)

func (ps *PersistentShell) Generation() uint64     // 当前代数（重建时 +1）
func (ps *PersistentShell) IsAlive() bool
func (ps *PersistentShell) MarkAlive()
func (ps *PersistentShell) MarkDead() uint64       // 标死并换代，返回新代数
func (ps *PersistentShell) RebuildCount() int64
func (ps *PersistentShell) IsPrompt(output []byte) bool

func (ps *PersistentShell) EnvDiff(newEnv map[string]string) (toSet map[string]string, toUnset []string)
// 计算 env 快照差异：toSet 待 export；toUnset 上次有、本次无（§3.3：删 key 必须 unset）
```

## `PromptDetector`

```go
func DefaultPromptPatterns() []string // 覆盖 Alpine ash/bash/zsh 常见 prompt
func NewPromptDetector(patterns []string) (*PromptDetector, error)
func (d *PromptDetector) Detect(output []byte) bool
```

## 包级工具函数

```go
func BuildEnvCommands(toSet map[string]string, toUnset []string) string
// 生成 export/unset 命令串，用于持久 shell 同步

func StripEcho(output []byte, cmd string) []byte
// 去掉 PTY 回显的命令行
```

调用示例：

```go
ps, _ := shell.NewPersistentShell("sess-1")
ps.MarkAlive()

toSet, toUnset := ps.EnvDiff(map[string]string{"A": "1"})
script := shell.BuildEnvCommands(toSet, toUnset)
// "unset OLD; export A='1'; "
```

---

# `security` — 安全模型

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/security"
```

## `SeccompFallbackPolicy` — Android seccomp 回退（§4.5.3）

触发条件（**三者同时**成立才重试，且**只重试一次**）：

1. exit code ∈ {132 SIGILL, 135 SIGBUS, 139 SIGSEGV, 159 SIGSYS}
2. 进程存活 < 1.5s
3. 无任何输出

**禁止重试**：SIGKILL(137)、SIGTERM(143)、SIGABRT(134)——外部杀/优雅关/主动 abort，重试可能有副作用。

```go
func NewSeccompFallbackPolicy() *SeccompFallbackPolicy
func (p *SeccompFallbackPolicy) ShouldRetry(sessionID, cmd string, exitCode int, duration time.Duration, outputLen int) bool
// 同一 session+cmd 只放行一次

func IsSeccompSignal(exitCode int) bool   // 是否触发类信号
func IsForbiddenRetry(exitCode int) bool  // 是否禁止重试
```

## `NetworkEnforcer` — 出网执行器（§3.5）

```go
func NewNetworkEnforcer(domains []string, cidrs []string, blockMeta bool, proxy string) (*NetworkEnforcer, error)

func (e *NetworkEnforcer) CheckDomain(domain string) bool // 域名白名单（大小写不敏感；空白名单=全拒）
func (e *NetworkEnforcer) CheckIP(ip net.IP) bool         // IP 白名单 + metadata 黑洞
func (e *NetworkEnforcer) IsMetadataIP(ip net.IP) bool    // 是否云 metadata 段（169.254.0.0/16 等）
```

## `EnvSanitizer` — 敏感环境处理（§3.3）

```go
func NewEnvSanitizer() *EnvSanitizer
func (s *EnvSanitizer) IsSensitive(key string) bool          // KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH/APIKEY/PRIVATE 等
func (s *EnvSanitizer) HashValue(value string) string        // 截断 SHA-256（16 hex 字符），审计只记哈希不记值
func (s *EnvSanitizer) SanitizeForAudit(env map[string]string) []string // 只返回 key 名
```

---

# `offload` — Native Offload 网关

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/offload"
```

Native Offload 能力桥（§5）：白名单校验 → 权限检查 → handler 分发 → 信封格式化 → 大输出路由 outbox → 审计。

## `Gateway`

```go
func NewGateway(audit AuditFunc, maxOutputKB int) *Gateway
// audit 可为 nil（不记录）；maxOutputKB 控制 stdout 截断

func (g *Gateway) RegisterHandler(command string, handler HandlerFunc)
func (g *Gateway) HasHandler(command string) bool
func (g *Gateway) Dispatch(req cell.OffloadRequest, allowedOffloads []string) cell.OffloadResult
// 完整管道；白名单空=全拒；返回结构化信封（错误也是数据）

func (g *Gateway) GrantPermission(sessionID, command string)   // ASK_ONCE：一次授权
func (g *Gateway) RevokePermission(sessionID, command string)

type HandlerFunc func(req cell.OffloadRequest) cell.OffloadResult
type AuditFunc   func(entry cell.AuditEntry)
```

调用示例：

```go
gw := offload.NewGateway(audit.Record, 100)
gw.RegisterHandler("zc-device", func(req cell.OffloadRequest) cell.OffloadResult {
    return cell.OffloadResult{ExitCode: 0, Stdout: `{"model":"Pixel 9"}`}
})

res := gw.Dispatch(
    cell.OffloadRequest{Command: "zc-device", SessionID: "s1", Args: []string{"--info"}},
    []string{"zc-device"}, // 模板白名单；支持 "*"
)
// res.ExitCode / res.Stdout / res.Files / res.Truncated
```

**退出码语义**（与 §5.3 对齐）：白名单拒 → 126；权限拒 → 125；未注册命令 → 127；成功 → 0。超长 stdout 截断并落 `/cell/outbox/<uuid>`（`Files` 引用）。

## 移动端 wire 协议（§5.1）

```go
const (
    WireMagicRequest  uint32 = 0x5a434646 // "ZCFF"
    WireMagicResponse uint32 = 0x5a434652 // "ZCFR"
    WireVersion       uint8  = 1
    WireSocketName           = "zephyr-cell-offload" // abstract unix socket
    ResponseFileTTL          = 10 * time.Minute      // 响应临时文件 TTL
    CleanupInterval          = 50                    // 每 N 个响应机会式清理
)

type WireRequest struct {
    Magic     uint32            `json:"magic"`
    Version   uint8             `json:"version"`
    PID       int               `json:"pid"`
    SessionID string            `json:"session_id"`
    Command   string            `json:"command"`
    Args      []string          `json:"args"`
    Env       map[string]string `json:"env,omitempty"`
    Cwd       string            `json:"cwd"`
}

type WireResponse struct {
    Magic    uint32             `json:"magic"`
    Version  uint8              `json:"version"`
    Result   cell.OffloadResult `json:"result"`
    TempFile string             `json:"temp_file,omitempty"` // 大输出 guest 路径
}

func EncodeWireRequest(req WireRequest) ([]byte, error)
func DecodeWireRequest(data []byte) (WireRequest, error)
func EncodeWireResponse(resp WireResponse) ([]byte, error)
func DecodeWireResponse(data []byte) (WireResponse, error)
```

---

# `quota` — 三层配额

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/quota"
```

三层限流（§8.1，继承 L2 配额模型）：全局并发 / 每用户并发 / 每会话每小时次数。

## `Config`（L2 默认值）

| 字段 | 默认 | 说明 |
|---|---|---|
| GlobalMaxConcurrent | 4 | 全局并发 exec 上限 |
| UserMaxConcurrent | 2 | 每用户并发 exec 上限 |
| SessionMaxPerHour | 60 | 每会话每小时次数（滑动窗口） |
| MaxOutputKB | 100 | 单次输出上限 |
| MaxDiskMB | 1024 | 每会话磁盘配额 |
| MaxWebSessionsPerUser | 5 | 每用户并发会话数（Web） |

```go
func DefaultConfig() Config
```

## `Manager`

```go
func NewManager(cfg Config) *Manager

func (m *Manager) AcquireExec(userID, sessionID string) error  // 超限返回错误；userID 可空
func (m *Manager) ReleaseExec(userID string)
func (m *Manager) AcquireSession(userID string) error          // Web 会话配额
func (m *Manager) ReleaseSession(userID string)
func (m *Manager) Stats() Stats

type Stats struct {
    GlobalActive int
    GlobalMax    int
    UserActive   map[string]int
    UserMax      int
}
```

调用示例：

```go
q := quota.NewManager(quota.DefaultConfig())
if err := q.AcquireExec("user-1", "sess-1"); err != nil {
    return cell.ErrQuotaExceeded // 配额超限
}
defer q.ReleaseExec("user-1")
```

---

# `pathmap` — 路径映射

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/pathmap"
```

guest↔宿主双向路径翻译（§3.2）。应用代码**不得**硬编码宿主路径。

## `Mapper`

```go
func NewMapper(sessionID, hostDataDir string) *Mapper
// 自动映射 7 个标准挂载点：
//   /cell/workspace → <data>/sessions/<id>/workspace
//   /cell/inbox|outbox|tmp → <data>/sessions/<id>/...
//   /cell/shared/* → <data>/shared/*（跨会话）

func (m *Mapper) ToHost(guestPath string) (string, error)   // guest→host；未知挂载点报错
func (m *Mapper) ToGuest(hostPath string) (string, error)   // host→guest
func (m *Mapper) BindMounts() map[string]string             // 交引擎配置的完整挂载表
func (m *Mapper) HostDirs() []string                        // 需创建的宿主目录
func (m *Mapper) SessionDir() string                        // <data>/sessions/<id>
```

## `ValidateGuestPath`

```go
func ValidateGuestPath(guestPath string) error
// 必须绝对路径、必须在 /cell/ 下、不得含 ".." 穿越任何挂载点
```

调用示例：

```go
m := pathmap.NewMapper("sess-1", "/var/lib/zephyr-cell")
host, _ := m.ToHost("/cell/workspace/data.csv")
// "/var/lib/zephyr-cell/sessions/sess-1/workspace/data.csv"

guest, _ := m.ToGuest("/var/lib/zephyr-cell/sessions/sess-1/workspace/data.csv")
// "/cell/workspace/data.csv"
```

---

# `boot` — 首启流程

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/boot"
```

首启与引擎选择（§9.3）：检测宿主 → 选引擎与 rootfs 变体 → 验证/下载 rootfs → 引擎启动 → 冒烟 `exec("echo ok")` → 上报能力 → 就绪。任一步失败给**结构化诊断**，绝不只报"初始化失败"。

## `Run`

```go
func Run(ctx context.Context, registry *engine.Registry, cfg engine.Config) Result

type Result struct {
    Engine      engine.Engine       // 选中并已启动的引擎（失败为 nil）
    Caps        cell.CapabilitySet  // 该引擎能力位
    Host        HostInfo
    RootfsArch  string              // "aarch64" | "x86_64"
    Diagnostics []Diagnostic        // 每个失败引擎的结构化诊断
    Duration    time.Duration
}

type Diagnostic struct {
    Step   string // 失败步骤（engine_boot / engine_select / smoke_test）
    Engine string // 引擎名
    Error  error
    Hint   string // 可操作的用户提示（如 "wsl --install"）
}
func (d Diagnostic) String() string
```

## 其他

```go
func DetectHost() HostInfo                       // OS/arch/特性探测
func SelectRootfsVariant(host HostInfo) string   // arm64→aarch64；amd64→x86_64
func HealthCheck(ctx context.Context, eng engine.Engine) error
// /healthz 同款冒烟：exec("echo ok") 必须退出码 0

type HostInfo struct {
    OS       string   // runtime.GOOS
    Arch     string   // runtime.GOARCH
    Features []string // user_ns / wsl2 / vf 等
}
```

调用示例：

```go
reg := engine.NewRegistry()
reg.Register(direct)
result := boot.Run(ctx, reg, engine.Config{DataDir: dataDir})
if result.Engine == nil {
    for _, d := range result.Diagnostics {
        fmt.Println(d) // boot: step "engine_boot" (engine direct): ... [hint: ...]
    }
    return
}
fmt.Println("caps:", result.Caps)
```

---

# `mcp` — MCP 工具

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/mcp"
```

MCP server 工具定义（§6.5）。工具描述自带护栏文档（配额/白名单语义），LLM 可据此决策。

## 内置 6 工具

| 工具名 | 参数（required） | 说明 |
|---|---|---|
| `cell_exec` | `command` (string)；可选 `persistent` (bool)、`cwd` (string)、`timeout_seconds` (int) | 沙箱执行命令 |
| `cell_read_file` | `path` (string)；可选 `offset` (int)、`limit` (int) | 读 guest 文件 |
| `cell_write_file` | `path` (string)、`content` (string)；可选 `append` (bool) | 写 guest 文件 |
| `cell_list_dir` | `path` (string) | 列目录 |
| `cell_install_package` | `packages` (string[]) | apk 装包 |
| `cell_reset` | （无参数） | 重置沙箱到模板态 |

## 类型与构造

```go
func BuiltinTools() []Tool              // 6 个内置工具（含 JSON Schema）
func DefaultServerInfo(version string) ServerInfo  // {"zephyr-cell", version}

type Tool struct {
    Name        string          `json:"name"`
    Description string          `json:"description"`
    InputSchema json.RawMessage `json:"inputSchema"`
}

type ToolResult struct {
    Content  []ContentBlock `json:"content"`
    IsError  bool           `json:"isError,omitempty"`
}
func TextResult(text string) ToolResult
func ErrorResult(text string) ToolResult

type ContentBlock struct {
    Type string `json:"type"` // "text" | "image"
    Text string `json:"text,omitempty"`
}

type ServerInfo struct {
    Name         string `json:"name"`    // "zephyr-cell"
    Version      string `json:"version"`
    Capabilities struct {
        Tools struct{} `json:"tools"`
    } `json:"capabilities"`
}
```

---

# `rootfs` — rootfs 层管理

```go
import "github.com/Lanlan13-14/zephyr-ssh/zephyr-cell/rootfs"
```

内容寻址 rootfs 层（§3.1）：base(<30MB)/toolchain(<80MB)/media(<60MB)/user 四层，SHA-256 校验，签名 manifest，原子切换。

## `Store`

```go
func NewStore(baseDir string) *Store

func (s *Store) AddLayer(layer Layer, data []byte) error // 校验 digest + 尺寸预算后入库
func (s *Store) GetLayer(digest string) *Layer
func (s *Store) HasLayer(digest string) bool
func (s *Store) SetActiveManifest(m *Manifest) error     // 原子切换（所有层须在库）
func (s *Store) ActiveManifest() *Manifest
func (s *Store) NeedsUpdate(m *Manifest) []Layer          // manifest 中缺失的层（增量下载）
func (s *Store) DetectCorruption(getData func(digest string) ([]byte, error)) []Layer
// 全量重校验，返回损坏层（应重下）
```

## `Layer` / `Manifest` / `LayerKind`

```go
type LayerKind string
const (
    LayerBase      LayerKind = "base"
    LayerToolchain LayerKind = "toolchain"
    LayerMedia     LayerKind = "media"
    LayerUser      LayerKind = "user"
)

type Layer struct {
    Digest    string    // SHA-256
    Kind      LayerKind
    Arch      string    // "aarch64" | "x86_64"
    SizeBytes int64     // 压缩尺寸
    CreatedAt time.Time
}

type Manifest struct {
    Version   int
    Layers    []Layer     // 挂载序（base 在前）
    Arch      string
    Signature []byte      // canonical manifest 的 detached 签名
    SignedBy  string      // 签名 key ID
    CreatedAt time.Time
}

func (m *Manifest) TotalSize() int64
func (m *Manifest) BaseLayer() *Layer  // 无则 nil
```

## 校验函数与预算常量

```go
func DigestBytes(data []byte) string                        // SHA-256 hex
func VerifyDigest(data []byte, expected string) error       // 不匹配报错
func VerifyManifestArch(m *Manifest, expectedArch string) error
func ComputeManifestDigest(m *Manifest) string              // 签名用 canonical digest
func HostArch() string                                      // aarch64 | x86_64

const (
    MaxBaseSizeBytes      = 30 * 1024 * 1024  // <30MB
    MaxToolchainSizeBytes = 80 * 1024 * 1024  // <80MB
    MaxMediaSizeBytes     = 60 * 1024 * 1024  // <60MB
    MaxDockerImageBytes   = 150 * 1024 * 1024 // Web 镜像 <150MB
)
```

调用示例：

```go
store := rootfs.NewStore(dataDir + "/rootfs")
data := fetch("base.tar.gz")
digest := rootfs.DigestBytes(data)
err := store.AddLayer(rootfs.Layer{
    Digest: digest, Kind: rootfs.LayerBase, Arch: rootfs.HostArch(),
    SizeBytes: int64(len(data)), CreatedAt: time.Now(),
}, data)

for _, l := range store.NeedsUpdate(newManifest) {
    redownload(l)
}
_ = store.SetActiveManifest(newManifest)
```

---

# 错误码总表

17 个机器可读错误码（`cell.ErrorCode`）：

| 码 | 触发场景 |
|---|---|
| `ENGINE_UNSUPPORTED` | 当前引擎不支持该操作（查 `Capabilities()`） |
| `ENGINE_UNAVAILABLE` | 引擎无法启动（无 user ns / 无 WSL2 / Docker 未跑） |
| `TIMEOUT` | exec 超过 WallClock |
| `OUTPUT_TRUNCATED` | 输出超 MaxOutputKB，超出部分在 outbox |
| `ROOTFS_CORRUPT` | rootfs 层完整性校验失败 |
| `ROOTFS_MISMATCH` | rootfs 架构与宿主不符 |
| `SESSION_NOT_FOUND` | 会话不存在 |
| `SESSION_DEAD` | 持久 shell 已死重建 / 会话已杀 |
| `QUOTA_EXCEEDED` | 配额超限（CPU/内存/磁盘/进程/会话数） |
| `PERMISSION_DENIED` | offload 被用户或系统拒绝（exit 125） |
| `OFFLOAD_UNAVAILABLE` | offload 在此平台不可用（exit 126） |
| `OFFLOAD_UNKNOWN` | 未知 zc-* 命令（exit 127） |
| `OFFLOAD_TIMEOUT` | offload handler 超时（exit 124） |
| `RESET_FAILED` | 沙箱重置失败 |
| `TRANSPORT` | 帧协议/传输层失败 |
| `AUTH` | 认证/授权失败（Web/Cell-Server） |
| `INTERNAL` | 未预期内部错误 |

> 注：哨兵错误 `ErrEngineUnsupported` / `ErrEngineUnavailable` / `ErrSessionNotFound` / `ErrQuotaExceeded` / `ErrResetFailed` 可直接 `==` 比较；其余用 `CellError.Code` 判定。

---

# 附录：常量表

## Offload 标准退出码

| 值 | 含义 |
|---|---|
| 0 | 成功 |
| 124 | 超时 |
| 125 | 权限拒绝 |
| 126 | 平台不可用 |
| 127 | 未知命令 |

## 14 个 zc-* offload 命令

`zc-calendar` `zc-contacts` `zc-location` `zc-notify` `zc-clipboard` `zc-speak` `zc-speech` `zc-vision` `zc-photos` `zc-device` `zc-open` `zc-weather` `zc-alarm` `zc-ffmpeg`

## 测试

```bash
cd zephyr-cell && go vet ./... && go test ./... -count=1
# 12 包 137 测试全绿
```

## Design Reference

Full specification: [`FREEZE/ZEPHYR-CELL.md`](../FREEZE/ZEPHYR-CELL.md)

## License

GPL-3.0, same as the Zephyr project.
