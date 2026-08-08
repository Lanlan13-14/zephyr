# Zephyr One RDP / VNC 原生移动体验规范

> [KNOWN] RDP 和 VNC 可以复用成熟 native protocol core，但不能把第三方客户端 UI、Web canvas 或桌面鼠标交互直接照搬进 Zephyr One。
>
> [KNOWN] RDP 当前首选 FreeRDP；VNC 候选是 LibVNCClient/TigerVNC/MultiVNC 类 RFB core，最终选型必须通过 M0 功能、许可证、iOS/Android、真机和 Zephyr fixture 门。

## 1. 方案结论

### RDP

- [KNOWN] FreeRDP 官方仓库使用 Apache-2.0，当前同时维护 `client/Android` 和 `client/iOS`，且有 Android/iOS channel/platform 代码。
- [INFERRED] One 复用 FreeRDP core、settings accessor、channel、证书和 protocol parsing；渲染 surface、连接状态、手势、工具栏、权限、文件授权和 Zephyr 设置 UI 自己实现。
- [KNOWN] 必须支持 Zephyr 已有 RDP 能力：TLS/NLA、domain、证书、分辨率、质量、FPS、音频、剪贴板、麦克风、摄像头、位置、storage/drive、direct/trackpad touch。

### VNC

- [KNOWN] LibVNCClient 提供成熟 RFB client、TLS/auth/encoding、Android cross-compile；TigerVNC 与 MultiVNC 提供成熟行为/移动参考。
- [KNOWN] LibVNC/TigerVNC/MultiVNC 是 GPL 系列，Zephyr 自身是 GPL-3.0-only，但仍需确认版本兼容、静态链接、App Store/Play 分发、源码/notice 和依赖链。
- [INFERRED] VNC 首选“共享 RFB core + Zephyr adapter”，而不是 noVNC WebView；若候选无法满足 iOS、许可证或内存门，才维护范围受控的自有 RFB core。

## 2. 共享 RemoteSurface 架构

```text
RemoteSessionController
 ├─ protocol adapter (FreeRDP / RFB)
 ├─ FrameMailbox (latest complete frame / dirty rects)
 ├─ RemoteSurface (SurfaceView/Metal/UIKit view)
 ├─ ViewportTransform (fit / zoom / pan / rotation)
 ├─ PointerController (direct / trackpad / hardware mouse)
 ├─ KeyboardController (IME / hardware / modifiers)
 ├─ ClipboardBridge
 ├─ ChannelController (audio/mic/camera/location/drive)
 ├─ Certificate/TrustController
 └─ SessionChromeController
```

- [KNOWN] protocol callback 不直接操作 Compose/SwiftUI state；通过 bounded mailbox/actor 交付 dirty rect、cursor、status 和 channel event。
- [INFERRED] UI thread/GPU thread只消费最新可显示 frame；积压时丢过时 video frame，不丢 input、clipboard、resize 或 channel control。
- [INFERRED] protocol core 不知道浮岛、sheet、主题或 navigation。

## 3. 屏幕布局

### 3.1 沉浸 surface

- [KNOWN] RDP/VNC session 默认 edge-to-edge，framebuffer 是主内容；root 四入口浮岛隐藏。
- [INFERRED] 顶部只保留可自动隐藏的状态 pill：connection name、网络/质量、录入模式；点击显示完整 chrome。
- [INFERRED] 底部 session dock：键盘、pointer mode、modifiers、clipboard、display、channels/files、more、disconnect。
- [INFERRED] chrome 叠加在 surface，不 resize remote desktop；只有系统 IME 改变可用 viewport时，根据用户策略 resize 或 pan-to-caret。

### 3.2 手机与平板

- [INFERRED] 手机一次显示一个 remote session，不切四格缩略操作；session switcher 用 sheet/edge-safe horizontal switch。
- [INFERRED] 平板可 split 两 session，但每个 pane 达到最小交互尺寸；不足自动退回单 session + thumbnail switcher。
- [INFERRED] 外接显示器可把 remote session 放外屏，本机保留控制/会话页；这是增强项，不降低主屏功能。

## 4. Viewport 模式

| 模式 | 语义 | 默认场景 |
| --- | --- | --- |
| Fit | [INFERRED] 整个远程桌面适配 viewport，可能留边 | 首次连接/观察 |
| Fill width | [INFERRED] 宽度填满，垂直可 pan | 文档/桌面 |
| 1:1 | [INFERRED] 远程像素对应设备逻辑/物理策略 | 精细检查 |
| Custom zoom | [INFERRED] pinch 后保持用户 scale/anchor | 交互 |
| Dynamic resolution | [KNOWN] 请求服务器匹配可用 viewport | RDP 支持时首选 |

- [INFERRED] pinch 缩放围绕双指焦点，双指平移，双击在 fit 与最近 zoom 间切换。
- [INFERRED] transform 每帧 1:1 跟手；释放只对 pan 边界/惯性使用平台 decay/spring。
- [INFERRED] rubber band 只用于 viewport 超出边界的视觉阻力，释放回合法范围；远程 pointer 坐标只在合法 transform 中计算。
- [KNOWN] orientation/IME/split resize 不能把 pointer 映射留在旧矩阵。

## 5. 两种触控模式

### 5.1 Direct touch

- 单指 tap = remote primary click；drag = remote drag。
- long press = remote secondary click，进入前 haptic；可在设置交换行为。
- 双指 scroll = remote wheel；pinch = local viewport zoom，优先于 remote gesture。
- [INFERRED] direct 模式适合 Windows touch UI/大目标；不把手指位置做加速度偏移。

### 5.2 Trackpad

- 单指移动 = 相对 pointer move，不按下。
- 单指 tap = left click；double tap + drag = drag lock。
- 双指 tap = right click；双指 drag = wheel；pinch = viewport zoom。
- 三指/额外手势默认不占用系统导航；用户可自定义但不能覆盖 edge-back/home。
- [INFERRED] pointer acceleration 使用稳定曲线并提供 0.5–2.5 sensitivity；切模式保留 remote cursor，不跳到手指位置。

### 5.3 Mouse / trackpad hardware

- [KNOWN] primary/secondary/middle、wheel、hover、relative movement、button chord 必须直通。
- [INFERRED] Android pointer capture/iPad pointer APIs 只在用户进入 capture mode 后启用，Esc/系统 gesture 可退出。
- [INFERRED] hover 显示 remote cursor，不自动显示整套 chrome。

## 6. 键盘

- [INFERRED] 点 keyboard action 显示系统 IME + 一行 remote modifier bar：Ctrl/Alt/Shift/Win/Cmd/Esc/Tab/arrows。
- [INFERRED] RDP 默认把平台 Meta 映射到 Win；VNC 按 X key mapping；映射可查看和修改。
- [INFERRED] system IME 文本通过 Unicode/text channel；程序级 key shortcut 通过 scan/key code，不把 Ctrl+C 当普通字符串。
- [KNOWN] IME 出现时默认不把 remote desktop永久改分辨率：RDP 提供 `resize remote / pan to cursor` 用户策略；VNC 通常 pan viewport。
- [INFERRED] hardware keyboard 不显示软 modifier bar，除非用户固定显示。

## 7. Clipboard

- [KNOWN] 只有连接启用 clipboard 且用户/ACL允许时桥接。
- [INFERRED] 文本 clipboard 默认询问/本次允许/总是允许策略；图片/文件显示大小和方向，避免后台静默复制大对象。
- [INFERRED] remote→local 不在后台读取/覆盖系统 clipboard；显示“远程剪贴板可用”action，由用户确认写入。
- [KNOWN] clipboard 内容不写日志、analytics 或同步 feed。

## 8. Channels 与权限

| Channel | One 行为 |
| --- | --- |
| Audio playback | [KNOWN] 会话级开关；显示实际输出 route；后台按平台 audio policy |
| Microphone | [KNOWN] 远端实际请求时申请权限；状态 pill 常驻可见；一键 mute |
| Camera | [KNOWN] 实际请求时申请；前/后摄像头选择；系统 privacy indicator |
| Location | [KNOWN] 实际请求时申请；精确/近似按平台结果，不伪造 |
| Drive/files | [KNOWN] 用户显式选择目录；显示 read-only/read-write 和授权状态 |
| Clipboard | [KNOWN] 独立开关；拒绝不终止整个 session |

- [KNOWN] 权限拒绝只关闭对应 channel；protocol 能继续则 session 保持。
- [INFERRED] 永久拒绝显示系统设置 deep link；不连续弹权限框。

## 9. RDP Drive 与 VNC 文件边界

- [KNOWN] RDPDR drive 复用 Zephyr `FileSyncShareProfile`，Android SAF/iOS bookmark 是本机授权，不能跨设备复制。
- [KNOWN] `readOnly` 在 provider 层拒绝 open-write/write/truncate/mkdir/delete/rename；不能只显示开关。
- [KNOWN] FreeRDP 映射前要验证路径/授权；不可用返回 `file_share_unavailable`，不能把整个连接压成 generic error。
- [KNOWN] 标准 VNC/RFB 不等于 RDP drive；若服务器/扩展没有 file transfer，VNC 页面不伪造“远程磁盘”。One 仍可通过 Zephyr/SFTP 文件能力处理同一主机文件。

## 10. Certificate 与安全

### RDP

- [KNOWN] 首次证书显示 subject、issuer、validity、SHA-256 fingerprint；信任按 server profile/host/port 保存。
- [KNOWN] 证书变化默认阻断，不能普通 toast 一键忽略。
- [INFERRED] NLA/认证失败、TLS policy、CredSSP、证书错误分开报告。

### VNC

- [KNOWN] unknown security type 明确拒绝，不降级到未知弱模式。
- [INFERRED] TLS/VeNCrypt/X509 等按 core capability 列表显示；不把普通 VNC password 描述成强加密。

## 11. Frame/render 性能

- [INFERRED] Android 优先 SurfaceView/HardwareBuffer/OpenGL/Vulkan 中经 spike 证明的一条；iOS 优先 Metal layer。Compose/SwiftUI 只承载 host 与 chrome。
- [INFERRED] dirty rect merge 有上限；rect 太多时单帧退化为 bounding/full frame，下一帧恢复，不长期 full-copy。
- [INFERRED] 像素格式转换、解码和颜色转换不在 main thread；cursor 可独立 layer，避免每次移动重绘 framebuffer。
- [INFERRED] mailbox 最大 2–3 个 frame；display latest，统计 dropped frames。输入 event 独立高优先队列并 coalesce move，不 coalesce down/up/key。
- [INFERRED] quality/FPS 是目标；UI 显示 negotiated/actual resolution、codec/encoding、FPS、latency、drop。

## 12. Session chrome 与动画

- [INFERRED] tap 空白处切 chrome 显隐；pointer/drag 中不误触 chrome。
- [INFERRED] chrome 显隐 120–180ms opacity + 4–8pt offset，不 scale framebuffer，不改变 remote coordinate system。
- [INFERRED] mode switch 使用选中态/haptic，remote cursor 不做飞行动画。
- [INFERRED] disconnect sheet 跟系统 detent/back；连接重试状态在原 surface 上连续更新，不跳回首页再弹 modal。
- [KNOWN] gesture-driven viewport/sheet 动画必须可中断，从当前值继续；Reduce Motion 下去掉空间位移。

## 13. 错误与恢复

```text
resolving → connecting → tls/cert → authenticating → negotiating
→ first-frame → connected → degraded → reconnecting → disconnected
```

- [INFERRED] 每阶段有具体错误和 elapsed time；首帧超时与 TCP connect timeout 分开。
- [INFERRED] 网络切换后可自动重连，使用同 session definition；credential/ACL/Token revoked 则停止并要求处理。
- [KNOWN] 本地 viewport/keyboard/mode 可以恢复；不伪称恢复远端未保存进程状态。

## 14. M0 功能/许可证门

### FreeRDP

- [KNOWN] 以官方 master/固定 release source + Apache-2.0 为候选；版本、patch SHA、build flags 和 notices 进入 lockfile。
- [INFERRED] Android/iOS 各验证 TLS/NLA、证书、graphics、dynamic resolution、clipboard、audio、input、RDPDR；mic/camera/location 若上游平台实现不足，写 adapter/patch，不删 Zephyr 开关。

### VNC

- [INFERRED] 对 LibVNCClient、TigerVNC core、MultiVNC-derived mobile adapter 做同一矩阵：RFB versions、Raw/CopyRect/Hextile/ZRLE/Tight、TLS/security types、clipboard、pointer/key、dirty rect、取消、iOS build。
- [KNOWN] 任何 GPL 候选先过许可证清单；“仓库也是 GPL”不自动替代 App Store/依赖合规审核。

## 15. 真机验收

- [INFERRED] Windows Server/Windows 10/11 RDP；xrdp/FreeRDP shadow；不同 DPI/分辨率；弱网/旋转/后台。
- [INFERRED] TigerVNC/RealVNC/UltraVNC/libvncserver 常见服务器，覆盖 security/encoding 差异。
- [INFERRED] 手机 direct touch 完成窗口拖动、右键、滚动、文本选取；trackpad 完成精细 resize/菜单操作。
- [INFERRED] hardware keyboard/mouse、iPad trackpad、Android DeX/平板、多点触控。
- [INFERRED] 30 分钟连接无泄漏/ANR；快速切 50 次 session；frame/input queue bounded。
- [KNOWN] 缺任一 Zephyr 已承诺 channel/设置不能用“现成库不支持”作为正式版删项理由；要补 adapter、fork、替换库或阻断发布。
