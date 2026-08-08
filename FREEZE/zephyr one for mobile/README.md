# Zephyr One for Mobile

此目录是 Zephyr One Android / iOS 原生 App 的产品合同、Zephyr 能力继承规范、机器协议、逐屏交互、数据迁移和发布追踪入口。

## 当前真实状态

- [KNOWN] Android 目标是 Kotlin + Jetpack Compose；iOS 目标是 Swift + SwiftUI；不用整页 WebView 冒充原生。
- [KNOWN] 仓库当前还没有新的 Kotlin/Swift 原生项目；`../../zephyr_one/` 是旧 Tauri 迁移/兼容来源，不代表原生实现完成。
- [KNOWN] Zephyr 主端已有认证、ACL、连接、笔记、工作区、AI、备份、Client Token、ZFT2 等业务实现。
- [KNOWN] 旧 `/api/one/sync/pull` 仍是整包 pull-only；正式 `/api/mobile/v1` 双向同步尚未实现。
- [KNOWN] 本目录已经把 Zephyr 的现有业务规则提取成 One 的可执行规格和 machine-readable contracts；实际实现状态逐项见 [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)。

## 阅读顺序

1. [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md)：用户确认的产品范围；决定必须做什么和明确排除什么。
2. [`ZEPHYR_PARITY.md`](ZEPHYR_PARITY.md)：Zephyr 已有认证、ACL、资源、协议、笔记、AI、设置、备份、Token 和测试怎样继承到原生 One。
3. [`SCREEN_CATALOG.md`](SCREEN_CATALOG.md)：四入口信息架构、服务器设置/备份恢复落点和每屏完整状态。
4. [`MOBILE_EXPERIENCE.md`](MOBILE_EXPERIENCE.md)：iOS/Android 平台原生视觉、Android 自定义返回、iOS 全面右滑、动画和响应式体验。
5. [`TERMINAL_EXPERIENCE.md`](TERMINAL_EXPERIENCE.md)：参考 Termux 行为的 SSH/Telnet 输入、IME、scrollback、selection、extra keys 和 PTY 体验。
6. [`REMOTE_DESKTOP_EXPERIENCE.md`](REMOTE_DESKTOP_EXPERIENCE.md)：RDP/VNC 成熟核心、direct/trackpad、键盘、通道、弱网和沉浸式 UI。
7. [`AI_FLOATING_WORKSPACE.md`](AI_FLOATING_WORKSPACE.md)：Zephyr AI 全能力对齐、浮窗、可见操作闭环和原生 semantic bridge。
8. [`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)：共享资源零驻留、AI/笔记主端请求、连接 direct use envelope 与 strict relay。
9. [`SYNC_STATE_MACHINE.md`](SYNC_STATE_MACHINE.md)：首次 bootstrap、普通 push/pull、幂等、冲突、墓碑、blob 和崩溃恢复。
10. [`DATA_AND_MIGRATION.md`](DATA_AND_MIGRATION.md)：服务端新增 DDL、Android/iOS 逻辑 DB、SecretStore、Token 明文 JSON 和 Tauri 迁移。
11. [`NATIVE_ENGINE_DECISIONS.md`](NATIVE_ENGINE_DECISIONS.md)：SSH/SFTP、终端、RDP、VNC、Telnet、网络和密码学的 M0 决策门。
12. [`DEVELOPMENT.md`](DEVELOPMENT.md)：总体架构、视觉参数、能力矩阵、里程碑和质量目标。
13. [`TRACEABILITY.md`](TRACEABILITY.md)：需求 → Zephyr 事实源 → One code → One tests；发布门。
14. [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md)：只报告当前仓库真实完成度。

## 机器合同

| 文件 | 作用 |
| --- | --- |
| [`contracts/openapi-mobile-v1.json`](contracts/openapi-mobile-v1.json) | Mobile v1 登录、设备、同步、敏感验证和文件桥接 API |
| [`contracts/ai-capability-baseline.json`](contracts/ai-capability-baseline.json) | 从 Zephyr 真实 catalog 派生的 116 个 AI tool/capability/risk/confirmation/schema 对齐基线 |
| [`contracts/entity-registry.json`](contracts/entity-registry.json) | 每个同步实体的 editable/secret/opaque/deviceLocal/serverAuthority 分类和当前阻断 |
| [`contracts/error-registry.json`](contracts/error-registry.json) | 稳定错误码、HTTP 状态、retryable 和客户端动作 |
| [`contracts/schemas/sync-operation.schema.json`](contracts/schemas/sync-operation.schema.json) | push operation JSON Schema |
| [`contracts/schemas/sync-change.schema.json`](contracts/schemas/sync-change.schema.json) | change feed JSON Schema |
| [`contracts/schemas/secret-envelope.schema.json`](contracts/schemas/secret-envelope.schema.json) | 自有镜像设备 secret envelope JSON Schema |
| [`contracts/schemas/shared-use-envelope.schema.json`](contracts/schemas/shared-use-envelope.schema.json) | 共享连接一次 session/device/resource/purpose 绑定 use envelope JSON Schema |
| [`contracts/schemas/error.schema.json`](contracts/schemas/error.schema.json) | 统一错误 envelope JSON Schema |
| [`contracts/test-vectors/sync-v1.json`](contracts/test-vectors/sync-v1.json) | 自有镜像 AAD 和同步边界测试向量 |
| [`contracts/test-vectors/shared-use-v1.json`](contracts/test-vectors/shared-use-v1.json) | 共享 use AAD 与错 device/session/resource/purpose/expiry/replay 向量 |

## 已冻结的产品边界

- [KNOWN] One 完整实现当前账号有直接移动用途的能力：连接、SSH/Telnet/RDP/VNC、SFTP、Docker/监控/日志、批量执行、Proxy/SSH Key/JumpHost、Snippet、笔记、活动、AI、服务器设置、备份恢复、分享资源、工作区、Client Token 与文件同步。
- [KNOWN] One 不提供：多用户管理、独立 Zephyr Agent 页、当前账号安全设置、SMTP/邮件、CAPTCHA/IP白名单/防爆破配置、ICP/公安备案、自定义 CSS/JS 编辑执行。
- [KNOWN] One 内原 Agent 位置统一叫“文件同步”；主端入口叫“Zephyr Client”并继续兼容旧 Agent。
- [KNOWN] 文件同步是 iCloud 类完整双向镜像，有 push、cursor、idempotency、conflict、tombstone、secret envelope、用户间隔和立即同步；不是 pull-only 备份。
- [KNOWN] 开启前主端必须已有 Client Token；One 用 Zephyr 账号密码并在需要时通过 TOTP 后选择 Token 绑定。
- [KNOWN] 删除 One、查看/旋转/删除/重置 Token 必须经过当前密码或 TOTP 敏感验证。
- [KNOWN] 普通页使用四入口悬浮岛；服务器设置和备份恢复都位于“工具 → 服务器”，不得因根导航只有四项而消失。
- [KNOWN] 终端使用 viewport + 快捷键矩阵 + context dock；IME 打开时隐藏 root/dock，viewport 与 PTY rows/cols 同步。
- [KNOWN] Android App 内返回采用系统 progress 驱动的 One 自定义预测性返回视觉；iOS 每个普通 push 层级全面支持 interactive 右滑返回。
- [KNOWN] Zephyr AI 默认是叠在当前 page/terminal/RDP/VNC 上的原生浮窗；底层目标持续可见，能力/tool catalog 与同版本 Zephyr 完全一致。
- [KNOWN] 只有当前账号拥有的数据进入完整镜像；别人共享给当前账号的资源全部在线按次使用且不落地。共享 AI/笔记由主端授权和执行；共享连接可选择 strict relay，或使用绑定单会话的短时加密 use envelope 原生直连。

## 设计与品牌资料

- [`branding/manifest.json`](branding/manifest.json)：四色图标 palette、geometry、源文件 SHA-256 与生产规则。
- [`branding/source/`](branding/source/)：Frost / Lava / Asagi / Cyber SVG 和预览设计源。
- [`references/bottom-floating-island.jpg`](references/bottom-floating-island.jpg)：四入口底部浮岛参考。
- [`references/terminal-ime-closed.jpg`](references/terminal-ime-closed.jpg)：终端 IME 收起参考。
- [`references/terminal-ime-open.jpg`](references/terminal-ime-open.jpg)：终端 IME 打开参考。
- [`references/manifest.json`](references/manifest.json)：参考图尺寸、hash 和角色。
- [`original-uploads/zephyr-one-icons.zip`](original-uploads/zephyr-one-icons.zip)：原始用户图标包。

## 更新规则

- [KNOWN] 改 Zephyr 业务字段时必须同步检查 entity registry、OpenAPI、Android model、iOS model 和跨端 fixture。
- [KNOWN] 新增持久字段必须分类为 `editableSync / opaquePreserve / deviceLocal / serverOnly`；未分类则 CI 失败。
- [KNOWN] 只有文档或页面没有真实服务、Android/iOS 测试和真机证据，不得把 `IMPLEMENTATION_STATUS.md` 改为 implemented。
- [KNOWN] `PRODUCT_REQUIREMENTS.md` 与技术文档冲突时产品合同优先；用户后续明确要求高于现有文件。
