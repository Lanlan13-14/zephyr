# Zephyr One 原生协议引擎决策

> [KNOWN] Zephyr 的业务行为必须继承；Node `ssh2`、Go/WASM RDP、noVNC 和 DOM 终端不能直接嵌入 Kotlin/Swift 原生 App。
>
> [INFERRED] 状态：M0 决策基线。候选必须完成 ABI、许可证、真机和 Zephyr fixture 验证后才能写入 lockfile；未验证的版本号不在本文伪造。

## ADR-001：共享 C 协议 core，双端原生 UI

**决定**：

- [INFERRED] Android/iOS 共用边界清晰的 C ABI adapter：terminal、RDP、VNC 可共享；平台网络、KeyStore/Keychain、Surface/UIView、音频、剪贴板和文件授权由平台层实现。
- [KNOWN] Android UI 是 Compose，iOS UI 是 SwiftUI；共享 core 不拥有导航、表单或 App 状态。
- [INFERRED] C ABI 只使用固定宽度整数、byte span、opaque handle 和 callback vtable；不跨 ABI 传 C++/Rust/Swift/Kotlin object。

**理由**：

- [KNOWN] Zephyr 已有跨协议一致字段、ACL、路由、错误和测试语义；共享 adapter 可减少 Android/iOS 行为分叉。
- [INFERRED] 两套完全独立协议实现会把证书、编码、IME、文件重定向和错误映射变成两套真源。

## ADR-002：SSH/SFTP

**决定**：

- [INFERRED] 首选共享 `libssh2` C core + Zephyr adapter；TLS/crypto backend 和算法集合在构建清单中显式固定。
- [INFERRED] 平台端提供 socket transport abstraction，使 direct、SOCKS5、HTTP CONNECT 和多级 SSH jump 共用 Zephyr route planner。
- [INFERRED] 若 M0 证明 `libssh2` 无法满足所需 host-key/agent/key 算法或八级 jump，备选是 Android SSHJ + iOS SwiftNIO SSH；切换需新 ADR，不允许悄悄分叉。

**必须通过**：

- RSA/Ed25519 key、encrypted private key、password、host-key unknown/change。
- SFTP list/stat/read/write/rename/delete、1 GiB、mtime conflict、取消。
- SOCKS5、HTTP CONNECT、1/2/8 级 jump。
- PTY xterm-256color、resize、UTF-8/CJK、大输出、断线重连。
- 与 Zephyr `resource-service` dependency/ACL 错误逐项映射。

## ADR-003：终端 parser 与 renderer

**决定**：

- [INFERRED] 不强求一套共享 terminal renderer。Android M0 首选评估 Termux `terminal-emulator` + `terminal-view`（其仓库明确说明这两个模块源自 Apache-2.0 Android Terminal Emulator 代码）；iOS M0 首选评估 MIT 的 SwiftTerm UIKit/Metal terminal。两端必须通过同一 VT/Unicode/IME/scrollback fixture，业务行为一致即可。
- [KNOWN] Termux 当前 App 整仓是 GPLv3-only；可借鉴交互和只在许可证审计后复用明确例外模块，不能把整套 Termux App/extra-keys UI 无选择复制进 One。SwiftTerm 提供 iOS UIView、Unicode/grapheme/BiDi、resize、hyperlink 和可选 Metal，但 selection/accessibility 完整性必须由 M0 实测，不能只信 README。
- [KNOWN] 不嵌 Web xterm iframe，不把隐藏 WebView 当 renderer。
- [KNOWN] 终端交互合同见 [`TERMINAL_EXPERIENCE.md`](TERMINAL_EXPERIENCE.md)：单一 SurfaceController、composition 不滚、IME 开合 rows/cols 同步、用户上滑不被输出抢回、extra keys/selection/hardware keyboard 完整。

**C ABI 最小面**：

```c
terminal_new / terminal_free
terminal_feed_utf8
terminal_resize
terminal_key / terminal_paste
terminal_snapshot_cells
terminal_cursor
terminal_dirty_regions
terminal_scrollback_read
```

## ADR-004：RDP

**决定**：

- [INFERRED] 首选 FreeRDP native client core，经 C adapter 接 Android Surface 和 iOS UIView/Metal；不继续移动端 Go/WASM pipeline。
- [INFERRED] 使用 FreeRDP accessor API，不读取内部 settings struct；adapter 隔离 FreeRDP 2/3 ABI 差异。
- [INFERRED] GDI/graphics update 转成 dirty rectangles，不每帧复制整屏；像素格式在 adapter 中固定并测试。
- [KNOWN] RDP 功能门：TLS/NLA、证书、动态分辨率、音频、剪贴板、输入、触控、麦克风、摄像头、位置、RDPDR drive。

**文件 drive**：

- [KNOWN] Zephyr UI 的 `readOnly` 必须落到 provider 操作检查；协议层没有可相信的单一“只读目录”产品开关。
- [INFERRED] provider 对 write/open-write/truncate/mkdir/delete/rename 返回明确 access denied；已打开 handle 在 policy 变只读时拒绝后续写并关闭写 handle。
- [INFERRED] 映射前验证目录授权仍有效；路径丢失/授权撤销返回 `file_share_unavailable`，不能让整个 session 只报 generic connect failed。

**上游与许可证证据**：

- [KNOWN] FreeRDP 官方仓库 README/LICENSE 声明 Apache-2.0；官方树同时包含 `client/Android` 与 `client/iOS`，2026-07 仍各有提交，说明移动 adapter 可作为实现和测试参考，不只是桌面 core。
- [KNOWN] Apache-2.0 不免除发布审计：必须固定 commit/version、保留 LICENSE/NOTICE、记录本地 patch、生成 SBOM，并审计其构建实际链接的 OpenSSL/FFmpeg/channel 等依赖许可证。
- [KNOWN] Zephyr One 不能直接采用 FreeRDP 示例 App 的 UI；只复用 core、channel、平台 glue 和测试经验，Compose/SwiftUI 浮层、手势、权限和状态仍按 One 合同实现。

**仓库内已有实证（桌面，不是移动端）**：

- [KNOWN] `main@851df26` 已把 Zephyr One 桌面壳的 WASM RDP 换成原生 FreeRDP：仓库存在 `zephyr_one/native/zephyr-one-rdp/`，含 C shim（`csrc/zephyr_rdp.{h,c}`）、Rust FFI（`src/ffi.rs`）、length-prefixed 协议（`src/proto.rs`）、C 单测和 e2e 脚本。
- [KNOWN] 该实现只面向 Linux/Windows/macOS 桌面；树内没有 Android Surface 或 iOS UIView/Metal 绑定，因此**不能据此宣称移动端 RDP 已实现**。
- [KNOWN] 它已验证了 ADR-004 的三个关键假设，可直接继承而不必重新试错：accessor-only settings API 可同时适配 FreeRDP 2/3；damage rect 增量上屏可行；GDI 为 BGRA32、需在 pack 阶段转 RGBA。
- [KNOWN] 已被实测证伪的两个默认行为必须在移动 adapter 复用同样修法：FreeRDP WLog 默认写 stdout 会冲垮二进制协议流（须在启动时隔离 fd1）；`freerdp_client_add_device_channel` 会 stat 映射路径，目录不存在即整体 settings 组装失败（须前置校验并返回具体错误码）。
- [INFERRED] 移动 adapter 应复用同一 C shim 与协议测试向量，只替换 surface/audio/输入/文件授权的平台层；分叉成第二套 C 代码属于回归。

## ADR-005：VNC

**决定**：

- [INFERRED] 首选共享 LibVNCClient 类 RFB core，经小 C adapter 输出 framebuffer dirty rect；TigerVNC/MultiVNC 作为行为、encoding、移动手势和互操作参考。若许可/移动稳定性不过门，选择其他成熟 core 或维护范围受控的 RFB adapter，不从 UI 层重写协议。
- [KNOWN] LibVNCClient/TigerVNC 当前仓库许可证为 GPL-2.0 系列，MultiVNC 为 GPL-3.0；Zephyr 本身 GPL-3.0-only 不等于组合一定自动兼容，必须审计具体版本、链接方式、依赖和 App Store 分发义务。
- [KNOWN] 不在原生 App 中嵌 noVNC 页面，也不照搬第三方 VNC viewer UI。

**必须通过**：RFB 3.3/3.7/3.8、常见 pixel format/encoding、增量更新、剪贴板、键鼠、认证失败、断线恢复、未知 security type 拒绝，以及 [`REMOTE_DESKTOP_EXPERIENCE.md`](REMOTE_DESKTOP_EXPERIENCE.md) 的 direct/trackpad/IME/弱网手势矩阵。

## ADR-006：Telnet

**决定**：

- [INFERRED] 直接移植 Zephyr `telnet-transport.js` 的 IAC 状态机与 fixture，不引入重量级库。
- [KNOWN] 支持 IAC、DO/DONT/WILL/WONT、SB/SE、ECHO、SGA、TTYPE、NAWS、BINARY；默认 terminal type `xterm-256color`。
- [KNOWN] UTF-8/GBK/Big5/Latin-1 编解码行为与 Zephyr 测试一致；密码只作 in-band auto-login。

## ADR-007：本地数据库

**决定**：

- [INFERRED] Android 使用 Room/SQLite；iOS 使用 GRDB/SQLite；两端共享 SQL fixture 与 migration expectation，不共享 ORM object。
- [KNOWN] WAL、事务、revision/cursor/pending op 必须由 SQLite 保证；普通 preferences 不保存镜像和 secret。
- [INFERRED] schema 逻辑真源见 `DATA_AND_MIGRATION.md`，平台 migration 不能自行删列或改默认。

## ADR-008：HTTP/WebSocket

**决定**：

- [INFERRED] Android 主网络栈固定 OkHttp；iOS 固定 URLSession。
- [KNOWN] 同一平台不能同时用两个主 HTTP 栈处理认证与 retry，避免 Cookie/SID/证书 pin 分叉。
- [INFERRED] 统一 adapter 实现 requestId、body limit、redirect credential stripping、一次 refresh、Retry-After 和 jitter backoff。

## ADR-009：密钥

**决定**：

- [KNOWN] 继承 Zephyr 已使用的 ML-KEM-768 方向做设备加密 envelope；另用 ES256 hardware-backed signing key 做 device proof。
- [INFERRED] Android 通过 NDK/经过审计的 PQ 实现处理 ML-KEM，private key 由 Keystore wrapping key 加密；iOS 同理由 Keychain ThisDeviceOnly wrapping。
- [KNOWN] 不自己实现密码学 primitive；所有跨语言输出必须跑 test vector。

## M0 Spike 退出门

| 引擎 | Android 真机 | iOS 真机 | Zephyr fixture | 30 分钟稳定 | License |
| --- | --- | --- | --- | --- | --- |
| SSH/SFTP | [INFERRED] 必须 | [INFERRED] 必须 | [INFERRED] 必须 | [INFERRED] 必须 | [INFERRED] 审核 |
| Terminal | [INFERRED] IME+CJK | [INFERRED] IME+CJK | [INFERRED] VT fixture | [INFERRED] 大输出 | [INFERRED] 审核 |
| RDP | [INFERRED] 全通道子集 | [INFERRED] 全通道子集 | [INFERRED] cert/input/drive | [INFERRED] 必须 | [KNOWN] FreeRDP Apache-2.0 + transitive deps 审核 |
| VNC | [INFERRED] 必须 | [INFERRED] 必须 | [INFERRED] RFB fixture | [INFERRED] 必须 | [INFERRED] 审核 |
| Telnet | [INFERRED] 编码/route | [INFERRED] 编码/route | [KNOWN] 复用现有 tests | [INFERRED] 必须 | [INFERRED] 审核 |

- [KNOWN] 任一引擎只有模拟器成功、只有 connect 没有功能矩阵、没有许可证结论或没有真机内存/泄漏结果，都不能从 provisional 变 accepted。
