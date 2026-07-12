# Zephyr RDP WASM GPU 管线 - 冻结状态

> 冻结日期：2026-07-11  
> 预计恢复：2027-07-10  
> 基线版本：v1.1.447（稳定，RDP 可用）  
> 实验代码：main 分支 commit `eae6a58` 起

---

## 1. 架构方向（已验证正确）

浏览器端 WASM RDP 协议栈 + WebCodecs H.264 硬解直通 + WebGL2 surface compositor + Dedicated Worker + OffscreenCanvas + SAB。

**这是浏览器端 RDP 的天花板路线，不是 Guacamole 服务端渲染路线。** 方向正确，不怀疑。

---

## 2. 已完成的工作

### 2.1 已推 main 并通过 CI 的提交

| Commit | 内容 | CI |
|--------|------|----|
| `1f91308` | feat(rdp): move rendering to worker GPU pipeline | ✅ |
| `cc12dc5` | fix(ci): run Go WASM tests with clean environment | ✅ |
| `283a9ca` | fix(rdp): fall back when worker isolation is unavailable | ✅ |
| `ea33dec` | fix(rdp): load Go runtime in module worker | ✅ |
| `ac4f9a9` | fix(ci): verify Go worker runtime deterministically | ✅ |
| `7978860` | fix(rdp): bundle Go runtime as worker ESM | ✅ |
| `15448f4` | fix(ci): stabilize WebGL browser smoke | ✅ |
| `eae6a58` | ci: isolate flaky headless GPU diagnostic | ✅ |

### 2.2 已实现的协议与功能

- WS↔TCP 双向背压
- WASM 可靠接收队列（不静默丢字节）
- RDPGFX frame tracker / semantic / END_FRAME 单次 present / FRAME_ACK
- SURFACE_TO_CACHE 协议实现 + GPU cache graph
- WebGL2 surface/FBO/cache compositor
- AVC420/AVC444 双流 WebCodecs 解码路径
- 页面/Worker 双管线（`worker-gpu-v2` 默认，失败回退 `gpu-v2-page`）
- 输入 envelope（Worker 有序输入）
- SAB RPC 通信
- WASM linear-memory view 上传
- RDPEFS FILE_NETWORK_OPEN_INFORMATION Reserved 修正
- UTF16 emoji 与 NTLM fixture 测试修正
- SQLite migration：`rdpPipeline` 列，默认 `worker-gpu-v2`
- credentials 和 iframe 贯通
- Go WASM runtime 转为真正 ESM（`wasm_exec.mjs`，`export class Go`）

### 2.3 测试状态（冻结时）

- 59/59 Node 测试通过
- 27 JS 语法检查通过
- Go 1.26 WASM 主模块编译通过
- rdpgfx/cliprdr/nla 编译通过
- WebGL2 像素冒烟通过
- SQLite migration 通过
- Docker 镜像构建成功（`sha256:a6c45a4...d533917`，451,696,399 bytes）
- CI run `29155904571` success

### 2.4 已删除的 legacy 代码

- 页面 Canvas2D 渲染
- 旧单纹理 WebGL
- raw-H264 WebCodecs 直接回调
- `rdpDrawBitmapBGRA` / `rdpOnH264`
- classic bitmap 改为 `RenderClassicBitmap` semantic
- UI 删除 legacy pipeline 选项

---

## 3. 未完成的发布门禁

以下三项是冻结时**未通过**的，恢复后优先处理：

### 3.1 真实 Windows RDP 连接测试 [CRITICAL]
- 需要真实 Windows 主机（3389）进行端到端验证
- 测试目标（如有）：见 memory 中的 RDP 连接信息
- 预期问题：协议握手、NLA/CredSSP、实际画面渲染

### 3.2 Android WebView 验证 [CRITICAL]
- OffscreenCanvas + Worker 在 Android WebView 中的兼容性
- COOP/COEP 隔离在 WebView 中的行为
- WebCodecs 在 WebView 中的可用性

### 3.3 长时压力测试 [HIGH]
- 内存泄漏检测
- 连接稳定性（断线重连）
- 大量 RDPGFX surface 创建/销毁

---

## 4. 已知未解决问题清单

### 4.1 Go WASM runtime — 实测首个阻塞 bug

**实测错误**：`RDP WASM 引擎加载失败: Go WASM runtime did not register globalThis.Go`

- 已尝试的修复：`scripts/build-go-wasm-esm.mjs` 将 Go SDK runtime 转为 ESM `export class Go`，取消 `globalThis.Go` 依赖
- **该修复在生产 HTTPS WebView 中仍失败**：module Worker 依赖 global side-effect 注册不可靠
- Go 1.26.3 工具链在 Android/PRoot 下 segfault，必须在 Linux/Docker 环境构建
- 如果 Go SDK 升级，`wasm_exec.mjs` 转换脚本可能需要同步更新
- **恢复后第一个要解决的问题就是这个**，不解决它 RDP 无法启动

### 4.2 Worker 隔离回退
- 非安全 HTTP、缺少 COOP/COEP、SAB 或 OffscreenCanvas 不可用时回退 `gpu-v2-page`
- 回退逻辑已在真实 Canvas 转移前启动一次性 Worker probe
- probe 3 秒超时/错误则终止并安全回退
- **未验证**：某些 WebView 环境可能 probe 通过但实际渲染失败

### 4.3 AVC444 双流
- LC（Lossless Codec）模式实现完整性需验证
- 双流 surface/frame 语义需真实 Windows RDP 验证
- 软件 reference 解码器质量门禁未设

### 4.4 CI 稳定性
- GitHub Chromium headless WebGL 像素诊断多次超时，已改为 continue-on-error
- 确定性 ESM、Node、Go WASM、WASM build 保持硬门禁

### 4.5 性能基线缺失
- 没有端到端延迟测量
- 没有帧率基线
- 没有与 Guacamole 方案的对比数据

---

## 5. 恢复路线图

### Phase 1：环境验证（1-2 天）
1. 在 Linux/Docker 环境重新构建 Go WASM
2. 确认 59/59 测试仍绿
3. 确认 Docker 镜像构建成功

### Phase 2：真实连接测试（3-5 天）
1. 准备 Windows 测试主机
2. 端到端 RDP 连接验证
3. 逐个验证：握手 → NLA → bitmap → RDPGFX → AVC420 → AVC444
4. 修复发现的问题

### Phase 3：Android WebView（3-5 天）
1. 在 Android 设备上测试
2. 验证 Worker probe 回退逻辑
3. 验证 WebCodecs 可用性

### Phase 4：性能与质量（2-3 天）
1. 建立延迟/帧率基线
2. 长时压力测试
3. 内存泄漏检测

### Phase 5：发布
1. 发布新版本
2. 更新文档
