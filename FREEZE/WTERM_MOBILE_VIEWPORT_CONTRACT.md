# WTerm × Zephyr 移动端视口 / 自动滚动契约

日期：2026-07-21  
基线：Netcatty `domain/terminalScroll.ts` 纪律 + Zephyr IME chrome 产品几何  
实现模块：`public/terminal-scroll-policy.js`

## 分离两条权威

| 轨 | 职责 | 禁止 |
|----|------|------|
| **A. BufferScrollPolicy** | 何时对终端 buffer 调用 `scrollToBottom` | DOM `getBoundingClientRect` 驱动滚动；多相位 timer 追滚 |
| **B. ImeChromeLayout** | 软键盘 inset、工具栏 fixed、光标可见 class | 在键盘动画里每帧改 `scrollTop` |

应用层改 `element.scrollTop` 抢权视为违约（调试除外）。

## A. Buffer 滚动（Netcatty）

| ID | 规则 |
|----|------|
| S0 | at-bottom：优先 buffer `viewportY >= baseY`；否则 `term.isAtBottom()` / viewport snapshot |
| S1 | `scrollTerminalToBottomIfNeeded`：已在底部 → **false 且 0 次** scroll API |
| S2 | 可打印输入 → `scrollOnInput`（默认 true）；ESC/控制 → `scrollOnKeyPress`（默认 false） |
| S3 | 远端输出：`scrollOnOutput` **默认 false**；stick 靠内核在已 at-bottom 时的行为 |
| S4 | 粘贴：`scrollOnPaste` 默认 true → 最多 1 次 ifNeeded |
| S5 | composition 期间 shouldScroll=false |
| S6 | 任意事件路径 scroll API ≤ 1；settle phases：input=`[0]`，layout=`[]`，paste/enter≤2 |

默认设置：

```js
{ scrollOnInput: true, scrollOnOutput: false, scrollOnKeyPress: false, scrollOnPaste: true }
```

## B. IME / 布局（产品）

| ID | 场景 | 通过标准 |
|----|------|----------|
| V1 | 少内容 + 开键盘 | prompt 在工具栏上沿之上；无半空大黑块 |
| V2 | 铺满 + 开键盘 | 光标行可见，底边在工具栏上沿 0～0.5 行内 |
| V3 | 关键盘 | 工具栏回 flow；无残留 fixed / inset |
| V4 | 点终端黑区 | 手势打开 IME；滚动/长按/双击不打开 |
| V5 | 光标 | IME 开期间 `.wterm.ime-active` 实心光标可见 |
| V6 | ASCII 同行连打 | 已可见则 scrollTop 不变 |
| V7 | 中文 composition | 组合期不滚；commit 后 ≤1 次校正 |
| V8 | 大输出 | 用户在底部时 stick；上滑阅读不抢 |
| V9 | 键盘动画 | 非单调 scrollTop 写入 ≤1 |
| V10 | 图3 | 禁止 prompt 悬视口中部 + 大块 bottom blank |

几何（`computeCursorAboveChromeScrollTop`）：

- 光标坐标必须是 **viewport-relative**（`cursorBottomInViewport`）
  - 来源：overlay `getBoundingClientRect` 或 `bridge.getCursor().row * lineHeight`
  - **禁止** `contentY = scrollTop + row*lh`（会正反馈，光标乱飞）
- 校正用 **delta**：`nextScrollTop = scrollTop + (cursorBottomVisible - visibleBottom)`
- `--ime-chrome-bottom` 来自父页 `frameRect.bottom - keyboardTop`
- keyboard-open：`padding-bottom` **只**含 tools+aux，**不含** `keyboard-inset`
- 少内容 `maxScroll<=0`：`scrollTop=0`
- fully visible → **0** scroll（force 也不能动）
- 移动端关闭 WTerm `_shouldScrollToBottom`；render 路径 **不** pin
- **唯一写 scrollTop**：`applyCursorAboveChromeScroll`（rAF 合并 + 32ms 限速）
- 旧 `ensureMobileStableCursorVisible` 步进器禁用，只转调唯一写入口

## 光标

- 实心样式：`.wterm.focused` **或** `.wterm.ime-active`
- 焦点在 `#mobileTerminalImeProxy` 时必须加 `ime-active`
- 光标行列：`bridge.getCursor()`，禁止依赖 `.cursor` query 作为唯一路径

## 文件

- `public/terminal-scroll-policy.js`
- `tests/terminal-scroll-policy.test.mjs`
- `public/ssh-mobile-keyboard.js`（intent，不拥有 buffer scroll）
- `public/terminal.js`（接线）
- `wterm/.../terminal.css` + `public/vendor/wterm-fork/terminal.css`

## 明确不做

- 不再叠 `schedule*Follow` 7 相位
- 不用 workspace 裁高 / `translateY(-keyboard)` 作主方案
- 不为光标 focus WTerm 隐藏 textarea
- 不在本契约内做平滑滚动动画
