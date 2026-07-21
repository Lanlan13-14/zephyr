# SSH 移动端软键盘 —— 排查报告与根本修复计划

> 范围：**仅 SSH 终端**（`terminal.html` / `terminal.js` / `app.js` 父页通道）。
> 不做 RDP / noVNC / 编辑器。
> 本文档只写有证据支撑的内容。每条结论附文件：行号。

---

# 第一部分：排查报告（基于事实）

## A. 架构现状（事实）

当前 main `7fcfe2f` 的键盘链路涉及 5 层：

| 层 | 文件 | 行数 | 角色 |
|----|------|------|------|
| 1. 事件采集 | `public/terminal.js` | 11342 行 | touch/focus/viewport/IME 事件 |
| 2. 意图状态机 | `public/ssh-mobile-keyboard.js` | 531 行 | intent/physical 分离 |
| 3. 表面控制器 | `public/terminal-surface-controller.js` | 529 行 | scroll pin + chrome + IME 协调 |
| 4. 滚动策略 | `public/terminal-scroll-policy.js` | ~360 行 | cursor-above-chrome 纯计算 |
| 5. 父页通道 | `public/app.js` | 8009 行 | iframe metrics + workspace 裁剪 |

## B. 根本性缺陷（每条有证据）

### B1. 同一键盘状态有 3 套并行权威源 —— 这是所有 bug 的根源

**证据**（terminal.js 中状态变量的写者数量）：
- `mobileKeyboardOpen` —— **10 个写点**（terminal.js:149,158,183,186,1761,1787,7877,8483,8587,8654,8683）
- `mobileKeyboardUserControlled` —— **12 个写点**（terminal.js:160,180,1724,7708,8091,8122,8233,10334,10345,10695,10700,10727,10737）
- `keyboardFocusLikely` —— **14 个写点**（terminal.js:161,181,855,1723,8090,8123,8507,8520,8655,8684,10335,10346,10696,10701,10728,10738）

这三组变量与 `sshSoftKeyboard` 内部的 `state.intent/state.physicalOpen` 是**同一信息的第四份拷贝**。每份拷贝都有独立的更新时机，任何一个写点漏掉或时序错位，就会出现「半开半关」。

### B2. 打开键盘有 3 条并行代码路径

**证据**（terminal.js:10690-10740）：正文 tap 时依次尝试：
1. `surface.onTerminalTap('terminal-touch-immediate')`（surface 路径）
2. `sshSoftKeyboard.handleTerminalTap(...)`（controller 路径）
3. `focusMobileStableImeProxy(...)`（legacy 路径）

三条路径各自 `focus()` 同一个 proxy，各自写 state，各自发 parent metrics。**if-else 链的顺序决定行为，而不是状态机**。这就是「有时候开了马上关」「有时候点不开」的直接原因。

### B3. 键盘开合仍可能触发 WTerm resize —— 布局跳变根源

**证据**（terminal.js 中 keyboard/viewport 触发的 resize 调用点）：
- `updateViewportInsets`（terminal.js:8591）→ `stabilizeWTermAfterViewportOnlyChange('keyboard-open-start')`
- `requestStableTerminalLayout`（terminal.js:1830,1835）→ 内部含 `scheduleTerminalResize`
- `scheduleStableTerminalGridResize`（terminal.js:2585）→ `:settled-fit` 延迟 resize
- `scheduleKeyboardCloseFit`（terminal.js:8617,8626）→ 关闭后 650ms/360ms 再次 fit

虽然 stable 模式声明「键盘只是裁剪不 resize」，但 **5 个调用点在键盘事件的延迟回调里仍会触发 fit/resize**。这是打开瞬间文本跳动的原因。

### B4. 父页与子页各维护一份 open 状态 —— 通道不一致

**证据**：
- 父页：`appKeyboardOpen`（app.js:88）+ `.keyboard-open` class（app.js 中 11 处写）
- 子页：`mobileKeyboardOpen` + `sshSoftKeyboard.state` + `.keyboard-open` class（terminal.js 中 23 处写）
- 通信：子页 `notifyParentKeyboardMetrics`（terminal.js:8599）→ 父页 `applyTerminalWorkspaceKeyboard`（app.js:2919），父页 `reset-mobile-keyboard` → 子页 `finalizeKeyboardClose`

父页有独立的 hysteresis（app.js:7300 开≥80、关<16），子页有独立的 hysteresis（ssh-mobile-keyboard.js 开≥80、关<12）。**两套阈值不一致时，父页认为开着、子页认为关了，就会出现工具栏悬在半空**。

### B5. 手势判定不是状态机 —— 滚动/选区误开

**证据**（terminal.js:10653-10760）：
- tap 判定依赖 `terminalTouchMoved`（boolean）+ `mobileStableLastFocusGestureAt`（时间戳）+ 延迟 180ms 的 timer
- `pointermove` 只更新 `terminalTouchMoved=true`（terminal.js:10764 区域），但**没有 fling 检测**：快速滑动后的惯性滚动期间，`terminalTouchMoved` 已被 pointerup 前的最后状态决定，timer 回调里再判断已晚
- `scheduleMobileLongPressSelectionGuard`（terminal.js:446）是独立 timer，与 tap timer 互相 clear，但**双击选词与 tap-to-open 的冲突靠 `handleMobileTerminalDoubleTap` 先跑 + 360ms 时间窗**，不是状态互斥

### B6. 补丁历史证明「补丁式修复」已失效

**证据**：最近 13 个 commit 全部是键盘/滚动相关修复：

```
7fcfe2f fix(terminal): make WTerm an external mobile input surface
283aa00 fix(terminal): wire TerminalSurface as sole mobile control plane
66c1d5c fix(terminal): stop cursor fly — viewport pin + single scroll writer
272d99b fix(terminal): pin cursor above chrome, never chase maxScroll
b88e9b9 fix(terminal): Netcatty-style buffer scroll + ime-active cursor
0d4a7bc fix(ssh): remove blue scrollbar pill and exact-pin IME bars
b8a2d5c fix(ssh): flush IME chrome pin + kill blue press flash
5873a09 fix(ssh): bottom bar positioning and blue highlight
248e591 fix(ssh): kill keyboard auto-dismiss and gray void layout
045dfae fix(ssh): command bar IME overlays with zero layout change
e35007b fix(ssh): stop keyboard lift gray-void flash
4d3e42c fix(ssh): scheme-A keyboard lift + editor toolbar scroll
```

每个 fix 修上一个 fix 引入的回归。terminal.js 膨胀到 11342 行、139 处 keyboard 相关 CSS、100 处 setTimeout、32 处 classList 写。**这不是「还差几个补丁」的状态，是架构性债务**。

### B7. CSS 状态通道过多

**证据**：键盘布局状态通过以下渠道同时传递：
- CSS 变量：`--keyboard-inset`、`--app-keyboard-inset`、`--ime-chrome-bottom`、`--app-keyboard-shift`、`--app-keyboard-top`、`--visual-vh`、`--stable-vh`、`--visual-offset-top`（8 个）
- CSS class：`keyboard-open`、`keyboard-settling`、`mobile-keyboard-open`、`ime-active`、`viewport-updating`、`terminal-keyboard-lift`、`cmd-overlay-keyboard`（7 个）

**15 个 CSS 通道表达同一件事**：「键盘开了，高度 X」。任何一个通道更新延迟或顺序错位，就会闪烁/悬停/灰屏。

---

## C. 根本原因总结

```
根因 1（状态）：键盘 open/closed 状态存在 4 份拷贝，43 个写点
根因 2（控制流）：打开/关闭键盘有 3 条并行路径，if-else 顺序决定行为
根因 3（布局）：键盘事件与 resize/fit 没有硬隔离，5 个调用点可越界
根因 4（通道）：父/子页各自判定 open，阈值不一致，CSS 通道 15 个
根因 5（手势）：tap/pan/fling/selection 不是状态机，靠 timer+boolean 互猜
```

**结论：继续在现有代码上加补丁，只会重复 B6 的循环。必须把这 5 个根因一次解决。**

---

# 第二部分：根本修复方案

## 设计原则

1. **单一事实源**：键盘 open/closed 状态只存在于一个对象里，其他所有地方只读
2. **单一控制流**：打开/关闭只有一个入口函数，无 if-else 降级链
3. **硬隔离**：键盘事件与 WTerm resize/fit 之间用不可绕过的 gate 隔离
4. **单通道**：父/子页只传一份 metrics，父页不再自行判定
5. **手势状态机**：tap/pan/fling/selection 是显式状态，不是 timer+boolean

## 目标架构

```
┌─ public/ssh-keyboard/
│
├─ gesture.js          GestureStateMachine
│                      pointerdown/move/up/cancel → tap|pan|fling|pinch|longpress
│                      纯状态机，无 timer 猜测，无 DOM 依赖
│
├─ intent.js           KeyboardIntentStore  （重构现有 ssh-mobile-keyboard.js）
│                      唯一保存 intent/physical/focusOwner
│                      open()/close()/toggle()/syncViewport()
│                      唯一的 focus()/blur() 调用者
│
├─ layout.js           KeyboardLayoutGate
│                      键盘 phase: closed|opening|open|closing
│                      opening/open/closing 期间：
│                        - 禁止 term.fit()/term.resize()
│                        - 禁止非 pin 的 scrollTop 写入
│                        - 只允许更新 --ssh-kb-inset 一个 CSS 变量
│
├─ bridge.js           ParentBridge
│                      唯一 postMessage 出口
│                      消息：{type:'ssh-kb', phase, inset, intent}
│                      父页 app.js 只渲染，不判定
│
└─ index.js            SshKeyboard  （facade）
                       const kb = createSshKeyboard({...})
                       kb.handlePointerDown/Move/Up(event)
                       kb.handleViewportChange(metrics)
                       kb.handleImeFocus/Blur/Composition(event)
                       kb.buttonClick()
                       kb.reset()
```

**terminal.js 与它的交互收敛为：**
```js
// 事件转发（每个事件一行，无任何键盘逻辑）
wtermWrapper.addEventListener('pointerdown', (e) => sshKb.handlePointerDown(e));
wtermWrapper.addEventListener('pointermove', (e) => sshKb.handlePointerMove(e));
wtermWrapper.addEventListener('pointerup',   (e) => sshKb.handlePointerUp(e));
window.visualViewport?.addEventListener('resize', () => sshKb.handleViewportChange());
kbBtn.addEventListener('click', () => sshKb.buttonClick());
// IME proxy 事件
proxy.addEventListener('focus', () => sshKb.handleImeFocus());
proxy.addEventListener('blur',  () => sshKb.handleImeBlur());
proxy.addEventListener('compositionstart', () => sshKb.handleCompositionStart());
proxy.addEventListener('compositionend',   (e) => sshKb.handleCompositionEnd(e));
```

**terminal.js 删除的代码量（预估）：**
- `mobileKeyboardOpen/UserControlled/keyboardFocusLikely` 及其 43 个写点 → 全部删除
- `updateViewportInsets` 120 行 → 替换为 `sshKb.handleViewportChange()` 一行
- `finalizeKeyboardClose` 80 行 → 删除（intent.js 内部处理）
- `focusMobileStableImeProxy/dismissMobileStableImeProxy` 60 行 → 删除
- `keepMobileAuxImeFocused` 30 行 → 替换为 `sshKb.retainFocus()`
- tap 路径 110 行（terminal.js:10653-10760）→ 替换为 3 行事件转发
- `applyMobileStableKeyboardInset` 40 行 → 替换为 layout.js 单一 CSS 变量更新

**预估 terminal.js 净减少 ~600-800 行键盘相关代码。**

## 关键机制设计

### M1. 手势状态机（gesture.js）

```
状态：idle → touching → (tap|pan|pinch|longpress) → idle
                   ↓
              touching 时记录 startX/startY/startTime/pointerCount
                   ↓
  pointermove: 位移>10px → pan;  pointerCount>1 → pinch
  pointerup:   位移<10px 且 时长<300ms 且 非pinch → tap
  长按时长>500ms 无移动 → longpress
  pan 结束后速度>0.5px/ms → fling（惯性期 300ms 内 tap 被抑制）
```

**只有状态==='tap' 且无 selection 时才允许 open。pan/fling/pinch/longpress 一律拒绝。**
无 timer 猜测：所有判定在 pointerup 时刻基于已收集的数据做出。

### M2. 意图存储（intent.js）

```js
state = {
  intent: 'closed' | 'open',      // 用户意图（唯一可变状态）
  physical: 'closed' | 'open',    // 系统键盘实际状态（只读自 viewport）
  focusOwner: 'terminal' | 'cmd' | null,  // IME 应该给谁
  inset: 0,                        // 当前键盘高度（px）
}
```

**唯一的 intent 变更入口：**
- `open(reason)` — 来自 tap/button/cmd-focus
- `close(reason)` — 来自 button/系统返回/parent reset
- `syncViewport(inset)` — 只更新 physical，不改 intent（除非 system-dismiss 确认）

**43 个写点收敛为这 3 个函数。**

### M3. 布局门（layout.js）

```js
phase: 'closed' | 'opening' | 'open' | 'closing'

gate 规则：
  phase !== 'closed' 时：
    - term.fit() → 排队到 phase==='closed' 后执行
    - term.resize() → 同上
    - scrollTop 非 pin 写入 → 拒绝
    - 唯一允许的 DOM 写：--ssh-kb-inset + .ssh-kb-open class
```

实现：在 `scheduleTerminalResize`/`sendTerminalResize`/scrollTop 写入处加一个检查函数 `sshKbLayoutGate.allowResize()`，一行判断。

### M4. 父页通道（bridge.js）

子页 → 父页只发一种消息：
```js
{ type: 'ssh-kb', phase, intent, inset, tabId }
```
发送时机：phase 变化或 inset 变化 >4px。

父页 app.js：
- 收到消息 → 保存 `{phase, inset}` → 更新 workspace clip
- **删除** `appKeyboardOpen` 独立状态、`reset-mobile-keyboard` 独立判定、独立 hysteresis
- 父页只在自己需要时（切 tab、关面板）发 `{type:'ssh-kb-reset'}`

### M5. CSS 收敛

15 个通道 → 2 个：
- CSS 变量：`--ssh-kb-inset`（键盘高度，px）
- CSS class：`ssh-kb-open`（在 `html` 上）

所有键盘相关布局（workspace clip、aux bar 位置、terminal 高度、IME proxy 位置）只读这两个。

---

## 第三部分：实施步骤

### Step 1：新建模块骨架 + 契约测试（不动现有代码）
- 创建 `public/ssh-keyboard/` 目录，4 个文件骨架
- 写 `tests/ssh-keyboard/` 契约测试：手势分类、intent 迁移、layout gate、parent 协议
- **现有代码完全不动，新旧并存**
- 交付：测试全绿的新模块（未接线）

### Step 2：手势状态机（gesture.js）
- 实现 M1 状态机
- 单测覆盖：tap/pan/fling/pinch/longpress/selection 互斥
- 交付：独立可用的手势分类器

### Step 3：意图存储（intent.js）
- 把 `ssh-mobile-keyboard.js` 的 531 行重构为只保留核心 intent 逻辑（~200 行）
- 删除：openHold/physicalLowSince/lastPhysicalAboveCloseAt 等 timer-based 猜测
- 改为：system-dismiss 确认需要「physical closed + 无 editable focus + 无 open 手势在 300ms 内」三个条件同时成立
- 交付：重构后的 intent store + 单测

### Step 4：布局门（layout.js）
- 实现 phase 状态 + gate 函数
- 在 terminal.js 的 `scheduleTerminalResize`、`sendTerminalResize`、scrollTop 写入处插入 gate 检查（各一行）
- 交付：键盘开合期间 resize 被硬阻断的验证

### Step 5：父页通道（bridge.js）
- 实现单一消息协议
- 重写 app.js 的 `keyboard-metrics` handler（~40 行 → ~10 行）
- 删除 app.js 的 `appKeyboardOpen` 独立判定
- 交付：父子页状态一致的验证

### Step 6：接线（terminal.js 重构）
- 按「目标架构」中的事件转发代码替换现有键盘逻辑
- 删除 43 个状态写点、120 行 updateViewportInsets、80 行 finalizeKeyboardClose、110 行 tap 路径
- 保留：`sendMobileStableImeText`/`sendMobileStableControl`（IME 数据通路，与键盘开合无关）
- 交付：terminal.js 键盘相关代码从 ~800 行降到 ~150 行（纯事件转发）

### Step 7：CSS 收敛
- 15 个 CSS 通道 → 2 个
- 删除 `keyboard-open`/`keyboard-settling`/`mobile-keyboard-open`/`ime-active`/`viewport-updating`/`terminal-keyboard-lift`/`cmd-overlay-keyboard` 在 terminal.js 中的所有写入
- CSS 只保留 `html.ssh-kb-open` 和 `var(--ssh-kb-inset)` 的消费端
- 交付：CSS 通道一致性验证

### Step 8：E2E 测试
- Playwright 手机视口测试（关键 10 用例，见 plan 第二版）
- 测试机部署 + 真机验收

### Step 9：清理与合并
- 删除 `ssh-mobile-keyboard.js`、`terminal-surface-controller.js` 中被取代的部分
- 删除 MOBILE_KEYBOARD_PLAN.md / SSH_MOBILE_KEYBOARD.md 旧文档
- cache-bust 更新、commit、推送

---

## 第四部分：验证标准（DoD）

每条对应一个根因：

| 根因 | 验证方法 | 标准 |
|------|----------|------|
| 状态 4 份拷贝 | 代码审查 | terminal.js 中 `mobileKeyboardOpen/UserControlled/FocusLikely` 出现次数 = 0 |
| 3 条打开路径 | 代码审查 | `focus(` 在 keyboard 相关代码中只出现 1 次（intent.js 内） |
| resize 越界 | E2E | 键盘开合 10 次，WTerm cols/rows 不变，scrollTop 无 pin 外变化 |
| 父子不一致 | E2E | 打开键盘，父子页 `.ssh-kb-open` class 同时出现/消失，inset 差 <4px |
| 手势误判 | E2E | pan/fling/pinch/longpress 后键盘不开；tap 后键盘开 |

| 体验 | 验证方法 | 标准 |
|------|----------|------|
| 误开 | 手动 | 滚动终端 30 秒，键盘不弹 |
| 误收 | 手动 | 打开键盘后点正文 10 次，键盘保持 |
| 跳动 | 录屏 | 打开/关闭键盘 5 次，文本无帧间位移 |
| IME | 手动 | 中文拼音输入 20 字，无丢字无重复 |
| 高度抖动 | 录屏 | aux bar 随键盘平滑移动，无跳帧 |

---

## 第五部分：风险

| 风险 | 概率 | 对策 |
|------|------|------|
| Android WebView viewport 数据不可靠 | 高 | 三路信号（vv + virtualKeyboard + focus）投票 |
| iOS 非手势 focus 不弹键盘 | 中 | open 只在 tap/click 同步调用栈内 |
| WTerm fork resize 清空 scrollback | 中 | layout gate 硬阻断，不依赖调用方自觉 |
| 新旧并存期间行为不一致 | 低 | Step 1-5 不接线，Step 6 一次性切换 |
| 删除代码引入新回归 | 中 | 保留旧文件到 Step 9，Step 6 后立即可 git revert |
