# zephyr-ssh RDP WASM 渲染/音画同步/剪贴板 修复计划

> 基于对 `public/rdp-wasm-client.js`、`rdp-wasm/main.go`、`grdp-patch/grdp.go`、`grdp-patch/core/rle.go`、`grdp-patch/plugin/cliprdr/handler.go`、`grdp-patch/plugin/rdpgfx/rdpgfx.go` 等文件的完整代码审查。

---

## 一、CPU/GPU 渲染问题分析

### 问题 1：WASM 构建使用了标量像素转换（SIMD 代码全部失效）

**根因**：[KNOWN] Go 的 build tag 机制导致 SIMD 加速代码在 WASM 中完全不编译。

| 文件 | Build Tag | WASM 中编译？ |
|------|-----------|--------------|
| `convert_amd64.go` | `//go:build amd64` | ❌ |
| `convert_arm64.go` | `//go:build arm64` | ❌ |
| `convert_generic.go` | `//go:build !amd64 && !arm64` | ✅ (标量循环) |
| `ycbcr_arm64.go` | `//go:build arm64` | ❌ |
| `ycbcr_generic.go` | `//go:build !amd64 && !arm64` | ✅ (标量循环) |

Makefile 构建命令：`GOOS=js GOARCH=wasm go build` → `GOARCH=wasm` 不匹配 `amd64` 也不匹配 `arm64` → 所有 NEON/SSE2 批量转换函数退化为逐像素标量循环。

**影响**：
- `bgr32BatchToRGBA`：BGRA→RGBA 转换，逐像素 4 次字节操作 + `binary.LittleEndian.PutUint32`
- `rgb555BatchToRGBA` / `rgb565BatchToRGBA`：16 位色彩转换，逐像素位操作
- `ycoCgToBGRANoSub`：RemoteFX YCoCg→BGRA 转换，逐像素 3 次乘法 + clamp
- 在 1920×1080 分辨率下，每帧约 200 万像素，标量循环在 WASM 中极为缓慢

### 问题 2：`putImageData` 是纯 CPU 操作

**根因**：[KNOWN] Canvas 2D `putImageData` 不经过 GPU 纹理上传，而是将像素数据复制到 canvas 的 backing store 中。

`main.go:renderBitmaps` 的渲染流程：
```
Go WASM RLE 解压(CPU) → BGR→RGBA 像素转换(CPU 标量) → js.CopyBytesToJS(CPU memcpy)
→ new ImageData(CPU 分配) → ctx2d.putImageData(CPU 复制到 backing store)
```

每一步都是 CPU 操作。对于一个 1920×1080 的完整帧（约 8MB 像素数据），意味着：
1. Go 中 BGR→RGB 逐像素交换（~200 万次循环）
2. `js.CopyBytesToJS` 复制 8MB 到 JS 堆
3. `putImageData` 再复制 8MB 到 canvas backing store

**对比**：H.264 路径使用 `VideoDecoder`（GPU 解码）+ `drawImage`（GPU blit），性能好得多。但普通位图路径（桌面 UI、窗口拖动等）走的是全 CPU 路径。

### 问题 3：位图数据被复制两次

`main.go:OnBitmap` 回调中：
```go
// 第一次复制：从 pool 借用的数据需要 copy 因为要传给 goroutine
for i := range bs {
    d := make([]byte, len(bs[i].Data))
    copy(d, bs[i].Data)
    bs[i].Data = d
}
go func() {
    renderBitmaps(bs)
}()
```
然后 `renderBitmaps` 中：
```go
// 第二次复制：Go → JS Uint8ClampedArray
js.CopyBytesToJS(bitmapJSArr, rgba)
```

每帧两次完整帧大小的内存复制，在低配机器上造成显著 GC 压力和内存带宽瓶颈。

### 问题 4：`bm.RGBA()` 每次调用都分配新 image

`renderBitmaps` 中对非 32bpp 格式调用 `bm.RGBA()`，这会 `image.NewRGBA()` 分配新内存。`FillRGBA(dst)` 的复用模式虽然有，但 `renderBitmaps` 没有使用它。

### 问题 5：H.264 路径的时间戳是伪造的

```javascript
h264Timestamp += 1000;  // 每次 +1ms，与真实 PTS 无关
h264FramePos.set(h264Timestamp, { x: destX, y: destY });
```

`h264Timestamp` 只是单调递增的计数器，不是真实的呈现时间戳。`VideoDecoder` 配置了 `optimizeForLatency: true`，解码后帧在 `output` 回调中立即绘制，没有任何呈现调度。

### 问题 6：`h264FramePos` Map 可能内存泄漏

如果 `VideoDecoder` 丢弃了帧（`optimizeForLatency: true` 会鼓励丢帧），对应 timestamp 的 Map 条目永远不会被删除：
```javascript
output(frame) {
    const pos = h264FramePos.get(frame.timestamp);
    h264FramePos.delete(frame.timestamp);  // 只在 output 时删除
    // 如果帧被丢弃，这行永远不执行
}
```

---

## 二、音画不同步问题分析

### 问题 1：音视频没有共享时钟

- **视频**：零缓冲，解码即绘制。没有呈现时间戳，没有帧队列，没有 vsync 对齐。
- **音频**：40ms-150ms 可变缓冲。`audioNextAt` 链式调度，但与视频完全独立。

两者使用完全不同的时间基准，没有任何同步机制。

### 问题 2：视频没有 PTS（呈现时间戳）

H.264 NAL 数据中的真实 PTS 被 Go 侧丢弃。`h264Timestamp += 1000` 是假的时间戳，VideoDecoder 无法据此排序或调度帧呈现。

### 问题 3：音频重同步是单向的

```javascript
if (audioNextAt < now || audioNextAt > now + AUDIO_MAX_QUEUE) {
    audioNextAt = now + AUDIO_MIN_LATENCY;
}
```

音频会在 underrun 或积压时自我重同步，但视频从不调整。如果视频解码器落后，音频会继续播放，导致音画偏移不断扩大。

### 问题 4：AudioBuffer 填充是 CPU 标量循环

```javascript
for (let ch = 0; ch < channels; ch++) {
    const out = audioBuf.getChannelData(ch);
    for (let i = 0; i < numSamples; i++) {
        out[i] = int16[i * channels + ch] / 32768.0;
    }
}
```

立体声 48kHz 音频每秒需要 96,000 次迭代。`createScriptProcessor` 已被废弃，应该用 `AudioWorklet`。

### 问题 5：AUDIN 麦克风也用了废弃的 `createScriptProcessor`

```javascript
audinProcessor = audinContext.createScriptProcessor(bufferSize, channels, channels);
```

`ScriptProcessorNode` 在主线程运行，会造成音频卡顿。应迁移到 `AudioWorkletNode`。

---

## 三、剪贴板同步问题分析

### 问题 1：`encodeUTF16LE` 缺少 null 终止符（BUG）

`handler.go` 中：
```go
func encodeUTF16LE(s string) []byte {
    runes := []rune(s)
    u16 := utf16.Encode(runes)
    b := make([]byte, len(u16)*2)
    for i, v := range u16 {
        binary.LittleEndian.PutUint16(b[i*2:], v)
    }
    return b  // 没有 null 终止符！
}
```

注释说 "encodeUTF16LE appends null terminator" 但实际没有。对比旧代码 `cliprdr.go`：
```go
buff.Write(core.UnicodeEncode(data))
buff.Write([]byte{0, 0})  // 显式追加 null 终止符
```

Windows 期望 `CF_UNICODETEXT` 格式的数据以 UTF-16LE null 结尾。缺少 null 终止符可能导致：
- 远程剪贴板文本末尾出现乱码
- 某些应用程序拒绝粘贴
- 安全问题（缓冲区越界读取）

### 问题 2：本地剪贴板没有主动同步

JS 侧只在 `pointerdown` 和 `paste` 事件时读取本地剪贴板：
```javascript
rdpCanvas.addEventListener('pointerdown', syncClipboard);
document.addEventListener('paste', (e) => { ... });
```

如果 canvas 已有焦点，用户直接按 Ctrl+V：
1. `keydown` 处理器 `await clipboardSyncPromise`（这是初始的 `Promise.resolve()`）
2. 直接发送 Ctrl+V scancode 到远程
3. 远程粘贴的是**旧的**剪贴板内容，因为本地新剪贴板从未被同步

### 问题 3：`sendTextViaClipboard` 竞态条件

用于 CJK 输入的剪贴板粘贴路径：
```javascript
function sendTextViaClipboard(text) {
    rdpClipboardChanged(text);
    setTimeout(() => {
        rdpKeyDown('ControlLeft');
        rdpKeyDown('KeyV');
        // ...
    }, 50);
}
```

50ms 远不够完成完整的剪贴板同步往返：
1. JS → Go: `rdpClipboardChanged(text)` → 设置 `localClipboard` + `sendFormatList()`
2. Go → Server: `CB_FORMAT_LIST` PDU
3. Server → Go: `CB_FORMAT_DATA_REQUEST` PDU
4. Go → Server: `CB_FORMAT_DATA_RESPONSE` PDU（含文本数据）
5. Server 更新剪贴板
6. 然后才能收到 Ctrl+V 并粘贴

步骤 2-5 需要至少一个网络往返（通常 20-200ms），50ms 在远程连接上几乎肯定不够。

### 问题 4：`suppressNextLocalChange` 标志脆弱

```go
func (h *CliprdrHandler) processFormatDataResponse(body []byte, msgFlags uint16) {
    // ...
    h.suppressNextLocalChange = true
    h.onRemoteClipboardChanged(text)
}
```

单个 boolean 标志，没有去抖、没有计数。如果远程剪贴板连续变化两次，或者 `navigator.clipboard.writeText` 的异步完成与下一次 `pointerdown` 交叠，标志会被错误消费或跳过。

### 问题 5：跨标签页剪贴板转发可能形成反馈环

`initFilePanel` 中：
```javascript
const origOnClipboard = window.rdpOnClipboard;
window.rdpOnClipboard = function (text) {
    if (origOnClipboard) origOnClipboard(text);
    window.parent?.postMessage?.({
        source: 'zephyr-terminal',
        type: 'shared-clipboard-text',
        text,
        tabId: params.tabId || ''
    }, '*');
};
```

消息处理器中：
```javascript
} else if (msg.type === 'shared-clipboard-text' && msg.text && connected) {
    rdpClipboardChanged(msg.text);
}
```

流程：Tab A 收到远程剪贴板 → 转发给 parent → parent 广播给 Tab B → Tab B 调用 `rdpClipboardChanged` → Tab B 的远程服务器收到 FORMAT_LIST → 服务器把文本发回 Tab B → Tab B 转发给 parent → 循环。

`suppressNextLocalChange` 只在单个 CliprdrHandler 实例内有效，跨标签页没有防环机制。

### 问题 6：`sendFormatList()` 不包含文件格式

当文本剪贴板变化时，`OnLocalClipboardChanged()` → `sendFormatList()` 只发送 `CF_UNICODETEXT`：
```go
func (h *CliprdrHandler) sendFormatList() {
    b := &bytes.Buffer{}
    if h.useLongFormatNames {
        binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
        b.Write([]byte{0, 0})
    }
    // ...
}
```

如果用户之前通过 `SendLocalFilesFormatList()` 广播了文件格式，现在复制了文本，文件格式信息会被覆盖清除。

### 问题 7：不支持 HTML/RTF 等富文本格式

`sendFormatList()` 只广告 `CF_UNICODETEXT`。`processFormatList()` 只请求 `CF_UNICODETEXT` 或 `CF_TEXT`。远程复制富文本（Word、浏览器等）时，格式信息丢失。

### 问题 8：`CliprdrClient`（cliprdr.go）是死代码

`grdp.go:doLogin()` 注册的是 `cliprdr.NewHandler()`（handler.go），`cliprdr.NewCliprdrClient()` 从未被调用。`cliprdr.go` 的全部代码（包括 `ClipWatcher`、`SimpleTextClipboard` 等）都是死代码，但容易造成维护混淆。

---

## 四、修复计划

### Phase 1：渲染管线 GPU 化（影响最大）

#### 1.1 引入 WebGL 渲染路径替代 Canvas 2D `putImageData`

**目标**：将位图上传和颜色转换从 CPU 移到 GPU。

**方案**：
- 创建 WebGL2 上下文替代 Canvas 2D（保留 Canvas 2D 作为 fallback）
- 使用 `RGBA8` 纹理 + `texSubImage2D` 上传位图数据
- 在 fragment shader 中做 BGR→RGB 交换（采样时 `swizzle`），消除 Go 侧的逐像素转换
- 使用 `UNPACK_FLIP_Y_WEBGL` 处理 bottom-up 位图翻转

**关键改动**：
- `rdp-wasm-client.js`：新增 WebGL renderer 模块，在 `ensureCanvas` 时创建 WebGL 上下文
- `main.go:renderBitmaps`：跳过 BGR→RGB 转换，直接上传原始 BGRA 数据到 JS
- 新增 JS 函数 `rdpDrawBitmapBGRA(destX, destY, w, h, uint8Data)` 直接上传到 WebGL 纹理

**预期收益**：
- 消除 Go 侧逐像素 BGR→RGB 转换（~200 万次循环/帧 → 0）
- `texSubImage2D` 走 GPU DMA 路径，比 `putImageData` 的 CPU 复制快 5-10 倍
- 低配机器帧率预计提升 2-3 倍

#### 1.2 消除冗余内存复制

**当前**：Go `make+copy` → `js.CopyBytesToJS` → `putImageData`（3 次复制）
**目标**：Go 直接写入预分配的 JS `Uint8Array` → GPU 纹理上传（1 次复制）

**方案**：
- 在 JS 侧预分配一个足够大的 `Uint8Array`（屏幕大小 × 4 字节）
- Go 侧通过 `js.Value.Set("index", value)` 或共享内存直接写入
- 或者使用 Go WASM 的 `fs.FS` / 内存映射机制（如果可用）

**现实约束**：Go WASM 的 `syscall/js` 没有零拷贝 API。`js.CopyBytesToJS` 是唯一方式。但仍可以：
- 消除 `make+copy`（直接在回调中同步渲染，不 spawn goroutine，避免数据生命周期问题）
- 或者使用 `FillBGRA` 直接写入复用的 buffer，避免 `RGBA()` 分配

#### 1.3 为 WASM 构建添加 SIMD 支持

**方案**：
- 创建 `convert_wasm.go`（`//go:build js && wasm`），使用 Go WASM SIMD intrinsics（如果 Go 版本支持）
- 或者将像素转换完全移到 JS 侧（WebGL shader），绕过 Go WASM 的 SIMD 限制
- 如果 WebGL 方案实现，此步骤可跳过（GPU shader 替代了 CPU SIMD）

#### 1.4 H.264 路径优化

- 修复 `h264FramePos` Map 泄漏：定期清理过期条目，或限制 Map 大小
- 添加 `VideoDecoder.decodeQueueSize` 检查，当队列深度过大时丢弃旧帧
- 考虑使用 `requestAnimationFrame` 对齐绘制时机到 vsync

### Phase 2：音画同步

#### 2.1 建立共享呈现时钟

**方案**：
- 以音频时钟为主时钟（audio master clock）
- 维护一个 `presentationClock` 变量，由 `audioCtx.currentTime` 驱动
- 视频帧不再立即绘制，而是根据 PTS 在 `requestAnimationFrame` 中调度

#### 2.2 视频帧呈现队列

**方案**：
- `VideoDecoder.output` 回调中将帧放入待呈现队列（不立即 `drawImage`）
- `requestAnimationFrame` 回调中检查队列，呈现 PTS ≤ 当前时钟的帧
- 如果队列中有多于 1 帧等待呈现，丢弃最旧的帧（保持低延迟）
- 如果队列为空，保持上一帧（等待解码）

**关键改动**：
- `rdp-wasm-client.js`：新增 `FramePresenter` 类管理帧队列
- H.264 `output` 回调改为入队
- `requestAnimationFrame` 驱动出队 + 绘制

#### 2.3 音频路径优化

- 将 `createScriptProcessor`（AUDIN 麦克风输入）迁移到 `AudioWorklet`
- Int16→Float32 转换使用 `DataView` 批量读取或 WASM 模块
- 考虑使用 `latencyHint: 'balanced'` 替代 `'interactive'`，牺牲少量延迟换取稳定性

### Phase 3：剪贴板修复

#### 3.1 修复 `encodeUTF16LE` 缺少 null 终止符（P0 BUG）

```go
func encodeUTF16LE(s string) []byte {
    runes := []rune(s)
    u16 := utf16.Encode(runes)
    b := make([]byte, (len(u16)+1)*2)  // +1 for null terminator
    for i, v := range u16 {
        binary.LittleEndian.PutUint16(b[i*2:], v)
    }
    // 最后 2 字节已经是 0x00 0x00 (null terminator)
    return b
}
```

#### 3.2 添加主动剪贴板同步

**方案**：
- 监听 `window` 的 `focus` 和 `visibilitychange` 事件，在窗口获得焦点时同步剪贴板
- 在 `keydown` 处理器中检测 Ctrl+V / Cmd+V，如果是粘贴操作则先 `await syncClipboard()` 再发送按键
- 如果浏览器支持 `navigator.clipboard.addEventListener('clipboardchange', ...)`，注册监听

```javascript
window.addEventListener('focus', syncClipboard);
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncClipboard();
});

rdpCanvas.addEventListener('keydown', async (e) => {
    if (!connected) return;
    e.preventDefault();
    // 如果是粘贴操作，先确保剪贴板已同步
    if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
        await syncClipboard();
    }
    await clipboardSyncPromise;
    rdpKeyDown(e.code);
});
```

#### 3.3 修复 `sendTextViaClipboard` 竞态

**方案**：将 50ms 固定延迟改为等待服务器确认。

在 Go 侧添加 `clipboardReadyCh`：
- `sendFormatList()` 后等待 `CB_FORMAT_LIST_RESPONSE`
- `processFormatDataRequest` 处理完毕后表示剪贴板已就绪
- JS 侧调用 `rdpClipboardChanged` 时返回 Promise，在 Go 侧 FORMAT_DATA_REQUEST 处理完成后 resolve

如果实现过于复杂，至少将延迟增加到 200ms 并添加重试机制。

#### 3.4 替换 `suppressNextLocalChange` 为计数器 + 去抖

```go
type CliprdrHandler struct {
    // ...
    suppressCount atomic.Int32  // 替代 suppressNextLocalChange bool
    suppressTimer *time.Timer   // 去抖定时器
}

func (h *CliprdrHandler) OnLocalClipboardChanged() {
    if h.suppressCount.Load() > 0 {
        h.suppressCount.Add(-1)
        return
    }
    // 去抖：延迟 100ms 发送，如果期间又有变化则重置定时器
    if h.suppressTimer != nil {
        h.suppressTimer.Stop()
    }
    h.suppressTimer = time.AfterFunc(100*time.Millisecond, func() {
        h.sendFormatList()
    })
}
```

#### 3.5 添加跨标签页防环机制

在 `rdpOnClipboard` 转发时添加来源标记：
```javascript
window.rdpOnClipboard = function (text, fromRemote) {
    if (origOnClipboard) origOnClipboard(text);
    // 只有远程来的文本才转发给其他标签页
    if (!fromRemote) {
        window.parent?.postMessage?.({
            source: 'zephyr-terminal',
            type: 'shared-clipboard-text',
            text,
            tabId: params.tabId || '',
            origin: 'remote'  // 标记来源
        }, '*');
    }
};
```

在收到跨标签文本时：
```javascript
if (msg.type === 'shared-clipboard-text' && msg.text && connected) {
    // 来自其他标签页的文本，设置 suppress 防止回环
    rdpClipboardChanged(msg.text);
    // 不再转发
}
```

#### 3.6 `sendFormatList()` 合并文件格式

当有本地文件时，`sendFormatList()` 也应包含文件格式：
```go
func (h *CliprdrHandler) sendFormatList() {
    b := &bytes.Buffer{}
    if h.useLongFormatNames {
        binary.Write(b, binary.LittleEndian, uint32(CF_UNICODETEXT))
        b.Write([]byte{0, 0})

        // 如果有本地文件，也广告文件格式
        if h.getLocalFiles != nil {
            files := h.getLocalFiles()
            if len(files) > 0 {
                binary.Write(b, binary.LittleEndian, h.localFGDFormatId)
                b.Write(encodeUTF16LE("FileGroupDescriptorW"))
                binary.Write(b, binary.LittleEndian, h.localFCFormatId)
                b.Write(encodeUTF16LE("FileContents"))
            }
        }
    }
    h.sendPDU(CB_FORMAT_LIST, 0, b.Bytes())
}
```

#### 3.7 清理死代码

删除或标记 `cliprdr.go`（`CliprdrClient`）为 deprecated。它从未被实例化，只会造成维护混淆。

#### 3.8 可选：支持 HTML 格式

在 `sendFormatList()` 中广告 `CF_HTML`（注册格式 "HTML Format"），在 `processFormatList()` 中检测并请求 HTML 格式，在 `processFormatDataRequest()` 中提供本地 HTML 剪贴板内容。

---

## 五、优先级排序

| 优先级 | 问题 | 影响 | 难度 |
|--------|------|------|------|
| P0 | `encodeUTF16LE` 缺少 null 终止符 | 剪贴板文本损坏/安全问题 | 低 |
| P0 | `sendTextViaClipboard` 竞态 | CJK 输入经常粘贴错误内容 | 中 |
| P0 | 本地剪贴板未主动同步 | Ctrl+V 粘贴旧内容 | 低 |
| P1 | WebGL 渲染替代 putImageData | 低配机器渲染卡顿 | 高 |
| P1 | WASM 标量转换无 SIMD | 像素转换慢 5-10 倍 | 中（如果 WebGL 方案则可跳过）|
| P1 | 视频帧呈现队列 + 共享时钟 | 音画不同步 | 高 |
| P2 | 消除冗余内存复制 | GC 压力 + 内存带宽 | 中 |
| P2 | h264FramePos Map 泄漏 | 长时间使用内存增长 | 低 |
| P2 | suppressNextLocalChange 脆弱 | 偶发剪贴板回环 | 中 |
| P2 | 跨标签页防环 | 多标签剪贴板循环 | 中 |
| P3 | sendFormatList 合并文件格式 | 文件+文本混合剪贴板异常 | 低 |
| P3 | AudioWorklet 替代 ScriptProcessor | 麦克风输入卡顿 | 中 |
| P3 | 清理 cliprdr.go 死代码 | 维护性 | 低 |
| P3 | HTML 格式支持 | 富文本降级 | 中 |

---

## 六、注意事项

1. **WebGL 方案是渲染问题的根本解**：如果实现了 WebGL 纹理上传 + shader 颜色转换，则 Go 侧的 SIMD 问题、BGR→RGB 转换问题、`putImageData` CPU 复制问题全部一次性解决。建议优先实现此方案。

2. **音画同步需要谨慎设计**：不能简单地对视频加缓冲，否则会增加延迟。需要在"低延迟"和"同步"之间取平衡。建议以音频为主时钟，视频帧 PTS 对齐到音频时钟，最大缓冲 3 帧（~50ms@60fps）。

3. **剪贴板修复大部分是低难度高收益**：null 终止符、主动同步、防环机制都是小改动但解决实际问题。

4. **测试约束**：Go WASM 测试需要 `GOOS=js GOARCH=wasm` 交叉编译 + `node --check` 验证 JS。不能用标准 `go test` 直接运行 WASM 测试（需要 `wasm_exec.js` 测试运行器）。
