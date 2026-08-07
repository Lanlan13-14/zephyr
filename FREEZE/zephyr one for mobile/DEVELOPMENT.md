# Zephyr Android / iOS 原生 App 完整开发文档

> 文档状态：架构与实施提案 v1.0
>
> 审计基线：仓库 `Lanlan13-14/zephyr-ssh`，提交 `e41d610`（2026-08-07）
>
> 目标产品：以 Android Kotlin + Jetpack Compose、iOS Swift + SwiftUI 重写 Zephyr 移动端，并把 Zephyr Agent 文件映射能力整合进 App

## 0. 标记与置信度

- [KNOWN] 表示由当前仓库代码直接确认；相关结论置信度 HIGH。
- [COMMON] 表示移动平台或工程领域的标准知识；相关结论通常置信度 HIGH。
- [INFERRED] 表示本文提出的架构决策；它是建议，不是假装已经实现，相关置信度 MED～HIGH。
- [COMPUTED] 表示由当前字段、接口或约束推导出的结果；相关结论通常置信度 HIGH。
- [GUESS] 表示缺乏依据的估计；本文不提供日历工期承诺。

## 1. 执行摘要

[KNOWN] SwiftUI 是 Apple UI 框架而不是编程语言；准确技术栈是 **Android：Kotlin + Jetpack Compose**，**iOS：Swift + SwiftUI**。

[INFERRED] 新 App 不应把现有 Web 页面塞进 WebView，也不应继续在手机里运行 Node + `server.js` 作为 UI 后端。原生改造的价值来自原生导航、原生输入法与手势、平台文件授权、平台安全存储、平台后台策略以及更低的启动和内存成本；继续使用 WebView 只会保留旧架构的限制。

[INFERRED] “原生”不等于用 Kotlin 和 Swift 各自重写 RDP、SSH 加密和终端解析。UI、业务状态和平台集成必须原生；复杂协议核心应复用经过测试的协议库，必要时通过 C ABI、JNI、Objective-C++ 或 Swift C Module 接入。自行从零实现 RDP/TLS/SSH 是错误的成本分配，也是安全风险。

[INFERRED] 产品采用 **local-first**：连接资料、笔记、代理、密钥、设备 Agent 配置保存在本机；SSH/Telnet/RDP/VNC 会话优先由手机直接连接目标；Zephyr 主端负责账号、授权、跨设备同步和可选的服务端能力，不作为原生 UI 的宿主。

[KNOWN] 当前 `/api/one/sync/pull` 只返回整包快照，当前 `SyncEngine` 也只执行 pull。它没有 push、变更游标、删除墓碑、操作幂等或冲突解决，所以不能满足“双向数据同步”。

[INFERRED] 服务端必须新增版本化的 `/api/mobile/v1/*` 协议。旧 `/api/one/*` 保留一段兼容期，但原生 App 不以旧整包 pull 作为正式同步机制。

[INFERRED] Zephyr Agent 以 App 内的独立运行域存在：RDP 编辑器选择设备目录、只读策略、何时启动以及是否允许主端使用；Android 可用前台服务保持 Agent 在线，iOS 只能在 App 前台或有效系统执行窗口内工作，不能伪装成无限后台服务。

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

## 3. 产品范围

### 3.1 目标

- [INFERRED] 所有日常操作页使用 Compose/SwiftUI 原生组件，不加载 `public/app.html`。
- [INFERRED] 手机上的 SSH/Telnet/RDP/VNC 日常会话不依赖远端 Zephyr Web UI。
- [INFERRED] 主端离线时，已有本地资料和本地连接仍可工作；重新联网后再同步。
- [INFERRED] 账号 + Client Token 完成设备绑定；绑定后不再反复要求用户输入账号密码。
- [INFERRED] 自有连接资料和凭据可双向同步；共享资源严格服从主端 ACL。
- [INFERRED] Agent 文件映射从独立 App 能力升级为 RDP 配置的一部分，同时保留“供主端 Web RDP 使用”的 Agent 模式。
- [INFERRED] UI 继承 Web 的信息层级、四色主题、卡片感和术语，但使用平台导航、手势、字体、动态字号和无障碍语义。

### 3.2 非目标

- [INFERRED] App 不承载主端部署管理：CAPTCHA 密钥、SMTP、IP 白名单、防爆破、备案、多用户管理和服务端备份不在本地设置中出现。
- [INFERRED] App 不执行自定义 CSS/JS；原生组件没有安全且可维护的 CSS/JS 注入语义。
- [INFERRED] App 不承诺在 iOS 后台无限运行 Agent 或持久会话。
- [INFERRED] 第一版不尝试复制桌面 Web 的多窗口自由布局；手机采用单活动会话，其他会话保持在会话列表。
- [INFERRED] 第一版不从零重写完整 RDP、VNC、SSH 加密协议。

## 4. 总体架构

```text
┌──────────────── Android App ────────────────┐
│ Kotlin + Compose                            │
│ ViewModel / UseCase / Repository            │
│ Room/SQLite + encrypted secret store        │
│ SSH/Telnet/RDP/VNC native session engines   │
│ SAF file provider + Agent foreground svc    │
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
│ security-scoped URLs + foreground Agent      │
└──────────────────────────────────────────────┘
```

[INFERRED] 两端共享的是 **协议规范、JSON Schema/OpenAPI、测试向量和可选协议核心**，不是共享 UI。任何共享核心都必须暴露小而稳定的接口，不允许把平台 UI 退化为跨平台壳。

### 4.1 分层

| 层 | Android | iOS | 责任 |
| --- | --- | --- | --- |
| Presentation | [INFERRED] Compose | [INFERRED] SwiftUI | 页面、导航、交互、无障碍 |
| State | [INFERRED] ViewModel + StateFlow | [INFERRED] `@Observable`/ObservableObject | 单向状态流、加载/错误/空态 |
| Domain | [INFERRED] Kotlin use cases | [INFERRED] Swift use cases | 连接、同步、Agent、会话规则 |
| Data | [INFERRED] Repository | [INFERRED] Repository | 本地 DB、远端 API、缓存 |
| Protocol | [INFERRED] Kotlin/JNI | [INFERRED] Swift/C/ObjC++ | SSH/RDP/VNC/Telnet/ZFT2 |
| Platform | [INFERRED] SAF/Keystore/WorkManager | [INFERRED] DocumentPicker/Keychain/BGTask | 文件、安全、后台、通知 |

### 4.2 推荐目录

```text
mobile/
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
    feature-agent/
    feature-settings/
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
    Features/Agent/
    Features/Settings/
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

[INFERRED] `mobile/contracts` 是唯一协议真源。Kotlin `kotlinx.serialization` model 和 Swift `Codable` model由 schema 生成或由契约测试校验，禁止两端手写出两个悄悄分叉的字段集合。

## 5. 平台技术选型

### 5.1 Android

- [INFERRED] Kotlin、Jetpack Compose、Navigation Compose、Coroutines、StateFlow。
- [INFERRED] Room 管理非敏感结构化数据；连接密码、私钥、Token 和 refresh credential 使用 Android Keystore 保护的 AES-GCM 密文，数据库只保存 ciphertext 与 key version。
- [INFERRED] OkHttp 或 Ktor Client 统一承载 HTTPS、WebSocket、超时、证书与网络日志；项目只能选一个主网络栈。
- [INFERRED] WorkManager 执行机会性后台同步；Agent 常驻必须使用用户明确开启的 foreground service 和持续通知。
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
4. [INFERRED] **工具**（crossed tools）：远程批量执行、AI、Agent、代理、SSH Key、账号同步、外观和设置。

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
4. [INFERRED] RDP 设备：音频、剪贴板、麦克风、摄像头、位置、Agent 存储。
5. [INFERRED] RDP 显示：分辨率、质量、FPS、直接触控/触控板、灵敏度。
6. [INFERRED] Agent：共享来源、共享名、只读、启用范围、空闲关闭、主端可见性。
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

- [INFERRED] RDP 使用边缘可收起工具条：键盘、触控模式、缩放、剪贴板、Agent 磁盘、Ctrl+Alt+Del、重连、断开；RDP 软键盘也遵循同一 IME inset 原则，但不显示 SSH 专属的 Home/End modifier 矩阵，除非用户打开“完整键盘”。
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
- [INFERRED] 合入仓库时保留收到的 SVG/HTML为不可改的 `mobile/branding/source/` 设计源；另生成 `mobile/branding/outlined/`，把 O、n、e 转成固定 path。轮廓版才是 Android/iOS 出包输入，生成器不得依赖运行机器字体。
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
mobile/branding/
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

## 7. 移动端功能取舍

| Web 功能/设置 | 原生 App | 处理 |
| --- | --- | --- |
| 仪表盘/连接 | [INFERRED] 保留 | 原生首页与连接编辑器 |
| 活动 | [INFERRED] 保留 | 首页二级页，区分本地/主端 |
| SSH/Telnet/RDP/VNC | [INFERRED] 保留 | 原生 session engine |
| 远程批量执行 | [INFERRED] 保留 | 本地 SSH 执行，结果可选择同步 |
| 笔记 | [INFERRED] 保留 | 原生 Markdown 编辑/预览 |
| 代理池/SSH Key/跳板 | [INFERRED] 保留 | 归入连接资源设置 |
| Agent/Client Token | [INFERRED] 保留并重构 | 账号同步 + 设备文件映射 |
| AI 聊天 | [INFERRED] 分阶段保留 | 调主端 AI API，不在手机运行 Chromium |
| AI Provider/MCP stdio 管理 | [INFERRED] 默认不显示 | 服务端管理员功能 |
| 账号密码/TOTP/Passkey | [INFERRED] 保留 | 主端账号安全页或系统认证流 |
| 多用户管理 | [INFERRED] 移除 | 服务端管理功能 |
| IP 白名单/防爆破/CAPTCHA 配置 | [INFERRED] 移除 | 服务端管理功能 |
| SMTP/备案 | [INFERRED] 移除 | Web 部署功能 |
| 数据库备份导入导出 | [INFERRED] 移除 | 主端运维功能；本机仅提供安全导出连接/笔记的独立格式 |
| 自定义 CSS/JS | [INFERRED] 移除 | 原生无对应安全语义 |
| 浏览器终端布局/快捷键平台 | [INFERRED] 重做 | 使用平台原生会话偏好 |
| 主题/语言/终端颜色 | [INFERRED] 保留子集 | 不支持 CSS/JS 注入 |
| 本地 App Lock | [INFERRED] 新增 | 生物识别/系统口令 |

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

AgentShareProfile
  id, serverProfileId, displayName, localGrantRef,
  readOnly, autoStart, idleTimeoutMinutes, enabled

DeviceConnectionOverride
  connectionId, agentShareProfileIds, localResolutionPolicy,
  localKeyboardPolicy, updatedAt

PendingOperation
  opId, batchId, entityType, entityId, action, baseRevision,
  fieldMask, payload, createdAt, attemptCount, lastError
```

### 8.2 本地与同步边界

- [INFERRED] `Connection/Proxy/SshKey/JumpHost/Note` 为同步实体。
- [INFERRED] `ServerProfile`、本机文件授权 URI/bookmark、Agent 本地目录、窗口状态、生物识别偏好和 `DeviceConnectionOverride` 不同步。
- [INFERRED] RDP 的“希望启用存储重定向”可同步；具体 Android tree URI 或 iOS bookmark 只能本地保存。
- [INFERRED] Client Token secret、device refresh credential、数据库主密钥不进入同步 payload。
- [INFERRED] Activity 默认不双向同步；主端活动通过只读 API读取，本机活动单独记录。否则高频事件会污染业务同步流。
- [INFERRED] 已打开 PTY/RDP 会话不同步；同步的是连接定义，不是活 socket。

### 8.3 SecretStore

- [INFERRED] 业务表只保存 `secretRef`，SecretStore 保存 AES-GCM ciphertext、nonce、AAD、keyVersion 和更新时间。
- [INFERRED] AAD 至少包含 `serverId/userId/entityType/entityId/fieldName`，防止密文被换位复用。
- [INFERRED] Android master key 位于 Keystore；iOS master material 位于 Keychain，必要时用 Secure Enclave key agreement/wrapping 增强设备绑定。
- [INFERRED] 敏感字段在 UI 生命周期结束后从可观察状态移除；日志、analytics、crash report 永不包含密码、私钥、Token、SID、TOTP。

## 9. 账号、Token 与设备绑定

### 9.1 正式绑定流程

```text
1. 用户添加 Zephyr 主端 HTTPS 地址
2. App 获取 /api/mobile/v1/capabilities
3. App 使用账号 + 密码登录
4. 如需 TOTP，完成第二步验证
5. 如启用 CAPTCHA/Passkey，转系统认证会话完成，不用内嵌 WebView
6. App 生成稳定随机 deviceId 和设备密钥对
7. 用户选择 Client Token metadata 或扫码/粘贴一次 Token
8. POST /api/mobile/v1/devices/bind
9. 服务端确认：登录账号、Token owner、设备 challenge、版本能力
10. 服务端返回短期 access credential、长期 refresh credential、初始 sync cursor
11. App 把 refresh credential 与私钥写入安全存储
12. 原始账号密码和一次性输入 Token 立即从内存清除
```

[INFERRED] 绑定必须同时满足账号认证和 Client Token 所属关系；只有 Token 而没有账号认证不能读取账号同步数据，只有账号密码而没有 Token也不能注册 Agent/同步设备。

[INFERRED] `clientId` 使用随机 UUIDv4/UUIDv7 并持久化，不再从 server URL + device name 推导；设备改名不应改变身份。

[INFERRED] access credential 有短有效期，refresh credential 可撤销且服务端只保存 hash。每次刷新可轮换 refresh credential，旧值进入短暂重放检测窗口。

[INFERRED] 设备绑定时注册 P-256/Ed25519 公钥；同步写请求携带 challenge proof/DPoP 风格签名。仅窃取 Bearer token 不足以长期冒充设备。

### 9.2 CAPTCHA 与 Passkey

- [INFERRED] 若主端要求浏览器 CAPTCHA，服务端返回一次性 `authUrl`；Android 使用 Custom Tabs，iOS 使用 ASWebAuthenticationSession，完成后通过 universal link/app link 返回一次性 code。
- [INFERRED] 不降低主端 CAPTCHA 策略，也不在 native API 中偷偷绕过登录防护。
- [INFERRED] Passkey 使用 Android Credential Manager 与 iOS AuthenticationServices 对接服务端 WebAuthn challenge；RP ID 与主端公开域名保持一致。

### 9.3 撤销

- [INFERRED] 主端可禁用同步、撤销设备、撤销 Client Token或停用账号；任一条件触发后 access refresh 和 Agent lease 都失效。
- [INFERRED] App 的“退出并解绑”先调用服务端 revoke，再删除本地 credential；离线时先本地清除并记录待撤销标记，下一次联网补偿。
- [INFERRED] 远程 wipe 只删除 App 自己的本地数据库与安全项，不能声称擦除系统备份或用户导出的文件。

## 10. 双向同步协议 `/api/mobile/v1`

### 10.1 为什么不扩展旧 pull

[KNOWN] 旧接口的 `revision` 是每次构建 snapshot 时递增的 client sync count，不是全局数据变更序号；它无法判断哪一条资源发生了什么变化。

[INFERRED] 新协议使用服务端单调 `changeSeq` 作为 cursor，并为每个实体保留 revision。cursor 解决“从哪里继续拉”，entity revision 解决“我编辑的基础版本是否仍然有效”。

### 10.2 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | [INFERRED] `/api/mobile/v1/capabilities` | 版本、功能、限制、认证方式 |
| POST | [INFERRED] `/api/mobile/v1/devices/bind` | 绑定设备 |
| POST | [INFERRED] `/api/mobile/v1/devices/refresh` | 轮换 access/refresh credential |
| DELETE | [INFERRED] `/api/mobile/v1/devices/:id` | 撤销设备 |
| GET | [INFERRED] `/api/mobile/v1/sync/bootstrap` | 首次分页全量 |
| GET | [INFERRED] `/api/mobile/v1/sync/changes?cursor=&limit=` | 增量 pull |
| POST | [INFERRED] `/api/mobile/v1/sync/push` | 幂等批量 push |
| POST | [INFERRED] `/api/mobile/v1/sync/ack` | 确认已应用 cursor |
| POST | [INFERRED] `/api/mobile/v1/agent/lease` | 获取短期 Agent credential |
| GET | [INFERRED] `/api/mobile/v1/devices` | 查看账号设备 |

### 10.3 Push 请求

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

### 10.4 Push 响应

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

### 10.5 Change feed

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

### 10.6 服务端表

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

### 10.7 服务端写入路径

- [INFERRED] 所有 mobile push 必须调用 `ResourceService`/`NotesService`，不能直接写 SQLite 绕过 ACL、依赖校验、审计和 revision。
- [INFERRED] Web CRUD 也必须写 `mobile_sync_changes`，否则 Web 改动不会到手机。
- [INFERRED] 资源写入和 change log 插入处于同一数据库事务；不允许资源成功但 feed 丢失。
- [INFERRED] Token owner 从 username 逐步迁移到不可变 userId，同时保留旧数据兼容读取；用户名修改不应断开设备归属。

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
| Settings subset | [INFERRED] 分 section/field revision，不同步整份 Web settings blob |
| Delete vs edit | [INFERRED] tombstone 胜出；用户可显式 restore 成新 revision |
| Shared resource | [INFERRED] 无 EDIT capability 时本地不得排队写操作 |

### 11.3 依赖顺序

- [INFERRED] push 拓扑顺序为 SSH Key/Proxy → Jump connection/JumpHost → target Connection → Note link。
- [INFERRED] 若依赖尚未同步，服务端返回 `dependency_missing`，客户端保留 op 并在依赖成功后重试，不把它当永久失败。
- [INFERRED] 删除依赖前，UI列出受影响连接；服务端仍做最终引用校验。

## 12. Secret 同步

[INFERRED] TLS 是最低要求，但绑定后的 deviceToken 泄漏不应直接暴露所有连接密码。服务端向设备返回 secret 时，使用绑定公钥派生会话密钥并生成 AES-256-GCM envelope。

```json
{
  "alg": "ECDH-P256-HKDF-SHA256+A256GCM",
  "ephemeralPublicKey": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
  "salt": "...",
  "nonce": "...",
  "ciphertext": "...",
  "aad": "server/user/connection/id/password",
  "keyVersion": 1
}
```

- [INFERRED] 服务端生成 envelope 时可短暂接触明文，因为现有 Web 主端本来就需要解密凭据建立会话；明文不得进入 change log、日志或缓存。
- [INFERRED] 设备私钥不可导出时优先不可导出；不支持硬件密钥的设备退化为 Keychain/Keystore 保护的软件密钥并在安全页明确显示。
- [INFERRED] 用户可关闭“同步连接凭据”；关闭后只同步 `hasPassword/hasPrivateKey` metadata，本机连接要求重新输入。
- [INFERRED] 共享连接默认不下发 owner secret；如果主端允许 shared user 使用但不 reveal，原生端应通过主端会话代理连接，或明确提示“该共享连接仅可由主端执行”，不能绕过 ACL索取凭据。

## 13. Zephyr Agent 原生整合

### 13.1 概念拆分

[INFERRED] App 中必须明确区分两条路径：

1. [INFERRED] **本机 RDP 存储重定向**：原生 RDP 会话直接把已授权目录作为 RDPDR drive 暴露给远端 Windows，不经过 Zephyr 主端。
2. [INFERRED] **Zephyr Main Agent**：App 连接主端 `/agent/files`，供该账号在主端 Web RDP 会话中挂载手机目录。

[INFERRED] 两条路径复用同一个 `AgentShareProfile`、路径监禁和 ZFT2 file provider，但网络拓扑不同。UI 不应只放一个模糊的“RDP Storage”布尔开关。

### 13.2 RDP 编辑器中的 Agent 配置

```text
存储重定向
  模式：关闭 / 每次询问 / 使用本机共享 / 供 Zephyr 主端使用
  共享配置：<选择 AgentShareProfile>
  共享名：PHONE / DOCUMENTS / 自定义
  权限：只读 / 读写
  多目录：允许选择多个 profile
  会话结束：立即关闭 / 空闲 N 分钟关闭 / 保持 Agent 在线
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

- [INFERRED] Android：用户开启“保持主端 Agent 在线”后启动 foreground service；网络切换后指数退避重连并加随机抖动；通知提供停止 action。
- [COMMON] iOS 普通 App 进入后台后不能保证 WebSocket 持续存活。
- [INFERRED] iOS：前台运行 Agent；进入后台时完成短暂清理并告知主端 offline。原生 RDP 正在前台显示时，本机 drive redirection 可继续。
- [INFERRED] iOS UI 必须明确写“离开 App 后主端文件映射会暂停”，不得显示虚假的常驻开关。
- [INFERRED] 两端恢复前台后先验证绑定状态和 Agent lease，再自动重连。

### 13.6 Agent credential

- [INFERRED] 正式方案使用 `/api/mobile/v1/agent/lease` 生成绑定设备的短期 Agent credential，`/agent/files` 同时接受旧 Client Token和新 lease。
- [INFERRED] lease 与 userId、deviceId、tokenId、share policy 和过期时间绑定；撤销设备或 Client Token立即使 lease 失效。
- [INFERRED] 过渡期若仍需保存原始 Client Token，只能放安全存储，绝不放普通 DB、SharedPreferences/UserDefaults 或日志。

## 14. 本地连接数据面

### 14.1 SSH

- [INFERRED] 支持密码、内联私钥、密钥库、私钥口令、host key verification、SOCKS5、HTTP CONNECT 和最多 8 级 SSH jump chain。
- [INFERRED] 首次遇到未知 host key 时显示算法与 SHA-256 fingerprint；用户确认后按 `serverProfile/host/port` 保存。host key 改变默认阻断，不用普通 toast 一键忽略。
- [INFERRED] PTY resize 跟随可见终端像素与字号；输入、输出、resize、disconnect 进入有序 actor/serial queue。
- [INFERRED] SFTP 文件管理、代码编辑和 Docker 面板可在基础终端稳定后分阶段加入；不能让附属功能阻塞第一条可靠 SSH 会话。

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

- [INFERRED] `mobile-device-manager.js`：绑定、refresh、撤销、设备 key、Agent lease。
- [INFERRED] `mobile-sync-service.js`：bootstrap、pull、push、冲突、ACL。
- [INFERRED] `mobile-change-log.js`：事务内 changeSeq、tombstone、cursor retention。
- [INFERRED] `mobile-secret-envelope.js`：按设备公钥生成 secret envelope。
- [INFERRED] `mobile-contracts.js`：协议版本和 JSON Schema 校验。

### 15.2 现有接口保留

- [INFERRED] `/api/auth/login` 和 `/api/auth/totp/verify` 可继续提供登录基础，但 native 返回 SID 的兼容分支最终迁移到 mobile credential。
- [INFERRED] `/api/one/*` 标记 legacy pull-only；旧 One 继续可用。
- [INFERRED] `/api/rdp/file-agent-tokens` 继续服务 Web/Flutter Agent；新设备管理页可在内部调用相同 manager。
- [INFERRED] `/agent/files` 同时支持旧 `hello.token` 与新 `hello.lease`，通过 capability negotiation 区分。

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

- [INFERRED] App Lock 默认可选，开启后支持立即/1分钟/5分钟锁定；锁定只遮 UI，并同时从内存清除已解密 secret。
- [INFERRED] Android 禁止明文备份敏感 DB；iOS 敏感 Keychain item 设为 ThisDeviceOnly，数据库备份策略明确区分可恢复 metadata 与不可迁移 secret。
- [INFERRED] 截图保护可对密码/私钥页与 RDP session 独立配置；Android 使用 secure window，iOS 在 capture 状态变化时遮罩敏感页。
- [INFERRED] 剪贴板写入密码/Token 前提示并设置自动清理；读取系统剪贴板只在用户动作后发生。

### 16.3 服务端

- [INFERRED] Token 比较使用 constant-time；refresh 与 Agent lease 只存 hash。
- [INFERRED] bind、refresh、push、secret reveal、Agent lease 都限速并写审计，但审计 metadata 不含 secret。
- [INFERRED] 设备 public key、app version、platform、last seen、last sync、revoked reason 可由账号安全页查看。
- [INFERRED] 所有 resource ownership 使用不可变 userId，不依赖可改 username。

### 16.4 威胁模型最低覆盖

- [INFERRED] 被盗 deviceToken、refresh replay、恶意代理、旧设备撤销、数据库拷贝、日志泄密、path traversal、symlink escape、ZFT2 length bomb、op replay、cursor 回退、共享资源越权、冲突覆盖和 rooted/jailbroken device。
- [INFERRED] root/jailbreak 检测只能作为风险信号，不能声称能可靠阻止拥有系统控制权的攻击者。

## 17. 同步调度与离线体验

- [INFERRED] 任一实体本地保存先写本地 DB 和 PendingOperation，UI立即成功；网络同步状态显示“待同步”。
- [INFERRED] App 前台启动、绑定完成、手动下拉、网络恢复、本地写入后 debounce、push notification 提示时触发同步。
- [INFERRED] 同一账号同一时刻只运行一个 sync actor；新触发合并，不并发修改 cursor。
- [INFERRED] Android 后台周期同步使用 WorkManager，系统最小周期和省电策略由平台决定；用户设置的 30 秒仅适用于前台，不包装成后台承诺。
- [INFERRED] iOS 使用 BGTask 作机会性刷新，并在前台/静默推送获准时同步；设置页显示“系统决定后台频率”。
- [INFERRED] push queue 对 retryable 错误保留；永久 4xx 标记“需要处理”，不无限耗电重试。
- [INFERRED] 离线时共享资源可读缓存但禁止首次下载 secret；ACL 过期策略可由主端下发，超过期限要求联网重新授权。

## 18. 从 Tauri One / Flutter Agent 迁移

### 18.1 原则

- [INFERRED] 原生版不是直接覆盖后让旧数据消失。Android 同包名升级可访问原 App 私有目录；iOS 同 bundle/container 条件下也可读取旧容器数据，但迁移代码必须在旧格式仍存在时执行。
- [KNOWN] 当前 One 可能保存 localStorage 绑定状态/快照，并在本机运行完整 Zephyr core；这些数据格式与新原生 DB 不等价。

### 18.2 迁移步骤

1. [INFERRED] 发布最后一个 Tauri 过渡版本，写出版本化 `native-migration-v1.json.enc`；不导出 SID、deviceToken 或明文 Token。
2. [INFERRED] 新原生版首次启动检测旧容器与迁移文件，导入非敏感 connection/note/proxy/key metadata。
3. [INFERRED] 连接 secret 若能安全导出，使用一次性迁移 key envelope；否则提示用户重新绑定主端后从主端同步。
4. [INFERRED] 导入完成写不可逆 marker，保留加密备份一个版本周期，之后由用户确认删除。
5. [INFERRED] 旧 One deviceToken 不能直接复制到新安全模型；原生版执行一次重新绑定/credential upgrade。
6. [INFERRED] Agent 的 SAF tree URI 和 iOS bookmark通常需要重新授权，不能假设跨框架可直接复用。

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

### 19.3 同步

- [INFERRED] 两设备同时改不同字段应自动合并；同字段应稳定产生 conflict。
- [INFERRED] 离线创建→改名→删除在上线后折叠为最小操作，不产生幽灵资源。
- [INFERRED] 同 batch/op 重放 100 次只执行一次。
- [INFERRED] cursor 页应用中途 crash 后重放不重复业务副作用。
- [INFERRED] Web、Android、iOS 三方修改都进入同一 feed。
- [INFERRED] 覆盖时钟快/慢 24 小时、服务端重启、Token 旋转、账号改名、设备撤销、共享权限撤销和 tombstone retention。

### 19.4 协议集成环境

- [INFERRED] CI/测试实验室提供 OpenSSH、Telnet、SOCKS5、HTTP CONNECT、两级 SSH bastion、xrdp/Windows RDP 测试机、VNC server、Zephyr main。
- [INFERRED] SSH 覆盖密码、RSA/Ed25519 key、host key change、SFTP、大输出、窗口 resize、代理与跳板。
- [INFERRED] RDP 覆盖 NLA、证书首次/变化、分辨率变化、音频、剪贴板、触控、Agent drive、断网重连。
- [INFERRED] VNC 覆盖不同像素格式、增量更新、认证失败、剪贴板和重连。

### 19.5 平台测试

- [INFERRED] Android unit + instrumented test + Compose UI test；至少一台低内存真机和一台主流真机验证 SAF、Keystore、生物识别、前台服务和网络切换。
- [INFERRED] iOS unit + UI test + simulator；至少一台真机验证 Keychain/Secure Enclave、DocumentPicker bookmark、LocalAuthentication、后台/前台和内存压力。
- [INFERRED] 仅模拟器通过不能作为 Agent 文件授权和后台行为验收。
- [INFERRED] UI snapshot/golden 覆盖四主题、深浅模式、动态字体、中文/英文、RTL准备、横竖屏和 Reduce Motion。

### 19.6 安全测试

- [INFERRED] path traversal、符号链接逃逸、恶意文件名、超大目录、handle 泄漏、Token 日志扫描、TLS MITM、redirect credential leak、SQL/JSON injection、ACL 越权、refresh replay。
- [INFERRED] release artifact 自动扫描 `http://`、trust-all verifier、debuggable、明文 secret fixture 和过宽 entitlement/permission。

## 20. 性能与质量门槛

[INFERRED] 以下是验收目标，不是对所有设备的事实承诺：

- [INFERRED] 参考中端真机冷启动到可交互首页 p95 ≤ 2.5s；已有本地缓存时不等待网络。
- [INFERRED] 连接列表 2,000 项搜索/滚动无主线程长任务，滚动目标 60fps。
- [INFERRED] SSH 本地输入到 glyph 提交 p95 ≤ 50ms（不含网络 RTT）。
- [INFERRED] sync 10,000 个实体使用分页/流式处理，峰值内存不随全量 JSON线性翻倍。
- [INFERRED] Agent 1 GiB 传输 checksum 正确，断线不泄漏 handle，取消后 2 秒内停止继续读取。
- [INFERRED] App 未打开会话时不维持无必要 socket；Android Agent foreground service 除外。
- [INFERRED] crash-free、ANR、OOM、sync error rate、Agent reconnect count 和 protocol error code 可观测，但 telemetry 默认不含主机名、用户名、路径和 secret。

## 21. CI/CD

### 21.1 Android pipeline

1. [INFERRED] ktlint/detekt、unit tests、schema contract tests。
2. [INFERRED] native core/JNI build 与 ABI 检查。
3. [INFERRED] Compose instrumented tests、Agent/ZFT2 integration。
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
- [INFERRED] mobile v1 API contract、ACL、事务、幂等、cursor 与 tombstone测试。
- [INFERRED] 旧 Web、旧 One、旧 Flutter Agent 全量回归。
- [INFERRED] Android/iOS client compatibility matrix 至少覆盖当前版和前一版 server。

## 22. 实施里程碑与退出门

### M0：协议冻结与风险验证

- [INFERRED] 完成 mobile OpenAPI、数据 schema、ZFT2 vectors、RDP/SSH/VNC library spike、许可证审计。
- [INFERRED] 退出门：Android/iOS 都能用候选 RDP core 连到测试服务；iOS Agent 生命周期限制已在产品文案确认。

### M1：原生壳与本地数据

- [INFERRED] 完成四入口底部浮岛、主题、连接列表/编辑、本地 DB、SecretStore、App Lock。
- [INFERRED] 退出门：无网络可完整 CRUD，浮岛几何/中断动画/大字体/安全区测试通过，重启后数据与 secret 正确恢复，敏感字段不出日志。

### M2：服务端 mobile v1 与双向同步

- [INFERRED] 完成设备绑定、bootstrap/change feed/push、冲突、tombstone、secret envelope。
- [INFERRED] 退出门：Web + 两台移动设备 chaos matrix 通过，重复 op 无副作用。

### M3：Agent 整合

- [INFERRED] 完成 Android SAF、iOS security-scoped provider、ZFT2、Android foreground service、iOS 前台状态提示、RDP editor profile。
- [INFERRED] 退出门：大文件与路径安全套件通过，主端 Web RDP 可稳定挂载整合版 App。

### M4：SSH/Telnet 与远程操作

- [INFERRED] 完成 terminal renderer、SSH/Telnet、代理/跳板、批量执行、session management、终端快捷键矩阵与 IME/terminal dock 状态切换。
- [INFERRED] 退出门：IME 开合 50 次几何无漂移，terminal/快捷键/IME/dock 零重叠且 cursor 始终可见；键盘/选择/重连/大输出、代理与八级限制测试通过。

### M5：RDP/VNC

- [INFERRED] 完成 native rendering、输入、音频、剪贴板、证书、Agent drive、VNC。
- [INFERRED] 退出门：真机功能矩阵与 30 分钟稳定会话通过，无 handle/texture/audio 泄漏。

### M6：笔记、AI 入口与迁移

- [INFERRED] 完成笔记冲突 UI、主端 AI chat 入口、Tauri One/Agent 迁移、商店隐私与发布材料。
- [INFERRED] 退出门：升级安装、数据迁移、撤销与回滚演练通过。

## 23. 发布验收清单

- [INFERRED] App 全部日常页面为 native；无隐藏 Web app 作为主 UI。
- [INFERRED] 普通页面四入口底部浮岛、终端 context dock 与 IME 快捷键矩阵状态明确；横竖屏、大字体和安全区不遮挡主要 action，终端 rows/cols 与可见 viewport 一致。
- [INFERRED] 本地离线 CRUD、直连会话和重新联网同步可用。
- [INFERRED] 双向同步有 push、cursor、idempotency、tombstone、conflict，不用整包覆盖冒充同步。
- [INFERRED] 账号 + Token 绑定、TOTP、撤销、Token rotation 均有测试。
- [INFERRED] secret 仅在 HTTPS/加密 envelope/安全存储中出现，不进日志和普通 preferences。
- [INFERRED] Agent 可从 RDP 编辑器配置目录与只读；Android/iOS 生命周期差异在 UI明确。
- [INFERRED] ZFT2 与现有 Node/Dart 实现逐字节兼容。
- [INFERRED] 自签证书处理不含 release trust-all。
- [INFERRED] Web-only 服务端设置不出现在原生 App。
- [INFERRED] 旧 Web、旧 One 和独立 Agent 无回归。
- [INFERRED] Android/iOS 真机测试、升级迁移、性能、安全与无障碍门槛全部通过。

## 24. 风险登记

| 风险 | 严重度 | 对策 |
| --- | --- | --- |
| RDP native core 跨平台成熟度 | [INFERRED] 高 | M0 先 spike；不在 UI 完成后才验证 |
| iOS Agent 后台限制 | [KNOWN] 高 | 产品明确前台限制；不承诺常驻 |
| VNC/终端库许可证 | [INFERRED] 高 | 引入前法律/许可证审计 |
| 旧 One 数据迁移 | [INFERRED] 高 | 过渡版导出 + 同包升级测试 |
| 双向同步覆盖数据 | [INFERRED] 高 | revision、fieldMask、conflict、tombstone、chaos tests |
| secret 在设备泄漏 | [INFERRED] 高 | KeyStore/Keychain、envelope、日志扫描、App Lock |
| Android 文件权限被商店拒绝 | [COMMON] 中高 | SAF 默认，不依赖 all-files permission |
| 两端模型分叉 | [INFERRED] 中高 | contract 单一真源 + generated/validated model |
| shared connection 无 reveal 权限 | [KNOWN] 中 | 明确使用主端代理或显示不可本地直连，不绕过 ACL |
| 后台同步不准时 | [COMMON] 中 | foreground event sync + opportunistic BGTask，不宣传固定周期 |

## 25. 已确定默认决策

- [INFERRED] 产品名沿用 Zephyr One，移动版原生重写。
- [INFERRED] Android UI 使用 Kotlin + Compose，iOS 使用 Swift + SwiftUI。
- [INFERRED] 普通页面根导航使用四入口底部浮岛；Activity 合并首页，AI 归入工具/页面级 action。
- [INFERRED] 终端采用“terminal viewport + 快捷键矩阵 + context dock”结构；IME 弹出时 dock 隐藏，快捷键矩阵贴住系统键盘且 viewport/PTY 几何同步 resize。
- [INFERRED] local-first，主端主要负责账号、同步、ACL 与可选服务端能力。
- [INFERRED] `/api/mobile/v1` 新增增量双向同步，旧 `/api/one` 只做兼容。
- [INFERRED] Agent profile 在 RDP 编辑器内配置，目录授权不跨设备同步。
- [INFERRED] Android Agent 可前台常驻；iOS Agent 前台工作。
- [INFERRED] release 不允许 trust-all TLS。
- [INFERRED] 不自行从零实现 RDP/SSH 密码学；协议核心可共享，UI 不共享。
- [INFERRED] 所有实现按里程碑退出门推进，不用“页面看起来完成”替代协议、迁移和真机验证。

## 26. 当前仓库对应代码索引

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

[INFERRED] 本文的核心边界是：**原生 UI、local-first 会话、版本化双向同步、设备安全密钥、RDP 内 Agent 配置、尊重 Android/iOS 真实生命周期**。如果其中任意一项被替换成 WebView、整包覆盖、明文 local storage 或伪后台常驻，项目就没有达到本文定义的原生移动端目标。
