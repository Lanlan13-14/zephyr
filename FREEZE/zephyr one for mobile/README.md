# Zephyr One for Mobile

此目录集中保存 Zephyr One Android / iOS 原生 App 的产品、架构、交互和品牌设计资料。

## 内容

- [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md)：用户确认的产品范围合同；规定功能、绑定、完整同步、Token互备、命名和发布阻断项。
- [`DEVELOPMENT.md`](DEVELOPMENT.md)：Kotlin + Jetpack Compose、Swift + SwiftUI 原生 App 完整技术开发文档。
- [`branding/manifest.json`](branding/manifest.json)：四色图标 palette、geometry、源文件 SHA-256 与生产规则。
- [`branding/source/`](branding/source/)：用户提交的 Frost / Lava / Asagi / Cyber 四色 SVG 及预览 HTML 权威设计源。
- [`references/bottom-floating-island.jpg`](references/bottom-floating-island.jpg)：普通页面四入口底部浮岛视觉参考。
- [`references/terminal-ime-closed.jpg`](references/terminal-ime-closed.jpg)：终端系统键盘收起状态参考。
- [`references/terminal-ime-open.jpg`](references/terminal-ime-open.jpg)：终端系统键盘弹出状态参考。
- [`references/manifest.json`](references/manifest.json)：三张参考图的原始文件名、像素尺寸、SHA-256 和设计角色。
- [`original-uploads/zephyr-one-icons.zip`](original-uploads/zephyr-one-icons.zip)：用户提交的原始图标压缩包。

## 已冻结的关键决策

- [KNOWN] Android 使用 Kotlin + Jetpack Compose、iOS 使用 Swift + SwiftUI；旧 Tauri `zephyr_one/` 是迁移/兼容来源。
- [KNOWN] Zephyr One完整实现当前账号有直接移动用途的能力，并保留用户要求的服务器设置和备份恢复。
- [KNOWN] One不提供当前账号安全设置、SMTP、CAPTCHA/IP策略、备案、自定义CSS/JS管理、多用户或独立Agent页；登录时只被动遵守主端认证策略。
- [KNOWN] One内原Zephyr Agent设置改名“文件同步”；主端入口统一叫“Zephyr Client”并继续兼容旧Agent。
- [KNOWN] 文件同步像iCloud一样完整双向镜像One有用途的账号数据、凭据和Client Token，不限于连接/笔记。
- [KNOWN] 开启同步要求主端先创建 Token，然后在 One 输入 Zephyr 用户名、密码，并在启用 TOTP 时通过动态码后绑定设备。
- [KNOWN] 文件同步同时提供用户自定义自动间隔和“立即同步”；删除 One 设备、查看/旋转/删除/重置 Token 必须走密码或 TOTP 敏感验证。
- [INFERRED] 普通页面使用四入口底部浮岛；选中项展开为“图标 + 文字”胶囊，其他项只显示图标。
- [INFERRED] 终端使用 `terminal viewport + 快捷键矩阵 + terminal context dock`；系统键盘出现时隐藏 dock，矩阵紧贴 IME，viewport 与 PTY rows/cols 同步 resize。
- [INFERRED] Zephyr One 使用 Frost / Lava / Asagi / Cyber 四套应用图标，并按平台能力随主题切换；正式 launcher asset 先把 “One” 文字转成固定 path。

[KNOWN] 设计参考和原始压缩包按收到的字节保存；校验值记录在 `DEVELOPMENT.md` 与 `branding/manifest.json`。
