# Zephyr One for Mobile

此目录集中保存 Zephyr One Android / iOS 原生 App 的产品、架构、交互和品牌设计资料。

## 内容

- [`DEVELOPMENT.md`](DEVELOPMENT.md)：Kotlin + Jetpack Compose、Swift + SwiftUI 原生 App 完整开发文档。
- [`branding/manifest.json`](branding/manifest.json)：四色图标 palette、geometry、源文件 SHA-256 与生产规则。
- [`branding/source/`](branding/source/)：用户提交的 Frost / Lava / Asagi / Cyber 四色 SVG 及预览 HTML 权威设计源。
- [`references/bottom-floating-island.jpg`](references/bottom-floating-island.jpg)：普通页面四入口底部浮岛视觉参考。
- [`references/terminal-ime-closed.jpg`](references/terminal-ime-closed.jpg)：终端系统键盘收起状态参考。
- [`references/terminal-ime-open.jpg`](references/terminal-ime-open.jpg)：终端系统键盘弹出状态参考。
- [`references/manifest.json`](references/manifest.json)：三张参考图的原始文件名、像素尺寸、SHA-256 和设计角色。
- [`original-uploads/zephyr-one-icons.zip`](original-uploads/zephyr-one-icons.zip)：用户提交的原始图标压缩包。

## 已冻结的关键决策

- [INFERRED] 普通页面使用四入口底部浮岛；选中项展开为“图标 + 文字”胶囊，其他项只显示图标。
- [INFERRED] 终端使用 `terminal viewport + 快捷键矩阵 + terminal context dock`。
- [INFERRED] 系统键盘出现时隐藏根浮岛/context dock，快捷键矩阵紧贴 IME，终端 viewport 与 PTY rows/cols 同步 resize。
- [INFERRED] Zephyr One 使用 Frost / Lava / Asagi / Cyber 四套应用图标，并按平台能力随主题切换。
- [INFERRED] 正式 launcher asset 必须把 SVG 中的 “One” 系统字体文字转成固定 path 后再生成。

[KNOWN] 设计参考和原始压缩包按收到的字节保存；校验值记录在 `DEVELOPMENT.md` 与 `branding/manifest.json`。
