# Zephyr Cell 技术文档

> **一份 SDK，六端同构。给 AI 一台真实、安全、随处可用的计算机。**
>
> 平台：Windows · macOS · Linux · iOS · Android · **Web（Docker 部署，浏览器使用）**
> 版本：v0.4 设计定稿草案 · 2026-09-16
> 定位：**Zephyr（Lanlan13-14/zephyr，GPL-3.0）AI 助理的执行底座**。
> Cell 是 Zephyr 现有"L2 受限 Exec"的统一化上位替代：把单端、短命、白名单命令级的
> 本地 exec，升级为六端同构、完整 Linux 用户态、可持久会话的 Agent 计算机。
> 本文档自包含：所有架构决策、接口规范、实现细节、集成落点、测试门禁、合规结论均在本文。

## 0.0 与 Zephyr 主项目的关系（先读这一节）

Zephyr 现状（与本设计相关的部分）：

| 现有组件 | 形态 | 与 Cell 的关系 |
|---|---|---|
| **server.js 主端** | Node.js 控制面（认证/ACL/AI/笔记），Docker 部署 | Cell-Server 嵌入主端容器，AI 工具调用经 Cell 执行（§2.5） |
| **zephyr-worker** | Go 会话数据面（持久 SSH/Telnet PTY、输出回放、订阅分发） | Cell Core 用 Go 实现，复用其持久会话/流分发模式与经验 |
| **zephyr-ai** | Go AI runtime（agent loop/provider/session/tool/mcp 等 12 模块） | Cell 作为 zephyr-ai 的**新工具后端**接入：`cell_exec` 等工具替换/包裹 L2 的 `session_exec_v1`（§6.6） |
| **L2 受限 Exec** | `ai-session-exec.js`：bwrap+白名单+prlimit，已实现 | **被 Cell 取代并平滑迁移**（§2.6）：L2 的威胁模型表、配额、审计格式、降级纪律全部被 Cell 吸收为子集 |
| **Zephyr One** | Tauri 桌面（Win/macOS/Linux），内嵌 Node 核心，loopback 钉死 | One 内嵌 Cell 原生引擎（Direct/CellVM/WSL2），桌面 AI 获得本地完整 Linux（§2.5） |
| **Zephyr One 移动端（重做中）** | iOS SwiftUI / Android Kotlin 原生客户端 | 嵌入 Cell 移动引擎（PRoot/Asbestos），移动端 AI 首次获得端侧 Linux |
| **Zephyr Agent（Flutter）** | 五端文件磁盘映射应用 | 可选嵌入 Cell，让 Agent 设备本身成为 AI 的算力/文件节点 |

为什么 L2 不够、Cell 是必要的：L2 自己声明"不是完整虚拟机沙箱"——它是主端 Linux 容器内的命令白名单执行器，只能跑 jq/grep/受限 python，**没有** apt/pip 自由装包、没有持久 shell 状态、没有 PTY、没有五端一致性，而且只在主端 Linux 存在（One 桌面和移动端没有等价物）。Cell 把这些全部补齐，并把 L2 已经趟对的路（bwrap、白名单、配额、审计、永不降级到 `sh -c`）继承为默认策略的子集。

License 前置结论：**Zephyr 主项目是 GPL-3.0**，Cell 作为其组件同样 GPL 发布，因此 iSH（GPLv3）与 PRoot（GPLv2）的 fork 可直接链接使用，原 §11 的"闭源传染"阻塞不适用于本项目——M0 不再被法务阻塞（详见 §11）。

---

# 目录

- 0. 设计目标与非目标
- 1. 核心架构决策（ADR 集）
- 2. 总体架构（含 2.5 Zephyr 集成落点、2.6 L2 迁移）
- 3. Guest 环境规范（六端统一契约）
- 4. 执行引擎详规（五端原生 × 六引擎 + Web 服务端引擎）
- 5. Native Offload 能力桥
- 6. SDK 接口规范（含 Web 传输与 JS/TS 绑定）
- 7. 安全模型与威胁分析
- 8. 资源限额与可观测性
- 9. 分发、打包与更新
- 10. 测试规范与验收门禁
- 11. 开源合规（法务前置）
- 12. 里程碑与工作量
- 13. 风险登记册
- 14. 附录：调研依据

---

# 0. 设计目标与非目标

## 0.1 目标（全部可验收）

| # | 目标 | 验收标准 | 裁判 |
|---|------|---------|------|
| G1 | **功能统一** | 同一 guest 脚本/命令/技能在六端行为一致；差异只能以能力位表达 | 契约测试（§10.2）六端绿 |
| G2 | **接口统一** | 一份 SDK API 六端逐字对齐；上层代码无平台分支 | SDK 头文件 diff 检查（§10.5） |
| G3 | **本地优先** | 五个原生端全部支持纯本地执行，不强制远端。Web 端形态天然为"浏览器 + 服务端容器"，其服务端可部署在本地 Docker（单机自用）或机房（团队共享），Cell 不强制任何特定远端 | 断网真机测试（五原生端）全过；Web 端 localhost Docker 全流程可跑 |
| G4 | **高性能** | 见 §10.1 性能预算表，逐端逐指标 | CI 性能门禁 |
| G5 | **低占用** | 运行时 < 30MB/端；rootfs base 层 < 30MB；空闲内存 < 50MB（移动端）/ <100MB（Web 单容器） | 打包与内存门禁 |
| G6 | **AI 原生** | 输出截断/限额/审计/能力扩展全部针对 Agent 负载设计 | 审计回放测试 |

## 0.2 非目标（明确不做）

- **不做沙箱内 GPU 计算**。需要 GPU/重计算的场景走 Native Offload 到 host 框架。Web 服务端如需 GPU 负载，同样在容器 host 上以 offload 形式提供，不做 guest GPU 直通。
- **Web 端不在 v1 做公共多租户 SaaS**。Web 部署形态为：单用户本地 Docker、团队内网 Docker、或 Zephyr 自托管服务端。公开多租户服务的计费/配额/租户隔离运营体系不在本文档范围（其技术地基——每会话独立容器——已在 §4.8 打好）。
- **不做 x86_64 guest 一等支持**。guest 统一 ARM64；x86_64 host（含 x86 服务器跑 Web 端）用 rootfs 变体或翻译兜底（§4.7）。
- **不做 GUI 应用沙箱**。Cell 面向命令行/脚本/工具负载；浏览器端呈现的是终端与文件界面，不是把图形桌面流化。

## 0.3 设计哲学

1. **统一的是契约，不是实现**。各端引擎实现必然不同（iOS 的 W^X 约束物理存在，浏览器不能执行原生代码同样是物理存在），统一落在三处：同一份 guest rootfs、同一份 SDK API、同一份行为契约测试。
2. **能力默认拒绝**。网络、文件、设备能力全部白名单制。沙箱内不存在的权限比"给了再封"安全一个量级。
3. **AI 是一等用户**。所有 API 的输出格式、错误码、截断行为为"LLM 读取并决策"优化：结构化、可解析、不溢出上下文。
4. **工程对齐靠纪律不靠自觉**。env、路径、错误码的对齐由 CI 强制，不允许"这一端先这样"。
5. **传输无关性**。SDK 与引擎之间只有一套帧协议，跑在函数调用、unix socket、vsock、WebSocket 上语义完全相同——这是 Web 端（浏览器↔Docker）与原生端（进程内）共享同一契约的技术基础。

---

# 1. 核心架构决策（ADR 集）

## ADR-001：统一 guest = ARM64 Linux 用户态

**决策**：六端运行同一份 Alpine Linux aarch64 rootfs。不为任何平台更换 guest OS 或 ISA。

**理由**：
- 目标设备 overwhelmingly 是 ARM64：iPhone/iPad 全系、Android 手机全系、Apple Silicon Mac 全系、ARM 服务器与 ARM 笔记本已成气候。guest 与 host 同 ISA 时，用户态仿真只需做 syscall 翻译与指令调度，无需指令集翻译，开销最小。
- 一份 rootfs 意味着：AI 装的包、写的脚本、跑的命令在任何端逐字节一致——这是"功能统一"的物理基础。
- 先例已验证：OpenMinis 用同一份 Alpine aarch64 rootfs 在 iOS（解释器）与 Android（PRoot）双端生产运行，4.5k star、App Store 在售。

**代价与对策**：x86_64 host（Intel Mac、Windows PC、x86 Linux 桌面与 x86 服务器）上跑 ARM64 guest 需要二进制翻译（QEMU-user/box64）。对策是提供 x86_64 rootfs **变体**，由 SDK/服务端按 host 架构自动选择，契约测试保证两变体行为对齐（§4.7、§10.3）。**Web 端 Docker 镜像同时发布 arm64 与 amd64 两个 manifest，对应两种 rootfs 变体。**

**被否决的替代方案**：
- *Wasm/WASI 便携核*：冷启动极快（社区实现实测 P50 约 1ms）、能力模型优雅，但 WASI 生态无法承载"真实 Linux shell + apt 装包 + 任意开源工具"的负载。作为 Cell 内部的"轻量任务后端"长期可考虑，但不做主路径。
- *浏览器内 Wasm 执行作为主路径*：浏览器不能 fork/exec、不能提供真实 Linux 环境，只能跑 WASI 子集——与 G1 冲突。浏览器是客户端，不是引擎宿主。
- *x86 guest*：移动端全部要翻译，方向性错误。
- *每端原生环境（Mac 用 zsh、Windows 用 PowerShell）*：等于放弃功能统一，直接违背 G1。

## ADR-002：引擎分级，不追求单一运行时

**决策**：每端选择该平台约束下最优的执行引擎，SDK 层抹平差异。原生端六引擎：Direct / CellVM / WSL2-bridge / PRoot / Asbestos / QEMU-user；Web 端服务端引擎：Cell-Server（容器内 Direct 嵌套 / gVisor / 可选 Firecracker，见 §4.8）。

**理由**：iOS 禁止第三方 App 动态生成可执行代码（W^X），浏览器不能执行原生代码，都是物理约束。承认约束、按端择优、用契约测试锁死行为，是诚实的工程。

**被否决的替代方案**：iOS 强制远端回退（违背 G3）；iOS 使用侧载 JIT（把用户排除在 App Store 之外）；浏览器内跑整个沙箱（物理不可能承载完整 Linux）。

## ADR-003：能力扩展走 Native Offload，不扩 guest

**决策**：所有需要 host 平台能力的功能，通过 execve 拦截路由到 host 原生 handler（§5），guest 内只放 `zc-*` stub。

**理由**：guest 保持极简与统一；能力无限扩展而不改引擎；权限模型天然落在 host 系统弹窗（原生端）或服务端配置（Web 端）；审计集中在 offload 网关一点。OpenMinis 已用 22 个生产 handler 验证此模式。

**Web 端推论**：浏览器没有日历/相册/HealthKit。Web 端的 offload handler 分两类：(a) **服务端能力**（数据库、对象存储、内部 API 网关、whisper/ffmpeg 等计算 offload）；(b) **浏览器能力**（通知、剪贴板、Web Speech、文件下载）——经 WebSocket 帧转发到浏览器侧 JS handler 执行，结果回传。两类对 guest 完全同构，都是 `zc-*`。

## ADR-004：SDK 对象模型对齐 E2B 直觉

**决策**：Template / Cell / Exec / PTY / Files / Snapshot / Metrics 对象模型（§6），命名向业界最广泛采用的沙箱 SDK 直觉靠拢。

**理由**：降低开发者认知成本；MCP/工具调用映射直接；JS/TS 绑定与 Go 绑定共享同一心智模型。

## ADR-005：移动端引擎直接 fork iSH-ARM64 / PRoot（GPL 前提）

**决策**：在 Zephyr GPL-3.0 前提下，移动端引擎 fork OpenMinis 验证过的 iSH-ARM64（iOS）与 PRoot（Android）路线做 Cell 化改造，而非自研重写。

**理由**：license 兼容（§11）；两者均已生产验证（App Store 在售、4.5k star 项目同路线）；自研重写解释器/用户态 chroot 是 6 个月以上的高风险工程，收益只在可控性，v1 不值得。

**保留项**：长期可因性能与可控性动机自研（替换为渐进式，非返工式）；若未来出现闭源发行需求再回到 license 分支讨论。

## ADR-006：Web 端 = Docker 容器内的 Cell-Server + 浏览器瘦客户端

**决策**：Web 端不在浏览器内执行任何 guest 代码。执行发生在 Docker 容器中的 Cell-Server（复用 Linux 引擎栈），浏览器通过 WebSocket 承载的统一帧协议使用 SDK。每会话（或每用户，按部署模式）独立容器。

**理由**：
- 浏览器沙箱无法提供真实 Linux（ADR-001 已否决浏览器内执行）。
- Docker 部署让 Web 端获得**最强的默认隔离组合**：容器边界 + 容器内二级沙箱（§4.8），且天然支持资源配额、编排、水平扩展。
- 统一帧协议（§6.3）使浏览器客户端与原生端共享 100% 的 API 语义；JS/TS SDK 是协议绑定，不是重新实现。
- 本地 Docker 部署满足"不强制远端"：开发者 `docker run` 一个容器，浏览器开 localhost，全程无外部依赖。

**被否决的替代方案**：
- *WebAssembly 版 Linux 模拟器（如 v86/jor1k）跑在浏览器里*：性能极差（完整内核模拟），无真实网络栈，与六端契约对齐成本极高，体验与"高性能"目标冲突。
- *Web 端复用用户本机原生端（浏览器连 localhost 原生 Cell）*：作为"伴侣模式"支持（§4.8.4），但不做主路径——Web 的独立可用性是产品价值本身。

---

# 2. 总体架构

## 2.1 分层视图

```
┌──────────────────────────────────────────────────────────────────┐
│ L5  Zephyr Agent / 上层应用（含 Web 前端）                          │
│     只依赖 Cell SDK；不感知平台、引擎、rootfs 变体                  │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L4  Zephyr Cell SDK（六端语言绑定，API 逐字对齐）                   │
│     Kotlin / Swift / Go / C# / C ABI / **TypeScript**            │
│     Template / Cell / Exec / PTY / Files / Snapshot / Metrics    │
│     Capabilities 查询 / Offload 白名单 / 审计读取                  │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│ L3  Cell Core（跨平台共用，Rust/Go 实现）                          │
│     引擎路由 · 会话协调器 · 限额与护栏 · 审计记录 · 传输编解码       │
│     rootfs 层管理（内容寻址、增量下载、验签）                       │
└───────┬──────────┬──────────┬──────────┬──────────┬─────────┬───────────┐
        ▼          ▼          ▼          ▼          ▼         ▼           ▼
┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────────┐
│ Direct   ││ CellVM   ││ WSL2-    ││ PRoot    ││ Asbestos ││ Cell-Server  │
│ (Linux)  ││ (macOS)  ││ bridge   ││ (Android)││ (iOS)    ││ (Web/Docker) │
│ QEMU-user ││ VF 微VM  ││ vsock    ││ ptrace   ││ 线程代码 ││ 容器内二级   │
│ 全端兜底  ││          ││          ││ 用户态   ││ 解释器   ││ 沙箱 + WS 网关│
└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└────┬─────┘└──────┬───────┘
     └───────────┴───────────┴─────┬─────┴───────────┴─────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ L1  Guest：Alpine Linux aarch64 rootfs（六端同一份；x86 变体对齐） │
│     base 层 + toolchain 层 + /usr/local/bin/zc-* offload stubs   │
└──────────────────────────────────────────────────────────────────┘
                                ▼（仅当 guest 调用 zc-* 时）
┌──────────────────────────────────────────────────────────────────┐
│ L0  Native Offload Handlers                                       │
│     原生端：EventKit/WinRT/Android 框架/…                          │
│     Web 端：服务端能力 + 浏览器能力（经 WS 转发至 JS handler）      │
└──────────────────────────────────────────────────────────────────┘
```

## 2.2 六端引擎选型矩阵

| 平台 | 主引擎 | 备选/兜底 | guest ISA | 隔离边界 | 冷启动预算 | 关键约束 |
|------|--------|----------|-----------|---------|-----------|---------|
| Linux arm64 | Direct | gVisor；QEMU-user | arm64 原生 | 内核命名空间 | <10ms | 需 user ns 或特权 |
| Linux x86_64 | Direct + x86 rootfs 变体 | QEMU-user 跑 arm64 | x86_64 / arm64 | 内核命名空间 | <10ms / <500ms | 双 rootfs 对齐 |
| macOS ARM | CellVM（Virtualization.framework） | Asbestos 移植 | arm64 原生 | **VM 边界** | <300ms | VF 需 macOS 11+ |
| macOS Intel | x86 rootfs 变体（Direct 式） | QEMU-user | x86_64 / arm64 | 进程+沙箱 | <100ms / <500ms | 存量兼容 |
| Windows | WSL2-bridge | QEMU-user | x64/arm64 | **VM 边界** | 热身 <100ms | WSL2 缺失时降级 |
| Android | PRoot fork | 容器（root 机） | arm64 原生 | 用户态仿真+App 沙箱 | <200ms | seccomp 碎片化（§4.5.3） |
| iOS | Asbestos 解释器 | TCI 纯解释 | arm64 解释 | 用户态仿真+App 沙箱 | <500ms | W^X 禁 JIT |
| **Web** | **Cell-Server：容器内 Direct（gVisor 可选）** | Firecracker（独占节点） | 与镜像架构一致（arm64/amd64 双 manifest） | **容器边界 + 二级沙箱** | 会话首 exec <50ms（容器预热池） | 见 §4.8 |

## 2.3 引擎能力位（CapabilitySet）

SDK 通过 `Capabilities()` 上报，上层按能力降级而非按平台分支：

| 能力位 | 含义 | Direct | CellVM | WSL2 | PRoot | Asbestos | Cell-Server |
|---|---|---|---|---|---|---|---|
| `SNAPSHOT` | 内存快照/恢复 | ✗ | ✓ | ✗ | ✗ | ✗ | ✗（v1；CRIU 评估中） |
| `PERSIST_SHELL` | 持久 shell 会话 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `CGROUP_LIMITS` | 硬 CPU/内存限额 | ✓ | ✓ | ✓ | 部分 | 部分 | ✓（容器级最强） |
| `NET_FILTER` | guest 内网络过滤 | ✓ | ✓ | ✓ | 部分 | 部分 | ✓ |
| `PTY` | 交互终端 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（经 WS） |
| `OFFLOAD` | native offload | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（服务端+浏览器两类） |
| `BROWSER_OFFLOAD` | 浏览器侧能力转发 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

规则：能力差异**只允许**出现在此表；任何其他行为差异都是 bug，由契约测试拦截。

## 2.4 Web 端部署形态

| 形态 | 场景 | 隔离/配额 |
|---|---|---|
| **本地单机** `docker run zephyr/cell` | 开发者本机、个人自用 | 单容器；localhost 绑定 |
| **团队内网** docker-compose / K8s | 团队共享服务端 | 每用户一容器；命名空间隔离网络 |
| **Zephyr 托管**（v1 后的演进方向） | 公开服务 | 每会话一容器 + 编排层；多租户运营体系另行设计 |

## 2.5 Zephyr 集成落点

Cell 在 Zephyr 各形态中的物理位置：

```
┌─ Zephyr 主端 Docker 容器 ──────────────────────────────┐
│  server.js (Node 控制面)                                │
│    └─ zephyr-ai (Go runtime) ──工具调用──┐              │
│  zephyr-worker (Go 数据面)               │              │
│                                          ▼              │
│  Cell-Server 容器内进程（Direct 嵌套二级沙箱 §4.8）      │
│    └─ Alpine guest：cell_exec / 持久 shell / offload    │
└─────────────────────────────────────────────────────────┘
   浏览器 ←— 现有 Zephyr Web UI + AI 浮窗（新增 Cell 终端/文件面板）

┌─ Zephyr One（Tauri 桌面 Win/macOS/Linux）───────────────┐
│  内嵌 Node 核心（zephyr-core）                           │
│    └─ zephyr-ai ──工具调用──▶ Cell 原生引擎              │
│         （Linux=Direct / macOS=CellVM / Windows=WSL2）  │
│  引擎以 Tauri sidecar 二进制分发，loopback 帧协议通信      │
└─────────────────────────────────────────────────────────┘

┌─ Zephyr One 移动端（重做中：iOS SwiftUI / Android Kotlin）┐
│  嵌入 Cell 移动引擎（iOS=Asbestos / Android=PRoot）       │
│  AI 调用经 /api/one/* 同步层，或直接端侧执行               │
└──────────────────────────────────────────────────────────┘

┌─ Zephyr Agent（Flutter 五端，可选）───────────────────────┐
│  嵌入 Cell 引擎 → Agent 设备成为 AI 可调度算力节点         │
└──────────────────────────────────────────────────────────┘
```

与现有基础设施的复用关系：
- **Go 数据面经验**：Cell Core 的持久会话、PTY 流、输出回放直接参照 zephyr-worker 的成熟模式（同一团队同一语言）。
- **AI 工具面**：zephyr-ai 的 tool/mcp 模块新增 `cell_exec/cell_file_read/cell_file_write/cell_install_package` 工具族；敏感操作确认、过程卡片、审计展示等 UI 机制原样复用。
- **认证与 ACL**：Web 端 Cell-Server 不复造认证——挂在主端现有登录会话与用户体系下，WS 握手 token 由 server.js 签发（短期、绑 userId）。
- **配额体系**：继承 L2 的配额直觉（全局/用户/会话三级），数值按引擎能力上调（§8.1）。

## 2.6 从 L2 受限 Exec 到 Cell 的迁移

L2（`ai-session-exec.js` + `session_exec_v1`）已实现的纪律，Cell 全部继承并泛化：

| L2 已有 | Cell 中的去向 |
|---|---|
| bwrap 优先 + 降级矩阵（bwrap-netns → bwrap → unshare → whitelist-confine），**永不降级到 `sh -c`** | Direct 引擎的隔离档位；`whitelist-confine` 档由"guest 白名单 + 引擎仿真"吸收，降级纪律保留为 Cell 的 ENGINE 级规则 |
| 命令白名单（jq/grep/python3 禁 `-c`、npm 限子命令、ffmpeg 禁远程 URL） | 保留为默认 Template `l2-compat` 的 guest 内策略层；Cell 允许放开（完整 apk/pip），但默认 Template 仍收紧 |
| 配额：全局 4 / 用户 2 / 会话 60 次每小时 | Cell 限额矩阵的三级配额直接沿用，可按部署上调 |
| 输出截断 512KB/256KB | Cell 默认 100KB 可调；超限落 `/cell/outbox/` |
| 审计 ndjson（每行 userId/sessionId/cmd/…） | Cell AuditEntry schema 字段对齐，迁移期双写 |
| 会话目录 `data/ai-sessions/{user}/{session}/` | host 侧落点保持不变（由 server.js 托管），guest 内路径统一为 `/cell/*` |

迁移路径：
1. **M2.5 之后**：zephyr-ai 新增 `cell_exec` 工具，与 `session_exec_v1` 并存；AI 系统提示词优先引导到 cell。
2. **灰度期**：L2 保留为回退（Cell 不可用时），审计双写，对比两路行为一致性（契约测试的生产版）。
3. **切换**：Cell 契约六端绿 + 灰度 2 周无回归 → L2 标记 deprecated → 一个主版本后移除。

---

# 3. Guest 环境规范（六端统一契约）

## 3.1 Rootfs 分层

| 层 | 内容 | 大小预算 | 分发 |
|---|------|---------|------|
| `base` | Alpine minirootfs aarch64 + busybox + Cell 引导脚本 + zc-* stubs | <30MB | 随包内置或首启下载；Web 端打进 Docker 镜像 |
| `toolchain` | python3+pip、node、git、curl、jq、sqlite、ca-certificates | <80MB | 按需增量下载 |
| `media`（可选） | ffmpeg、imagemagick | <60MB | 按需 |
| 用户层 | apk/pip/npm 安装结果 | 不限 | 本地/容器卷增量 |

规则：
- 所有层**内容寻址**（SHA-256），manifest 签名，下载后验签再挂载。
- base 层六端逐字节相同；toolchain/media 层同版本同构建。
- rootfs 损坏/架构不匹配 → 自动重下 base 层；用户层可备份后重置。
- guest 内包管理器统一为 `apk`；SDK 暴露 `install_package()` 走 apk，六端一致。
- **Web 端**：rootfs 层以 OCI artifact 形式随镜像仓库分发，容器启动时按 manifest 校验；x86 节点用 amd64 镜像（x86 rootfs 变体），ARM 节点用 arm64 镜像，契约测试保证对齐。

## 3.2 统一文件布局

| Guest 路径 | 语义 | 生命周期 | 挂载方式 |
|---|---|---|---|
| `/cell/workspace/` | 当前会话工作目录 | 会话级持久 | bind mount → host / 容器卷 |
| `/cell/inbox/` | 输入文件（用户投递/上层传入） | 会话级 | bind mount |
| `/cell/outbox/` | 大输出落盘（offload 结果、生成物） | 会话级 | bind mount |
| `/cell/tmp/` | 临时 | 会话结束即清 | tmpfs/会话目录 |
| `/cell/shared/memory/` | 跨会话记忆 | 全局持久 | bind mount |
| `/cell/shared/skills/` | 技能定义 | 全局持久 | bind mount |
| `/cell/shared/cache/` | 包缓存等 | 全局，可清 | bind mount |

约束：
- guest 进程**只能**看到 rootfs 与显式 bind mount 的路径，host 其余文件系统物理不可达。
- 会话目录隔离：会话 A 的 workspace 对会话 B 不可见（除非显式共享）。
- host 侧落点由 SDK 托管，**应用代码不得硬编码 host 路径**，一律经 SDK 的 `map_path()` 双向转换。
- **Web 端**：bind mount 落点为容器内目录（由 docker volume 持久化）；浏览器上传文件经 WS 帧写入 `/cell/inbox/`，下载经 `map_path()` + HTTP range 端点。单文件上传上限默认 100MB 可配。

## 3.3 统一环境变量（逐字节对齐）

```
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
HOME=/root
TERM=xterm-256color
CHARSET=UTF-8
LANG=C.UTF-8
LC_ALL=C.UTF-8
TZ=UTC                      # guest 内固定 UTC；本地时间由 zc-device 提供
NO_COLOR=1
PYTHONDONTWRITEBYTECODE=1
PIP_DISABLE_PIP_VERSION_CHECK=1
npm_config_update_notifier=false
GOMAXPROCS=2
ZEPHYR_CELL=1
ZEPHYR_CELL_VERSION=<semver>
ZEPHYR_SESSION_ID=<uuid>
ZEPHYR_ENGINE=<direct|cellvm|wsl2|proot|asbestos|qemu|cellserver>
BROWSER=/usr/local/bin/zc-open
ENV=/etc/profile
```

纪律：
- 任一端新增/修改默认 env，必须同 PR 六端落地，否则契约 CI 拒绝。
- 用户自定义 env 存 host 侧安全存储（Keychain/凭据管理器/加密文件；Web 端为服务端加密存储，按用户隔离），每次执行以**全量快照**注入；已删除的 key 必须在持久 shell 中 `unset`，防止残留。
- 敏感值（API key 等）只进 guest 内存，不落 rootfs 层、不进审计明文（审计记录 key 名与 hash，不记值）。Web 端额外要求：敏感值不出现在 WS 帧日志与浏览器 devtools 可读的持久化存储中。

## 3.4 时区、编码、区域

- guest 固定 UTC + C.UTF-8。理由：消灭六端时区/编码差异这一最大行为漂移源。
- 本地时区/地区信息通过 `zc-device --timezone` 等 offload 显式提供。Web 端浏览器时区经 `BROWSER_OFFLOAD` 通道获取（`Intl.DateTimeFormat`），服务端时区不冒充用户时区。

## 3.5 网络模型

- guest 无独立网卡；socket 由引擎桥接 host/容器网络栈。
- **DNS**：引擎启动时从 host resolver 生成 `/etc/resolv.conf` 注入 guest；网络切换刷新。Web 端用容器 DNS。
- **默认策略**：仅出向；可配域名/IP 白名单；云 metadata 地址段（169.254.0.0/16 等）默认黑洞——**Web 端此项为强制不可关**，因为容器多跑在云主机上。
- **企业模式**：强制全部流量经 HTTP 代理，集中审计出口。Web 端以 sidecar 代理容器实现，egress 策略在 docker network 层强制（不只靠 guest 内配置）。

---

# 4. 执行引擎详规

## 4.1 引擎共性契约

每个引擎必须实现同一组原语（Cell Core 以 trait/接口调用）：

```
boot(config)                    初始化引擎与 rootfs
spawn_session(session_id, tpl)  创建会话（含 bind mount、env 快照）
exec(session, cmd, limits)      执行命令，流式回传 stdout/stderr 行
spawn_pty(session, size)        交互式 PTY
signal(session, sig)            发送信号（SIGTERM/SIGKILL…）
mount/unmount                   动态 bind mount
intercept_execve(path)          注册/卸载 offload 拦截点
teardown(session)               回收会话资源
```

未实现的原语返回标准错误 `ENGINE_UNSUPPORTED`，能力位置 0。

## 4.2 Direct（Linux）

**原理**：user/mount/pid/net 命名空间 + pivot_root 进 rootfs；seccomp-bpf 白名单 syscall；cgroup v2 限 CPU/内存/IO。

- 依赖：内核 ≥ 4.18（user namespace）；无 Docker/containerd 依赖；单静态二进制交付。
- 网络：slirp4netns 用户态网络（免特权）或 netns+veth（有特权）。
- 快照：不支持（能力位 0）。
- 资源回收：会话结束 umount 全部 bind + 杀进程组 + 清 cgroup。

**失败模式**：user ns 被 sysctl 禁用 → 探测后报 `ENGINE_UNAVAILABLE` 并建议兜底，不得静默降权运行。

## 4.3 CellVM（macOS ARM，可选 Linux KVM）

**原理**：Virtualization.framework 启动极简 ARM64 Linux 微 VM（定制 kernel + initramfs + Cell guest agent），virtio-fs 挂载 workspace，virtio-console/vsock 通信。

- 冷启动预算 <300ms；**快照/恢复** P50 目标 <100ms（业界 microVM 快照恢复实测已达 28ms 量级）。
- guest agent 协议与 Cell Core 其他引擎共用同一帧格式。
- macOS Intel 不支持 VF → x86 rootfs 变体 + Direct 式进程沙箱（sandbox-exec 辅助）。

## 4.4 WSL2-bridge（Windows）

**原理**：WSL2 本身就是 Hyper-V 微 VM。Cell 在其内运行常驻 daemon（与 Linux Direct 同代码），Windows 侧 SDK 经 vsock 通信。

- 文件桥：WSL2 的 9P 挂载直接暴露 Windows 目录为 bind mount 落点。
- 冷启动：VM 未运行时需热身（秒级）；热身后 exec <100ms。SDK 后台保活 daemon。
- 降级：WSL2 不存在/被禁 → QEMU-user 或 x64 rootfs 变体；能力位如实上报。
- 不依赖 WSL1；检测到 WSL1 直接走降级路径。

## 4.5 PRoot（Android）

### 4.5.1 原理
PRoot = 用户态 chroot：ptrace 拦截 guest 进程 syscall，重写路径，socket 等 syscall 透传 host。无需 root。

### 4.5.2 工程化要点
- 自编译 PRoot + talloc 静态链接；随 AAR 以 `.so` 装载，经 extractNativeLibs 或 /proc/self/fd 提取执行。
- **持久 shell**：每会话一个 `/bin/sh` 常驻进程 + PTY；prompt 正则检测完成。省掉重复 ptrace attach 开销。
- **每会话 Mutex + 跨会话并发**：同会话串行，跨会话并发。优于全局 FIFO 串行（一条卡死堵全部，已验证的反面教材）。
- env 注入对齐 §3.3；`BROWSER` 强制覆盖用户 dotfile。
- 镜像源可配；升级覆盖层后必须重放用户镜像选择，不得重置。

### 4.5.3 Seccomp 碎片化（已验证的真实地雷）
症状：部分设备内核 seccomp fast path 与 proot ptrace+seccomp 组合冲突，**动态链接** guest 程序启动即 SIGBUS/SIGSEGV/SIGSYS，静态 busybox 正常；同字节 rootfs 同 argv 在另一些设备正常——问题在 host 内核。

**强制内置 SeccompFallbackPolicy**：
- 触发签名（三者同时）：退出码 ∈ {132, 135, 139, 159} 且 存活 < 1.5s 且 无输出。
- 动作：`PROOT_NO_SECCOMP=1` 重试**恰好一次**，记录审计。
- **禁止**对 SIGKILL(137)/SIGTERM(143)/SIGABRT(134) 重试。有副作用窗口的命令绝不自动重跑。

### 4.5.4 root 设备
检测到 root 可改容器后端（mount ns + chroot）；接口与能力位不变。

## 4.6 Asbestos（iOS）

### 4.6.1 原理（为什么这能过 App Store）
Apple 的 W^X 禁止运行时把数据页标记为可执行。Asbestos 不在运行时生成任何机器码：
- guest ARM64 指令解码为"预编译 host 函数（gadget）的指针序列"（线程代码）。
- 全部 gadget **编译期**进入 App 二进制；运行时只分配**数据页**存指针程序。
- 此路线有 App Store 在售先例（iSH 及其 ARM64 fork 生态）。

### 4.6.2 引擎规格
- guest 线程 ↔ host pthread 1:1；线程本地任务指针做进程隔离。
- 软件 TLB + 用户态页表仿真；访存经 TLB 快路径（汇编），miss 回落 C 运行时。
- syscall 仿真 ≥100 个：fork/exec/wait、信号、pthread、mmap/brk、pipe/eventfd、poll/epoll、inotify、pty、socket、fakefs 文件操作。
- fakefs：SQLite 元数据库 + host 目录数据层；bind mount = meta.db 条目 + symlink。
- 崩溃隔离：SIGSEGV/SIGBUS 恢复处理器（CoW 陈旧 TLB 指针不得打挂宿主 App）。
- VDSO 内置，减少时钟等热路径开销。

### 4.6.3 性能档位（诚实声明）
- 纯计算负载：比原生慢数倍到一个量级（同 ISA 解释器典型 5-15×）。
- **但** AI 工具负载以 I/O、文本处理、syscall、子进程为主，大量时间在 host 原生代码里执行，实际体感差距远小于纯计算基准。生产先例证明对 Agent 负载可用。
- 可选增强：侧载/调试场景可启用 arm64→arm64 JIT 后端（开源先例把差距压到硬件虚拟化的 10-20%）。**JIT 是增强不是依赖**；App Store 构建用构建开关物理剔除 JIT 代码路径。

### 4.6.4 iOS 集成层职责
Boot（挂 rootfs→PID 1→设备节点→procfs/devpts→DNS→TTY 驱动→offload 注册）；Rootfs 管理（解包/架构校验/损坏重置）；执行协调（持久 shell + 每会话串行 + prompt 检测 + 10min 抢占 + 100KB 上限 + 回显剔除）；DNS 实时桥接。

## 4.7 QEMU-user 兜底（全端）

- 场景：x86_64 host 跑 arm64 rootfs；或主引擎不可用的降级路径。
- QEMU-user（linux-user 模式）；box64 是 x86_64 上跑 arm64 的更快替代。
- **x86_64 rootfs 变体**优先于翻译：SDK/服务端按 host 架构自动选 rootfs；两变体行为对齐由 §10.3 强制。

## 4.8 Cell-Server（Web 端引擎）

### 4.8.1 架构：双层沙箱

```
浏览器（JS/TS SDK）
   │  WebSocket（wss://，统一帧协议 §6.3，TLS + token 认证）
   ▼
Cell Gateway（容器外或边缘容器：认证、会话路由、限流、WS 终结）
   │  每会话路由到专属容器（或单用户容器内的会话）
   ▼
Docker 容器（第一重边界：容器隔离 + 容器级 cgroup 配额 + 只读根 + no-new-privileges）
   └─ Cell-Server 进程
        └─ Direct 引擎嵌套（第二重边界：容器内 user ns + mount ns + seccomp + cgroup）
             └─ guest：Alpine aarch64/x86_64 rootfs
```

关键设计：
- **容器本身不是沙箱边界，是配额与运维单元；guest 代码面对的是容器内的第二重 Direct 沙箱。** 双层都破才触及 host。
- 更强隔离档：容器 runtime 换 **gVisor（runsc）**——guest 感知不到差异，能力位不变；独占节点可上 Firecracker/Kata（容器即微 VM）。
- **嵌套 user namespace** 需要 Docker ≥ 20.10（`--security-opt seccomp=unconfined` 换为自带收紧 profile）或 gVisor；镜像附带推荐的 docker run 参数与 compose 文件，开箱即安全。

### 4.8.2 会话与容器映射

| 部署形态 | 映射 | 理由 |
|---|---|---|
| 本地单机 | 全会话共享一容器，容器内按会话隔离（bind mount + 会话目录） | 资源最省；单用户信任模型 |
| 团队/托管 | **每用户一容器**，用户内按会话隔离 | 用户间隔离靠容器边界；用户内靠二级沙箱 |
| 高敏任务（可配） | **每会话一容器**，用完即毁 | 任务级爆炸半径 |

容器预热池：团队/托管形态维持 N 个热容器，会话首 exec 预算 <50ms。

### 4.8.3 浏览器侧职责

- JS/TS SDK（npm 包 `zephyr-cell`）：与 Go API 逐字对齐的方法集；内部走 WS 帧协议。
- 终端 UI 用 xterm.js 接 PTY 帧；文件树/预览接 Files API。
- **浏览器 offload handler**：`zc-notify`→Notification API、`zc-clipboard`→Async Clipboard、`zc-speech`/`zc-speak`→Web Speech、`zc-open`→window.open、文件下载→流式 HTTP。权限弹窗走浏览器原生权限模型。
- 大文件上行：分块（1MB）+ 断点续传 + 内容校验。

### 4.8.4 伴侣模式（可选）

浏览器也可连接**用户本机**的原生端 Cell（`ws://127.0.0.1:<port>`，原生端 SDK 内建 WS server）。此时 Web 前端成为原生端的界面，执行全在本机。这是附加便利，不改变 Web 端"Docker 自包含可用"的主形态。

### 4.8.5 认证与传输安全

- WS 握手携带 bearer token（本地单机：首启生成随机 token 打印到容器日志；团队：OIDC/反向代理 SSO）。
- 强制 wss（本地 localhost 可 ws）；token 不记日志；帧不带敏感值（§3.3）。
- CORS/Origin 校验白名单化；防跨站 WS 劫持（CSWSH）：校验 Origin + 首帧 challenge。

---

# 5. Native Offload 能力桥

## 5.1 原理与数据流

```
guest 进程 execve("/usr/local/bin/zc-calendar", argv, envp)
  │  引擎拦截 execve：
  │    iOS      → 内核 hook（native_offload 层）
  │    Android  → proot 扩展 → abstract unix socket
  │    Direct   → rootfs 内 zc-* 是 Unix socket 客户端 stub → Cell Core
  │    CellVM   → guest agent 转发 → vsock → host
  │    WSL2     → 同 Direct，经 vsock 到 Windows 侧
  │    Cell-Server → 容器内同 Direct → 网关判定 handler 位置：
  │                  服务端 handler → 直接执行
  │                  浏览器 handler → WS 帧转发 → JS handler → 结果回传
  ▼
Cell Core offload 网关：
  白名单校验（Template.Offloads）→ 权限检查（按 ZEPHYR_SESSION_ID 维度）
  → 分发到 Handler → 调用平台框架 / 浏览器 API
  ▼
返回：JSON 信封 {exit_code, stdout, stderr, files[]}
  大输出写 /cell/outbox/<uuid>，信封只带路径
```

移动端 wire 协议（可直接实现）：
- abstract unix socket `zephyr-cell-offload`；魔数 `ZCFF`(0x5a434646)/`ZCFR`，version 1；长度前缀帧携带 pid/argv/env/cwd/session_id。
- handler 输出写 guest `/tmp` tmpfile，execve 重写为 `/bin/cat <tmpfile>`；guest 视角即普通 stdout。
- 应答文件 TTL 10min 惰性清理；每 50 次应答机会性清扫。
- socket 绑定指数退避重试 ~2s（进程速杀后内核仍占用 abstract 名），避免崩溃-重启循环。

## 5.2 统一 Offload 矩阵（`zc-*` 六端同名）

| guest 命令 | 能力 | iOS | Android | macOS | Windows | Linux | Web |
|---|---|---|---|---|---|---|---|
| `zc-calendar` | 日历 | EventKit | CalendarContract | EventKit | WinRT | CalDAV | 服务端 CalDAV / 浏览器不可（返回 126） |
| `zc-contacts` | 联系人 | Contacts | ContactsContract | Contacts | WinRT | CardDAV | 服务端 CardDAV |
| `zc-location` | 定位 | CoreLocation | FusedLocation | CoreLocation | WinRT | GeoClue | 浏览器 Geolocation（经转发，需授权） |
| `zc-notify` | 通知 | UserNotifications | NotificationManager | UserNotifications | Toast | libnotify | Notification API |
| `zc-clipboard` | 剪贴板 | UIPasteboard | ClipboardManager | NSPasteboard | Win32 | wl/xclip | Async Clipboard |
| `zc-speak` | TTS | AVSpeechSynthesizer | TTS | NSSpeechSynthesizer | SAPI | espeak/piper | Web Speech / 服务端 TTS |
| `zc-speech` | 语音识别 | SFSpeechRecognizer | SpeechRecognizer | SFSpeechRecognizer | WinRT SR | whisper.cpp | 服务端 whisper |
| `zc-vision` | OCR/识别 | Vision | ML Kit | Vision | WinRT OCR | tesseract | 服务端 OCR |
| `zc-photos` | 相册 | Photos | MediaStore | Photos | WinRT | 目录扫描 | 浏览器文件选择器（仅上行） |
| `zc-device` | 设备信息 | UIKit 等 | Build/Battery | IOKit | WMI/WinRT | /sys+upower | 浏览器 UA/电量 API + 服务端容器信息 |
| `zc-open` | 打开 URL/文件 | UIApplication | Intent | NSWorkspace | ShellExecute | xdg-open | window.open（新标签） |
| `zc-weather` | 天气 | WeatherKit | Open-Meteo | WeatherKit | Open-Meteo | Open-Meteo | Open-Meteo |
| `zc-alarm` | 闹钟/提醒 | 系统桥 | AlarmManager 桥 | 本地通知 | 任务计划桥 | systemd/cron | 服务端定时（会话存活期内） |
| `zc-ffmpeg` | 音视频 | FFmpeg kit | FFmpeg 静态库 | 同左 | 同左 | 同左 | 容器内 FFmpeg |

规则：
1. 某端无此能力 → `OFFLOAD_UNAVAILABLE`（exit 126）+ 能力位置 0。**禁止静默降级为不同行为**。浏览器能力需要用户授权而未授权 → `OFFLOAD_DENIED`（exit 125）。
2. 权限走各端原生弹窗（浏览器为权限 API）；`ASK_ONCE` 记忆按 `ZEPHYR_SESSION_ID`。
3. handler **永不**写非 bind-mount 的 host 路径；输出只落 `/cell/outbox/`。
4. 新能力 = 注册 handler + rootfs 放 stub + 矩阵加行，**不改引擎、不改 SDK**。Web 端新浏览器能力 = 服务端注册转发 + npm 包注册 JS handler。
5. 浏览器转发的 offload 有超时（默认 30s）与"浏览器标签页关闭"失败语义（返回 126 + 审计事件），guest 侧行为可预期。

## 5.3 信封格式

```json
{
  "exit_code": 0,
  "stdout": "…",
  "stderr": "",
  "files": [{"guest_path": "/cell/outbox/<uuid>", "mime": "image/png", "bytes": 20481}],
  "truncated": false
}
```

- stdout 超 100KB 自动落 outbox 文件，信封带 `files[]` + 摘要。
- 错误码统一：124=timeout，125=permission denied，126=unavailable，127=unknown offload。

---

# 6. SDK 接口规范

## 6.1 核心对象模型

```go
// 模板：可复用环境定义
type Template struct {
    ID       string            // 内容寻址 ID（layers+env+limits 的 hash）
    Layers   []string          // rootfs 层（SHA-256 引用）
    Env      map[string]string
    Limits   Limits
    Offloads []string          // zc-* 白名单；默认空 = 全禁
    Network  NetworkPolicy     // egress 白名单 / 强制代理
}

type Limits struct {
    Cores       float64
    MemoryMB    int
    WallClock   time.Duration // 单次 exec 上限，默认 10min
    IdleTimeout time.Duration
    MaxOutputKB int           // 默认 100
    MaxProcs    int
}

type Cell struct { /* 不透明句柄 */ }

func Spawn(ctx context.Context, tpl Template, opts ...Option) (*Cell, error)

func (c *Cell) Exec(ctx context.Context, cmd string, opts ...ExecOption) (*ExecResult, error)
func (c *Cell) ExecStream(ctx context.Context, cmd string, onLine func(StreamLine)) (*ExecResult, error)
func (c *Cell) PTY(rows, cols int) (*PTYSession, error)

func (c *Cell) WriteFile(guestPath string, r io.Reader) error
func (c *Cell) ReadFile(guestPath string) (io.ReadCloser, error)
func (c *Cell) ListDir(guestPath string) ([]FileInfo, error)

func (c *Cell) InstallPackage(pkgs ...string) error

func (c *Cell) Snapshot() (SnapshotID, error)         // 仅 SNAPSHOT 能力引擎
func (c *Cell) Restore(id SnapshotID) error

func (c *Cell) Metrics() (*Metrics, error)
func (c *Cell) Capabilities() CapabilitySet
func (c *Cell) AuditLog(since time.Time) ([]AuditEntry, error)

func (c *Cell) Pause() error
func (c *Cell) Resume() error
func (c *Cell) Kill() error     // 幂等
```

```go
type ExecResult struct {
    Stdout, Stderr []byte
    ExitCode       int
    Duration       time.Duration
    Truncated      bool
    Engine         string
}

type AuditEntry struct {
    TS        time.Time
    Session   string
    Cmd       string
    ExitCode  int
    Duration  time.Duration
    BytesOut  int
    Offloads  []string
    NetPeers  []string
    EnvKeys   []string      // 只记 key 名，不记值
}
```

TypeScript 绑定（Web/Node 同构）：

```ts
const cell = await Cell.spawn(template, { endpoint: "wss://cell.local:8443" });
const result = await cell.exec("python3 analyze.py", { onLine: console.log });
await cell.writeFile("/cell/workspace/data.csv", blob.stream());
const caps = cell.capabilities();        // { snapshot: false, browserOffload: true, ... }
```

## 6.2 执行语义

1. **会话内串行**：同一 Cell 的 Exec 串行（内部 Mutex）。要并发 → 多 Spawn。
2. **持久 shell**（`Persistent: true`）：命令在同一 shell 进程内跑，cwd/env 跨命令保留；prompt 正则判定完成；shell 死亡自动重建并恢复 bind mount（记录审计）。
3. **护栏默认值**：单次 10min（SIGTERM→5s→SIGKILL）；无输出 100KB 截断；空闲 30min 自动 Pause。
4. **错误即数据**：结构化错误（错误码 + 人类可读 + LLM 可读建议），不抛裸异常。
5. **审计**：Exec/Offload/网络出向落审计，append-only，上层/AI 可读。
6. **Web 断连语义**：WS 断开 ≠ 会话死亡。Cell-Server 保会话（默认 10min 可配），重连后 `attach(session_id)` 恢复流；持久 shell 状态不丢。浏览器彻底关闭超期 → 按部署形态回收（§4.8.2）。

## 6.3 传输编解码（跨进程/跨 VM/跨端统一）

- 帧格式：`u32 length | u8 type | payload(protobuf)`，同一格式跑在：同进程函数调用、unix socket、abstract socket、vsock、WebSocket。
- 帧类型：`exec_req/exec_line/exec_result`、`pty_in/pty_out/pty_resize`、`fs_req/fs_resp`（分块）、`offload_req/offload_resp`（含浏览器转发）、`metrics`、`audit_pull`、`attach/detach`、`ping/pong`。
- 这一统一让"本地引擎"与"远端引擎"（Web 端、伴侣模式、未来服务端复用）对 SDK 透明。
- WS 附加层：TLS、token 认证、Origin 校验、每连接速率限制、最大帧 4MB（超出走 fs 分块通道）。

## 6.4 六端交付物

| 端 | 交付物 | API 语言 | 集成 |
|---|---|---|---|
| Android | AAR（含引擎 .so、rootfs manifest） | Kotlin（挂起函数） | Gradle |
| iOS | XCFramework | Swift（async/await） | SPM |
| macOS | XCFramework + CLI 单二进制 | Swift + C ABI | SPM / brew |
| Windows | NuGet + CLI | C#（P/Invoke）+ C ABI | NuGet / winget |
| Linux | 静态单二进制 + Go module + C ABI | Go/C | 包管理器 |
| **Web** | **npm 包 `zephyr-cell`（浏览器+Node 同构）+ Docker 镜像 `zephyr/cell`（amd64/arm64 双 manifest）+ compose/K8s 样例** | TypeScript | npm / docker run |

API 命名、参数顺序、错误码六端逐字对齐；差异仅经 `Capabilities()` 表达。SDK 头文件/接口定义纳入 CI diff 门禁（§10.5）。

## 6.5 MCP / Agent 集成

- 内置 MCP server 模式：`exec / read_file / write_file / list_dir / install_package` 暴露为标准 MCP 工具。Web 端 Cell-Server 可直接以 MCP over HTTP 暴露，原生端以 stdio/本地端口暴露。
- 工具描述内置护栏说明（限额、白名单语义）。
- skill 约定：声明所需 offloads 与网络白名单，SDK 安装期校验并申请。

---

# 7. 安全模型与威胁分析

## 7.1 边界声明

| 引擎 | 隔离边界 | 威胁模型强度 |
|---|---|---|
| CellVM / WSL2 | VM（hypervisor） | 最强 |
| **Cell-Server（Web）** | **容器边界 + 容器内二级沙箱（gVisor 档：用户态内核）** | 强（gVisor 档接近 VM） |
| Direct | 内核命名空间 + seccomp | 强：共享内核 |
| PRoot / Asbestos | 用户态仿真 + 外层 OS App 沙箱 | 中：最终边界是应用沙箱 |

必须如实表述：移动端隔离 = 仿真层 + 平台应用沙箱，不是 VM 边界；Web 端单容器共享形态是"单用户信任模型"，多用户必须每用户一容器。高敏负载路由到 VM 边界引擎或 gVisor 档。

## 7.2 威胁清单与对策

| 威胁 | 对策 |
|---|---|
| Prompt injection 驱使恶意命令 | 能力默认拒绝：无白名单=断网/无设备能力；文件只见 bind mount |
| 数据外泄（DNS exfil） | egress 白名单 + metadata 黑洞（Web 端强制）+ 企业模式强制代理审计 |
| 凭据泄露 | 敏感值只存安全存储、注入内存不落盘；审计不记值；Web 端额外：不进 WS 日志/浏览器持久存储 |
| 资源耗尽 | 限额三件套：CPU/内存/进程数/输出/磁盘配额；Web 端容器级配额兜底 |
| 引擎被逃逸 | 移动端平台沙箱兜底；Web 端双层沙箱 + 只读根 + no-new-privileges + gVisor 档 |
| 供应链（rootfs 篡改） | 层内容寻址 + manifest 签名 + 验签后挂载；Docker 镜像签名（cosign） |
| 崩溃打挂宿主 | signal 恢复 + 引擎隔离 + 看门狗重启；Web 端容器重启策略 |
| 自动重试放大副作用 | SeccompFallback 仅"无副作用窗口"重试一次 |
| 审计被 guest 篡改 | 审计写 host/容器外 append-only，guest 不可达 |
| **Web 特有：CSWSH/会话劫持** | Origin 白名单 + 首帧 challenge + bearer token + 短时令牌轮换 |
| **Web 特有：多租户串话** | 每用户/每会话容器隔离；会话目录强制隔离测试；审计按用户分段 |

## 7.3 权限申请原则

- 设备能力权限在首次 offload 调用时触发系统/浏览器弹窗；拒绝 → exit 125，不崩溃不轰炸。
- SDK 提供 `preflight(offloads[])` 一次性申请。

---

# 8. 资源限额与可观测性

## 8.1 限额矩阵

| 维度 | 机制 | 默认 |
|---|---|---|
| CPU | cgroup v2 cpu.max（Direct/CellVM/WSL2/Cell-Server）；移动端引擎内配额 + GOMAXPROCS=2 | 2 核 |
| 内存 | cgroup memory.max；移动端观测 + 超限 SIGKILL | 512MB |
| 进程数 | cgroup pids.max / 引擎计数 | 128 |
| 磁盘 | workspace 配额 | 1GB |
| 时间 | wall-clock + idle 双超时 | 10min / 30min |
| 输出 | 行流 + 字节上限截断 | 100KB |
| 网络 | egress 白名单 + 带宽整形 | 断网（白名单默认空） |
| Web 会话 | 每用户并发会话数 / 容器数上限 | 5 / 1（可配） |

## 8.2 Metrics

累计 CPU、当前/峰值内存、IO 字节、exec 次数与分位耗时、offload 计数、网络出向字节。Web 端额外：WS 帧量、容器启动次数、预热池命中率。

## 8.3 日志与审计

三流分离（SDK 日志/审计流/guest 输出）；审计 append-only 按 session 分段可导出；崩溃现场保存（进程表、最近 N 命令、层版本）。Web 端审计卷挂容器外，容器销毁不丢审计。

---

# 9. 分发、打包与更新

## 9.1 组成物与体积预算

| 组成 | 预算 | 说明 |
|---|---|---|
| SDK + Cell Core | <10MB/端 | Rust/Go 静态产物；npm 包 <2MB（纯协议绑定） |
| 引擎 | <15MB/端 | PRoot ~1MB；Asbestos ~5MB；Direct ~2MB；CellVM 含内核 ~10MB |
| rootfs base | <30MB | 六端同一份 |
| 原生端首装合计 | **<55MB** | 移动端硬指标 |
| Web Docker 镜像 | **<150MB**（base 层内置） | toolchain 层按需拉取 |

## 9.2 更新策略

- SDK/引擎随宿主 App 或镜像 tag 更新。
- rootfs 层独立更新：manifest 比对 → 增量下载（内容寻址天然 dedup）→ 验签 → 原子切换（旧层保留至无会话引用）。
- 覆盖层纪律：更新 base 层不得重置用户配置（镜像源、用户层）；更新后重放用户选择。
- Web 端：镜像发版带 SBOM 与 cosign 签名；滚动更新时旧容器排干（drain）会话后再销毁。

## 9.3 首启流程

```
检测 host（OS/arch/能力）→ 选引擎与 rootfs 变体
→ 校验/下载 rootfs → boot 引擎 → 冒烟 exec("echo ok")
→ 上报 Capabilities → 就绪
```
任一步失败给结构化诊断（缺 user ns / WSL2 未装 / Docker 权限不足 / 存储不足…），不得只报"初始化失败"。Web 端容器健康检查端点 `/healthz` 执行同一冒烟。

---

# 10. 测试规范与验收门禁

## 10.1 性能预算（CI 门禁，随实测收紧）

| 指标 | Linux Direct | Android PRoot | iOS Asbestos | macOS CellVM | Windows WSL2(热) | Web Cell-Server |
|---|---|---|---|---|---|---|
| `echo hello` P50 | <10ms | <200ms | <500ms | <300ms | <100ms | <50ms（预热池；不含 WS 建连） |
| `python3 -c "print(1)"` P50 | <100ms | <1s | <3s | <500ms | <300ms | <150ms |
| 持久 shell 内命令 P50 | <5ms | <50ms | <150ms | <50ms | <30ms | <20ms |
| 快照恢复 P50 | — | — | — | <100ms | — | — |
| WS 首帧往返 P50 | — | — | — | — | — | <30ms（同机房/本地） |
| 空闲常驻内存 | <20MB | <50MB | <50MB | <100MB | <150MB | <100MB/容器 |
| rootfs base | <30MB 全端 | 同左 | 同左 | 同左 | 同左 | 同左 |

规则：数值是预算不是承诺；回归超 20% 阻塞发版；不得以端特性为由豁免记录。

## 10.2 契约测试（"功能统一"的唯一裁判）

- **语料库**：shell/python/node 各 ≥50 例真实 Agent 负载脚本。
- **判定**：六端执行，stdout/stderr 归一化后**逐字节比对**；exit code 一致。Web 端通过同一语料经 WS 通道执行，判定标准不变。
- **env/路径/编码/时区**：§3.2/§3.3/§3.4 全部条目逐字段断言。
- **offload**：白名单语义、错误码、能力位行为六端一致（浏览器转发类用自动化浏览器实测）。
- 任一端红 = 发版阻塞。没有例外流程。

## 10.3 双 rootfs 对齐（x86 变体）

- arm64 与 x86_64 rootfs 跑同一语料库；输出差异只允许白名单项（`uname -m` 等）。
- 单架构行为不符的包不得进 toolchain 层。Docker 双 manifest 发布前必须通过此门禁。

## 10.4 真机/真系统矩阵

| 端 | 覆盖 |
|---|---|
| Android | ≥6 机型高中低端；seccomp 碎片化机型；低内存杀进程恢复 |
| iOS | 最低支持版本到最新；Low Power Mode；后台被杀恢复 |
| Windows | 10/11，WSL2 有/无/版本旧 |
| macOS | ARM + Intel |
| Linux | Ubuntu/Fedora/Arch，user ns 开/关 |
| **Web** | Chrome/Safari/Firefox/Edge 最新两版；Docker（runC）与 gVisor（runsc）双 runtime；WS 断连重连恢复；浏览器标签页关闭的 offload 失败语义 |

## 10.5 SDK 对齐门禁

- 六端公开 API（Kotlin/Swift/Go/C#/C/TypeScript）生成规范化接口描述，CI diff：命名、参数、错误码不一致即失败。
- 能力位矩阵（§2.3）由代码生成，文档不得手改。

## 10.6 故障注入

- 杀引擎进程/线程 → 自动重启 + 会话恢复
- rootfs 损坏/半下载 → 验签拒绝 + 重下
- 网络切换/断网 → DNS 刷新 + egress 行为；Web 端 WS 闪断/长断 → attach 恢复与会话保活
- offload handler 崩溃（含浏览器 handler throw）→ 不传染 guest/宿主
- Web 端：容器 OOMKill、token 过期 mid-session、并发会话串话扫描

---

# 11. 开源合规

**本项目前提：Zephyr 为 GPL-3.0，Cell 作为其组件同样 GPL 发布。**

| 组件 | License | 在本项目中的含义 |
|---|---|---|
| iSH 及其 ARM64 fork / 衍生解释器 | GPLv3 | **可直接 fork/链接**——与 Zephyr GPL-3.0 兼容 |
| PRoot | GPLv2 | **可直接 fork/链接**——GPLv2→GPLv3 单向兼容（GPLv3 §"or later" 不适用时，以 GPLv3 发布组合作品即可吸收 GPLv2 组件；FSF 确认 GPLv2-only+GPLv3 组合作品可按 GPLv3 分发） |
| QEMU | GPLv2 | 同上可用 |
| box64 | MIT | 友好 |
| Alpine rootfs 各包 | 混合 | 分发附许可清单与源码获取说明 |
| FFmpeg | LGPL-2.1+ | 动态链接合规 |
| gVisor | Apache-2.0 | 友好（Apache-2.0 与 GPLv3 兼容） |
| xterm.js / protobuf | MIT / BSD | 友好 |

**结论（取代原"决策分支"）**：
- 移动端引擎**直接 fork OpenMinis 的 iSH-ARM64 与 PRoot 路线**起步，在其架构上做 Cell 化改造（offload 泛化、协调器、限额、审计）。
- 保留自研重写的长期选项（性能/可控性动机，而非 license 动机）。
- 若未来 Zephyr 出现闭源商业发行版需求，再回到分支讨论——当前不构成阻塞。

**M0 解除法务阻塞**：原 ADR-005 的"license 决策先于移动端正线"在当前 GPL 前提下已默认满足，M0 仅剩 SDK 接口冻结与基型打通。

---

# 12. 里程碑与工作量

| 里程碑 | 内容 | 周期 | 出口标准 |
|---|---|---|---|
| **M0 基型** | SDK 接口冻结 v0（含 TS 绑定）；帧协议与审计 schema 定稿；选定 iSH-ARM64/PRoot fork 基线 commit | 2 周 | 六端 `echo ok` 打通（Web 用 Direct 容器原型）；Capabilities 上报 |
| **M1 移动双端** | Android PRoot 引擎（SeccompFallback、持久 shell、每会话 Mutex）+ iOS Asbestos 引擎（boot/fakefs/offload 网关）+ bind mount + env 对齐 + 5 个核心 offload | 6-8 周 | 双端契约语料 50 例绿；真机 6+2 台过 |
| **M2 桌面三端** | Direct + CellVM + WSL2-bridge + 桌面 offload + CLI | 4-6 周 | 五原生端契约全绿 |
| **M2.5 Web 端**（可与 M2 并行） | Cell-Server 嵌入主端 Docker 容器（Direct 嵌套）+ zephyr-ai 新增 `cell_exec` 工具族 + 认证挂主端会话 + npm SDK + AI 浮窗 Cell 终端/文件面板 + 浏览器 offload 五件套 + 预热池 | 4-5 周 | 六端契约全绿；双 runtime（runC/runsc）过门禁；断连恢复过；L2 双写灰度开始 |
| **M3 AI 原生层** | 持久 shell 完善、审计回放、快照（CellVM）、限额全量、MCP server（stdio + HTTP） | 3-4 周 | 性能门禁达标；审计可回放任一 session |
| **M4 加固发布** | 真机矩阵、双 rootfs 对齐、威胁模型文档、开发者文档、Web 部署指南（本地/团队两形态） | 4 周 | G1-G6 验收全过 |

总计约 **21-26 周**（M2.5 与 M2 并行则不延长总期）。人力估算：2-3 名系统工程师（引擎）+ 1 名 SDK/绑定 + 1 名 Web 全栈 + 1 名测试基建。

---

# 13. 风险登记册

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | ~~GPL 传染~~（已消解：Zephyr 为 GPL-3.0，§11） | — | — | 保留条目仅作记录；若未来闭源发行需重估 |
| R2 | iOS Asbestos 性能不达预算 | 中 | 高 | 持久 shell 摊薄；负载分级路由；JIT 侧载增强；预算如实下调重定验收 |
| R3 | Android 内核碎片化 | 高 | 中 | SeccompFallback 内置；真机矩阵；设备指纹降级策略库 |
| R4 | Apple 审核政策变化 | 低-中 | 高 | 守"代码全在包内"红线；备选分发叙事 |
| R5 | WSL2 部署率/企业禁用 | 中 | 中 | QEMU-user 降级；安装引导 |
| R6 | 双 rootfs 对齐维护成本 | 中 | 中 | 契约测试自动化；不对齐包禁入工具链层 |
| R7 | offload 矩阵六端进度漂移 | 高 | 低 | 能力位机制；契约锁语义不锁覆盖 |
| R8 | 快照仅 CellVM 可用被误读 | — | 低 | 能力位 + 文档明示；CRIU 评估（Linux/Cell-Server） |
| R9 | **Web 端被当作公共多租户 SaaS 过早暴露** | 中 | 高 | v1 明确只做本地/团队形态（§0.2）；每用户容器隔离；metadata 黑洞强制 |
| R10 | **嵌套命名空间在某些 Docker 环境被拒**（旧 Docker/受限 K8s PSP） | 中 | 中 | gVisor 档不需要嵌套 user ns；镜像附带双 runtime 说明；探测失败给结构化诊断 |
| R11 | **浏览器 offload 的权限/生命周期碎片化**（各浏览器权限模型差异、标签页关闭） | 高 | 低 | 统一 126/125 错误语义 + 超时 + 审计；自动化浏览器测试入矩阵 |

---

# 14. 附录：调研依据

本文档每个关键决策都建立在已验证的公开实现之上：

1. **OpenMinis**（GitHub OpenMinis/OpenMinis，GPLv3，4.5k star，App Store 在售）——iOS（iSH-ARM64 fork，Asbestos 解释器，Alpine aarch64）+ Android（PRoot fork）双端生产实现。native offload 机制（execve 拦截 + 22 handler）、每会话 bind mount、env 逐端对齐、SeccompFallbackPolicy（其 GH#186）、持久 shell + 每会话 Mutex 均源自对其规格文档与源码的研读。其 iOS 全局 FIFO 串行是本文档修正的反面教材。
2. **ios-linuxkit**（rcarmo/ios-linuxkit）——Asbestos 解释器活跃维护 fork，明示核心合规机制："全部可执行 host 指令来自构建产物，解释器只分配数据"。
3. **ish-jit-arm64**（gzz2000）——arm64→arm64 同 ISA JIT，sysbench 仅慢硬件虚拟化 10-20%。证明 iOS 性能天花板，定位为增强非依赖。
4. **MimoBox**（showkw/mimobox）——统一 SDK + 多后端智能路由先例与性能基准（Wasm P50 1.01ms / OS 8.24ms / microVM 快照恢复 28ms）。能力位与引擎路由设计参考其模式。
5. **E2B**（e2b.dev，Apache-2.0）——Template/Sandbox/commands/files/PTY 对象模型；其"云端沙箱 + SDK"形态也是 Web 端产品形态的参照（Cell 的差异：六端同构 + 本地优先 + 自托管）。
6. **gVisor / Firecracker / Kata**——Web 端容器内二级沙箱与隔离档选型的技术依据。
7. **Cloudflare Dynamic Workers / NVIDIA Pyodide 实践**——轻量沙箱 + 默认拒绝能力模型对 Agent 负载的适用性佐证。
8. **UTM SE / a-Shell / iSH**（App Store 在售）——iOS 本地 Linux/Unix 的三条已验证路线，支撑 ADR-002 的"iOS 本地可行"结论。

---

*文档结束。下一步：M0——SDK 接口冻结（含 TS 绑定）+ 六端 `echo ok` 基型。license 已在 Zephyr GPL-3.0 前提下解除阻塞；M2.5（Web/主端集成 + zephyr-ai 工具接入）与 M2 并行。*
