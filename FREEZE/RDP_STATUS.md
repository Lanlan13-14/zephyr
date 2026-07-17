# Zephyr RDP WASM GPU 管线 - 现状

> 最后更新：2026-07-17（第三次修复后）
> 当前提交：`17032e0` (main)
> 部署版本：`orientation-fix-r3`
> 基线版本：v1.1.447（稳定，RDP 可用）
>
> ⚠️ 本文档 2026-07-17 早先版本中的多项"PASS/✅"结论未经真实验证
> （浏览器冒烟只断言像素数量而非像素值；Go 测试在 main 上根本无法编译）。

---

## 1. 架构方向

浏览器端 WASM RDP 协议栈 + RDPGFX Graphics Pipeline + 混合编解码器
（ClearCodec / Progressive / AVC420 / AVC444）+ WebCodecs H.264 硬解 +
WebGL2 surface compositor + Dedicated Worker + OffscreenCanvas。

当前真实 Windows 会话使用 ClearCodec（codecId 0x0008），不是 Classic Bitmap。

---

## 2. 已完成并提交到 main（commit `61a12aa`）

### 2.1 ClearCodec 规范解码器

- 纯 Go 实现：residual RLE、bands、Full/Short VBar cache、subcodec
  Raw/RLEX、glyph hit/miss/store、sequence 连续性、cache reset
- MS-RDPEGFX Example 2/3/4 官方向量逐字节匹配 FreeRDP BGRA32
- 8 个真实 Windows ClearCodec payload 与独立 Rust 实现对比：**0 像素差异**
- 跨包 cache 状态测试：glyph miss->hit、VBar miss->hit、sequence wrap

### 2.2 RDPGFX surface/cache graph

- WTS1 ClearCodec -> surface rect 写入
- SURFACE_TO_CACHE：source rect 提取、cache slot/key 存储
- CACHE_TO_SURFACE：多目标点复制
- MAP_SCALED_OUTPUT_V2：signed output 坐标

### 2.3 SVC/DVC 传输层

- 每静态通道独立分片重组（原来共用一个 buffer）
- DVC CAPS：服务器版本回复 + 无请求时主动 v3 fallback
- DVC CREATE：NUL 终止名称校验、拒绝未注册通道
- DVC DATA_FIRST/DATA：严格长度校验、溢出拒绝
- DVC DATA_FIRST_COMPRESSED/DATA_COMPRESSED：每通道独立 ZGFX history
- framed ZGFX（0xE0 单段 / 0xE1 多段）

### 2.4 AVC/WebCodecs

- H.264 profile/level 从 Annex-B SPS 动态推导（原来硬编码 Baseline）
- SPS 变化时动态重配 decoder
- AVC444 LC=1/LC=2 单流长度语义修正

### 2.5 GPU compositor

- 垂直翻转修复：staging texture 与 FBO texture V 坐标分离
- WebGL2 readPixels 四角方向门禁：PASS
- Cache 往返方向门禁：PASS

### 2.6 Worker/基础设施

- SharedArrayBuffer 不再是 Worker GPU 硬要求
- WASM cache-bust（build ID + no-store headers）
- Ready-stage 协议遥测 endpoint
- RDP proxy 双向字节/frame 计数

---

## 3. 当前真实测试状态

### 3.1 Linux XRDP

| 项目 | 状态 |
|------|------|
| 连接 | ✅ 正常 |
| 画面 | ✅ 有画面 |
| 残留 | chansrv 僵尸进程导致 16 秒会话终止 |

### 3.2 Windows RDP（当前状态：花屏，仅在特定 GPU 驱动上复现）

| 项目 | 状态 |
|------|------|
| TCP 连接 | ✅ |
| X.224 / TLS / CredSSP | ✅ |
| MCS / DVC / RDPGFX 建链 | ✅ |
| CAPS_ADVERTISE / CAPS_CONFIRM | ✅ |
| ClearCodec 解码 | ✅ 像素正确（双实现验证） |
| 画面方向 | ✅ 修复已推（见根因 1） |
| 画面内容 | ❌ Adreno 750 / ANGLE OpenGL ES 上仍花屏 |
| 画面内容 | ✅ WebKit WebGL / 桌面 Chrome 上正常 |
| AVC420/AVC444 | 未出现（Windows 当前只发 ClearCodec） |
| 稳定性 | ⚠️ 偶发 websocket-close:1006 / 对端 ECONNRESET |

**桌面 Chrome（WebKit WebGL）**和**Android Chrome（Adreno 750 / ANGLE OpenGL ES）**在
同一份代码、同一台服务器、同一个 Windows 目标上呈现不同结果：桌面正常，手机花屏。
这排除了协议层和缓存问题（build marker 已在状态栏可见，确认手机跑的是新代码）。
根因高度指向 ANGLE→OpenGL ES 翻译层对 WebGL2 特定 API 的行为差异。

已修复的根因（三个独立缺陷，修复后桌面端正常）：

1. **JS 合成器 V 坐标约定错误**（`public/rdp-renderer.js` `_drawTexture`）：
   v=0 被映射到 rect 顶边，而 Go 端发的是 bottom-up 行序。现统一为
   GL 自然约定：纹理行 0 = 图像底行；VideoFrame（top-down 源）经
   `topDownSource` 标志单独处理。FreeRDP 自己也在 GDI 路径用
   `FREERDP_FLIP_VERTICAL` 做相同转换，约定一致。
2. **ClearCodec 未写持久 surface**（`rdpgfx.go` WTS1 快速路径提前返回，
   未执行 `blitToSurface`）：SURFACE_TO_CACHE 从 surface 缓冲抓到的全
   是 0，CACHE_TO_SURFACE 把黑块/垃圾贴满屏幕。已改走正常 codec
   switch。
3. **main 分支 WASM 无法编译**（`codecClear` 常量重复声明）：已删除。

浏览器冒烟门禁原先只断言像素**数量**，对上述回归完全无感；现已改为
断言精确像素值（全屏/局部上传、cache 往返、solid fill 四个场景）。

---

## 4. 未解决问题

### 4.1 花屏（Android Adreno 750 / ANGLE OpenGL ES）—— 未解决，当前主要问题

- 桌面 Chrome（WebKit WebGL）和 Android Chrome（Adreno 750 / ANGLE OpenGL ES）
  在同一份代码、同一服务器、同一 Windows 目标上结果不同：桌面正常，手机花屏
- 已排除协议层、缓存、行序约定（FreeRDP 对照一致）
- 根因高度指向 ANGLE→OpenGL ES 翻译层差异
- 已知可疑点（Adreno 750 workarounds 清单）：
  - `blitFramebuffer` 区域裁剪（`adjustSrcDstRegionForBlitFramebuffer` 在本设备上
    未启用，但 blit 被大量用于 SURFACE_TO_CACHE 和 copySurface 实现）
  - `use_copyteximage2d_instead_of_readpixels_on_multisampled_textures` 已启用
  - `exit_on_context_lost` 已启用（GL 上下文丢失不恢复）
  - `round_down_uniform_bind_buffer_range_size` 已启用
  - `dont_invalidate_incomplete_fbos` 已启用
- **下一步**：为 Adreno 设备添加 driver-specific 规避路径（替换 blitFramebuffer
  为 render-to-texture + scissor 方案，或添加 ANGLE-specific 诊断页面）

### 4.2 其他未解决

- CredSSP 单次 Read 当完整 DER message 的风险
- ECDSA RDP 证书 + CredSSP pubKeyAuth 绑定未验证
- Android WebView 兼容性未测试
- 缺少端到端延迟/帧率/长时内存基线
- **新增**：Adreno 750 / ANGLE OpenGL ES 花屏（见 4.1）

---

## 5. 验证基线（commit `17032e0`，本次全部实跑）

### Go 测试（远程 Go 1.26 Docker）

```
plugin:          PASS（实跑）
plugin/drdynvc:  PASS（实跑）
plugin/rdpgfx:   PASS（实跑，含 WTS1 surface 写入与 cache 往返哈希测试）
```

### Node 测试

```
84/84 PASS (exit code 0，实跑)
```

### 浏览器像素级冒烟（桌面 WebKit WebGL，断言精确像素值）

```
全屏上传方向:        PASS
局部 rect 落点:      PASS
cache 往返内容与落点: PASS
solid fill 区域:     PASS
```

### 真实桌面 RDP 会话（commit `17032e0`，目检）

```
桌面 Chrome:    ✅ 壁纸/图标/任务栏/文字全部正确
Android Chrome: ❌ 花屏（Adreno 750 / ANGLE OpenGL ES）
```

### ClearCodec 双实现差分

```
Go decoder vs 独立 Rust decoder
8 个真实 Windows payload
每包像素差异: 0
总差异: 0
```

### WASM / Docker

```
GOOS=js GOARCH=wasm go build:  PASS
Docker build:                  PASS
```

---

## 6. 推进计划

### Phase 1-2：ClearCodec + Surface Graph（完成）

### Phase 3：GPU Compositor（完成）

### Phase 4：完整构建（完成）

### Phase 5：真实 Windows 出画面（部分完成）

| Item | 状态 |
|------|------|
| RDPGFX 建链 | ✅ |
| ClearCodec 解码 | ✅ |
| 画面方向 | ✅ |
| 画面内容正确（桌面 Chrome） | ✅ |
| 画面内容正确（Android Chrome） | ❌ 花屏 |
| cache command 离线差分 | ✅（trace + 最小复现已定位三个根因） |

### Phase 6：AVC420/AVC444（代码就绪，真实会话未触发）

| Item | 状态 |
|------|------|
| SPS profile 动态推导 | ✅ |
| AVC444 LC 语义 | ✅ |
| 真实 Windows AVC bitstream | ❌ Windows 当前不发 AVC |

### Phase 7：Frame ACK（代码就绪，未验证）

| Item | 状态 |
|------|------|
| PDU 字段编码 | ✅ |
| 真实时序 | ❌ |

### Phase 8：Android 兼容性（当前主要问题）

| Item | 状态 |
|------|------|
| 桌面 Chrome 验证 | ✅ |
| Android Chrome 验证 | ❌ 花屏（Adreno 750 / ANGLE OpenGL ES） |
| 根因定位 | 高度指向 ANGLE→OpenGL ES 翻译层差异 |
| 规避方案 | 待实施（替代 blitFramebuffer 或 Adreno 专用路径） |

### Phase 9：错误恢复 / 长时稳定性（未开始）
