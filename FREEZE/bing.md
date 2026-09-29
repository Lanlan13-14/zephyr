<p align="center">
  <img src="public/zephyr-mark.svg" width="96" height="96" alt="Zephyr Logo" />
</p>

<h1 align="center">The Philosophy of Zephyr · 西风宣言</h1>

<p align="center">
  <b>Sovereignty · Fluidity · Zero-Trace · Continuous Pressure</b><br>
  主权自持 · 随器赋形 · 零痕拂过 · 气压守恒
</p>

---

### The Metaphor of the Wind · 命名的源起

**[EN]** In classical mythology, **Zephyr** (*Zephyrus*) is the swiftest, most agile of all winds. In fluid dynamics, the Westerlies represent a directional, relentless current spanning continents with minimal impedance.  
Modern operations tooling has devolved into a web of centralized SaaS dependencies: multi-hundred-megabyte client bloat, outsourced credential custody, invasive resident daemons, and sessions that disintegrate at the first drop of a TCP packet.  
**Zephyr is a rebellion against these heavy, centralized chains.** We reconstruct the engineer’s workspace around four elemental fluid principles.

**[ZH]** 在古典神话中，**Zephyr（西风）** 是诸风中最轻盈敏捷的信使；在流体力学中，西风带是横贯大陆、阻抗极低且动能恒定的定向气流。  
现代远程基础设施正在变得前所未有的臃肿：动辄数百兆的客户端、被迫交出凭据的中心化云托管、目标机上层层堆叠的特权常驻守护进程，以及在物理网络微小波动下瞬间崩溃的工作现场。  
**Zephyr 的诞生，是对这种“沉重与中心化锁链”的反叛。** 我们以“流体”的四项物理法则，重新铸造属于工程师的工作现场。

---

### Four Tenets of Zephyr · 四大工程法则

#### 1. Zero-Trace by Default · 拂过，而不侵入
> *"The wind sweeps through the forest without driving a single nail into the bark."*  
> *“风穿过树梢，绝不在树干上钉下一颗钉子。”*

* **[EN] Strict Agentless Foundation**: Managing thousands of target nodes demands zero proprietary resident daemons. We orchestrate native SSH, Telnet, bare RDP, and VNC protocols without polluting the host OS or expanding attack surfaces.
* **[ZH] 严格的无代理（Agentless）基底**：管控千百台目标设施，无需在被控机器上驻留任何专有守护进程。完全依赖原生 SSH、Telnet、纯粹 RDP 与 VNC 协议完成调度，不污染宿主系统，不扩张攻击面。
* **[EN] On-Demand Piercing**: Only when traversing deep NATs or strict VPC perimeters do we deploy an ephemeral, unidirectional edge bastion (*Zephyr Agent*). It pierces the mist on demand, then vanishes.
* **[ZH] 按需穿透，用完即隐**：仅在深层私网与 NAT 边界必须刺破时，才调用轻量单向边缘跳板（Zephyr Agent），充当穿透管道，绝不沦为常驻后门。

#### 2. Pressure & Inertia, Not Fragile Ropes · 气压守恒，而非脆弱的硬绳
> *"A physical connection is a rope that snaps under strain; fluid state carries persistent pressure."*  
> *“物理连接是一扯就断的绳子，流体状态却有着持续的压差。”*

* **[EN] Decoupled Lifecycles**: Cellular handoffs, train tunnels, and sleep cycles make physical disconnections an inevitable reality. Zephyr treats the underlying TCP pipe as an expendable, transient carrier.
* **[ZH] 进程与链路彻底解耦**：基站切换、电梯盲区与设备休眠，让物理断网成为不可避免的常态。Zephyr 将底层 TCP 管道视为随时可消亡的消耗品。
* **[EN] Fluid State Continuity**: A background Go PTY daemon paired with persistent ring-buffering locks down your execution context. When physical link breaks, state pauses; once restored, buffered delta re-flows instantaneously without a missing byte.
* **[ZH] 上下文顺流回灌**：底层 Go PTY 守护进程与环形缓冲区牢牢锁住执行现场。物理断网只是关上阀门，重连建立则是闸门重启——历史输出瞬时回显，工作状态分毫不差。

#### 3. Fluid Geometry, Rigorous Parity · 形随器化，神韵合一
> *"The gale rushes through the canyon; the gentle breeze drifts over the plain. The vessels differ, the soul remains."*  
> *“西风过峡谷是疾风，掠平原为和风；器物有异，风骨如一。”*

* **[EN] Eradicating Context Fractures**: Whether seated at a triple-monitor workstation or gripping a phone single-handedly in a cold server aisle, your operational intuition must never diverge.
* **[ZH] 消除操作语境割裂**：无论是在工位的三屏工作站前，还是在刺骨机房里单手握持手机，操作直觉绝不应因设备切换而破碎。
* **[EN] Cross-Platform Contract Symmetry**: Across Desktop (Electron & local Node/SQLite core), Web (DOM terminal & WASM RDP), and Native Mobile (Kotlin/Compose & Swift/SwiftUI), keystroke round-trips, split-pane topologies, and touch semantics maintain strict contract parity.
* **[ZH] 跨平台契约严格对称**：桌面端（Electron 与本地 Node/SQLite 核心）、Web 端（DOM 终端与 WASM RDP）与移动原生端（Kotlin/Compose & Swift/SwiftUI）之间，按键往返时延、分屏拓扑状态与触控手感保持严格的契约级对称。

#### 4. Sovereign in Adversarial Transit · 穿透荒原，主权闭合
> *"Air flows through hostile wastes, only precipitating form at origin and destination."*  
> *“气流穿过充满敌意的荒原，只在起点与终点显形。”*

* **[EN] Zero Trust in the Wire**: We assume every intermediary transit hop—public gateways, corporate middleboxes, and commercial CDNs—actively inspects and terminates TLS.
* **[ZH] 假定传输管道全不可信**：我们预设所有公网网关、企业拦截网关与商业 CDN 边缘都在对明文 TLS 实施窥探和阻断。
* **[EN] End-to-End Post-Quantum Envelope**: The Zephyr Link protocol (ZSL/2) encapsulates payloads using post-quantum hybrid key exchange (ML-KEM-768 + X25519) and authenticated symmetric encryption (AES-GCM). Cryptographic keys and plaintext credentials permanently reside within local endpoints—never surrendered to upstream clouds.
* **[ZH] 载荷级抗量子端到端自持**：Zephyr Link 协议（ZSL/2）采用后量子混合密钥协商（ML-KEM-768 + X25519）与对称加密（AES-GCM）封装载荷。解密私钥与凭据物理沉降于端点本地，绝不向上游云端让渡半寸主权。

---

### The Stance · 终局立场

> **[EN] We build no brittle castles on another's cloud.**  
> We forge a sovereign, weightless, and unyielding westerly wind—carried at your side, blowing across any machine, bowing to no master.  
>
> **[ZH] 我们不为别人的云端搭建脆弱的城堡。**  
> 我们为每一个开发者，铸造一缕主权自持、轻捷无痕却坚不可摧的工程西风——随身携带，吹拂万象，永不称臣。