<p align="center">
  <img src="public/zephyr-mark.svg" width="96" height="96" alt="Zephyr Logo" />
</p>

<h1 align="center">Zephyr: Architecture & Vision</h1>

<p align="center">
  <b>A Sovereign, Zero-Trace Workspace for Heterogeneous Infrastructure</b><br>
  主权自持 · 零宿主污染 · 跨异构基础设施的工作现场
</p>

---

## 1. Why "Zephyr"? / 命名含义

### [EN] The Engineering Definition of Wind
In fluid mechanics, a **zephyr** is a low-impedance, directional current. It flows around irregular surfaces without tearing them, maintains pressure across breaks in the medium, and dissipates entirely when its valve is closed.

Most remote administration suites today behave like rigid concrete pipes:
- They force you to run invasive resident daemons with `root` privileges on every target node.
- They route your keystrokes and credentials through third-party SaaS relays.
- Their terminal canvases break mobile IME, while their RDP stacks melt your server CPU with server-side FreeRDP video transcoders.
- A single train tunnel or Wi-Fi handoff severs your TCP socket and destroys your running buffer.

**Zephyr was built to replace rigid pipes with fluid mechanics.** It manages infrastructure without leaving resident code behind; it treats network dropouts as normal valve cycles rather than fatal errors; and it anchors cryptographic sovereignty strictly to the user's local hardware.

### [ZH] 风的工程定义
在流体力学中，**Zephyr（西风）** 指代一种极低阻抗、具备恒定动能的定向流体。它拂过粗糙表面而不造成撕裂，在介质受阻时维持压力差，在阀门关闭后不留残渣。

反观当今主流的远程运维工具，往往如同笨重僵硬的水泥管道：
- 强迫你在被管理的服务器上常驻一个 `root` 权限的专有 Agent；
- 将你的按键流与认证凭据托付给云端 SaaS 中转；
- 终端基于 Canvas 绘制，导致移动端输入法（IME）与划词选择彻底失效；远程桌面依赖服务端 FreeRDP 暴力转码，几路连接就能打满服务器 CPU；
- 一次高铁隧道或 Wi-Fi 漫游导致 TCP 断开，正在运行的控制台前台与缓冲区瞬间灰飞烟灭。

**Zephyr 的设计初衷，是用流体力学替代僵硬管道。** 它穿行于服务器集群而不留下任何宿主垃圾；将物理断网视为常规的流体阀门启闭而非致命崩溃；并将数据与密钥主权死死锁在端点本地。

---

## 2. Core Architectural Pillars / 核心架构支柱

### I. Zero-Trace & Agentless Core / 零痕迹管理与严格无代理
* **[EN] No Target Pollution**: Managing 1,000 Linux/BSD nodes or network switches requires zero Zephyr binaries on the target. All orchestration terminates on standard protocol endpoints: OpenSSH, Telnet, native RDP, and VNC. The target OS attack surface remains exactly as the vendor designed it.
* **[ZH] 拒绝宿主系统污染**：管理 1000 台目标 Linux/BSD 主机或网络交换机，被管机无需植入任何 Zephyr 二进制文件。所有控制流直接交由标准 OpenSSH、Telnet、原生 RDP 与 VNC 协议终结，不扩大任何受攻击面。
* **[EN] The Strict Edge Bastion Boundary**: The companion `Zephyr Agent` is not a monitoring spyware. It serves exactly two edge scenarios: piercing isolated NAT/VPC perimeters as a unidirectional outbound reverse tunnel, and bridging local filesystem directories into remote RDP sessions as virtual disks (`\\tsclient` via MS-RDPEFS). When the task finishes, no persistent artifacts remain.
* **[ZH] 边缘跳板的严格边界**：附带的 `Zephyr Agent` 不是入侵式监控软件，它的存在仅收敛于两个极端边界：作为单向出站反向隧道穿透深层隔离的 NAT/内网；或在 RDP 远程桌面中将本地目录挂载为虚拟磁盘（基于 MS-RDPEFS 的 `\\tsclient`）。任务结束即走，绝不常驻越权。

### II. State Continuity & Decoupled PTY / 会话解耦与气压保活
* **[EN] TCP Sockets Die; PTYs Persist**: A network connection is an ephemeral transport, not a session anchor. Zephyr’s Go PTY runtime decouples process lifecycles from physical network states. When physical connection drops, the child process does not receive an unhandled `SIGHUP`.
* **[ZH] TCP 链接会死，但 PTY 必须活着**：物理连接只是临时的传输载体，绝不能作为会话生命周期的锚点。Zephyr 的 Go 语言底层 PTY 会话管理器将进程生命周期与网络套接字彻底解耦。物理断线时，受控进程绝不会收到意外的 `SIGHUP` 异常终止。
* **[EN] Incremental Ring-Buffer Replay**: Output generated during a disconnect is buffered in a fixed-size memory ring. Upon client reconnect and sequence acknowledgment, lost output re-flows into the UI without truncation or corrupted escape codes.
* **[ZH] 增量环形缓冲区回灌**：断线期间产生的控制台输出，由内存中的定长环形缓冲区持久锁定。一旦客户端重连完成并完成序列握手，缺失的字符流瞬间回显，绝不丢失关键编译日志与操作现场。

### III. DOM Terminal & Client-Side GPU RDP / DOM 渲染与客户端 GPU 算力
* **[EN] The DOM Terminal (@wterm/dom)**: Canvas-based terminals (like standard xterm.js configurations) turn characters into flat pixels, breaking native mobile text selection, magnifiers, screen readers, and mobile virtual keyboard IMEs. Zephyr renders terminal cells directly into the DOM, making terminal text natively selectable, searchable, and responsive across phone touchscreens.
* **[ZH] DOM 级原生终端渲染（@wterm/dom）**：传统的 Canvas 终端渲染方案将字符画在位图画布上，直接摧毁了移动端长按划词、放大镜选择、无障碍读取以及虚拟键盘拼音（IME）输入。Zephyr 基于 `@wterm/dom` 将每个终端单元格直接渲染在 DOM 树中，使控制台字符具备原生文本的复制能力与触屏交互精度。
* **[EN] Zero Server Transcoding (WASM grdp)**: Traditional remote desktop gateways run FreeRDP on the server and transcode desktop frames into heavy WebRTC/H.264 streams, exhausting host CPU. Zephyr compiles its Go RDP protocol stack into WebAssembly (`grdp`). The browser negotiates raw RDPGFX / bitmap semantics directly, offloading rendering to the client's WebGL2 FBO compositor and hardware WebCodecs (AVC420/444). The server acts purely as a lightweight binary forwarder.
* **[ZH] 零服务端转码开销（WASM grdp）**：传统网关在服务端运行 FreeRDP 并把画面强行压制为 WebRTC/H.264 视频流，耗尽服务器 CPU。Zephyr 将 Go 原生 RDP 协议栈编译为浏览器内运行的 WebAssembly（`grdp`）。由浏览器直接解析 RDPGFX 与位图语义，交由本地 GPU（WebGL2 FBO 混合器）与 WebCodecs 硬件管线解码，服务端仅充当极轻量的二进制转发通道。

### IV. Local-First Desktop & Cryptographic Mesh / 本地优先与抗量子传输
* **[EN] Independent Desktop Core (Zephyr One)**: The desktop shell (Electron) does not depend on a remote server to function. It houses an embedded Node.js runtime and local `node:sqlite` storage. Managing local LAN machines, running SSH keys, and interacting with local AI runtimes works fully offline. Remote Zephyr servers serve strictly as synchronization peers.
* **[ZH] 独立的本地优先桌面核心（Zephyr One）**：桌面端（Electron）不依赖任何远端服务器即可独立运转。它内嵌 Node.js 运行时与本地 `node:sqlite` 数据库。管理局域网设施、调用本地 SSH 私钥、执行本地 AI 模型在完全断网下秒级可用；远程主端仅作为多设备状态同步的一个对等节点。
* **[EN] Adversarial Transit & Post-Quantum Encryption (ZSL/2)**: Standard TLS terminates and decrypts at corporate middleboxes, enterprise proxies, and commercial CDN edges. Zephyr Link Layer 2 (ZSL/2) wraps operational traffic in an end-to-end envelope using post-quantum hybrid key exchange (ML-KEM-768 + X25519) and authenticated symmetric encryption (AES-256-GCM). Transit hops see only opaque binary frames; credentials never touch intermediary memory.
* **[ZH] 敌对网络信道下的抗量子传输（ZSL/2）**：标准 TLS 会在企业反向代理和商业 CDN 边缘被强制解密拆包。Zephyr Link 二代协议（ZSL/2）在应用层使用后量子混合密钥协商（ML-KEM-768 + X25519）与对称加密（AES-256-GCM）构建端到端加密封包。公网中继节点只能看到不透明的密文分块，认证凭据在内存生命周期中永不暴露给中间商。

---

## 3. Engineering Stance / 工程立场

> **[EN]** We reject telemetry-laden SaaS dashboards, mandatory agent installations, and fragile browser terminal canvases.  
> Zephyr exists to deliver deterministic, low-latency, and sovereign operational control over any machine, across any network topology, from any client device.
>
> **[ZH]** 我们拒绝充斥数据追踪的商业云监控、拒绝在受控主机上强推全家桶 Agent、拒绝不可选词的玩具级 Canvas 终端。  
> Zephyr 的存在只有一个目的：在任何不可靠的网络拓扑与终端设备上，为工程师交付确定、低延迟且主权完全闭环的基础设施控制现场。