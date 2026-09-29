<p align="center">
  <img src="public/zephyr-mark.svg" width="96" height="96" alt="Zephyr Logo" />
</p>

<h1 align="center">Zephyr</h1>

<p align="center">
  <b>The Architectural Manifesto & Engineering Vision</b><br>
  主权自持 · 零宿主污染 · 跨异构基础设施的工作现场
</p>

<p align="center">
  <a href="#english">English</a> | <a href="#chinese">中文</a>
</p>

---

<a name="english"></a>
## English

### 1. The Metaphor of the Wind: Why "Zephyr"?

In fluid dynamics and classical mythology, **Zephyr** (*Zephyrus*) represents a directional, low-impedance westerly airflow. It navigates complex topography without shearing surfaces, sustains persistent pressure across medium breaks, and leaves zero residue behind.

Modern remote access tools and enterprise bastion platforms have evolved into rigid, brittle concrete pipelines:
- They force administrators to inject heavy, proprietary `root` daemons into every target node.
- They lock credentials into closed cloud backends, turning private infrastructure access into a rented service.
- They render terminals onto Canvas bitmaps—breaking mobile IME virtual keyboards, magnifier lenses, and text selection.
- They transcode remote desktop frames on the server via CPU-heavy FreeRDP instances, turning a few concurrent RDP sessions into host-level resource exhaustion.
- A single cellular tower handoff or transient Wi-Fi packet drop snaps the TCP socket, destroying foreground PTY processes and terminal buffers.

**Zephyr was architected to replace brittle pipelines with fluid mechanics.** It treats infrastructure management not as a permanent invasion, but as a low-resistance current: sweeping across nodes without leaving host artifacts, treating physical disconnects as ordinary valve operations, and anchoring cryptographic sovereignty strictly to client hardware.

---

### 2. Four Concrete Architectural Pillars

#### I. Strict Agentless Foundation & Zero Target Pollution
Managing thousands of production Linux/BSD nodes or network switches requires zero Zephyr binaries on the target:
- **Standard Protocol Endpoints**: Control flows terminate natively on standard OpenSSH, Telnet, bare RDP, and VNC listeners. Operating systems retain their stock security boundary and attack surface.
- **Strictly Scoped Edge Bastion (`Zephyr Agent`)**: The optional companion Flutter agent is not a resident spyware. It exists for exactly two edge scenarios:
  1. Acting as an ephemeral, outbound reverse tunnel to pierce deep-VPC or strict NAT barriers without exposing public ports.
  2. Bridging local client directories into remote Windows RDP sessions as native virtual drives (`\\tsclient` via the MS-RDPEFS protocol).
- Once the task completes, the edge tunnel dissipates completely.

#### II. Decoupled PTY Lifecycles & Persistent Ring-Buffer Replay
Physical networks are volatile; interactive processes must be resilient:
- **Go Data Plane Isolation (`zephyr-worker`)**: The Go-based PTY supervisor decouples process lifecycles from ephemeral WebSocket transport. When mobile signal drops or laptop lids close, the underlying shell does not receive an unhandled `SIGHUP`.
- **Zero-Loss Reconnection**: Terminal outputs generated during disconnects are held in a fixed-size memory ring-buffer. Upon client re-authentication and sequence handshake, buffered output replays cleanly, preserving escape sequences and ongoing compilation streams.

#### III. Client-Side GPU Offloading & DOM Terminal Fidelity
Modern clients possess abundant compute power; servers should not waste cycles on UI transcoding:
- **Native DOM Terminal (`@wterm/dom`)**: Canvas-based terminals flatten glyphs into pixels. Zephyr renders cells directly into the DOM tree. Mobile touchscreens gain native magnifier selection, hardware-accelerated kinetic scrolling, screen reader accessibility, and uncorrupted multi-byte CJK IME composition.
- **Browser-Side WASM RDP (`grdp`)**: Zephyr eliminates server-side FreeRDP video transcoders. It compiles a Go RDP engine into browser WebAssembly (`grdp`), parsing RDPGFX and bitmap orders directly on the client. Rendering is handled by the client's WebGL2 FBO compositor and hardware WebCodecs (AVC420/AVC444 dual-stream), reducing server overhead to a lightweight binary WebSocket-to-TCP forwarder.

#### IV. Local-First Sovereignty & Post-Quantum Cryptographic Mesh
Trust must not be outsourced to third-party cloud providers:
- **Embedded Desktop Core (`Zephyr One`)**: The Electron desktop runtime operates fully offline via an embedded Node.js instance and local `node:sqlite` database. Local SSH keys, LAN node inventories, and AI tooling execute without reaching the public internet. Remote Zephyr servers function strictly as optional synchronization peers.
- **Adversarial Transit Hardening (`ZSL/2`)**: Enterprise proxies and commercial CDNs routinely decrypt public TLS. The Zephyr Link Layer 2 protocol encapsulates sensitive traffic in an end-to-end envelope using post-quantum hybrid key exchange (ML-KEM-768 + X25519) and authenticated symmetric ciphering (AES-256-GCM). Cryptographic keys reside exclusively within local endpoints.

---

### 3. The Engineering Stance

> We reject telemetry-laden SaaS dashboards, mandatory agent deployments, and fragile browser terminal canvases.  
> Zephyr exists to deliver deterministic, low-latency, and sovereign operational control over any machine, across any network topology, from any client device.

---

<a name="chinese"></a>
## 中文

### 1. 风的工程定义：为什么叫 Zephyr？

在流体力学与古典意象中，**Zephyr（西风）** 指代一种阻抗极低、动能恒定的定向气流。它拂过粗糙表面而不造成撕裂，在介质受阻时维持压力差，在阀门关闭后不留残渣。

反观当代主流的远程运维工具与商业堡垒机，往往如同笨重僵硬的水泥管道：
- 强迫管理员在每台被控节点上植入高权限的专有常驻 Agent；
- 将资产凭据与会话调度锁死在云端 SaaS，把基础设施控制权变成按月续费的质押品；
- 终端基于 Canvas 绘制位图，导致移动端拼音输入法（IME）吞字、划词放大镜失效；
- 远程桌面在服务端强行运行 FreeRDP 转压 H.264 视频流，几路并发就能打满宿主机 CPU；
- 一次高铁进洞或 Wi-Fi 漫游中断了 TCP 链路，正在跑的前台 PTY 进程与缓冲区瞬间灰飞烟灭。

**Zephyr 的设计初衷，是用流体力学替代僵硬管道。** 它将运维交互视为一股低阻抗的穿透气流：拂过万千节点而不留宿主代码，将网络断连视为常规的阀门启闭而非致命崩溃，并将数据与密钥主权死死锁在端点本地。

---

### 2. 四大核心架构支柱

#### 一、 严格无代理（Agentless）与零宿主污染
管理上千台 Linux/BSD 节点或网络交换机，被控机器无需安装任何 Zephyr 二进制组件：
- **原生协议终结**：所有控制流直接由标准 OpenSSH、Telnet、纯粹 RDP 与 VNC 协议终结，不污染宿主操作系统，完全保留系统原生的安全边界与攻击面。
- **边界严格收敛的边缘跳板（`Zephyr Agent`）**：附带的 Flutter Agent 绝非入侵式监控软件，它的职责严格收敛于两个极端场景：
  1. 作为轻量单向反向隧道，从深层 VPC 或内网穿透 NAT 边界，对外零暴露端口；
  2. 基于 MS-RDPEFS 协议，在远程 RDP 桌面中将本地客户端目录挂载为虚拟磁盘（`\\tsclient`）。
- 任务执行完毕后，隧道即刻消散，不在宿主留下任何驻留痕迹。

#### 二、 进程生命周期解耦与环形缓冲保活
现实物理信道充满抖动，交互进程必须具备自持能力：
- **Go 数据平面隔离（`zephyr-worker`）**：Go 语言底层 PTY 守护进程将真实进程生命周期与易碎的 WebSocket 传输彻底解耦。网络断开、笔记本合盖时，受控 Shell 绝不会收到意外的 `SIGHUP` 异常终止。
- **零丢失增量回显**：断线期间产生的输出数据，由定长内存环形缓冲区持久锁定。客户端重连握手完成后，缺失的字符流瞬间顺流回灌，完整保留 ANSI 转义序列与编译现场。

#### 三、 算力下沉客户端与 DOM 级终端交互
现代客户端具备充沛的图形算力，服务端不应为界面转码浪费任何 CPU：
- **DOM 原生终端渲染（`@wterm/dom`）**：摒弃将字符画成位图的 Canvas 方案，Zephyr 将每个单元格直接渲染在 DOM 树中。移动端触屏原生支持长按划词、放大镜选择、无障碍屏幕阅读器，以及多字节 CJK 输入法平滑上屏。
- **浏览器端 WASM RDP（`grdp`）**：彻底剔除服务端 FreeRDP 暴力视频转码方案。Zephyr 将 Go RDP 协议栈编译为浏览器内运行的 WebAssembly（`grdp`），在客户端直接解析 RDPGFX 与位图指令，并交由本地 WebGL2 FBO 合成器与 WebCodecs 硬件管线解码，服务端仅充当轻量的二进制数据流转发通道。

#### 四、 本地优先架构与抗量子加密网格
安全与控制主权绝不向上游第三方让渡：
- **完全自治的桌面核心（`Zephyr One`）**：桌面端（Electron）内置独立的 Node.js 运行时与 `node:sqlite` 数据库。扫描局域网资产、调用本地 SSH 私钥、运行本地 AI 智能体在完全断网下秒级可用；远程主端仅作为可选的数据同步对等节点。
- **敌对信道防护（`ZSL/2`）**：企业代理与商用 CDN 会在边缘强制拆解并明文解密标准 TLS。Zephyr Link 二代协议（ZSL/2）采用后量子混合密钥协商（ML-KEM-768 + X25519）与对称加密（AES-256-GCM）构建端到端密文通道，网络中继节点只能看到不透明的二进制分块，私钥与凭据物理驻留于端点。

---

### 3. 工程立场

> 我们拒绝充斥数据追踪的商业云监控、拒绝在受控主机上强推全家桶 Agent、拒绝不可选词的玩具级 Canvas 终端。  
> Zephyr 的存在只有一个目的：在任何不可靠的网络拓扑与终端设备上，为工程师交付确定、低延迟且主权完全闭环的基础设施控制现场。