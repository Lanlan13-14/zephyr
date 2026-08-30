# Zephyr One 统一产品、架构、体验、安全与交付合同

> [KNOWN] 状态：新的唯一权威规格；用户最新要求高于历史冻结文本。
>
> [KNOWN] 范围：Zephyr One Desktop、Android、iOS，以及 Zephyr 主端为 One 提供的 Zephyr Link、共享 broker 和兼容服务。
>
> [KNOWN] 本文件只规定产品和工程合同；本次文档重组不实现业务代码。
>
> [KNOWN] 当前审计基线：`origin/main@e1db614`，2026-08-22。
>
> [INFERRED] 总体置信度 HIGH；具体压缩、分块、并发和设备性能基线在实测前为 MED。

---

# 第一编　产品定义与不可退让原则

## 1. Zephyr One 是什么

- [KNOWN] Zephyr One 是 Zephyr 面向 Windows、macOS、Linux、Android 与 iOS 的第一方客户端，不是 Zephyr Lite、网页壳、同步伴侣或旧 Agent 换皮。
- [KNOWN] Zephyr One 与 Zephyr 主端都必须能完全独立运行：主端没有 One 仍提供完整 Web 产品；One 未绑定、主端离线或同步失败时仍是完整本地终端与远程工作台。
- [INFERRED] One 的能力范围是“同版本 Zephyr 中当前账号可使用、且在终端设备上有产品意义的全部能力”，不能由客户端团队维护一个缩水子集。
- [INFERRED] Zephyr Link 是可选纽带，负责账号数据副本、设备身份、近实时同步、blob、文件桥接、在线共享、撤销和诊断；它不是启动 One 或使用本地连接的前置条件。
- [INFERRED] One 同时可以是本地独立工作区、Zephyr 账号数据的本地副本，以及 shared strict broker 的安全操作界面；三种驻留语义必须明确分开。

## 2. 平台技术栈

| 平台 | 技术栈 | 产品策略 |
| --- | --- | --- |
| [KNOWN] Android | Kotlin + Jetpack Compose | 原生页面、原生导航、原生终端/Remote Surface、Android 文件授权、生物识别、预测性返回和后台生命周期。 |
| [KNOWN] iOS | Swift + SwiftUI，必要平台桥接使用 UIKit/Metal/LocalAuthentication | 原生页面、interactive swipe-back、security-scoped files、Keychain/Secure Enclave 和系统生命周期。 |
| [KNOWN] Desktop | Tauri 2 + Rust shell + 本地 Zephyr Node core；协议核心含 C/原生库 | 视觉与成熟 Zephyr 页面最小变化，但启动、凭据、Link、workspace 和 shared 安全底座必须升级。 |

- [KNOWN] 移动端不以整页 WebView 冒充原生客户端。
- [INFERRED] 桌面“最小变化”是产品和视觉策略，不代表旧 pull-only、启动等待页或不安全凭据路径可以保留。
- [INFERRED] 业务规则以 Zephyr canonical service、registry、schema 和错误合同为唯一真源；One 负责本地 mirror、原生协议 adapter 和平台 UI，不另造一套业务语义。

## 3. 当前代码事实

- [KNOWN] Android 已有 510 个 Kotlin 文件，约 46,869 行，并存在 20 个 Gradle 模块：app、contracts/model/security/data/network/sync/ui、connections/sessions/remote/notes/file-sync/tools/AI 以及 SSH/Telnet/RDP/VNC/ZFT2 协议模块。
- [KNOWN] iOS 已有 125 个 Swift 文件，约 45,589 行，包含 ZephyrContracts、ZephyrCore、ZephyrUI 及大量 XCTest；当前仓库是 Swift Package/library 结构，尚未发现正式 `@main App`/Xcode App target，因此不能把“已有大量代码”等同于“可发布 iOS App”。
- [KNOWN] Desktop 的 Tauri/Rust/JS/C 相关核心约 41 个文件、19,772 行，已包含本地 Node core、系统解锁、原生 RDP broker/surface、文件与 Token bridge。
- [KNOWN] Android 已实现设备本地 `ensureLocalWorkspace()` 与 `localMode`，该方向满足“未绑定也可用”，必须保留。
- [KNOWN] 历史 `FREEZE/zephyr one/ZEPHYR_ONE.md` 中“原生项目未开始”“状态机未实现”等描述已失真，本文件不继承这些陈旧结论。

## 4. 能力完整性

### 4.1 必须完整覆盖

- [KNOWN] Connection 库、临时连接、搜索、筛选、收藏、标签、备注和测试连接。
- [KNOWN] SSH、Telnet、RDP、VNC、SFTP、上传、下载、预览、编辑、重命名、删除与冲突检测。
- [KNOWN] Proxy、SSH Key、JumpHost 与多级路由。
- [KNOWN] 终端会话、远程桌面会话、工作区恢复、历史任务和批量执行。
- [KNOWN] 笔记、代码片段、文件、下载、活动。
- [KNOWN] Docker、监控、日志和当前账号可执行的远程运维能力。
- [KNOWN] Zephyr AI 的 Provider、模型、Memory、Skills、Env、MCP、Planner、Sandbox、Tool、risk、confirmation、trace 和 verification。
- [KNOWN] 当前账号 own resource 的 ACL/分享管理，以及 shared-to-me 资源的在线受限使用。
- [KNOWN] Client Token、One 设备、文件同步、文件桥接、服务器有用途设置、备份与恢复、诊断、外观和本地解锁。

### 4.2 完整支持的含义

- [INFERRED] 协议“支持”不能只等于 connect success 或出现画面；字段、默认值、认证方式、代理/跳板、host-key/证书、编码、IME、键鼠、剪贴板、音频、文件映射、通道权限、重连、取消和错误映射必须与同版本 Zephyr 对齐。
- [INFERRED] 上游原生库缺少 Zephyr 已承诺能力时，必须通过 adapter、受控 fork、替换核心或发布阻断解决，不能把库缺陷转换成产品删项。
- [INFERRED] 新增主端能力必须进入 capability parity manifest，并被分类为 `native-local`、`linked-owned`、`server-executed`、`shared-brokered` 或 `explicit-excluded`；未分类时 CI 失败。

### 4.3 显式排除

- [KNOWN] 多用户管理。
- [KNOWN] 当前账号安全设置管理；One 可以完成登录、Passkey/MFA ceremony 和敏感验证，但不提供账号安全策略编辑页。
- [KNOWN] SMTP/邮件通知配置、CAPTCHA/IP 白名单/防爆破策略配置、ICP/公安备案、自定义 CSS/JS 编辑执行。
- [KNOWN] 独立 Zephyr Agent 产品页面；旧 Agent/ZFT2 只作为兼容底层能力存在。
- [INFERRED] 新排除项必须由产品合同明确批准，不能以“移动端不方便”或“暂未实现”为由添加。

---

# 第二编　启动与性能硬门

## 5. 一秒可用合同

- [KNOWN] 从用户点击应用图标/启动项到出现真实可操作产品页面不得超过 1,000ms。
- [KNOWN] 不得出现应用自建 Splash、Logo 等待页、启动卡、Spinner、Skeleton loading page、“正在准备/正在加载/正在启动核心”、白屏、黑屏或同色空白占位页。
- [INFERRED] 1,000ms 指受控发布基线设备上的冷启动 `input/launch request → first fully drawn and interactive product surface`，不是仅进程创建或绘制背景色。
- [INFERRED] 发布门按至少 30 次真正冷启动统计，p50、p95 和 max 全部记录；合同要求每个有效样本 `usableMs <= 1000`。无法达到的构建不得发布。
- [INFERRED] App Lock 开启时，系统解锁页是合法的真实功能页，但它也必须在 1,000ms 内出现；等待用户认证不计入后续首页启动预算。
- [INFERRED] 首次安装、数据库迁移、崩溃恢复、主端离线、同步 bootstrap、网络超时、Node core 冷启动和密钥加载都不能把用户挡在加载页。

## 6. 启动架构

### 6.1 共通原则

1. [INFERRED] 首帧只依赖包内资源、同步可读的最小启动状态和本地安全存储，不依赖网络、同步、健康检查或服务端。
2. [INFERRED] 首帧直接恢复上次真实页面；没有历史时直接显示可操作的本地首页空态。
3. [INFERRED] 数据库、密钥、会话、同步、AI runtime、协议库探测、文件授权复查和后台任务全部在首帧后异步恢复。
4. [INFERRED] 页面以最后一次已提交本地状态立即可操作；后台 hydrate 只做差量修正，不能替换成全屏 loading。
5. [INFERRED] 需要等待的单个 action 只在对应控件上显示 pending；不得封锁整页。
6. [INFERRED] 启动 snapshot 必须原子写入、版本化、加密或严格限制为非敏感 UI/read-model 数据，并与数据库 generation 绑定；损坏时直接进入可操作空态。

### 6.2 Android 当前缺口与目标

- [KNOWN] 当前 `MainActivity` 在 `app.ready=false` 时只绘制同色空 `Box`；这仍是空白等待，不满足“出现页面且不得有加载页面”。
- [KNOWN] 当前恢复已从主线程移到 `Dispatchers.IO`，比过去黑屏正确，但仍以全局 `ready` 门阻止真实页面出现。
- [INFERRED] 应用启动后立即构造 `StartupReadModel`，直接渲染 LockGate、上次 RootRoute 或本地首页；Room/SQLCipher 恢复后按 generation 合并。
- [INFERRED] 禁止 Application.onCreate 同步做数据库扫描、网络、ML-KEM 初始化、WorkManager 大任务或协议引擎探测。
- [INFERRED] 使用 Android Macrobenchmark `StartupTimingMetric`、frame timing、baseline profile 和真实 release APK 验证，不能用 debug 或单元测试代替。

### 6.3 iOS 当前缺口与目标

- [KNOWN] 当前 iOS 代码量已很大，但仓库尚无正式 App entry/Xcode application target；必须先补齐真正可启动产品后才能声称满足启动指标。
- [INFERRED] SwiftUI App 首个 scene 立即显示真实 RootView/LockView；Keychain、SQLCipher、bookmark revalidation、sync 和 engine 恢复在后台 task 中完成。
- [INFERRED] 使用 XCTest/XCUIApplication 启动 measurement、os_signpost 和 release archive，在最低支持设备与当前主流设备分别测试。

### 6.4 Desktop 当前缺口与目标

- [KNOWN] 当前 `index.html` 明确显示 `bootGate` 和“正在准备完整 Zephyr”；`startAndEnter()` 又显示“正在启动内置 Zephyr 核心”；这直接违反新合同。
- [KNOWN] Windows release autostart 当前主动等待 2 秒再启动 Node core，仅这一项就必然突破 1 秒。
- [KNOWN] 当前主窗口等待本地 core health、创建第二个隐藏 WebView、导航 `/app.html` 后再切窗，冷启动路径过长。
- [INFERRED] 删除 BootGate；Tauri shell 在首帧直接显示持久化的真实 Zephyr read-model 页面，Node core 从进程启动第一时间并行拉起。
- [INFERRED] 去掉 2 秒 autostart grace；窗口关闭但产品配置允许后台驻留时可保留 core，真正退出才停止。
- [INFERRED] Core 未就绪时，用户仍可浏览本地 read-model、打开设置和准备操作；需要 core 的具体 action 在控件级排队或返回可重试状态，不得切到等待页。
- [INFERRED] 长期应让桌面 shell/read model 与本地数据库直接协作，避免“必须等完整 Node Web 页面启动后才有任何 UI”的结构性依赖；视觉可以保持最小变化。

## 7. 性能预算

| 阶段 | 硬预算 |
| --- | ---: |
| [INFERRED] 进程/Activity/Scene/Tauri window 到首帧提交 | 350ms |
| [INFERRED] 启动状态与主题/锁定状态读取 | 100ms |
| [INFERRED] 真实首屏布局和交互注册 | 250ms |
| [INFERRED] 预留 OS/设备波动 | 300ms |
| [KNOWN] 总计 | 1,000ms |

- [INFERRED] 任何单项超过预算必须在性能 trace 中归因；不能用扩大总预算解决。
- [INFERRED] 启动后 5 秒内的后台工作应限流，避免用户刚进入就因数据库、同步、图标、AI 和协议初始化同时抢占 CPU/I/O 而掉帧。
- [INFERRED] 终端输入和 remote input 优先级永远高于同步、blob、AI 历史和索引。

---

# 第三编　产品体验与平台原生实现

## 8. 信息架构

- [KNOWN] 移动端根导航为首页、会话、资料、工具四个入口；终端和 Remote Surface 是沉浸式 surface，不是带底栏的普通页面。
- [INFERRED] 手机使用全屏 push/sheet/浮窗，平板与桌面可以使用多栏；布局变化不能删除字段和能力。
- [KNOWN] 服务器设置与备份恢复保留在工具中的服务器区域；文件同步/Zephyr Link 是独立二级入口。
- [INFERRED] 每个页面必须具备 content、empty、offline、permission-denied、revoked/not-found、retryable error、pending-sync 和 conflict 状态；启动阶段不得新增全屏 loading 状态。

## 9. SSH、Telnet 与终端

- [KNOWN] SSH 支持密码、私钥、加密私钥、host-key 首次确认/变更阻断、Proxy、HTTP CONNECT、SOCKS5、多级 JumpHost、PTY、resize、SFTP、断线和错误映射。
- [KNOWN] Telnet 支持 IAC、DO/DONT/WILL/WONT、SB/SE、ECHO、SGA、TTYPE、NAWS、BINARY，以及 UTF-8/GBK/Big5/Latin-1。
- [KNOWN] Raw Telnet 对 owned/local 连接保留但必须明确明文风险；shared strict 模式要求安全 carrier。
- [INFERRED] 终端由唯一 SurfaceController/Session owner 管理 input、composition、output、scrollback、selection、viewport 和 PTY geometry。
- [KNOWN] IME composition 期间不滚动；commit 后最多一次光标校正；用户上滑阅读时远端输出不得抢回到底部。
- [KNOWN] 支持软件键盘、硬件键盘、extra keys、modifier、鼠标模式、选择、复制、粘贴和大输出。
- [INFERRED] 输入到 socket write 的本地 p95 目标不高于 16ms；终端输出不得因 Compose/SwiftUI 重组逐字符抖动。

## 10. RDP 与 VNC

- [KNOWN] RDP 使用成熟原生核心，支持 TLS/NLA、证书、动态分辨率、画质、音频、剪贴板、键鼠、触控、麦克风、摄像头、位置和 RDPDR drive。
- [KNOWN] VNC 支持 RFB 3.3/3.7/3.8、常见 pixel format/encoding、增量更新、认证、剪贴板和未知 security type 拒绝。
- [KNOWN] 手机和平板同时支持 direct touch 与 trackpad/relative pointer，外接鼠标/触控板不经过手势模拟。
- [INFERRED] Framebuffer 高频数据不经过 Node/JS bridge、JSON、Base64 或 Compose/SwiftUI state；协议 core 直接向原生 Surface/Metal/窗口提交 dirty rect。
- [INFERRED] Frame queue 有界，显示线程只消费最新可用帧；旧画面可以丢弃，输入和控制帧不能被 bulk frame 阻塞。
- [KNOWN] 文件映射的 readOnly 必须由 provider 层逐操作执行，不能只依赖 UI 开关。

## 11. 文件、笔记与代码片段

- [KNOWN] SFTP 支持 list/stat/read/write/rename/delete、续传、大文件、mtime/hash 冲突和取消。
- [INFERRED] 编辑器保存先本地提交；owned 数据可离线并产生 pending operation，shared 数据在线提交且不建立离线副本。
- [KNOWN] 笔记支持 Markdown、搜索、group/tag、关联连接、回收站、导入导出、AI read/write 和冲突处理。
- [INFERRED] Owned note 使用 local-first snapshot + delta/op log；shared note 使用主端权威 revision 和内存 viewer/editor session。
- [KNOWN] Snippet 支持编辑、复制、插入当前终端和按权限执行，删除通过 tombstone 收敛。

## 12. AI 浮动工作区

- [KNOWN] AI 默认叠在当前页面、终端、RDP/VNC、文件或笔记上，而不是强制进入隔离全屏聊天页。
- [KNOWN] 同版本 Zephyr 的 model-visible tool/capability、risk、confirmation、playbook 和安全边界必须完整对齐。
- [INFERRED] Web DOM action 在原生端变为版本化 semantic/action bridge；业务写操作仍调用 canonical service，不能通过 UI 模拟绕开 ACL/revision。
- [KNOWN] 用户必须看到 observation、proposal、confirmation、execution、trace 和 verification。
- [INFERRED] 本地 AI 可在 One 独立运行；shared/provider 主端 AI 由 Zephyr 执行，One 不获得 Provider Key、Env secret 或 resolved credential。

## 13. 无障碍、动效与输入优先级

- [KNOWN] Android 命中区至少 48dp，iOS 至少 44pt；状态不能只靠颜色，图标按钮必须有可读 action label。
- [KNOWN] 尊重 Android animator/accessibility 与 iOS Reduce Motion。
- [INFERRED] 手势动画必须跟手、可中断；terminal character、remote pointer、framebuffer 和连接输入不做装饰性补间。
- [KNOWN] Android 应用内返回由系统 back progress/commit/cancel 驱动；iOS 普通 push 页面支持 interactive edge swipe-back。

---

# 第四编　数据、同步、共享与安全

## 14. Workspace 与数据驻留

| 数据域 | 真源与驻留 |
| --- | --- |
| [INFERRED] Local Workspace | 设备独有 dataset；不绑定服务器、不自动上传；独立数据库、SecretStore、operation log 和 key scope。 |
| [INFERRED] Linked Workspace | `serverId + immutable userId + datasetEpoch` 的本地副本；Zephyr 与已绑定 One 共同写入。 |
| [KNOWN] Owned resource | 当前账号拥有；进入完整加密镜像，可离线使用与编辑。 |
| [KNOWN] Shared-to-me | 不进入业务 DB、SecretStore、FTS、最近记录、备份、通知正文、日志和工作区恢复；在线按次使用。 |
| [KNOWN] Device-local | SAF URI、security-scoped bookmark、设备私钥、数据库 master key、active socket、surface handle 等不跨设备。 |
| [INFERRED] Opaque preservation | One 不理解或无 UI 用途的 canonical 字段加密保存但不编辑，旧客户端不得清空。 |

- [INFERRED] 首次绑定不得自动上传 Local Workspace；用户明确选择保持本地、复制所选项目到账号或建立纯主端 Linked Workspace。
- [INFERRED] 解绑只影响 Linked Workspace 和该设备凭据，不删除 Local Workspace。
- [KNOWN] 用户主动下载、复制或导出 shared 内容是显式外流动作，必须受 capability、owner policy 和审计约束。

## 15. Zephyr Link 产品模型

- [KNOWN] Zephyr Link 在 UI 中称“Zephyr Link”，但覆盖设备 enrollment、账号数据同步、blob、文件桥接、shared online use、撤销和诊断。
- [KNOWN] Zephyr 与 One 都不依赖 Link 才能运行；Link 关闭或失败只影响同步和明确依赖主端的能力。
- [INFERRED] 底层能力通道必须隔离：`control`、`owned-sync`、`secret`、`blob`、`file-bridge`、`shared-terminal`、`shared-remote`、`shared-note`、`shared-file`、`ai`。
- [INFERRED] UI 统一入口不等于权限和凭据合并；每个通道有独立 capability、密钥、流控、大小限制和驻留规则。

## 16. 不依赖认证因子的设备 Enrollment

```text
1 One 生成 deviceId、ES256、ML-DSA、ML-KEM 和 enrollment key
2 POST /api/link/v2/enrollments
3 主端返回 bindId、verificationUri、userCode、server identity
4 One 显示二维码、短码、设备指纹与 SAS
5 用户在系统浏览器或另一台已登录设备打开审批页
6 Zephyr 按当前策略完成 password/TOTP/Passkey/CAPTCHA/MFA/SSO
7 审批页显示账号、设备、平台、IP、设备指纹和 SAS
8 用户批准精确设备公钥
9 One 使用 enrollment secret 与设备私钥兑换加密 bind bundle
10 建立 Link 会话并 bootstrap
```

- [KNOWN] 旧原生绑定只认识 password/TOTP，且 TOTP 登录后又复用密码字段做敏感验证；该路径不能成为 v2 正式绑定流程。
- [INFERRED] One 不保存账号密码、TOTP、Passkey assertion、CAPTCHA token 或浏览器 SID。
- [INFERRED] 系统浏览器保持正确 Passkey RP ID、origin 和平台 Credential API；内嵌 WebView 不承担认证。
- [INFERRED] Enrollment 绑定服务器应用身份和设备公钥；短码只有定位作用，没有 enrollment secret 和设备私钥不能兑换。
- [INFERRED] 状态单向 `pending → approved → consumed`，并发兑换使用 SQL compare-and-swap。

## 17. 凭据分离

| 凭据 | 用途 | 禁止用途 |
| --- | --- | --- |
| [INFERRED] One Device Identity | 设备认证、同步、PoP、撤销 | 旧 Agent 通用 bearer |
| [INFERRED] Legacy Client Token | 旧 Zephyr Agent/ZFT2 兼容 | One 设备绑定与完整账号访问 |
| [INFERRED] File Bridge Lease | 某设备、某 shareProfile、某时段的文件桥接 | 同步、账号管理、其他目录 |
| [INFERRED] Shared Session Capability | 某设备、会话、资源、通道的在线使用 | 资源编辑、secret reveal、其他资源 |

- [KNOWN] Client Token 不再是 One 绑定前置。
- [INFERRED] Client Token 可在绑定后作为账号 own secret 实体同步；Token 旋转只影响实际使用该 Token 的 Agent/lease。
- [INFERRED] Access 短寿命，refresh 单次轮换并重用检测；服务端只存 hash；所有 token 绑定 device generation 与 instanceEpoch。

## 18. CDN 兼容传输与应用层加密

```text
Primary:  HTTPS/TLS 1.3 + WSS /api/link/v2/stream
Fallback: HTTPS/TLS 1.3 + HTTP/2 POST /push + GET /pull
Wake:     WSS control → SSE → bounded long poll
```

- [KNOWN] 不使用 QUIC、HTTP/3 或 UDP 必需能力。
- [INFERRED] WSS 只降低延迟；durable change log、op replay table 和持久 cursor 才是真源。
- [INFERRED] CDN 可终止外层 TLS，因此 One 与 Zephyr 应用进程建立 `X25519 + ML-KEM-768` 混合会话；CDN 不得读取内层业务 payload。
- [INFERRED] 设备与服务器使用 `ES256 + ML-DSA-65` 双身份；握手和 rekey 双签名，高频帧只使用派生 AEAD。
- [INFERRED] 每通道、方向和 epoch 独立派生 key；nonce=`epoch|direction|channelId|sequence`；AAD 绑定 serverId、instanceEpoch、userId、deviceId、datasetId、channel、sequence、scope 和 capability hash。
- [INFERRED] Base URL 固定 scheme/host/port；重定向默认拒绝，跨 origin 永不转发 Authorization、SID、proof、cookie 或 body secret。

## 19. iCloud 类双向同步

```text
Zephyr Web 写入 ─┐
One A 写入 ──────┼─> Zephyr canonical service + durable change log
One B 写入 ──────┘                │
                                  ├─ cursor wake → One A
                                  └─ cursor wake → One B
```

- [INFERRED] Zephyr 主端是正式 writer，One 设备也是正式 writer；账号数据不是主端 snapshot 的只读副本。
- [INFERRED] 本地保存先事务提交 mirror + pending op；网络可用时 debounce 后立即 push；服务端 canonical service、revision、change log 和 idempotency result 同事务提交。
- [INFERRED] 在线设备收到 cursor wake 后只拉 appliedCursor 后的变化；一页 change 与 cursor 在本地同事务应用。
- [KNOWN] 首次 bootstrap 使用稳定 snapshotCursor 和 staging generation，先 catch-up、再 push、再 pull。
- [KNOWN] Normal round 保留 push→pull→ack；cursor 过期转 bootstrap，不能继续在陈旧视图上 push。
- [KNOWN] 同 opId 逻辑幂等；field revision 不重叠自动合并，重叠进入 conflict；delete 通过 tombstone 传播。
- [INFERRED] 固定 30 秒～24 小时间隔只作为后台维护和断流补偿；近实时依赖 local write trigger 与 cursor wake。
- [INFERRED] 同一区域在线小编辑到另一设备可见的初步 p95 目标为 300ms，最终以基准冻结。

## 20. Wire format、压缩与 Blob

- [INFERRED] Link v2 使用 canonical CBOR 二进制帧和稳定 registry integer ID，停止扩展 JSON/Base64 高频协议；v1 仅兼容迁移。
- [INFERRED] 压缩在加密前，普通 metadata/note delta 使用 stateless zstd；secret 与攻击者可控反射数据不共享压缩上下文；小帧不压缩。
- [INFERRED] 批量同时受 byte budget、RTT、BDP、内存和交互优先级控制，不只按固定 operation 数量。
- [INFERRED] Owned note 发送 UTF-8 splice delta，冲突时回退三方合并或 snapshot。
- [INFERRED] Blob 使用 content-defined chunking、每块 hash、整文件 SHA-256 和 Merkle manifest；上传先交换已有块 bitmap，只传缺块。
- [INFERRED] Dedup 仅限同一账号，并以账号级 keyed chunk ID 防止跨账号存在性 oracle。
- [INFERRED] 临时文件在账号私有目录内创建、完整校验、fsync 后原子 rename；配额、并发、chunk count、总大小和解压比例均有硬上限。

## 21. Shared strict broker

- [KNOWN] Shared-to-me 正式模式只允许 strict broker/relay；不得把 SSH/RDP/VNC/Telnet password、private key、passphrase、proxy/jump credential、AI API Key、Env secret、Client Token、SID、refresh 或 data key 下发 sharee。
- [KNOWN] 历史 `direct-ephemeral` 与“share 方只拥有使用权、不拿到凭据”冲突，必须废弃；兼容期若存在须标记 insecure legacy，新客户端默认拒绝并设定删除版本。
- [INFERRED] 每个 shared operation 实时重验 user、device、grant、expiry、resource revision、dependency ACL、channel policy 和 owner policy；revoke push 只加速，权威鉴权永远在主端。
- [INFERRED] Capability 是 PoP，不是可转移 bearer，绑定 actorUserId、device key、ZSL exporter、sessionId、resourceId、purpose、channel、policyHash、expiry 和 jti。
- [KNOWN] Relay 不可用时失败，不能静默下发 secret。
- [INFERRED] Owner 若要真正交付资源，应使用显式复制/转让事务，为对方创建新的 owned resource；这不属于 share-use。
- [KNOWN] 已显示内容无法绝对阻止外部摄像或人工转录；产品保证的是凭据不交付、零持久化、能力受限、即时撤销和显式外流审计。

## 22. Shared 协议执行

- [INFERRED] SSH/SFTP：Zephyr 解析 credential/proxy/jump 并建立 upstream；One 只收 PTY/file semantic stream。完整 shell 本身授予远端账号已有的数据访问能力，需要更严限制时必须使用受限账号或 command broker。
- [KNOWN] Telnet：owned/local 可使用 raw Telnet 并警告；shared strict 必须通过 SSH tunnel/VPN/IPsec/TLS wrapper，无法安全承载时拒绝。
- [INFERRED] RDP/VNC：Zephyr Remote Gateway 建立 target 会话，下游拆分 reliable control/input、可丢 frame/audio、clipboard 和 file channel；RDP 要求 TLS/NLA，VNC strict 要求 VeNCrypt/TLS 或安全隧道。
- [INFERRED] Shared note：在线 viewer/editor、Zephyr 权威 revision、内存 buffer；不进 mirror/FTS/draft recovery。
- [INFERRED] Shared AI：Zephyr 持有 Provider key、Env 和 resolved credential；One 只收 event、脱敏 trace、confirmation 和结果。Provider 是明确数据处理端点，不能被描述为 provider-blind E2EE。

## 23. 密钥层级、轮换与恢复

```text
Offline Hybrid Root Identity
  └─ Online Server Identity / CryptoProfile
      ├─ Server transport/KEM epochs
      ├─ Account DEK epochs
      │   ├─ Entity/field keys
      │   ├─ Account blob-dedup key
      │   └─ Backup references
      └─ Device registrations
          ├─ ES256 identity
          ├─ ML-DSA identity
          ├─ ML-KEM key
          ├─ local storage master key
          └─ ephemeral Link channel keys
```

- [INFERRED] Offline root 不参与日常请求；online identity、KEM、account DEK、backup 和 session key 分开轮换。
- [INFERRED] 普通 KEK 更新优先 rewrap；怀疑 DEK 泄漏时才重加密数据。
- [INFERRED] Device revoke 立即失效 access、refresh、ticket、Link session、shared capability、wake 和 file lease。
- [KNOWN] Backup restore 递增 instanceEpoch；旧 cursor、proof、ticket、session 和 pending op 不得自动覆盖恢复后的主端。

---

# 第五编　安全威胁目录与发布门

## 24. 安全方法

- [KNOWN] 无法证明穷举所有未知 0-day、恶意内核、未来密码分析和未知供应链漏洞。
- [INFERRED] 可执行要求是：所有已知入口、信任边界、状态机、STRIDE/LINDDUN 类别、滥用路径和资源耗尽路径进入机器可读 threat catalog；每项必须有 owner、防护、server test、Android test、iOS test、desktop test、fuzz/property test 或明确不适用理由。
- [INFERRED] 新 endpoint、frame、parser、credential、storage path、AI tool、shared channel 或 native bridge 没有 threat entry 时 CI 失败。

## 25. 网络、认证与 Enrollment 攻击

| 攻击 | 必须防护与测试 |
| --- | --- |
| [COMMON] MITM/恶意 CDN | [INFERRED] 应用身份 pin/二维码、混合握手、transcript binding；合法 TLS 的恶意中间层仍不能解密 ZSL payload。 |
| [COMMON] TLS downgrade/错误证书绕过 | [KNOWN] 禁止 trust-all；最低 TLS policy、hostname/SPKI、suite pin；任何 downgrade 失败。 |
| [COMMON] Host/X-Forwarded-* poisoning | [INFERRED] public origin、Passkey RP ID 和回调使用配置 allowlist；只信任明确 proxy hop。 |
| [COMMON] Redirect credential leak | [INFERRED] 默认拒绝 redirect；跨 origin 剥离所有凭据、proof 和 secret body。 |
| [COMMON] Request smuggling/WebSocket hijack/Slowloris | [INFERRED] 统一代理解析、Origin allowlist、header/body/time/concurrency 限制和异常 upgrade 测试。 |
| [COMMON] Password stuffing/spraying与账号枚举 | [INFERRED] IP+账号+设备+ASN 风控、近似响应、指数退避、Passkey 优先；分布式低频攻击仍进入账号风控。 |
| [COMMON] Lockout DoS | [INFERRED] 不能只靠 IP；渐进 challenge/step-up，锁定状态可见且有安全恢复路径。 |
| [COMMON] TOTP 猜测/重放/时间漂移 | [INFERRED] 单 transaction、严格次数、短 TTL、成功后消费、有限 skew；旧码和跨事务码失败。 |
| [COMMON] Passkey challenge replay/origin confusion | [INFERRED] challenge 单次、TTL、expected origin/rpID、credential counter、账号绑定。 |
| [COMMON] MFA fatigue | [INFERRED] 审批页显示设备/IP/SAS；频率限制、拒绝后冷却、异常告警。 |
| [COMMON] Enrollment userCode 穷举/二维码替换/SAS 欺骗 | [INFERRED] 256-bit secret + 设备 PoP、短码限流、二维码签名、双端 SAS；攻击者设备不能兑换受害 approval。 |
| [COMMON] 双重消费与审批竞态 | [INFERRED] 单向状态与 SQL CAS；并发兑换只有一个成功。 |

## 26. Token、API 与同步攻击

- [INFERRED] Access/refresh theft、refresh replay/concurrent refresh、device public-key substitution、key rollback、nonce/RNG failure、KEM oracle、unknown-key-share、ticket replay全部建立负面向量。
- [INFERRED] BOLA/IDOR、mass assignment、ownerId spoof、confused deputy、ACL TOCTOU、resource enumeration、admin overreach 必须按 immutable userId、server-side owner、allowlist field 和统一 404 防护。
- [KNOWN] Mobile/Link 写入只能调用 canonical service，禁止直接写业务表。
- [INFERRED] Op replay、idempotency GC、cursor skip、bootstrap race、tombstone resurrection、field-mask smuggling、secret 明文混入、revision overflow、double-primary split、restore rollback 必须有 crash/fault/property 测试。
- [INFERRED] 同一 opId 重放 100 次只产生一次副作用；任一 crash point 后 entity/op/cursor 不出现半事务。

## 27. Parser、压缩、文件与 Native bridge 攻击

- [INFERRED] JSON prototype pollution、duplicate key、非 canonical CBOR、超深嵌套、长度/整数溢出、decompression bomb、compression oracle、Unicode identity confusion 和客户端 OOM 均有硬限制与 fuzz corpus。
- [INFERRED] Path traversal、absolute/drive/UNC/device path、NUL、symlink/junction/hardlink escape、TOCTOU、chunk substitution、dedup oracle、disk exhaustion、ZIP bomb、temp-file race 和恶意预览必须按句柄相对访问、realpath containment、no-follow、配额、sandbox preview 防护。
- [INFERRED] Native C/Rust/Swift/Kotlin ABI 使用固定宽度、layout assertion、bounded buffers、lifetime ownership 和 sanitizer/fuzz；高频 frame 不通过不受限 IPC/JSON。
- [KNOWN] 日志、crash、analytics、通知和诊断不得包含 host、path、username、正文、terminal output、frame、key 或 token；用 canary 自动扫描。

## 28. Shared、Relay 与 AI 攻击

- [INFERRED] Relay→direct downgrade、capability 转移、attach credential 泄漏、revoke 后续用、clipboard/drive/mic/camera 越权、SSRF、DNS rebinding、proxy/jump loop、target 协议 downgrade 和 shared 本地落盘均为发布阻断。
- [INFERRED] 目标地址在授权与 connect 前后解析并按 policy 校验；默认阻止 loopback、link-local、metadata、内网越权和 DNS rebinding，除非 owner 明确策略允许。
- [INFERRED] AI prompt injection 不能读取 Provider key、Env value、Client Token 或 resolved credential；模型只接 opaque resource reference，tool executor 重新鉴权。
- [INFERRED] Tool event 必须绑定 runId、toolCallId、sequence、schema 和 AEAD；伪造/重排事件失败。
- [INFERRED] Shared AI history、note、terminal 和 remote capture 不得进入 One 本地 mirror；copy/export 是显式能力和审计事件。

## 29. 服务端、供应链与运维

- [INFERRED] SQL 参数化与 identifier allowlist；模糊 field/path 不能成为 SQL 标识符。
- [INFERRED] Server master key 进入 TPM/Keychain/HSM 或外部 secret provider；禁止单一可读 key file 作为长期生产默认。
- [INFERRED] 审计日志 hash-chain 并周期签名；删除、重排和截断可检测。
- [INFERRED] 依赖 exact pin、hash/checksum、SBOM、许可证、构建 provenance、签名更新和 rollback protection；恶意更新不能读取其他 account scope 或导出 secret。
- [INFERRED] Outbox/change append 同事务，worker lease + idempotency；重复 worker 不重复 change/wake。
- [INFERRED] 时间敏感 token 同时绑定 wall-clock 与 monotonic/epoch 语义；系统时间回拨不能复活 grant。

---

# 第六编　规格、代码组织、测试与交付

## 30. 权威规格与机器合同

- [KNOWN] 本文件 `FREEZE/zephyr one/ZEPHYR_ONE.md` 是 Zephyr One 唯一叙事规格；不得再创建平台分散的产品合同、状态文档或重复架构 Markdown。
- [KNOWN] 机器合同的正式工作源位于 `zephyr_one/mobile/contracts/` 与后续 Link v2 contracts；品牌工作源位于 `zephyr_one/mobile/branding/`/`zephyr_one/platform_assets/`。
- [KNOWN] `FREEZE/zephyr one/contracts/` 与 `FREEZE/zephyr one/branding/` 必须保留经过审核的冻结副本；通过 `FREEZE_PARITY.json`、hash 和 size 检查保证它们与正式工作源逐字节一致，副本不能脱离审核流程手工漂移。
- [INFERRED] 每个需求使用稳定 ID：`ONE-PRODUCT-*`、`ONE-STARTUP-*`、`ONE-PROTOCOL-*`、`ONE-LINK-*`、`ONE-SHARED-*`、`ONE-SEC-*`、`ONE-TEST-*`；CI 读取 machine traceability manifest，而不是解析多个 Markdown 真源。
- [KNOWN] 参考图、预览 HTML 与原始上传不是业务真源，但作为设计证据必须保留在 `FREEZE/zephyr one/references/`、`demo.html` 与 `original-uploads/`；不得因合并 Markdown 删除。

## 31. 推荐仓库结构

```text
FREEZE/
  zephyr one/
    ZEPHYR_ONE.md                 # 唯一叙事合同
    contracts/                    # 经过审核的机器合同冻结副本
    branding/                     # 品牌冻结副本
    references/                   # UI 设计证据
    original-uploads/             # 原始上传归档
    demo.html                     # 设计预览

zephyr_one/
  src/ + src-tauri/ + native/     # Desktop Tauri/Rust/C
  mobile/
    android/                      # Kotlin/Compose
    ios/                          # Swift/SwiftUI
    contracts/                    # 正式机器合同与 vectors
    branding/                     # 正式品牌工作源
    tests/ + tools/

mobile-contracts/                 # staged server/runtime copy；由正式合同生成或复制
```

- [INFERRED] `mobile-contracts/` 是部署/staging 所需副本时，必须由脚本从正式源生成并用 manifest 校验，不能人工编辑。
- [INFERRED] 新的 Link v2 OpenAPI/CBOR schema/threat catalog/capability parity/traceability 应放正式 contracts，而不是再次塞回 FREEZE 目录。

## 32. 测试矩阵

### 32.1 启动性能

- [INFERRED] Android：release APK + Macrobenchmark cold start 30 次，记录 TTID/TTFD/usable marker；最低支持和主流设备。
- [INFERRED] iOS：release archive + XCTest/XCUIApplication launch measurement + os_signpost；最低支持和主流设备。
- [INFERRED] Desktop：签名/发行构建从进程 spawn 到真实本地产品窗口可操作的 monotonic marker，Windows/macOS/Linux 各至少 30 次。
- [KNOWN] 任一显示 BootGate、loading page、空白占位或 usableMs>1000 的样本失败；视觉截图和 accessibility tree 同时验证“真实页面”。

### 32.2 功能与协议

- [KNOWN] Android、iOS、Desktop、主端合同测试；不能以一端通过代表其他端。
- [INFERRED] SSH/Telnet/RDP/VNC/SFTP 必须有真实服务器 interoperability、30 分钟稳定、弱网、断线、权限、证书/host-key、IME/键鼠、通道和内存泄漏测试。
- [INFERRED] capability parity manifest 对比同版本 Zephyr live catalog；One 未分类/未实现能力失败。
- [KNOWN] Shared canary 在 DB、KeyStore/Keychain、文件、cache、log、crash、notification、clipboard、backup 和 search 中为零。

### 32.3 Link 与安全

- [INFERRED] 两设备/三设备/主端并发编辑、离线数月、cursor GC、restore epoch、duplicate op、crash injection、packet loss/reorder、CDN proxy、WSS/SSE/long-poll fallback。
- [INFERRED] Enrollment 覆盖 password、TOTP、Passkey、CAPTCHA、组合 MFA、拒绝、过期、并发消费、二维码替换和设备公钥替换。
- [INFERRED] Threat catalog 中每个 negative vector 必须在 server 与相关客户端至少各执行一次；parser/native 边界进入 fuzz/sanitizer。

## 33. CI/CD 硬门

1. [INFERRED] 单一总合同路径存在，旧 `FREEZE/zephyr one` 不得重新出现。
2. [INFERRED] 正式 machine contracts 生成物无漂移；staged `mobile-contracts` 可重复生成。
3. [INFERRED] Android release compile/unit/instrumentation/macrobenchmark；iOS build/unit/UI/launch measurement；Desktop unit/C/Rust/build/startup measurement。
4. [INFERRED] 主端 server tests、Link v2 e2e、shared residency、security regression、fuzz corpus 和 migration fault tests。
5. [INFERRED] capability parity、threat coverage、traceability、SBOM、license、provenance、artifact signature 和 secret scan。
6. [KNOWN] 任一必需平台只有文档、mock 或静态检查，没有真实编译/真机/运行证据，不得标记 implemented。

## 34. 分阶段实施

### Phase 0：合同与路径统一

- [KNOWN] 建立本文件；旧目录改名为 `zephyr one`，删除陈旧多文档和 FREEZE 机器合同副本；更新测试、索引和生成工具。
- [INFERRED] 建 capability parity、traceability、threat catalog 和 startup benchmark 合同。

### Phase 1：一秒启动

- [INFERRED] Android 去掉全局 ready 空白门，使用真实 StartupReadModel。
- [INFERRED] iOS 建正式 App target/entry 与可测启动链路。
- [INFERRED] Desktop 删除 BootGate 和 2 秒 grace，首帧显示真实 read-model，Node core 并行启动。

### Phase 2：Enrollment 与凭据解耦

- [INFERRED] 建 `/api/link/v2/enrollments`、浏览器审批、SAS、PoP bind；Client Token 退出 One 绑定。
- [INFERRED] 敏感操作改 AuthorizationTransaction。

### Phase 3：统一 Link 会话与 iCloud 同步

- [INFERRED] WSS/HTTP2/SSE/long-poll transport、ZSL/2、CBOR、多路通道、wake-first、完整 registry、冲突与 tombstone。

### Phase 4：Blob、文件桥接与大规模数据

- [INFERRED] Content-defined chunking、账号内 dedup、quota、SAF/security-scoped/desktop provider、断点续传和路径安全。

### Phase 5：Shared strict broker

- [INFERRED] 删除 direct secret 下发；完成 SSH/SFTP semantic relay、Telnet secure carrier、RDP/VNC Remote Gateway、shared note/file/AI online session 和即时 revoke。

### Phase 6：能力与安全闭环

- [INFERRED] 补齐同版本 capability parity，关闭 threat catalog，完成三端真机/桌面矩阵、供应链与迁移发布门。

## 35. 发布阻断条件

- [KNOWN] 点击 App 后超过 1 秒才出现真实可操作页面，或出现任何应用自建加载页/空白等待。
- [KNOWN] One 被发布为 Lite/只连接/只同步版本，或 SSH/Telnet/RDP/VNC/SFTP 任一合同能力缩水。
- [KNOWN] Android/iOS/Desktop 任一必需平台只有部分实现却宣称全平台完成。
- [KNOWN] 本地功能依赖主端才能启动，或主端依赖 One 才能正常运行。
- [KNOWN] Client Token 仍作为 One 绑定前置，或 Passkey/MFA 账号无法绑定。
- [KNOWN] 文件同步仍是 pull-only、整包覆盖、轮询优先、无幂等/冲突/tombstone/secret protection。
- [KNOWN] Shared credential、AI key、Env secret、Client Token 或 resolved credential 下发 sharee，或 relay 失败静默降级 direct。
- [KNOWN] Shared 内容进入本地持久化、索引、备份、日志、通知或诊断。
- [KNOWN] Raw Telnet/弱 VNC 在 strict 安全模式下被虚假描述为完整加密。
- [KNOWN] Capability parity 未分类，threat catalog 无测试，或 machine contracts/三端实现漂移。

## 36. 最终冻结决策

- [INFERRED] Zephyr One 是 Zephyr 的桌面与移动第一方客户端：能力和业务逻辑与同版本 Zephyr 对齐，移动端以 Kotlin/Swift 原生重构并追求更优体验，桌面端以 Tauri 保持最小产品变化但升级启动、安全和 Link 底座。
- [INFERRED] One 与主端都独立；Local Workspace 永不自动上传，Linked Workspace 是 iCloud 类加密账号副本，Shared Workspace 是 strict broker 在线使用权。
- [KNOWN] App 启动硬门是 1 秒内出现真实可操作页面，禁止任何加载页面；当前桌面 BootGate、2 秒 autostart grace 和 Android ready 空白门都必须移除或重构。
- [INFERRED] Zephyr Link 不用 QUIC，采用 HTTPS/HTTP2/WSS/SSE/long-poll 与 ZSL/2 应用层加密。
- [INFERRED] One Device Identity、Legacy Client Token、File Bridge Lease 和 Shared Capability 完全分离；绑定使用系统浏览器 factor-agnostic enrollment。
- [INFERRED] 本文件替代原 `FREEZE/zephyr one` 中全部叙事规格；后续只在本文件增加章节，不再恢复多文档真源。

[RULES I BROKE]: 无。
