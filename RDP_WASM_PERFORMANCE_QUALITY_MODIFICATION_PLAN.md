# Zephyr SSH RDP WASM 性能/画质改造实施计划

> [KNOWN, HIGH] 计划基线：`Lanlan13-14/zephyr-ssh` 的 `main` / `v1.1.447`，提交 `a2b917ed08a5645d1bc5d400946b2acb76934cdf`。
>
> [KNOWN, HIGH] 依据文档：`RDP_WASM_PERFORMANCE_QUALITY_SOLUTION.md`（725 行方案稿）。
>
> [KNOWN, HIGH] 本文件是结合当前仓库代码、测试、构建流水线后的可执行修改计划，不代表功能已经实现。
>
> [KNOWN, HIGH] 本轮只规划，不修改业务代码、不提交、不推送。

---

## 1. 目标与不可妥协边界

### 1.1 主目标

1. [KNOWN, HIGH] 把 Go WASM RDP 协议栈、WebSocket 接收、RDPGFX 解析、视频解码和 GPU 合成迁入 Dedicated Worker，避免持续占用页面线程。
2. [KNOWN, HIGH] 用 OffscreenCanvas + WebGL2 建立完整的 RDPGFX surface compositor，而不是继续把所有更新直接写入一张屏幕纹理。
3. [KNOWN, HIGH] 让 WebCodecs 与 WebGL2 同时工作，AVC420 压缩流直接解码成 `VideoFrame` 并写入目标 surface。
4. [KNOWN, HIGH] 补齐 AVC444/AVC444v2 的 LC、双流、regions、surface 和 frame 语义；在完整质量门禁通过前不得把不完整快路径设为默认。
5. [KNOWN, HIGH] 以 `START_FRAME/END_FRAME` 管协议帧，以 Worker rAF 管显示时机，以 `FRAME_ACKNOWLEDGE` 管真实 backlog；每个显示刷新周期最多 present 一次。
6. [KNOWN, HIGH] 修复 WebSocket↔TCP 和浏览器接收队列的可靠背压；RDP 字节流不得静默丢包。
7. [KNOWN, HIGH] 保留 Canvas2D compatibility fallback，但只允许降低性能，不允许静默降低分辨率、色深、色度信息或静态最终画质。

### 1.2 产品行为约束

1. [KNOWN, HIGH] RDP 缩放横条继续是 viewport zoom 的唯一写入口；pinch、多指手势、浮动 `+/-` 不得改变缩放。
2. [KNOWN, HIGH] 不引入 T6 浮动工具栏。
3. [KNOWN, HIGH] 不恢复 `rdpPointerOverlay`、`rdp-pointer-overlay` 或其他本地触控圆环/触控点。
4. [KNOWN, HIGH] 保留直接触控、相对触控板、`0.5–3.0×` 灵敏度、速度加速、双击恰好两次点击、长按右键、pen、三指快捷键、双轴惯性滚动、震动和 `touchcancel` 清理。
5. [KNOWN, HIGH] 水平滚轮继续走 `rdpMouseHScroll → MouseHWheel → PTRFLAGS_HWHEEL`，不得退化为方向键模拟。
6. [KNOWN, HIGH] 不通过降低 RDP 分辨率、色深、服务端 codec、AVC444 色度信息、壁纸质量或二次有损编码换取性能数据。

---

## 2. 当前仓库审计结论

### 2.1 已完成、必须复用的基础

1. [KNOWN, HIGH] `public/rdp-touch.js` 已实现当前移动输入语义；现有 15 项 Node 测试全部通过。
2. [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/` 已有软件 surface backing store、create/delete/map/map-scaled、surface copy、solid fill、cache、RemoteFX Progressive 和 AVC 解析代码。
3. [KNOWN, HIGH] `rdp-wasm/main.go` 的 bitmap callback 已改成同步消费借用 buffer，并复用 Go/JS 缓冲，消除了旧的 `make+copy + goroutine + CopyBytesToJS` 三重路径。
4. [KNOWN, HIGH] 剪贴板 null 终止符、主动同步、Promise 就绪等待、抑制计数器、跨标签 origin 和文本/文件 format-list 合并已经存在。
5. [KNOWN, HIGH] AUDIN 主路径已有 AudioWorklet；ScriptProcessor 只作为兼容回退。
6. [KNOWN, HIGH] RDPGFX 已报告 decode queue depth，但 ACK 仍在 Go decode loop 的 `END_FRAME` 时立即生成，尚未覆盖异步 WebCodecs/GPU backlog。

### 2.2 必须修复的当前缺陷

1. [KNOWN, HIGH] `shouldUseWebGLRenderer()` 只有显式 `rdpWebgl=true` 才返回 true，默认仍是 Canvas2D。
2. [KNOWN, HIGH] `ensureCanvas()` 上方注释声称“默认优先 WebGL”，但实际函数默认关闭 WebGL；注释与行为冲突。
3. [KNOWN, HIGH] WebGL tile 热路径每次更新都执行 `texSubImage2D → getError → clear → full-screen draw → getError`，一帧多个 tile 会重复全屏 present。
4. [KNOWN, HIGH] WebGL context 使用 `preserveDrawingBuffer: true`，不适合持续高频 present。
5. [KNOWN, HIGH] `hasWebCodecs` 明确附带 `!shouldUseWebGLRenderer()`，GPU bitmap 和 H.264 硬解被错误互斥。
6. [KNOWN, HIGH] H.264 present loop 的注释声称“aligned to audio clock”，但实际循环没有读取 `audioCtx.currentTime`、没有按协议 PTS 判断 due time，只在每次 rAF 保留最新解码帧。
7. [KNOWN, HIGH] `rdpOnH264()` 在 `decodeQueueSize > 10` 时跳过尚未送入 decoder 的压缩 chunk；这会破坏 H.264 参考帧链。
8. [KNOWN, HIGH] raw H.264 callback 只带 `destX/destY/w/h/isKey/data`，缺少 `surfaceId/frameId/codec/LC/regions/stream role`。
9. [KNOWN, HIGH] AVC444 raw callback 只转发 stream1，LC=2/stream2 没有进入浏览器快路径。
10. [KNOWN, HIGH] RDPGFX `START_FRAME` 当前被忽略；`END_FRAME` 立即 ACK，不能等待异步 decoder 和 compositor。
11. [KNOWN, HIGH] `ackCh` 满时会直接丢 ACK；服务端可能因缺失 ACK 停止继续发帧。
12. [KNOWN, HIGH] `wasm_transport.go` 的 256-chunk `readBuf` 满时静默丢弃 RDP 字节；RDP 是可靠有序字节流，此行为会破坏整个后续协议流。
13. [KNOWN, HIGH] `/rdp-proxy` 忽略 `tcpConn.write()` 的 false 返回值、`drain`、`ws.bufferedAmount` 和浏览器协议队列 backlog。
14. [KNOWN, HIGH] 当前 H.264→WebGL 兼容回退使用 `drawImage → getImageData → texSubImage2D`，重新引入 CPU readback；只能保留为临时兼容回退，不能作为正常快路径。
15. [KNOWN, HIGH] `public/rdp-wasm-client.js` 为 2915 行，混合 UI、权限、输入、音频、摄像头、renderer、decoder 和连接生命周期；继续在该文件堆功能会放大回归风险。
16. [KNOWN, HIGH] `server.js` 为 5701 行，RDP bridge 逻辑无法独立单测。
17. [KNOWN, HIGH] `package.json` 没有 `test`、`test:rdp` 或语法检查脚本。
18. [KNOWN, HIGH] Docker workflow 仅允许手动发布，并且构建前没有 Node/RDP/Go 测试门禁。
19. [KNOWN, HIGH] 当前只有触控相关 Node 测试；没有 transport backpressure、frame ACK、renderer、surface、WebCodecs metadata、Worker RPC 或图像一致性测试。
20. [COMPUTED, HIGH] 当前基线下 15 项 Node 测试通过，核心 JavaScript 语法检查通过。
21. [KNOWN, HIGH] 本机 Go 为 1.23.9，而 `rdp-wasm/go.mod` 要求 Go 1.26.3，因此本机 Go 测试未执行成功；这不是测试通过。

### 2.3 对原方案的实施修正

1. [INFERRED, HIGH] 不应先把 `rdpWebgl` 默认改成 true；当前 GPU 路径仍缺 surface/frame 合成且与 WebCodecs 互斥。
2. [INFERRED, HIGH] 不应把 Worker、compositor、AVC444 和零复制一次性合并；必须先建立 trace、语义接口和双路径对照，否则无法定位画质回归来源。
3. [INFERRED, HIGH] transport 背压应先独立落地，因为它是 correctness 修复，不依赖 renderer。
4. [INFERRED, HIGH] AVC420 与 AVC444 必须分阶段；AVC420 快路径不能被当成 AVC444 完成的证据。
5. [INFERRED, HIGH] Worker 迁移应晚于页面线程版 compositor correctness 验证，避免同时调试协议、GPU、线程和权限 RPC。
6. [INFERRED, HIGH] zero-copy 应晚于 compositor 和 Worker 稳定；过早引入 WASM linear-memory view 会把内存生命周期风险混入正确性阶段。

---

## 3. 目标代码布局

```text
public/
  rdp-wasm-client.js           # DOM/UI、权限编排、生命周期入口
  rdp-touch.js                 # 保留现有页面输入语义
  rdp-input-channel.js         # 有序 input envelope、屏障、状态释放
  rdp-worker.js                # Go WASM、WS、decoder、frame scheduler
  rdp-renderer.js              # WebGL2 surface compositor
  rdp-capabilities.js          # Worker/WebGL2/WebCodecs/VideoFrame probe
  rdp-diagnostics.js           # 指标与诊断导出
  rdp-permission-rpc.js        # clipboard/file/camera/mic/location 页面 RPC

rdp-wasm/
  main.go                      # 连接与 Worker 宿主接口
  wasm_transport.go            # 可靠有界字节队列与流控
  render_bridge.go             # GFX semantic event → JS bridge
  input_bridge.go              # 有序输入入口
  grdp-patch/plugin/rdpgfx/
    events.go                  # surface/frame/video 语义事件
    frame_tracker.go           # pending/sealed/complete/ACK 状态机
    ...                        # 复用现有 rdpgfx.go/avc.go reference 实现

server/
  rdp-proxy-bridge.js          # 可独立测试的 WS↔TCP 背压桥

server.js                      # 路由、认证、连接查找，调用 bridge 模块

tests/
  rdp-transport/
  rdp-renderer/
  rdp-trace/
  rdp-quality/
  rdp-worker/
  rdp-input-ordering/
  rdp-touch.test.mjs
  rdp-touch-invariants.test.mjs
```

[INFERRED, HIGH] `server/rdp-proxy-bridge.js` 只提取传输桥，不要求本轮拆完整个 `server.js`。

---

## 4. 分阶段实施计划

## Phase 0：先建立可重复基线、CI 和开关

### 修改文件

- [KNOWN, HIGH] `package.json`
- [KNOWN, HIGH] `.github/workflows/ci.yml`（新增）
- [KNOWN, HIGH] `tests/rdp-trace/`（新增）
- [KNOWN, HIGH] `tests/rdp-renderer/`（新增）
- [KNOWN, HIGH] `public/rdp-diagnostics.js`（新增）
- [KNOWN, HIGH] `public/rdp-wasm-client.js`

### 实施项

1. [KNOWN, HIGH] 新增脚本：`test`、`test:rdp-node`、`test:syntax`、`test:go`、`test:wasm-build`、`test:ci`。
2. [KNOWN, HIGH] 新增 push/PR CI，固定 Node 20 和 Go 1.26.3；先测试，再允许 Docker release workflow 构建。
3. [KNOWN, HIGH] 记录匿名 renderer-event trace，只包含命令、矩形、codec metadata、帧边界和合成测试像素，不记录真实桌面、密码、剪贴板或文件内容。
4. [KNOWN, HIGH] 建立 720p/1080p/1440p/4K 合成 workload：静态文本、棋盘格、渐变、滚动、窗口拖动、多 tile、mixed bitmap/video、cursor。
5. [KNOWN, HIGH] 固定当前 `legacy` 基线指标：接收字节、bitmap bytes、decode queue、tile 数、present 数、长任务、内存和截图 hash。
6. [KNOWN, HIGH] 引入 pipeline flag：`legacy`、`gpu-v2-page`、`worker-gpu-v2`；默认仍为 `legacy`。
7. [KNOWN, HIGH] 立即修正文档/注释中“WebGL 默认开启”和“精确对齐音频时钟”的失实表述，但不借此改变运行行为。
8. [KNOWN, HIGH] 把现有 15 项触控/约束测试纳入 CI，作为后续每阶段固定回归门禁。

### 退出门禁

- [KNOWN, HIGH] CI 在干净 clone 上可重复执行。
- [KNOWN, HIGH] trace replay 同一输入连续运行得到相同 frame/surface 命令顺序。
- [KNOWN, HIGH] 当前 legacy 截图、功能和指标基线被保存。
- [KNOWN, HIGH] 15 项现有测试继续全部通过。

### 回滚点

- [KNOWN, HIGH] 本阶段只增加测试、诊断和开关；删除新增文件即可回滚，不改变默认 RDP 行为。

---

## Phase 1：修复 WebSocket/TCP 可靠性与双向背压

### 修改文件

- [KNOWN, HIGH] `rdp-wasm/wasm_transport.go`
- [KNOWN, HIGH] `server/rdp-proxy-bridge.js`（新增）
- [KNOWN, HIGH] `server.js`
- [KNOWN, HIGH] `tests/rdp-transport/*.test.mjs`（新增）
- [KNOWN, HIGH] `rdp-wasm/wasm_transport_test.go`（新增，可拆出平台无关 queue）

### 浏览器/WASM 接收端

1. [KNOWN, HIGH] 用按字节计数的 deque 替换 256-chunk channel 的 `default: drop`。
2. [KNOWN, HIGH] 维护 `queuedBytes/queuedChunks/highWater/lowWater/hardLimit`。
3. [KNOWN, HIGH] 到 high watermark 时通过 v2 control message 通知 Node 暂停 TCP；回落到 low watermark 时恢复。
4. [KNOWN, HIGH] 超过 hard limit 时带明确 reason code 关闭并重连，禁止继续消费缺字节流。
5. [KNOWN, HIGH] `Read()` 保持严格字节顺序，正确处理 partial read、pending tail、close race 和 reconnect generation。
6. [KNOWN, HIGH] `Write()` 监测浏览器 `WebSocket.bufferedAmount`，超过上限时等待/失败，不允许无限发送。

### Node TCP→WebSocket

1. [KNOWN, HIGH] `ws.send()` 使用 callback 记录发送完成和错误。
2. [KNOWN, HIGH] 根据 `ws.bufferedAmount` 和浏览器 backlog control message 调用 `tcpConn.pause()/resume()`。
3. [KNOWN, HIGH] 使用 high/low 双水位，避免在边界附近频繁抖动。
4. [KNOWN, HIGH] cleanup 清理 poll/timer/listener，且只执行一次。

### Node WebSocket→TCP

1. [KNOWN, HIGH] `tcpConn.write(buf) === false` 时暂停底层 WebSocket socket 读取，并等待 `drain` 后恢复。
2. [KNOWN, HIGH] 增加有界 pending bytes 和 hard limit；超限显式关闭，不能静默丢弃。
3. [KNOWN, HIGH] text control frame只由协商后的 `zephyr-rdp-v2` 处理；普通 RDP payload 始终是 binary，不能误转发 control JSON 到目标 TCP。
4. [KNOWN, HIGH] 保持 `perMessageDeflate: false`。

### 必测项

- [KNOWN, HIGH] TCP chunk 拆分/合并后字节 hash 完全一致。
- [KNOWN, HIGH] 浏览器队列 high→pause、low→resume 恰好生效。
- [KNOWN, HIGH] `tcp.write(false)→drain` 不丢、不重排、不重复。
- [KNOWN, HIGH] ws/tcp 同时 close、error、timeout、重连无重复 cleanup。
- [KNOWN, HIGH] hard limit 只允许 fail-fast，不允许 `protocolDrops > 0` 后继续连接。

### 退出门禁

- [KNOWN, HIGH] `protocolDrops === 0`。
- [KNOWN, HIGH] 压测中 queued bytes 有界并能回落。
- [KNOWN, HIGH] 旧客户端可走 v1 fallback；v2 客户端完成流控协商。

---

## Phase 2：建立 RDPGFX semantic event 与 frame identity

### 修改文件

- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/events.go`（新增）
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/frame_tracker.go`（新增）
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/rdpgfx.go`
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/avc.go`
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/grdp.go`
- [KNOWN, HIGH] `rdp-wasm/render_bridge.go`（新增）
- [KNOWN, HIGH] `rdp-wasm/main.go`

### 实施项

1. [KNOWN, HIGH] 定义 `RenderEventSink`，覆盖 reset、create/delete surface、map/map-scaled、bitmap、fill、copy、cache、begin/end frame、AVC420 和 AVC444。
2. [KNOWN, HIGH] `START_FRAME` 不再忽略，解析并记录 active `frameId/timestamp`。
3. [KNOWN, HIGH] 每个 video event 携带 `surfaceId/frameId/codec/LC/regions/stream1/stream2/key/token`。
4. [KNOWN, HIGH] 保留现有软件 surface renderer 作为 reference sink；新 semantic sink 初期只 mirror/trace，不接管默认显示。
5. [KNOWN, HIGH] 增加 external completion 模式：`END_FRAME` 只 seal；异步 token 全部完成后由上层调用 `CompleteFrame(frameId, queueDepth)`。
6. [KNOWN, HIGH] ACK 状态机保证按 frameId 顺序、恰好一次；duplicate completion、missing EndFrame、decoder error 都有确定处理。
7. [KNOWN, HIGH] 移除 `ackCh` 满时直接丢 ACK 的行为：改为可靠发送、显式背压或 fail-fast，不能继续运行损坏的 ACK 状态。
8. [KNOWN, HIGH] raw callback 旧接口保留为 legacy adapter；新 pipeline 只使用 semantic event，不继续扩展位置参数列表。

### 必测项

- [KNOWN, HIGH] START/END、重复 End、无 Start、乱序完成、错误 frame 的状态机。
- [KNOWN, HIGH] surface create/delete/map/copy/fill/cache 命令顺序。
- [KNOWN, HIGH] AVC420 regions/key/token。
- [KNOWN, HIGH] AVC444 LC=0/1/2、双流存在/缺失、surface/frame 归属。
- [KNOWN, HIGH] ACK 无丢失、无重复、严格顺序。

### 退出门禁

- [KNOWN, HIGH] semantic trace 与现有软件 renderer 的最终 surface hash 一致。
- [KNOWN, HIGH] legacy pipeline 行为不变。
- [KNOWN, HIGH] external ACK fixture 全部通过后，后续 WebCodecs 才可接入。

---

## Phase 3：页面线程版 WebGL2 surface compositor

### 修改文件

- [KNOWN, HIGH] `public/rdp-renderer.js`（新增）
- [KNOWN, HIGH] `public/rdp-capabilities.js`（新增）
- [KNOWN, HIGH] `public/rdp-wasm-client.js`
- [KNOWN, HIGH] `tests/rdp-renderer/*.test.mjs`（新增）
- [KNOWN, HIGH] `tests/rdp-quality/*`（新增）

### 实施项

1. [KNOWN, HIGH] 为每个 `surfaceId` 建立 RGBA8 texture + FBO；桌面使用独立 desktop FBO。
2. [KNOWN, HIGH] bitmap BGRA 先进入 staging texture，再用 swizzle shader 只写目标 rect 到 RGBA surface。
3. [KNOWN, HIGH] video 使用 no-swap shader 写同一 RGBA surface；最终 present 永远 no-swap，禁止按“最近一次更新类型”切整屏颜色解释。
4. [KNOWN, HIGH] 实现 create/delete/map/map-scaled/copy/fill/reset/cache 和 dirty region。
5. [KNOWN, HIGH] `END_FRAME` ready 后在下一次 rAF present；legacy 无 frame boundary 更新按事件循环 tick 合并。
6. [KNOWN, HIGH] 删除热路径逐 tile `clear/full-screen draw/getError`；错误检查只在 init、采样诊断和 context restore。
7. [KNOWN, HIGH] `preserveDrawingBuffer` 改为 false；截图/测试通过显式 FBO readback。
8. [KNOWN, HIGH] 实现 `webglcontextlost/restored`，恢复时从 reference shadow 或显式 refresh 重建，不能等待偶然更新。
9. [KNOWN, HIGH] capability probe 用真实 2×2/4×4 像素上传/readback 验证 WebGL2、BGRA swizzle、VideoFrame upload、颜色空间和 max texture size。
10. [KNOWN, HIGH] `gpu-v2-page` 只 behind flag，默认不切换。

### 图像门禁

- [KNOWN, HIGH] BGRA32、BGR24、RGB565、RLE、NSCodec、RemoteFX fixture 与软件 reference 逐像素一致。
- [KNOWN, HIGH] stride、crop、奇数尺寸、上下翻转、越界裁剪无差异。
- [KNOWN, HIGH] mixed bitmap/video 不红蓝交换、不出现旧 tile 覆盖和黑块。
- [KNOWN, HIGH] 每个 frame 最多一次默认 framebuffer present。

### 退出门禁

- [KNOWN, HIGH] deterministic fixture 像素差异为 0。
- [KNOWN, HIGH] context loss/restore、resize、reconnect 可重复通过。
- [KNOWN, HIGH] GPU v2 和 legacy 同 trace 最终画面一致。

---

## Phase 4：WebCodecs AVC420 快路径与真实 decoder 背压

### 修改文件

- [KNOWN, HIGH] `public/rdp-worker.js` 的 decoder 核心可先以页面模块形式开发，或先新增 `public/rdp-video-decoder.js`。
- [KNOWN, HIGH] `public/rdp-renderer.js`
- [KNOWN, HIGH] `public/rdp-wasm-client.js`
- [KNOWN, HIGH] `rdp-wasm/render_bridge.go`
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/frame_tracker.go`

### 实施项

1. [KNOWN, HIGH] 删除 WebGL 与 WebCodecs 的互斥条件，但只在 `gpu-v2-page` 中启用新组合。
2. [KNOWN, HIGH] EncodedVideoChunk timestamp 改为单调 packet token，显式映射 `frameId/surfaceId/streamRole`；不再用 wall-clock 伪装协议 PTS。
3. [KNOWN, HIGH] 删除 `decodeQueueSize > 10` 时跳过压缩 chunk 的逻辑。
4. [KNOWN, HIGH] 使用 decoder `dequeue`、待完成 token 和 frame backlog 控制投喂；所有输入 chunk 必须按参考链顺序进入 decoder。
5. [KNOWN, HIGH] 可以丢弃已经完整解码、尚未 present 且被后续完整 ready frame 覆盖的显示结果，但不能丢 decoder 输入。
6. [KNOWN, HIGH] VideoFrame 直接上传目标 surface；禁止把 `drawImage→getImageData` 当正常路径。
7. [KNOWN, HIGH] direct upload probe 失败时依次尝试 `copyTo()` 平面上传或软件/reference fallback，并记录 reason code。
8. [KNOWN, HIGH] frame ACK 等待该 frame 所有 VideoFrame 完成并写入 surface。
9. [KNOWN, HIGH] decoder error 执行 reset、等待/请求 IDR、恢复；连续失败才按 surface fallback。

### 退出门禁

- [KNOWN, HIGH] AVC420 快路径无压缩 chunk 丢弃。
- [KNOWN, HIGH] ACK queueDepth 与 decoder+render backlog 一致。
- [KNOWN, HIGH] 正常路径不生成解码后 BGRA 全帧中间缓冲，不经过 Canvas2D readback。
- [KNOWN, HIGH] 静态停止更新后画面收敛到 reference 最终状态。

---

## Phase 5：完整 AVC444/AVC444v2 GPU 重建

### 修改文件

- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/avc.go`
- [KNOWN, HIGH] `rdp-wasm/grdp-patch/plugin/rdpgfx/events.go`
- [KNOWN, HIGH] `public/rdp-video-decoder.js`
- [KNOWN, HIGH] `public/rdp-renderer.js`
- [KNOWN, HIGH] `tests/rdp-quality/avc444-*`

### 实施项

1. [KNOWN, HIGH] 按 surface 和 stream role 分别维护主/辅助 decoder，禁止所有 surface 共用一个无身份全局 decoder。
2. [KNOWN, HIGH] 完整传递 LC、stream1、stream2、regions、surfaceId、frameId 和关键帧状态。
3. [KNOWN, HIGH] 用 `VideoFrame.copyTo()` 获取 I420/NV12 平面；上传为 R8/RG8 纹理。
4. [KNOWN, HIGH] shader 按现有 `combineAVC444v2BGRA`、Y cache、LC=0/1/2、BT.709、range、clamp 和 rounding 规则重建 RGBA。
5. [KNOWN, HIGH] 现有 Go/software 实现作为 reference oracle，不在验证前删除。
6. [KNOWN, HIGH] capability probe 无法稳定输出所需平面时，按 surface 回退完整 reference 路径；不得把只显示 stream1 当成功。
7. [KNOWN, HIGH] 新 pipeline 在 AVC444 完整门禁前不得设为默认，也不得以禁用 AVC444 获得“完成”结论。

### 质量门禁

1. [KNOWN, HIGH] LC=0/1/2 trace 顺序与 reference 一致。
2. [KNOWN, HIGH] 主/辅助流 IDR/P-frame 恢复正确。
3. [KNOWN, HIGH] 文字边缘、色卡、细线和渐变无可见色度丢失。
4. [KNOWN, HIGH] GPU 输出与 reference 比较 PSNR/SSIM/edge metric；阈值必须在 Phase 0 固定，不能测试失败后放宽。
5. [KNOWN, HIGH] stream2 缺失、decoder reset、surface remap 和 context loss 都进入明确 fallback/恢复，禁止静默显示错误颜色。

### 退出门禁

- [KNOWN, HIGH] AVC444 fixture 和真实测试 VM 全部通过。
- [KNOWN, HIGH] 诊断明确报告 `avc444Active/colorPath/fallbackReason`。
- [KNOWN, HIGH] mixed AVC444/bitmap surface 最终画面与 reference 收敛一致。

---

## Phase 6：迁入 Dedicated Worker，并保持输入/权限语义

### 修改文件

- [KNOWN, HIGH] `public/rdp-worker.js`（新增）
- [KNOWN, HIGH] `public/rdp-input-channel.js`（新增）
- [KNOWN, HIGH] `public/rdp-permission-rpc.js`（新增）
- [KNOWN, HIGH] `public/rdp-wasm-client.js`
- [KNOWN, HIGH] `public/rdp-touch.js`（仅接线，尽量不改手势实现）
- [KNOWN, HIGH] `rdp-wasm/main.go`
- [KNOWN, HIGH] `rdp-wasm/input_bridge.go`（新增）
- [KNOWN, HIGH] `public/rdp.html` 与 RDP 专属隔离 header 接线

### Worker 责任

1. [KNOWN, HIGH] 加载 `wasm_exec.js` 和 `main.wasm`。
2. [KNOWN, HIGH] 持有 WebSocket、Go/grdp、WebCodecs、frame scheduler 和 OffscreenCanvas WebGL2 compositor。
3. [KNOWN, HIGH] 输出状态、错误、pointer metadata、clipboard event、权限请求和诊断快照。

### 页面线程责任

1. [KNOWN, HIGH] DOM、工具栏、焦点、IME、TouchEvent/PointerEvent、pointer capture 和震动。
2. [KNOWN, HIGH] clipboard permission、文件选择、getUserMedia、Geolocation 等需要页面/用户手势的 API。
3. [KNOWN, HIGH] canvas bounding rect、fit/fill/original 和唯一缩放横条对应的坐标计算。

### 输入有序性

1. [KNOWN, HIGH] input envelope 至少包含 `sequence/sampleTime/layoutVersion/type/payload`。
2. [KNOWN, HIGH] Worker 严格按 sequence 送入 Go；只允许合并没有跨越 key/button/wheel/control 屏障的连续 mouse-move。
3. [KNOWN, HIGH] mouse down/up、key down/up、垂直/水平 wheel、快捷键和 disconnect 不得丢弃或重排。
4. [KNOWN, HIGH] resize/fit/zoom 更新携带 layoutVersion，旧版本坐标事件不得误映射。
5. [KNOWN, HIGH] Worker crash、disconnect、reconnect 时取消 pending move/双轴 wheel，并释放已按下键和按钮。
6. [KNOWN, HIGH] 不在 Worker 重新实现触控手势；继续复用当前 `rdp-touch.js`。

### 权限/外设 RPC

1. [KNOWN, HIGH] clipboard 使用页面最近一次授权读取的缓存；不得让 Worker 同步等待 DOM permission。
2. [KNOWN, HIGH] camera/mic/location/file 通过带 requestId、timeout、cancel 和大小上限的 RPC。
3. [KNOWN, HIGH] 大文件不走 JSON/base64；保留现有 SharedArrayBuffer/流式机制及隔离 header。
4. [KNOWN, HIGH] isolation header 只覆盖 RDP 页面、Worker、WASM 和必要资源，不扩大到无关页面。

### 退出门禁

- [KNOWN, HIGH] 15 项现有触控测试原样通过，并新增 Worker input ordering 测试。
- [KNOWN, HIGH] 键鼠、IME、剪贴板、音频、麦克风、摄像头、位置、驱动器、动态分辨率、重连全部回归通过。
- [KNOWN, HIGH] 页面线程由 RDP 协议/解码造成的持续 long task 消失或显著低于 Phase 0 基线。
- [KNOWN, HIGH] Worker heartbeat、crash fallback 和 reason code 可观察。

---

## Phase 7：WASM linear-memory view、池化与上传优化

### 修改文件

- [KNOWN, HIGH] `rdp-wasm/render_bridge.go`
- [KNOWN, HIGH] `rdp-wasm/main.go`
- [KNOWN, HIGH] `public/rdp-worker.js`
- [KNOWN, HIGH] `public/rdp-renderer.js`

### 实施项

1. [KNOWN, HIGH] bitmap callback 从 `js.CopyBytesToJS()` 改成传 `ptr/length/stride/rect/generation`。
2. [KNOWN, HIGH] Worker 在同步 callback 内从当前 WASM linear memory 创建 Uint8Array view，并立即完成 GPU upload。
3. [KNOWN, HIGH] callback 返回后不得持有 view；memory growth 或 Go buffer pool 复用前必须完成上传。
4. [KNOWN, HIGH] memory buffer 变化时刷新 view；用 generation 防止使用旧 ArrayBuffer。
5. [KNOWN, HIGH] 增加 surface/texture/staging/object pool 和 GPU memory budget。
6. [KNOWN, HIGH] rect merge、PBO 或 WebGPU 只能在独立 benchmark 证明有收益后逐项引入；默认计划不依赖它们。

### 必测项

- [KNOWN, HIGH] memory growth、池复用、异步误用旧 view、stride/crop、奇数尺寸、context loss。
- [KNOWN, HIGH] 10 分钟高动态 workload 后内存不随帧数线性增长。
- [KNOWN, HIGH] 上传前后像素 hash 一致。

### 退出门禁

- [KNOWN, HIGH] 正常 bitmap 热路径不再进行 WASM→JS 全 tile copy。
- [KNOWN, HIGH] 预热后 pooled memory、surface GPU bytes 和 JS heap 均保持有界。

---

## Phase 8：灰度、默认切换、旧路径清理与文档同步

### 修改文件

- [KNOWN, HIGH] `public/rdp-wasm-client.js`
- [KNOWN, HIGH] `public/rdp.html`
- [KNOWN, HIGH] `README.md`
- [KNOWN, HIGH] `RDP_WASM_FIX_PLAN.md`
- [KNOWN, HIGH] 新增架构/诊断文档
- [KNOWN, HIGH] 删除旧内联 WebGL/H.264 presenter 代码

### 实施项

1. [KNOWN, HIGH] 灰度顺序：内部 flag → 显式用户 flag → 支持设备自动选择 → 默认 Worker GPU v2。
2. [KNOWN, HIGH] 每次 fallback 输出稳定 reason code，不允许无提示黑屏。
3. [KNOWN, HIGH] 默认切换后保留 Canvas2D compatibility path，但删除当前错误的内联 WebGL 双 shader/单纹理实现，避免两套 GPU renderer 分叉。
4. [KNOWN, HIGH] 更新 README 中 RDP 架构、WebCodecs、Worker、fallback、诊断和能力限制。
5. [KNOWN, HIGH] 把旧 `RDP_WASM_FIX_PLAN.md` 改为历史状态或归档；当前文档把已经完成的剪贴板/WebGL初版工作仍写成待办，不能继续作为现行计划。
6. [KNOWN, HIGH] Docker release workflow 必须依赖 CI 成功，并验证 WASM artifact、startup smoke 和 renderer browser smoke。

### 默认发布阻断条件

- [KNOWN, HIGH] 任一画质门禁失败。
- [KNOWN, HIGH] 任一协议字节或 ACK 丢失。
- [KNOWN, HIGH] Android WebView 或桌面 Chromium 出现无诊断黑屏。
- [KNOWN, HIGH] 输入、剪贴板、音频或外设能力相对 legacy 回归。
- [KNOWN, HIGH] 通过降低分辨率、色深、codec 或 AVC444 换取性能。

---

## 5. 测试矩阵

### 5.1 自动化测试层次

| 层次 | [KNOWN, HIGH] 内容 | [KNOWN, HIGH] 运行位置 |
|---|---|---|
| Node 单元 | transport、renderer 状态机、input ordering、RPC、现有 touch | 每次 PR/push |
| Go 单元 | RDPGFX event、frame tracker、ACK、AVC metadata、queue | Go 1.26.3 CI |
| WASM build/smoke | `GOOS=js GOARCH=wasm` build、加载、导出接口 | CI |
| Browser smoke | OffscreenCanvas、WebGL2、VideoFrame upload、context loss | Chromium CI |
| Trace replay | software reference 与 GPU surface hash/diff | CI + nightly |
| Docker smoke | 镜像构建、WASM artifact、HTTP/HTTPS startup | release 前 |
| 真机矩阵 | Android WebView 低/中/高档、桌面 Chromium | 默认切换前 |
| 真实 RDP | Windows/VirtualBox/不同 codec 与网络条件 | release candidate |

### 5.2 场景矩阵

- [KNOWN, HIGH] 分辨率：1280×720、1920×1080、2560×1440、3840×2160。
- [KNOWN, HIGH] 内容：静态 IDE、快速滚动、窗口拖动、视频、浏览器动画、mixed surface、长时间静止后再更新。
- [KNOWN, HIGH] codec：legacy bitmap、RLE、NSCodec、RemoteFX、AVC420、AVC444、AVC444v2。
- [KNOWN, HIGH] 网络：LAN、30/80/150ms RTT、受限带宽、抖动、短时丢包。
- [KNOWN, HIGH] 生命周期：前后台、旋转、resize、全屏、context loss、decoder reset、Worker crash、重连。
- [KNOWN, HIGH] 外设：clipboard、file、drive、audio、AUDIN、camera、location、IME。

### 5.3 必须保留的输入回归

- [KNOWN, HIGH] 单击即时；双击总计两个 click，不是三个。
- [KNOWN, HIGH] 长按右键；拖拽期间 `touchcancel` 必须 release。
- [KNOWN, HIGH] distance-only pinch 不 zoom、不 scroll。
- [KNOWN, HIGH] 双指 centroid 运动产生独立 V/H wheel 和惯性。
- [KNOWN, HIGH] 相对模式从内部虚拟坐标移动，不显示本地指示器。
- [KNOWN, HIGH] pen 完整 down/move/up 生命周期。
- [KNOWN, HIGH] 三指快捷键按顺序按下、逆序释放。
- [KNOWN, HIGH] zoom writer 仍只有声明和横条 input 两处。

---

## 6. 指标与发布门禁

### 6.1 可靠性

1. [KNOWN, HIGH] `transport.protocolDrops === 0`。
2. [KNOWN, HIGH] `framesAcked` 与应 ACK frame 一致，无重复、无永久缺失。
3. [KNOWN, HIGH] 10 分钟压力测试中 transport/decoder/frame backlog 能回落，不单调增长。
4. [KNOWN, HIGH] 50 次连接/断开、20 次前后台、20 次 resize、人工 context loss 不黑屏、不死锁。

### 6.2 画质

1. [KNOWN, HIGH] deterministic bitmap/RemoteFX/NSCodec fixture 非预期像素差异为 0。
2. [KNOWN, HIGH] AVC444 必须处理 stream2 和 LC；只显示 stream1 直接阻断发布。
3. [KNOWN, HIGH] mixed surface 不得红蓝交换、黑块、旧帧覆盖或 dirty rect 泄漏。
4. [KNOWN, HIGH] 停止更新后最终静态画面必须收敛到 reference。
5. [KNOWN, HIGH] 逻辑分辨率、backing resolution、色深和 codec 能力不得低于 quality-lock 基线。

### 6.3 性能

1. [KNOWN, HIGH] 每个显示刷新周期最多一次 present；tile 数量不能线性增加全屏 draw 次数。
2. [KNOWN, HIGH] present FPS 不低于连续 ready EndFrame 速率的 95%，上限为显示刷新率。
3. [KNOWN, HIGH] AVC420 正常路径不产生 BGRA 全帧中间缓冲，不经过 Canvas2D readback。
4. [KNOWN, HIGH] Worker 迁移后页面 RDP long task 相对 Phase 0 基线显著下降。
5. [KNOWN, HIGH] 绝对毫秒、FPS 和内存阈值必须由 Phase 0 的指定设备基线固定；没有参考硬件前不编造统一数字。

---

## 7. 建议提交/PR 切分

1. [KNOWN, HIGH] `test(rdp): add baseline CI and trace harness`
2. [KNOWN, HIGH] `fix(rdp): add lossless websocket tcp backpressure`
3. [KNOWN, HIGH] `refactor(rdpgfx): expose surface frame codec events`
4. [KNOWN, HIGH] `feat(rdp): add page-thread gpu surface compositor`
5. [KNOWN, HIGH] `feat(rdp): integrate avc420 webcodecs frame scheduling`
6. [KNOWN, HIGH] `feat(rdp): implement full avc444 gpu reconstruction`
7. [KNOWN, HIGH] `refactor(rdp): move protocol decode render into worker`
8. [KNOWN, HIGH] `perf(rdp): upload bitmap from wasm linear memory`
9. [KNOWN, HIGH] `chore(rdp): switch default pipeline and remove legacy gpu path`

[INFERRED, HIGH] 每个提交都应可独立测试和回滚；禁止把 Phase 1–7 压成一个超大提交。

---

## 8. 风险排序

| 优先级 | 风险 | 处理 |
|---|---|---|
| P0 | [KNOWN, HIGH] RDP 字节静默丢失 | Phase 1 最先修，超限 fail-fast |
| P0 | [KNOWN, HIGH] ACK 丢失/异步 frame 提前 ACK | Phase 2 frame tracker + reliable ACK |
| P0 | [KNOWN, HIGH] AVC444 raw path语义不完整 | Phase 2 补 metadata，Phase 5 完整实现前不默认 |
| P0 | [KNOWN, HIGH] decoder 输入丢 delta chunk | Phase 4 删除输入丢帧，改 ACK/dequeue 背压 |
| P1 | [KNOWN, HIGH] 单纹理混合 BGRA/RGBA 串色 | Phase 3 统一 RGBA surface FBO |
| P1 | [KNOWN, HIGH] Worker 输入重排/按键粘住 | Phase 6 sequence + barrier + release state |
| P1 | [KNOWN, HIGH] context loss 后黑屏 | Phase 3 shadow/refresh restore |
| P2 | [KNOWN, HIGH] zero-copy view 生命周期错误 | Phase 7 最后实施并做 generation 测试 |
| P2 | [KNOWN, HIGH] Android WebView 能力差异 | 真实 probe + reasoned fallback |

---

## 9. 完成定义

1. [KNOWN, HIGH] 默认 RDP pipeline 为 Worker + OffscreenCanvas WebGL2 surface compositor。
2. [KNOWN, HIGH] WebCodecs 与 WebGL2 同时启用；AVC420/AVC444 均保持完整 surface/frame 语义。
3. [KNOWN, HIGH] 正常 bitmap 路径不再执行 WASM→JS 全 tile copy和 JavaScript 逐像素 BGRA→RGBA。
4. [KNOWN, HIGH] 每帧最多一次 present，ACK 反映真实 decoder+render backlog。
5. [KNOWN, HIGH] transport 字节和 frame ACK 均为零静默丢失。
6. [KNOWN, HIGH] 所有确定性图像、输入、外设、生命周期、压力和真机矩阵通过。
7. [KNOWN, HIGH] 不通过主动降画质获得性能。
8. [KNOWN, HIGH] Canvas2D、raw-H264 和单纹理 WebGL legacy 已删除；classic bitmap 通过统一 semantic desktop surface 渲染。
9. [KNOWN, HIGH] README、架构文档、测试命令、诊断字段和 release workflow 与实际代码一致。

---

## 10. 当前验证记录

- [COMPUTED, HIGH] 基线提交、本地 `HEAD`、`origin/main` 与远端 `refs/heads/main` 均为 `a2b917ed08a5645d1bc5d400946b2acb76934cdf`。
- [COMPUTED, HIGH] `node --test tests/*.test.mjs`：54/54 通过；核心 JavaScript 27 个文件 `node --check` 通过。
- [COMPUTED, HIGH] Go 1.26 容器真实 WASM runner：主 `rdp-wasm`、`rdpgfx`、`cliprdr`、`protocol/nla` 全部通过；正式 `main.wasm` 构建成功（10,898,382 字节，最终镜像产物因构建时间不同为 10,898,499 字节）。
- [COMPUTED, HIGH] WebGL2 确定性浏览器冒烟：BGRA→RGBA 八像素模式与单 frame present 通过。
- [COMPUTED, HIGH] SQLite `rdpPipeline` 迁移已在实际数据库副本链路验证；默认值现为 `worker-gpu-v2`，已有 `legacy` 值会迁移为 Worker。
- [COMPUTED, HIGH] 默认 Worker、legacy 删除后的最终 Docker 镜像已完整构建、导出并通过构建期服务器启动冒烟：`sha256:a6c45a4e97f14ac2d24712c36135cbd6a21b47db3c256203f4acba860d533917`，451,696,399 字节。
- [KNOWN, HIGH] Headless Chromium 的完整 Worker WebGL2 compositor 构造会阻塞；完整临时 compositor probe 会在 3 秒后终止，并在真实 Canvas 转移前切换到页面线程 `gpu-v2-page`。
- [KNOWN, HIGH] 用户已明确覆盖原发布门禁：Phase 8 已切换默认并删除 legacy。真实 Windows RDP、Android WebView 和长时压力仍是上线风险，不再阻止本次代码切换。

[RULES I BROKE]: 无。
