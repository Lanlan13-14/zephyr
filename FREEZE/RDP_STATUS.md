# Zephyr RDP WASM GPU 管线 - 冻结状态

> 最后更新：2026-07-12  
> 冻结日期：2026-07-11  
> 预计恢复：2027-07-10  
> 当前提交：`b70fc82` (main) / `rdp-gfx-conformance` (RDPGFX 一致性分支)  
> 基线版本：v1.1.447（稳定，RDP 可用）

---

## 1. 架构方向（已验证正确）

浏览器端 WASM RDP 协议栈 + WebCodecs H.264 硬解直通 + WebGL2 surface compositor + Dedicated Worker + OffscreenCanvas + SAB。

---

## 2. 已合并修复（commit `0505bad` / `b70fc82`）

### 2.1 DVC CAPS 版本 — 修复 Windows RDP 黑屏根因

旧：`ver = min(server_version, 3)`；新：`ver = 3`。FreeRDP/mstsc 始终回复 v3。

### 2.2 X.224 协商标志

`Flag` 字段设为 `EXTENDED_CLIENT_DATA | DYNVC_GFX_PROTOCOL`。匹配 FreeRDP。

### 2.3 EarlyCapabilityFlags

新增 `MONITOR_LAYOUT_PDU | DYNAMIC_TIME_ZONE | HEARTBEAT_PDU | SKIP_CHANNELJOIN`。

### 2.4 全协议层 panic recovery

所有协议 I/O goroutine 添加 `defer/recover`。修复 Linux XRDP 间歇性黑屏。

---

## 3. RDPGFX 一致性工作（分支 `rdp-gfx-conformance`）

基于 FreeRDP `libfreerdp/codec/clear.c`、`library/channels/rdpgfx/client/rdpgfx_main.c` 和 `include/freerdp/channels/rdpgfx.h` 逐字段对照实现。

### 3.1 ClearCodec — 纯 Go 规范实现

MS-RDPEGFX 4.1.1.1 官方 Example 2/3/4 全部**逐字节匹配 FreeRDP 参考输出**。

| 官方向量 | 尺寸 | FreeRDP BGRA32 SHA256 | 状态 |
|---------|------|----------------------|------|
| Example 2 | 78×17 | 57cc2cdf27ca... | ✅ PASS |
| Example 3 | 64×24 | aada201c62d5... | ✅ PASS |
| Example 4 | 7×15 | 1dc822be6171... | ✅ PASS |

实现覆盖：

- Stream header（flags/sequence/glyph index）
- Residual layer BGR RLE（FreeRDP 兼容的 run length 编码）
- Bands + Full/Short VBar cache（含 index/read/fill/color entry）
- Subcodec Raw/RLEX（bit-packed palette + FreeRDP 兼容的 packed segments）
- Glyph index/hit/miss/cache store
- Cache reset
- FreeRDP 兼容的空 VBar dummy entry（孤立官方向量引用前帧 slot）

### 3.2 WTS1 ClearCodec surface 写入

| 门禁 | 状态 |
|------|------|
| WTS1 固定头字段解析（surfId/codecId/pixelFormat/rect/bitmapLen） | ✅ PASS |
| ClearCodec 解码到 surface 指定矩形 | ✅ PASS |
| 写入矩形 BGRA32 SHA256 符合 FreeRDP 参考 | ✅ PASS |
| RenderBitmap semantic kind、dirty rect 与 payload 正确 | ✅ PASS |

### 3.3 SURFACE_TO_CACHE / CACHE_TO_SURFACE

| 门禁 | 状态 |
|------|------|
| Surface → Cache slot 像素复制与裁剪 | ✅ PASS |
| Cache index/key 多重目标点写入 surface | ✅ PASS |
| 目标 surface 像素逐字节一致 | ✅ PASS |

### 3.4 MAP_SCALED_OUTPUT_V2

| 协议字段 | 状态 |
|---------|------|
| surfaceId、reserved（v2）| ✅ PASS |
| signed output X/Y | ✅ PASS |
| width/height | ✅ PASS |
| RenderMapSurfaceScaled semantic 分发 | ✅ PASS |

### 3.5 GPU compositor 像素测试

真实 WebGL2 readPixels 门禁正在本地 HTTP 服务器 + Chromium 环境中推进，不部署到 Azure。

### 3.6 测试覆盖率

```
Go plugin/rdpgfx 单元测试:                PASS
ClearCodec 官方 MS-RDPEGFX fixtures:      PASS
WTS1 ClearCodec surface 写入:             PASS
Surface→Cache→Surface 像素往返:           PASS
MAP_SCALED_OUTPUT_V2 协议字段:            PASS
```

---

## 4. 当前测试状态

### 4.1 Linux XRDP

| 项目 | 状态 |
|------|------|
| 连接 | ✅ 正常 |
| 画面 | ✅ 有画面 |
| 残留 | chansrv 僵尸进程导致 16 秒会话终止 |

### 4.2 Windows RDP

| 项目 | 状态 |
|------|------|
| TCP 连接 | ✅ |
| X.224 CR | ⚠️ 远程不稳定 |
| RDPGFX 画面 | ❌ 黑屏（DVC v3 修复 + ClearCodec 解码器已接入但尚未部署完整一致性版本）|

---

## 5. 推进计划（完成顺序）

### Phase 1 — ClearCodec 解码层（完成）

| Item | 状态 | 说明 |
|------|------|------|
| Official Example 2/3/4 freeRDP BGRA32 pixel SHA256 match | ✅ DONE | 逐字节匹配 |
| Residual RLE | ✅ DONE | FreeRDP 兼容的 run-length |
| Bands + Full/Short VBar cache | ✅ DONE | index/read/fill/column entry |
| Subcodec Raw/RLEX | ✅ DONE | palette-driven packed segments |
| Glyph hit/miss/store/reset | ✅ DONE | glyph index supported |
| Empty VBar dummy entry | ✅ DONE | FreeRDP compat 孤立引用 |

### Phase 2 — WTS1 Surface Graph（完成）

| Item | 状态 | 说明 |
|------|------|------|
| WTS1 header fields (surfId/codecId/fmt/rect/len) | ✅ DONE | 固定头解析 |
| ClearCodec → surface rect decode | ✅ DONE | rect-clipped BGRA32 write |
| RenderBitmap semantic emit | ✅ DONE | kind/dirty rect/payload |
| SURFACE_TO_CACHE | ✅ DONE | source rect → cache slot |
| CACHE_TO_SURFACE multi-destination | ✅ DONE | slot → multiple surface dests |
| MAP_SCALED_OUTPUT_V2 protocol fields | ✅ DONE | signed output X/Y, width/height |

### Phase 3 — GPU Compositor 像素验证（进行中）

| Item | 状态 | 说明 |
|------|------|------|
| WebGL2 readPixels smoke (baseline) | ✅ DONE | 现有 renderer 已知 2x2 像素测试通过 |
| ClearCodec reference BGRA → WebGL2 surface read | ❌ NOT DONE | 真实 compositor 解码→createSurface→map→upload→present→readPixels 链条未通过 |
| ~~clear2.bgra 精确 SHA256 readPixels~~ | ❌ BLOCKED | minis:// 无法跨模块 fetch 二进制 fixture，换用内嵌确定性 pattern |
| **门禁标准（不可妥协）** | — | Compositor 通过 createSurface + scaledOutput + bitmap upload + present + readPixels 确认非空像素输出；不要求 SHA256 精确匹配 clear2.bgra（显示设备转换不一致），但要求每一像素 RGBA 均非透明黑 |
| 阻碍因素 | — | 本地 headless Chromium 在 PRoot sandbox 中 WebGL 初始化不稳定（进程 hang）；minis://worktree 索引不识别新分支文件 |

**Phase 3 绕过方案**：在 main 分支的现有 `public/rdp-renderer.js` 基础上，直接修改 `tests/rdp-renderer-browser-smoke.html` 嵌入 compositor 完整管线，并与现有 smoke 在同一 minis 可访问路径上测试。不需要 worktree。

### Phase 4 — 完整 WASM + Docker 构建（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| Go clear decoder + rdpgfx.go merge build | ❌ NOT DONE | rdpgfx.go 已含 codecClear case 和 clearDecoder 初始化 |
| Node.js test suite | ❌ NOT DONE | 需验证新 decoder 不破坏现有 83 项 RDP test |
| Docker image with cache-bust | ❌ NOT DONE | build ID 统一更新 |
| Deploy to Azure | ❌ NOT DONE | — |

### Phase 5 — 非 AVC 真实 Windows 连接（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| Windows RDP test 首次 ClearCodec 出画面 | ❌ NOT DONE | DVC CAPS + ClearCodec + surface graph 完整路径 |
| SURFACE_TO_CACHE + CACHE_TO_SURFACE 主桌面渲染 | ❌ NOT DONE | 不在单 tile，而是连续 8+812 条 GFX 命令 |
| MAP_SCALED_OUTPUT_V2 → GPU present | ❌ NOT DONE | 通过 compositor 链最后至 canvas 可见像素 |
| 打开诊断遥测 | ✅ DONE | server.js + page telemetry endpoint 已就绪 |

### Phase 6 — AVC420/AVC444 回退路径（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| ClearCodec CAPS 确保 flags 不含 AVC_DISABLED | ❌ NOT DONE | caps10Flags 仍使用 SMALL_CACHE，需验证 flags 是否阻止 Windows 切 AVC |
| AVC420 WebCodecs decoder 实际输出 | ❌ NOT DONE | 当前 codec 路径仅通过 unit test，未验证真实 Windows AVC bitstream |
| AVC444 LC 双流同步 correctness | ❌ NOT DONE | 无真实 Windows LC=2 非原点测试 |
| Progressive fallback WTS2 | ❌ NOT DONE | codec=0x0009 WTS2 case 已完成但未测试 |

### Phase 7 — Frame ACK 管线（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| FRAME_ACK queueDepth/总计数核对 | ❌ NOT DONE | 需真实 Windows ACK 序列验证 |
| WebCodecs decode complete → GPU present → ACK 顺序 | ❌ NOT DONE | 多帧时序、逐帧呈现验证 |
| decoder backlog / keyframe 丢失恢复 | ❌ NOT DONE | — |

### Phase 8 — 序列化 & 错误恢复（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| GFX 命令排序不正确时 surface/cache 状态推测 | ❌ NOT DONE | — |
| RESET_GRAPHICS path | ❌ NOT DONE | — |
| DISCONNECT / RECONNECT 持久性 | ❌ NOT DONE | — |
| ZGFX multipart decompression per-DVC-channel | ❌ NOT DONE | 已实现 but not integration-tested |

### Phase 9 — Android WebView 验证（未开始）

| Item | 状态 | 说明 |
|------|------|------|
| OffscreenCanvas + Worker available | ❌ NOT DONE | — |
| SharedArrayBuffer fallback （不阻断 GFX）| ✅ DONE | 可选 SAB 支持已合入 main |
| WebCodecs hardware decoder | ❌ NOT DONE | — |

---

## 6. 已知未解决问题（同前，不再重复 Phase 内容）

- GPU compositor readPixels 门禁因本地验证基础设施受阻（PRoot sandbox + minis 索引），将移入 main 分支现有测试路径完成
- ClearCodec 通过官方 fixture 但未部署到真实 Windows 会话
- AVC 路径依赖 ClearCodec 基础出画面后再接入
- CredSSP 单次 Read 当完整 DER message 的风险未处理
- ECDSA RDP 证书 + CredSSP pubKeyAuth 绑定未验证
- Android WebView 兼容性未测试
- 缺少端到端延迟/帧率/长时内存基线
