# Zephyr Android / iOS 原生 App 完整开发文档

> 文档状态：产品约束 + Zephyr 继承修订版 v1.2（用户要求优先）
>
> 审计基线：仓库 `Lanlan13-14/zephyr-ssh`，提交 `8dd5b98`（2026-08-08）
>
> 实现进度基线：提交 `b0e5a9c`（2026-08-09）。已写、未写与差距见 2.4「当前实现进度」；该节优先于本文其他章节和 `IMPLEMENTATION_STATUS.md` 里更早的状态描述。
>
> 目标产品：以 Android Kotlin + Jetpack Compose、iOS Swift + SwiftUI 原生实现 Zephyr One 的移动操作能力；排除无移动用途的账号安全/服务器部署后台，并通过“文件同步”完成 One 有用途账号数据的完整双向同步
>
> 产品范围合同：[`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md)。该合同约束“必须做什么”，本文约束总体“怎样实现”；范围冲突时合同优先。
>
> 细化规范：Zephyr 业务继承见 [`ZEPHYR_PARITY.md`](ZEPHYR_PARITY.md)，逐屏落点见 [`SCREEN_CATALOG.md`](SCREEN_CATALOG.md)，双平台视觉/返回/动画见 [`MOBILE_EXPERIENCE.md`](MOBILE_EXPERIENCE.md)，SSH/Telnet 手感见 [`TERMINAL_EXPERIENCE.md`](TERMINAL_EXPERIENCE.md)，RDP/VNC 交互见 [`REMOTE_DESKTOP_EXPERIENCE.md`](REMOTE_DESKTOP_EXPERIENCE.md)，Zephyr AI 全能力浮窗见 [`AI_FLOATING_WORKSPACE.md`](AI_FLOATING_WORKSPACE.md)，共享资源零驻留与按次使用见 [`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)，同步顺序见 [`SYNC_STATE_MACHINE.md`](SYNC_STATE_MACHINE.md)，DDL/Secret/迁移见 [`DATA_AND_MIGRATION.md`](DATA_AND_MIGRATION.md)，协议引擎见 [`NATIVE_ENGINE_DECISIONS.md`](NATIVE_ENGINE_DECISIONS.md)，机器合同见 [`contracts/`](contracts/)。这些细化文件在各自主题内覆盖本文早期概述。

## 0. 标记与置信度

- [KNOWN] 表示由当前仓库代码直接确认；相关结论置信度 HIGH。
- [COMMON] 表示移动平台或工程领域的标准知识；相关结论通常置信度 HIGH。
- [INFERRED] 表示本文提出的架构决策；它是建议，不是假装已经实现，相关置信度 MED～HIGH。
- [COMPUTED] 表示由当前字段、接口或约束推导出的结果；相关结论通常置信度 HIGH。
- [GUESS] 表示缺乏依据的估计；本文不提供日历工期承诺。

## 1. 执行摘要

[KNOWN] 本文以用户确认的产品用途为最高优先级：Zephyr One 完整实现当前账号的移动操作能力，但不复制无移动用途的 Zephyr Web 主端部署/管理后台。明确排除范围以 `PRODUCT_REQUIREMENTS.md` 第 3 章为准。

[KNOWN] SwiftUI 是 Apple UI 框架而不是编程语言；当前确定技术栈是 **Android：Kotlin + Jetpack Compose**，**iOS：Swift + SwiftUI**。早期“使用 Tauri 做全端 App”的要求已由当前原生移动端方案取代；仓库现有 `zephyr_one/` Tauri 版本是兼容和迁移来源，不是新 Android/iOS UI 的运行架构。

[INFERRED] 新 App 不把现有 Web 页面塞进 WebView，也不继续在手机里运行 Node + `server.js` 作为 UI 后端。页面、导航、表单、终端输入、文件授权、生物识别和系统集成都必须原生；服务端管理类功能也必须有原生管理页面，而不是被删掉。

[INFERRED] “原生实现”不等于从零重写 RDP、SSH 密码学和终端解析。复杂协议核心可以复用经过测试的库，通过 C ABI、JNI、Objective-C++ 或 Swift Module 接入；最终界面、状态管理、生命周期和平台能力仍由 Kotlin/Swift 原生实现。

[INFERRED] 产品采用 **local-first + full mirror**：Zephyr One 日常功能可本地运行；绑定 Zephyr 主端后，“文件同步”像 iCloud 一样同步该账号的完整持久数据集，包括连接、凭据、代理、SSH Key、跳板、笔记、代码片段、AI 配置/记忆、主题和终端偏好、Client Token 等。只有活 socket、内存会话、系统文件授权句柄、设备密钥和纯设备 UI 状态不跨设备复制。

[KNOWN] 绑定和同步必须同时满足：主端已存在 Client Token；用户在 One 中输入 Zephyr 用户名和密码；账号开启 TOTP 时还要通过 TOTP；随后绑定当前 One 设备。同步按账号作用域进行，不能跨用户混合。

[KNOWN] 当前 `/api/one/sync/pull` 只返回整包快照，当前 `SyncEngine` 也只执行 pull。它没有 push、变更游标、删除墓碑、操作幂等或冲突解决，所以不能满足“完整双向同步”。

[INFERRED] 服务端新增版本化 `/api/mobile/v1/*` 增量双向协议，旧 `/api/one/*` 保持兼容。UI 统一称为“文件同步”，必须提供开关、手动同步、用户自定义自动同步间隔、最后同步时间、进度、冲突与错误。

[KNOWN] 主端设置入口统一叫 **Zephyr Client**：保留旧 Zephyr Agent 的 Token、在线 Agent和文件映射能力，同时增加 Zephyr One 设备绑定、同步状态、启停和删除。删除 One 设备、删除/旋转/重置全部 Token 都必须验证当前密码；启用 TOTP 的账号使用 TOTP 动态码完成敏感验证。

[KNOWN] Zephyr One 内不出现独立“Zephyr Agent”页；底层 Agent/文件桥接能力继续整合，但用户产品面统一收进“文件同步”和 RDP 存储配置。Android 可用前台服务保持文件桥接在线；iOS 只能在系统允许的前台/执行窗口工作，这一平台限制不能伪造成常驻。

### 1.1 本次冲突纠正（后者覆盖前者）

| 原文档理念 | 用户确认要求 | 最终规则 |
| --- | --- | --- |
| [INFERRED] 把“Zephyr 有的 One 都要有”解释成连 SMTP/CAPTCHA/IP策略/备案/主端备份/账号安全后台也复制 | [KNOWN] 这些 Web 部署管理页在 One 没用途 | [KNOWN] 明确排除；One 登录时只被动遵守服务端认证策略 |
| [INFERRED] AI、SFTP、编辑器、Docker 等可分阶段保留 | [KNOWN] 这些有直接移动操作用途 | [KNOWN] 属于最终范围，只允许调整实施顺序 |
| [INFERRED] 同步只覆盖连接、代理、Key、跳板、笔记和设置子集 | [KNOWN] 文件同步像 iCloud 一样完整同步账号数据 | [KNOWN] 全部持久业务实体默认同步；schema registry/CI 阻止漏项 |
| [INFERRED] Activity 不同步，Client Token只同步 metadata/仅用于绑定 | [KNOWN] 对应账号数据和 Zephyr Agent Token 要在 Zephyr 与 One 间互备 | [KNOWN] Activity按 eventId 镜像；Client Token record + secret 用设备 envelope完整互备 |
| [INFERRED] App 内存在 Agent 独立运行域/设置入口 | [KNOWN] One 没有 Zephyr Agent，原页改名文件同步 | [KNOWN] 删除独立 Agent产品页；底层 `/agent/files`/ZFT2兼容能力收进文件同步与 RDP配置 |
| [INFERRED] 主端和 One 使用各自设备管理概念 | [KNOWN] 主端 Zephyr Agent设置改名 Zephyr Client，保留旧 Agent并管理 One | [KNOWN] 一个 Zephyr Client页面同时管理 Token、旧 Agent和 One设备同步 |
| [INFERRED] App 可用独立 device credential后弱化原 Token角色 | [KNOWN] 开启同步前主端必须先建 Token，One还必须账号密码+TOTP登录绑定 | [KNOWN] Token是硬前置和互备实体；device credential只做会话安全增强，不替代产品流程 |
| [INFERRED] 自动同步主要服从系统后台调度 | [KNOWN] 用户要自定义自动时间和手动同步 | [KNOWN] 保存用户目标间隔、前台精确触发、后台尽力调度，并始终提供立即同步 |
| [INFERRED] 可建立 App 自己的安全入口 | [KNOWN] 删除应用自建密码验证，可选系统解锁/人脸进入 | [KNOWN] One 不建本地账号密码墙；App Lock只调用系统人脸/指纹/设备凭据 |

[KNOWN] 本表之后的章节均按“最终规则”展开；如果后文和本表冲突，以本表及用户最新要求为准。

## 2. 当前仓库事实基线

### 2.1 已有产品能力

- [KNOWN] Web 主端当前提供 SSH、Telnet、RDP、VNC、代理、SSH 多级跳板、远程批量执行、笔记、活动、AI、用户与安全管理。
- [KNOWN] 当前连接协议枚举为 `SSH / TELNET / RDP / VNC`；默认端口分别为 `22 / 23 / 3389 / 5900`。
- [KNOWN] 当前 RDP 设置已有声音、剪贴板、麦克风、摄像头、Agent 存储、位置、分辨率、画质、帧率、触控模式、触控灵敏度和 Windows 域字段。
- [KNOWN] 当前 Agent 使用 `wss://<server>/agent/files`，先发送 JSON `hello`，认证成功后使用 JSON RPC v1 或二进制 ZFT2 v2。
- [KNOWN] 当前 ZFT2 使用 20 字节大端头、`ZFT2` magic、版本 2、最大 256 KiB metadata、最大 1 MiB payload，支持 open/read/write/close/stat/list/mkdir/delete/rename/truncate/cancel/ping。
- [KNOWN] 当前 Agent Token 由主端按账号维护；令牌删除、旋转、重置以及 One 客户端撤销需密码或 TOTP 敏感验证。
- [KNOWN] 当前 One 绑定流程是账号登录（必要时 TOTP）后，选择属于该账号的 Client Token，再获得单独的 `deviceToken`。
- [KNOWN] 当前快照包含 connections、proxies、sshKeys、jumpHosts、notes、settings 和 Agent Token metadata；对于自有连接，服务端会把密码和私钥解密后放进 HTTPS 响应。
- [KNOWN] 当前 One 把 SID、deviceToken 和含敏感字段的快照写进 Web localStorage；这不应复制到原生实现。

### 2.2 当前同步缺口

| 缺口 | 当前状态 | 原生目标 |
| --- | --- | --- |
| 上传 | [KNOWN] 无 push API | [INFERRED] 批量幂等 push |
| 增量 | [KNOWN] 每次整包 snapshot | [INFERRED] server cursor + change feed |
| 删除传播 | [KNOWN] 资源大多硬删除 | [INFERRED] tombstone + retention |
| 冲突 | [KNOWN] 仅 notes 有 expectedRevision | [INFERRED] 全资源 optimistic concurrency |
| 幂等 | [KNOWN] 无 opId/batchId | [INFERRED] 设备级去重表 |
| 密钥绑定 | [KNOWN] Bearer deviceToken | [INFERRED] 短期 access token + device proof |
| 本地密钥保存 | [KNOWN] localStorage | [INFERRED] Android Keystore / iOS Keychain |
| 后台模型 | [KNOWN] Web `setInterval` | [INFERRED] WorkManager / BGTask + 前台事件同步 |

### 2.3 必须保留的兼容约束

- [INFERRED] 主端已有 Web 客户端、独立 Flutter Agent 和 Tauri Zephyr One 不得被新接口破坏。
- [INFERRED] ZFT2 v2 保持字节级兼容；原生端先实现 v2，只有兼容旧服务端时才启用 JSON RPC v1。
- [INFERRED] 原生 App 延续 `com.zephyr.one` 时，Android 必须使用现有 One 的正式签名证书才能覆盖安装；包名相同但签名不同会导致升级失败。
- [INFERRED] 独立 `com.zephyr.agent` 在整合版完成同等能力并经过迁移期前继续发布，不立即删除。

### 2.4 当前实现进度（实测基线 `b0e5a9c`，2026-08-09）

[KNOWN] 本节只记录仓库里实际存在的文件和实测跑出来的结果，不记录设计意图。`zephyr_one/mobile/` 目录已经存在，所以本文早期以及 `IMPLEMENTATION_STATUS.md`、`TRACEABILITY.md` 中「仓库没有 mobile/android」「Android/iOS 为 missing」的判断已经过期；在那两份表格重新生成之前，本节是进度的事实来源。

#### 2.4.1 已经写到哪里

| 层 | 实测规模 | 判定 |
| --- | --- | --- |
| 机器合同 | [KNOWN] OpenAPI 21 路径 / 22 操作、20 个实体、66 个错误码、15 份 codegen 产物；`FREEZE_PARITY.json` 记录 16 份冻结源哈希 | 可用：`zephyr_one/mobile/tests` 69 项断言全过，`check:drift` 无漂移 |
| Android 工程 | [KNOWN] 21 个 Gradle 模块 + `buildSrc`，293 个 `.kt` 共 46,487 行（主源 220 文件 / 34,091 行，单测 73 文件 / 12,396 行）；AGP 8.7.3、Kotlin 2.0.21、minSdk 26 | 骨架与纯逻辑已成规模，但从未构建过 |
| Android UI | [KNOWN] 131 个 `@Composable`、7 个 ViewModel、6 个屏幕（连接列表、连接编辑、会话列表、终端、远程桌面、批量执行） | `SCREEN_CATALOG.md` 的 23 个屏幕 ID 中落地 6 个 |
| 协议与纯逻辑 | [KNOWN] Telnet IAC/协商/自动登录、ZFT2 编解码 + Session + Provider + Dispatcher、RFB 握手与像素格式、终端按键/鼠标编码、视口与手势、同步 Actor / PushPlanner / 冲突解析 / 字段掩码 | 有真实实现并带单测 |
| 安全与本地数据 | [KNOWN] Keystore 主密钥、SecretStore / SecretBlobStore、MobileAad、HKDF、ML-KEM 信封、SessionSecretArena、Room 数据库与镜像/待办/冲突表及仓库层 | 有实现，未在真机验证 |
| iOS | [KNOWN] 只有 6 个生成的合同 Swift 文件共 670 行；没有 `Package.swift`、没有 Xcode 工程、没有 App 代码 | 除合同外为空 |
| 服务端 mobile v1 | [KNOWN] `server.js` 中 `/api/mobile/v1` 出现 0 次 | 未开始 |

#### 2.4.2 还没有写

- [KNOWN] **服务端 `/api/mobile/v1/*` 的 22 个操作全部未实现**：设备绑定/刷新、bootstrap、changes、push、ack、status、sensitive/verify、file-bridge/lease 以及 shared 全系列都只存在于 OpenAPI 里。客户端 `SyncActor` 因此没有可连的对端。
- [KNOWN] **三个协议引擎是空壳**：`SshEngine`、`RdpEngine`、`VncEngine` 的默认实现都是 `isAvailable = false`，对应 ADR-002 / ADR-004 / ADR-005 未出 M0 门（VNC 仍卡在 GPL 许可审计）。Telnet 与 ZFT2 是目前唯二端到端可用的协议逻辑。
- [KNOWN] **iOS 侧除生成合同外一行未写**：没有工程文件、没有 SwiftUI 界面、没有 Keychain 与 security-scoped provider 实现。
- [KNOWN] **两个模块只有构建文件**：`feature-ai` 与 `feature-file-sync` 各有 0 个 Kotlin 源文件，即「Zephyr AI 全能力浮窗」和「文件同步设置页」尚未开工。
- [KNOWN] **17 个屏幕缺失**：S01/S02 解锁与绑定、账号、设置、文件同步、冲突中心、笔记与片段、SFTP 与编辑器、Docker 与监控、共享资源等都没有 Compose 实现。`feature-notes` 有 24 个主源文件但 0 个 `@Composable`，属于逻辑先行、界面未做。
- [KNOWN] **没有仪器测试**：整个 `zephyr_one/mobile/android` 不存在 `androidTest` 目录，`SCREEN_CATALOG.md` 要求的 UI 测试与真机矩阵一项都没跑。
- [KNOWN] **没有构建与 CI**：没有 Gradle wrapper，`.github/workflows/` 里没有移动端流水线，`zephyr-one.yml` 仍写明 Android/iOS 不属于 Zephyr One。因此 46,487 行 Kotlin 至今没有经过一次编译验证。
- [KNOWN] **发布面未做**：没有 Deep Link 处理代码，`app/src/main/res` 只有占位自适应图标，四色（asagi / cyber / frost / lava）产物在 Android 资源目录中为 0。

#### 2.4.3 已知会编译失败的引用（最高优先级）

[KNOWN] 对 293 个 `.kt` 的 `one.zephyr.mobile.*` 导入做静态解析后，有三个符号被引用但整树没有声明：

| 符号 | 引用位置 | 问题 |
| --- | --- | --- |
| `ZephyrOneRoot` | `zephyr_one/mobile/android/app/.../MainActivity.kt:32` | 根导航 Composable 从未编写，App 没有入口树 |
| `ZephyrApplication` | `zephyr_one/mobile/android/app/.../filebridge/FileBridgeForegroundService.kt:16,59`、`zephyr_one/mobile/android/app/.../sync/SyncWorker.kt:6,22` | 实际类名是 `ZephyrOneApplication`，导入和强转都指向不存在的类 |
| `AccountContainer` | `zephyr_one/mobile/android/app/.../di/AppContainer.kt:87,90` | 账号级依赖图类型未定义，`bindAccount` 无法通过编译 |

[INFERRED] 这三处说明 `zephyr_one/mobile/android` 目前的真实状态是「模块与逻辑先落地、App 壳未收口」：库模块的代码可以独立单测，但 `:app` 模块拼不成一个能运行的 App。补齐它们是任何构建验证的前置条件。

#### 2.4.4 距离各里程碑还差多少

[KNOWN] 按第 22 章的退出门逐项对照：

| 里程碑 | 已完成部分 | 未完成部分 |
| --- | --- | --- |
| M0 协议冻结 | OpenAPI、schema、vectors、ZFT2 全部冻结且有测试 | ADR-002/004/005 三个引擎 spike 与 VNC 许可审计未出门 |
| M1 原生壳与本地数据 | 主题、浮岛几何、连接列表/编辑、Room DB、SecretStore、AppLock 代码齐备 | 根导航与解锁/绑定屏幕缺失，2.4.3 的三处未声明符号阻断构建，重启恢复与大字体/安全区测试未跑 |
| M2 服务端与完整双向同步 | 客户端 SyncActor、PushPlanner、冲突与信封逻辑及单测齐备 | 服务端 0 行；chaos matrix、往返测试、tombstone 与游标行为全部无法验证 |
| M3 文件桥接整合 | ZFT2 provider/dispatcher、路径安全与单测齐备 | 前台服务引用不存在的类，SAF 授权链与 iOS security-scoped provider 未实现，大文件套件未跑 |
| M4 SSH/Telnet | 终端渲染、按键与鼠标编码、IME 桥、会话管理与 Telnet 协议齐备 | 没有 SSH 引擎就连不上任何主机，代理/跳板与批量执行的传输层缺失 |
| M5 RDP/VNC | 远程屏幕、指针/键盘/剪贴板/视口逻辑与单测齐备，RFB 握手可用 | 没有 RDP/VNC 引擎与平台 Surface 绑定，真机矩阵与 30 分钟稳定会话未跑 |
| M6 其余能力、迁移与发布 | 笔记、片段、SFTP、批量执行、备份的纯逻辑与端口定义齐备 | 对应界面、AI 浮窗、文件同步页缺失；`feature-tools` 的端口全部 `isAvailable = false`；迁移与商店材料未做 |

[GUESS] 本文不给日历工期。可核对的比例是：屏幕 6/23，服务端接口 0/22，平台上 Android 有骨架而 iOS 仅有合同，五类协议逻辑中 2 类可用（Telnet、ZFT2），仪器测试 0。

## 3. 产品范围

### 3.1 目标

- [KNOWN] Zephyr One 完整实现当前账号有直接移动用途的能力；服务器部署/登录后台不因存在于 Zephyr Web 就自动进入 One。
- [INFERRED] 所有 One 产品操作页使用 Compose/SwiftUI 原生组件，不加载 `public/app.html`。
- [INFERRED] 手机上的 SSH/Telnet/RDP/VNC、SFTP、编辑器、Docker/监控、批量执行、笔记、活动、AI 使用能力等采用原生界面，不能只打开 Zephyr Web 页面冒充实现。
- [INFERRED] 主端离线时，可由手机本地完成的功能继续工作；明确依赖主端进程的共享、服务端 AI/浏览器等使用能力显示离线状态。
- [KNOWN] 当前账号安全设置、SMTP、CAPTCHA/IP策略和备案不建立One页面；服务器设置和备份恢复保留，由原生页面调用主端能力。
- [KNOWN] 账号登录 + Client Token 完成设备绑定；同步开启前主端必须已有 Token，账号开启 TOTP 时必须完成第二步验证。
- [KNOWN] “文件同步”对绑定账号执行完整双向数据镜像，包含敏感凭据与 Client Token；共享资源继续服从主端 ACL。
- [KNOWN] Zephyr One 不显示独立 Zephyr Agent 页面，但保留并整合 Agent 文件桥接能力；Zephyr 主端仍兼容旧 Agent，主端设置入口统一叫 Zephyr Client。
- [INFERRED] UI 继承 Web 的信息层级、四色主题、卡片感和术语，但使用平台导航、手势、字体、动态字号和无障碍语义。

### 3.2 产品排除项与技术边界

- [KNOWN] **排除多用户管理**：One 不创建、删除、停用用户，不转让超级管理员，不管理其他账号；它只登录并同步当前绑定账号。
- [KNOWN] **排除独立 Zephyr Agent 页面**：不出现名为“Zephyr Agent”的设置页；对应底层能力归入“文件同步”和 RDP 文件/存储配置。
- [KNOWN] **排除当前账号安全后台**：不在 One 修改账号资料/密码、启停 TOTP、管理 Passkey或安全策略；账号密码/TOTP只用于绑定和敏感验证。
- [KNOWN] **排除无移动用途的Web登录/展示配置**：SMTP/邮件通知、CAPTCHA/IP白名单/防爆破、备案不在One提供配置页。
- [KNOWN] **保留服务器设置与备份恢复**：用原生页面调用主端API；不得因执行发生在主端就删除入口。
- [KNOWN] **排除自定义 CSS/JS 编辑入口**：One 原生 UI 不执行这些 Web 注入项，也没有编辑用途；同步兼容层只需 opaque preservation，不能覆盖清空主端值。
- [INFERRED] 活 SSH/Telnet/RDP/VNC socket、PTY 内存状态、正在运行的任务进程不是持久业务数据，不跨设备镜像；连接定义、历史、布局/恢复 metadata 仍同步。
- [INFERRED] Android SAF URI、iOS security-scoped bookmark、生物识别私钥、Launcher icon应用结果等设备绑定状态不能传给另一台设备；同步对应的产品意图，目标设备自行重新授权。
- [COMMON] iOS 不保证后台 WebSocket 无限存活；这是运行限制，不是删除文件同步/文件桥接能力的理由。
- [INFERRED] 手机不照搬桌面自由窗口几何；保留的功能重排为会话列表、全屏工作区、sheet 和宽屏多栏。这是移动端布局适配，不是功能删减。
- [INFERRED] 不从零重写 RDP/SSH 密码学；复用协议核心不违反原生要求，WebView 承载整页才违反。

## 4. 总体架构

```text
┌──────────────── Android App ────────────────┐
│ Kotlin + Compose                            │
│ ViewModel / UseCase / Repository            │
│ Room/SQLite + encrypted secret store        │
│ SSH/Telnet/RDP/VNC native session engines   │
│ SAF provider + file-bridge foreground svc   │
└───────────────┬──────────────────────────────┘
                │ HTTPS / WSS
                │ /api/mobile/v1/* + /agent/files
┌───────────────▼──────────────────────────────┐
│ Zephyr main                                  │
│ Auth + ACL + Sync + Device registry          │
│ Existing Web/API/Agent compatibility         │
└───────────────▲──────────────────────────────┘
                │ HTTPS / WSS
┌───────────────┴──────────────────────────────┐
│ iOS App                                      │
│ Swift + SwiftUI                              │
│ Observable state / UseCase / Repository      │
│ SQLite + Keychain protected secrets          │
│ SSH/Telnet/RDP/VNC native session engines    │
│ security-scoped URLs + file-bridge transport │
└──────────────────────────────────────────────┘
```

[INFERRED] 两端共享的是 **协议规范、JSON Schema/OpenAPI、测试向量和可选协议核心**，不是共享 UI。任何共享核心都必须暴露小而稳定的接口，不允许把平台 UI 退化为跨平台壳。

### 4.1 分层

| 层 | Android | iOS | 责任 |
| --- | --- | --- | --- |
| Presentation | [INFERRED] Compose | [INFERRED] SwiftUI | 页面、导航、交互、无障碍 |
| State | [INFERRED] ViewModel + StateFlow | [INFERRED] `@Observable`/ObservableObject | 单向状态流、加载/错误/空态 |
| Domain | [INFERRED] Kotlin use cases | [INFERRED] Swift use cases | 连接、文件同步/文件桥接、会话规则 |
| Data | [INFERRED] Repository | [INFERRED] Repository | 本地 DB、远端 API、缓存 |
| Protocol | [INFERRED] Kotlin/JNI | [INFERRED] Swift/C/ObjC++ | SSH/RDP/VNC/Telnet/ZFT2 |
| Platform | [INFERRED] SAF/Keystore/WorkManager | [INFERRED] DocumentPicker/Keychain/BGTask | 文件、安全、后台、通知 |

### 4.2 推荐目录

```text
zephyr_one/mobile/
  contracts/
    openapi-mobile-v1.yaml
    schemas/
    zft2-v2.md
    test-vectors/
  android/
    app/
    core-model/
    core-data/
    core-network/
    feature-connections/
    feature-sessions/
    feature-remote/
    feature-notes/
    feature-file-sync/       # includes embedded Agent transport; no Agent page
    feature-settings/        # One preferences only; no Web deployment admin
    protocol-ssh/
    protocol-rdp/
    protocol-vnc/
  ios/
    ZephyrOne.xcodeproj/
    App/
    CoreModel/
    CoreDataStore/
    CoreNetwork/
    Features/Connections/
    Features/Sessions/
    Features/Remote/
    Features/Notes/
    Features/FileSync/       # includes embedded Agent transport; no Agent page
    Features/Settings/       # One preferences only; no Web deployment admin
    Protocols/SSH/
    Protocols/RDP/
    Protocols/VNC/
  native-core/              # optional C/Rust protocol adapter; no UI
server/
  mobile-device-manager.js
  mobile-sync-service.js
  mobile-change-log.js
  mobile-secret-envelope.js
```

[INFERRED] `zephyr_one/mobile/contracts` 是唯一协议真源。Kotlin `kotlinx.serialization` model 和 Swift `Codable` model由 schema 生成或由契约测试校验，禁止两端手写出两个悄悄分叉的字段集合。

## 5. 平台技术选型

### 5.1 Android

- [INFERRED] Kotlin、Jetpack Compose、Navigation Compose、Coroutines、StateFlow。
- [INFERRED] Room 管理非敏感结构化数据；连接密码、私钥、Token 和 refresh credential 使用 Android Keystore 保护的 AES-GCM 密文，数据库只保存 ciphertext 与 key version。
- [INFERRED] OkHttp 或 Ktor Client 统一承载 HTTPS、WebSocket、超时、证书与网络日志；项目只能选一个主网络栈。
- [INFERRED] WorkManager 执行机会性后台同步；文件桥接常驻必须使用用户明确开启的 foreground service 和持续通知。
- [INFERRED] BiometricPrompt 负责本地 App 解锁和敏感字段查看，不替代主端 TOTP。
- [INFERRED] 文件访问默认使用 SAF tree URI 与 persistable permission；不把 `MANAGE_EXTERNAL_STORAGE` 作为商店版默认方案。

### 5.2 iOS

- [INFERRED] Swift、SwiftUI、NavigationStack/TabView、Swift Concurrency、Observation。
- [INFERRED] SQLite/GRDB 或等价薄层管理结构化数据；SwiftData 不作为首选，因为显式 schema migration、批量同步事务和跨版本可预测性更重要。
- [INFERRED] URLSession 承载 HTTP 与 WebSocket；Keychain 保存 refresh credential 和密钥材料。
- [INFERRED] LocalAuthentication 负责本地解锁；`kSecAttrAccessibleWhenUnlockedThisDeviceOnly` 类保护用于不可迁移敏感项。
- [INFERRED] UIDocumentPicker 获取目录/文件授权，并保存 security-scoped bookmark；书签失效时要求用户重新授权。
- [COMMON] BGAppRefreshTask 和 BGProcessingTask 的执行时间由系统决定，不能用作精确 30 秒/5 分钟定时器。

### 5.3 协议核心

- [INFERRED] SSH：Android 可评估 SSHJ/Apache MINA SSHD；iOS 可评估 SwiftNIO SSH。最终选择须通过算法、代理、跳板、SFTP、超时、许可证与维护活跃度审计。
- [INFERRED] 终端：优先使用经过测试的 VT parser/core，渲染层原生；不要用 Web xterm iframe。
- [INFERRED] RDP：优先评估 FreeRDP 或现有 grdp 核心的非 WASM 提取，通过 JNI 和 Objective-C++/C Module 接入；Compose/SwiftUI 只负责 Surface/UIView、手势、工具栏和状态。
- [INFERRED] VNC：选择可接受许可证的 RFB 实现或维护一个范围受控的原生核心；引入前必须做许可证审计。
- [INFERRED] Telnet：平台 socket + IAC/NAWS/TTYPE 状态机；UI 必须持续显示“明文协议”风险。
- [INFERRED] ZFT2：Kotlin 与 Swift 可直接实现，因为格式小且现有 JS/Dart 测试向量可复用；编码和解析必须字节级互测。

## 6. 信息架构与底部导航

### 6.1 根导航：底部浮岛

[KNOWN] 视觉参考 `1000069462.jpg` 为 1440×323，SHA-256 `c3a458fcd0ab11a66c4efe4f680638c41c1a5d5b138bfe1012adeb3248b834b1`：外层是悬浮圆角胶囊，选中项扩展为浅主题色的“图标 + 文字”胶囊，未选中项只显示图标。

[INFERRED] 普通页面不使用贴屏、全宽、矩形 BottomNavigation。底部安全区本来就不能承载正文，把导航做成浮岛不会额外牺牲可用内容；正文允许滚到浮岛下方，但列表必须留足 bottom content inset，最后一项可以完整滚到浮岛上方。

[INFERRED] 手机根浮岛固定为四个目的地，顺序与图标位置稳定：

1. [INFERRED] **首页**（dashboard）：连接卡片、搜索、协议/标签筛选、最近连接、活动摘要。
2. [INFERRED] **会话**（document/session）：正在连接、已连接、断线、可恢复的 SSH/Telnet/RDP/VNC 会话。
3. [INFERRED] **资料**（folder）：笔记、最近文件、代码片段；进入具体 SSH 会话后由终端上下文 dock 的“文件”入口接管 SFTP。
4. [INFERRED] **工具**（crossed tools）：远程批量执行、AI、文件同步、代理、SSH Key、JumpHost、外观、One 设置，以及“服务器”二级分组中的服务器设置与备份恢复；不出现账号安全、Web部署管理、多用户管理或独立 Zephyr Agent入口。逐屏路径以 [`SCREEN_CATALOG.md`](SCREEN_CATALOG.md) 为准。

[INFERRED] Web 顶栏里的 Activity 合并到首页二级页；AI 是工具入口和页面级 action，不单独挤占第五个导航槽。顶部仍保留原生标题与页面 action，例如搜索、添加、同步状态；浮岛只负责根目的地切换。

#### 6.1.1 浮岛几何与材质

- [INFERRED] 外岛手机基准高 `72dp/pt`，左右离屏幕 `16dp/pt`，最大宽 `520dp/pt`，底部间距为 `max(10dp/pt, safeAreaBottom)`；圆角为高度的一半。
- [INFERRED] 外岛内边距 `6dp/pt`；选中胶囊高 `60dp/pt`、圆角 `30dp/pt`，宽度由 `24dp/pt` 图标、`10dp/pt` 间距、单行标签和左右各 `20dp/pt` padding 决定。
- [INFERRED] 未选中项的视觉图标为 `24dp/pt`，但每项点击区域至少 Android `48×48dp`、iOS `44×44pt`；整岛四项均分剩余空间，选中胶囊不能挤压到让其他命中区低于下限。
- [INFERRED] 普通字号只给选中项显示标签；动态字体增大到标签无法安全放下时，浮岛整体仍保持单行，标签使用短名称且不缩小到无障碍字号以下。极窄窗口退化为四个等宽“图标 + 无可见标签”，但保留 accessibility label。
- [INFERRED] 浅色外岛使用接近系统分组背景的高不透明材质、细描边和柔和双层阴影；深色使用高不透明暗材质、亮度很低的边缘高光。iOS 可使用系统 Material；Android 不支持可靠背景采样时使用 tonal surface，禁止用高斯模糊截图伪造玻璃。
- [INFERRED] 不在浮岛下再铺一条全宽底栏，不叠两层半透明材料；系统手势区保持透明。
- [INFERRED] 列表/滚动页 bottom inset = 浮岛可见高度 + 岛与内容间距 + safe area；FAB 位于浮岛右上方至少 `12dp/pt`，不得压住第四项。

#### 6.1.2 选择反馈与运动

- [INFERRED] 按下立即把当前 item 缩放到 `0.97`，`100ms` 内反馈，并触发一次轻 haptic；页面切换不等待动画结束。
- [INFERRED] 选中胶囊从当前项的屏幕几何连续移动/改宽到目标项，使用临界阻尼、无弹跳 spring（目标 response `0.28s`、damping ratio `1.0`）；图标随胶囊移动，旧/新标签做不超过 `140ms` 的交叉淡化。
- [INFERRED] 动画必须可中断：用户快速连续点击时从当前呈现位置重定向，不先完成上一次动画；不使用会从起点重播的关键帧。
- [INFERRED] 选择 haptic 只在 destination 真正改变时触发，重复点当前项不振动；Reduce Motion 下取消位移 spring，改为 `120ms` 颜色/透明度交叉淡化。
- [INFERRED] 浮岛不随普通列表滚动自动隐藏。只有沉浸式 SSH/Telnet/RDP/VNC 会话或系统 IME 出现时，才由明确的上下文规则替换/隐藏。

[INFERRED] Android 平板和 iPad 宽屏可以在内容区使用双栏；根浮岛仍保持四个稳定语义并限制最大宽，不能被拉成横跨整屏的长条。Notes 分组和 Settings 分类等二级导航可在内容区显示侧栏。

### 6.2 首页

- [INFERRED] 顶部：标题、同步状态、账号头像、全局搜索。
- [INFERRED] 内容：最近连接横向区 + 全部连接卡片列表/网格。
- [INFERRED] 筛选：协议、标签、所有权、离线可用、收藏。
- [INFERRED] 主操作：右下角 FAB 新建连接；长按卡片出现编辑、复制、测试、删除。
- [INFERRED] 卡片沿用 Web 的协议色点、名称、`host:port`、标签、备注摘要和状态，但不复制 hover 逻辑。

### 6.3 连接编辑器

[INFERRED] 编辑器使用原生 sheet/全屏表单，按以下 section 分组，而不是把 Web 长表单一屏铺开：

1. [INFERRED] 基础：名称、协议、主机、端口、用户名、Windows 域/Telnet 编码。
2. [INFERRED] 认证：密码、已保存 SSH Key、临时私钥；敏感值默认不回填明文。
3. [INFERRED] 路由：直连、SOCKS5/HTTP CONNECT 代理、多级 SSH 跳板，最多 8 级与主端一致。
4. [INFERRED] RDP 设备：音频、剪贴板、麦克风、摄像头、位置、文件同步存储（底层兼容 Agent/RDPDR）。
5. [INFERRED] RDP 显示：分辨率、质量、FPS、直接触控/触控板、灵敏度。
6. [INFERRED] 文件同步：共享来源、共享名、只读、启用范围、空闲关闭、主端可见性；产品 UI 不使用 Agent 名称。
7. [INFERRED] 元数据：标签、Markdown 备注、共享权限。
8. [INFERRED] 底部固定 action：测试、保存；新建时另有“不保存直接连接”。

### 6.4 会话页面与终端键盘

[KNOWN] 终端视觉参考有两个状态：`1000069466.jpg`（1440×2828，SHA-256 `23cf2451d4670299caf8b087dd6c983ea75349bbf1fbd592496fe38d3d6879f2`）是系统键盘收起；`1000069465.jpg`（1440×2849，SHA-256 `a4afcc889da6d344fccfb2e293075a90b506cc87bc7e55aa6f10aa1024bd014b`）是系统键盘弹出。

- [INFERRED] 根页面显示会话列表；进入 SSH/Telnet session 后采用沉浸式终端，不显示普通四入口根浮岛。
- [INFERRED] 终端自身保持干净，不铺传统 AppBar；会话名、连接状态、重连和断开收进轻量顶部 overlay 或系统返回层，不能持续占用一整条高栏。
- [INFERRED] 参考图是结构和交互标准，不是配色硬编码。终端可使用用户的深/浅终端主题，但快捷键和 dock 必须与当前主题保持足够对比度。
- [INFERRED] 返回手势先退出沉浸式 session 回到会话列表，不直接断线；真正断线由显式 action 或用户的“退出即断开”偏好决定。

#### 6.4.1 IME 收起状态

```text
┌──────────────────────────────┐
│ Terminal viewport            │
│ (cursor/active line visible) │
│                              │
├──────────────────────────────┤
│ Terminal shortcut matrix     │
├──────────────────────────────┤
│ Terminal context dock        │
└──────── system safe area ────┘
```

- [INFERRED] 快捷键矩阵固定在 terminal viewport 下方、terminal context dock 上方，背景与终端连续，不做浮动卡片。
- [INFERRED] 第一行：`Esc`、`Alt`、`Home`、`↑`、`End`、选择/鼠标模式、`<>` 代码片段。
- [INFERRED] 第二行：`Tab`、`Ctrl`、`←`、`↓`、`→`、剪贴板、系统键盘开关。
- [INFERRED] 第三行：`Shift`；剩余空间保留，不为视觉对称塞入低价值按钮。
- [INFERRED] 底部 terminal context dock 使用四个稳定入口：会话/主机、SSH、文件、代码片段；当前 SSH 项使用与根浮岛相同的主题色选中胶囊并显示 `SSH` 标签，其他项只显示图标。
- [INFERRED] terminal dock 可以使用贴近底部的专用材质，而不是再套一个普通页面浮岛；它是会话上下文切换器，不是根导航。点击“会话/主机”回会话列表，点击“文件”打开当前连接 SFTP，点击“代码片段”打开 snippet sheet。

#### 6.4.2 IME 弹出状态

```text
┌──────────────────────────────┐
│ Resized terminal viewport    │
│ cursor stays visible         │
├──────────────────────────────┤
│ Terminal shortcut matrix     │  ← keyboard accessory
├──────────────────────────────┤
│ Native system keyboard       │
└──────────────────────────────┘
```

- [INFERRED] 系统键盘出现时，普通根浮岛和 terminal context dock 都隐藏；快捷键矩阵成为紧贴 IME 顶边的原生 keyboard accessory，不能在键盘与快捷键间留重复底栏或安全区空洞。
- [INFERRED] 键盘必须是系统 IME；App 不复制图中的 QWERTY 键帽。Android 通过 IME insets，iOS 通过 keyboard layout guide/input accessory 控制布局。
- [INFERRED] terminal viewport 的 bottom edge = shortcut matrix top；每个 IME/inset 帧都重新计算可见像素和终端 rows/cols，禁止仅用 translate 把旧画面上移，因为那会让 PTY 几何与可见区域分叉。
- [INFERRED] 键盘打开后自动把 active cursor line 滚到快捷键矩阵上方至少一个 line-height；不得把终端直接滚到底部，也不得破坏用户正在查看的 scrollback。若用户离开 follow-output 模式，只保证输入光标可见并保留可恢复的 scroll anchor。
- [INFERRED] 快捷键矩阵与键盘同步移动，不做额外 200～300ms 独立动画；系统逐帧提供 insets 时 1:1 跟随。只在无逐帧 API的降级路径使用不超过 `160ms` 的 ease-out。
- [INFERRED] 键盘收起时先完成 viewport/inset 更新，再恢复 terminal context dock；dock 从底部当前呈现位置淡入/上移 `8dp/pt`，不能让终端在一帧内上下跳两次。

#### 6.4.3 快捷键语义

- [INFERRED] `Ctrl`、`Alt`、`Shift` 是可锁定 modifier：单击锁定下一次字符/功能键，激活态使用主题色；发送后自动释放。双击可进入持续锁定，第二次单击解除；持续锁定必须有更强视觉状态和 accessibility announcement。
- [INFERRED] modifier 与普通键的命令由单一 `TerminalKeyCommand` actor 串行发送，禁止 UI 层自己拼字节；例如 `Ctrl+C`、`Alt+←`、Shift 组合必须通过终端 encoder 生成。
- [INFERRED] `Esc/Tab/Home/End/方向键` 在 touch-down 时给出按压反馈，在 touch-up 时发送一次；长按方向键可在 `350ms` 后开始重复，重复频率遵从系统键盘设置或平台合理默认。
- [INFERRED] 选择/鼠标按钮在“文本选择”和“终端鼠标上报”之间切换；若远端启用 mouse reporting，UI 明确显示当前模式，避免触摸被远端应用吞掉却没有解释。
- [INFERRED] 剪贴板按钮打开 paste preview sheet，而不是无提示立即发送多行文本；单行纯文本可由用户设置改为直接粘贴。预览显示字符数、行数，并允许取消。
- [INFERRED] `<>` 打开代码片段 sheet；选择片段后默认填入输入缓冲，只有片段自身标记 auto-run 且用户确认时才发送 Enter。
- [INFERRED] 键盘图标是显式 show/hide IME action；点终端输入区也可调出 IME。硬件键盘连接时矩阵仍可显示，但允许用户折叠；修饰键状态不能与物理键状态粘连。

#### 6.4.4 尺寸、可访问性与测试

- [INFERRED] 快捷键矩阵使用 7 列逻辑网格；文字键最小命中高 `44pt/48dp`，图标键同样保留完整命中区。视觉字号基准 `16sp/17pt`，等宽终端字体设置不影响快捷键字号。
- [INFERRED] 矩阵总高随动态字体增长，但最多占可用高度的 32%；超过时变成两行横向分页的自定义布局，不缩字、不让按键重叠。
- [INFERRED] 每个图标有可读 accessibility label，例如“打开剪贴板”“显示系统键盘”“切换文本选择”；modifier announcement 包含“已锁定/下一键/未激活”。
- [INFERRED] 颜色不能是 modifier 状态的唯一提示，同时使用填充、描边或角标；高对比和 Reduce Transparency 模式改用不透明背景。
- [INFERRED] Android Compose 必须测试 `adjustResize`/edge-to-edge + `WindowInsets.ime` 在手势/三键导航、Gboard/第三方 IME、横屏和浮动键盘下的行为；iOS SwiftUI 必须测试 safeAreaInset/keyboardLayoutGuide、QuickType、硬件键盘、iPad 浮动/分离键盘。
- [INFERRED] 自动化几何断言至少包括：终端不与矩阵重叠、矩阵不与 IME 重叠、dock 在 IME 显示时不可见、cursor rect 位于 terminal visible rect 内、rows/cols 与 viewport 像素和 cell size 一致、键盘反复开合 50 次无累计漂移。

- [INFERRED] RDP 使用边缘可收起工具条：键盘、触控模式、缩放、剪贴板、文件同步磁盘、Ctrl+Alt+Del、重连、断开；RDP 软键盘也遵循同一 IME inset 原则，但不显示 SSH 专属的 Home/End modifier 矩阵，除非用户打开“完整键盘”。
- [INFERRED] 手势：单指点击、双击、长按拖选、双指滚动、捏合缩放；触控板模式下单指移动指针、轻点左键、双指右键/滚动。

### 6.5 视觉系统

- [KNOWN] Web 已有 frost、lava、asagi、cyber 四套配色。
- [INFERRED] 原生端把颜色、圆角、间距、阴影、字体级别做成 design token；两端共享 token JSON，但分别映射到 Compose MaterialTheme 与 SwiftUI Environment。
- [INFERRED] 保留 Zephyr 的暗色基调、卡片层级、蓝色主操作和四色品牌；控件尺寸、系统字体和动态字体遵从平台规范。
- [INFERRED] 动画使用 180～300ms 的短过渡，支持系统 Reduce Motion；列表删除、sheet、会话全屏切换允许动画，持续闪烁和装饰性循环动画不允许。

### 6.6 Zephyr One 四色应用图标

[KNOWN] 本文配套的权威设计输入为 `zephyr-one-icons.zip`，SHA-256 为 `f379493ee3cdb4060dc9d526990cc5c0769607674b7840e515f3c78c15ccf533`，包含以下 5 个文件：

| 主题 | 权威源文件 | 主题色 `dotA` | 用途 |
| --- | --- | --- | --- |
| frost | [KNOWN] `zephyr-one-frost.svg` | [KNOWN] `#0a84ff` | 默认/凝霜蓝图标 |
| lava | [KNOWN] `zephyr-one-lava.svg` | [KNOWN] `#bf5a1f` | Lava 主题图标 |
| asagi | [KNOWN] `zephyr-one-asagi.svg` | [KNOWN] `#4d9c8a` | 浅葱主题图标 |
| cyber | [KNOWN] `zephyr-one-cyber.svg` | [KNOWN] `#4f9da6` | Cyber Teal 主题图标 |
| preview | [KNOWN] `zephyr-one-icon.html` | — | 四色、原版对照和多尺寸视觉验收页 |

- [KNOWN] 四套 SVG 均使用 `viewBox="0 0 200 200"`；风形、渐变、左下灰点与 Web `public/theme-runtime.js` 的 `ICON_PALETTES` 一致。
- [KNOWN] “One” 横向字标的 O 锚定原圆点 `(145, 115)`；中线通过 `rx=5 / ry=4.8` 的 mask 与 O 衔接；细线使用 `M 78 88 C 108 106, 137 137, 170 128`。
- [KNOWN] 当前 SVG 使用 `system-ui/-apple-system/Segoe UI/Roboto` 的 `<text>` 绘制 “One”。这会让不同操作系统、CI 镜像和 SVG rasterizer 选择不同字形，不能作为可重复构建的最终 launcher asset。
- [INFERRED] 合入仓库时保留收到的 SVG/HTML为不可改的 `zephyr_one/mobile/branding/source/` 设计源；另生成 `zephyr_one/mobile/branding/outlined/`，把 O、n、e 转成固定 path。轮廓版才是 Android/iOS 出包输入，生成器不得依赖运行机器字体。
- [INFERRED] 轮廓化不得改变 O 的墨心、mask 交界、曲线或四色 palette；生成前后使用 16/20/29/32/40/48/60/64/76/83.5/120/128/180/512/1024 px 尺寸做像素与人工检查。
- [INFERRED] App 内品牌标记随主题立即切换；系统桌面图标按平台能力尽力同步。主题为 `custom`、未知值或资源损坏时稳定回退 `frost`，不动态生成未经设计验收的第五套图标。
- [INFERRED] `selectedTheme` 可以参与用户偏好同步；`lastAppliedSystemIcon` 必须是本机设置，因为系统许可、Launcher 缓存和 iOS 用户确认状态不能跨设备复制。
- [INFERRED] 应用商店 listing icon 固定使用 frost；运行时替换只影响已安装 App 的系统图标，不会改变 Google Play / App Store 商店页图标。

#### 6.6.1 Android 资产与切换

- [INFERRED] 每套主题生成 legacy PNG、adaptive icon foreground/background 和 Android 13+ monochrome icon。不能把带白色圆角矩形的完整 SVG直接当 adaptive foreground，否则系统外层 mask 会造成双重圆角和光学缩小。
- [INFERRED] adaptive icon 的 background 为设计白底；foreground 使用去掉最外层白色圆角 `<rect>` 后的固定轮廓，按 Android safe zone 做光学缩放；legacy icon 保留完整圆角白底构图。
- [INFERRED] monochrome 资源只保留可辨识的风形与 One 轮廓，由系统着色；四色图标仍用于不启用 themed icon 的 Launcher。
- [INFERRED] Manifest 声明 frost/lava/asagi/cyber 四个 `activity-alias`，每个 alias 引用对应 `android:icon`、`android:roundIcon` 和同一入口 Activity。切换时通过 `PackageManager.setComponentEnabledSetting` 只启用目标 alias。
- [COMMON] Android Launcher 对 alias 图标有缓存，切换可能延迟，部分 Launcher 会短暂重启入口或不立即刷新。
- [INFERRED] Compose 主题切换立即完成；alias 切换在持久化主题后执行，失败只记录非敏感诊断并保留上一个有效图标，不回滚整个 UI 主题。
- [INFERRED] 每次 release CI 验证四个 alias 恰有一个默认启用、所有 density 资源存在、adaptive safe-zone 无裁切、monochrome 在浅/深系统底色均可辨识。

#### 6.6.2 iOS/iPadOS 资产与切换

- [INFERRED] frost 为 primary `AppIcon`；lava/asagi/cyber 作为 Asset Catalog alternate icon，并在 `CFBundleIcons` 与 `CFBundleIcons~ipad` 完整声明。所有图标生成 1x/2x/3x 和 App Store 所需尺寸，1024 px 商店源无 alpha。
- [INFERRED] 用户选择主题后，App 先应用 SwiftUI 主题，再在 `UIApplication.shared.supportsAlternateIcons` 为 true 时调用 `setAlternateIconName`；frost 对应 `nil`，其余对应稳定名称 `AppIconLava/AppIconAsagi/AppIconCyber`。
- [COMMON] iOS 可由系统展示图标更换确认，App 不能绕过；系统不支持 alternate icon 时只能切换 App 内主题。
- [INFERRED] 不在每次启动重复调用；只有期望主题与 `alternateIconName` 不一致时尝试。失败后在设置页显示“主题已切换，系统图标未切换”，不循环弹窗。
- [INFERRED] iPad 分屏、深浅外观不会改变主题到图标的映射；alternate icon 是用户级本机选择，不是后台任务。

#### 6.6.3 资源生成与验收

```text
zephyr_one/mobile/branding/
  source/
    zephyr-one-icon.html
    zephyr-one-frost.svg
    zephyr-one-lava.svg
    zephyr-one-asagi.svg
    zephyr-one-cyber.svg
  outlined/
    zephyr-one-{theme}-outlined.svg
  manifest.json             # palette、源 SHA-256、生成器版本
  generate-icons.*
```

- [INFERRED] 生成器输入只接受 `outlined` master 和 manifest；输出目录每次先清理再完整生成，防止旧尺寸混入。
- [INFERRED] CI 对 `source/` 做 hash contract，对四色 palette 做字段级 contract，对生成物做尺寸、色彩空间、alpha、空白边距和视觉快照测试。
- [INFERRED] 预览 HTML 是人工验收工具，不参与 App runtime，也不打进发布包。

## 7. Zephyr → Zephyr One 能力矩阵

[KNOWN] 本表按“在手机上是否有直接产品用途”定范围；不是把 Zephyr Web 设置页逐项照搬。

| Zephyr 功能/设置 | Zephyr One 要求 | 原生实现与同步 |
| --- | --- | --- |
| 仪表盘、连接库、搜索、筛选、标签、备注 | [KNOWN] 必须完整提供 | 原生首页/编辑器；连接及全部字段双向同步 |
| SSH、Telnet、RDP、VNC、Deep Link 临时连接 | [KNOWN] 必须完整提供 | 原生 session engine 和系统 Deep Link；持久定义同步，临时凭据不落盘 |
| SFTP 文件管理、上传下载、预览、编辑器、AI 补全 | [KNOWN] 必须完整提供 | 原生文件浏览/预览/编辑；偏好和可持久 metadata 同步 |
| Docker、状态监控、日志、远程批量执行 | [KNOWN] 必须完整提供 | 本地 SSH/现有能力 API；配置和可持久历史双向同步 |
| 代理池、SSH Key、跳板机、多级跳板 | [KNOWN] 必须完整提供 | 原生管理页；含凭据完整双向同步 |
| 代码片段 | [KNOWN] 必须完整提供 | 原生列表/编辑/终端调用；内容、分组、auto-run 双向同步 |
| 笔记、分组、标签、关联、回收站、导入导出 | [KNOWN] 必须完整提供 | 原生 Markdown 工作区；正文、墓碑和分组完整双向同步 |
| 活动 | [KNOWN] 必须提供 | 当前账号活动与本机操作记录；eventId 去重同步 |
| AI 聊天、会话、计划、Memory、Skills、环境变量、附件 | [KNOWN] 必须提供使用能力 | 原生 AI UI；当前账号使用数据和所需 secret 加密同步 |
| 当前账号安全设置页 | [KNOWN] 不提供 | 密码/TOTP只用于绑定和敏感验证，不在One管理账号安全 |
| 多用户管理 | [KNOWN] 不提供 | One只操作当前绑定账号 |
| 服务器设置 | [KNOWN] 必须提供 | 原生设置页调用主端API；按当前账号权限展示 |
| SMTP、邮件通知 | [KNOWN] 不提供 | 留在Zephyr Web主端 |
| CAPTCHA、IP白名单、防爆破 | [KNOWN] 不提供配置页 | One登录被动遵守主端认证结果 |
| ICP/公安备案 | [KNOWN] 不提供 | 只服务Web登录页/站点 |
| 主端数据库备份导入导出/恢复 | [KNOWN] 必须提供 | 原生触发、上传/下载、恢复确认和进度UI；执行在主端 |
| 自定义 CSS/JS | [KNOWN] 不提供编辑/执行入口 | 兼容同步层opaque preservation，不清空主端值 |
| 外观、主题、四色图标、终端颜色/背景、语言 | [KNOWN] 必须完整提供 | 原生主题系统；One 有用途的设置完整同步 |
| 工作区恢复、会话列表、布局偏好 | [KNOWN] 必须提供移动等价物 | 手机全屏工作区，平板多栏；可持久状态同步 |
| 分享资源使用/ACL状态 | [KNOWN] 必须提供当前账号所需部分 | 服从主端 ACL，不提供多用户管理后台 |
| Zephyr Client Token | [KNOWN] 必须完整管理并互备 | 创建、查看、复制、改名、旋转、删除、重置全部；secret 加密双向同步 |
| 文件同步 | [KNOWN] 必须取代 One 内独立 Agent 设置 | 绑定、自动间隔、手动同步、状态、冲突、设备目录和底层文件桥接 |
| 独立 Zephyr Agent 页面 | [KNOWN] 不提供 | 底层兼容能力归入文件同步/RDP；主端继续兼容旧 Agent |
| App Lock | [KNOWN] 新增但无自建密码 | 仅系统人脸/指纹/设备凭据；本机设置 |

## 8. 本地数据模型

### 8.1 核心实体

```text
ServerProfile
  id, baseUrl, displayName, tlsPolicy, createdAt, lastUsedAt

AccountBinding
  serverProfileId, userId, username, deviceId, tokenId,
  syncCursor, status, boundAt, lastSyncAt

Connection
  id, ownerUserId, protocol, name, host, port, username,
  authRef, tags, remark, connectionMode, proxyId, jumpHostIds,
  rdpSettings, revision, updatedAt, deletedAt, syncState

Proxy
  id, ownerUserId, type, host, port, username, secretRef,
  revision, updatedAt, deletedAt, syncState

SshKey
  id, ownerUserId, name, privateKeySecretRef, passphraseSecretRef,
  remark, revision, updatedAt, deletedAt, syncState

JumpHost
  id, ownerUserId, name, connectionId,
  revision, updatedAt, deletedAt, syncState

Note
  id, ownerUserId, title, content, groupPath, tags,
  linkedConnectionIds, revision, updatedAt, deletedAt, syncState

Snippet / AiProvider / AiConversation / AiMemory / AiSkill / AiPlan
  id, ownerUserId, payloadRef, secretRefs, revision,
  updatedAt, deletedAt, syncState

UserSettingsSection / ServerSettingsSection
  sectionKey, ownerScope, payloadRef, secretRefs,
  revision, updatedAt, syncState

ActivityEvent / SecurityEvent
  id, ownerUserId, category, payload, occurredAt,
  revision, syncState

ClientTokenRecord
  id, ownerUserId, name, tokenSecretRef, createdAt,
  updatedAt, lastUsedAt, revision, deletedAt, syncState

FileSyncConfig
  serverProfileId, enabled, automaticEnabled, intervalSec,
  bindingState, registryHash, bootstrapId, bootstrapPageToken,
  lastAttemptAt, lastSuccessAt, appliedCursor, acknowledgedCursor,
  pendingCount, lastError, conflictCount, rerunRequested, updatedAt

FileSyncShareProfile
  id, serverProfileId, displayName, localGrantRef,
  readOnly, autoStart, idleTimeoutMinutes, enabled

DeviceConnectionOverride
  connectionId, fileSyncShareProfileIds, localResolutionPolicy,
  localKeyboardPolicy, updatedAt

PendingOperation
  opId, batchId, entityType, entityId, action, baseRevision,
  fieldMask, payload, createdAt, attemptCount, lastError
```

### 8.2 完整镜像边界

[KNOWN] “文件同步”是 One 有用途数据的账号级完整镜像，不是只同步 connections/notes，也不是复制整个 Zephyr 服务器后台。

- [KNOWN] 必须同步：Connection、Proxy、SshKey、JumpHost、Note、Snippet、AI使用数据/所需配置、ServerSettings、BackupMetadata/加密包引用、Activity、资源ACL/分享状态、One用户偏好、Client Token record和token secret，以及One后续新增的持久业务数据。
- [KNOWN] 不进入One可编辑同步：用户账号安全设置、SMTP、CAPTCHA/IP策略、备案、自定义CSS/JS。
- [KNOWN] 连接密码、私钥、SSH Key、代理密码、One使用所需AI secret、服务器设置secret、Client Token等敏感字段同步时必须使用设备公钥envelope，并进入Keystore/Keychain保护的SecretStore。
- [INFERRED] `ServerProfile` 的可移植 metadata（URL、名称、TLS pin）可同步；当前服务器选择、滚动位置等纯 UI 状态默认只留本机。
- [INFERRED] RDP/文件同步“希望共享目录”的意图可同步；Android SAF URI、iOS bookmark 和目录访问授权不可跨设备使用，目标设备显示“需要重新选择目录”。
- [KNOWN] Client Token secret 进入互备范围；device refresh credential、设备私钥和数据库 master key 不同步，因为复制它们会克隆设备身份。
- [INFERRED] Activity 按稳定 eventId 镜像；高频终端原始输出不作为 Activity同步。
- [INFERRED] 已打开 PTY/RDP socket 和正在运行的进程不镜像；会话定义、最近状态、可恢复 metadata和持久历史按产品设置同步。
- [INFERRED] 多用户和账号安全表不下发；当前账号访问共享资源所需的 ACL snapshot 同步。

### 8.3 同步范围注册表

- [INFERRED] 服务端维护显式 `SYNC_ENTITY_REGISTRY`：One有用途的每个实体声明主键、owner scope、revision、secret fields、dependency order、tombstone policy和最低版本。
- [INFERRED] 另维护 `OPAQUE_PRESERVATION_REGISTRY`：One无用途但可能出现在全量快照中的Web管理字段只做端到端保留，不展示、不编辑、不参与One生成的patch。
- [INFERRED] CI扫描 schema migration：新增字段必须登记为 `editableSync`、`opaquePreserve` 或有理由的 `deviceLocal/serverOnly`；未分类则失败。
- [INFERRED] Android/Swift model 从同一 contracts schema生成或契约校验；未知字段必须保留，旧 One 不得把新主端字段清空。

### 8.4 SecretStore

- [INFERRED] 业务表只保存 `secretRef`，SecretStore 保存 AES-GCM ciphertext、nonce、AAD、keyVersion 和更新时间。
- [INFERRED] AAD 至少包含 `serverId/userId/entityType/entityId/fieldName`，防止密文被换位复用。
- [INFERRED] Android master key 位于 Keystore；iOS master material 位于 Keychain，必要时用 Secure Enclave key agreement/wrapping 增强设备绑定。
- [INFERRED] 敏感字段在 UI 生命周期结束后从可观察状态移除；日志、analytics、crash report 永不包含密码、私钥、Token、SID、TOTP。

## 9. 账号、Token 与设备绑定

### 9.1 正式绑定与开启流程

```text
前置：用户必须先在 Zephyr 主端 → 设置 → Zephyr Client 新增至少一个 Client Token

1. 用户在 Zephyr One → 文件同步添加 Zephyr 主端 HTTPS 地址
2. App 获取 /api/mobile/v1/capabilities
3. App 要求输入 Zephyr 用户名 + 密码并登录
4. 若该账号开启 TOTP，必须继续输入有效 TOTP 动态码
5. 如主端登录策略要求 CAPTCHA，使用系统认证会话完成；One 不提供策略配置页
6. App 生成稳定随机 deviceId 和设备密钥对
7. App 列出当前账号 Client Token metadata；用户选择一个已在主端创建的 Token，必要时扫码/粘贴 secret
8. POST /api/mobile/v1/devices/bind
9. 服务端原子校验：登录账号、Token owner、Token 状态、设备 challenge、客户端版本能力
10. 服务端登记 Zephyr One 设备并返回 access/refresh credential、初始 sync cursor
11. App 把 refresh credential、设备私钥和绑定 Token secret 写入安全存储
12. App 展示同步范围和自动间隔；用户确认“开启文件同步”
13. 立即执行第一次完整 bootstrap，成功后才显示“文件同步已开启”
14. 账号密码、TOTP 和表单中的 Token 临时副本立即从 UI 状态清除
```

[KNOWN] “主端先新增 Token”是硬前置，不允许 App 在零 Token 状态下偷偷自动创建默认 Token并绕过这个产品步骤；此时显示明确引导和刷新按钮。

[KNOWN] 绑定必须同时满足账号认证和 Client Token 所属关系：只有 Token、只有账号密码、或 TOTP 未完成，均不能绑定或开启同步。

[KNOWN] 绑定成功后，所选 Client Token 与账号的其他 Client Token 都作为完整同步实体互备；它们继续可供旧 Zephyr Agent、Zephyr One 绑定和文件桥接使用，不能被转换成只剩 metadata 的“手机专用 token”。

[INFERRED] `clientId` 使用随机 UUIDv4/UUIDv7 并持久化；设备改名不改变身份。access credential 短期有效，refresh credential 可撤销且服务端只保存 hash，并通过设备密钥证明减少 Bearer token 被盗风险。

[INFERRED] 用户名变化后绑定跟随不可变 userId；密码变化不删除已绑定设备，但主端可按安全策略要求重新认证。Token 删除/旋转会让引用该 Token 的 One 设备和旧 Agent立即失效，UI 明确提示受影响设备。

### 9.2 Client Token 双向互备语义

[KNOWN] Client Token 既是旧 Zephyr Agent 的认证材料，也是 One 绑定的必要前置，并且属于 Zephyr ↔ One 完整互备数据。其双向规则固定如下：

- [KNOWN] 主端新增 Token 后，所有已绑定且同步开启的 One 拉取 token id/name/secret/revision/时间字段；secret 使用设备 envelope。
- [KNOWN] One 中创建、改名、旋转或删除 Token 后，操作 push 回主端，再由 change feed传播到其他 One；服务端始终校验 owner userId 和敏感 grant。
- [KNOWN] 首台 One 的第一次绑定仍要求主端预先存在 Token，不能用“以后 Token 会同步”绕开冷启动前置条件。
- [INFERRED] Token 使用稳定 `tokenId` 做身份；旋转只改变 secret 和 revision，不生成另一个逻辑 Token，除非用户明确选择“复制为新 Token”。
- [INFERRED] 删除使用 tombstone 并传播到所有设备；这是 iCloud式一致删除。若用户需要抗误删恢复，使用版本化加密备份/回收保留期，而不是让离线设备把已删 Token 悄悄复活。
- [INFERRED] 某 Token 旋转/删除后，使用该 Token 的旧 Agent 和 One绑定立即断开；使用账号内其他有效 Token 的 One 保持在线并同步变更。
- [INFERRED] “重置全部 Token”在单个事务内为旧 Token 写 tombstone、断开关联客户端并创建新 Token；任何中间失败都必须回滚，避免账号进入零 Token 半完成状态。
- [INFERRED] 加密导出包含 Client Token record + secret envelope，恢复时按 `tokenId/revision/tombstone` 合并；不把 token 明文写入 ZIP/JSON。

### 9.3 主端登录策略兼容

- [KNOWN] One 不提供 CAPTCHA、IP白名单、防爆破或 Passkey 管理页面。
- [INFERRED] 若主端登录要求浏览器 CAPTCHA，服务端返回一次性 `authUrl`；Android使用 Custom Tabs，iOS使用 ASWebAuthenticationSession，完成后通过 app/universal link返回一次性 code。
- [INFERRED] IP白名单、防爆破、账号停用等由主端判定；One展示稳定错误码和说明，不绕过、也不在本地复制一套策略设置。
- [INFERRED] 若未来允许用 Passkey登录绑定，可调用系统 Credential API完成主端 challenge；这仍不是 One 的账号安全管理功能。

### 9.4 敏感验证、撤销与 Token 生命周期

[KNOWN] 以下操作必须走主端 `verifySensitiveAccess` 等价流程，不能只靠 App Lock/人脸：

- [KNOWN] 从 Zephyr Client 删除或撤销一个 Zephyr One 设备。
- [KNOWN] 查看/复制 Client Token secret。
- [KNOWN] 旋转、删除一个 Client Token。
- [KNOWN] 重置全部 Client Token。
- [KNOWN] 执行会让多个客户端断开的批量操作。

[KNOWN] 验证输入规则按用户要求固定为：账号未启用 TOTP 时输入当前 Zephyr 密码；账号已启用 TOTP 时输入当前有效 TOTP 动态码。服务端验证通过后签发短时、单次用途的 sensitive-action grant，具体删除/重置请求再消费该 grant，避免在多个请求重复发送密码/TOTP。

[INFERRED] 删除设备前显示设备名、平台、最后同步时间和将被清除的绑定；重置全部 Token 前列出会断开的旧 Agent 与 One 设备，并要求二次确认，但不能省略密码/TOTP验证。

- [INFERRED] 主端可暂停某设备同步、撤销设备、撤销 Token 或停用账号；任一条件触发后 access/refresh、文件桥接 lease 和后续同步均失效。
- [INFERRED] “暂停同步”不删本地数据；“解绑并删除本地镜像”先 revoke，再清除本机安全存储。离线解绑先本地锁死 credential，联网后补偿撤销。
- [INFERRED] 远程 wipe 只删除 App 自己的本地数据库与安全项，不能声称擦除用户另行导出的文件或系统云备份。

## 10. “文件同步”完整双向同步协议 `/api/mobile/v1`

### 10.1 为什么不扩展旧 pull

[KNOWN] 旧接口的 `revision` 是每次构建 snapshot 时递增的 client sync count，不是全局数据变更序号；它无法判断哪一条资源发生了什么变化。

[INFERRED] 新协议使用服务端单调 `changeSeq` 作为 cursor，并为每个实体保留 revision。cursor 解决“从哪里继续拉”，entity revision 解决“我编辑的基础版本是否仍然有效”。

### 10.2 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | [INFERRED] `/api/mobile/v1/capabilities` | 版本、功能、限制、认证方式、同步实体 registry hash |
| POST | [INFERRED] `/api/mobile/v1/devices/bind` | 账号 + Token 绑定设备 |
| POST | [INFERRED] `/api/mobile/v1/devices/refresh` | 轮换 access/refresh credential |
| PATCH | [INFERRED] `/api/mobile/v1/devices/:id` | 启停同步、更新名称和自动间隔 |
| DELETE | [INFERRED] `/api/mobile/v1/devices/:id` | 消费 sensitive grant 后撤销设备 |
| GET | [INFERRED] `/api/mobile/v1/sync/bootstrap` | 首次分页完整镜像 |
| GET | [INFERRED] `/api/mobile/v1/sync/changes?cursor=&limit=` | 增量 pull |
| POST | [INFERRED] `/api/mobile/v1/sync/push` | 全实体幂等批量 push |
| POST | [INFERRED] `/api/mobile/v1/sync/ack` | 确认已应用 cursor |
| POST | [INFERRED] `/api/mobile/v1/sync/now` | 手动同步握手/状态审计；客户端随后走同一 pull/push engine |
| GET | [INFERRED] `/api/mobile/v1/sync/status` | 状态、进度、cursor、错误、冲突数、上次成功时间 |
| POST | [INFERRED] `/api/mobile/v1/file-bridge/lease` | 获取短期底层 Agent/ZFT2 credential |
| GET | [INFERRED] `/api/mobile/v1/devices` | 查看账号 One 设备 |
| POST | [INFERRED] `/api/mobile/v1/sensitive/verify` | 用当前密码或 TOTP换一次性敏感操作 grant |

### 10.3 完整同步实体

[KNOWN] bootstrap/change feed/push 不能硬编码只处理 connection、note、proxy、key、jumpHost。One可编辑的 `entityType` 至少覆盖：

```text
connection, proxy, sshKey, jumpHost, note, noteGroup, snippet,
aiConversation, aiMessage, aiPlan, aiMemory, aiSkill, aiEnv,
oneUserSettings, serverSettings, backupMetadata, activityEvent,
resourceAcl, clientToken, workspaceState
```

[KNOWN] `accountSecurity/smtp/captcha/ipPolicy/beian/customCssJs` 不接受One push；若兼容快照携带，只进入opaque preservation区。

[INFERRED] One有用途的大对象（AI附件、终端背景图、用户请求下载的加密备份包等）使用content-addressed blob manifest + 分块上传/下载；备份恢复必须二次确认并显示主端进度。

[INFERRED] Client Token 的 secret envelope 只下发给已完成账号登录、TOTP（如启用）、Token 归属校验且设备未撤销的 One。旧 Zephyr Agent 继续只用 Token 连接 `/agent/files`，不获得账号完整同步权限。

### 10.4 Push 请求

```json
{
  "protocolVersion": 1,
  "deviceId": "018f...",
  "batchId": "018f...",
  "baseCursor": 4821,
  "operations": [
    {
      "opId": "018f...",
      "entityType": "connection",
      "entityId": "018e...",
      "action": "upsert",
      "baseRevision": 7,
      "clientModifiedAt": 1786093200000,
      "fieldMask": ["name", "remark", "rdp.quality"],
      "payload": {
        "name": "Office RDP",
        "remark": "Primary workstation",
        "rdp": { "quality": "balanced" }
      }
    }
  ]
}
```

[INFERRED] `clientModifiedAt` 只用于 UI 和三方合并提示，不用于决定胜负；设备时钟不可信。服务端接收顺序、baseRevision 与 ACL 才是权威。

### 10.5 Push 响应

```json
{
  "ok": true,
  "batchId": "018f...",
  "serverCursor": 4824,
  "results": [
    {
      "opId": "018f...",
      "status": "accepted",
      "entityId": "018e...",
      "revision": 8,
      "changeSeq": 4824
    }
  ],
  "changesAvailable": true
}
```

[INFERRED] `status` 枚举：`accepted / duplicate / conflict / rejected / dependency_missing`。重复 opId 必须返回第一次的同一逻辑结果，不得再次执行。

### 10.6 Change feed

```json
{
  "fromCursor": 4821,
  "nextCursor": 4824,
  "hasMore": false,
  "changes": [
    {
      "changeSeq": 4824,
      "entityType": "connection",
      "entityId": "018e...",
      "action": "upsert",
      "revision": 8,
      "actorDeviceId": "018f...",
      "changedAt": 1786093200400,
      "payload": { "...": "full authorized entity or patch" }
    }
  ]
}
```

- [INFERRED] App 按 changeSeq 顺序在单个本地事务中应用一页，再持久化 cursor；崩溃后最多重放同一页。
- [INFERRED] 服务端 payload 只包含该用户有权发现的资源；自有资源可包含设备公钥加密的 secret envelope，共享资源按 ACL 决定字段。
- [INFERRED] 同一设备自己刚 push 的变化也可出现在 feed；本地按 revision 去重，不依赖“服务端别发给我”。
- [INFERRED] bootstrap 分页完成前，push queue 可以收集但不发送；完成后先 pull 到最新 cursor，再提交本地操作。

### 10.7 服务端表

```sql
CREATE TABLE mobile_devices (
  device_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  app_version TEXT,
  public_key_jwk TEXT NOT NULL,
  refresh_token_hash TEXT,
  status TEXT NOT NULL,
  last_acked_cursor INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE mobile_sync_changes (
  change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_device_id TEXT,
  changed_at INTEGER NOT NULL,
  tombstone_json TEXT
);

CREATE TABLE mobile_applied_ops (
  owner_user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  applied_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, device_id, op_id)
);
```

[INFERRED] 变更日志不复制秘密明文；upsert 时按当前资源和 ACL生成响应，delete 使用 tombstone。`mobile_applied_ops` 设保留期，但保留期不得短于客户端允许的最长离线重试窗口。

### 10.8 服务端写入路径

- [INFERRED] 所有mobile push必须调用One范围内的业务service（`ResourceService`、`NotesService`、AI使用数据、One/server settings、backup、token/ACL services），不能直接写SQLite绕过权限、敏感确认、审计和revision。
- [INFERRED] 所有 Web/API 持久写入都必须经过 change-log hook；连接、笔记、AI、设置、Token、ACL 或未来新增业务写入若没有产生 `mobile_sync_changes`，契约测试失败。
- [INFERRED] 业务写入和 change log 插入处于同一数据库事务；不允许资源成功但 feed 丢失。
- [INFERRED] Token owner 从 username 逐步迁移到不可变 userId，同时保留旧数据兼容读取；用户名修改不应断开设备归属。
- [INFERRED] Token secret change 只记录“该 token revision 变化”，不把明文放进 change log；响应时按目标设备即时生成 envelope。
- [KNOWN] mobile push 支持服务器设置和备份metadata，但必须复用主端现有权限/敏感确认；不接受SMTP、CAPTCHA/IP策略、备案、账号安全或自定义CSS/JS修改，收到这些entityType返回`unsupported_scope`。

## 11. 冲突与删除规则

### 11.1 总规则

- [INFERRED] 每个 upsert/delete 都携带 `baseRevision`；匹配当前 revision 才直接应用。
- [INFERRED] baseRevision 落后时，服务端用 fieldMask 与自该 revision 后的字段变更尝试非重叠合并；字段重叠则返回 conflict。
- [INFERRED] 客户端不得静默 last-write-wins 覆盖密码、私钥、路由依赖、Note content 或 delete。
- [INFERRED] 冲突记录保存在本机，UI 提供“保留本机 / 使用主端 / 复制为新项 / 手工合并”。

### 11.2 类型策略

| 类型 | 策略 |
| --- | --- |
| Connection | [INFERRED] 字段级三方合并；host/auth/route 同字段冲突需用户选择 |
| Proxy/SSH Key/JumpHost | [INFERRED] metadata 可字段合并；secret 原子冲突 |
| Note | [INFERRED] title/tags/group 字段合并；content 尝试三方文本合并，失败生成 conflict copy |
| One user/server settings | [INFERRED] 分section/field revision；排除的Web登录/展示字段只opaque保留，不由One写入 |
| Backup metadata | [INFERRED] 服务端jobId/revision为权威；恢复操作不做字段合并，只允许显式重试 |
| AI conversation/message | [INFERRED] append-only messageId 去重；编辑/删除用 revision/tombstone |
| AI使用所需配置/Env/Token | [INFERRED] metadata 可字段合并；secret 原子冲突且必须重新 envelope |
| Snippet | [INFERRED] name/tags/autoRun 字段合并；command 冲突要求选择或复制 |
| Activity/SecurityEvent | [INFERRED] eventId append-only 去重，不做 last-write-wins |
| ACL/share | [INFERRED] 服务端权限为权威；权限撤销立即覆盖离线缓存能力 |
| Delete vs edit | [INFERRED] tombstone 胜出；用户可显式 restore 成新 revision |
| Shared resource | [INFERRED] 无 EDIT capability 时本地不得排队写操作 |

### 11.3 依赖顺序

- [INFERRED] push 拓扑顺序为 SSH Key/Proxy → Jump connection/JumpHost → target Connection → Note link。
- [INFERRED] 若依赖尚未同步，服务端返回 `dependency_missing`，客户端保留 op 并在依赖成功后重试，不把它当永久失败。
- [INFERRED] 删除依赖前，UI列出受影响连接；服务端仍做最终引用校验。

## 12. Secret 同步

[INFERRED] TLS 是最低要求，但绑定后的 access credential 泄漏不应直接暴露所有连接密码。为继承 Zephyr `secret-crypto.js` 已采用的 ML-KEM-768 方向，正式设备 envelope 使用 `ML-KEM-768+HKDF-SHA256+AES-256-GCM`；设备另持有 ES256 signing key 证明请求来源。JSON Schema、AAD 的 NUL 分隔字节、Base64、tag、keyVersion、entityRevision 与跨端测试向量以 [`DATA_AND_MIGRATION.md`](DATA_AND_MIGRATION.md) 和 [`contracts/schemas/secret-envelope.schema.json`](contracts/schemas/secret-envelope.schema.json) 为唯一细节真源，禁止 Android/iOS各自解释一版。

- [INFERRED] 服务端生成 envelope 时可短暂接触明文，因为现有 Web 主端本来就需要解密凭据建立会话；明文不得进入 change log、日志或缓存。
- [INFERRED] 设备私钥不可导出时优先不可导出；不支持硬件密钥的设备退化为 Keychain/Keystore 保护的软件密钥并在安全页明确显示。
- [KNOWN] 完整镜像模式必须同步当前账号自有的连接凭据、SSH Key、代理密码、AI secret 和 Client Token；不能用默认关闭的“只同步 metadata”偷换产品要求。
- [INFERRED] 可额外提供用户主动选择的“此设备不下载敏感字段”安全模式，但它是明确降级：UI 必须显示该设备不是完整镜像，并且不能改变主端仍保有完整数据的事实。
- [KNOWN] shared-to-me 资源全部排除在 mobile mirror/SecretStore/local DB 外；共享 AI、笔记、文件和业务操作每次在线请求主端并实时重验 ACL，细节见 [`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)。
- [KNOWN] 共享连接默认使用主端 relay，owner secret 不下发；若 owner policy 允许原生 direct，主端只可签发一次、短时、绑定 device/session/resource/revision/purpose/nonce 的 encrypted use envelope，One 仅在 native SessionSecretArena 内解密、不持久化并尽力清零。
- [KNOWN] direct 模式意味着连接材料曾在 One 内存出现，不能宣传“秘密未到设备”；若 owner 要求绝不下发则强制 relay，relay 不可用时拒绝连接。
- [KNOWN] Client Token envelope 解密后只进入 SecretStore；文件同步导出/恢复必须能恢复 token record 与 secret，确保 Zephyr 与 One 互备。

## 13. “文件同步”与底层 Zephyr Agent 能力整合

### 13.1 产品命名与概念拆分

[KNOWN] Zephyr One 内不出现独立“Zephyr Agent”页面或导航项；原设置位置改名为 **文件同步**。代码、协议日志和兼容 API 可使用 `agent` 技术术语，但用户可见文案统一为“文件同步”“设备文件”“文件桥接”。

[INFERRED] 文件同步页面同时承载三类关联能力，不能混为一个开关：

1. [KNOWN] **账号数据同步**：像 iCloud 一样完整双向镜像 Zephyr 持久数据，是本章之外 `/api/mobile/v1/sync/*` 的核心能力。
2. [INFERRED] **本机 RDP 存储重定向**：原生 RDP 会话直接把已授权目录作为 RDPDR drive 暴露给远端 Windows，不经过 Zephyr 主端。
3. [INFERRED] **主端文件桥接**：App 通过兼容 `/agent/files` + ZFT2 的底层传输，让当前账号在 Zephyr 主端 Web RDP 中挂载手机目录。

[INFERRED] 后两条路径复用同一个 `FileSyncShareProfile`、路径监禁和 ZFT2 provider，但网络拓扑不同；账号数据同步不读用户文件内容，除非用户显式选择文件桥接目录。

### 13.2 RDP 编辑器中的文件同步配置

```text
存储重定向
  模式：关闭 / 每次询问 / 使用本机共享 / 供 Zephyr 主端使用
  共享配置：<选择 FileSyncShareProfile>
  共享名：PHONE / DOCUMENTS / 自定义
  权限：只读 / 读写
  多目录：允许选择多个 profile
  会话结束：立即关闭 / 空闲 N 分钟关闭 / 保持主端文件桥接在线
  主端可见：仅当前绑定账号
```

- [INFERRED] 目录授权本机化：同步的连接只保存 `storageIntent=enabled/ask/off`，具体 profileId 放进 `DeviceConnectionOverride`。
- [INFERRED] 首次启动 RDP 时若找不到本机 profile，弹出目录选择器，不自动共享整个存储。
- [INFERRED] 读写能力由 profile、RDP connection 和服务端三层取最严格值；任一层只读，最终只读。
- [INFERRED] UI 显示在线状态、共享目录数、传输字节、最近错误和手动停止。

### 13.3 ZFT2 兼容规范

```text
Offset  Size  Field
0       4     ASCII "ZFT2"
4       1     version = 2
5       1     operation
6       2     flags, big-endian
8       4     requestId, big-endian
12      4     metadataLength, big-endian
16      4     payloadLength, big-endian
20      N     UTF-8 JSON metadata
20+N    M     payload
```

| Op | Code | 行为 |
| --- | ---: | --- |
| OPEN | [KNOWN] `0x01` | 返回 handle |
| READ | [KNOWN] `0x02` | offset/length，payload 返回 bytes |
| WRITE | [KNOWN] `0x03` | offset + binary payload |
| CLOSE | [KNOWN] `0x04` | 关闭 handle |
| STAT | [KNOWN] `0x05` | 文件 metadata |
| LIST | [KNOWN] `0x06` | 目录 entries |
| MKDIR | [KNOWN] `0x07` | 建目录 |
| DELETE | [KNOWN] `0x08` | 删除，支持 recursive |
| RENAME | [KNOWN] `0x09` | oldPath/newPath |
| TRUNCATE | [KNOWN] `0x0A` | 调整 size |
| CANCEL | [KNOWN] `0x0B` | targetRequestId |
| PING | [KNOWN] `0x0C` | Agent 时间/活性 |

- [KNOWN] response flag 为 `0x0002`，error flag 为 `0x0001`。
- [INFERRED] 两端默认 maxInflight 8；实际值使用 hello capability 协商并限制到 1～16。
- [INFERRED] Android SAF chunk 默认 256 KiB；iOS 可协商更大，但首版统一 256 KiB 能减少平台差异，性能测试后再提高。
- [INFERRED] 同一路径的 open/write/truncate/close/rename/delete 串行，不同路径与 read 可并行。
- [INFERRED] handle 使用不可预测随机值，disconnect 时全部关闭；每个 handle 绑定 canonical path 和访问模式。

### 13.4 路径安全

- [INFERRED] 所有虚拟路径先拒绝 NUL、空段、`.`、`..`、绝对本机路径和平台分隔符逃逸，再映射到授权 root。
- [INFERRED] Android 只通过 DocumentFile/ContentResolver 操作已授权 tree；iOS 只在 security-scoped root 内协调访问。
- [INFERRED] 不跟随越出 root 的符号链接；无法可靠判断时拒绝。
- [INFERRED] 文件名、大小、时间、可读写能力来自平台实际结果，不能固定返回 `canWrite=true`。
- [INFERRED] 限制 metadata、payload、并发、打开 handle 数、单次 list entry 数和递归删除范围，防止内存/句柄耗尽。

### 13.5 生命周期

- [INFERRED] Android：用户开启“保持主端文件桥接在线”后启动 foreground service；网络切换后指数退避重连并加随机抖动；通知提供停止 action。
- [COMMON] iOS 普通 App 进入后台后不能保证 WebSocket 持续存活。
- [INFERRED] iOS：前台运行文件桥接 transport；进入后台时完成短暂清理并告知主端 offline。原生 RDP 正在前台显示时，本机 drive redirection 可继续。
- [INFERRED] iOS UI 必须明确写“离开 App 后主端文件映射会暂停”，不得显示虚假的常驻开关。
- [INFERRED] 两端恢复前台后先验证绑定状态和 file-bridge lease，再自动重连。

### 13.6 文件桥接 credential

- [INFERRED] 正式方案使用 `/api/mobile/v1/file-bridge/lease` 生成绑定设备的短期 credential，`/agent/files` 同时接受旧 Client Token 和新 lease。
- [INFERRED] lease 与 userId、deviceId、tokenId、share policy 和过期时间绑定；撤销设备或 Client Token立即使 lease 失效。
- [KNOWN] 原始 Client Token 不只是过渡数据，而是完整互备实体；在 One 中必须放安全存储，绝不放普通 DB、SharedPreferences/UserDefaults 或日志。

## 14. 本地连接数据面

### 14.1 SSH

- [INFERRED] 支持密码、内联私钥、密钥库、私钥口令、host key verification、SOCKS5、HTTP CONNECT 和最多 8 级 SSH jump chain。
- [INFERRED] 首次遇到未知 host key 时显示算法与 SHA-256 fingerprint；用户确认后按 `serverProfile/host/port` 保存。host key 改变默认阻断，不用普通 toast 一键忽略。
- [INFERRED] PTY resize 跟随可见终端像素与字号；输入、输出、resize、disconnect 进入有序 actor/serial queue。
- [KNOWN] SFTP 文件管理、代码编辑、预览、Docker 和监控面板都属于最终必备功能；可在基础终端之后按里程碑实现，但正式范围和发布验收不得删除它们。

### 14.2 Telnet

- [INFERRED] 支持 IAC、NAWS、TTYPE、编码 UTF-8/GBK/Big5/Latin-1 与可选 prompt auto-login。
- [INFERRED] 每次新增 Telnet 连接显示明文风险；公网目标可增加二次确认但不伪装成加密。

### 14.3 RDP

- [INFERRED] native engine 负责证书、TLS/NLA、图形、音频、输入、剪贴板和 RDPDR；UI 层不处理协议包。
- [INFERRED] RDP 证书采用独立 trust store；首次信任显示 subject、issuer、有效期和 fingerprint，证书变化默认阻断。
- [INFERRED] 画质/FPS 是期望值而不是保证值；engine 根据设备解码能力、网络和服务端协商降级并向 UI报告实际值。
- [INFERRED] 摄像头、麦克风、位置和文件权限仅在连接启用且会话实际请求时申请，拒绝后该通道关闭而不是让整个 RDP 失败。

### 14.4 VNC

- [INFERRED] 支持协议协商、认证、像素格式、增量 framebuffer、剪贴板和输入；TLS扩展按所选引擎能力明确列出。
- [INFERRED] 不支持的加密/认证类型返回具体错误，不回退到未知弱模式。

### 14.5 批量执行

- [INFERRED] 仅对 SSH 连接启用；并发上限用户可设，默认保守值 4。
- [INFERRED] 每台主机有独立状态、stdout/stderr、exit code、duration、取消；一台失败不取消全部，除非用户选择 fail-fast。
- [INFERRED] 结果默认只保存在本机活动记录；用户可导出，不把大段命令输出塞进核心同步 feed。

## 15. 主端 API 与兼容实现

### 15.1 新模块职责

- [INFERRED] `mobile-device-manager.js`：账号+Token绑定、refresh、撤销、设备 key、file-bridge lease、自动间隔和同步状态。
- [INFERRED] `mobile-sync-service.js`：bootstrap、pull、push、冲突、ACL。
- [INFERRED] `mobile-change-log.js`：事务内 changeSeq、tombstone、cursor retention。
- [INFERRED] `mobile-secret-envelope.js`：按设备公钥生成 secret envelope。
- [INFERRED] `mobile-contracts.js`：协议版本和 JSON Schema 校验。

### 15.2 主端 Zephyr Client 与兼容接口

- [KNOWN] Zephyr 主端设置页用户可见名称统一为 **Zephyr Client**，不是 Zephyr Agent；内部 route/file 名可为兼容保留。
- [KNOWN] 同一页面保留原有 Agent 功能：Client Token CRUD、旧 Agent 在线列表、文件映射状态；同时增加 One 设备列表、平台/版本、同步开关、自动间隔、最后同步、手动触发、删除。
- [KNOWN] `/api/auth/login` 和 `/api/auth/totp/verify` 是 One 开启同步的强制账号认证基础；native credential 不能绕开 TOTP。
- [INFERRED] `/api/one/*` 标记 legacy pull-only；旧 Tauri One 继续可用，新原生端使用 mobile v1。
- [KNOWN] `/api/rdp/file-agent-tokens` 继续服务旧 Agent 与 Zephyr Client 页面；token manager 扩展 revision/change-log/secret envelope 后同时服务 One 完整互备。
- [INFERRED] `/agent/files` 同时支持旧 `hello.token` 与新 `hello.lease`，通过 capability negotiation 区分，不破坏旧 Agent。
- [KNOWN] One 设备删除、Token 查看/复制/旋转/删除、重置全部必须消费密码/TOTP sensitive grant；前端改名不能削弱服务端验证。
- [INFERRED] 主端“手动同步”向目标 One 写入 sync wake event（在线时 SSE/WebSocket/push），设备随后仍走相同幂等 pull/push engine；主端不能直接覆盖设备 DB。

### 15.3 错误格式

```json
{
  "ok": false,
  "error": {
    "code": "sync_conflict",
    "message": "Connection changed on another device",
    "retryable": false,
    "details": {
      "entityType": "connection",
      "entityId": "...",
      "currentRevision": 9
    },
    "requestId": "srv_..."
  }
}
```

- [INFERRED] App 只根据稳定 code 分支，message 用于展示；不得解析中文 message 判断逻辑。
- [INFERRED] 401 触发一次 refresh；refresh 失败进入“绑定失效”。403 不无限重试；409 进入冲突；429 尊重 Retry-After；5xx/网络错误指数退避。

## 16. 安全要求

### 16.1 网络

- [INFERRED] 默认只接受 HTTPS/WSS，系统信任链严格校验。
- [INFERRED] 自签部署通过安装私有 CA、显式 fingerprint pairing 或受控 TOFU 支持；不提供默认“忽略所有证书错误”。
- [INFERRED] debug build 可有临时不安全开关，但 release build 必须编译掉全局 trust-all verifier。
- [INFERRED] HTTP 请求有 requestId、合理 connect/read/write timeout、body size limit；redirect 不得把 Authorization 发往不同 origin。

### 16.2 本地

- [KNOWN] One 不建立自己的用户名/密码/找回密码系统，启动 App 不显示 Zephyr Web 登录墙；这与“开启文件同步时必须登录 Zephyr 主端”是两个独立流程。
- [KNOWN] 本地 App Lock 默认可选，只调用系统原生设备认证：Android BiometricPrompt（指纹/人脸/设备凭据）、iOS LocalAuthentication（Face ID/Touch ID/设备密码）。不得要求用户再创建一个 Zephyr One 专用解锁密码。
- [INFERRED] App Lock 开启后支持立即/1分钟/5分钟锁定；锁定遮住 UI并清除内存中的已解密 secret。系统认证不可用时，设置页明确提示不可用，不降级成应用自建弱密码。
- [INFERRED] Android 禁止明文备份敏感 DB；iOS 敏感 Keychain item 设为 ThisDeviceOnly，数据库备份策略明确区分可恢复 metadata 与不可迁移 device identity。业务 secret 仍通过文件同步/加密导出恢复。
- [INFERRED] 截图保护可对密码/私钥页与 RDP session 独立配置；Android 使用 secure window，iOS 在 capture 状态变化时遮罩敏感页。
- [INFERRED] 剪贴板写入密码/Token 前提示并设置自动清理；读取系统剪贴板只在用户动作后发生。

### 16.3 服务端

- [INFERRED] Token 比较使用 constant-time；refresh 与 file-bridge lease 只存 hash。
- [INFERRED] bind、refresh、push、secret reveal、file-bridge lease 都限速并写审计，但审计 metadata 不含 secret。
- [INFERRED] 设备 public key、app version、platform、last seen、last sync、revoked reason 在主端 Zephyr Client 页面查看，不在 One 建账号安全页。
- [INFERRED] 所有 resource ownership 使用不可变 userId，不依赖可改 username。

### 16.4 威胁模型最低覆盖

- [INFERRED] 被盗 deviceToken、refresh replay、恶意代理、旧设备撤销、数据库拷贝、日志泄密、path traversal、symlink escape、ZFT2 length bomb、op replay、cursor 回退、共享资源越权、冲突覆盖和 rooted/jailbroken device。
- [INFERRED] root/jailbreak 检测只能作为风险信号，不能声称能可靠阻止拥有系统控制权的攻击者。

## 17. 文件同步设置、调度与离线体验

### 17.1 One 设置页

[KNOWN] 原 Zephyr Agent 设置槽位改为 **文件同步**，至少显示：

```text
文件同步                      [总开关]
Zephyr 主端                  https://...
绑定账号                     username
绑定 Token                   token name / token id
设备名称                     My Phone
自动同步                     [开关]
自动同步间隔                 用户自定义
仅 Wi-Fi / 允许蜂窝网络       [策略]
上次成功                     时间
当前状态                     空闲/扫描/上传/下载/冲突/失败
进度                         已处理实体与字节
[立即同步] [查看冲突] [重新绑定] [解绑]
设备文件桥接                 目录、只读、生命周期
```

[KNOWN] 必须同时有用户可编辑的自动同步间隔和“立即同步”按钮；不能只依赖系统后台任务，也不能把手动同步藏在下拉刷新里。

[INFERRED] 间隔输入接受 `30秒～24小时` 作为产品配置。前台用精确定时器按该值触发；Android/iOS 后台受系统调度时，保存用户目标间隔并在系统给予执行窗口时尽快同步。UI 同时展示“目标间隔”和“最近实际同步”，不能谎称后台会精确到秒。

### 17.2 触发与串行化

- [INFERRED] 任一实体本地保存先写本地 DB 和 PendingOperation，UI立即成功；网络同步状态显示“待同步”。
- [KNOWN] App 前台启动、绑定完成、用户点“立即同步”、自动间隔到期、网络恢复、本地写入 debounce、主端 wake event 时触发同步。
- [INFERRED] 手动同步不受自动同步总开关影响：只要设备仍绑定，用户始终可点“立即同步”；完全解绑后才禁用。
- [INFERRED] 同一账号同一时刻只运行一个 sync actor；新触发合并为 rerun flag，不并发修改 cursor。用户连续点击只产生一次当前任务 + 最多一次尾随任务。
- [INFERRED] 普通轮顺序固定为：验证绑定/registry → push 本地 pending ops → pull changes 到最新 → 处理 blob → ack cursor → 更新状态。首次绑定固定为 bootstrap → catch-up pull → push bootstrap期间 pending ops → pull → blob → ack；事务、崩溃恢复和 cursor 不变量以 [`SYNC_STATE_MACHINE.md`](SYNC_STATE_MACHINE.md) 为准。

### 17.3 平台后台行为

- [INFERRED] Android 使用 WorkManager 做持久调度；当用户选择非常短间隔且明确启用“持续同步”时，使用带常驻通知的 foreground service，不利用后台限制漏洞。
- [COMMON] iOS BGTask 执行时间由系统决定；前台按用户间隔精确触发，后台通过 BGAppRefresh/BGProcessing、静默推送和下次前台补偿。
- [INFERRED] 平台延迟不改变用户配置值；设置页显示下一次计划、上次尝试、上次成功和“系统延迟”原因。

### 17.4 错误与离线

- [INFERRED] push queue 对 retryable 错误保留；永久 4xx 标记“需要处理”，不无限耗电重试。
- [INFERRED] Token 被删除/旋转、设备被撤销、密码安全策略要求重认证时，状态变为“需要重新绑定”，停止上传但保留本地镜像。
- [INFERRED] 离线时共享资源可读缓存但禁止首次下载 secret；ACL 过期策略可由主端下发，超过期限要求联网重新授权。
- [INFERRED] 手动同步结果必须明确区分：全部成功、成功但有冲突、部分失败、绑定失效；只显示一个模糊 toast 不合格。

## 18. 从 Tauri One / Flutter Agent 迁移

### 18.1 原则

- [KNOWN] 早期要求建立的 `zephyr_one/` Tauri 全端实现和当前 Kotlin/Swift 原生移动方案并不同时作为最终 UI 架构；当前要求优先，Tauri One 成为迁移源和桌面兼容实现。
- [INFERRED] 原生版不是直接覆盖后让旧数据消失。Android 同包名升级可访问原 App 私有目录；iOS 同 bundle/container 条件下也可读取旧容器数据，但迁移代码必须在旧格式仍存在时执行。
- [KNOWN] 当前 One 可能保存 localStorage 绑定状态/快照，并在本机运行完整 Zephyr core；这些数据格式与新原生 DB 不等价。
- [KNOWN] 旧独立 Flutter Agent 继续兼容主端；One 不复制它的独立页面，但可迁移 Token、授权意图和共享 profile 到“文件同步”。

### 18.2 迁移步骤

1. [INFERRED] 发布最后一个 Tauri 过渡版本，写出版本化 `native-migration-v1.json.enc`；SID/deviceToken 不导出，Client Token和其他业务 secret 只能放进一次性迁移 envelope，绝不明文导出。
2. [INFERRED] 新原生版首次启动检测旧容器与迁移文件，导入 connection/note/proxy/key/settings/token 等完整持久数据。
3. [INFERRED] 所有 secret 使用一次性迁移 key envelope；无法安全读取时提示重新绑定主端，再由完整文件同步恢复，不能静默丢弃。
4. [INFERRED] 导入完成写不可逆 marker，保留加密备份一个版本周期，之后由用户确认删除。
5. [INFERRED] 旧 One deviceToken 不能直接复制到新安全模型；原生版执行一次重新绑定/credential upgrade，但 Client Token 作为业务互备数据保留。
6. [INFERRED] 文件桥接的 SAF tree URI 和 iOS bookmark通常需要重新授权，不能假设跨框架可直接复用。

### 18.3 包与发布

- [INFERRED] Android 保留 package `com.zephyr.one` 和正式签名链；versionCode 单调递增。
- [INFERRED] iOS bundle id、entitlements、Keychain access group、associated domains 在签名方案确认后冻结。
- [INFERRED] 独立 Agent 的 Token/profile 可通过安全二维码迁移到整合版；二维码使用一次性短期 pairing code，不直接展示长期 Token。

## 19. 测试策略

### 19.1 契约测试

- [INFERRED] OpenAPI/JSON Schema 对所有 request/response 做正反例测试。
- [INFERRED] Node、Kotlin、Swift 对同一 fixture 解码后字段完全一致，再编码需通过 canonical comparison。
- [INFERRED] 旧 `/api/one` 和旧 Agent hello/ZFT2 行为建立回归测试，新增 mobile API 不改变旧客户端。

### 19.2 ZFT2

- [INFERRED] 从当前 JS/Dart 生成 golden frames，Kotlin/Swift 逐字节相等。
- [INFERRED] 覆盖 magic/version/flags/endian、0/最大长度、length mismatch、非法 JSON、超限 payload、requestId wrap、cancel、乱序 response。
- [INFERRED] parser 接受 libFuzzer/Jazzer/Swift fuzz 或等价模糊测试；随机输入不得 crash、OOM 或越界。
- [INFERRED] 1 KiB、256 KiB、1 MiB、100 MiB、1 GiB 文件传输以 SHA-256 校验，覆盖断网、取消、短读、重复 write、truncate race。

### 19.3 完整文件同步

- [INFERRED] 两设备同时改不同字段应自动合并；同字段应稳定产生 conflict。
- [INFERRED] 离线创建→改名→删除在上线后折叠为最小操作，不产生幽灵资源。
- [INFERRED] 同 batch/op 重放 100 次只执行一次；cursor 页应用中途 crash 后重放不重复业务副作用。
- [INFERRED] Web、Android、iOS 三方修改都进入同一 feed。
- [KNOWN] 对 `SYNC_ENTITY_REGISTRY` 的**每个实体**自动参数化执行 bootstrap、incremental、push、conflict、delete、restore、unknown field 和 secret envelope；不能只手写 connection/note 测试。
- [INFERRED] schema migration 测试断言新字段已分类为 editableSync、opaquePreserve、deviceLocal 或 serverOnly；未分类即失败。
- [INFERRED] 覆盖AI使用数据/Env、One/server settings、backup metadata/job、activity、snippet、ACL、blob和Client Token secret的Zephyr→One→Zephyr往返；账号安全/SMTP/CAPTCHA/IP策略/备案/CSS-JS只验证opaque preservation和拒绝One push。
- [INFERRED] 覆盖时钟快/慢 24 小时、服务端重启、Token 旋转、账号改名、设备撤销、共享权限撤销和 tombstone retention。
- [KNOWN] 绑定矩阵覆盖：主端无 Token、错账号 Token、密码错、需要 TOTP但缺失、TOTP错/过期、成功；敏感操作覆盖密码模式和 TOTP模式。
- [KNOWN] 调度测试覆盖自动间隔更新、自动开关、手动同步不受自动开关影响、重复点“立即同步”合并、主端 wake、后台延迟和前台补偿。

### 19.4 协议集成环境

- [INFERRED] CI/测试实验室提供 OpenSSH、Telnet、SOCKS5、HTTP CONNECT、两级 SSH bastion、xrdp/Windows RDP 测试机、VNC server、Zephyr main。
- [INFERRED] SSH 覆盖密码、RSA/Ed25519 key、host key change、SFTP、大输出、窗口 resize、代理与跳板。
- [INFERRED] RDP 覆盖 NLA、证书首次/变化、分辨率变化、音频、剪贴板、触控、文件同步 drive、断网重连。
- [INFERRED] VNC 覆盖不同像素格式、增量更新、认证失败、剪贴板和重连。

### 19.5 平台测试

- [INFERRED] Android unit + instrumented test + Compose UI test；至少一台低内存真机和一台主流真机验证 SAF、Keystore、生物识别、前台服务和网络切换。
- [INFERRED] iOS unit + UI test + simulator；至少一台真机验证 Keychain/Secure Enclave、DocumentPicker bookmark、LocalAuthentication、后台/前台和内存压力。
- [INFERRED] 仅模拟器通过不能作为文件同步目录授权和后台行为验收。
- [INFERRED] UI snapshot/golden 覆盖四主题、深浅模式、动态字体、中文/英文、RTL准备、横竖屏和 Reduce Motion。

### 19.6 安全测试

- [INFERRED] path traversal、符号链接逃逸、恶意文件名、超大目录、handle 泄漏、Token 日志扫描、TLS MITM、redirect credential leak、SQL/JSON injection、ACL 越权、refresh replay。
- [INFERRED] release artifact 自动扫描 `http://`、trust-all verifier、debuggable、明文 secret fixture 和过宽 entitlement/permission。

## 20. 性能与质量门槛

[INFERRED] 以下是验收目标，不是对所有设备的事实承诺：

- [INFERRED] 参考中端真机冷启动到可交互首页 p95 ≤ 2.5s；已有本地缓存时不等待网络。
- [INFERRED] 连接列表 2,000 项搜索/滚动无主线程长任务，滚动目标 60fps。
- [INFERRED] SSH 本地输入到 glyph 提交 p95 ≤ 50ms（不含网络 RTT）。
- [INFERRED] 文件同步 10,000 个实体使用分页/流式处理，峰值内存不随全量 JSON线性翻倍。
- [INFERRED] 文件桥接 1 GiB 传输 checksum 正确，断线不泄漏 handle，取消后 2 秒内停止继续读取。
- [INFERRED] App 未打开会话时不维持无必要 socket；Android 用户明确开启的文件桥接 foreground service 除外。
- [INFERRED] crash-free、ANR、OOM、sync error rate、file-bridge reconnect count 和 protocol error code 可观测，但 telemetry 默认不含主机名、用户名、路径和 secret。

## 21. CI/CD

### 21.1 Android pipeline

1. [INFERRED] ktlint/detekt、unit tests、schema contract tests。
2. [INFERRED] native core/JNI build 与 ABI 检查。
3. [INFERRED] Compose instrumented tests、文件同步/文件桥接/ZFT2 integration。
4. [INFERRED] release APK/AAB 签名、versionCode、package、permission、network security config 验证。
5. [INFERRED] 安装升级测试：已发布 Tauri One → 原生版，验证数据迁移和签名链。

### 21.2 iOS pipeline

1. [INFERRED] SwiftFormat/SwiftLint、unit tests、schema contract tests。
2. [INFERRED] native core 编译为 device/simulator architecture，检查 symbols 与 bitcode要求按当前 Xcode规则处理。
3. [INFERRED] simulator UI tests；真机测试由受控 runner/TestFlight 阶段完成。
4. [INFERRED] archive、entitlement、privacy manifest、bundle version、签名检查。
5. [INFERRED] 同 bundle id 升级迁移测试。

### 21.3 Server pipeline

- [INFERRED] SQLite migration up/down/重复执行测试。
- [KNOWN] schema分类完整性门：新增字段未归入 editableSync、opaquePreserve、deviceLocal或serverOnly时CI失败；不能默认把服务器后台变成One功能。
- [INFERRED] mobile v1 API contract、One实体/服务器设置/备份往返、明确排除字段push拒绝、opaque preservation、blob、secret/Client Token envelope、ACL、事务、幂等、cursor与tombstone测试。
- [KNOWN] Zephyr Client 页面命名、旧 Agent兼容、One 设备管理、自动间隔/手动同步、密码/TOTP敏感验证 contract tests。
- [INFERRED] 旧 Web、旧 Tauri One、旧 Flutter Agent 全量回归。
- [INFERRED] Android/iOS client compatibility matrix 至少覆盖当前版和前一版 server。

## 22. 实施里程碑与退出门

### M0：协议冻结与风险验证

- [INFERRED] 完成 mobile OpenAPI、数据 schema、ZFT2 vectors、RDP/SSH/VNC library spike、许可证审计。
- [INFERRED] 退出门：Android/iOS 都能用候选 RDP core 连到测试服务；iOS 文件桥接生命周期限制已在产品文案确认。

### M1：原生壳与本地数据

- [INFERRED] 完成四入口底部浮岛、主题、连接列表/编辑、本地 DB、SecretStore、App Lock。
- [INFERRED] 退出门：无网络可完整 CRUD，浮岛几何/中断动画/大字体/安全区测试通过，重启后数据与 secret 正确恢复，敏感字段不出日志。

### M2：服务端 mobile v1 与完整双向文件同步

- [INFERRED] 完成账号+Token+TOTP绑定、One实体registry/后台字段分类、bootstrap/change feed/push、blob、冲突、tombstone、secret/Client Token envelope、自动间隔与手动同步。
- [INFERRED] 退出门：Zephyr持久schema 100%完成editable/opaque/deviceLocal/serverOnly分类；Web+两台移动设备chaos matrix通过，Token/AI使用数据/One与服务器设置/备份metadata/ACL/活动和凭据均能往返，明确排除字段不被One覆盖。

### M3：文件同步底层 Agent 能力整合

- [INFERRED] 完成无独立 Agent 页的 Android SAF、iOS security-scoped provider、ZFT2、Android foreground service、iOS 前台状态提示、RDP 文件同步 profile。
- [INFERRED] 退出门：大文件与路径安全套件通过，主端 Web RDP 可稳定挂载整合版 App；用户可见文案无独立 Zephyr Agent 设置。

### M4：SSH/Telnet 与远程操作

- [INFERRED] 完成 terminal renderer、SSH/Telnet、代理/跳板、批量执行、session management、终端快捷键矩阵与 IME/terminal dock 状态切换。
- [INFERRED] 退出门：IME 开合 50 次几何无漂移，terminal/快捷键/IME/dock 零重叠且 cursor 始终可见；键盘/选择/重连/大输出、代理与八级限制测试通过。

### M5：RDP/VNC

- [INFERRED] 完成 native rendering、输入、音频、剪贴板、证书、Agent drive、VNC。
- [INFERRED] 退出门：真机功能矩阵与 30 分钟稳定会话通过，无 handle/texture/audio 泄漏。

### M6：其余 Zephyr 完整能力、迁移与发布

- [INFERRED] 完成SFTP/编辑器/预览/Docker/监控、笔记全功能、AI使用能力、活动、服务器设置、主端备份恢复、分享资源使用、Tauri One/旧Agent迁移和商店材料；不增加账号安全、SMTP/CAPTCHA/IP策略、备案或自定义CSS-JS管理页。
- [INFERRED] 退出门：第 7 章标为“必须提供”的项目全部为“已实现 + 自动/真机验收通过”，明确排除的Web后台没有误加；升级安装、完整数据迁移、撤销与回滚演练通过。

## 23. 发布验收清单

- [INFERRED] App 全部日常页面为 native；无隐藏 Web app 作为主 UI。
- [INFERRED] 普通页面四入口底部浮岛、终端 context dock 与 IME 快捷键矩阵状态明确；横竖屏、大字体和安全区不遮挡主要 action，终端 rows/cols 与可见 viewport 一致。
- [INFERRED] 本地离线 CRUD、直连会话和重新联网同步可用。
- [KNOWN] 第7章标为“必须提供”的移动操作能力、服务器设置和备份恢复全部实现；账号安全、SMTP、CAPTCHA/IP策略、备案、自定义CSS/JS和独立Agent等排除页不得误加。
- [INFERRED] 完整双向文件同步覆盖 registry 全实体和 blob，有 push、cursor、idempotency、tombstone、conflict，不用整包覆盖冒充同步。
- [KNOWN] 设置页有总开关、自动同步开关、用户自定义间隔、立即同步、进度、上次成功、冲突和错误；主端 Zephyr Client 可管理 One 设备。
- [KNOWN] 账号 + Token + TOTP（如启用）绑定，设备删除、Token 查看/旋转/删除/重置全部的密码/TOTP敏感验证均有测试。
- [KNOWN] Client Token和所有自有业务 secret 能在 Zephyr ↔ One 间加密互备；secret 只在 HTTPS/设备 envelope/安全存储中出现，不进日志和普通 preferences。
- [INFERRED] 文件同步可从 RDP 编辑器配置目录与只读；One 无独立 Agent 页；Android/iOS 生命周期差异在 UI明确。
- [INFERRED] ZFT2 与现有 Node/Dart 实现逐字节兼容。
- [INFERRED] 自签证书处理不含 release trust-all。
- [INFERRED] 旧 Web、旧 Tauri One 和独立 Agent 无回归。
- [INFERRED] Android/iOS 真机测试、升级迁移、性能、安全与无障碍门槛全部通过。

## 24. 风险登记

| 风险 | 严重度 | 对策 |
| --- | --- | --- |
| RDP native core 跨平台成熟度 | [INFERRED] 高 | M0 先 spike；不在 UI 完成后才验证 |
| iOS 文件桥接后台限制 | [KNOWN] 高 | 产品明确前台限制；不承诺常驻 |
| VNC/终端库许可证 | [INFERRED] 高 | 引入前法律/许可证审计 |
| 旧 One 数据迁移 | [INFERRED] 高 | 过渡版导出 + 同包升级测试 |
| 双向同步覆盖数据 | [INFERRED] 高 | revision、fieldMask、conflict、tombstone、chaos tests |
| secret 在设备泄漏 | [INFERRED] 高 | KeyStore/Keychain、envelope、日志扫描、App Lock |
| Android 文件权限被商店拒绝 | [COMMON] 中高 | SAF 默认，不依赖 all-files permission |
| 两端模型分叉 | [INFERRED] 中高 | contract 单一真源 + generated/validated model |
| shared connection 无 reveal 权限 | [KNOWN] 中 | 明确使用主端代理或显示不可本地直连，不绕过 ACL |
| 后台同步不准时 | [COMMON] 中 | foreground event sync + opportunistic BGTask，不宣传固定周期 |

## 25. 已确定默认决策

- [KNOWN] 产品名沿用 Zephyr One；Android 使用 Kotlin + Compose，iOS 使用 Swift + SwiftUI 原生重写，旧 Tauri One 是迁移/兼容来源。
- [KNOWN] One完整实现第7章标为必须提供的能力，包括服务器设置和备份恢复；当前账号安全、SMTP、CAPTCHA/IP策略、备案、自定义CSS/JS管理、多用户和独立Agent页不提供。
- [KNOWN] One 内原 Zephyr Agent 设置改名“文件同步”，底层 Agent/ZFT2能力整合进去；主端设置入口统一叫“Zephyr Client”并保留旧 Agent兼容。
- [KNOWN] 文件同步像 iCloud 一样完整双向镜像 One有用途的账号数据和 Client Token；活socket、设备身份密钥、不可移植系统授权及Web后台配置不作为One可编辑数据。
- [KNOWN] 开启前必须主端已有 Token，并在 One 输入 Zephyr 用户名+密码，启用 TOTP 时继续通过动态码；随后按账号绑定设备。
- [KNOWN] 用户可设置自动同步间隔，也始终有“立即同步”；主端能查看、启停和删除 One 设备。
- [KNOWN] 删除 One 设备、查看/旋转/删除 Token、重置全部 Token 必须走当前密码或 TOTP 敏感验证。
- [INFERRED] 普通页面根导航使用四入口底部浮岛；Activity 合并首页，AI 归入工具/页面级 action。
- [INFERRED] 终端采用“terminal viewport + 快捷键矩阵 + context dock”；IME 弹出时 dock 隐藏，矩阵贴住系统键盘且 viewport/PTY 几何同步 resize。
- [INFERRED] Android 文件桥接可前台服务常驻；iOS 按系统允许的前台/后台执行窗口工作。
- [INFERRED] release 不允许 trust-all TLS；不从零重写 RDP/SSH 密码学，协议核心可共享而 UI 不共享。
- [INFERRED] 所有实现按里程碑退出门推进，不用“页面看起来完成”替代协议、完整功能、迁移和真机验证。

## 26. 当前仓库对应代码索引

- [KNOWN] 用户确认的移动端产品范围合同：[`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md)
- [KNOWN] Zephyr 业务继承规范：[`ZEPHYR_PARITY.md`](ZEPHYR_PARITY.md)
- [KNOWN] 原生逐屏规格：[`SCREEN_CATALOG.md`](SCREEN_CATALOG.md)
- [KNOWN] 同步状态机：[`SYNC_STATE_MACHINE.md`](SYNC_STATE_MACHINE.md)
- [KNOWN] DDL、Secret 与迁移：[`DATA_AND_MIGRATION.md`](DATA_AND_MIGRATION.md)
- [KNOWN] 原生协议引擎决策：[`NATIVE_ENGINE_DECISIONS.md`](NATIVE_ENGINE_DECISIONS.md)
- [KNOWN] 原生移动视觉、返回和动画：[`MOBILE_EXPERIENCE.md`](MOBILE_EXPERIENCE.md)
- [KNOWN] SSH/Telnet 终端交互：[`TERMINAL_EXPERIENCE.md`](TERMINAL_EXPERIENCE.md)
- [KNOWN] RDP/VNC 远程桌面交互：[`REMOTE_DESKTOP_EXPERIENCE.md`](REMOTE_DESKTOP_EXPERIENCE.md)
- [KNOWN] Zephyr AI 浮窗与能力对齐：[`AI_FLOATING_WORKSPACE.md`](AI_FLOATING_WORKSPACE.md)
- [KNOWN] 共享资源零驻留与按次使用：[`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)
- [KNOWN] 需求追踪与实际状态：[`TRACEABILITY.md`](TRACEABILITY.md)、[`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)
- [KNOWN] OpenAPI、entity/error registry、JSON Schema 与 vectors：[`contracts/`](contracts/)
- [KNOWN] 主功能与协议说明：[`../../README.md`](../../README.md)
- [KNOWN] 现有 One 设备绑定与 pull：[`../../one-client-manager.js`](../../one-client-manager.js)
- [KNOWN] 现有 One pull-only engine：[`../../zephyr_one/src/js/sync/sync-engine.js`](../../zephyr_one/src/js/sync/sync-engine.js)
- [KNOWN] 现有 One API/SID 处理：[`../../zephyr_one/src/js/sync/zephyr-api.js`](../../zephyr_one/src/js/sync/zephyr-api.js)
- [KNOWN] 现有 One localStorage binding：[`../../zephyr_one/src/js/sync/bind-store.js`](../../zephyr_one/src/js/sync/bind-store.js)
- [KNOWN] Agent server manager：[`../../file-agent-manager.js`](../../file-agent-manager.js)
- [KNOWN] ZFT2 JS：[`../../file-transfer-protocol.js`](../../file-transfer-protocol.js)
- [KNOWN] ZFT2 Dart：[`../../zephyr_agent/lib/agent/file_transfer_protocol.dart`](../../zephyr_agent/lib/agent/file_transfer_protocol.dart)
- [KNOWN] Agent controller：[`../../zephyr_agent/lib/agent/agent_controller.dart`](../../zephyr_agent/lib/agent/agent_controller.dart)
- [KNOWN] Agent file providers：[`../../zephyr_agent/lib/fs/file_provider.dart`](../../zephyr_agent/lib/fs/file_provider.dart)
- [KNOWN] 连接/ACL服务：[`../../resource-service.js`](../../resource-service.js)
- [KNOWN] 连接与 revision 存储：[`../../storage.js`](../../storage.js)
- [KNOWN] 连接编辑器：[`../../public/app.html`](../../public/app.html)、[`../../public/app.js`](../../public/app.js)
- [KNOWN] Zephyr One 四色图标设计源：[`branding/source/`](branding/source/)
- [KNOWN] 图标 palette、geometry 与 hash 清单：[`branding/manifest.json`](branding/manifest.json)
- [KNOWN] 浮岛和终端键盘参考图：[`references/`](references/)
- [KNOWN] 参考图尺寸、hash 与设计角色清单：[`references/manifest.json`](references/manifest.json)
- [KNOWN] 用户提交的原始图标包：[`original-uploads/zephyr-one-icons.zip`](original-uploads/zephyr-one-icons.zip)

---

[KNOWN] 本文的最终产品边界是：**原生移动操作UI、保留服务器设置与备份恢复、排除账号安全/SMTP/CAPTCHA-IP策略/备案等无用途后台、账号+Token+TOTP绑定、Client Token与One有用途数据完整双向文件同步、手动与自定义间隔同步、主端Zephyr Client兼容管理、RDP内文件同步配置**。用WebView冒充原生、只做pull、只保留Token metadata、重新增加独立Agent页，删除服务器设置/备份恢复，或把明确排除项塞回One，都违反要求。
