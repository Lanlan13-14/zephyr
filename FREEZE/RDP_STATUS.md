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

### 4.1 Go WASM runtime — 根因已定位并修复，待生产验证

**原实测错误**：`RDP WASM 引擎加载失败: Go WASM runtime did not register globalThis.Go`

- **根因**：`7978860` 只把 `worker-gpu-v2` 迁移到 `wasm_exec.mjs` named export；隔离或 Worker probe 失败后的 `gpu-v2-page` 路径仍加载 classic `wasm_exec.js` 并检查 `globalThis.Go`
- worker、probe、page fallback 现统一通过 `public/rdp-wasm-runtime.js` 显式导入 `module.Go`，生产代码不再依赖 global side effect
- Docker 最终镜像不再发布 `wasm_exec.js`；CI/镜像构建会拒绝旧错误字符串、旧 runtime 引用和 `globalThis.Go` 泄漏
- loader 现在区分 ESM import、HTTP status、WASM MIME/instantiate，并在错误中包含 pipeline 与 URL
- Go 1.26.3 工具链在 Android/PRoot 下 segfault，仍必须在 Linux/Docker 环境构建
- **状态**：代码级根因已关闭；必须在生产 HTTPS WebView 清缓存后验证 worker 与 page fallback 两条路径

### 4.2 Worker 隔离回退
- 非安全 HTTP、缺少 COOP/COEP、SAB 或 OffscreenCanvas 不可用时回退 `gpu-v2-page`
- probe 在真实 Canvas 转移前验证 Go ESM import、OffscreenCanvas 和完整 WebGL compositor
- probe 3 秒超时/错误则终止并安全回退，并记录失败 stage
- probe 后正式 Worker 若仍启动失败，会替换不可逆转移的 Canvas，再启动 page fallback
- **未验证**：Android WebView 中 module Worker/WebCodecs/COOP/COEP 的真实组合

### 4.3 本轮额外修复的 confirmed bugs
- WS→TCP bridge 在同步授权后、首个异步路由/TCP await 前挂接，避免浏览器立即发送的 X.224 首帧丢失
- X.224 在发送 Connection Request 前注册 confirm listener，关闭快速目标响应竞态
- `SURFACE_COPY` / `CACHE_TO_SURFACE` 不再被错误或陈旧 bitmap 二次覆盖
- AVC444 LC=0 同时复制并组合 main/aux I420，而不是丢弃 chroma upgrade stream
- graphics reset 清理 frame pending；decoder close reject pending；compositor destroy 释放基础 GL 对象
- Worker 启动中关闭会 settle ready promise；显式重连会重建 page pipeline 或 reload Worker 页面

### 4.4 仍需真实环境/fixture 验证的高风险项
- CredSSP 当前存在把单次 TLS `Read` 当完整 DER message 的风险，需要分片/大 target-info fixture
- ECDSA RDP 证书路径及 CredSSP pubKeyAuth 绑定需要真实证书验证
- IPv6 RDP target 的 host:port 构造与服务端解析尚未列入发布支持
- 跨 surface/跨 decoder 的 frame apply 顺序和 ACK queue depth 需要真实 RDPGFX trace
- AVC partial regions、AVC444 LC=2 非原点 rect、context loss 后 cache 重建需要 reference fixture

### 4.5 CI 与性能门禁
- GitHub Chromium headless WebGL 像素诊断仍为 continue-on-error；不能作为生产 GPU 可用证明
- ESM contract、Node、Go WASM、WASM build 保持硬门禁
- 仍缺少端到端延迟、帧率、长时内存和 Guacamole 对比基线

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
