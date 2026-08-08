# Zephyr One Mobile 产品要求合同

> 状态：冻结；用户最新要求优先
>
> 适用：Android Kotlin + Jetpack Compose、iOS Swift + SwiftUI 原生 Zephyr One

## 1. 优先级

- [KNOWN] 本文件约束“必须做什么”；`DEVELOPMENT.md` 约束“怎样实现”。两者冲突时，先满足本文件的产品范围，再调整技术方案。
- [KNOWN] 用户后续明确要求高于本文；早期 Tauri 全端方案低于当前 Kotlin/Swift 原生移动方案。
- [KNOWN] 里程碑只允许调整实施顺序；最终范围以本合同的能力矩阵和明确排除项为准，既不能擅自删移动操作能力，也不能把无用途的 Web 部署后台硬塞进 One。

## 2. 产品与技术栈

- [KNOWN] 编译产品名称为 **Zephyr One**。
- [KNOWN] Android 使用 Kotlin + Jetpack Compose；iOS 使用 Swift + SwiftUI。
- [KNOWN] 页面、导航、表单、终端输入、系统文件选择和系统认证原生实现，不用整页 WebView 冒充原生。
- [INFERRED] SSH/RDP/VNC/终端等复杂协议核心可复用成熟 native library；复用协议库不等于非原生 UI。
- [KNOWN] 仓库已有 `zephyr_one/` Tauri 实现作为迁移/兼容来源，不作为新 Android/iOS UI 架构。
- [KNOWN] Logo、四色主题、图标和总体视觉与 Zephyr 保持一致；移动端按已冻结浮岛、终端和 IME 规范适配。
- [KNOWN] Zephyr One 的产品定位是 **Zephyr 的完整移动端原生客户端**，不是 Zephyr Lite、远程连接工具集合或阉割版客户端；原生重构的目标是在手机、平板、触控、键盘和系统生命周期下获得比压缩 Web UI 更好的体验。
- [KNOWN] Android 与 iOS 共用 Zephyr 品牌、能力、数据和协议合同，但分别采用各自平台的导航、返回、sheet、菜单、文件选择、权限、触觉、字体、安全区和动画能力；不得为了像素一致破坏平台习惯。
- [KNOWN] 成熟的 SSH/终端/RDP/VNC native library 可以复用协议和渲染核心，但不能决定 One 的产品范围，也不能把第三方 App UI、WebView 或桌面交互直接照搬进 One。

## 3. 功能范围

- [KNOWN] Zephyr One 必须完整实现**当前账号的移动操作能力**：连接/仪表盘、SSH、Telnet、RDP、VNC、SFTP、文件上传下载/预览/编辑、Docker/监控/日志、批量执行、代理、SSH Key、跳板、代码片段、笔记、活动、AI 使用能力、服务器设置、备份恢复、外观、分享资源使用、工作区恢复、Client Token 与文件同步。
- [KNOWN] 明确排除以下功能：**多用户管理、独立 Zephyr Agent页面、当前账号安全设置、SMTP/邮件通知、CAPTCHA/IP白名单/防爆破配置、ICP/公安备案**。
- [KNOWN] 服务器设置和备份恢复保留；不能因为它们由主端执行就擅自从One移除。
- [KNOWN] 其他只服务Web站点展示/登录页且在One没有直接用途的设置不进入One；新增排除项必须由用户确认，不能由开发者机械扩张或删减。
- [KNOWN] One 的账号密码/TOTP只用于绑定文件同步和敏感操作验证，不因此提供“账号安全”设置页。
- [KNOWN] 主端要求 CAPTCHA/IP策略时，One 登录流程必须遵守服务端结果，但不提供这些策略的配置页面。
- [KNOWN] 自定义 CSS/JS 是 Web 页面注入配置，在 One 原生 UI 没有执行用途，也不提供编辑页面；文件同步是否备份其原始值由服务端完整快照兼容层处理，不能当成 One 功能入口。
- [KNOWN] 手机上的布局可改成全屏工作区、sheet、会话列表和宽屏多栏，但保留的移动操作能力不能因布局变化而消失。
- [KNOWN] 当前绑定账号**自己拥有**的数据进入 One 完整双向镜像；其他用户通过 ACL 分享给当前账号的资源不属于其镜像，不能落入 One 本地数据库、SecretStore、搜索索引、离线缓存、备份、日志或系统集成，每次查看/使用都在线请求 Zephyr 并实时重验权限。
- [KNOWN] “移动端优化”只允许改变布局、信息层级、手势、系统集成和渐进披露，不允许减少字段、协议选项、ACL、错误状态、同步语义或操作能力；复杂功能必须重构成适合移动端的 flow，而不是隐藏或延期成无期限占位。
- [KNOWN] Termux 可作为 SSH/Telnet terminal 输入、scrollback、selection、extra keys、IME、硬件键盘和 PTY resize 的交互参考，但 One 不复制其 drawer、视觉皮肤或本地 shell 产品定位。
- [KNOWN] RDP/VNC 使用成熟 core 时，Zephyr 已承诺的通道或设置若上游缺失，必须通过 adapter、受控 fork、替换核心或发布阻断解决，不能把缺库能力转化成产品删项。

## 4. Zephyr Agent、Zephyr Client 与文件同步命名

- [KNOWN] Zephyr One 不显示名为“Zephyr Agent”的独立页面、设置项或导航项。
- [KNOWN] One 内原 Zephyr Agent 设置位置改名为 **文件同步**。
- [KNOWN] 底层旧 Agent/ZFT2/`/agent/files` 能力继续整合，用于 RDP 文件重定向和主端文件桥接；这是兼容实现，不是独立产品页。
- [KNOWN] Zephyr 主端原 Zephyr Agent 设置入口统一改名为 **Zephyr Client**。
- [KNOWN] Zephyr Client 页面必须保留旧 Zephyr Agent 的 Token、在线 Agent 和文件映射能力，同时增加 Zephyr One 设备、同步状态、自动间隔、手动同步、启停和删除。
- [KNOWN] 旧独立 Zephyr Agent 客户端和协议必须继续兼容。

## 5. 绑定前置条件

- [KNOWN] 开启文件同步前，用户必须先在 Zephyr 主端 → Zephyr Client 创建至少一个 Client Token。
- [KNOWN] One 不得在零 Token 状态下自动创建默认 Token 来绕过该前置步骤。
- [KNOWN] 用户必须在 One 输入 Zephyr 主端地址、Zephyr 用户名和密码并登录。
- [KNOWN] 若账号启用 TOTP，两步验证未成功前不能绑定或开启同步。
- [KNOWN] 登录成功后必须选择属于该账号的有效 Client Token，再绑定当前 One 设备。
- [KNOWN] 只有 Token、只有账号密码、错账号 Token、缺失/错误 TOTP 都不能开启同步。
- [KNOWN] 绑定和同步严格按不可变 userId 隔离，不跨账号混合数据。

## 6. 完整双向文件同步

- [KNOWN] 文件同步按 iCloud 类语义工作：Zephyr 与已绑定 One 都可修改数据，最终通过版本、冲突和墓碑收敛。
- [KNOWN] 同步不是只下拉，不是只备份，不是只同步 connections/notes，也不是只同步 metadata。
- [KNOWN] 默认同步当前账号**拥有**且在 One 有用途的完整持久数据和敏感字段，包括：连接、凭据、代理、SSH Key、跳板、笔记、代码片段、AI 使用数据/所需配置、服务器设置、备份恢复 metadata/加密包引用、活动、自己拥有资源的 ACL/分享状态、工作区持久状态和 Client Token record + secret；其他用户共享给当前账号的资源全部排除在镜像之外。
- [KNOWN] 不把 SMTP、CAPTCHA/IP策略、备案或账号安全配置同步成 One 的可操作功能。
- [INFERRED] One不理解的Web展示/登录字段可在加密 opaque snapshot中保留；One不展示、不编辑、不回写覆盖。
- [KNOWN] Zephyr 后续新增持久业务字段只有在 One 存在产品用途时进入可编辑同步 registry；未知/无用途字段按 opaque preservation 处理，不得被旧 One 清空。
- [KNOWN] Client Token 同时用于旧 Agent、One 绑定前置和 Zephyr ↔ One 完整互备；不能降级成只同步 token id/name。
- [KNOWN] One 创建、改名、旋转、删除 Token 后要同步回 Zephyr并传播到其他 One；主端对应修改也要传播到 One。
- [INFERRED] 敏感字段通过绑定设备公钥 envelope 传输，落入 Android Keystore/iOS Keychain保护的 SecretStore；日志、普通 preferences、change log 和导出包不出现明文。
- [INFERRED] 活 socket/PTY进程、设备身份私钥、数据库 master key、Android SAF URI、iOS bookmark等不可移植运行态不跨设备复制；对应连接定义、产品意图和可持久 metadata仍同步。
- [INFERRED] 删除通过 tombstone 传播，离线设备不能把已删除 Token/资源静默复活；恢复必须显式执行。
- [KNOWN] 共享 AI 每次由 One 向 Zephyr 主端发起请求，Provider Key、Env secret、Client Token 和共享资源 resolved credential 保留在主端；One 只收脱敏 stream/trace/结果和有权查看的内容。
- [KNOWN] 共享笔记不离线、不本地索引、不恢复草稿；正文和编辑每次在线经主端 `view/edit + expectedRevision + allowAiRead/Write` 校验，当前 viewer 的内存 buffer 离页/锁屏/撤销即清。
- [KNOWN] 共享连接默认支持主端 relay（凭据不下发）；需要原生直连时，Zephyr 可按次下发绑定 device/session/resource/purpose/expiry/nonce 的加密 use envelope，只含该会话最小连接材料，不持久化，并在握手/断开/失败/撤销时尽力清零。
- [KNOWN] direct 模式不能宣传“凭据从未到达设备”；若资源拥有者要求秘密绝不进入 One，必须强制 relay，relay 不可用则拒绝而不是静默降级。
- [KNOWN] 共享零驻留、按次 session、撤销、内存销毁和测试合同见 [`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)。

## 7. 自动与手动同步

- [KNOWN] 文件同步页必须提供总开关。
- [KNOWN] 必须提供独立“自动同步”开关。
- [KNOWN] 用户必须能自定义自动同步间隔。
- [KNOWN] 必须始终提供清晰可见的“立即同步”按钮；自动同步关闭时，只要设备仍绑定，手动同步仍可使用。
- [KNOWN] 必须显示当前状态、进度、上次尝试、上次成功、目标间隔、冲突数和最后错误。
- [INFERRED] 前台按用户间隔精确触发；后台受 Android/iOS 调度限制时尽力执行并显示实际同步时间，不能谎称后台精确到秒。
- [INFERRED] 重复点击立即同步必须合并为单个运行任务和最多一次尾随任务，不能并发破坏 cursor。

## 8. 敏感操作验证

- [KNOWN] 以下操作必须经 Zephyr 主端敏感验证：删除/撤销 One 设备；查看/复制 Token；旋转/删除 Token；重置全部 Token；会批量断开客户端的操作。
- [KNOWN] 未开启 TOTP 的账号输入当前 Zephyr 密码。
- [KNOWN] 已开启 TOTP 的账号输入当前有效 TOTP 动态码。
- [INFERRED] 验证成功后使用短时、单次用途 grant 执行具体操作，避免重复传递密码/TOTP。
- [KNOWN] 重置全部 Token 前显示受影响 One 与旧 Agent，但二次确认不能代替密码/TOTP验证。
- [INFERRED] Token 旋转/删除后，使用该 Token 的 One/旧 Agent立即失效；使用账号内其他 Token 的客户端不受无关影响。

## 9. 本地解锁

- [KNOWN] Zephyr One 不建立自己的本地用户名、应用密码和找回密码体系。
- [KNOWN] 启动 App 时可由用户选择是否要求系统原生解锁。
- [KNOWN] Android 使用 BiometricPrompt 的指纹/人脸/设备凭据；iOS 使用 LocalAuthentication 的 Face ID/Touch ID/设备密码。
- [KNOWN] 本地系统解锁不能替代开启文件同步时的 Zephyr 账号密码和 TOTP，也不能替代主端敏感操作验证。

## 10. UI 冻结项

- [KNOWN] 普通页面底部使用四入口悬浮岛；选中项显示“图标 + 文字”胶囊，未选中项只显示图标。
- [KNOWN] 终端采用 `terminal viewport + 快捷键矩阵 + terminal context dock`。
- [KNOWN] 系统键盘出现时隐藏根浮岛/context dock，快捷键矩阵贴紧 IME，终端 viewport 和 PTY rows/cols 同步 resize，光标保持可见。
- [KNOWN] Zephyr One 使用 Frost、Lava、Asagi、Cyber 四套图标并按平台能力随主题切换。
- [KNOWN] RDP/VNC 使用沉浸式 remote surface，并同时提供 direct touch 与 trackpad 两种模式；键盘、modifier、剪贴板、通道和 session 工具通过移动端 context dock/sheet 提供。
- [KNOWN] 动画优先调用系统原生导航、sheet、keyboard/inset、predictive back、spring、interactive animator 和 haptic；手势动画必须跟手、可中断，不得以动画延迟 terminal/remote input。
- [KNOWN] iOS Reduce Motion、Android animator/accessibility 设置必须被尊重；终端字符、remote pointer 和 framebuffer 不做增加输入延迟的装饰补间。
- [KNOWN] Android App 内返回使用系统 back progress/commit/cancel 作为真源，但由 One 实现符合自身层级的可交互预测性返回视觉；根 Activity 返回主页/跨任务仍交给系统。
- [KNOWN] iOS 所有 push 进入的普通页面都必须支持可取消、跟手的左边缘右滑返回；scroll/pager/terminal/RDP/VNC/AI 手势不得无故吞掉系统返回边缘。
- [KNOWN] Zephyr AI 在 One 默认使用覆盖当前页面的原生浮窗/detent/side panel，而不是强迫进入隔离的聊天页；底层页面、终端或 RDP/VNC 画面必须持续可见，用户能看见 AI 的目标、执行 trace 和验证结果。
- [KNOWN] 同版本 Zephyr 的全部 model-visible AI capability/tool、risk、confirmation、playbook 和安全边界必须在 One 保持一致；Web DOM 操作通过原生版本化 semantic/action bridge 提供等价能力，不能因改成原生 UI 而删除。
- [KNOWN] 详细视觉、交互和动画合同见 [`MOBILE_EXPERIENCE.md`](MOBILE_EXPERIENCE.md)，终端见 [`TERMINAL_EXPERIENCE.md`](TERMINAL_EXPERIENCE.md)，远程桌面见 [`REMOTE_DESKTOP_EXPERIENCE.md`](REMOTE_DESKTOP_EXPERIENCE.md)，AI 浮窗与能力见 [`AI_FLOATING_WORKSPACE.md`](AI_FLOATING_WORKSPACE.md)。

## 11. 发布阻断条件

任一项成立则不能宣称 Zephyr One 已完整实现：

- [KNOWN] 第 3 章要求保留的移动操作能力仍有功能缺失，或错误加入了明确排除的 Web 主端管理页面。
- [KNOWN] 任一 One 有用途的持久业务实体没有双向同步或删除传播。
- [KNOWN] Client Token只同步 metadata、不能从 One 回写主端或不能加密恢复。
- [KNOWN] 文件同步只有 pull、没有 push/conflict/idempotency/tombstone。
- [KNOWN] 没有用户自定义自动间隔或没有立即同步。
- [KNOWN] One 设备删除/Token重置绕过密码或 TOTP。
- [KNOWN] One 再次出现独立 Zephyr Agent 产品页。
- [KNOWN] 用整页 WebView代替要求的原生页面。
- [KNOWN] 用平台后台限制作为删除功能的理由，而不是明确说明并做前台/补偿实现。
- [KNOWN] 把 One 定位或发布成 Zephyr Lite/阉割版，只实现连接协议而缺失其他保留能力，或用“移动端不方便”删除复杂功能。
- [KNOWN] SSH/Telnet 没有达到冻结的 IME、scrollback、selection、extra keys、硬件键盘、mouse mode 和 PTY resize 交互门。
- [KNOWN] RDP/VNC 只有画面或基本点击，缺 direct/trackpad、键盘、剪贴板、证书、通道、文件授权、弱网恢复或 Zephyr 已承诺设置。
- [KNOWN] 自绘动画破坏 iOS/Android 返回事件、sheet、键盘、Reduce Motion，或动画/重组增加 terminal 与 remote input 延迟。
- [KNOWN] Android 应用内返回没有 progress-driven 自定义视觉、不能取消/反向、一次手势改变两层，或错误覆盖根页系统 home/task transition。
- [KNOWN] iOS 任一普通 push 页面只能点按钮返回，或 pager/terminal/remote/AI overlay 吞掉左边缘 interactive swipe-back。
- [KNOWN] Zephyr AI 被降级成独立全屏聊天页、浮窗遮住/暂停目标 surface、用户看不到 tool trace/目标/确认/验证，或 One 的 AI tool catalog 少于同版本 Zephyr。
- [KNOWN] 任一 shared-to-me 实体、正文、ACL grant 或 secret 被写入 One 镜像、SecretStore、索引、离线缓存、备份、日志、通知、诊断或系统搜索。
- [KNOWN] 共享 AI 收到 Provider/Env/Client Token/resolved credential；共享笔记离线可读；ACL 撤销后仍可从本地缓存继续使用。
- [KNOWN] 共享连接 use envelope 可跨 device/session/resource/purpose/expiry 重放、被持久化，或 strict relay 失败时静默降级为凭据下发。
