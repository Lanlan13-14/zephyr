# RDP 像素行序契约 — 形式证明（2026-07-18）

> 目的：在不依赖“再部署一次看截图”的情况下，用规范 / FreeRDP / 本仓库源码
> 三方对照，证明当前花屏的充分原因，并给出唯一正确的修复方向。

## 0. 结论（先给）

| 层 | 真实约定 | 证据 |
|---|---|---|
| FreeRDP ClearCodec 输出 | **top-down**（row0 = 图像顶） | `clear.c` residual 顺序写 TempBuffer；bands 写 `pDstData[(nYDstRel+y)*stride+…]`，y 从 0 递增 |
| FreeRDP GDI surface | **top-down** | `surface->data[y * scanline]`，y 为协议 top |
| FreeRDP SurfaceToCache | **无 flip** 从 surface 顶向下拷 | `freerdp_image_copy_no_overlap(..., FREERDP_FLIP_NONE)` |
| 本仓库 Go ClearCodec | **top-down** | `out[pixel*4]` pixel 从 0 递增；bands `dst=((ys+row)*width+x)*4` |
| 本仓库 Go surface 缓冲 | **top-down** | `blitToSurface`: `dstOff = (y+row)*stride + x*4`，y=协议 top |
| 本仓库 Go classic bitmap | **强制翻成 top-down** | `grdp.go`：“Uncompressed bitmaps are bottom-up; flip to top-down” |
| 本仓库 Go RFX | **top-down** | `rfx.go` 注释：“top-down BGRA pixel buffer” |
| 本仓库 JS `uploadBitmap` | **按 bottom-up 采样** | UV `{v0:0, v1:vMax}`：协议底边采 staging 行 0 |
| 本仓库 JS 注释 | **错误地声称 Go 发 bottom-up** | `rdp-renderer.js` “matches the bottom-up BGRA rows the Go WASM side emits” |
| 本仓库冒烟测试 | **喂 bottom-up 假数据** | `rdp-renderer-browser-smoke.html` 注释 “Go WASM wire order” 与真实 Go 输出相反 |

**因此：即使 ClearCodec 与 FreeRDP 逐字节一致，WebGL 合成层仍会把正确像素上下颠倒写入 surface FBO；随后 `SURFACE_TO_CACHE` 从错误垂直位置取样，`CACHE_TO_SURFACE` 把错误 64×64 块铺满屏幕 → 规则马赛克。**

这与用户截图的结构一致（网格状重复碎块 + 局部可辨壁纸色），且**不依赖**客户端是否加载了 VBar-nil 修复。

---

## 1. 代数证明（8×2 瓦片）

Go 真实输出（top-down）：

```
byte row 0 = RED   = 视觉顶
byte row 1 = WHITE = 视觉底
```

`texSubImage2D` 后 staging：

```
texel row 0 = RED
texel row 1 = WHITE
```

当前 `uploadBitmap` 传入 UV `{v0:0, v1:vMax}`，且 `_drawTexture` 约定：

```
协议底边 (NDC bottom) ← v0
协议顶边 (NDC top)    ← v1
```

代入：

```
协议顶边 ← vMax ← WHITE   （错：应为 RED）
协议底边 ← 0    ← RED     （错：应为 WHITE）
```

→ surface FBO 内整块垂直翻转。

`cacheSurface` 对协议顶条 `top=0,bottom=1` 使用：

```
v0 = (H-bottom)/H , v1 = (H-top)/H
```

该公式假定 FBO 为 GL 自然 bottom-up（行 0 = 视觉底）。  
在错误上传后，FBO 上半实际是视觉底内容 → **“缓存顶条”拿到的是底条内容**。

Windows 大量 `CACHE_TO_SURFACE` 把这些错误槽位贴到全屏网格 → 马赛克。

`solidFill` 的 scissor 是按协议 top-down 正确映射的：

```
scissor(left, H-bottom, w, h)
```

→ 纯色块落点正确，与翻转的 bitmap 混叠 → **不是单纯整屏倒置，而是混向腐蚀**（更像花屏而非简单倒立）。

---

## 2. FreeRDP 对照（不可省）

### 2.1 residual

`clear.c`：顺序 `FreeRDPWriteColor(dstBuffer++)`，再 `convert_color(..., nXDst, nYDst, ...)`。  
`nYDst` 为协议顶。输出缓冲行 0 = 图像顶。

### 2.2 bands

```
nYDstRel = nYDst + yStart;
for (y = 0; y < count; y++)
  pDstData[((nYDstRel + y) * nDstStep) + (nXDstRel + i) * bpp]
```

y 从 0 递增 → top-down。

### 2.3 SurfaceToCache / CacheToSurface

`FREERDP_FLIP_NONE` 直接按 surface 坐标系拷贝。  
surface 与 GDI 一致为 top-down。

### 2.4 本仓库 Go 与 FreeRDP 一致

离线 55 流已证明 **解码 RGB 与 FreeRDP 一致**（`f8ec343` 后）。  
问题在解码**之后**的合成契约，不在 residual/band 算法本身。

---

## 3. 为什么现有测试全绿却仍花屏

| 测试 | 测了什么 | 漏了什么 |
|---|---|---|
| ClearCodec fixture / FreeRDP 差分 | 解码器字节 | 不经 WebGL |
| `rdp-renderer-browser-smoke` | 人为 bottom-up 输入下的 UV | **强化了错误约定** |
| Node software compositor (`drive.mjs`) | CPU 顶向下 blit | **不走 WebGL UV** |
| 真机 GL diag (T9) | 合成器自洽 | 输入仍按错误 bottom-up 构造 |

**验收闸门必须包含：用 top-down（与 Go/FreeRDP 相同）字节喂 `uploadBitmap`，断言屏幕顶为第一行。**

---

## 4. 唯一正确的修复方向

统一为：

1. **语义像素（ClearCodec / RFX / classic OnBitmap / surface 缓冲）= top-down BGRA**（与 FreeRDP 一致）。
2. **GPU surface 纹理内部**保持 GL 自然：texel 行 0 = 视觉底。
3. `uploadBitmap` 对 top-down 源使用 UV：

```
{ u0:0, v0: srcH/stagingH, u1: srcW/stagingW, v1: 0 }
```

即：协议顶边采 staging 行 0，协议底边采 staging 末行。  
（`uploadVideoFrame` 已是此约定，BITMAP 路径反了。）

4. `cacheSurface` / `copySurface` / `solidFill` / `present` 在 GL 自然存储下**保持现有公式**（它们本来就是为 bottom-up 纹理写的）。
5. 删除/停用死代码 `clearCodecCtx`（仅 `clearDecoder` 在 WTS1 使用），避免双实现漂移。
6. 重写冒烟：输入改为 top-down；新增“真实契约”门禁；可选：用一条真实 ClearCodec 解码输出直喂 WebGL 做像素金标。

## 5. 与“缓存版本未撞”的关系

- 运行中容器仍是 `final` + build `clearcodec-parity1` → 用户截图不能证明最新 WASM。
- 但 **即使撞版本部署 VBar 修复，只要本契约错误仍在，花屏仍会存在**。
- VBar-nil 与 glyph 修复是必要的（解码丢块），**不是充分的**（合成层仍会毁图）。

## 6. 不接受的偷懒

- 只改注释不改 UV
- 只在 JS 里对部分路径 flip、保留双约定
- 用“再截一张图”代替 formal 像素门禁
- 继续用 bottom-up 假数据当“Go wire order”