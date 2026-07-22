# 移动端底部栏升降判定 + 输入草稿 —— 根因诊断与修复方案

日期：2026-07-22
基线：GitHub main（clone @ 2026-07-22），`public/ssh-keyboard/*`、`public/terminal.js`、`public/app.js`、`public/style.css`
范围：仅 SSH 终端移动端（compact + mobile-stable-input）。所有行号基于当前 clone。

---

# 第一部分：底部栏升降「慢半拍/快半拍/没键盘也乱动」根因

## 0. 当前真实数据流（先对齐事实）

```
用户 tap 终端
  → gesture.js 分类 TAP
  → intent.open()  ── 同时做两件不可逆的事：
       ① state.physical = OPEN（"provisional"，键盘还没升起来）
       ② focusProxy()（聚焦隐藏 textarea）
  → layout.applyIntentState → phase=OPENING
  → applyFacadeChrome → applyMobileStableKeyboardInset(provisionalInset≈230~380, open)
  → CSS: .terminal-page height = calc(100% - var(--ssh-kb-inset))   ← 页面立刻缩小
  → 子页 postMessage ssh-kb {intent:open, inset:provisional}
  → 父页 reduceParentKeyboardMessage → applyTerminalWorkspaceKeyboard
       → 父页自己 measureParentKeyboardTop()（此时键盘还没升，测到 0）
       → 走 'provisional' 分支：估 32% 屏高
       → applyParentIframeShellToKeyboard：!important 裁 iframe 高度
       → postParentShellManaged(open, shellH) 回子页
  → 子页 keyboard-overlap handler：writeSshKbPageGeometry(exact=0, open=true)
       + kb._intent.syncViewport({inset: parentInset(估)})
  → 键盘真正升起（300~500ms 后）→ 父页 visualViewport.resize
  → startSshKbAlignLoop rAF 循环：每帧量键盘顶、重裁 iframe、每 32ms postMessage
  → 子页每帧收到 keyboard-overlap → writeSshKbPageGeometry + syncViewport + applyFacadeChrome
```

关闭方向对称，但有 5 个独立"关闭判定"互相竞争（见 R4）。

## R1. "快半拍"：provisional（估算）inset 直接驱动布局

**证据**
- `ssh-keyboard/index.js:167-180` `provisionalInset()`：没有真实高度时估 `baseline*0.33`，clamp 230~380。
- `ssh-keyboard/intent.js:159-163`：`open()` 里 `if (state.physical !== Intent.OPEN) state.physical = Intent.OPEN;` —— 注释自认 "Provisional physical open"。**键盘尚未升起，physical 已判定为 OPEN。**
- `terminal.js:8557+` `applyMobileStableKeyboardInset` 收到 ≥80 的 inset 就 debounce 64~96ms 后写 `--ssh-kb-inset`，`.terminal-page` 高度立刻按估算值缩小。
- `app.js:3228-3234`：父页同样有 provisional 分支（`layoutHeight*0.32`，260~360），且**父子各估各的**（子 33%/230-380，父 32%/260-360），两个估算值不一致 → 先跳一次估算高度，键盘真升起后再跳到真实高度 = 两段跳。

**后果**：点击后页面先按错误高度缩一次（快半拍），键盘到位后再修正（跳第二次）。键盘升起动画期间 align-loop 每帧重裁 iframe，高度连续抖。

## R2. "慢半拍"：关闭方向 5 个串联 debounce/确认窗

关闭一个事件要穿过：
1. 父页 align-loop：`sshKbParentLowSince` 持续低 **100ms** 才判关（`app.js:3158-3162`）；
2. 父页 message handler：`_closeDebounce` **120ms**（`app.js:7649-7652`）；
3. 子页 intent.syncViewport：`dismissConfirmMs` **220ms** 连续低 inset（`intent.js:33`）+ `openGuardMs` 280ms 守卫；
4. 子页 `parent-layout-close-settle` 再 **220ms**（`terminal.js:2160-2175`）；
5. 子页 proxy blur 后的 `[80,200,420,680]ms` 四轮 `updateViewportInsets`（`terminal.js:9110-9116`）。

**最坏路径 100+120+220+220 ≈ 660ms**，且任何一环没触发（比如 focus 还粘着，见 R3）就整条链停摆。这就是"键盘都回去了，底部栏还悬在半空"。

## R3. "键盘回去了/没呼出过也改位置"：focus-hold 死锁 + provisional 无失效期

**证据 A（回去后不落下）**：`intent.js:296-303` —— 只要 `hasEditableFocus`（proxy textarea 还聚焦），syncViewport **永远返回 focus-hold，physical 强制 OPEN**。Android 上用户用返回键/手势收起键盘后，proxy 的 DOM focus 通常还保留 1~数秒（[KNOWN] Android Chrome 行为：IME 隐藏不必然 blur focus element）。于是 intent 永远 open → 页面永远缩着。现有补丁 `facade-physical-zero`（`terminal.js:9580-9590`）用 `measureImeChromeBottom()<40` 兜底，但在 `overlaysContent=true`（`terminal.js:9688` 主动开启）下 visualViewport 恒不缩 → measured 恒 0 → 这个兜底**每次都会误触发**，把"键盘刚升起、vv 还没来得及报"的正常瞬间也当成关闭 → 开/关抖动。

**证据 B（没呼出过也缩）**：provisional physical OPEN 没有失效期。若键盘因任何原因没升起（iOS 非手势栈 focus、IM被禁用、WebView 抢焦点失败），`hasEditableFocus=true` 使 focus-hold 永久成立 → 页面永久缩 280px，键盘压根不存在。代码里**没有任何"open 后 N ms 内没拿到真实高度就撤销 provisional"的逻辑**。

## R4. 双几何权威：父裁 iframe 与子缩 page 叠加

- 父页 `applyParentIframeShellToKeyboard`（`app.js:2986+`）用 `!important` 把 iframe/window-body 高度裁到键盘顶，**然后** `postParentShellManaged` 告诉子页 `keyboardOverlap: 0`（"我已裁好，你不用再缩"）。
- 但子页收到后（`terminal.js:2092-2093`）`exact = parentShellManaged ? 0 : overlap` → `writeSshKbPageGeometry(0, true)` —— inset 写 0，**class `ssh-kb-open` 却仍打开**；同时 `syncViewport({inset: parentInset})` 又把 intent.inset 设成屏幕级高度（280+）。
- 于是 `applyFacadeChrome` 下一 tick 读到 `inset>=64` → 再次 `applyMobileStableKeyboardInset(280, open)` → `.terminal-page` 在**已经被裁小的 iframe 里再缩 280px** → 双重收缩 = 下半屏黑/空白（你 memory 里 kb-close1 修的就是这个的关闭方向，但打开方向仍残留）。
- 子页没有保存 `parentShellManaged` 标志位（grep 确认只有 handler 局部变量），下一个 tick 就忘了"父已托管"。

## R5. 阈值五套，各判各的

| 位置 | 开阈值 | 关阈值 |
|---|---|---|
| `intent.js` DEFAULT_THRESHOLDS | 80 | 12 |
| `terminal.js getViewportKeyboardMetrics` | min260~max110 动态 / layoutOpen 时 8 | 8 |
| `bridge.js reduceParentKeyboardMessage`（父页） | 80 | 12 |
| `app.js applyTerminalWorkspaceKeyboard` | 64 | <40 |
| `terminal.js applyMobileStableKeyboardInset` | 80（<80 归 0） | — |

同一个 inset=70：子页 metrics 说"没开"，intent 说"没开"，父页 reduce 说"没开"，但父页 apply 说"开了"（≥64）。边界值附近父子结论相反 → 底部栏在临界高度反复横跳。

## R6. 事件风暴：一次开/关触发几十次全链路重入

- proxy focus → `[60,160,320,560]` ms 四轮 `updateViewportInsets`（`terminal.js:9096`）；blur → `[80,200,420,680]` 四轮（`terminal.js:9110`）。
- 父页 `scheduleCompactKeyboardViewportCheck` → `[0,60,140,260,420,700]` 六轮（`app.js:408-412`）；`scheduleTerminalLayoutStabilize` → `[0,80,220,520]` 四轮 × 每轮再 postMessage `layout-stabilize`。
- align-loop 开着时每 32ms 一条 `keyboard-overlap`。
- 每条消息在子页都走 `writeSshKbPageGeometry`（同步 reflow：`measureSshKbChromeHeights` 两次 getBoundingClientRect）+ `syncViewport` + `applyFacadeChrome` + `scheduleSshKbGeometryFit`。

这些"多相位轮询"是旧架构（SSH_KEYBOARD_INVESTIGATION.md B6 自己承认的补丁循环）的残留——它们的存在让 R2/R3 的时序问题**概率化**：有时某轮补救成功（看起来正常），有时补救轮先于真实事件到达（快半拍），有时全部被 focus-hold 挡住（慢半拍/卡死）。

## R7. 底部栏本身是 in-flow，页面缩高 = 栏移动；两条动画曲线不同步

`style.css:13643+`（FINAL keyboard chrome lock）：`.terminal-page` 高度 `calc(100% - inset)`，栏 `position: static`（in-flow）。栏的位置完全由页面高度决定——**页面高度是唯一执行器，但它由 R1~R6 的混乱判定驱动**。同时 `.terminal-input-panel` 还有一条独立的 `transform: translateY(calc(-1 * var(--keyboard-inset)))` + 0.22s transition（`style.css:4822-4827`），与页面高度变化（无 transition / 不同时长）叠加 → 开合瞬间栏有视差跳动。

---

# 第二部分：底部栏升降修复方案

## 设计原则（对应根因）

| 根因 | 对策 |
|---|---|
| R1 provisional 驱动布局 | 布局只认真实测量高度；provisional 降级为"占位意图"，不写几何 |
| R2 串联 debounce | 关闭走**单一确认窗**，其余全部删除 |
| R3 focus-hold 死锁 | focus 不再是"物理开着"的证据；provisional 加失效期 |
| R4 双权威 | 几何只由父页执行（shell-managed 唯一模式），子页 inset 通道永久为 0 |
| R5 五套阈值 | 全链路只留一套（intent 的 80/12），其余删 |
| R6 事件风暴 | 删多相位轮询；align-loop 只在开合过渡期跑，带自动停止 |

## F1. 单一几何模型：父裁 iframe 是唯一执行器

**子页永不缩页面。** 删除 `applyMobileStableKeyboardInset` 的 OPEN 分支对 `--ssh-kb-inset` 的写入；`--ssh-kb-inset` 在 shell-managed 模式下恒 0（父页 `app.js:3321` 已经在写 0，子页对齐即可）。底部栏随 iframe 底边（= 键盘顶）自然移动，因为栏是 in-flow 的。

子页保留的唯一 DOM 写：`html.ssh-kb-open` class（供 chrome 样式切换：static 栏、禁滤镜等），来源只有一个——`keyboard-overlap` 消息的 `keyboardOpen` 字段。

**落地改动**
- `terminal.js`：`keyboard-overlap` handler 里删除 `writeSshKbPageGeometry(exact, true)` 的 inset 写入，改为 `setSshKbShellOpen(open)`（只 toggle class + 触发一次 stick-bottom）。保存 `_sshKbShellManaged = true` 持久标志，`applyFacadeChrome` 在 shellManaged 下**永不**调用 `applyMobileStableKeyboardInset(inset>0)`。
- `applyFacadeChrome` 简化为二态：shellManaged → 只看 parent 的 open/close 消息；standalone（terminal.html 直接打开，无父页）→ 才用本地 vv inset。两条路径互斥，不再混合。
- 删除 `facade-retain-parent`/`parentFreshOpen`/`_sshKbParentGeomAt` 整套"保留父几何"逻辑（`terminal.js:9595-9610`）——shell-managed 下没有要保留的东西。

## F2. 打开时序：意图先行、几何跟随、一次到位

```
tap (用户手势栈内)
  → intent.open()            // 只改 intent，physical 保持 CLOSED
  → focusProxy()             // 同栈同步调用（iOS 要求）
  → 子页发 ssh-kb {intent:open, inset:0, phase:'opening'}
  → 父页收到：进入 "awaiting-physical" 状态（不裁、不估）
  → 父页 vv.resize / vk.geometrychange 首次 inset ≥ 80
  → 父页一次性裁 iframe 到真实键盘顶 + postParentShellManaged(open, shellH, inset)
  → 子页 toggle ssh-kb-open class（栏随 iframe 底边移动）
```

- **删除子页 `provisionalInset()` 和 intent.open 里的 provisional physical**（`intent.js:159-163`）。`physical` 只能由真实测量（父页 overlap 消息 / standalone 的 vv）置位。
- 键盘升起动画期间父页 align-loop 持续跟裁（保留现有 rAF loop），但**只在 `awaiting-physical → settled` 过渡期 + 键盘高度变化 >4px 时** postMessage；高度稳定即停（现有 loop 只在低 100ms 后停，改为"高度稳定 300ms 且子页已确认"也停）。
- 栏的视觉：iframe 底边被父页每帧钉在键盘顶，栏 in-flow 贴 iframe 底 → 栏与键盘**零视差**同升同降。这比子页自己缩页面+独立 transition（R7）严格更同步。

**代价（诚实说明）**：点击到栏开始移动，要等键盘升起第一帧 vv 事件（~100-200ms）。这是物理正确的延迟——键盘没升起前没有高度可对齐。用 provisional 估算抢跑正是"快半拍"的来源。若嫌这段空窗期栏还在屏幕最底（键盘从下方盖上来），可选补偿：awaiting-physical 期间给 `.terminal-page` 加 `ssh-kb-opening` class 做一个 120ms 的轻微 opacity/placeholder 提示，但**不动几何**。

## F3. 关闭时序：单一确认窗，其余全删

关闭只认一条链：

```
父页测量 inset < 12 连续 160ms（唯一确认窗）
  → 父页恢复 iframe 全高（uncrop）+ postParentShellManaged(open:false)
  → 子页 keyboard-overlap(close)：
       ① 移除 ssh-kb-open class（同步，无 transition 延迟）
       ② intent.close('parent-physical-close')   ← 唯一 close 入口（系统收起方向）
       ③ stick-bottom 一次（仅当关闭前处于跟随态）
```

**删除**（全部是 R2 的串联窗）：
- `intent.js` 的 `dismissConfirmMs` 连续低判定 → syncViewport 不再自动 close（system-dismiss 改由父页 overlap(close) 驱动；standalone 模式保留一个 160ms 窗作为唯一例外）。
- `terminal.js` `parent-layout-close-settle` 220ms 定时器（2160-2175）。
- proxy blur/focus 后的 `[60,160,320,560]`/`[80,200,420,680]` 轮询（9096、9110）→ 改为 blur 时**一次** `handleViewportChange`，不再轮询。
- 父页 `_closeDebounce` 120ms → 保留但缩到 0（align-loop 的 160ms 已是唯一去抖）。
- `scheduleCompactKeyboardViewportCheck` 六相位、`scheduleTerminalLayoutStabilize` 四相位里所有键盘相关重入 → 删除键盘分支（layout-stabilize 只保留非键盘用途）。

**关键修复（R3）**：`intent.syncViewport` 里删除 `hasEditableFocus → 强制 physical OPEN` 的 focus-hold（`intent.js:296-303`）。focus 只用于"是否该 refocus proxy"，**永远不作为物理高度的证据**。父页说关了（overlap close）→ 无条件 `intent.close`，不管 proxy 是否还聚焦；close 时若 proxy 仍聚焦则 blur 它（现有 `close()` 已 blur）。

## F4. provisional 失效兜底（防"没呼出过也改位置"）

`intent.open()` 记录 `lastOpenAt`。新增：open 后 **1200ms** 内从未收到真实高度（父页 overlap-open 且 inset≥80，或 standalone vv≥80）→ 自动 `close('open-timeout:no-physical')` + blur proxy。
- 正常路径：键盘 300~500ms 升起，父页 100ms 内确认 → 超时永不触发。
- 键盘没升起：1.2s 后静默复位，页面全高，无任何几何残留。
- 超时值取 1200ms 是因为最慢的 Android IME 冷启动（首次唤起输入法进程）实测 ~800ms（[INFERRED]，需真机标定；做成 thresholds 可配）。

## F5. 阈值收敛为一套

全链路只用 `intent.js` 的 `{openInset: 80, closeInset: 12}`：
- 删 `getViewportKeyboardMetrics` 里的动态 `openThreshold`（`terminal.js:1609-1613`），standalone 也用 80/12。
- 删 `app.js` 的 64/40（`applyTerminalWorkspaceKeyboard` 的 `keyboardOpen = childOpen && effectiveInset >= 64` 与 low-40 判定），父页测量层只报原始 inset，判定归 reduce（80/12）。
- `applyMobileStableKeyboardInset` 的 `>=80 归 0` 量化保留（standalone 路径）。

## F6. 删事件风暴源

- align-loop：高度稳定 300ms 自动停（现仅低 inset 停）；postMessage 节流从 32ms 提到 80ms（[INFERRED] 80ms 内键盘高度变化 <1 行，肉眼不可辨）。
- 子页 `keyboard-overlap` handler：inset 变化 <4px 且 open 状态不变 → 直接 return（现有 signature 去重在父页，子页没有）。
- 删 `writeSshKbPageGeometry` 里的双次 `measureSshKbChromeHeights`（每帧两次强制 reflow）→ 栏高缓存 + ResizeObserver 失效。

## F7. 动画收尾

- `.terminal-input-panel` 的独立 `translateY(-keyboard-inset)` transition（`style.css:4822`）删除——shell-managed 下 inset 恒 0，这条规则只会和 iframe 裁高打架。
- iframe 裁高不加 CSS transition（父页每帧跟裁，本身就是动画）；uncrop 恢复全高时也不加（一帧到位，栏落底与键盘消失同帧）。

## 验证矩阵（DoD）

| # | 场景 | 通过标准 |
|---|---|---|
| K1 | 点终端开键盘 ×10 | 栏与键盘同帧移动（录屏逐帧：栏底与键盘顶偏差 ≤2px 全程）；无两段跳 |
| K2 | 返回键收键盘 ×10 | 键盘消失后 ≤160ms 栏落底；无悬空残留 |
| K3 | 键盘升起中点返回键（打断） | 1.2s 超时兜底复位，页面全高 |
| K4 | 快速开关 ×5（<800ms 间隔） | 状态收敛，最终态与最后一次操作一致 |
| K5 | 切后台再回前台（键盘被系统杀） | 恢复后 ≤1s 内栏落底 |
| K6 | 点 cmd 顶栏输入 | liftMode=none，页面/栏完全不动（现有行为保持） |
| K7 | 滚动/长按/双击/拖选 ×30s | 键盘不误开（gesture 状态机已保证，回归用） |
| K8 | 中文拼音输入中收键盘 | 草稿不丢（见第二部分），栏正常落底 |
| K9 | standalone（terminal.html 直开，无父页） | vv 路径独立工作，开/关正确 |
| K10 | overlays-content 设备（vv 恒 0） | 父页 virtualKeyboard.boundingRect 路径工作；子页永不自行缩页面 |

---

# 第三部分：输入草稿（回车前绿色字）的问题与方案

## 现状（事实）

- 可打印字符**不进 PTY**，累积在宿主 JS 变量 `mobileLocalDraft`（`terminal.js:1049`），经 `term.setLocalDraft()` 交给 wterm renderer，在**格子内从光标处绘制**覆盖层（`wterm renderer.ts:298-405`，fg=14 青色斜体——你看到的"绿色"）。
- Enter 时 `flushMobileLocalDraft` 一次性 `sendData(body + '\r')`。
- Backspace 先吃草稿；方向键/Tab/Ctrl 序列先 flush 草稿再发控制序列（`terminal.js:8941-8944`）。

## 这个设计的固有缺陷（不是实现 bug，是模型 bug）

| # | 缺陷 | 说明 |
|---|---|---|
| D1 | **远端看到的和你看到的不一样** | 你在打 `rm -rf /tmp/x`，远端 shell 的行缓冲区里什么都没有。此时任何远端事件（异步输出、`PS1` 重绘、另一会话写同一 tty、`\x1b[6n` 光标查询）都会把提示符重画一遍——你的草稿是 DOM 覆盖层，重画后光标位置/行内容变了，草稿还画在旧光标处 → 错位/叠字。 |
| D2 | **行编辑全部失效** | readline/zsh 的 Tab 补全、`Ctrl-R` 历史搜索、`Ctrl-A/E`、fish 自动建议——全部依赖"字符已在 PTY 行缓冲"。草稿模式下 Tab 的语义被改成"先 flush 再发 \t"（`terminal.js:8943`）：补全看到的是刚到的整行，时序上 readline 可能还没处理完 → 补全乱。这是**协议级错误**，无法在草稿模型内修复。 |
| D3 | **宽字符/emoji 宽度不一致** | 草稿渲染"每个 JS codepoint 占 1 cell"（`renderer.ts:356` 注释自认），但远端 echo 回来后 xterm 按 Unicode 宽度画（CJK 2 列）→ 回车瞬间整行跳一下宽度。 |
| D4 | **粘贴语义被篡改** | 多行粘贴被"规范化进草稿"，尾部换行才 flush（`terminal.js:8878-8886`）。用户粘贴一段脚本，期望逐行立即执行或整段进缓冲——实际进了一个本地气泡，一个误触 Enter 把整段一次性灌进 PTY；粘贴内容里的 `\n` 与远端 shell 的 bracketed-paste 处理完全脱节。 |
| D5 | **草稿易失** | 切 tab、页面刷新、WS 断线重连 → `mobileLocalDraft` 清零，用户打了一半的命令消失。PTY 行缓冲里也没有（从没发过）。 |
| D6 | **与滚动/光标钉位耦合** | 每次 paint 草稿都触发 `scheduleEnsureActiveLineAboveChrome`（`terminal.js:8782`），草稿多行增长时不断重算 grid shift（你 memory 里的 `--term-active-line-shift`）→ 打字时页面抖。 |
| D7 | **三路输入去重靠时间窗** | proxy beforeinput / input fallback / wterm-onData 都可能送同字符进草稿，靠 `mobileImeLastSent` 80ms 内容去重（`terminal.js:8845`）——内容相同但合法的重复输入（快速打两个 'a'）会被吞。 |

## 为什么当初会选草稿（公平地说）

memory 记录：移动端每个 beforeinput 立即 sendData → 远端 echo → xterm write → 旧渲染器 markAllDirty 全行重绘 + chrome pin → 每键一次全闪。**草稿是对"每键全量重绘"的规避，不是对输入模型的修正。** 现在渲染层已经是 xterm-bridge + wterm 单元格 diff（你 memory 2026-07-20 P1-2），逐键 echo 的重绘成本已不存在——草稿存在的前提已消失。

## 方案对比

### 方案 A（推荐）：回归标准终端模型 —— 逐键即时进 PTY，草稿只留给 IME 组合期

```
可打印字符 → beforeinput → 立即 sendData(ch) → 远端 echo → xterm buffer → 单元格 diff 重绘
IME 组合期（compositionstart→end）→ 组合文本显示在 proxy 原位（浏览器原生行为）→ compositionend 一次性 sendData(commitText)
Enter/Backspace/控制序列 → 直接 sendData，无本地状态
```

**这就是 Termux / a-Shell / Blink / xterm.js 移动端的标准做法**（[KNOWN] Termux 即逐键过 PTY；xterm.js 官方 mobile 分支同）。
- D1 消失：你看到的就是远端行缓冲，任何重绘都自洽。
- D2 消失：Tab 补全/Ctrl-R/方向键编辑全部恢复正常 readline 语义。
- D3 消失：宽度永远由 xterm 统一计算。
- D4 消失：粘贴直接进 PTY（保留 bracketed-paste 包裹）。
- D6 消失：无草稿 paint，无每键 chrome 重算。
- D7 消失：无本地缓冲，无去重时间窗。
- **唯一保留的本地态**：composition 期间的未提交文本——这由浏览器 IME 管线自己管（proxy textarea 的 value），compositionend 才进 PTY。中文输入体验不变（组合期不逐拼音提交）。

**需要验证的风险（诚实清单）**：
1. 高延迟链路（>300ms RTT）逐键 echo 有可感滞后——但草稿方案同样要等回车才见远端结果，且 SSH 用户已习惯 echo 延迟；可加本地可选开关 `localEcho: off|on`（on = 保留草稿，给极端延迟用户）。
2. 每键一次 WS 帧：吞吐可忽略（1 字节/帧，WS 开销 ~6 字节），xterm 单元格 diff 只重绘 1 cell。需实测确认旧"全行闪"确实不再现（渲染层已换，理论上不会）。
3. `mobileImeLastSent` 去重窗删除后，确认 beforeinput/input 双路不会重复提交——做法：**只保留 beforeinput 一条路径**，input fallback 仅在 `!e.defaultPrevented` 且 beforeinput 未处理时兜底（现有代码已 preventDefault，兜底路径实际永不触发，可直接删）。

### 方案 B（折中，若 A 的延迟实测不可接受）：草稿降级为纯视觉回声，语义全走 PTY

逐键即时 sendData（同 A），但同时在光标处画一个"本地预测回声"覆盖层，远端 echo 到达后逐字符比对撤销覆盖层。即 VSCode terminal 的 type-ahead 预测。**复杂度远高于 A**（要做预测与 echo 的对齐、分歧回滚），只在 RTT 大到 A 不可用时才值得。

### 方案 C（维持现状修补）：不推荐

D1~D5 是模型缺陷，修补（比如给草稿加远端重绘同步）等于在实现一个劣化的方案 B，工作量更大且永远有边角。

## 方案 A 落地步骤

1. **删草稿状态机**：`mobileLocalDraft` / `mobileLocalDraftComposing` 变量、`appendMobileLocalDraft` / `backspaceMobileLocalDraft` / `flushMobileLocalDraft` / `paintMobileLocalDraft`（`terminal.js:8764-8850`）。
2. **`sendMobileStableImeText` 恢复直通**：删除 `isMobileStableInputMode()` 分支里的草稿拦截（`terminal.js:8874-8888`），可打印字符直接走现有下半段的 `sendData` 路径（那里本来就完整，只是被草稿分支短路了）。
3. **`sendMobileStableControl` 删草稿前置**：Enter 直接发 `\r`（删 `flushMobileLocalDraft` 调用，`terminal.js:8927-8929`）；Backspace 直接发 `\x7f`（删 `backspaceMobileLocalDraft` 优先，`terminal.js:8931-8933`）；删"控制序列前先 flush 草稿"（`terminal.js:8941-8944`）。
4. **wterm-onData 路径**（`terminal.js:11161-11174`）：删草稿路由，恢复直通 `sendData`。
5. **组合期**：`compositionupdate` 不再写 `mobileLocalDraftComposing`，让 proxy textarea 自己显示组合文本（proxy 锚定在光标处，`anchorImeProxyToCursor` 已存在）；`compositionend` 把 `e.data` 一次性 `sendData`（现有 `appendMobileLocalDraft(text, 'mobile-ime-composition')` 改为 `sendData`）。需要把 proxy 从 `opacity:0.01` 改为组合期可见（加 `.composing` class 时 opacity:1 + 真实字号），否则组合文本不可见。
6. **渲染器**：`renderer.setLocalDraft` 保留 API 但 terminal.js 永不调用（或一并删 wterm fork 里的 draft overlay 代码，`renderer.ts:298-405` + `_buildDraftOverlay`——建议删，减少一条渲染分支）。
7. **滚动契约**：逐键输入走 `terminal-scroll-policy` 的 `scrollOnInput`（S2，默认 true）——已有，无需新写。删 `appendMobileLocalDraft` 里的 `cancelTerminalBottomFollow` 特殊处理。
8. **测试**：`tests/mobile-local-draft-contract.test.mjs` 重写为 `mobile-direct-input-contract.test.mjs`：断言 beforeinput('a') → sendData('a') 恰好一次；compositionend('你好') → sendData('你好') 一次；Enter → '\r' 一次；无本地缓冲残留。

## 验证矩阵（DoD）

| # | 场景 | 通过标准 |
|---|---|---|
| I1 | ASCII 连打 50 字符 | 无丢字无重复；每字符 echo 延迟 = 网络 RTT（console 计时） |
| I2 | 中文拼音输入 20 字 | 组合期文本在光标处可见；commit 后宽度正确无跳变 |
| I3 | Tab 补全（bash/zsh） | 补全正常工作（草稿模式下必坏，这是 A 的杀手验证） |
| I4 | `Ctrl-R` 搜索 + 方向键编辑 | 正常 |
| I5 | 粘贴多行脚本 | 立即进 PTY，bracketed-paste 语义正确 |
| I6 | 打字中远端有异步输出 | 无叠字、无草稿错位（D1 验证） |
| I7 | 高延迟链路（tc netem 300ms，可选） | 可用；若不可接受再评估方案 B |

---

# 第四部分：实施顺序与回归防线

1. **先做第二部分方案 A（输入直通）**——它独立于键盘几何，且删代码多于加代码（净删 ~200 行），先落地可以先消灭 D6 的打字抖动，减少键盘修复的干扰变量。
2. 再做 F1~F7（键盘几何）。顺序：F5（阈值收敛，纯删）→ F3（关闭单链）→ F1（shell-managed 唯一执行器）→ F2/F4（打开时序 + 超时兜底）→ F6/F7（风暴源与动画）。
3. 每步用现有 `tests/ssh-keyboard/` 契约测试框架补对应断言；真机验证按 K1~K10 / I1~I7。
4. cache-bust 统一一个新版本号；部署测试机（103.240.198.233:8089）后先跑 K1~K5 再放开。

## 明确不做

- 不再加任何新的多相位 settle/repair 定时器。
- 不在子页恢复任何本地 rows/cols resize（键盘只裁壳的既定模型保持）。
- 不改选区/复制路径。
- 不改 RDP / noVNC / 编辑器的键盘逻辑。
