# Zephyr RDP WASM GPU 管线 - 现状

> 最后更新：2026-07-17
> 当前提交：`61a12aa` (main)
> 基线版本：v1.1.447（稳定，RDP 可用）

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

### 3.2 Windows RDP

| 项目 | 状态 |
|------|------|
| TCP 连接 | ✅ |
| X.224 / TLS / CredSSP | ✅ |
| MCS / DVC / RDPGFX 建链 | ✅ |
| CAPS_ADVERTISE / CAPS_CONFIRM | ✅ |
| ClearCodec 解码 | ✅ 像素正确（双实现验证） |
| 画面方向 | ✅ 已修复（不再是 180° 翻转） |
| 画面内容 | ❌ 仍有重复小图块和阶梯错位 |
| AVC420/AVC444 | 未出现（Windows 当前只发 ClearCodec） |

---

## 4. 未解决问题

### 4.1 重复小图块和阶梯错位（当前主要问题）

- ClearCodec 解码器本身已排除：8 个真实 payload 与独立 Rust 实现逐像素一致
- cache PDU 字段布局与 FreeRDP 一致
- GPU 方向已修复
- **剩余怀疑方向**：
  - SURFACE_TO_CACHE 的 source rect 像素在 GPU compositor 中读取时机
  - CACHE_TO_SURFACE 的目标点在 Go emit 和 JS handleEvent 之间的映射
  - Go surface `data` 与 Worker GPU surface 的像素同步
  - cache entry 在 JS renderer 中的 texture 复用与覆盖时序
- **下一步**：离线重放捕获的真实 cache command 序列（surfaceId / sourceRect /
  cacheSlot / cacheKey / destPoints），逐命令比较 Go surface graph 与 JS GPU
  compositor 的像素状态，定位第一个产生分歧的命令

### 4.2 其他未解决

- CredSSP 单次 Read 当完整 DER message 的风险
- ECDSA RDP 证书 + CredSSP pubKeyAuth 绑定未验证
- Android WebView 兼容性未测试
- 缺少端到端延迟/帧率/长时内存基线

---

## 5. 验证基线

### Go 测试（远程 Go 1.26 Docker）

```
plugin:          PASS
plugin/drdynvc:  PASS
plugin/rdpgfx:   PASS
```

### Node 测试

```
83/83 PASS (exit code 0)
```

### ClearCodec 双实现差分

```
Go decoder vs 独立 Rust decoder
8 个真实 Windows payload
每包像素差异: 0
总差异: 0
```

### GPU 门禁

```
四角方向 readPixels:     PASS
Cache 往返方向 readPixels: PASS
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
| 画面内容正确 | ❌ 重复图块 |
| cache command 离线差分 | ❌ 下一步 |

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

### Phase 8-9：错误恢复 / Android（未开始）
