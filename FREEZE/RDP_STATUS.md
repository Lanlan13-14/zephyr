# Zephyr RDP WASM GPU 管线 - 冻结状态

> 最后更新：2026-07-12  
> 冻结日期：2026-07-11  
> 预计恢复：2027-07-10  
> 当前提交：`0505bad` (main)  
> 基线版本：v1.1.447（稳定，RDP 可用）

---

## 1. 架构方向（已验证正确）

浏览器端 WASM RDP 协议栈 + WebCodecs H.264 硬解直通 + WebGL2 surface compositor + Dedicated Worker + OffscreenCanvas + SAB。

**这是浏览器端 RDP 的天花板路线，不是 Guacamole 服务端渲染路线。** 方向正确。

---

## 2. 冻结后追加修复（2026-07-12，commit `0505bad`）

### 2.1 DVC CAPS 版本协商 — 修复 Windows RDP 黑屏根因 (`drdynvc/dvc.go`)

- **旧逻辑**：`ver = min(server_version, 3)` — 服务器提供 v2 时回复 v2
- **新逻辑**：`ver = 3` — 始终回复 DVC v3
- **对照 FreeRDP**：`dvcman_recv_capability_request()` 始终发送 v3
- **根因**：Windows RDP 服务器在客户端协商 DVC v2 时不会创建 `Microsoft::Windows::RDS::Graphics` DVC 通道 → 无 RDPGFX → 无 EGFX 图形命令 → 黑屏
- **状态**：已部署 Azure 测试环境，待端到端验证

### 2.2 X.224 协商标志 (`x224/x224.go`)

- RDP Negotiation Request 的 `Flag` 字段从 `0` 改为 `EXTENDED_CLIENT_DATA (0x01) | DYNVC_GFX_PROTOCOL (0x02)`
- 匹配 FreeRDP/mstsc 行为：告知服务器客户端支持 DYNVC GFX 协议

### 2.3 EarlyCapabilityFlags (`gcc/gcc.go`)

- 新增标志位匹配 FreeRDP：`MONITOR_LAYOUT_PDU | DYNAMIC_TIME_ZONE | HEARTBEAT_PDU | SKIP_CHANNELJOIN`
- 提升 Windows 10/11 兼容性

### 2.4 全协议层 panic recovery（`tpkt.go`, `pdu.go`, `mcs.go`, `sec.go`, `render_bridge.go`, `main.go`）

- 所有协议 I/O 协程添加 `defer/recover`：TPKT readLoop、PDU RecvFastPath、PDU recvPDU、MCS recvData、sec RecvFastPath、forwardRenderEvent、forwardClassicBitmaps
- **修复 Linux XRDP 间歇性黑屏**：此前协议解析 panic 静默杀死 TPKT readLoop 协程，后续所有数据被丢弃

---

## 3. 当前测试状态

### 3.1 Linux XRDP (`danielguerra/ubuntu-xrdp:20.04`)

| 项目 | 状态 |
|------|------|
| 连接 | ✅ 正常 |
| NLA/CredSSP | N/A（security_layer=tls） |
| 画面 | ✅ 有画面（panic recovery 修复了间歇性黑屏） |
| 已知残留问题 | XRDP chansrv 僵尸进程导致 session 16秒后被拆；需镜像侧修复 |

### 3.2 Windows RDP (`82.152.163.53:3389`)

| 项目 | 状态 |
|------|------|
| TCP 连接 | ✅ |
| X.224 CR 响应 | ⚠️ 远程服务器不稳定（直接 TCP 测试偶尔超时） |
| DVC CAPS（v3 fix） | ⚠️ 待验证 |
| RDPGFX 画面 | ❌ 黑屏（冻结前状态） |
| **最新** (dvc-v3-fix) | ⚠️ 卡在"连接中"，尚未拿到画面 — 待深入调试 |

### 3.3 单元测试

```
59/59 Node 测试通过
27 JS 语法检查通过
Go 1.26 WASM 主模块编译通过
Docker 镜像构建成功
```
> 注：本地无法运行 Go 测试（PRoot/Android Go 1.26.3 工具链 segfault），单元测试仅在 Docker CI 环境有效。

---

## 4. 已知未解决问题

### 4.1 Windows RDP 黑屏（冻结前遗留，部分修复）

- **现象**：`pdu.ready=1`、`pdu.pointer.update=2`、`semanticEvents=0`、`mcs.drdynvc.data=1`
- **部分修复**：DVC v3 强制响应 + X.224 协商标志 + EarlyCapabilityFlags
- **未验证**：修复是否解决根本问题。当前部署 `dvc-v3-fix` 镜像表现为"连接中"不结束，可能是 X.224 协商标志变化导致，需回滚测试
- **下一步**：1) 回滚 X.224 flags 变化单独测试 DVC v3 效果；2) 确认真实 Windows 服务器 RDP 服务正常；3) 抓包对比 xfreerdp 与 Go WASM 的协议差异

### 4.2 Go WASM runtime ESM

- 原错误 `Go WASM runtime did not register globalThis.Go` — 根因已定位并修复
- Worker、probe、page fallback 统一通过 `rdp-wasm-runtime.js` 显式导入 `module.Go`
- Docker 最终镜像不发布 `wasm_exec.js`
- Go 1.26.3 工具链在 Android/PRoot 下 segfault，必须在 Linux/Docker 构建

### 4.3 Android WebView 验证

- OffscreenCanvas + Worker + COOP/COEP + WebCodecs 在 Android WebView 中未测试

### 4.4 仍需真实环境验证的高风险项

- CredSSP：单次 `Read` 当完整 DER message 的风险（需分片 fixture）
- ECDSA RDP 证书 + CredSSP pubKeyAuth 绑定
- IPv6 RDP target host:port 构造
- 跨 surface/跨 decoder 的 frame apply 顺序和 ACK queue depth
- AVC partial regions、AVC444 LC=2 非原点 rect
- Real Windows RDPGFX trace 验证

---

## 5. CI 状态

- GitHub Chromium headless WebGL 像素诊断：continue-on-error（不可靠）
- ESM contract、Node、Go WASM、WASM build：硬门禁
- 缺少：端到端延迟/帧率/长时内存基线、Guacamole 对比

---

## 6. 恢复路线图（不变）

| Phase | 内容 | 预估 |
|-------|------|------|
| 1 | 环境验证 — 重新构建 Go WASM，确认测试全绿 | 1-2天 |
| 2 | 真实 Windows RDP 连接测试 — 逐个验证握手→NLA→bitmap→RDPGFX→AVC | 3-5天 |
| 3 | Android WebView 验证 | 3-5天 |
| 4 | 性能与质量基线 | 2-3天 |
| 5 | 发布新版本 | 1天 |
