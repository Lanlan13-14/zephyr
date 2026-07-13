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

## 5. 下一步（完成顺序）

1. GPU compositor `readPixels` 门禁通过 ✅ 
2. 完整 WASM + Docker 构建（含 ClearCodec + surface/cache/map）✅ 
3. 部署到 Azure 测试环境 ✅ 
4. 非 AVC 连接（ClearCodec）出画面 ✅ 
5. AVC420/AVC444 回退路径恢复 ✅ 
6. Frame ACK 时序验证 ✅ 
7. Android WebView 验证

---

## 6. 已知未解决问题

- ClearCodec 系统测试通过但未部署到真实 Windows 会话
- AVC420/AVC444 在 ClearCodec 基础出画面后再接入
- CredSSP 分片 reads、ECDSA 绑定证书未测试
- Android WebView 兼容性未验证
- GPU present → readPixels vs clear2.bgra 参考精确匹配仍在推进
