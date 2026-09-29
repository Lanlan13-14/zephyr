<p align="center">
  <img src="public/zephyr-mark.svg" width="96" height="96" alt="Zephyr Logo" />
</p>

<h1 align="center">Zephyr</h1>

<p align="center">
  Unified Multi-Platform Remote Infrastructure & Agent Platform
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#chinese">中文</a>
</p>

---

<a name="english"></a>
## English

### 1. The Crisis of Sovereignty & The Philosophy of the Wind

#### The Enclosure of the Modern Workspace
Over the past decade, personal computing and infrastructure management have undergone a quiet enclosure. The tools engineers rely on to touch bare metal—terminal emulators, remote desktop clients, credential managers, and bastion relays—have been systematically absorbed into proprietary cloud silos. Access to private servers is now brokered by subscription paywalls, session metadata is logged in remote analytical telemetry, and sensitive cryptographic keys are outsourced to hosted vaults.

Simultaneously, the physical medium of work has fractured. An engineer moves between multi-display workstations, lightweight laptops, and mobile touchscreens throughout a day. Yet, the software ecosystem treats these transitions as disruptive failures:
- Connections sever irreversibly upon transient network handoffs;
- Mobile interfaces remain clumsy, second-class citizens with broken virtual keyboards and unselectable canvas pixels;
- Remote desktops exhaust server resources by forcing obsolete server-side video re-encoding;
- Bastion tools demand the installation of heavy, root-level resident daemons across every managed node, expanding attack surfaces while stripping operators of system cleanliness.

#### The Genesis of "Zephyr"
In fluid dynamics and classical mythology, **Zephyr** (*Zephyrus*) is the directional westerly airstream—a force that traverses vast geographical distances with minimal impedance, flows seamlessly around complex obstacles without tearing them, maintains steady atmospheric pressure across turbulent boundaries, and vanishes without physical residue the moment its flow ceases.

**Zephyr was conceived not as an administrative utility, but as a fluid operational continuum.** It rejects the premise that infrastructure management requires rigid, permanent, and centralized pipes. Instead, it models computational access as a pervasive, low-resistance atmospheric current:
1. **Flowing across nodes without leaving host artifacts** (strict agentless architecture);
2. **Treating physical network severance not as fatal failure, but as transient valve behavior** (decoupled PTY lifecycle);
3. **Adapting fluidly to any vessel while retaining identical kinetic behavior** (cross-platform strict parity);
4. **Permeating hostile public transit without surrendering cryptographic keys** (payload-level post-quantum mesh).

---

### 2. The Comprehensive Subsystem Matrix

Zephyr realizes this vision through five strictly coordinated subsystems:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Zephyr One Clients                              │
│   Desktop (Electron + Embedded Core) │ Android (Compose) │ iOS (Swift)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ ZSL/2 Post-Quantum Envelope
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Zephyr Transport Plane                           │
│     ZSL/2 (ML-KEM-768 + AES-GCM) │ WebSocket │ Mesh Tunnel Matrix      │
└───────────────────┬─────────────────────────────────┬──────────────────┘
                    │                                 │
┌───────────────────▼───────────────┐ ┌───────────────▼──────────────────┐
│      Zephyr Server Control        │ │      Zephyr Worker Data Plane   │
│  Node.js Control Plane & APIs     │ │  Go High-Concurrency PTY Daemon │
│  better-sqlite3 State Store       │ │  Ring-Buffer Session Persistence│
│  ML-KEM-768 Credential Encryption │ │  Telnet IAC/NAWS Protocol Engine │
└───────────────────┬───────────────┘ └───────────────┬──────────────────┘
                    │                                 │
┌───────────────────▼───────────────┐ ┌───────────────▼──────────────────┐
│       Zephyr AI & Cell            │ │    Zephyr Agent & Edge Mesh     │
│  Multi-Provider Agent Sandbox     │ │  Ephemeral Unidirectional Tunnel│
│  Chromium Automation & Planner    │ │  MS-RDPEFS \\tsclient Bridge    │
│  Connection-Scoped Memory Mesh    │ │  Strictly Ephemeral Piercing    │
└───────────────────────────────────┘ └──────────────────────────────────┘
```

#### I. Zephyr One: Absolute Multi-Platform Parity
The core objective of Zephyr One is the **complete eradication of operational friction across form factors**:
- **Desktop Offline Autonomy**: The desktop build houses an embedded Node.js core paired with `node:sqlite`. It is not an empty WebView; it functions as an autonomous local bastion capable of scanning LAN nodes, mounting keys, and driving local AI runtimes without internet access. Remote Zephyr servers operate merely as state-synchronization peers.
- **First-Class Mobile Native Engines**: Mobile implementations in Kotlin/Jetpack Compose (Android) and Swift/SwiftUI (iOS) reject web wrappers. They implement direct touch gestures, custom virtual auxiliary keyboards, and biometric Passkey authentication, ensuring terminal navigation on a 6-inch phone matches the efficiency of a physical workstation.

#### II. Zephyr Server & Worker: Decoupled Control & Data Planes
Traditional monolithic architectures collapse when connection counts surge or long-running jobs are interrupted. Zephyr enforces a strict functional split:
- **Control Plane (Node.js)**: Governs authentication, role-based access control, cryptographic key lifecycles, and configuration management. Credentials are never written to disk unencrypted; sensitive fields undergo hybrid encryption (ML-KEM-768 + AES-256-GCM) before SQLite persistence.
- **Data Plane (`zephyr-worker`)**: Built in Go, this daemon supervises raw PTY allocations, stream multiplexing, and WebSocket bridging. The underlying shell process is strictly isolated from network socket states: closing a browser or dropping packet transmission does not dispatch `SIGHUP`. A persistent memory ring-buffer retains session delta, streaming buffered logs seamlessly upon sequence-acknowledged reconnects.

#### III. Client-Centric Rendering: DOM Terminal & WASM RDP
Zephyr systematically migrates computational workloads from overburdened servers to modern client hardware:
- **The DOM Terminal (`@wterm/dom`)**: Most web terminals render to a Canvas, reducing characters to unintelligent raster bitmaps. Zephyr renders each character directly into the DOM tree. Mobile touchscreens gain native magnifier selection, hardware-accelerated kinetic scrolling, screen reader accessibility, and zero-drop CJK IME composition.
- **Serverless Client RDP (`grdp` WASM)**: Traditional gateways host FreeRDP instances on the server, transcoding graphical changes into heavy video streams that throttle CPU cores. Zephyr compiles its Go RDP protocol stack into browser WebAssembly. The client decodes native RDPGFX and bitmap orders locally via a WebGL2 FBO compositor and hardware WebCodecs (AVC420/AVC444 dual-stream), reducing the server's role to a lightweight, zero-compute binary forwarder.

#### IV. Zephyr Link (ZSL/2): Post-Quantum Adversarial Transport
We treat all transit networks—commercial CDNs, enterprise TLS inspection proxies, and mobile gateways—as compromised, adversarial environments:
- **The ZSL/2 Cryptographic Envelope**: The Zephyr Link protocol establishes application-layer tunnels wrapped in post-quantum hybrid key exchange (ML-KEM-768 + X25519) combined with AES-256-GCM authenticated ciphering.
- **Intermediary Blindness**: Intermediary nodes observe only opaque, authenticated binary frames. Decryption keys and plaintext credentials exist exclusively within local device memory, neutralizing TLS-terminating enterprise middleboxes.

#### V. Zephyr Agent & Edge Mesh: Strict Non-Invasive Bastions
Zephyr upholds an uncompromising boundary regarding remote host intrusion:
- **Agentless by Default**: Over 99% of targets (Linux, BSD, switches, bare-metal servers) are managed purely through stock OpenSSH, Telnet, native RDP, and VNC interfaces. No resident software is installed; no foreign binaries remain.
- **The Ephemeral Agent**: The companion Flutter-based `Zephyr Agent` is invoked only under strict, operator-driven criteria:
  1. As an outbound, unidirectional tunnel that pierces isolated private VPCs without opening inbound listening ports.
  2. To bridge local client directories into remote Windows RDP sessions as virtual drives (`\\tsclient` via MS-RDPEFS).
- The agent holds no ambient authority; when the connection closes, the pathway evaporates.

#### VI. Zephyr AI & Zephyr Cell: Sovereign Autonomous Automation
Automation must remain auditable, deterministic, and securely constrained:
- **Decoupled AI Engine**: Supports multi-provider model switching, customized User-Agents, and granular credential sharing without exposing raw API tokens to operators.
- **Isolated Execution (`Zephyr Cell`)**: Automated scripts, file mutations, and multi-step tasks generated by AI agents execute within sandboxed containers equipped with Chromium automation and contextual long-term memory. Destructive operations require explicit human cryptographic sign-off.

---

### 3. The Ultimate Vision: The Sovereign Computing Fabric

The long-term endgame of Zephyr is to render the physical separation between machines invisible:
- **Your terminal follows you like atmospheric air**: An interactive debugging session initiated on a desktop in Beijing continues uninterrupted on a mobile device aboard a high-speed train, without losing terminal lines or process state.
- **Zero footprint, infinite reach**: You orchestrate thousands of servers without leaving a trace of foreign software on any of them.
- **Unconditional sovereignty**: Your keys, credentials, and logs belong exclusively to you, secured against both present surveillance and future quantum cryptanalysis.

> **We do not build software to sell seats in a rented cloud.**  
> **Zephyr exists to forge a sovereign, weightless, and unyielding westerly wind—carried at your side, blowing across any machine, bowing to no master.**

---

<a name="chinese"></a>
## 中文

### 1. 主权危机与西风哲学

#### 现代工作现场的“领地化”围剿
过去十年间，个人计算与基础设施运维经历了一场隐蔽的“圈地运动”。工程师用于触碰物理硬件的核心工具链——终端模拟器、远程桌面客户端、凭据管理库与跳板中继——正被系统性地收编进商业 SaaS 平台的中心化孤岛。连接私有服务器成了按月订阅的质押品，会话历史与操作元数据沉淀在远端数据仓库中，最敏感的生产私钥被托管于不受控的云端金库。

与此相伴的，是物理工作场景的极度碎片化。一个工程师在一天之内，需要在三屏工作站、轻薄笔记本以及机房走廊中的手机触屏之间频繁切换。然而，现有的工具链将这种设备流转视为致命的灾难：
- 移动基站切换导致 TCP 瞬间断开，前台编译流程连同缓冲区全面报废；
- 移动端界面形同虚设，Canvas 画布摧毁了虚拟输入法、划词放大镜与触控手感；
- 远程桌面强行在服务端暴力压制视频流，几路并发就耗尽宿主机的 CPU 核心；
- 商业堡垒机强推在每台受控节点上常驻庞大的特权 Agent，不仅污染系统原生环境，更无端扩张了整网的被攻击面。

#### 为什么叫“Zephyr（西风）”？
在流体力学与希腊古典意象中，**Zephyr（西风之神）** 指代一种阻抗极低、动能恒定的大尺度定向气流。它拂过复杂粗糙的地表而不发生撕裂，在穿透湍流介质时维持平稳的压力差，在阀门闭合后不留下任何物理碎屑。

**Zephyr 从诞生之日起，就不是一个平庸的运维管理工具，而是一个流动的工程现场连续体。** 它彻底否定了“系统管理必须依赖僵硬、永久且中心化管道”的教条，将对基础设施的控制重塑为一种无孔不入、阻抗极低的工程流体：
1. **拂过千百节点而不留宿主残渣**（严格的无代理 Agentless 哲学）；
2. **将物理断网视为常规的流体阀门启闭，而非不可挽回的崩溃**（进程生命周期彻底解耦）；
3. **随不同物理器物自适应赋形，但风骨与交互手感严苛对称**（跨端全平台绝对趋同）；
4. **穿行于充满敌意的公网荒原，私钥与主权死死闭环于本地**（载荷级抗量子网格）。

---

### 2. 完备的子系统架构矩阵

Zephyr 通过高度协同的五大核心子系统，将这一流体构想转化为严密的工程实现：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Zephyr One 统一客户端                            │
│   桌面端 (Electron + 本地自持核心) │ 安卓端 (Compose) │ iOS端 (SwiftUI) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ ZSL/2 抗量子端到端密文信道
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Zephyr 传输层拓扑                                │
│     ZSL/2 (ML-KEM-768 + AES-GCM) │ WebSocket │ 网格隧道路由矩阵        │
└───────────────────┬─────────────────────────────────┬──────────────────┘
                    │                                 │
┌───────────────────▼───────────────┐ ┌───────────────▼──────────────────┐
│      Zephyr Server 控制平面       │ │      Zephyr Worker 数据平面     │
│  Node.js 策略调度与 REST/WS API   │ │  Go 语言底层高并发 PTY 守护进程 │
│  better-sqlite3 状态存储引擎      │ │  定长内存环形缓冲区 (Ring Buffer)│
│  敏感凭据 ML-KEM-768 落盘加密     │ │  Telnet IAC/NAWS/TTYPE 双向引擎 │
└───────────────────┬───────────────┘ └───────────────┬──────────────────┘
                    │                                 │
┌───────────────────▼───────────────┐ ┌───────────────▼──────────────────┐
│       Zephyr AI & Cell            │ │    Zephyr Agent & 边缘跳板      │
│  多模型智能体沙盒与任务规划器     │ │  单向反向穿透轻量跳板            │
│  Chromium 浏览器自动化与截图分析  │ │  MS-RDPEFS \\tsclient 磁盘桥接   │
│  连接绑定的长期 Memory 知识网络   │ │  按需拉起，用完即隐              │
└───────────────────────────────────┘ └──────────────────────────────────┘
```

#### 一、 Zephyr One：全平台无差别的绝对趋同（Strict Parity）
Zephyr One 的核心使命，是**彻底消除不同设备形态带来的操作认知割裂**：
- **桌面端离线自持核心**：桌面安装包内嵌精简的 Node.js 运行时与 `node:sqlite` 数据库。它不是一个依赖远程服务才能启动的空壳，而是一个完全自给自足的本地堡垒机。断网状态下，扫描局域网、调用本地私钥、启动本地 AI 智能体秒级响应；远程主端仅作为可选的数据同步端点。
- **移动端一等公民体验**：安卓端（Kotlin/Compose）与 iOS 端（Swift/SwiftUI）彻底抛弃粗糙的网页套壳方案。重写原生的触摸选择手势、专为移动端调优的虚拟扩展辅助键栏、生物识别 Passkey 快速登录，确保在 6 英寸手机屏幕上的运维效率与物理键盘完全对齐。

#### 二、 Zephyr Server 与 Worker：控制平面与数据平面的双核解耦
当并发量上升或面临极端网络抖动时，传统的单体服务往往全盘瘫痪。Zephyr 实施了物理级的职能切分：
- **控制平面（Node.js）**：专注于身份认证、细粒度 ACL 鉴权、资产元数据管理与对外 API 服务。敏感数据绝不以明文落盘，密码、私钥、TOTP Secret 等核心字段在写入 SQLite 前均经过 ML-KEM-768 + AES-256-GCM 混合加密。
- **数据平面（`zephyr-worker`）**：采用 Go 语言构建的常驻底层守护进程，独占管理所有 PTY 实例的创建、流多路复用与 WebSocket 桥接。受控 Shell 进程的生命周期与前端网络连接彻底脱钩：即使关闭浏览器、合上笔记本电脑，后台脚本绝不触发 `SIGHUP` 异常终止；定长内存环形缓冲区（Ring Buffer）锁死断线期间的所有输出流，重连握手后按序列号无缝回灌，转义序列分毫不乱。

#### 三、 算力下沉客户端：DOM 终端渲染与浏览器端 WASM 桌面
Zephyr 系统性地将高昂的图形与文本渲染算力转移至现代客户端本地：
- **DOM 原生终端渲染（`@wterm/dom`）**：淘汰将文字绘制为扁平位图的 Canvas 方案。Zephyr 将每一个字符单元格直接映射为浏览器 DOM 节点。移动端操作系统原生赋予其精准划词、局部放大镜、屏幕无障碍朗读，以及多字节中文/日文/韩文输入法（IME）流畅上屏能力。
- **零服务端转码的 WASM 远程桌面（`grdp`）**：传统网关在服务端运行 FreeRDP 并将画面暴力重编码为 H.264 视频流，几路会话便能吞噬数颗 CPU。Zephyr 将原生 Go RDP 协议栈编译为浏览器内运行的 WebAssembly（`grdp`）。由浏览器直接解析 RDPGFX 与位图指令，并交由本地 WebGL2 FBO 合成器与 WebCodecs 硬件管线解码，服务端仅承担极轻量的二进制 WebSocket-to-TCP 转发，CPU 占用趋近于零。

#### 四、 Zephyr Link (ZSL/2)：抗量子敌对信道穿透
我们默认将传输路径上的所有公共基础设施——商用 CDN、企业级代理、移动网关——视为充满监听与证书解密的敌对环境：
- **ZSL/2 应用层密文封装**：Zephyr Link 协议在业务数据流外包裹一层由后量子混合密钥协商（ML-KEM-768 + X25519）与对称加密（AES-256-GCM）构建的端到端硬核隧道。
- **中间人不可视**：即便外部 WebSocket 在企业网关或 CDN 边缘被强行终止解密，中间层截获的仍然是不透明的应用层二进制密文。解密私钥与明文凭据永远只物理留存于两端设备的内存闭环中。

#### 五、 Zephyr Agent 与边缘跳板：严格收敛的非侵入边界
Zephyr 捍卫着对目标系统干净度的严苛承诺：
- **99% 场景严格无代理（Agentless）**：针对海量 Linux/BSD 主机、交换机及物理服务器，全面通过标准 OpenSSH、Telnet、纯粹 RDP 与 VNC 协议原厂接入。受控主机无需植入任何 Zephyr 代码，保持操作系统最纯净的原生安全边界。
- **1% 场景单向瞬态边缘跳板**：由 Flutter 编写的跨平台 `Zephyr Agent` 绝不是常驻监控木马，其职责仅在两类极端场景下被手动拉起：
  1. 作为轻量单向出站反向隧道，主动穿透深层 VPC 或隔离内网，对外零暴露公网端口；
  2. 基于 MS-RDPEFS 协议规范，在 RDP 远程桌面中将本地客户端目录虚拟化为挂载盘（`\\tsclient`）。
- 交互终止即隧道消亡，不在宿主系统留下一丝一毫的驻留进程。

#### 六、 Zephyr AI 与 Cell：主权内生的自主执行沙盒
智能化必须建立在可控、可验证且完全自治的前提之下：
- **解耦的多供应商模型底座**：支持主流 LLM 动态切换，支持逐模型定义请求 User-Agent 与加密环境变量，凭据共享机制允许普通用户调用算力而无法窥探原始 API Key。
- **隔离执行沙盒（`Zephyr Cell`）**：AI 智能体基于长期 Memory 记忆网络与任务规划器自主生成的排障脚本、文件读写与浏览器自动化（Chromium），运行于隔离容器环境内。任何涉及高危生产变更的写操作，必须经由人类操作员的加密确认签名方可下发。

---

### 3. 终局构想：随身携带的无界基础设施

Zephyr 的终局目标，是彻底抹平物理机器、异构网络与终端屏幕之间的物理鸿沟：
- **工作现场如同随身空气**：在工位工作站上未完的交互式调试，出门在高铁上掏出手机即可无缝接续，控制台输出分毫不差，后台任务平稳流转。
- **踏雪无痕，万物互联**：调度成千上万台异构设施，却不在任何一台机器上留下驻留痕迹。
- **永不妥协的技术主权**：凭据、密钥与操作上下文完完全全属于你自己，无惧任何外部网络的窃听、阻断与中心化审查。

> **我们不为任何租借而来的云端城堡砌砖。**  
> **Zephyr 的存在，是为每一个工程师锻造一缕主权自持、轻捷无痕却坚不可摧的工程西风——随身携带，吹拂万象，永不称臣。**