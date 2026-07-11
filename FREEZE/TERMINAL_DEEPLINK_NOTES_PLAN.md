# Zephyr SSH 终端稳定性、会话可靠性、Deep Link 与 AI 笔记功能改造方案

> [KNOWN] 审计基线：`Lanlan13-14/zephyr-ssh` `main` / `v1.1.447`，提交 `a2b917ed08a5645d1bc5d400946b2acb76934cdf`。  
> [KNOWN] 对照基线：`@wterm/dom 0.1.9` / `@wterm/core 0.1.9` 实际发布包；`xtermjs/xterm.js` 提交 `8aab310366549d8d865bd8fc4bd509051f2bb2a1` 仅用于分析成熟终端的视口与重排原则；`binaricat/Netcatty` 提交 `56216dbf4779b31b83c170859e93cfe6e6b795b8` 用于 Deep Link 与笔记功能参考。  
> [KNOWN] 产品约束：**继续使用 WTerm，不迁移到 xterm.js，不引入 xterm.js 运行时依赖。**  
> [KNOWN] UI 约束：笔记必须有完整可操作 UI；Deep Link 必须有 UI，并复用现有添加连接窗口的视觉与表单组件。临时连接模式不保存资产，底部业务动作只保留“测试连接”和“连接”。  
> [KNOWN] 审计日期：2026-07-11。  
> [KNOWN] 本文只给出修复与功能实施方案，没有修改业务源码、提交或推送。  
> [INFERRED] 总体结论置信度：HIGH。

---

## 0. 结论先行

### 0.1 必须先修的三个根因

1. [KNOWN] **监控闪烁不是图表动画问题，而是每次统计数据到达都销毁整个监控 DOM 和全部 Chart 实例，再从零创建。** `public/terminal.js:8015-8157` 每次执行 `infoBody.innerHTML = ...`，随后 `initCharts()`；`initCharts()` 又先调用 `destroyCharts()`（`6468-6542`）。服务器默认每秒推送一次（`server.js:4388-4418`）。**置信度：HIGH。**
2. [KNOWN] **自动滚动问题不是 `xterm.js` 的 bug；当前项目没有使用 `xterm.js`，使用的是 `@wterm/dom 0.1.9`，并在外围重写了它的多个私有方法。** 依赖见 `package.json`，初始化见 `public/terminal.js:9739-9788`，猴子补丁见 `8229-8378`。**置信度：HIGH。**
3. [KNOWN] **概率性要求重新登录的第一根因是 HTTP 登录会话仅保存在 Node 进程内的 `Map`。** 服务重启、容器滚动更新、进程崩溃或多实例负载分流都会让仍在浏览器 Cookie 中的 SID 失效；`server.js:89`、`282-296`、`1350-1356` 可直接证明。**置信度：HIGH。**

### 0.2 推荐的最终方案

1. [INFERRED] 监控改为“**订阅时采集 + 稳定 DOM + 原位更新 + 持久 Chart 实例**”，关闭面板后停止动态采集。**置信度：HIGH。**
2. [INFERRED] **保留 `@wterm/dom` / `@wterm/core` 技术栈**，把滚动、视口锚点、resize/reflow 与渲染同步能力修进一个固定版本的 Zephyr WTerm fork（或以 `patch-package` 固化的 vendored patch）；Zephyr 页面只调用稳定公开 API，删除对六个私有入口的运行时猴子补丁、像素级多阶段恢复和文本快照回灌。**置信度：HIGH。**
3. [INFERRED] WTerm 修复目标不是照搬 xterm.js 代码，而是借鉴其“缓冲区/视口单一真源、程序滚动抑制回调、resize 原子事务”的原则，并按 WTerm 的 WASM Bridge + DOM Renderer 架构实现。**置信度：HIGH。**
4. [INFERRED] 登录会话改为 SQLite 持久化、散列 SID、滑动空闲 TTL 与绝对 TTL 双限制；WebSocket Upgrade 和首个 `connect` 消息共享同一份已验证身份。**置信度：HIGH。**
5. [INFERRED] Deep Link 分成两层：Web 版实现 `https://<Zephyr>/open#...` 与可注册的 `web+zephyr:`；系统级 `ssh://`、`telnet://`、`jms://` 由原生壳接管。无论入口为何，最终都打开统一的“临时连接”UI，用户可检查/修改参数，只能“测试连接”或“连接”，不会保存到主机库。**置信度：HIGH。**
6. [INFERRED] 笔记使用独立 SQLite 表，并提供与现有 Zephyr 一致的完整 UI：主导航入口、列表/分组/搜索、Markdown 编辑/预览、连接关联、导入导出；同时给 AI 增加 `note_list/search/get/create/update/delete` 工具。**置信度：HIGH。**

---

## 1. 审计范围与现状

### 1.1 Zephyr 当前终端架构

- [KNOWN] 浏览器终端是 `@wterm/dom 0.1.9`，不是 `xterm.js`；`public/terminal.html:8,18-19` 加载 WTerm CSS/import map，`public/terminal.js:9744-9748` 动态导入 WTerm。**置信度：HIGH。**
- [KNOWN] WTerm 使用 DOM 行渲染，项目同时把 WTerm 根元素当作 Flex 子项、滚动容器和终端本体；`getTerminalScrollElement()` 固定返回 `wtermWrapper`（`public/terminal.js:6564-6566`）。**置信度：HIGH。**
- [KNOWN] SSH 数据通过 `/ssh` WebSocket 以 JSON `{type:'data', data}` 发送；浏览器调用 `term.write(data)`，见 `public/terminal.js:8409-8425`、`9905-9911`。**置信度：HIGH。**
- [KNOWN] 后端以 `ssh2.Client.shell()` 创建 PTY，尺寸由前端 `resize` 消息调用 `sshStream.setWindow()`，见 `server.js:4855-4898`、`4932-4939`。**置信度：HIGH。**
- [KNOWN] 单个 `public/terminal.js` 已约 10,022 行，终端尺寸、移动键盘、滚动、监控、SFTP、Docker 和编辑器逻辑全部耦合在同一模块。**置信度：HIGH。**

### 1.2 对照项目可借鉴点

- [KNOWN] `xterm.js` 用 `buffer.ybase` 表示底部基线、`buffer.ydisp` 表示当前视口，并用 `scrollToBottom()` 令两者一致；见 `src/browser/CoreBrowserTerminal.ts:719-730`。**置信度：HIGH。**
- [KNOWN] `xterm.js` 的 `Viewport` 把 DOM `scrollTop` 映射为 `ydisp * cellHeight`，用 `_isSyncing`、`_suppressOnScrollHandler` 和单次 `queueSync()` 防止程序滚动反向触发用户滚动；见 `src/browser/Viewport.ts:156-218`。**置信度：HIGH。**
- [KNOWN] `xterm.js` 在列数变化时于 Buffer 事务内重排 wrapped lines，并同步调整 `ybase/ydisp`；见 `src/common/buffer/Buffer.ts:323-486`。**置信度：HIGH。**
- [KNOWN] Netcatty 将 Deep Link 拆成操作系统协议注册、主进程排队、渲染器就绪后投递、协议解析和临时主机五层；关键实现位于 `electron/deepLink.cjs`、`electron/main.cjs`、`domain/sshDeepLink.ts`、`domain/telnetDeepLink.ts`、`domain/jmsDeepLink.ts`。**置信度：HIGH。**
- [KNOWN] Netcatty 的笔记是独立 Vault Note 模型，AI 通过 list/get/create/update 操作；见 `domain/notes.ts` 和 `infrastructure/ai/vaultAgentBridgeClient.ts:576-632`。**置信度：HIGH。**

---

## 2. 监控面板画面闪烁分析

## 2.1 可复现的渲染链路

1. [KNOWN] SSH 就绪后 `startStatsPush()` 立即执行一次采集，并设置 `setInterval(pushStats, 1000)`；见 `server.js:4388-4418`。**置信度：HIGH。**
2. [KNOWN] 浏览器收到 `stats` 后进入 `renderStatsSoon()`，下一帧调用 `renderStats()`；见 `public/terminal.js:8192-8201`、`9836`。**置信度：HIGH。**
3. [KNOWN] `renderStats()` 保存旧 `scrollTop`，随后直接替换 `infoBody.innerHTML`；见 `public/terminal.js:8043-8059`。**置信度：HIGH。**
4. [KNOWN] 整棵 DOM 被替换后，代码重新绑定 pager/process 事件，再在下一帧恢复 `scrollTop` 和焦点；见 `public/terminal.js:8129-8148`。**置信度：HIGH。**
5. [KNOWN] 同一次刷新中，旧 Chart 全部 `destroy()`，新 Canvas 和新 Chart 全部创建；见 `public/terminal.js:6468-6542`、`8150-8157`。**置信度：HIGH。**

## 2.2 闪烁的直接原因

### A. 整体 DOM 重建

- [KNOWN] `innerHTML` 会让现有节点、Canvas 位图、输入框、滚动上下文和布局盒全部失效。**置信度：HIGH。**
- [INFERRED] 浏览器至少会经历“旧树移除 → 新树布局 → Canvas 初始化/绘制 → 下一帧恢复滚动”的可见阶段，因此低端手机、WebView 或远程数据变化较大时会表现为白闪、黑闪、卡片抖动或滚动位置瞬移。**置信度：HIGH。**
- [KNOWN] `previousBodyScrollTop` 只在 `requestAnimationFrame` 中恢复，而且只在值非零且当前页为概览时恢复；进程页没有等价的滚动锚点恢复。**置信度：HIGH。**

### B. Chart 实例反复销毁/创建

- [KNOWN] `initCharts()` 每次先 `destroyCharts()`，因此 `updateDoughnut()` 中“无变化不更新”的优化几乎没有意义：对象刚创建，初始值总是 0。**置信度：HIGH。**
- [KNOWN] 折线图每次从 `Array(20).fill(0)` 开始，只追加当前一个样本，历史数据随每轮重建丢失。**置信度：HIGH。**
- [INFERRED] 用户看到的折线并非真实最近 20 个样本，而是“19 个 0 + 当前样本”；这同时是显示正确性 bug。**置信度：HIGH。**

### C. 采集周期和采集内容设计不合理

- [KNOWN] 采集命令每秒重新读取 CPU、内存、磁盘、磁盘速率、网络、CPU 信息、进程、hostname，并尝试访问最多四个公网 IP 服务；见 `stats.js:1-23`。**置信度：HIGH。**
- [KNOWN] 每个公网 IP `curl` 最长 5 秒，首选失败还会再试备用地址；整条远程命令最长超时为 15 秒，见 `stats.js:12-15`、`37-41`。**置信度：HIGH。**
- [INFERRED] 公网 IP、CPU 型号、内核版本和 hostname 是低频静态字段，不应每秒获取；该设计会增加远端进程/SSH channel 压力和统计延迟抖动。**置信度：HIGH。**
- [KNOWN] 监控面板关闭后，后端仍持续采集，只是前端不渲染；资源消耗与用户是否查看无关。**置信度：HIGH。**

### D. CDN 依赖放大不稳定性

- [KNOWN] Chart.js 从 `https://cdn.jsdelivr.net/npm/chart.js` 运行时加载，见 `public/terminal.html:14`。**置信度：HIGH。**
- [INFERRED] 离线、内网 DNS、CSP 或 CDN 波动可让监控首次打开失败；这不是周期闪烁主因，但属于同一功能的可靠性缺口。**置信度：HIGH。**

## 2.3 监控修复设计

### 2.3.1 前端：稳定结构、原位更新

- [INFERRED] `showInfoModal()` 首次打开时只创建一次结构，后续不得再给 `infoBody.innerHTML` 赋完整页面。**置信度：HIGH。**
- [INFERRED] 静态节点使用固定 `data-stat`：`cpu-usage`、`mem-used`、`net-rx`、`host-name` 等；收到样本只改 `textContent`、ARIA value 和 Chart dataset。**置信度：HIGH。**
- [INFERRED] 磁盘列表按稳定 key（filesystem + mountpoint）做 keyed reconcile：新增/删除磁盘时局部增删 card，普通样本只更新该 card。**置信度：HIGH。**
- [INFERRED] Chart 实例在面板生命周期内复用，关闭时可保留，SSH 会话销毁时统一销毁；折线 history 使用固定长度 ring buffer。**置信度：HIGH。**
- [INFERRED] 进程搜索输入期间不得重建 input；进程行按 PID keyed reconcile，并保留焦点、选择范围和滚动锚点。**置信度：HIGH。**
- [INFERRED] 数据到达频率高于绘制能力时只保留最新样本：`pendingStats = latest`，每帧最多更新一次。**置信度：HIGH。**

建议拆分文件：

```text
public/terminal-monitor.js
  createMonitorView(root)
  updateMonitorView(view, stats)
  reconcileDiskCards(view, devices)
  reconcileProcessRows(view, processes, filters)
  createCharts(view)
  updateCharts(view, stats)
  destroyMonitorView(view)
```

### 2.3.2 后端：显式订阅

建议 WebSocket 消息：

```json
{ "type": "stats-subscribe", "intervalMs": 2000, "includeProcesses": false }
{ "type": "stats-subscribe", "intervalMs": 2000, "includeProcesses": true }
{ "type": "stats-unsubscribe" }
{ "type": "stats-request", "includeProcesses": true }
```

- [INFERRED] 默认连接后不启动 stats timer；打开监控时订阅，关闭或 WS detach 时取消。**置信度：HIGH。**
- [INFERRED] interval 服务端限制为 1000–10000 ms，默认 2000 ms，防止恶意或错误客户端制造高频远程命令。**置信度：HIGH。**
- [INFERRED] `includeProcesses` 仅进程页激活或手动刷新时开启。**置信度：HIGH。**

### 2.3.3 采集器拆分

- [INFERRED] `getRemoteStaticStats()`：hostname、uname、CPU 型号/核数、公网 IP、磁盘静态信息；连接后或首次订阅采集，缓存 5–10 分钟。**置信度：HIGH。**
- [INFERRED] `getRemoteDynamicStats()`：`/proc/stat`、`/proc/meminfo`、`/proc/diskstats`、`/proc/net/dev`；每 2 秒采集。**置信度：HIGH。**
- [INFERRED] `getRemoteProcesses()`：仅进程页激活或手动刷新时采集。**置信度：HIGH。**
- [INFERRED] 每个采集请求增加 `sampleSeq`、`sampledAt`、`durationMs`，前端丢弃序号落后的结果。**置信度：HIGH。**
- [INFERRED] 公网 IP 查询失败不应让整轮统计失败，应返回上次缓存或 `N/A`。**置信度：HIGH。**

### 2.3.4 监控验收门禁

- [INFERRED] 连续打开监控 10 分钟，`infoBody` 根子树不发生整树替换，Chart 实例数量稳定。**置信度：HIGH。**
- [INFERRED] 1,000 次样本更新后，事件监听器和 Canvas 数量不增长。**置信度：HIGH。**
- [INFERRED] 进程搜索框持续输入时不丢焦点、不跳光标、不清空输入。**置信度：HIGH。**
- [INFERRED] 概览和进程页各自保留滚动位置。**置信度：HIGH。**
- [INFERRED] 关闭面板后 5 秒内远端不再创建 stats exec channel。**置信度：HIGH。**
- [INFERRED] 折线图显示真实最近 20 个样本，而不是 19 个 0。**置信度：HIGH。**

---

## 3. 自动滚动、狂闪和显示位置错误分析

## 3.1 关键澄清：不是 xterm.js 自身出错

- [KNOWN] Zephyr 没有安装或加载 `@xterm/xterm`；当前终端是 WTerm。**置信度：HIGH。**
- [KNOWN] 代码注释多处称“xterm.js 风格”，但实现不是 xterm 的 Buffer/Viewport 模型，而是项目层基于 DOM `scrollTop` 猜测并补偿。**置信度：HIGH。**
- [INFERRED] 因此把现象归咎于 xterm.js 会误导修复方向；真正的问题是“WTerm 内部滚动状态 + Zephyr 外部滚动状态 + 父 iframe/移动键盘布局状态”三套状态机并存。**置信度：HIGH。**

## 3.2 WTerm 自身语义与项目补丁的冲突

[KNOWN] `@wterm/dom 0.1.9` 的官方实现具有以下行为：

- `write()` 写入前记录 `_shouldScrollToBottom = _isScrolledToBottom()`，然后调度一次 rAF render。
- `_doRender()` 渲染后，如果之前贴底则 `_scrollToBottom()`；若无 scrollback 则可能把 `scrollTop` 设为 0。
- `_scrollToBottom()` 把最大滚动距离按 row height 向下取整。
- `autoResize:false` 时 `_lockHeight()` 给根元素写入 `rows * rowHeight` 的 inline height。

[KNOWN] Zephyr 随后又覆写 WTerm 的：

```text
_scrollToBottom
_isScrolledToBottom
write
resize
_doRender
_scheduleRender
```

见 `public/terminal.js:8229-8378`。**置信度：HIGH。**

[INFERRED] 这不是稳定扩展点：任一 WTerm 版本变更、私有字段行为变化或渲染时序变化，都可能让补丁失效。**置信度：HIGH。**

## 3.3 同一批输出触发多轮互相取消的滚动

单次 `writeTerminalData()` 可能经过：

1. [KNOWN] `writeTerminalData()` 写后调用 `scheduleTerminalBottomFollow('terminal-data')`，默认安排 7 个 phase：0/32/80/160/280/420/680ms；见 `public/terminal.js:6941-6954`、`8423-8425`。**置信度：HIGH。**
2. [KNOWN] patched `term.write()` 再安排 `write-follow` 的 7 个 phase；见 `8294-8305`。**置信度：HIGH。**
3. [KNOWN] patched `_doRender()` 再安排 `render-follow` 的 4 个 phase；见 `8333-8359`。**置信度：HIGH。**
4. [KNOWN] patched `_scheduleRender()` 双 rAF 后再安排 `scheduled-render-follow` 的 3 个 phase；见 `8363-8373`。**置信度：HIGH。**
5. [KNOWN] 每个新的 schedule 会取消上一批 timers 并创建新批次。**置信度：HIGH。**

- [INFERRED] 这些 phase 跨越多个布局与绘制帧；当 `scrollHeight` 因新 DOM 行、字体测量、滚动条出现、容器尺寸或软键盘变化而变化时，不同 phase 会算出不同目标，形成上/下抖动和闪烁。**置信度：HIGH。**
- [INFERRED] “多次补偿更稳”在这里是反效果；它把一次原子视口更新变成持续 680ms 的竞争窗口。**置信度：HIGH。**

## 3.4 ResizeObserver 自反馈

- [KNOWN] 一个 ResizeObserver 负责终端网格 resize，观察 `wtermWrapper` 和 `terminalContainer`；见 `public/terminal.js:2109-2120`。**置信度：HIGH。**
- [KNOWN] 另一个 ResizeObserver 负责自动跟随，观察 `wtermWrapper` 和 `.term-grid`；见 `public/terminal.js:7451-7463`。**置信度：HIGH。**
- [INFERRED] WTerm render 改变 `.term-grid` 高度 → observer 请求滚动 → `scrollTop` 改变/滚动条状态改变 → 可用宽度或布局改变 → grid resize/reflow → 再 render，构成反馈环。**置信度：HIGH。**
- [KNOWN] CSS 使用 `scrollbar-gutter: stable`（`public/style.css` 终端容器段），滚动性变化会保留 gutter；同时代码又实现自定义滚动条状态。**置信度：HIGH。**
- [INFERRED] 在临界列宽处，滚动条/gutter 和 padding 的宽度差可令测量结果在相邻列数之间振荡，触发反复 reflow。**置信度：MED。**

## 3.5 像素位置不能代表重排后的语义位置

- [KNOWN] `restoreMobileStableScrollTop()` 保存旧 `scrollTop` 像素值，并在立即、下一帧、80/180/360ms 重复写回；见 `public/terminal.js:7180-7211`。**置信度：HIGH。**
- [KNOWN] 当显示宽度改变时，长行会重新折行，历史总行数和每个逻辑行对应的物理行都会改变。**置信度：HIGH。**
- [INFERRED] 将旧像素值直接写回新布局不能保持同一文本锚点，只能保持“距顶部多少像素”；所以电脑分屏、窗口大小变化和手机旋转都会出现显示位置错误。**置信度：HIGH。**
- [KNOWN] xterm.js 的做法相反：先在 Buffer 内重排 wrapped lines，再在同一事务调整 `ydisp/ybase`，最后由 Viewport 派生 DOM scrollTop。**置信度：HIGH。**

## 3.6 文本快照“修复”会破坏终端状态

- [KNOWN] Zephyr 检测到所谓文本回归后，会调用 `bridge.init(cols, rows)` 清空终端，再把普通文本用 `writeString()` 灌回；见 `public/terminal.js:1945-1974`。**置信度：HIGH。**
- [KNOWN] 判定依据是文本长度、多重集缺失和顺序反转等启发式规则。**置信度：HIGH。**
- [INFERRED] 合法的 clear screen、TUI 重绘、回车覆盖、进度条、alternate screen、ANSI 光标移动都可能被误判为“回归”。**置信度：HIGH。**
- [INFERRED] 回灌纯文本会丢失颜色、属性、光标、wrapped 标记、alternate screen、OSC/DEC mode 和应用状态，并制造一次完整闪屏。**置信度：HIGH。**
- [INFERRED] 该机制必须删除，不能作为 WTerm 修复后的兜底。**置信度：HIGH。**

## 3.7 显示范围改变时的额外竞争

- [KNOWN] 父页面在窗口 resize 时可能重建 terminal workspace；见 `public/app.js` 的多个 `window.resize` 监听和 `renderTerminalTabs()` 调用。**置信度：HIGH。**
- [KNOWN] iframe 端又在 visibility/focus/parent layout 消息后分 0/60/160/360/720/1200ms 六阶段执行 layout repair；见 `public/terminal.js:9588-9607`。**置信度：HIGH。**
- [INFERRED] 父层窗口布局、iframe 尺寸、WTerm resize、PTY `setWindow`、远端应用重绘和自动滚动并非同一事务，因此显示范围改变时尤其容易放大竞争。**置信度：HIGH。**

## 3.8 正确修复：继续使用 WTerm，并修复 WTerm 的公开视口能力

### 3.8.1 技术路线与依赖约束

- [KNOWN] 产品明确要求继续使用 WTerm，因此本项目**不迁移到 xterm.js，不安装 `@xterm/xterm`，不引入 xterm addon，也不增加双终端引擎开关**。**置信度：HIGH。**
- [KNOWN] 当前发布版 `@wterm/dom 0.1.9` 的滚动与 resize 能力不足，而 Zephyr 在 `public/terminal.js` 运行时覆写六个私有入口，已形成不可控竞争。**置信度：HIGH。**
- [INFERRED] 最终方案应建立 **Zephyr WTerm 固定分支/本地 fork**：以 `@wterm/dom 0.1.9`、`@wterm/core 0.1.9` 为基线，把缺失能力直接修进 WTerm 源码并补测试，再由 Zephyr 只调用公开 API。**置信度：HIGH。**
- [INFERRED] fork 可以继续发布为内部固定包名（例如 `@zephyr/wterm-dom`、`@zephyr/wterm-core`），也可以放入仓库 `vendor/wterm-zephyr/` 作为 workspace/file dependency；不应在 Docker 构建时临时 sed node_modules，也不应保留页面运行时 monkey patch。**置信度：HIGH。**
- [INFERRED] `package-lock.json` 必须锁定 WTerm fork 的精确提交/版本和产物哈希。**置信度：HIGH。**

建议目录：

```text
vendor/wterm-zephyr/
  packages/core/                 WTerm WASM core 与 buffer/resize 修复
  packages/dom/                  DOM renderer、viewport controller、公开 API
  tests/                         buffer、viewport、resize、render 集成测试
public/terminal-runtime.js       只负责 WTerm 创建/销毁、输入和输出接线
public/terminal-layout.js        外层可见性与稳定尺寸协调，只调用 WTerm 公开 API
public/terminal-mobile-input.js  IME/VirtualKeyboard，不写 WTerm 私有字段
public/terminal-monitor.js       监控 UI
```

### 3.8.2 WTerm fork 必须新增的公开 API

建议给 WTerm 增加稳定接口；Zephyr 页面不得访问 `_` 开头的字段：

```ts
interface WTermViewportState {
  mode: 'follow' | 'history';
  viewportLine: number;
  bottomLine: number;
  scrollbackCount: number;
  rowHeight: number;
  atBottom: boolean;
}

interface WTermResizeResult {
  cols: number;
  rows: number;
  changed: boolean;
  viewportPreserved: boolean;
}

term.getViewportState(): WTermViewportState;
term.onViewportChange(listener): Disposable;
term.onRenderComplete(listener): Disposable;
term.scrollToBottom(options?: { source?: string }): void;
term.scrollToLine(line: number, options?: { source?: string }): void;
term.scrollLines(delta: number, options?: { source?: string }): void;
term.fitToContainer(options?: { minCols?: number; minRows?: number }): WTermResizeResult;
term.resize(cols: number, rows: number, options?: { preserveViewport?: boolean }): WTermResizeResult;
term.getBufferSnapshot(options): WTermBufferSnapshot;
```

- [INFERRED] `getViewportState()` 是 Zephyr 判断 follow/history 的唯一入口；页面不再自行组合 `scrollHeight/scrollTop/clientHeight` 猜内部状态。**置信度：HIGH。**
- [INFERRED] `onViewportChange` 必须标记来源（user/program/render/resize），使页面可以更新自定义滚动条，但不会把程序滚动误判为用户离开底部。**置信度：HIGH。**
- [INFERRED] `onRenderComplete` 在 DOM 行、scrollback、滚动尺寸和最终视口已原子提交后触发；Zephyr 不再双 rAF 猜测 WTerm 何时渲染完成。**置信度：HIGH。**
- [INFERRED] `fitToContainer()` 取代 Zephyr 对 `_lockHeight()` 副作用的清理；WTerm 新增 `sizeMode:'container'|'rows'`，Zephyr 使用 `container`，不得写固定 `rows * rowHeight` inline height。**置信度：HIGH。**
- [INFERRED] `getBufferSnapshot()` 直接从 WASM Bridge 返回结构化可见行/scrollback 文本，供 AI 读取，不再查询 `.term-row` DOM。**置信度：HIGH。**

### 3.8.3 WTerm 内部唯一视口状态

- [INFERRED] WTerm DOM 包新增 `ViewportController`，统一拥有 `mode`、当前顶部物理行、底部物理行、程序滚动抑制标志和 resize anchor。**置信度：HIGH。**
- [INFERRED] `write()` 只在写入前读取一次 `wasAtBottom`；WASM 写入、Renderer 更新、scrollback 尺寸同步和最终滚动必须在同一次 render commit 内完成。**置信度：HIGH。**
- [INFERRED] 若写入前为 follow，commit 末尾只执行一次滚到底；若为 history，则保持锚点，不得因远端输出抢回底部。**置信度：HIGH。**
- [INFERRED] 用户真实键盘输入是否回到底部由一个公开选项控制，建议 `scrollOnUserInput:true`；远端普通输出不改变 history 模式。**置信度：HIGH。**
- [INFERRED] 由 WTerm 自己设置 `scrollTop` 时必须设置 `_suppressScrollEvent`，同步 DOM 后再清除；scroll listener 在该标志期间不得切换 mode。**置信度：HIGH。**
- [INFERRED] `scrollToBottom()` 不再使用 `Math.floor(maxScroll / rowHeight) * rowHeight` 截断目标；应写精确 `maxScroll`，并在状态中记录 bottomLine，避免始终残留不足一行的底部距离。**置信度：HIGH。**
- [INFERRED] “无 scrollback 就强制 `scrollTop=0`”必须只发生在初始化或明确 reset，而不能在普通 render 中无条件纠正，否则渲染帧会先闪到顶部。**置信度：HIGH。**

### 3.8.4 WTerm resize/reflow 原子事务

[KNOWN] 当前 WTerm Renderer `setup()` 会清空 `.term-grid` 并重建行；WTerm core resize 还可能错误处理被裁掉的底部行，现有 Zephyr 才出现“PTY-only resize”和文本回灌等补偿。**置信度：HIGH。**

建议在 WTerm fork 内实现：

1. [INFERRED] resize 前由 `ViewportController.captureAnchor()` 保存语义锚点，而不是保存 pixel `scrollTop`。锚点至少包含 buffer generation、顶部物理行稳定 id、该行内偏移、是否 follow。**置信度：HIGH。**
2. [INFERRED] WTerm core 中每个 scrollback/viewport row 增加稳定 row id；列数 reflow 时维护 old-row-id → new-row-range 映射。**置信度：HIGH。**
3. [INFERRED] core 的 `resize()` 返回结构化 `ResizeDelta`，包含新增/删除物理行、trim 数量、cursor 新位置和 anchor 映射；DOM 层不再通过文本内容猜测是否丢行。**置信度：HIGH。**
4. [INFERRED] Renderer 在 DocumentFragment/离屏节点完成新行构建后一次性替换，禁止先清空后跨帧重建。**置信度：HIGH。**
5. [INFERRED] resize commit 完成后：原来 follow 就精确到底；原来 history 就按 row id 映射恢复同一段文本。**置信度：HIGH。**
6. [INFERRED] `onResize(cols, rows)` 只在 commit 成功后触发一次；Zephyr 收到后再向 SSH PTY `setWindow` 发送一次。**置信度：HIGH。**
7. [INFERRED] 同一帧多个 ResizeObserver/父布局通知只保留最后一个稳定尺寸，使用 generation token 丢弃旧事务。**置信度：HIGH。**

- [INFERRED] 父页面窗口变化、iframe 可见性、字体变化和横竖屏最终只能进入一个 `requestTerminalFit(reason)` coordinator；它去重后调用 `term.fitToContainer()`，不得各自 resize/scroll。**置信度：HIGH。**
- [INFERRED] 手机软键盘 overlay 只改变外层可见区域；若容器实际 cols/rows 未变化，不调用 WTerm resize。若确实变化，键盘动画稳定后只提交一次 fit。**置信度：HIGH。**

### 3.8.5 WTerm Renderer 与 scrollback 修复

- [KNOWN] 当前 Renderer 会把全部 scrollback row 都挂到 DOM，长会话会导致 DOM 节点持续增长。**置信度：HIGH。**
- [INFERRED] 第一阶段至少应修复 `syncScrollback()` 的增量顺序、trim 删除和 anchor 保持，并设置可测试的最大 scrollback。**置信度：HIGH。**
- [INFERRED] 第二阶段建议在 WTerm DOM 包实现窗口化 scrollback：只渲染视口上下 overscan 行，用顶部/底部 spacer 表示未挂载高度；viewport state 仍由 WTerm 管理。**置信度：MED。**
- [INFERRED] 窗口化实现必须先通过复制选择、搜索、链接和 AI buffer 读取测试；AI 读取必须走 Bridge，不能依赖当前挂载的 DOM。**置信度：HIGH。**

### 3.8.6 Zephyr 页面层必须删除的旧逻辑

- [INFERRED] 删除 `patchWTermScrollBehavior()` 对六个私有入口的全部覆写。**置信度：HIGH。**
- [INFERRED] 删除 `scheduleTerminalBottomFollow()` 多阶段 timer。**置信度：HIGH。**
- [INFERRED] 删除 `restoreMobileStableScrollTop()` 的重复像素恢复；改调用 WTerm 的 viewport anchor API。**置信度：HIGH。**
- [INFERRED] 删除 `snapshotWTermVisualLines()`、`detectAndRepairWTermTextRegression()`、`restoreWTermVisualSnapshot()`。**置信度：HIGH。**
- [INFERRED] 删除业务层对 `_doRender`、`_scheduleRender`、`_shouldScrollToBottom`、`_lockHeight` 等私有字段的访问。**置信度：HIGH。**
- [INFERRED] 删除用于修改内部状态的 `.term-grid/.term-row/.term-scrollback-row` 查询；主题和布局允许使用 WTerm 文档化 CSS class，但不能以其推导 buffer 状态。**置信度：HIGH。**
- [INFERRED] 自定义滚动条若保留，只通过 `getViewportState/onViewportChange/scrollToLine` 工作，不直接写 `wtermWrapper.scrollTop`。**置信度：HIGH。**

### 3.8.7 AI 终端输出适配

- [KNOWN] 当前 AI 输出读取同时尝试 WTerm bridge 和 `.term-row` DOM。**置信度：HIGH。**
- [INFERRED] 改为只调用 `term.getBufferSnapshot({ includeScrollback:true, maxChars })`；由 WTerm core 按 buffer 顺序输出文本和 wrapped 元数据。**置信度：HIGH。**
- [INFERRED] snapshot 返回 normal/alternate buffer 类型、cols/rows、cursor、scrollbackCount 和 truncated；不得为了 AI 读取而触发 render 或改变视口。**置信度：HIGH。**

## 3.9 WTerm 修复的落地顺序

1. [INFERRED] 先把 `@wterm/dom/core 0.1.9` vendoring 到仓库并原样跑通 upstream/Zephyr 测试，建立可重复构建。**置信度：HIGH。**
2. [INFERRED] 在 WTerm fork 加公开 viewport API、程序滚动抑制和单次 render commit；Zephyr 页面切换到公开 API。**置信度：HIGH。**
3. [INFERRED] 删除多阶段 timer 和六个私有 monkey patch，再做输出/历史滚动回归。**置信度：HIGH。**
4. [INFERRED] 修 core resize 的 row id/reflow anchor 和 DOM 原子替换，再删除 PTY-only resize、像素恢复和文本回灌。**置信度：HIGH。**
5. [INFERRED] 最后评估窗口化 scrollback；不得把虚拟化和基础正确性修复混在第一提交中。**置信度：HIGH。**

## 3.10 终端稳定性测试矩阵

### 自动化模型测试

- [INFERRED] 在 WTerm fork 内为 `ViewportController` 写状态机测试：follow/history、输出、用户输入、resize、alternate screen、selection 和程序滚动抑制。**置信度：HIGH。**
- [INFERRED] 断言一次 output batch 在 render commit 中最多执行一次 `scrollToBottom()`，且只触发一次公开 viewport change。**置信度：HIGH。**
- [INFERRED] Zephyr 业务源码门禁禁止访问 `_doRender/_scheduleRender/_shouldScrollToBottom` 等私有入口；WTerm fork 内部实现由其自身测试覆盖。**置信度：HIGH。**
- [INFERRED] resize 单测覆盖 row id 映射、trim、wrapped line、宽字符、cursor 和 history anchor，断言内容不丢失、不重复、不逆序。**置信度：HIGH。**

### Playwright 浏览器测试

- [INFERRED] 写入 5,000 行后滚到中部，再持续输出 500 行；首行语义锚点不得变化超过 1 个视觉行。**置信度：HIGH。**
- [INFERRED] 在底部持续输出 1,000 行，`term.getViewportState().atBottom` 始终为 true，截图不得出现顶部/底部交替。**置信度：HIGH。**
- [INFERRED] 宽度按 `1200→600→900→400→1200` 循环 50 次，当前阅读锚点保持，终端内容不丢行、不重复、不乱序。**置信度：HIGH。**
- [INFERRED] 手机测试覆盖 Android Chrome/WebView 与 iOS Safari：键盘开关 50 次、横竖屏 20 次、输入法组合输入、复制选择和历史滚动。**置信度：HIGH。**
- [INFERRED] 覆盖 `vim/top/less/tmux` alternate screen，退出后 normal scrollback 和视口正确。**置信度：HIGH。**
- [INFERRED] 覆盖 ANSI clear、回车覆盖进度条、宽字符、emoji、combining mark、超长行和 bracketed paste。**置信度：HIGH。**

### 性能门禁

- [INFERRED] 60 秒高频输出下 Long Task 数量、主线程时间和 DOM 节点数设置基线；WTerm 修复后不得回退。**置信度：HIGH。**
- [INFERRED] hidden/minimized tab 不做无意义 render；恢复后单次 refresh/fit，不执行多阶段 repair。**置信度：HIGH。**

---

## 4. 概率性“连接失败后要求重新登录”分析

## 4.1 已证实根因一：会话只在内存

- [KNOWN] `const sessions = new Map()` 位于 `server.js:89`，SID 没有写入 SQLite。**置信度：HIGH。**
- [KNOWN] 浏览器 Cookie 可保持到会话结束或 30 天，但服务重启后新进程的 Map 为空。**置信度：HIGH。**
- [INFERRED] 所以“之前页面还开着 → SSH 网络暂断/自动重连 → `/ssh` Upgrade 401 → 用户被要求登录”是确定可发生的链路。**置信度：HIGH。**
- [INFERRED] 若部署使用多个 Node 副本且无 sticky session，同一个 Cookie 被路由到另一副本也会随机 401。**置信度：HIGH。**

## 4.2 已证实根因二：名为 lastSeen 的字段没有参与 TTL

- [KNOWN] `currentSession()` 每次更新 `session.lastSeenAt`，但过期判断使用 `Date.now() - session.createdAt > ttl`；见 `server.js:285-296`。**置信度：HIGH。**
- [INFERRED] 当前是绝对 24 小时过期，不是用户通常理解的“活跃会话 24 小时不操作才过期”；用户持续工作也会在创建时间满 24 小时后失效。**置信度：HIGH。**

## 4.3 已证实根因三：Upgrade 与 connect 重复鉴权

- [KNOWN] `/ssh` Upgrade 在 `server.js:4177-4182` 调用一次 `currentSession(req)`。**置信度：HIGH。**
- [KNOWN] WebSocket 建立后，首个 `connect` 消息又在 `server.js:4745-4750` 调用一次 `currentSession(req)`；按 connectionId 读取时又调用一次，见 `4777-4779`。**置信度：HIGH。**
- [INFERRED] TTL 恰在两次检查之间越界时，会出现 WebSocket 已 open、随后收到“未登录或会话已过期”的边界竞态。**置信度：MED。**

## 4.4 错误分类不足

- [KNOWN] 服务端 SSH 登录失败和 Zephyr 登录失效都通过通用 `{type:'error', message}` 返回。**置信度：HIGH。**
- [KNOWN] 浏览器 WebSocket API 对失败的 HTTP Upgrade 通常只暴露 `error/close`，客户端当前只显示关闭 code，见 `public/terminal.js:9932-9944`。**置信度：HIGH。**
- [KNOWN] 消息解析包在空 `catch (_) {}` 中，意外协议错误不会记录；见 `public/terminal.js:9929`。**置信度：HIGH。**
- [INFERRED] 应区分 Zephyr App Session、远端 SSH Auth、网络、Host Key、路由、PTY Shell 和服务端重启，避免把所有失败引导成重新登录。**置信度：HIGH。**

## 4.5 反向代理 Cookie 风险

- [KNOWN] `Secure` 标志由 `PUBLIC_ORIGIN`、`TRUST_PROXY/ZEPHYR_TRUST_PROXY` 和请求协议推导；见 `server.js:1175-1195`、`1341-1355`。**置信度：HIGH。**
- [INFERRED] 反代部署若外部 HTTPS、内部 HTTP，却未正确设置 `PUBLIC_ORIGIN=https://...` 或 `TRUST_PROXY=true`，Cookie 属性和 Origin 校验可能不符合实际入口。**置信度：HIGH。**
- [INFERRED] 该项未必是用户反馈的主因，但必须加入部署诊断。**置信度：MED。**

## 4.6 修复设计：持久会话

### SQLite 表

```sql
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  user_agent_hash TEXT,
  ip_prefix TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(username);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);
```

- [INFERRED] Cookie 只保存随机 SID；SQLite 只保存 `SHA-256(SID)`，数据库泄露时不直接暴露可用 Cookie。**置信度：HIGH。**
- [INFERRED] 普通会话建议 idle TTL 24 小时、absolute TTL 7 天；remember 会话 idle TTL 30 天、absolute TTL 90 天，最终值可由环境变量配置。**置信度：MED。**
- [INFERRED] `last_seen_at` 最多每 60 秒落库一次，避免每个 API 请求写 SQLite。**置信度：HIGH。**
- [INFERRED] 内存 Map 可作为短期 cache，但 SQLite 必须是权威来源。**置信度：HIGH。**
- [INFERRED] 密码修改、用户重命名、显式 logout 和管理员安全操作应撤销对应 session。**置信度：HIGH。**

### WebSocket 身份传递

```js
const session = await sessionStore.resolve(req);
if (!session) return rejectSocket(...);
req.authSession = session;
targetWss.handleUpgrade(...);
```

- [INFERRED] `wss.on('connection')` 后只使用 `req.authSession`，不再从旧 Upgrade 请求重复解析 Cookie。**置信度：HIGH。**
- [INFERRED] 长连接每 5 分钟做轻量 session validity check；被撤销时用 WebSocket close code `4001` 和 reason `app-session-expired` 关闭。**置信度：HIGH。**

### 客户端错误协议

```json
{ "type": "error", "code": "ssh_auth_failed", "message": "...", "retryable": false }
{ "type": "error", "code": "app_session_expired", "message": "...", "retryable": false }
{ "type": "error", "code": "network_timeout", "message": "...", "retryable": true }
```

- [INFERRED] 每次自动重连前先调用 `/api/auth/me`；只有明确 401/`app_session_expired` 才通知父页面进入登录流程。**置信度：HIGH。**
- [INFERRED] SSH 密码错误必须停在终端错误页，不得跳 Zephyr 登录。**置信度：HIGH。**
- [INFERRED] 网络失败和 5xx 使用指数退避 + jitter；不要固定每 2 秒重试。**置信度：HIGH。**
- [INFERRED] 服务端启动生成 `instanceId`，`/healthz` 与 WS `ready` 返回；客户端可明确提示“服务已重启，正在恢复会话”。**置信度：HIGH。**

## 4.7 登录可靠性测试

- [INFERRED] 登录后重启 Node 进程，普通 API 和 `/ssh` Upgrade 仍有效。**置信度：HIGH。**
- [INFERRED] 两副本轮询请求时，会话在任一副本有效。**置信度：HIGH。**
- [INFERRED] 空闲 TTL、绝对 TTL、remember TTL 使用 fake clock 做边界测试。**置信度：HIGH。**
- [INFERRED] TTL 恰在 Upgrade/connect 边界时结果确定，无“先 open 后未登录”竞态。**置信度：HIGH。**
- [INFERRED] SSH 错密码、TCP 超时、服务重启、Cookie 失效分别显示不同错误和动作。**置信度：HIGH。**
- [INFERRED] 反代 HTTPS 测试断言 Cookie 含 `HttpOnly; Secure; SameSite=Lax`，WebSocket 携带 Cookie。**置信度：HIGH。**

---

## 5. Deep Link 功能设计

## 5.1 能力边界

- [KNOWN] Netcatty 是 Electron 桌面应用，可调用操作系统 API 注册 `ssh`、`telnet`、`jms` scheme；Zephyr 主应用当前是浏览器 Web 应用。**置信度：HIGH。**
- [KNOWN] 普通网页不能像 Electron 那样无条件注册任意 `ssh://` 或 `telnet://` 为系统默认处理器。**置信度：HIGH。**
- [INFERRED] 因此 Zephyr Web 版可完整实现 HTTPS Deep Link 和 `web+zephyr:`；系统级接管 `ssh://`、`telnet://`、`jms://` 需要 Android/桌面原生壳、PWA 平台支持或浏览器扩展。**置信度：HIGH。**
- [KNOWN] Zephyr 当前没有 Telnet 后端；仅解析 `telnet://` 不能让连接工作。**置信度：HIGH。**

## 5.2 分层协议

### Web 通用入口

```text
https://zephyr.example/open#uri=ssh%3A%2F%2Fuser%40host%3A22
https://zephyr.example/open#uri=telnet%3A%2F%2Fuser%40host%3A23
https://zephyr.example/open#uri=jms%3A%2F%2F<base64url>
web+zephyr://open?uri=<percent-encoded-uri>
```

- [INFERRED] 敏感 payload 放 URL fragment，不进入 HTTP access log、Referer 和服务端路由。**置信度：HIGH。**
- [INFERRED] `/open` 页面仅在浏览器本地解析 fragment，认证后 POST 到一次性凭据接口。**置信度：HIGH。**
- [INFERRED] 不允许把密码/JMS token 写入 localStorage、连接表、活动日志、分析日志或 toast。**置信度：HIGH。**

### 解析规则

#### SSH

```text
ssh://[username[:password]@]hostname[:port]
```

- [INFERRED] 默认端口 22，端口必须 1–65535，IPv6 支持 `[addr]`。**置信度：HIGH。**
- [INFERRED] 无密码且唯一匹配已保存连接时复用保存连接的路由/代理/跳板配置。**置信度：HIGH。**
- [INFERRED] URI 带密码时创建 ephemeral connection，URI 凭据优先且不得被保存身份覆盖。该原则来自 Netcatty `buildSshDeepLinkEphemeralHostFromSaved()`。**置信度：HIGH。**

#### Telnet

```text
telnet://[username[:password]@]hostname[:port]
```

- [INFERRED] 默认端口 23；规则同 SSH，但必须先实现 Telnet transport。**置信度：HIGH。**
- [INFERRED] Telnet 明文传输，应在 UI 明确标识“不加密”，且禁止误标为 SSH。**置信度：HIGH。**

#### JumpServer

- [KNOWN] Netcatty 解析 `jms://<base64url-json>`，读取 `protocol`、`token.id/value`、`endpoint.host/port` 和 `asset.name`；见 `domain/jmsDeepLink.ts:55-100`。**置信度：HIGH。**
- [INFERRED] Zephyr 可兼容该 payload，但需校验解码后 JSON 最大长度、字段类型、端口和 protocol allowlist。**置信度：HIGH。**
- [INFERRED] 支持 `ssh`、`sftp`；`telnet` 需等待 Telnet transport。SFTP payload 连接后自动打开文件面板。**置信度：HIGH。**
- [INFERRED] JumpServer token 仅存在 transient credential store，单次领取，默认 60 秒过期，终端会话结束即销毁。**置信度：HIGH。**

## 5.3 Deep Link 临时连接 UI（必须交付）

### 5.3.1 入口与打开方式

- [KNOWN] Deep Link 不能在解析后直接无界面连接；用户要求有可操作 UI。**置信度：HIGH。**
- [INFERRED] 所有入口——系统 `ssh://`、`telnet://`、`jms://`、`web+zephyr:`、HTTPS `/open#uri=...`、笔记内连接链接——最终统一调用 `openConnectionModal({ mode:'transient', source, draft })`。**置信度：HIGH。**
- [INFERRED] 未登录时完成登录回跳后也必须进入该 UI，不得自动连接。**置信度：HIGH。**

### 5.3.2 复用现有添加连接窗口

[KNOWN] 当前 `public/app.html` 已有 `#connectionModal/#connectionForm`，具备协议、主机、端口、用户名、密码、私钥、SSH 密钥库、代理/跳板链、RDP 设置、测试连接和保存按钮。**置信度：HIGH。**

[INFERRED] 不复制第二套表单，而是把现有连接窗口改成三种显式模式：**置信度：HIGH。**

```js
openConnectionModal({
  mode: 'create' | 'edit' | 'transient',
  source: 'dashboard' | 'deeplink' | 'jms' | 'note',
  draft,
  transientToken
});
```

| 模式 | 标题 | 底部动作 | 是否写入主机库 |
|---|---|---|---|
| `create` | 添加服务器 | 测试连接、取消、保存 | 是 |
| `edit` | 编辑服务器 | 测试连接、取消、保存 | 是 |
| `transient` | 临时连接 | **测试连接、连接** | **否** |

- [INFERRED] 临时模式下隐藏原“保存”按钮和普通“取消”业务按钮；关闭仍可使用右上角 `✕`、遮罩或系统返回键。底部只显示用户要求的两个业务动作：左侧“测试连接”、右侧主按钮“连接”。**置信度：HIGH。**
- [INFERRED] 现有 submit 保存按钮应增加明确 id（例如 `#saveConnectionBtn`），新增 `#connectTransientBtn`；`setConnectionModalMode()` 负责互斥显示普通动作组与临时动作组，避免只改按钮文字后仍误走保存逻辑。**置信度：HIGH。**
- [INFERRED] “连接”按钮必须是 `type="button"` 或由 submit handler 按 mode 分流；不得误进入 `POST /api/connections`。**置信度：HIGH。**
- [INFERRED] 临时模式下 `connectionId` 必须为空，提交前再做防御性断言 `mode === transient => never call saveConnection()`。**置信度：HIGH。**
- [INFERRED] 测试连接调用现有 `/api/connections/test`，但请求体使用当前临时 draft/transient token，不创建活动资产。**置信度：HIGH。**
- [INFERRED] 点击“连接”后用表单当前值签发一次性 transient token 并创建终端 tab；终端 tab 标题取资产名或 `username@host`，带“临时”标记。**置信度：HIGH。**

### 5.3.3 临时模式字段规则

- [INFERRED] 顶部标题下增加与现有 `.field-hint`、卡片色和边框变量一致的提示条：`临时连接 · 本次参数不会保存到主机库`。**置信度：HIGH。**
- [INFERRED] 名称、协议、主机、端口、用户名、密码/私钥、代理/跳板链保持可编辑，方便用户在连接前检查 Deep Link 解析结果。**置信度：HIGH。**
- [INFERRED] URI 未提供名称时自动填充 `username@host` 或 JumpServer asset name；名称只用于当前 tab，不保存。**置信度：HIGH。**
- [INFERRED] URI 带一次性密码/JMS token 时密码框显示“已载入一次性凭据”状态，不把明文写进 DOM value；可通过 transient credential handle 使用。若用户手动修改密码，则用内存中的新值替换 handle。**置信度：HIGH。**
- [INFERRED] “选择已保存 SSH 密钥”和路由设置可用，但选择结果只参与本次连接；JMS 一次性密码必须优先于已保存身份，避免被密钥库覆盖。**置信度：HIGH。**
- [INFERRED] Deep Link protocol 是 SFTP 时，UI 显示 `连接后自动打开文件管理器` 的只读状态；不是额外保存选项。**置信度：HIGH。**
- [INFERRED] Telnet 临时 UI 在 transport 尚未实现时不得显示可点击“连接”；应显示“不支持当前协议版本”，但 parser/UI 测试仍可存在。正式启用后显示醒目的“Telnet 未加密”提示。**置信度：HIGH。**

### 5.3.4 与现有 UI 统一的视觉规则

- [KNOWN] 当前连接弹窗使用 `.modal-backdrop`、`.connection-modal`、`.modal-head`、`.form-row`、`.form-group`、`.advanced-route-panel`、`.field-hint`、`.modal-actions`、`.btn`、`.btn-primary` 和 CSS 主题变量。**置信度：HIGH。**
- [INFERRED] Deep Link UI 必须复用这些 class 和变量，不创建 Netcatty 风格、Material 风格或另一套颜色/圆角/阴影。**置信度：HIGH。**
- [INFERRED] 深色、浅色、自定义配色和移动端响应式行为全部继承现有连接弹窗；新增 class 仅允许表达状态，例如 `.connection-modal.transient-mode`、`.transient-connection-banner`、`.transient-credential-state`。**置信度：HIGH。**
- [INFERRED] 动画复用现有 modal open/close；不得增加整页跳转造成的视觉割裂。HTTPS `/open` 在同源 app 已打开时应进入 `/app.html` 并打开 modal。**置信度：HIGH。**
- [INFERRED] 移动端临时连接窗口保持现有单列 form-row、可滚动内容和底部动作区；“测试连接”和“连接”始终可触达，但不得遮挡输入框或系统键盘。**置信度：HIGH。**

### 5.3.5 UI 状态机

```text
received → parsing → ready
                    ├─ testing → test-success / test-error → ready
                    └─ connecting → consumed → terminal-open
                                   └─ error → refresh-token → ready
```

- [INFERRED] parsing 错误留在统一弹窗中显示字段级错误，不静默关闭、不自动改成保存连接。**置信度：HIGH。**
- [INFERRED] 测试期间只禁用两个动作，结束后恢复；连接期间主按钮显示“正在连接…”，防止双击消费 token。**置信度：HIGH。**
- [INFERRED] 用户关闭窗口、连接成功、token 过期或页面卸载时清空 transient draft 和凭据 handle。**置信度：HIGH。**

## 5.4 一次性凭据与 UI 会话接口

建议把 Deep Link 原始 URI 解析、敏感凭据托管和 UI draft 分开：

```http
POST /api/deeplinks/prepare
Content-Type: application/json

{ "uri": "ssh://..." }

200
{
  "token": "random-one-time-token",
  "source": "ssh",
  "draft": {
    "name": "user@example",
    "protocol": "SSH",
    "host": "example",
    "port": 22,
    "username": "user",
    "hasTransientCredential": true,
    "autoOpenSftp": false
  },
  "expiresAt": 1234567890
}
```

- [INFERRED] 响应中的 `draft` 只包含可显示字段和 `hasTransientCredential`，绝不返回 Deep Link 原始密码/JMS token。临时连接 UI 用它填充普通字段，密码区域只显示“已载入一次性凭据”。**置信度：HIGH。**
- [INFERRED] 用户修改普通字段时，测试和连接请求携带 `overrides`；用户手工输入新密码/私钥时，该值仅在本次 HTTPS 请求和服务端短期内存中存在，成功/关闭后立即清空。**置信度：HIGH。**

测试连接：

```http
POST /api/deeplinks/:token/test

{ "overrides": { "host": "example", "port": 22, "username": "user" },
  "credentialOverride": { "password": "仅用户手工改写时传" } }
```

正式连接由终端 WebSocket 消费：

```json
{
  "type": "connect",
  "transientToken": "random-one-time-token",
  "transientOverrides": { "host": "example", "port": 22, "username": "user" },
  "sessionId": "...",
  "cols": 120,
  "rows": 30
}
```

- [INFERRED] token 与 Zephyr username 绑定，默认 60 秒过期；测试连接可在过期前重复使用但不会续期，正式 connect 原子领取并删除 token。**置信度：HIGH。**
- [INFERRED] WS 服务端将领取到的凭据直接放入当前 SSH/Telnet session 内存，创建连接后清除中间对象；不得落入 `connections`、settings、activities 或输出 buffer。**置信度：HIGH。**
- [INFERRED] 正式连接失败后不能复用已消费 token；客户端保留无敏感字段 draft，并请求用户重新打开链接或重新输入凭据。**置信度：HIGH。**
- [INFERRED] 日志只记录 scheme、目标 host hash、成功/失败原因，不记录原始 URI、用户名、密码或 JMS token。**置信度：HIGH。**
- [INFERRED] prepare/test 受登录、Same-Origin、请求大小和速率限制保护；响应增加 `Cache-Control:no-store`。**置信度：HIGH。**

## 5.5 未登录 Deep Link 流程

1. [INFERRED] `/open` 读取 fragment 并暂存在 `sessionStorage`，键含随机 nonce。**置信度：HIGH。**
2. [INFERRED] 调 `/api/auth/me`；401 时跳登录页并带非敏感 `returnTo=/open`。**置信度：HIGH。**
3. [INFERRED] 登录成功后返回 `/open`，读取 sessionStorage payload，prepare 后立即删除。**置信度：HIGH。**
4. [INFERRED] 不把原始敏感 URI放 query 参数。**置信度：HIGH。**

## 5.6 Telnet transport 实施

建议新增 `telnet-session.js`：

- [INFERRED] 基于 Node `net.Socket`，实现 IAC 协商最小集：DO/DONT/WILL/WONT、NAWS、TTYPE、ECHO、SGA、BINARY。**置信度：HIGH。**
- [INFERRED] 统一复用现有 WebSocket session envelope，但标识 `protocol:'TELNET'`。**置信度：HIGH。**
- [INFERRED] 支持 direct；代理/跳板能力分阶段实现，不能把 SSH jump 链直接当 Telnet 已支持。**置信度：HIGH。**
- [INFERRED] 用户名/密码自动输入默认关闭；如启用，只按显式 prompt detector 和一次性配置执行，避免误发凭据。**置信度：HIGH。**

## 5.7 原生接管路线

- [INFERRED] Android 若要接管 `ssh/telnet/jms`，在原生 Activity/Flutter 宿主添加 intent-filter，收到 URI 后打开配置的 Zephyr HTTPS `/open#uri=...`。**置信度：HIGH。**
- [INFERRED] 桌面端若未来提供 Electron/Tauri 壳，可采用 Netcatty 的单实例、pending queue、renderer-ready 投递模式。**置信度：HIGH。**
- [INFERRED] macOS Finder 打开本地终端目录属于桌面原生能力，不应在当前纯 Web 版本中伪装实现；需未来桌面壳单独立项。**置信度：HIGH。**

## 5.8 Deep Link 测试

- [INFERRED] parser 单测覆盖 IPv4/IPv6、percent encoding、空用户名、错误端口、超长 payload、非法 Base64/JSON 和不支持协议。**置信度：HIGH。**
- [INFERRED] 一次性 token 覆盖过期、重复消费、跨用户消费、服务重启和并发双消费。**置信度：HIGH。**
- [INFERRED] 断言 connections 表、settings、activities、server log 均不出现测试密码/token。**置信度：HIGH。**
- [INFERRED] JumpServer SFTP 在临时连接 UI 中显示自动打开文件管理器，点击连接后执行；关闭会话后临时凭据不可复用。**置信度：HIGH。**
- [INFERRED] 未登录→登录→返回→打开临时连接 UI→测试连接→连接全链路测试，浏览器历史和 Referer 不含原始 URI。**置信度：HIGH。**
- [INFERRED] UI 测试断言 transient mode 底部恰好只有“测试连接”和“连接”两个业务按钮，不出现“保存”，且测试/连接均不调用 `POST /api/connections`。**置信度：HIGH。**
- [INFERRED] UI 测试覆盖关闭后清除凭据、重复点击连接、测试失败后重试、token 过期刷新和表单手工修改。**置信度：HIGH。**
- [INFERRED] 视觉回归覆盖桌面/手机、深色/浅色/自定义主题，临时 UI 与现有添加连接弹窗的圆角、间距、按钮和动画一致。**置信度：HIGH。**

---

## 6. 笔记功能与 AI 读写设计

## 6.1 为什么不能只复用 Memory

- [KNOWN] Zephyr 已有 AI Memory，存放于 AI settings，并通过 `memory_search/memory_save` 使用；见 `ai-agent-service.js:607-608`、`1662-1688`。**置信度：HIGH。**
- [INFERRED] Memory 是模型上下文资产，笔记是用户可见、可编辑、可导入导出的 Markdown 文档；二者权限、排序、版本、搜索和删除语义不同。**置信度：HIGH。**
- [INFERRED] 应独立建模，并允许用户把一条笔记显式转为 Memory，而不是默认混用。**置信度：HIGH。**

## 6.2 数据模型

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  group_path TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order REAL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_notes_owner_updated ON notes(username, updated_at DESC);
CREATE INDEX idx_notes_owner_group ON notes(username, group_path);
```

- [INFERRED] 所有 CRUD 必须按 `req.session.username` 过滤，不能只凭 note id。**置信度：HIGH。**
- [INFERRED] title 限 200 字符，content 建议限 1 MiB，tags/连接关联各限 100 项。**置信度：MED。**
- [INFERRED] `revision` 用于乐观并发：更新携带 expectedRevision，不匹配返回 409。**置信度：HIGH。**
- [INFERRED] 可选 FTS5 表用于标题、正文、标签全文搜索；不支持 FTS5 的构建回退到参数化 LIKE。**置信度：HIGH。**

## 6.3 API

```text
GET    /api/notes?q=&group=&tag=&connectionId=&limit=&cursor=
POST   /api/notes
GET    /api/notes/:id
PUT    /api/notes/:id
DELETE /api/notes/:id
POST   /api/notes/import-markdown
GET    /api/notes/:id/export.md
GET    /api/notes/export.zip
```

- [INFERRED] list 默认只返回摘要和 content preview；get 才返回完整 content。**置信度：HIGH。**
- [INFERRED] 删除先 soft delete，30 天后清理；UI 可提供回收站/恢复。若不做回收站，则直接 hard delete 但必须明确。**置信度：MED。**
- [INFERRED] 导入 Markdown 时文件名作为默认 title，目录作为 group_path；导出文件名必须清理路径穿越和平台保留字符。**置信度：HIGH。**

## 6.4 笔记 UI（必须交付）

### 6.4.1 主入口和整体布局

- [KNOWN] 笔记功能必须有用户可直接使用的 UI，不能只提供数据库/API/AI 工具。**置信度：HIGH。**
- [INFERRED] 在现有顶部 `.nav-tabs` 中加入 `笔记`，顺序建议为“仪表盘 / 终端 / 远程执行 / 笔记 / 设置”；使用现有 `.nav-tab`、`.view` 和 `switchView()`，不引入新的路由框架。**置信度：HIGH。**
- [INFERRED] `#view-notes` 使用与现有 `.section-head` 一致的标题区：eyebrow `Notes`、标题“笔记”，右侧使用现有 `.btn.add-btn` 提供“＋ 新建笔记”。**置信度：HIGH。**
- [INFERRED] 桌面端采用三栏工作区，移动端降为分层页面：**置信度：HIGH。**

```text
桌面端
┌ 分组栏 220px ┬ 笔记列表 320px ┬ 编辑/预览 minmax(0,1fr) ┐

手机端
笔记列表 → 点选笔记 → 编辑器
顶部返回键返回列表；不把三栏压成不可用的小列。
```

- [INFERRED] 三栏均使用现有 `--surface/--surface-2/--border/--text/--muted/--accent` 等变量，卡片圆角、阴影、按钮和输入框复用当前项目样式。**置信度：HIGH。**

### 6.4.2 左侧分组栏

- [INFERRED] 固定条目包含“全部笔记”“未分组”“当前连接”“回收站”；其下显示用户分组树和每组数量。**置信度：HIGH。**
- [INFERRED] 提供“新建分组”、重命名、移动和删除；删除分组默认把笔记移到未分组，不连带删除笔记。**置信度：HIGH。**
- [INFERRED] 第一版用按钮/菜单移动，拖拽排序后置，避免首版引入移动端拖拽冲突。**置信度：HIGH。**

### 6.4.3 中间笔记列表

- [INFERRED] 顶部 action bar 使用现有 `.search-input`、`select`：全文搜索、标签筛选、连接筛选、排序。**置信度：HIGH。**
- [INFERRED] 每条列表项显示标题、两行正文摘要、标签、关联连接、更新时间和未保存/冲突状态；选中态使用现有 accent 边框与半透明背景。**置信度：HIGH。**
- [INFERRED] 列表项菜单包含重命名、移动分组、复制、导出 Markdown、删除；批量导入和导出全部放在列表标题区的次级动作菜单。**置信度：HIGH。**
- [INFERRED] 搜索输入不得因服务端结果刷新而重建 DOM/失焦；请求使用 debounce 和 generation，丢弃旧结果。**置信度：HIGH。**

### 6.4.4 右侧编辑器/预览

- [INFERRED] 顶栏包含可直接编辑的标题、保存状态、关联连接按钮、标签按钮、更多菜单，以及“编辑 / 分屏 / 预览”三段切换。**置信度：HIGH。**
- [INFERRED] Markdown 编辑器复用已有 CodeMirror 6 bundle 和 Markdown language；不得重新实现 textarea 高亮。**置信度：HIGH。**
- [INFERRED] Markdown 工具栏至少包含标题、粗体、斜体、删除线、行内代码、代码块、链接、引用、无序/有序列表和任务列表，并在窄屏自动换行。**置信度：HIGH。**
- [INFERRED] 分屏模式左右各占一半，使用现有 panel resize handle 视觉；预览滚动与编辑器按 heading/block anchor 做近似同步，不直接按百分比反复抖动。**置信度：MED。**
- [INFERRED] 自动保存采用 800ms debounce；离开笔记、关闭页面和切换视图前 flush。保存期间显示“保存中…”，成功显示“已保存”，失败保留 dirty 状态和“重试”。**置信度：HIGH。**
- [INFERRED] revision 409 时打开与现有 modal 样式一致的冲突窗口，提供“保留我的版本”“载入服务器版本”“打开对比”；不得静默覆盖。**置信度：HIGH。**

### 6.4.5 关联连接与终端入口

- [INFERRED] “关联连接”使用现有 modal/mini-list 风格，支持搜索和多选 SSH/RDP/VNC 资产；只存连接 id，不复制密码或私钥。**置信度：HIGH。**
- [INFERRED] 终端工具栏增加“笔记”按钮，打开当前连接筛选的笔记侧窗；按钮图标、hover、active 和浮动窗口布局复用监控/代码片段面板。**置信度：HIGH。**
- [INFERRED] 侧窗可查看、搜索、快速新建并自动关联当前连接；点击“完整编辑”切换主导航笔记视图并定位对应 note。**置信度：HIGH。**
- [INFERRED] 笔记预览中的 `ssh://`、`telnet://`、`jms://` 链接必须进入第 5.3 节统一临时连接 UI，不得直接连接或保存。**置信度：HIGH。**

### 6.4.6 UI 视觉统一要求

- [INFERRED] 只使用现有品牌字体、CSS 变量、按钮等级、圆角、边框、背景、toast、modal 和动画曲线；禁止照搬 Netcatty 的 React/Tailwind 视觉。**置信度：HIGH。**
- [INFERRED] 深色、浅色、凝霜蓝、Lava、Asagi、Cyber 和自定义配色都必须可读；不得硬编码黑白背景。**置信度：HIGH。**
- [INFERRED] 空状态使用现有 `.empty-state/.empty-card` 风格；加载使用局部 skeleton，不整页闪白；错误使用现有 toast 加编辑器内状态条。**置信度：HIGH。**
- [INFERRED] 移动端按钮触控区至少 44px，软键盘打开时编辑器工具栏固定但不遮挡正文；适配 safe-area。**置信度：HIGH。**
- [INFERRED] 所有图标沿用项目 SVG glyph/现有图标体系，不新增 emoji 作为主要操作图标。**置信度：HIGH。**

### 6.4.7 UI 安全和可访问性

- [KNOWN] 现有 `renderMarkdown()` 先 escape HTML，再解析受控 Markdown block；见 `public/app.js:889-919`。**置信度：HIGH。**
- [INFERRED] 笔记预览继续执行 HTML escape 和 URL scheme allowlist，禁止 `javascript:`、危险 data URI、event handler 和未净化原始 HTML。**置信度：HIGH。**
- [INFERRED] UI 明确提示“不要在笔记中保存密码、私钥或 token”；AI 读取权限与该提示分开控制。**置信度：HIGH。**
- [INFERRED] 分组树、列表、编辑/预览切换和 modal 必须有 aria-label、键盘导航、focus trap 和 focus restore。**置信度：HIGH。**

## 6.5 AI 工具

建议新增：

```text
note_list       列出标题、分组、标签、关联连接、更新时间
note_search     搜索标题/正文/标签/连接
note_get        读取完整 Markdown
note_create     创建笔记
note_update     更新笔记，必须带 noteId，可带 expectedRevision
note_delete     删除笔记
```

- [INFERRED] `note_list/search/get` 受新权限 `notesRead` 控制；`note_create/update/delete` 受 `notesWrite` 控制。**置信度：HIGH。**
- [INFERRED] AI 不应在每轮系统提示中自动注入所有笔记正文；应先 search/list，再按需 get，降低隐私和 token 消耗。**置信度：HIGH。**
- [INFERRED] create/update/delete 属于持久写操作，应进入现有 confirmation gate；`note_delete` 必须敏感确认。**置信度：HIGH。**
- [INFERRED] 工具结果返回脱敏摘要，完整正文只在当前模型调用上下文中使用，不写活动日志。**置信度：HIGH。**
- [INFERRED] AI 更新时传 expectedRevision；409 后重新 get 并向用户解释冲突，不可静默覆盖人工编辑。**置信度：HIGH。**

示例工具 schema：

```json
{
  "name": "note_update",
  "parameters": {
    "type": "object",
    "properties": {
      "noteId": { "type": "string" },
      "title": { "type": "string" },
      "content": { "type": "string" },
      "group": { "type": "string" },
      "tags": { "type": "array", "items": { "type": "string" } },
      "linkedConnectionIds": { "type": "array", "items": { "type": "string" } },
      "expectedRevision": { "type": "integer" }
    },
    "required": ["noteId", "expectedRevision"]
  }
}
```

## 6.6 笔记测试

- [INFERRED] storage 测试覆盖 CRUD、owner 隔离、revision 冲突、soft delete、排序和迁移。**置信度：HIGH。**
- [INFERRED] API 测试覆盖未登录 401、跨用户 404、大小限制、非法标签、分页游标。**置信度：HIGH。**
- [INFERRED] XSS 测试覆盖 script、event handler、javascript URL、SVG/data URI、恶意 Markdown link。**置信度：HIGH。**
- [INFERRED] 导入导出覆盖中文、emoji、Windows 保留名、重复标题、目录穿越和大文件。**置信度：HIGH。**
- [INFERRED] AI 工具测试覆盖读权限、写确认、revision 冲突、删除确认和不误用 Memory。**置信度：HIGH。**
- [INFERRED] UI E2E 覆盖主导航进入、新建、自动保存、编辑/分屏/预览、全文搜索、分组/标签/连接关联、删除/恢复、导入/导出。**置信度：HIGH。**
- [INFERRED] 手机 E2E 覆盖列表→编辑→返回、软键盘、工具栏换行、safe-area、长笔记滚动和离线/失败重试。**置信度：HIGH。**
- [INFERRED] 视觉回归覆盖所有内置配色及自定义主题，笔记 view、终端笔记侧窗、冲突 modal 均与现有 UI 统一。**置信度：HIGH。**
- [INFERRED] 可访问性测试覆盖键盘导航、焦点恢复、aria、颜色对比和 reduced-motion。**置信度：HIGH。**

---

## 7. RDP 文件传输性能瓶颈与 Go 重构方案

### 7.1 现状数据链路

[KNOWN] 当前 Zephyr RDP 文件传输的完整链路如下：**置信度：HIGH。**

```text
Windows RDP → rdpdr SVC → Go WASM rdpefs.go (IRP_MJ_READ/WRITE)
  → js.Global().Call("zephyrRdpFsRead/Write")  [Go WASM 同步阻塞]
  → rdp-fs-provider.js syncRpc()  [JS sync XMLHttpRequest, 阻塞浏览器主线程]
  → POST /api/rdp/file-agents/:agentId/rpc  [Node.js HTTP handler]
  → file-agent-manager.js callAgentBinaryRead()  [Node.js → Agent WebSocket]
  → Flutter Agent (手机/平板本地文件系统) → 读取文件
  → Agent WS 响应 → file-agent-manager → HTTP 200 响应
  → sync XHR 返回 → rdp-fs-provider.js → Go WASM → IRP IO_COMPLETION → Windows
```

- [KNOWN] `rdpefs.go` 是 Go WASM 编译产物，处理 MS-RDPEFS 协议的全部 IRP 类型（CREATE/READ/WRITE/CLOSE/QUERY_INFO/SET_INFO/QUERY_DIRECTORY 等），共 2133 行。**置信度：HIGH。**
- [KNOWN] `rdp-fs-provider.js`（359 行）提供 `globalThis.zephyrRdpFs*` 同步函数，Go WASM 通过 `js.Global().Call()` 调用。**置信度：HIGH。**
- [KNOWN] `file-agent-manager.js`（999 行）管理 Flutter Agent WebSocket 连接和 RPC 转发。**置信度：HIGH。**

### 7.2 已证实的性能瓶颈

#### 瓶颈一：同步 XMLHttpRequest 阻塞浏览器主线程

- [KNOWN] `rdp-fs-provider.js:155-173` 的 `syncRpc()` 使用 `xhr.open('POST', ..., false)` 同步模式。**置信度：HIGH。**
- [KNOWN] 同步 XHR 在文档上下文中完全阻塞浏览器主线程：RDP 渲染、用户输入、WebSocket 收发全部暂停。**置信度：HIGH。**
- [INFERRED] 每次 IRP_MJ_READ（通常 64KB 块）需要一次完整的阻塞 HTTP 往返：Go WASM 被阻塞 → JS 主线程被阻塞 → HTTP 请求 → Node.js → Agent WS → 文件系统读取 → 逐层返回。LAN 环境下单次往返约 5-15ms，但阻塞导致无法并行。**置信度：HIGH。**

#### 瓶颈二：RDP rdpdr 协议的串行 IRP 处理

- [KNOWN] MS-RDPEFS 协议要求每个 IRP 发送 IO_COMPLETION 后才能处理下一个同设备 IRP。**置信度：HIGH。**
- [INFERRED] Windows 文件复制时发出大量 IRP_MJ_READ（典型 64KB 块），每个都必须等待同步 JS 调用返回。即使 Agent 和网络有剩余带宽，也无法流水线化。**置信度：HIGH。**

#### 瓶颈三：Base64 编码膨胀（写入路径）

- [KNOWN] `rdp-fs-provider.js:311-318` 的 `zephyrRdpFsWrite` 将 Uint8Array 逐字节转 binary string 再 `btoa()`，payload 膨胀 33%。**置信度：HIGH。**
- [INFERRED] 写入路径还经过 JSON 序列化/反序列化，进一步增加 CPU 开销。**置信度：HIGH。**

#### 瓶颈四：HTTP 往返开销

- [KNOWN] 每次读取都经历：浏览器 sync XHR → Node.js HTTP 解析 → `file-agent-manager` Agent WS 转发 → Agent 处理 → Agent WS 响应 → Node.js HTTP 响应序列化 → 浏览器 sync XHR 解析。**置信度：HIGH。**
- [INFERRED] HTTP 层对每个小请求（64KB）产生完整的请求/响应头、JSON 解析、连接管理开销。**置信度：HIGH。**

#### 瓶颈五：单 chunk 预取不足

- [KNOWN] `file-agent-manager.js:23` 设置 `BINARY_READ_PREFETCH_CHUNKS = 1`，仅预取下一个 chunk。**置信度：HIGH。**
- [INFERRED] 顺序读取模式下，每次新 chunk 仍需等待完整往返，无法利用 Agent 的预读能力。**置信度：HIGH。**

#### 瓶颈六：Go WASM 与 JS 的值拷贝

- [KNOWN] Go WASM 的 `js.Global().Call()` 在 Go 和 JS 之间传递值时，Uint8Array 需要跨边界拷贝。**置信度：HIGH。**
- [INFERRED] 对于大文件传输，每次 64KB 读取的跨边界拷贝累积起来相当可观。**置信度：MED。**

### 7.3 为什么当前架构无法突破 5 MB/s

- [COMPUTED] 假设每次 IRP_MJ_READ 64KB，单次往返 10ms（LAN），则理论最大吞吐量 = 64KB / 10ms = 6.4 MB/s。加上 HTTP 开销、JSON 序列化、SAB 拷贝，实际 5 MB/s 符合预期。**置信度：HIGH。**
- [COMPUTED] 即使将块大小提升到 1MB，串行往返模型仍然限制吞吐量：1MB / 10ms = 100 MB/s 理论值，但 Windows RDP 客户端通常不会发 1MB 的 IRP_MJ_READ。**置信度：HIGH。**
- [INFERRED] 瓶颈不在 Agent 或网络，而在浏览器的同步阻塞调用模型。**置信度：HIGH。**

### 7.4 Go WASM 重构方案：WebSocket + SharedArrayBuffer 直连

#### 7.4.1 核心思路

- [INFERRED] 将文件传输从 "Go WASM → sync XHR → HTTP → Node.js → Agent WS" 改为 "Go WASM → WebSocket → Node.js → Agent WS"，消除同步 XHR 和 HTTP 层。**置信度：HIGH。**
- [INFERRED] Go WASM 通过 `syscall/js` 调用浏览器 WebSocket API，与 Zephyr 服务器建立专用于文件传输的 WebSocket 连接。**置信度：HIGH。**
- [INFERRED] Go WASM 使用 SharedArrayBuffer + `Atomics.wait()` / `Atomics.notify()` 实现同步等待——与主 RDP 连接完全相同的模式。**置信度：HIGH。**

#### 7.4.2 架构变更

```text
【当前】
Go WASM rdpefs.go → js.Global().Call() → rdp-fs-provider.js sync XHR
  → HTTP /api/rdp/file-agents/:agentId/rpc → file-agent-manager.js → Agent WS

【重构后】
Go WASM rdpefs.go → syscall/js → 浏览器 WebSocket API
  → Zephyr Server 专用 file-transfer WS → file-agent-manager.go/server.go → Agent WS
```

- [INFERRED] Go WASM 内新增 `file-transfer.go`（或扩展现有 `rdpefs.go`），直接管理 WebSocket 连接和二进制帧协议。**置信度：HIGH。**
- [INFERRED] 浏览器端不再需要 `rdp-fs-provider.js` 的 syncRpc/syncXHR 部分；仅保留 SSE agent 状态订阅和 drive attach/detach 生命周期管理。**置信度：HIGH。**
- [INFERRED] 服务端新增或改造 file-transfer WebSocket 端点，直接对接 Agent WS 转发，跳过 HTTP 层。**置信度：HIGH。**

#### 7.4.3 Go WASM 文件传输协议

建议在 Go WASM 和 Zephyr 服务器之间使用二进制帧协议：

```text
请求帧（Go WASM → Server）:
  [4 bytes]  magic: 0x5A465432 ("ZFT2")
  [4 bytes]  requestId (uint32 BE)
  [2 bytes]  agentIdLen (uint16 BE)
  [N bytes]  agentId (UTF-8)
  [1 byte]   op: 0x01=open, 0x02=read, 0x03=write, 0x04=close,
                  0x05=stat, 0x06=list, 0x07=mkdir, 0x08=delete,
                  0x09=rename, 0x0A=truncate
  [2 bytes]  pathLen (uint16 BE)
  [N bytes]  path (UTF-8)
  [8 bytes]  offset (uint64 LE, for read/write)
  [4 bytes]  length (uint32 LE, for read)
  [N bytes]  data (for write)

响应帧（Server → Go WASM）:
  [4 bytes]  magic: 0x5A465432 ("ZFT2")
  [4 bytes]  requestId (uint32 BE)
  [1 byte]   status: 0x00=ok, 0x01=error
  [4 bytes]  dataLen (uint32 BE, for read/stat/list responses)
  [N bytes]  data (file content or JSON-encoded stat/list)
```

- [INFERRED] 协议直接使用二进制帧，不经过 JSON 或 base64 编码，消除了 33% 的写入膨胀。**置信度：HIGH。**
- [INFERRED] Go WASM 使用 `Atomics.wait()` 在 SAB 上阻塞等待响应，JS 侧通过 WebSocket `onmessage` 写入 SAB 并 `Atomics.notify()`。**置信度：HIGH。**

#### 7.4.4 Go WASM 实现结构

```text
rdp-wasm/
  file_transfer.go       # WebSocket 管理、帧编解码、SAB 同步
  file_transfer_test.go  # 协议单测
  rdpefs.go              # 修改：IRP handler 调用 file_transfer.go 而非 js.Global().Call()
```

- [INFERRED] `file_transfer.go` 负责：WebSocket 连接生命周期、请求/响应帧编解码、requestId 生成、SAB 同步原语。**置信度：HIGH。**
- [INFERRED] `rdpefs.go` 的改动最小化：将 `callAgentList/Stat/Open/Read/Write/Close/Mkdir/Delete/Rename/Truncate` 从 `js.Global().Call("zephyrRdpFs...")` 改为调用 `file_transfer.go` 的同步接口。**置信度：HIGH。**
- [INFERRED] 保留 `rdpefs.go` 的 IRP 解析、drive 生命周期、NT status 映射、handle 管理等全部已有逻辑，只替换数据获取层。**置信度：HIGH。**

#### 7.4.5 服务端 Go 文件传输模块

- [INFERRED] 新增 `file-transfer-server.go`（或作为 Node.js 的 sidecar 进程），监听专用 WebSocket 端口。**置信度：HIGH。**
- [INFERRED] 该模块直接对接 Agent WebSocket 连接池，接收 Go WASM 的二进制帧请求，转发到对应的 Flutter Agent，等待响应后以二进制帧返回。**置信度：HIGH。**
- [INFERRED] 如果服务端保持 Node.js，则新增 `file-transfer-ws.js` WebSocket 端点，复用 `file-agent-manager.js` 的 Agent 连接池，但使用二进制帧协议替代 HTTP JSON。**置信度：HIGH。**

#### 7.4.6 支持流水线化

- [INFERRED] Go WASM 的 `file_transfer.go` 支持多个并发 requestId（建议 4-8 个），每个在独立 SAB slot 上等待。**置信度：HIGH。**
- [INFERRED] 服务端对同一个 handle 的顺序读请求做流水线转发：Agent 支持时，发送多个 read 请求不等响应，Agent 按序返回。**置信度：HIGH。**
- [INFERRED] 即使 Agent 不支持流水线化，消除 sync XHR 的阻塞也足以将吞吐量提升到 20-50 MB/s（LAN 环境）。**置信度：MED。**

#### 7.4.7 浏览器端 JS 残余职责

- [INFERRED] `rdp-fs-provider.js` 精简为只保留：SSE Agent 在线状态订阅、`syncAgentDrives()` 生命周期管理、`attachDrive/detachDrive` 调用 Go WASM。**置信度：HIGH。**
- [INFERRED] 删除全部 `syncRpc()`、`rpcReadBytesBinary()`、`rpcReadBytesJson()`、`cachedRead()` 和 base64 编解码逻辑。**置信度：HIGH。**
- [INFERRED] 新增 `globalThis.rdpFileTransferConnect(url)` 和 `globalThis.rdpFileTransferOnMessage` 回调，连接 Go WASM 的 WebSocket 到 JS 层。**置信度：HIGH。**

### 7.5 预期性能提升

| 指标 | 当前 | 重构后 | 提升倍数 |
|---|---|---|---|
| 每次读取的阻塞机制 | sync XHR（阻塞主线程） | SAB + Atomics.wait（仅阻塞 Go goroutine） | 主线程完全释放 |
| 读取路径数据编码 | JSON base64（33% 膨胀） | 二进制帧（零膨胀） | 1.33× |
| 写入路径数据编码 | binary string + btoa（33% 膨胀） | 二进制帧（零膨胀） | 1.33× |
| HTTP 协议开销 | 完整 HTTP 请求/响应头 | WebSocket 帧头（2-10 字节） | ~10× 减少 |
| 可并发请求数 | 1（串行 IRP） | 4-8（流水线） | 4-8× |
| LAN 预期吞吐量 | 5 MB/s | 40-80 MB/s | 8-16× |

- [INFERRED] 上述预估基于消除 sync XHR 阻塞和 base64 膨胀；实际吞吐量取决于 Agent 设备的文件系统性能和网络延迟。**置信度：MED。**
- [INFERRED] 即使 Agent 不支持流水线化，消除 sync XHR 和 base64 后，LAN 环境应达到 20-30 MB/s。**置信度：MED。**

### 7.6 风险与约束

- [INFERRED] Go WASM 的 `syscall/js` 调用 WebSocket API 需要 JS 胶水代码来创建 WebSocket 对象、设置 onopen/onmessage/onerror 回调。Go WASM 不能直接 `new WebSocket()`。**置信度：HIGH。**
- [INFERRED] 多 requestId 并发需要确保 SAB 有足够的 slot，且 Go 的 goroutine 调度与 `Atomics.wait()` 兼容。**置信度：HIGH。**
- [INFERRED] 服务端可以选择 Go 实现或 Node.js 实现；Node.js 实现可以复用现有 `file-agent-manager.js` 的 Agent 连接池，改动更小。**置信度：HIGH。**
- [INFERRED] 需要确保 WebSocket 连接在 RDP 会话断开时正确清理，避免 Go WASM 中的 goroutine 泄漏。**置信度：HIGH。**
- [INFERRED] 不修改 Flutter Agent 端的任何代码；只改变浏览器到 Zephyr 服务器的传输层。**置信度：HIGH。**

### 7.7 文件传输性能测试

- [INFERRED] 基准测试：100MB 文件从 Agent 复制到 Windows，记录吞吐量和主线程 Long Task 数量。**置信度：HIGH。**
- [INFERRED] 压力测试：同时复制 3 个 500MB 文件，验证并发请求不互相阻塞。**置信度：HIGH。**
- [INFERRED] 回归测试：小文件（< 1KB）、空文件、目录遍历、文件属性查询的性能不退化。**置信度：HIGH。**
- [INFERRED] 断线测试：传输过程中 Agent 断开，验证 Go WASM 正确处理错误并清理资源。**置信度：HIGH。**
- [INFERRED] 移动端测试：在 Android/iOS 浏览器上验证 SAB 和 Atomics 可用性；若不支持则回退到 sync XHR 路径。**置信度：HIGH。**

---

## 8. 分阶段实施顺序

## Phase 0：基线与可观测性

- [INFERRED] 增加浏览器 E2E 基线：监控、终端输出/滚动/resize、登录重启恢复。**置信度：HIGH。**
- [INFERRED] 为 WS 错误增加结构化 code，但先不改变 UI 行为。**置信度：HIGH。**
- [INFERRED] 记录 terminal resize 次数、scroll action 次数、render 次数、stats duration 和 auth failure reason，不记录敏感数据。**置信度：HIGH。**

## Phase 1：修会话持久化

- [INFERRED] 先消除“随机重新登录”，因为后续大改和部署重启会频繁触发此问题。**置信度：HIGH。**
- [INFERRED] 新建 auth_sessions、迁移 currentSession、统一 Upgrade 身份、前端错误分类。**置信度：HIGH。**

## Phase 2：修监控闪烁和采集负载

- [INFERRED] 拆静态/动态采集，改显式 subscribe，前端稳定 DOM 和 Chart 实例。**置信度：HIGH。**
- [INFERRED] 将 Chart.js 本地化并补监控 E2E。**置信度：HIGH。**

## Phase 3：固定并修复 Zephyr WTerm fork

- [INFERRED] 将 `@wterm/dom/core 0.1.9` 固定到仓库 fork，先保持行为不变并建立可重复构建、upstream 基线测试和产物哈希检查。**置信度：HIGH。**
- [INFERRED] 在 WTerm 内实现公开 viewport state/event、程序滚动抑制、精确 scroll bottom 和单次 render commit；Zephyr 页面改用公开 API。**置信度：HIGH。**
- [INFERRED] 不引入 xterm.js，不增加双引擎设置，不保留迁移回退分支。**置信度：HIGH。**

## Phase 4：WTerm resize/reflow 修复并删除页面补丁

- [INFERRED] 在 WTerm core 增加稳定 row id、ResizeDelta 和语义 anchor 映射，DOM Renderer 做离屏构建和原子替换。**置信度：HIGH。**
- [INFERRED] 删除 Zephyr 页面六个私有 monkey patch、多阶段 timer、像素 scrollTop 恢复、PTY-only resize 和文本快照回灌。**置信度：HIGH。**
- [INFERRED] 达到桌面/手机/alt-screen/长输出测试门禁后，更新固定 WTerm fork 版本并保持唯一引擎。**置信度：HIGH。**

## Phase 5：笔记存储、API 与完整 UI

- [INFERRED] SQLite/API → 主导航笔记 view → 三栏桌面/分层手机布局 → CodeMirror 编辑/分屏/预览 → 搜索/分组/标签/连接关联 → 终端笔记侧窗 → 导入导出。**置信度：HIGH。**
- [INFERRED] 完成所有主题视觉回归、移动端和可访问性测试后才视为功能交付；只有 API 不算完成。**置信度：HIGH。**

## Phase 6：AI 笔记工具

- [INFERRED] 增加读写权限、确认策略、工具定义、执行器、revision 冲突处理、前端 side effect 刷新和审计测试。**置信度：HIGH。**

## Phase 7：HTTPS Deep Link、临时连接 UI 与一次性凭据

- [INFERRED] 先交付 SSH/JMS SSH/SFTP；所有入口必须打开复用现有添加连接窗口的 transient mode。**置信度：HIGH。**
- [INFERRED] transient mode 底部只保留“测试连接”和“连接”，不会调用保存 API；凭据全程 transient。**置信度：HIGH。**
- [INFERRED] 笔记内连接链接和 Web `web+zephyr:` 注册接入同一 parser 与临时连接 UI。**置信度：HIGH。**

## Phase 8：Telnet 与原生协议接管

- [INFERRED] Telnet transport 完成后开放 `telnet://`。**置信度：HIGH。**
- [INFERRED] Android/桌面原生壳注册 `ssh/telnet/jms`，Web 版保持 HTTPS fallback。**置信度：HIGH。**

## Phase 9：RDP 文件传输 Go WebSocket 重构

- [INFERRED] 新增 `rdp-wasm/file_transfer.go`：Go WASM WebSocket 管理、二进制帧编解码、SAB 同步原语、多 requestId 并发。**置信度：HIGH。**
- [INFERRED] 修改 `rdpefs.go` 的数据获取层，从 `js.Global().Call()` 改为调用 `file_transfer.go` 的同步接口；IRP 解析、drive 生命周期、NT status 映射保持不变。**置信度：HIGH。**
- [INFERRED] 精简 `rdp-fs-provider.js`：删除 syncRpc/syncXHR/base64 编解码，仅保留 SSE agent 状态和 drive attach/detach。**置信度：HIGH。**
- [INFERRED] 服务端新增 `file-transfer-ws.js` WebSocket 端点，使用二进制帧协议复用 `file-agent-manager.js` 的 Agent 连接池。**置信度：HIGH。**
- [INFERRED] 优先实现服务端 Node.js 方案以减小改动；Go 独立 sidecar 方案作为后续优化。**置信度：HIGH。**
- [INFERRED] 实现 4-8 并发 requestId 的流水线化；Agent 不支持时回退到串行但无 sync XHR 阻塞。**置信度：HIGH。**
- [INFERRED] 性能测试：100MB 文件 LAN 环境下吞吐量达到 40 MB/s 以上，主线程不出现 Long Task。**置信度：HIGH。**
- [INFERRED] 移动端 SAB/Atomics 可用性检测；不支持时回退到 sync XHR 路径。**置信度：HIGH。**

---

## 9. 文件级修改清单

### 现有文件

| 文件 | 修改 |
|---|---|
| `server.js` | [INFERRED] 持久 session store、WS 身份传递、stats subscribe、Deep Link prepare/consume、notes routes 接线。 |
| `storage.js` | [INFERRED] `auth_sessions`、`notes` schema/migration/CRUD/事务。 |
| `stats.js` | [INFERRED] 静态/动态/进程采集拆分、缓存、序号、超时隔离。 |
| `public/terminal.js` | [INFERRED] 改用 Zephyr WTerm 公开 viewport/fit/snapshot API，删除六个私有 monkey patch、多阶段滚动、像素恢复、文本回灌，并拆出监控逻辑。 |
| `public/terminal.html` | [INFERRED] 移除 Chart CDN；继续加载固定 Zephyr WTerm CSS/模块。 |
| `public/style.css` | [INFERRED] 保留 WTerm 必需主题样式，删除重复和用于操纵私有布局状态的 mobile override；加入笔记 view、终端笔记侧窗、临时连接 banner/state，全部复用现有主题变量。 |
| `public/app.js` | [INFERRED] 完整 Notes UI、Deep Link transient modal mode、测试/临时连接分流、AI note side effect、auth-expired 状态。 |
| `public/app.html` | [INFERRED] 顶部笔记入口、笔记三栏工作区、终端笔记入口、现有 connection modal 的 transient 状态元素和只含测试/连接的动作组、AI 权限设置。 |
| `public/rdp-fs-provider.js` | [INFERRED] 精简：删除 syncRpc/syncXHR/base64 编解码，仅保留 SSE agent 状态和 drive attach/detach；新增 `globalThis.rdpFileTransferConnect` 和消息回调。 |
| `rdp-wasm/rdpefs.go` | [INFERRED] 数据获取层从 `js.Global().Call()` 改为调用 `file_transfer.go` 同步接口；IRP 解析和驱动生命周期保持不变。 |
| `ai-agent-service.js` | [INFERRED] note 工具定义、执行器、确认与权限。 |
| `package.json` | [INFERRED] 指向固定 Zephyr WTerm fork、本地 Chart 依赖与 E2E test scripts；明确不加入 xterm.js。 |
| `package-lock.json` | [INFERRED] 锁定 WTerm fork 精确版本/提交和本地前端依赖。 |
| `Dockerfile` | [INFERRED] 构建/复制固定 WTerm fork 与本地 Chart 产物，不再依赖运行时 CDN。 |

### 建议新增文件

```text
vendor/wterm-zephyr/packages/core/
vendor/wterm-zephyr/packages/dom/
vendor/wterm-zephyr/tests/
session-store.js
notes-service.js
deeplink-service.js
telnet-session.js
public/open.html
public/open.js
public/notes.js
public/terminal-runtime.js
public/terminal-layout.js
public/terminal-mobile-input.js
public/terminal-monitor.js
tests/session-store.test.mjs
tests/wterm-viewport.test.mjs
tests/wterm-resize-anchor.test.mjs
tests/wterm-render-commit.test.mjs
tests/stats-sampler.test.mjs
tests/deeplink-parser.test.mjs
tests/deeplink-transient-token.test.mjs
tests/deeplink-transient-ui.test.mjs
tests/notes-storage.test.mjs
tests/notes-api.test.mjs
tests/ai-notes-tools.test.mjs
tests/e2e/wterm-resize-scroll.spec.mjs
tests/e2e/monitor-stability.spec.mjs
tests/e2e/session-restart.spec.mjs
tests/e2e/deeplink-transient-ui.spec.mjs
tests/e2e/notes-ui.spec.mjs
rdp-wasm/file_transfer.go
rdp-wasm/file_transfer_test.go
file-transfer-ws.js
tests/file-transfer-ws.test.mjs
tests/e2e/rdp-file-transfer.spec.mjs
```

---

## 10. CI 与发布门禁

- [INFERRED] 每次提交运行 Node syntax、unit、storage migration、API integration 和 Playwright desktop/mobile。**置信度：HIGH。**
- [INFERRED] 源码门禁禁止 Zephyr 业务层重新出现 `term._doRender`、`term._scheduleRender`、`term._scrollToBottom`、`term._shouldScrollToBottom` 等 WTerm 私有耦合；私有实现只能存在固定 WTerm fork 内并由其自身测试覆盖。**置信度：HIGH。**
- [INFERRED] 数据库迁移必须支持旧库升级、重复执行和失败回滚。**置信度：HIGH。**
- [INFERRED] Deep Link/notes 日志做 secret scanner，测试密码和 JMS token 不得出现在日志快照。**置信度：HIGH。**
- [INFERRED] 灰度指标至少包括：终端异常重连率、WS 401、SSH auth failure、resize/分钟、scroll correction/分钟、监控 render duration、stats exec duration。**置信度：HIGH。**
- [INFERRED] 固定 WTerm fork 每次发布必须验证源码提交、WASM/JS 产物哈希和 API contract；禁止静默回退 npm 原版或在 node_modules 上做未测试临时修改。**置信度：HIGH。**
- [INFERRED] 笔记与 Deep Link transient UI 必须通过桌面/手机及所有主题视觉回归；只有后端/API 通过不算功能完成。**置信度：HIGH。**
- [INFERRED] 数据库 session/notes 和 Deep Link schema 必须向前兼容；回滚不得删除用户笔记或将临时连接写入主机库。**置信度：HIGH。**

---

## 11. 不应采用的伪修复

- [INFERRED] **不要**迁移或混入 xterm.js；xterm.js 在本文只作为状态机原则参考，运行时和最终实现均保持 WTerm。**置信度：HIGH。**
- [INFERRED] **不要**继续增加更多 `setTimeout/requestAnimationFrame` 滚动阶段。**置信度：HIGH。**
- [INFERRED] **不要**在 resize 后恢复旧 pixel `scrollTop`。**置信度：HIGH。**
- [INFERRED] **不要**通过重新初始化 terminal buffer 并写回纯文本“修复”显示。**置信度：HIGH。**
- [INFERRED] **不要**把监控刷新频率从 1 秒改成 2 秒就宣称闪烁修复；整树重建仍然存在。**置信度：HIGH。**
- [INFERRED] **不要**仅延长 SESSION_TTL；进程重启和多副本仍会丢 Map。**置信度：HIGH。**
- [INFERRED] **不要**给 Deep Link 只做 parser/API 后就称为交付；必须有复用现有添加连接窗口的临时连接 UI，且只提供测试连接和连接。**置信度：HIGH。**
- [INFERRED] **不要**给笔记只做数据库/API/AI 工具；必须交付主导航笔记工作区、移动端 UI、编辑/预览和终端关联入口。**置信度：HIGH。**
- [INFERRED] **不要**把 Deep Link 密码写进 query、数据库连接资产或 localStorage；临时连接 UI 也不得把一次性密码/JMS token写成可读取的普通 DOM value。**置信度：HIGH。**
- [INFERRED] **不要**把“笔记”直接等同现有 AI Memory。**置信度：HIGH。**
- [INFERRED] **不要**在没有 Telnet transport 的情况下展示“支持 telnet://”。**置信度：HIGH。**
- [INFERRED] **不要**在纯网页里声称已接管操作系统 `ssh://`；必须如实区分 HTTPS/web+ scheme 与原生 handler。**置信度：HIGH。**
- [INFERRED] **不要**继续用同步 XMLHttpRequest 做文件传输 RPC；sync XHR 阻塞主线程是吞吐量瓶颈，不是增加块大小能解决的。**置信度：HIGH。**
- [INFERRED] **不要**把文件传输的 base64 编码路径当作正常行为保留；二进制帧协议是正确方案。**置信度：HIGH。**

---

## 12. 最终验收定义

### 监控

- [INFERRED] 监控连续刷新无整面闪烁、无滚动跳变、无输入失焦，折线历史正确，关闭面板后停止采集。**置信度：HIGH。**

### 终端

- [INFERRED] 唯一终端引擎保持 Zephyr WTerm；电脑窗口/分屏变化和手机键盘/旋转期间，贴底时稳定跟随，历史阅读时保留语义锚点，内容不闪、不乱序、不丢失，TUI 正常；Zephyr 业务层不访问 WTerm 私有方法。**置信度：HIGH。**

### 登录与连接

- [INFERRED] 服务重启和多副本不再让有效 Cookie 随机失效；SSH 连接错误与 Zephyr 登录失效明确区分。**置信度：HIGH。**

### Deep Link

- [INFERRED] SSH 与 JumpServer 一次性凭据进入统一 transient connection UI；该 UI 与现有添加连接窗口风格一致，底部只提供“测试连接”和“连接”，不会保存主机；Telnet 仅在 transport 完成后开放。**置信度：HIGH。**

### 笔记与 AI

- [INFERRED] 用户可从主导航和终端关联入口使用风格统一的笔记 UI，完成创建、编辑/分屏/预览、搜索、分组、标签、连接关联、导入导出和移动端操作；AI 可在权限与确认策略下按需读取和写入，且不会静默覆盖人工编辑。**置信度：HIGH。**

### RDP 文件传输

- [INFERRED] 在 LAN 环境下，100MB 文件从 Zephyr Agent 到 Windows 的吞吐量不低于 40 MB/s；主线程不被传输阻塞，RDP 画面和交互保持流畅。**置信度：HIGH。**

---

## 13. 参考源码位置

- [KNOWN] Zephyr 监控：`public/terminal.js:6463-6562, 7840-8218`；`server.js:4388-4418`；`stats.js:1-323`。**置信度：HIGH。**
- [KNOWN] Zephyr 滚动/resize：`public/terminal.js:1320-2136, 6464-7770, 8229-8425, 9588-9945`。**置信度：HIGH。**
- [KNOWN] Zephyr session/WS：`server.js:89, 282-317, 1341-1356, 4151-4187, 4744-4790`。**置信度：HIGH。**
- [KNOWN] WTerm 发布包：`@wterm/dom 0.1.9`、`@wterm/core 0.1.9`；重点实现为 DOM `WTerm`、Renderer 和 WASM Bridge。**置信度：HIGH。**
- [KNOWN] xterm.js 仅作设计原则对照：`src/browser/Viewport.ts:125-225`、`src/browser/CoreBrowserTerminal.ts:708-732`、`src/common/buffer/Buffer.ts:180-490`；不作为 Zephyr 依赖或迁移目标。**置信度：HIGH。**
- [KNOWN] Netcatty Deep Link：`electron/deepLink.cjs`、`electron/main.cjs:547-910`、`domain/sshDeepLink.ts`、`domain/telnetDeepLink.ts`、`domain/jmsDeepLink.ts`。**置信度：HIGH。**
- [KNOWN] Netcatty Notes/AI：`domain/notes.ts`、`components/notes/*`、`infrastructure/ai/vaultAgentBridgeClient.ts:562-632`。**置信度：HIGH。**
- [KNOWN] 许可证：Zephyr 与 Netcatty 均为 GPL-3.0；xterm.js 为 MIT。**置信度：HIGH。**
- [KNOWN] Zephyr RDP 文件传输：`rdp-wasm/rdpefs.go:1-2133`（Go WASM rdpdr IRP 处理）、`public/rdp-fs-provider.js:1-359`（JS 同步 RPC 桥）、`file-agent-manager.js:1-999`（Node.js Agent WS 管理）、`public/rdp-wasm-client.js`（WASM 加载与 SAB 桥）。**置信度：HIGH。**
- [KNOWN] MS-RDPEFS 协议：`[MS-RDPEFS].pdf`（RDP 文件系统虚拟通道扩展）、`[MS-RDPDR].pdf`（RDP 设备重定向静态虚拟通道）。**置信度：HIGH。**

---

