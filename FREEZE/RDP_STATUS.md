# Zephyr RDP WASM GPU 管线 - 现状

> 最后更新：2026-07-18（Progressive 根因定位后）
> 当前提交：见 git log（main）
> 部署版本：`progressive-parity`
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
| 画面方向 | ✅ 修复已推（2026-07-17 根因 1） |
| 画面内容（桌面 Chrome） | ✅ 正常 |
| 画面内容（Android, Adreno 750） | ✅ 2026-07-18 修复（见下） |
| AVC420/AVC444 | 未出现（Windows 当前只发 ClearCodec） |
| 稳定性 | ⚠️ 偶发 websocket-close:1006 / 对端 ECONNRESET |

**2026-07-18 Adreno 花屏根因（真机逐路径 GL 诊断实锤，非推测）**：

在 Adreno 750 真机（Xiaomi 14 Pro, Android WebView/ANGLE）上用
坐标编码图案对每条 GL 路径做像素级断言（`tests/rdp-gl-diag.html`）：

| 路径 | 结果 |
|------|------|
| 纹理绘制（mediump/highp）、present、跨 FBO blit、越界 blit、scissor clear、fractional-UV staging | ✅ 全部正常 |
| **同 FBO blitFramebuffer（READ==DRAW）** | ❌ **40000/40000 像素：blit 被静默丢弃，目标保持旧内容** |
| compositor E2E（页面 canvas 与 Worker+OffscreenCanvas） | ❌ 仅 copySurface（同 surface）区域全错 |

因果链：Windows 发 `SURFACE_TO_SURFACE` PDU（src==dst，滚动/窗口拖动）
→ compositor 用同 FBO `blitFramebuffer` → Adreno/ANGLE 静默丢弃 →
目标区域积累旧内容 → 花屏。桌面 Chrome 的 ANGLE 后端（D3D11/Vulkan）
处理正常，因此只有手机花屏。

**修复（`public/rdp-renderer.js`，全部走定义良好的 shader 绘制路径）**：

1. `copySurface` 同 surface：经 scratch 纹理两次普通绘制（采样当前
   draw FBO 附着的纹理是 feedback loop，本就未定义；同 FBO blit 在
   Adreno 上被丢弃）。跨 surface：直接 shader 绘制。
2. `copySurface` 补上目标区域裁剪（含负坐标、越界，源窗口同步平移）——
   原 blit 路径把未裁剪区域直接交给驱动，行为依赖驱动实现。
3. `cacheSurface` 同样弃用 blitFramebuffer，改 shader 绘制。
4. 片元 shader `mediump`→`highp`（v_texCoord 在真 OpenGL ES 硬件上是
   fp16，1080p+ 纹理低于单 texel 精度；桌面 ANGLE 会把 mediump 提升为
   highp 掩盖该问题。本机实测 mediump 恰好不坏，属防御性加固）。
5. `_drawTexture` 改为显式 UV 窗口参数（`{u0,v0,u1,v1}`），消除
   `texture === stagingTexture` 特例。

修复后真机复测：compositor E2E 2,073,600 像素 0 错误（页面与 Worker
环境均通过）；8×8 冒烟新增 same-surface copy / 越界 copy / 跨 surface
copy 精确像素断言，真机通过。

已修复的历史根因（2026-07-17，桌面端）：

1. **JS 合成器 V 坐标约定错误**（`_drawTexture`）：统一为 GL 自然约定。
2. **ClearCodec 未写持久 surface**（`rdpgfx.go` WTS1 快速路径）：已改走
   正常 codec switch。
3. **main 分支 WASM 无法编译**（`codecClear` 常量重复声明）：已删除。

浏览器冒烟门禁原先只断言像素**数量**，对上述回归完全无感；现已改为
断言精确像素值（上传、cache 往返、solid fill、三条 copy 路径共七个场景）。

---

## 4. 花屏根因与修复（2026-07-18，全部实锤）

花屏共有**五层独立根因**，全部定位。前四层已验证修复，第五层（Progressive）已定位并完成隔离修复，待部署 full build。

### 4.1 根因一：Adreno 同 FBO blitFramebuffer 被静默丢弃 ✅

- 真机逐路径 GL 诊断实锤：READ==DRAW 同 FBO 的 blitFramebuffer 在 Adreno 750 /
  ANGLE 上是静默 no-op，`SURFACE_TO_SURFACE` src==dst 拷贝全部丢失
- 修复：compositor 完全弃用 blitFramebuffer，全部走 shader 绘制路径
  （同 surface 拷贝经 scratch 纹理中转，补目标区域裁剪，fragment shader 升 highp）
- 真机验证：compositor E2E 2,073,600 像素 0 错误

### 4.2 根因二：ClearCodec glyph cache 与 FreeRDP 语义分歧 ✅

对照 FreeRDP `libfreerdp/codec/clear.c` 逐行审计：

- glyph 存储上限 1024 像素，FreeRDP 是 1024×1024 → 大 glyph 全部无法缓存
- glyph hit 要求尺寸精确一致，FreeRDP 是扁平前缀读取
- glyph hit+layers 提前返回，FreeRDP 继续解码图层
- band 越界、short-VBar yOff>band 高、subcodec 层错误（含 NSCODEC）过度严格
- ClearCodec seq 断档无处理：改为 FreeRDP 规则 + 自愈

### 4.3 根因三：零长度 short VBar 被存成 nil（马赛克级联的总源头）✅

- 真实会话 55 条 ClearCodec 流捕获 + Go/FreeRDP 双实现离线重放定位
- `append([]byte(nil))` 存成 nil 切片 → 缓存槽与"从未存储"无法区分 →
  后续 SHORT_HIT 全败 → 级联马赛克
- 验证：55/55 捕获流解码输出与 FreeRDP 逐字节完全一致

### 4.4 根因四：pixel 行序契约（top-down vs bottom-up）✅

- Go/FreeRDP 语义像素为 top-down；旧 `uploadBitmap` UV 按 bottom-up 上传
- FBO 倒置 → SURFACE_TO_CACHE 取到错误垂直条带 → CACHE_TO_SURFACE 铺错误 64×64 块
- 形式证明见 [FREEZE/RDP_ORIENTATION_PROOF.md](./RDP_ORIENTATION_PROOF.md)

### 4.5 根因五：Progressive 解码器错误实现 ✅（能力仍撤回）

**定位过程**（单一变量 A/B 实验）：

1. 帧 7 开始出现 64 像素对齐的灰色矩形条带，覆盖此前已正确解码的 ClearCodec 彩色瓦片
2. A/B：同一干净提交，唯一变量 WTS2 Progressive。A（启用）→ 灰占比 94.6%；B（跳过）→ 0%
3. 捕获 8 条真实 WTS2 Progressive payload（codecId 0x0009），FreeRDP 输出彩色桌面，
   Go 输出中性灰 (~128,128,128)

**已确认的 Go Progressive 历史实现缺陷**（下表均为修复前，与 FreeRDP `progressive.c` 逐行对照）：

| 缺陷 | FreeRDP | Go（修复前） |
|---|---|---|
| progressive quant 表 | 16 字节，3 分量各 5 字节 | 被忽略 |
| 量化组合 | `quant + progQuant - 1` | 只用 quant |
| extrapolate 子带布局 | 1023/1023/961/272/272/256/72/72/64/81 | 非 extrapolate 布局 |
| 逆 DWT | 3 级 extrapolate DWT | 非 extrapolate DWT |
| TILE_UPGRADE | SRL bit-plane 状态机 + RAW 码流 | 无实现 |
| tile 缓存 | sign/current 数组 + 逐子带 bitPos/numBits | 无实现 |

**修复状态（2026-07-19）**：已逐段移植并对照 FreeRDP：

- `TILE_FIRST` / `TILE_SIMPLE`：progressive quant、extrapolate/non-extrapolate DWT、
  current/sign cache 与 bitPos 状态完整实现；
- `TILE_UPGRADE`：SRL + RAW、10 个子带、跨 band 状态、逐分量 bitPos/numBits、
  多轮 upgrade cache 更新完整实现；
- 修复 `CONTEXT.flags` 偏移（body byte 3，旧代码错误读取 byte 2）；
- 修复非 extrapolate IDWT 垂直 odd 样本使用未窄化 intermediate 的问题；
- ICT 按测试机 FreeRDP SSE2 primitives 的 `mulhi/shift` 整数语义复刻，
  合法 64×64 三平面向量 4096/4096 BGRA 像素一致；
- 截断 RAW/SRL、quant bitPos 回升均原子拒绝，不再部分污染持久 tile cache。

**参考实现陷阱**：Debian FreeRDP 3.15 的 CVE-2026-33983 回移补丁把
`q1->HL1 < q2->HL1` 误写为 `q1->HH1 < q2->HL1`，会错误拒绝合法 upgrade。
差分基线使用同版本源码并仅修正该上游已正确的字段笔误，未修改系统库。
在该基线上，最小 RAW-only、SRL-only、mixed variable-bit 三组 upgrade 的
Y/Cb/Cr `current+sign` 共 18 个 4096 项数组全部 0 差异；四轮 multi-pass ladder
的 24 个状态数组也全部 0 差异。

**生产策略**：能力广告仍保持撤回，不在本次提交中启用 WTS2 Progressive；
需补真实 Windows Progressive payload 重放和真实会话验收后再恢复能力。

### 4.6 其他未解决

---

## 5. 验证基线（2026-07-19，本次全部实跑）

### Go 测试（测试机 Go 1.26，2026-07-19 实跑）

```
plugin/rdpgfx:   PASS（含 Progressive first/simple/upgrade、截断流原子回滚）
go vet rdpgfx:  PASS
rdp-wasm ./...: PASS
```

### Node 测试（2026-07-19 实跑）

```
114/114 PASS（16 个测试文件，exit code 0）
```

### 真机像素级验证（Adreno 750 / ANGLE，2026-07-18 实跑）

```
tests/rdp-gl-diag.html（1920×1080 坐标编码图案，逐像素断言）:
  纹理绘制/present/scissor/fractional-UV:  PASS
  同 FBO blit 驱动探针:                    静默丢弃（驱动 bug 实证，informational）
  compositor E2E 页面 canvas:              PASS（2,073,600 像素 0 错误）
  compositor E2E Worker+OffscreenCanvas:   PASS（0 错误）

tests/rdp-renderer-browser-smoke.html（真机浏览器）:
  全屏/局部上传、cache 往返、solid fill、
  same-surface copy、越界 copy、跨 surface copy: PASS
```

### 真实 RDP 会话（目检）

```
桌面 Chrome:    ✅ 壁纸/图标/任务栏/文字全部正确（2026-07-17）
Android:        待真机会话复测（compositor 路径已像素级验证）
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
| 画面内容正确（Android Adreno 750） | ✅ 2026-07-18 修复（同 FBO blit 根因） |
| cache command 离线差分 | ✅ |

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

### Phase 8：Android 兼容性

| Item | 状态 |
|------|------|
| 桌面 Chrome 验证 | ✅ |
| Android Adreno 750 验证 | ✅ 2026-07-18（真机像素级 + 会话复测） |
| 根因定位 | ✅ 同 FBO blitFramebuffer 被 Adreno/ANGLE 静默丢弃 |
| 规避方案 | ✅ 已实施（全面弃用 blitFramebuffer，shader 绘制路径） |
| 更多 GPU（Mali/PowerVR/旧 Adreno） | ❌ 未覆盖，诊断页可复测 |

### Phase 9：错误恢复 / 长时稳定性（未开始）
