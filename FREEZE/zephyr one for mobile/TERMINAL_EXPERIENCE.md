# Zephyr One SSH / Telnet 终端交互规范

> [KNOWN] 参考基线：`termux/termux-app@3df69d1d` 的 `terminal-view`、`terminal-emulator`、extra keys 与输入行为；Zephyr 的 `FREEZE/WTERM_MOBILE_VIEWPORT_CONTRACT.md`、SSH/Telnet 字段、代理/跳板、会话、SFTP 和 ACL 仍是业务真源。
>
> [KNOWN] Termux 参考的是成熟终端“手感”和 Android 行为，不是照搬 Termux App 的视觉、drawer、shell runtime 或产品信息架构。

## 1. 结论

- [KNOWN] SSH 与 Telnet 共用同一原生 terminal surface、IME、scrollback、selection、extra keys、hardware keyboard 和 session dock。
- [KNOWN] 两者只在 transport/negotiation/security 上不同：SSH 加密并支持 SFTP/keys/proxy/jump；Telnet 明文、IAC/NAWS/TTYPE/encoding/in-band auto-login。
- [INFERRED] Android 可以评估直接复用/分叉 Termux `terminal-emulator` 与 `terminal-view` 中 Apache-2.0 来源模块，但必须完成许可证文件级审计、Compose host adapter、accessibility 和现代 API 适配。
- [INFERRED] iOS 首选评估 MIT `SwiftTerm` 的 UIKit/Metal terminal view 与 parser；通过 `UIViewRepresentable` 嵌入 SwiftUI。它不提供 Zephyr SSH 业务层，仍需连接、ACL、route、SFTP 和 session adapter。
- [KNOWN] 两端共享 Zephyr terminal behavior fixtures，不要求共享 renderer 源码；体验等价高于代码统一。

## 2. Termux 中值得继承的具体行为

[KNOWN] 以下均由 Termux 当前代码确认：

1. `TerminalView` 是真正的 text editor，提供 `InputConnection`，不是隐藏输入框代理。
2. 单击 terminal 获得焦点并显示软键盘；selection 时单击先退出 selection。
3. 一指垂直拖动按字体行高累计 residual，再转为完整 row scroll，低速滚动不丢亚行距离。
4. fling 使用原生 `Scroller`；scrollback 边界限制在 transcript 与底部之间。
5. alternate buffer 无 mouse tracking 时滚动转为 Up/Down，适配 `less` 等全屏程序。
6. mouse tracking active 时把 wheel/tap/move 转成 terminal mouse event，而不是总滚本地 transcript。
7. pinch 以阈值改变 font size，并立即重新计算 rows/columns。
8. 长按触发系统 haptic，进入文本选择；拖 selection handle 时隐藏 floating toolbar，松手后恢复。
9. physical mouse 支持 wheel、左键、右键 context menu、中键粘贴。
10. Ctrl 字符映射完整处理 `Ctrl+A..Z`、`Ctrl+Space`、`Ctrl+[\]^_/?` 和 DEL。
11. Alt 在 code point 前发送 ESC，兼容 readline Alt+B/Alt+F。
12. Shift+PageUp/PageDown 滚整屏 scrollback。
13. extra keys 支持 modifier、keyboard toggle、paste、scroll mode 等动作。
14. view 尺寸变化时以 cell width/line spacing 算出列行并通知 terminal session/PTTY。

[INFERRED] Zephyr One 继承这些行为，但重新设计 visual chrome、快捷键布局、会话切换和工具 dock。

## 3. TerminalSurface 单一所有者

```text
TerminalSurfaceController
 ├─ input connection / marked text / composition
 ├─ hardware key + modifier state
 ├─ gesture arbitration
 ├─ scrollback viewport
 ├─ selection + system actions
 ├─ terminal mouse protocol
 ├─ resize → PTY NAWS
 ├─ renderer dirty regions
 └─ accessibility snapshot
```

- [KNOWN] 不允许 Compose TextField/SwiftUI TextField、terminal view 和 extra-key layer 分别发送 Enter/IME commit；一个事件只能有一个 owner。
- [KNOWN] composition update 只更新 marked-text overlay，不写 PTY；commit exactly once；cancel 不发远端。
- [INFERRED] UI state 与 terminal engine state 分离：toolbar/session list 可以重组，terminal session/scrollback 不重建。

## 4. 输入链路

### 4.1 Android

- [INFERRED] TerminalView 暴露真实 `InputConnection`；优先 char-based input，但为 Gboard/Samsung/中文/日文/韩文维护 composing region。
- [INFERRED] `commitText`、`setComposingText`、`finishComposingText`、`deleteSurroundingText`、editor action 与 physical `KeyEvent` 各自有 fixture。
- [KNOWN] Ctrl+Space ROM workaround 只在检测/设置开启时使用，不全局吞 Space。
- [INFERRED] hardware key repeat 由系统 repeatCount 驱动；不以动画 timer 伪造。

### 4.2 iOS

- [INFERRED] UIKit terminal view 实现 `UIKeyInput`/`UITextInput` 等价输入面；markedTextRange 完整支持 CJK。
- [INFERRED] `UIKeyCommand` 提供 Cmd/Control/Option、方向、PageUp/Down、Tab、Esc 和 session shortcut；不得让 SwiftUI 上层吞 terminal key。
- [INFERRED] iPad hardware keyboard 的 key repeat、modifier lock 与 software keyboard 使用同一 canonical key encoder。

### 4.3 粘贴

- [KNOWN] 只在用户动作后读取 clipboard。
- [INFERRED] 终端启用 bracketed paste 时包裹 `ESC[200~`/`ESC[201~`。
- [INFERRED] 含换行、多行或超过 4 KiB 时显示预览/确认；可选择“粘贴但不执行最后换行”。
- [KNOWN] 密码/Token 写剪贴板走敏感自动清理策略，普通 terminal copy 不擅自清理用户 clipboard。

## 5. Scrollback 与程序鼠标模式

### 5.1 手势仲裁

```text
selection active      → selection handles own drag
pinch active          → font scale owns pointers
terminal mouse mode   → direct tap/drag goes remote; two-finger scroll local/remote by setting
normal primary buffer → one-finger vertical scrollback
alternate buffer      → translate scroll to app Up/Down/Page unless mouse mode owns it
```

- [INFERRED] 手势从第一帧并行识别，超过 axis/slop 后锁定 winner；不在 scroll 中途突然变 selection/pinch。
- [INFERRED] keyboard-visible 状态下向下 overscroll 到 bottom 不关闭键盘；键盘关闭只有明确按钮/系统手势。
- [KNOWN] 用户离开 bottom 后远端输出不抢回；显示“↓ 新输出 N 行”按钮。用户回到底部才恢复 follow-output。
- [INFERRED] `SCROLL` toggle 可临时强制 local scrollback，解决 tmux/vim mouse mode 下查看本地历史。

### 5.2 性能

- [INFERRED] scrollback 默认 100,000 行，可设 10k/50k/100k/500k；底层 chunk/ring 存储，不持有每行 Compose/UIView object。
- [INFERRED] fling 使用平台 decay：Android spline/decay，iOS UIScrollView-like deceleration；边界无无意义 bounce 到 terminal 内容之外。
- [INFERRED] renderer 只重绘 dirty rows/selection/cursor；scroll 使用 tile/texture reuse，不能每次复制完整 transcript。

## 6. 字体缩放与 PTY resize

- [INFERRED] pinch 连续显示 preview，但实际字号以 0.5sp/pt 或单级 threshold 稳定提交；范围默认 8–32，可在设置扩展。
- [KNOWN] 字号、orientation、IME、shortcut matrix、split view、floating keyboard、Stage Manager 改变可见 viewport 都要重算 rows/cols。
- [INFERRED] resize debounce 16–50ms，最后值必须发送；拖 iPad/折叠屏 resize 时不积压数百个 NAWS/window-change。
- [KNOWN] 最少 4×4 cells；不足时收起非必要 chrome，不把 terminal 算成负高度。
- [INFERRED] resize 前后光标尽量保持在同一可见 anchor；服务器 reflow 与本地 scrollback reflow 行为需 fixture。

## 7. 文本选择

- [KNOWN] 长按进入 selection，立即 system haptic；不是打开自绘菜单后再选。
- [INFERRED] Android 使用 ActionMode/system text toolbar；iOS 使用 edit menu。操作：复制、全选、搜索、分享、打开链接、复制命令。
- [INFERRED] 单/双/三击：单击焦点，双击 word，三击 logical line；在 mouse-reporting mode 下 double/triple selection 需要 selection modifier 或临时 scroll mode，避免误发远端鼠标。
- [KNOWN] selection 期间锁定会冲突的 root/session swipe；结束后恢复。
- [INFERRED] bidi/CJK/wide glyph/combining/emoji selection 坐标按 grapheme + cell map，不按 UTF-16 index 猜测。

## 8. 快捷键矩阵

### 8.1 默认布局

```text
Row 1: Esc  Ctrl  Alt  Tab  ←  ↓  ↑  →
Row 2: /    -     |    Home End PgUp PgDn keyboard
```

- [INFERRED] 手机默认一行主键 + 可横滑/展开第二行；平板可两行常驻。
- [KNOWN] 用户可重排；同步保存语义 key id，不同步像素位置。
- [INFERRED] Ctrl/Alt/Shift/Fn 支持 one-shot latch；双击 lock；再次点击 release。状态有文字/形状/semantics/haptic，不只靠颜色。
- [INFERRED] 按住箭头重复，初始 delay/频率跟平台 keyboard repeat；松手立即停止。
- [KNOWN] `keyboard`、`paste`、`scroll`、`snippets`、`sessions` 是 action，不伪装成发给 PTY 的字符串。

### 8.2 与冻结 IME 布局结合

- [KNOWN] IME 收起：terminal viewport → 快捷键矩阵 → context dock。
- [KNOWN] IME 打开：root 浮岛/context dock 隐藏，快捷键矩阵紧贴 IME，terminal viewport resize。
- [INFERRED] Android 读 WindowInsets.ime；iOS 读 keyboard layout guide/safe area；不使用固定键盘高度。
- [INFERRED] floating/split hardware keyboard 时矩阵仍可用，不误判整屏键盘高度。

## 9. Session 体验

- [KNOWN] 手机不把多个 terminal 缩成不可读网格；使用全屏 session + 快速切换器。
- [INFERRED] session dock 左右滑切换或打开 sheet；手势必须避开 iOS edge-back/Android predictive back，不占系统边缘。
- [INFERRED] 外接键盘：Ctrl+Alt+N/P（Android/兼容）和 Cmd+Shift+[/]（iPad）切换，可在设置改。
- [KNOWN] 切 session 不重连、不重置 scrollback、selection、IME composition；composition 未完成时先 commit/cancel 按平台合同处理。
- [INFERRED] background session output 有 badge，可独立 mute bell；高输出不触发频繁 haptic/notification。

## 10. SSH 与 Telnet 差异

| 能力 | SSH | Telnet |
| --- | --- | --- |
| 加密 | [KNOWN] SSH transport | [KNOWN] 无；每次新建/公网目标警示 |
| 认证 | [KNOWN] password/key/passphrase | [KNOWN] in-band username/password auto-login |
| route | [KNOWN] direct/SOCKS5/HTTP/最多 8 jump | [KNOWN] direct/SOCKS5/HTTP/SSH jump route |
| terminal resize | [KNOWN] PTY window-change | [KNOWN] NAWS |
| terminal type | [KNOWN] xterm-256color | [KNOWN] TTYPE xterm-256color |
| encoding | [KNOWN] UTF-8 为主 | [KNOWN] UTF-8/GBK/Big5/Latin-1 |
| files | [KNOWN] SFTP | [KNOWN] 无 SFTP，文件 dock 隐藏并说明 |
| host identity | [KNOWN] host key unknown/change | [KNOWN] 无等价 cryptographic identity |

[KNOWN] 除这些协议差异外，terminal 交互、快捷键、selection、scrollback、会话和动画一致。

## 11. 动画

- [INFERRED] terminal glyph、cursor、selection handle、remote output 不做补间动画。
- [INFERRED] shortcut matrix/dock 显隐使用系统 keyboard/inset 同步曲线；如果拿不到系统曲线则 120–180ms critical fade/translate，不先动 chrome 再 resize terminal。
- [INFERRED] session switcher 可跟手拖动并可中断；terminal bitmap/texture 只作过渡 snapshot，完成后恢复 live surface。
- [KNOWN] Reduce Motion 下 session switch 使用 crossfade/即时切换；终端输入和 scroll 性能不变。

## 12. 测试门

### 输入

- Gboard、Samsung、AOSP、中文拼音、日文、韩文、emoji、dead key、hardware keyboard。
- Enter exactly once、backspace/delete、Ctrl+Space、Alt+B/F、Ctrl+C/D/Z、Fn/arrow、key repeat。
- composition update/cancel/commit、keyboard show/hide 50 次。

### 终端程序

- bash/zsh/fish、vim/neovim、tmux/screen、less/man、htop、nano、fzf、top、curses mouse app。
- primary/alternate buffer、DEC mouse modes、bracketed paste、application cursor/keypad、OSC 8 links、truecolor、wide/combining/BiDi。

### 几何与性能

- 旋转、split screen、fold/unfold、iPad resize、floating keyboard、fontScale、最大字号。
- 100k scrollback fling、10 MB/s output、大量 ANSI、selection 跨 10k 行。
- input→glyph p95 ≤ 50ms；连续 fling/输出无 ANR/main-thread stall；resize 最终 rows/cols 正确。

### 反向测试

- [KNOWN] 注入双 owner 发送 Enter 必须失败。
- [KNOWN] 注入 output 抢回 bottom 必须失败。
- [KNOWN] mouse mode 下错误滚本地/远端必须失败。
- [KNOWN] IME 打开后 dock 遮住 terminal 或 cursor 必须失败。
