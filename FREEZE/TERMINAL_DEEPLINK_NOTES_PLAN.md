# Zephyr SSH 终端稳定性、会话可靠性、Deep Link、AI 笔记、多用户权限、协同与持久任务统一改造方案

> [KNOWN] 审计基线：`Lanlan13-14/zephyr-ssh` `main` / `v1.1.447`，提交 `a2b917ed08a5645d1bc5d400946b2acb76934cdf`。  
> [KNOWN] 对照基线：`@wterm/dom 0.1.9` / `@wterm/core 0.1.9` 实际发布包；`xtermjs/xterm.js` 提交 `8aab310366549d8d865bd8fc4bd509051f2bb2a1` 仅用于分析成熟终端的视口与重排原则；`binaricat/Netcatty` 提交 `56216dbf4779b31b83c170859e93cfe6e6b795b8` 用于 Deep Link 与笔记功能参考。  
> [KNOWN] 产品约束：**继续使用 WTerm，不迁移到 xterm.js，不引入 xterm.js 运行时依赖。**  
> [KNOWN] UI 约束：笔记必须有完整可操作 UI；Deep Link 必须有 UI，并复用现有添加连接窗口的视觉与表单组件。临时连接模式不保存资产，底部业务动作只保留“测试连接”和“连接”。  
> [KNOWN] 审计日期：2026-07-11。  
> [KNOWN · HIGH] 多用户整合补充审计基线：当前本地 `main` 提交 `80b98a1`；原技术审计的文件行号仍对应其声明的旧基线，实施前必须在目标提交上重新核对。
>
> [KNOWN · HIGH] 本文已把原独立多用户规格并入同一主文档；多用户、资源 ACL、工作区恢复和持久任务是 Deep Link、笔记、AI、终端与 Agent 能力的前置横切约束。
>
> [INFERRED · HIGH] 多用户默认安全边界：用户资源默认私有，管理员资源按 capability 共享，管理员不自动获得用户私有秘密，浏览器关闭只断开订阅而不取消持久任务。
>
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
7. [INFERRED · HIGH] 用户、认证会话、连接、代理、密钥、笔记、AI 资源、工作区、终端会话、Agent Token 和后台任务全部使用不可变 `userId` 归属，并通过统一 ACL 在服务端授权。**置信度：HIGH。**
8. [INFERRED · HIGH] 工作区按 `userId + clientId + workspaceId` 保存；重新打开浏览器时只恢复当前用户仍有权访问的页面、标签和任务订阅，不重放危险输入或自动确认。**置信度：HIGH。**
9. [INFERRED · HIGH] SSH/Codex 等长任务使用远端 tmux/持久 Agent 或独立 Worker；AI 长操作改为持久任务与事件流，不能继续绑定单次浏览器 `fetch`。**置信度：HIGH。**
10. [INFERRED · HIGH] AI 支持 `disabled/admin_shared/self_managed/both` 四种用户策略；共享管理员 Provider 只授予调用权，不暴露 API Key。**置信度：HIGH。**

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
  user_id TEXT NOT NULL,
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
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
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

- [INFERRED] token 与 Zephyr `userId` 绑定，默认 60 秒过期；测试连接可在过期前重复使用但不会续期，正式 connect 原子领取并删除 token。**置信度：HIGH。**
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
  owner_user_id TEXT NOT NULL,
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
CREATE INDEX idx_notes_owner_updated ON notes(owner_user_id, updated_at DESC);
CREATE INDEX idx_notes_owner_group ON notes(owner_user_id, group_path);
```

- [INFERRED] 所有 CRUD 必须按认证主体的不可变 `userId` 和 note ACL 过滤，不能只凭 note id。**置信度：HIGH。**
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

---

## 8. 产品目标与最终行为

### 8.1 用户要得到的行为

[INFERRED · HIGH] 用户 A 在设备 A 登录 Zephyr 后，可以打开自己的连接、管理员共享给他的连接、自己的笔记和 AI 任务；关闭浏览器后，重新登录同一账号时，系统只恢复属于该账号和该浏览器实例的工作区，不加载其他用户的标签、任务、聊天或私有资源。

[INFERRED · HIGH] 用户 B 登录同一 Zephyr 实例时，系统加载 B 自己的工作区和 B 有权访问的共享资源；B 不会因为使用同一服务器、同一浏览器设备或同一个管理员账号的资源而看到 A 的私有数据。

[INFERRED · HIGH] 浏览器关闭只应断开页面订阅，不应自动取消已经转交给持久任务执行器的 SSH、AI 或其他后台任务；用户回来后可以通过任务 ID 重新订阅输出和结果。

[INFERRED · HIGH] 管理员可以控制用户 A 能否发现、连接、查看、输入、执行命令、使用文件传输或修改某个管理员资源；这些能力应按资源和操作分别授权，而不是只有一个“能用/不能用”开关。

[INFERRED · HIGH] 用户 A 默认可以创建自己的 SSH/RDP/VNC 连接、代理、SSH 密钥、笔记和个人 AI 配置；这些资源默认仅 A 可见，不自动出现在管理员列表中。A 可以显式把资源或指定操作权限共享给管理员或其他用户。

[INFERRED · HIGH] 用户可以修改自己的密码、绑定自己的邮箱、配置自己的 MFA/Passkey，并通过属于自己的邮箱完成密码找回；管理员可以执行账号管理和强制失效会话，但默认不能读取用户的旧密码、连接密码、私有 AI API Key 或私有笔记正文。

[INFERRED · HIGH] 管理员配置的系统默认外观、平台安全策略和共享 AI 供应商，与用户自己的个性化设置、个人 AI 供应商和个人工作区分离。用户可以覆盖允许覆盖的页面配置，不会修改管理员页面或其他用户页面。

### 8.2 不能接受的实现

[INFERRED · HIGH] 不能只把 `username` 放进前端请求或 localStorage 就宣称完成隔离；服务端每一个 HTTP 路由、WebSocket upgrade、WebSocket 消息、后台任务、AI 工具调用、文件代理调用和导出接口都必须重新验证当前会话与资源 ACL。

[INFERRED · HIGH] 不能继续让所有用户共用一份全局 `connections`、`settings`、AI provider、Memory、notes 或活动日志，然后在前端按用户过滤；这种结构会造成越权读取和交叉修改。

[INFERRED · HIGH] 不能把关闭浏览器后的任务继续执行建立在浏览器 `fetch`、页面 JavaScript、单个 WebSocket 或 Node 进程内的临时 Map 上；页面和进程都可能消失。

[INFERRED · HIGH] 不能把管理员角色等同于“自动拥有所有用户私有资源的明文秘密”。管理员需要平台治理能力，但私有资源的秘密读取必须是独立权限，并且默认关闭、显式确认、完整审计。

## 9. 当前代码基线与改造原因

### 9.1 当前已经存在的基础

[KNOWN · HIGH] 当前项目已经使用 SQLite 存储用户、连接、设置、安全事件等部分数据，并保留了从旧 JSON 文件迁移的逻辑。

[KNOWN · HIGH] 当前 `users` 表已经有用户名、密码哈希、邮箱、TOTP、登录失败和锁定字段；但现有用户模型还没有完整的不可变 `userId`、角色、状态、资源归属和通用 ACL 模型。

[KNOWN · HIGH] 当前 Web 会话主要保存在 `server.js` 进程内的 `sessions` Map；有效 Cookie 对应的会话在进程重启或多实例分流时不能可靠恢复。

[KNOWN · HIGH] 当前 SSH 活跃会话保存在进程内的 `sshTerminalSessions` Map；WebSocket 断开时已有 detach 逻辑，但该会话及其 SSH 连接不是跨进程持久任务。

[KNOWN · HIGH] 当前 `public/app.js` 的终端标签、活动标签和布局数组主要是页面内存状态；SSH/RDP 参数还使用了按 tabId 命名的 `sessionStorage` 条目，因此不能作为跨关闭、跨账号的可靠工作区存储。

[KNOWN · HIGH] 当前 AI 设置通过全局 settings 的 `ai` 对象保存 provider、skills、Memory、plans 和环境变量；当前代码没有按用户拆分这些对象，也没有完整的管理员 AI 授权层。

[KNOWN · HIGH] 当前 `/api/ai/chat` 在请求或响应关闭时触发 AbortController；这意味着页面关闭会取消当前同步 AI 请求，而不是把它转为独立后台任务。

[KNOWN · HIGH] 当前部分连接接口仍直接读取旧的 `connections.json`，而不是统一经过带用户过滤的 SQLite 资源服务；多用户改造前必须消除这种双数据源。

[KNOWN · HIGH] 当前忘记密码流程使用第一个用户和全局管理员邮箱作为重置对象，不满足每个用户独立找回密码的要求。

### 9.2 前述技术方案中尚未完成的相关能力

[KNOWN · HIGH] 本文第 4–7 节将持久登录会话、WTerm 视口/resize 修复、监控订阅、HTTPS Deep Link、临时连接 UI、笔记 UI/AI 工具和 RDP 文件传输重构列为后续方案，而不是当前已完成能力。

[INFERRED · HIGH] 多用户 ACL 必须先成为这些能力的横切基础；否则先按单用户实现，再补用户隔离，会导致 notes、Deep Link token、terminal session、AI task、Agent token 和 workspace 全部返工。

[INFERRED · HIGH] 本文前述方案中的所有“持久化”对象都必须增加 `ownerUserId` 或等价的主体字段；所有“共享”对象都必须通过统一 ACL 服务计算有效权限；所有“自动恢复”对象都必须检查当前用户是否仍然有权访问。

## 10. 术语、范围与默认决策

### 10.1 术语

[INFERRED · HIGH] **安装实例**指一套 Zephyr 服务、数据库和配置；本文不把不同安装实例之间的用户数据混合起来。

[INFERRED · HIGH] **用户**指可以登录 Web UI 的人；每个用户有不可变 `userId`，用户名只是可修改的登录标识，不得作为资源外键。

[INFERRED · HIGH] **管理员**指具有平台管理权限的用户角色；管理员权限和某个连接资源的秘密读取权限是两组不同能力。

[INFERRED · HIGH] **资源**指连接、代理、SSH 密钥、跳板机、笔记、AI provider、AI 会话、终端会话、后台任务、Agent token、工作区和其他需要归属或授权的对象。

[INFERRED · HIGH] **拥有者**指资源的 `ownerUserId` 对应用户；拥有者负责资源的普通编辑、删除和分享，除非平台策略另有明确限制。

[INFERRED · HIGH] **共享**指通过 ACL 把某资源的一个或多个能力授予另一个用户；共享不转移所有权。

[INFERRED · HIGH] **工作区**指某个用户在某个浏览器实例中的视图、终端标签、布局、选中的连接、AI 面板状态和待恢复订阅信息；工作区不包含密码、私钥、API Key 等秘密。

[INFERRED · HIGH] **持久任务**指脱离当前浏览器请求后仍可运行、拥有任务 ID、状态、事件日志和退出结果的执行单元。

[INFERRED · HIGH] **协同会话**指多个已授权用户同时观察或操作同一个终端/RDP/任务；协同会话必须区分观察权限和控制权限。

### 10.2 默认决策

| 项目 | 默认行为 |
|---|---|
| 新建普通用户 | [INFERRED · HIGH] 允许登录；默认不能看到任何管理员设备，不能使用 AI，不能创建资源，除非管理员策略开启。 |
| 用户新建连接 | [INFERRED · HIGH] 归当前用户所有，默认私有，不显示给管理员或其他用户。 |
| 管理员设备 | [INFERRED · HIGH] 归管理员所有，默认仅管理员可用；管理员通过 ACL 指定 A 可以做什么。 |
| 用户分享给管理员 | [INFERRED · HIGH] 默认允许用户主动选择是否分享；管理员列表不会自动扫描用户私有设备。管理员可通过平台策略关闭该能力。 |
| 管理员查看用户私有资源 | [INFERRED · HIGH] 默认不允许读取连接秘密、私有笔记正文、私有 AI 内容；管理员仍可禁用账号、撤销会话和执行平台级安全处置。 |
| 页面恢复 | [INFERRED · HIGH] 按 `userId + clientId` 恢复；恢复 UI 和订阅，不自动重复执行危险动作。 |
| 任务恢复 | [INFERRED · HIGH] 任务由服务端 Worker、远端 tmux/后台进程或其他持久执行器继续；浏览器只重新订阅。 |
| AI | [INFERRED · HIGH] 默认关闭普通用户 AI；管理员可以授予管理员共享 AI、允许用户自带 AI，或两者同时允许。 |
| 自定义 JavaScript | [INFERRED · HIGH] 普通用户默认关闭；若开放，必须在隔离沙箱或受限能力模型中运行，不能让用户脚本直接读取全站 Cookie、其他用户数据或管理员设置。 |

### 10.3 范围

[INFERRED · HIGH] 本规格覆盖账号与会话、资源归属、ACL 分享、工作区恢复、SSH/AI 持久任务、终端协同、个人设置、AI 权限、Deep Link、笔记、RDP Agent/文件传输和本文前述技术方案的权限接入。

[INFERRED · MED] 本规格暂不要求多安装实例联邦登录、组织/部门层级、计费系统、跨实例资源复制或完整企业目录同步；这些可以在稳定的单实例用户/ACL模型上后续扩展。

## 11. 用户、角色与账号生命周期

### 11.1 角色模型

| 角色 | 平台能力 | 资源默认范围 |
|---|---|---|
| `admin` | [INFERRED · HIGH] 管理用户、全局策略、系统默认配置、共享管理员资源、审计和平台运行状态。 | [INFERRED · HIGH] 自己拥有的资源；其他用户私有资源仅在显式 ACL 或 break-glass 策略下可见。 |
| `user` | [INFERRED · HIGH] 使用被授予的资源，管理自己的资源、工作区、笔记、个人设置和被允许的 AI。 | [INFERRED · HIGH] 自己拥有的资源与显式共享资源。 |
| `service` | [INFERRED · MED] 仅供 Agent/Worker 使用，不提供普通 Web 登录。 | [INFERRED · HIGH] 由任务或资源 ACL 限定的最小范围。 |

[INFERRED · HIGH] 第一版可以继续保留一个初始 `admin` 账号，但数据库和授权代码应使用角色字段而不是硬编码用户名 `admin`；这样改名、增加第二管理员或迁移账号时不会破坏权限。

[INFERRED · HIGH] 管理员用户的创建、删除、降级和最后一个管理员保护必须是事务操作；系统不得允许把最后一个可用管理员降级或删除后无法管理实例。

### 11.2 用户状态

[INFERRED · HIGH] 用户状态至少包括 `active`、`invited`、`suspended`、`deleted`；被暂停用户不能创建新会话，也不能继续建立新的 WebSocket/任务订阅。

[INFERRED · HIGH] 暂停用户的后台任务默认继续或暂停应由管理员策略决定；安全默认是停止新的危险操作、保留已有任务日志、允许管理员处理任务，而不是静默删除数据。

[INFERRED · HIGH] 删除用户必须先执行资源处置策略：转移给管理员、全部删除、保留为不可访问归档或逐项选择；不得因为删除账号而把资源无主地留在可访问列表中。

### 11.3 密码、找回与 MFA

[INFERRED · HIGH] 每个用户都有自己的密码哈希、邮箱和密码更新时间；密码修改接口只修改当前用户，不得再读取旧 JSON 文件或第一个用户。

[INFERRED · HIGH] 忘记密码请求按用户名/邮箱匹配目标用户，但响应必须使用统一文案，避免泄露账号是否存在；验证码记录必须绑定 `userId`、邮箱、过期时间、使用状态和请求风控信息。

[INFERRED · HIGH] 管理员可以为用户发起“发送重置邮件”“强制下次登录改密”“撤销全部会话”，但不能看到用户当前密码；管理员直接设置新密码时必须明确标记为管理员操作并强制用户下次登录改密。

[INFERRED · HIGH] TOTP Secret、Passkey、公钥凭据和密码重置记录都必须按 `userId` 隔离；重命名用户名不能破坏凭据关联。

[INFERRED · HIGH] 密码修改、重置、角色变化、账号暂停和管理员撤销会话都应使相关认证会话失效或重新验证，避免旧 Cookie 继续使用过期权限。

## 12. 资源归属与统一 ACL

### 12.1 资源归属原则

[INFERRED · HIGH] 每个持久资源都必须有明确的 `ownerUserId`，或者明确标记为 `system` 资源；不能用“当前请求是谁”在读取时临时推断所有权。

[INFERRED · HIGH] 资源 ID 使用随机 UUID/不可预测 ID；ID 本身不构成授权，服务端仍必须查询当前用户的有效 ACL。

[INFERRED · HIGH] 资源列表接口默认只返回当前用户拥有或被授予 `discover` 权限的资源；搜索、排序、分页和导出也必须在过滤后的集合上执行。

[INFERRED · HIGH] 资源删除、转移所有权、分享和修改 ACL 都必须在事务中检查拥有者、管理员策略和目标用户状态，防止并发请求绕过权限。

### 12.2 需要纳入归属/ACL的资源

| 资源 | 默认拥有者 | 需要的最小访问判断 |
|---|---|---|
| SSH/RDP/VNC 连接 | [INFERRED · HIGH] 创建者 | [INFERRED · HIGH] 发现、查看元数据、连接、终端控制、RDP 输入、SFTP、Docker、编辑、分享、删除、秘密读取分开判断。 |
| 代理、SSH 密钥、跳板机 | [INFERRED · HIGH] 创建者 | [INFERRED · HIGH] 连接资源只能间接使用被授权的依赖，不得因知道 connectionId 自动获得依赖秘密。 |
| 终端/远程桌面会话 | [INFERRED · HIGH] 启动者 | [INFERRED · HIGH] 观察、控制、共享控制、结束、读取输出分别判断。 |
| 后台任务与任务事件 | [INFERRED · HIGH] 创建者 | [INFERRED · HIGH] 查看、订阅、暂停、取消、重试、确认和分享分别判断。 |
| 笔记 | [INFERRED · HIGH] 创建者 | [INFERRED · HIGH] 读取、编辑、评论/协同、分享、删除分别判断。 |
| AI Provider/API Key | [INFERRED · HIGH] 创建者或系统 | [INFERRED · HIGH] 使用权与查看/导出 API Key 永远分开；共享 provider 只向获授权用户发起服务端请求。 |
| AI 对话、Memory、计划、环境变量 | [INFERRED · HIGH] 当前用户 | [INFERRED · HIGH] 按用户隔离；共享时只授予明确的读/写或执行能力。 |
| 浏览器自动化会话/截图 | [INFERRED · HIGH] AI 任务拥有者 | [INFERRED · HIGH] 绑定 `userId + aiTaskId/conversationId`，其他用户不能用猜到的 session 名称访问。 |
| Zephyr Agent Token/磁盘映射 | [INFERRED · HIGH] 创建者或被授权连接拥有者 | [INFERRED · HIGH] Token、Agent、RDP 会话和文件读写权限必须同时匹配。 |
| 工作区、标签、布局、个人 snippets | [INFERRED · HIGH] 当前用户和 clientId | [INFERRED · HIGH] 不能被其他用户恢复或读取；管理员只能看到必要运行元数据。 |
| 活动日志、审计日志 | [INFERRED · HIGH] 系统记录 | [INFERRED · HIGH] 普通用户只能看自己的可公开活动；管理员看平台审计，但敏感字段脱敏。 |

### 12.3 权限原子项

[INFERRED · HIGH] 统一 ACL 不应只存一个布尔值；建议使用以下能力集合，资源可以只授予其中一部分：

```text
resource.discover       出现在列表/搜索结果中
resource.view           查看非秘密元数据
resource.use            发起连接或使用 provider
resource.observe        查看实时输出/画面/统计
resource.control        发送终端输入、RDP 输入或任务控制指令
resource.execute        执行远程命令/高风险工具
resource.fileRead       读取远程文件
resource.fileWrite      写入、删除或重命名远程文件
resource.edit           修改资源配置
resource.share          修改该资源的共享对象
resource.delete         删除资源
resource.revealSecret   查看密码、私钥、API Key 等明文秘密
resource.administer     资源级强制处置或转移所有权
```

[INFERRED · HIGH] `resource.use` 不应自动包含 `resource.revealSecret`；服务端可以用加密保存的秘密代替用户发起连接，而不把秘密返回给浏览器。

[INFERRED · HIGH] `resource.control` 不应自动包含 `resource.execute`；用户可能被允许观察和输入普通终端，但不允许 AI 或批量执行工具在该设备执行命令。

### 12.4 权限档位

| 档位 | 包含能力 | 适用场景 |
|---|---|---|
| `observer` | [INFERRED · HIGH] `discover/view/observe` | [INFERRED · HIGH] 只看设备信息、终端输出或远程桌面。 |
| `operator` | [INFERRED · HIGH] `observer + use/control` | [INFERRED · HIGH] 可连接、输入和交互，但不能改资产配置。 |
| `file-operator` | [INFERRED · HIGH] `operator + fileRead/fileWrite` | [INFERRED · HIGH] 允许文件管理或 RDP 文件映射。 |
| `executor` | [INFERRED · HIGH] `operator + execute` | [INFERRED · HIGH] 允许远程命令/危险 AI 工具，仍受确认策略限制。 |
| `editor` | [INFERRED · HIGH] `operator + edit` | [INFERRED · HIGH] 可修改连接参数，不自动获得秘密读取。 |
| `manager` | [INFERRED · HIGH] 以上能力加 `share/delete` | [INFERRED · HIGH] 资源拥有者或被明确授权的管理员。 |

[INFERRED · HIGH] UI 可以展示档位快捷选择，但数据库最终应保存展开后的 capability 集合或可审计的 policy version，避免以后修改档位定义时悄悄扩大旧授权。

### 12.5 有效权限计算

[INFERRED · HIGH] 一次操作的有效权限应按以下顺序计算：

```text
有效权限
= 用户状态允许
∩ 平台全局策略允许
∩ 角色上限允许
∩ 资源拥有权或 ACL 允许
∩ 依赖资源 ACL 允许
∩ 当前会话/任务状态允许
∩ 操作安全确认条件满足
```

[INFERRED · HIGH] 任何一层拒绝都应在服务端返回结构化错误，例如 `forbidden_resource_control`、`forbidden_ai_remote_execute` 或 `resource_not_found_or_inaccessible`；对普通用户可把不存在和无权访问统一为 404，避免资源枚举。

## 13. 管理员与普通用户的设备共享

### 13.1 管理员设备共享给用户 A

[INFERRED · HIGH] 管理员在“用户管理 → 用户 A → 资源授权”或连接详情的“共享”面板中选择设备、权限档位、有效期和是否允许协同。

[INFERRED · HIGH] 管理员可以授予 A 只读、操作、文件操作、命令执行、编辑或管理权限；每项权限都应在 UI 显示实际影响，例如“允许发送终端输入”“允许 Docker 重启”“允许读取远程文件”。

[INFERRED · HIGH] A 登录后在连接列表中看到“管理员共享”分组和资源来源；A 可以使用资源但不应看到管理员保存的密码、私钥、代理密码或 API Key 明文。

[INFERRED · HIGH] 管理员撤销共享后，A 的新请求立即被拒绝；已打开的 WebSocket/协同会话应在短时间内收到权限撤销事件并按策略变为只读或关闭。

[INFERRED · HIGH] 共享管理员设备所依赖的代理、跳板机和 SSH 密钥必须作为依赖授权一并解析；用户不能通过修改路由字段把连接跳转到未授权的代理或跳板机。

### 13.2 用户 A 自己添加设备

[INFERRED · HIGH] 当平台策略 `allowUserOwnedResources` 开启时，A 可以新建 SSH/RDP/VNC 连接；新资源的 `ownerUserId` 必须是 A 的不可变 `userId`。

[INFERRED · HIGH] A 的资源默认 `visibility=private`，不会出现在管理员的普通连接列表、管理员 AI 的 `list_connections`、管理员活动摘要或其他用户搜索结果中。

[INFERRED · HIGH] A 可以在资源分享面板选择“共享给管理员”“共享给指定用户”或“生成协同邀请”；默认选项必须是“不共享”。

[INFERRED · HIGH] A 分享给管理员时可以只授予 `observe` 或 `use`，不必授予 `revealSecret`、`edit` 或 `delete`；管理员不能通过管理员角色自动扩大这项 ACL，除非启用并触发 break-glass 流程。

[INFERRED · HIGH] A 删除自己的设备时，相关共享、协同会话、任务依赖和恢复条目必须进入一致的失效流程；已运行的远程任务是否继续由任务策略决定，但不能再创建新的连接操作。

### 13.3 管理员对用户私有资源的治理边界

[INFERRED · HIGH] 默认管理员可以执行以下平台治理动作：暂停账号、撤销会话、撤销共享、禁用 Agent Token、停止由该用户拥有的危险后台任务、查看资源数量/状态和审计元数据。

[INFERRED · HIGH] 默认管理员不能执行以下读取动作：读取用户私有连接密码/私钥、读取私有 AI API Key、读取私有笔记正文、读取私有 AI 对话内容、接管用户私有终端输入。

[INFERRED · MED] 可选的 break-glass 功能可以在系统设置中关闭；若开启，管理员必须填写原因、进行二次确认，系统记录操作者、目标用户、资源、字段、时间和结果，并尽量只授予一次性最小能力。

[INFERRED · HIGH] 这是产品权限边界，不是依靠 UI 隐藏实现；所有秘密读取和强制接管都必须经过独立服务端授权函数和审计记录。

### 13.4 协同控制

[INFERRED · HIGH] SSH 终端允许多个用户同时观察，但同一时刻默认只有一个 `controller` 可以发送输入；其他用户是 `observer`，可以申请控制权。

[INFERRED · HIGH] 控制权采用租约或显式锁，包含 `holderUserId`、取得时间、过期时间和最后心跳；浏览器关闭、会话断开或超时后自动释放。

[INFERRED · HIGH] RDP/VNC 默认允许多个观察者但只允许一个输入控制者；剪贴板、文件传输、Ctrl+Alt+Del 等高影响动作还需单独 capability。

[INFERRED · HIGH] 任务协同至少支持 `observe`、`approve`、`control` 三种角色；“能看任务”不能自动获得“能取消任务”或“能批准危险操作”。

[INFERRED · HIGH] 所有协同输入、控制权转移、任务暂停/恢复和确认操作都写入审计日志，并标记真实操作者，而不是只记录任务拥有者。

## 14. 用户工作区、跨设备恢复与任务持久化

### 14.1 工作区隔离模型

[INFERRED · HIGH] 工作区主键建议为 `(userId, clientId, workspaceId)`：`userId` 保证账号隔离，`clientId` 区分设备/浏览器实例，`workspaceId` 支持用户建立多个工作区。

[INFERRED · HIGH] `clientId` 可以首次登录后由浏览器生成并保存在该浏览器的 localStorage，但它只用于选择恢复槽位，不用于授权；服务端永远以认证会话中的 `userId` 为准。

[INFERRED · HIGH] 同一用户在设备 A 和设备 B 登录时，默认恢复两个独立工作区，避免 A 的终端标签和 B 的标签互相覆盖；用户可以显式选择“复制工作区”或“在其他设备打开”。

[INFERRED · HIGH] 同一浏览器先登录 A、退出再登录 B 时，内存状态、嵌入 iframe、AI 面板、待确认项和本地缓存都必须清理或换到 B 的命名空间；不能继续显示 A 的数据。

[INFERRED · HIGH] 工作区保存内容至少包括：当前 view、活动 tab、终端 tab 元数据、布局、窗口顺序、面板开关、筛选器、笔记选中项、AI 当前会话 ID、待恢复任务 ID和版本号。

[INFERRED · HIGH] 工作区禁止保存：SSH 密码、私钥、RDP 密码、代理密码、API Key、TOTP Secret、JMS token、一次性 Deep Link 密码以及完整敏感终端输出，除非另有加密任务日志策略。

### 14.2 启动恢复流程

[INFERRED · HIGH] 登录成功后客户端调用一个原子 bootstrap 接口，服务端一次性返回当前用户、有效能力摘要、可见资源摘要、工作区元数据、未完成任务摘要和待确认事项摘要。

[INFERRED · HIGH] 客户端按照以下顺序恢复：

```text
验证 App 会话
→ 获取用户 bootstrap
→ 读取 userId + clientId 对应工作区
→ 再次过滤资源 ACL
→ 恢复视图和 tab 元数据
→ 对每个 tab 建立新的受权连接/订阅
→ 回放任务事件和终端历史
→ 恢复未完成 AI 确认界面
```

[INFERRED · HIGH] 恢复过程不能自动重发上次的键盘输入、不能重复提交表单、不能再次执行远程命令、不能自动批准 AI 敏感操作；只能恢复页面状态并等待用户明确操作。

[INFERRED · HIGH] 如果资源已经删除、被撤销共享或用户权限降低，工作区显示“无权访问/资源已移除”的占位项，不应通过旧 tabId 越权重连。

[INFERRED · HIGH] 如果服务端实例发生重启，客户端应显示“正在恢复服务端会话/任务订阅”，而不是直接把远端 SSH 错误显示成需要重新登录。

### 14.3 SSH 长任务

[INFERRED · HIGH] 需要跨浏览器关闭、Node 重启继续执行的命令必须进入持久执行层，例如远端 `tmux`/`screen`、远端后台进程加日志、或独立 Worker；普通 WebSocket PTY 只能作为实时交互通道，不能是唯一任务存储。

[INFERRED · HIGH] 每个长任务至少保存 `taskId`、`ownerUserId`、目标连接 ID、远端会话标识/PID、命令摘要、日志位置、状态、退出码、开始/结束时间和最后心跳。

[INFERRED · HIGH] 任务日志应按事件或分段持久化，并设置最大容量、轮转和脱敏策略；不能无限把所有输出存进 Node 内存。

[INFERRED · HIGH] 浏览器关闭后，服务端保留任务执行；用户回来时先检查任务 ACL，再从持久日志回放历史，最后订阅新增事件。

[INFERRED · HIGH] 交互式 `vim`、`codex` 等程序如果需要完整 PTY，推荐把 PTY 放在远端 tmux 会话或持久 Agent 中；页面只是重新 attach。程序是否因远端环境收到 SIGHUP 退出，必须在实际目标系统上做测试，不得靠理论宣称全部兼容。

### 14.4 RDP/VNC 恢复边界

[INFERRED · HIGH] 浏览器关闭会断开当前浏览器到 Zephyr 的 RDP/VNC 显示通道；重新打开时应恢复连接 tab 并重新建立受权通道，而不是假设浏览器端 WebGL/WASM 状态仍存在。

[INFERRED · MED] 远端 Windows 会话是否保留取决于 RDP 服务端的断线重连策略；Zephyr 可以恢复连接和页面，但不能保证每个目标系统都保留远程桌面会话状态。

[INFERRED · HIGH] RDP Agent 文件映射和临时文件传输订阅必须绑定用户、资源和 RDP 会话；页面恢复后重新签发短期授权，不复用其他用户或旧浏览器的 token。

### 14.5 AI 长任务

[INFERRED · HIGH] `/api/ai/chat` 的同步请求模式不能作为最终后台任务接口；应新增 `ai_tasks` 和 Worker/任务调度层，HTTP 请求只负责创建任务或提交事件。

[INFERRED · HIGH] AI 任务至少保存：`taskId`、`ownerUserId`、provider/profile ID、对话 ID、输入摘要、状态、当前工具轮次、事件、确认项、错误、结果、创建/更新时间和资源访问快照版本。

[INFERRED · HIGH] 浏览器断开时只取消事件流订阅，不自动调用任务 Abort；用户点击“停止”或服务端策略/超时才取消任务。

[INFERRED · HIGH] AI 任务每次调用工具前都重新检查当前用户对目标连接、笔记、浏览器会话和文件的权限；任务创建时有权不代表任务执行时永远有权。

[INFERRED · HIGH] AI 任务进入 `waiting_confirmation` 后，确认记录归任务拥有者或明确的 `approve` 协作者；浏览器重新打开时恢复确认卡片，但不会因为超时或页面重开自动批准。

## 15. 个人设置与管理员默认配置

### 15.1 设置分层

[INFERRED · HIGH] 设置必须拆成三层：

```text
systemSettings       平台运行、安全、邮件、全局策略，仅管理员
adminDefaults        管理员设置的品牌和默认外观，仅作为默认值
userSettings         当前用户的个人外观、终端、快捷键、工作区和个人 AI 设置
```

[INFERRED · HIGH] 当前 `/api/settings` 不能继续让普通用户直接读写整份全局 settings；应拆为 `/api/admin/settings`、`/api/me/settings` 和必要的只读 `/api/bootstrap`。

[INFERRED · HIGH] 设置合并优先级建议为：平台强制策略 > 用户允许范围内的个人覆盖 > 管理员默认值 > 内置默认值；个人设置不能覆盖安全策略、资源 ACL、AI 禁止项或数据保留策略。

### 15.2 普通用户可以自定义的内容

[INFERRED · HIGH] 管理员开启策略后，普通用户可以独立修改自己的主题、亮暗模式、终端字体、终端背景、终端布局上限、快捷键平台、个人 snippets、笔记编辑器偏好、AI 面板布局和个人工作区默认页。

[INFERRED · HIGH] 用户的自定义 CSS 必须按 `userId` 存储和加载；用户 A 的 CSS 不能进入 B 的页面，也不能修改管理员的全局 CSS。

[INFERRED · HIGH] 任意自定义 JavaScript 具有读取和修改页面状态的潜在能力，普通用户默认不应直接在主页面执行；可选实现应采用 sandbox iframe、受限事件 API 或管理员明确开启的信任模式。

[INFERRED · HIGH] 管理员可以设置允许哪些个人配置项、最大 CSS/脚本大小、是否允许自定义品牌、是否允许用户覆盖系统主题；这些策略自身不应被普通用户的 `PUT /api/me/settings` 修改。

### 15.3 配置隔离验收

[INFERRED · HIGH] 修改 A 的主题后，B 的页面和管理员页面不变；修改管理员默认主题后，只影响没有个人覆盖的用户，不能覆盖已有个人设置。

[INFERRED · HIGH] 用户退出并重新登录另一个账号时，页面必须重新加载目标用户的设置，不能把上一个账号的 brand、CSS、AI 面板或 snippets 留在内存中。

[INFERRED · HIGH] 设置导出/导入必须声明范围：个人设置只导出当前用户可读内容，管理员系统备份才可以包含平台配置；导出文件中的秘密必须继续加密或排除。

## 16. AI 多用户权限与供应商策略

### 16.1 管理员可配置的 AI 模式

[INFERRED · HIGH] 管理员为每个用户设置一个 AI access policy，至少支持以下模式：

| 模式 | 行为 |
|---|---|
| `disabled` | [INFERRED · HIGH] 用户看不到 AI 入口，所有 AI API 和 AI WebSocket 请求服务端拒绝。 |
| `admin_shared` | [INFERRED · HIGH] 用户只能使用管理员授权的 provider/model；API Key 由服务端持有，用户不能查看或导出。 |
| `self_managed` | [INFERRED · HIGH] 用户可以添加和使用自己的 provider；是否允许网页搜索、远程执行等工具仍由管理员策略控制。 |
| `both` | [INFERRED · HIGH] 用户可以在管理员共享 provider 和自己的 provider 之间选择；两者的模型、额度和工具权限分别受限。 |

[INFERRED · HIGH] 管理员可以为用户设置 AI 总开关、允许的 provider/model 白名单、每日/每月请求额度、最大并发任务、最大工具轮次、是否允许后台任务、是否允许浏览器自动化和是否必须人工确认。

[INFERRED · HIGH] “给用户用管理员的 AI”只表示授予服务端代发请求的使用权，不表示把管理员 API Key、provider 原始配置、组织字段或隐藏 Header 返回给用户。

[INFERRED · HIGH] “允许用户自己添加 AI”必须把 provider 归属到用户；用户自己的 API Key 对管理员默认不可见，管理员只能看到 provider 名称、启用状态、用量和健康状态等非秘密元数据。

### 16.2 AI 工具能力权限

[INFERRED · HIGH] AI 工具权限至少分为：`chat`、`webSearch`、`webFetch`、`browser`、`remoteObserve`、`remoteExecute`、`fileRead`、`fileWrite`、`codeEdit`、`memoryRead`、`memoryWrite`、`notesRead`、`notesWrite`、`envRead`、`uiControl`、`taskBackground`。

[INFERRED · HIGH] 管理员的全局 AI policy、用户 grant、目标资源 ACL 和现有敏感确认策略共同决定工具是否可用；AI system prompt 中写了“可以”不能替代执行器授权。

[INFERRED · HIGH] `list_connections`、`remote_execute`、`remote_read_file`、`remote_write_file`、`open_connection`、RDP 截图和 UI action 都必须接收当前用户上下文，并过滤/检查资源 ACL；不能继续调用返回全局连接列表的旧 helper。

[INFERRED · HIGH] AI 使用管理员共享设备时，工具执行器必须以当前用户身份进行授权；不能因为 provider 属于管理员就让 AI 获得管理员的全部设备权限。

[INFERRED · HIGH] AI 使用用户私有设备时，只有用户自己的任务或明确共享给协作者的任务可以访问；管理员 AI 不应自动读取用户私有设备。

### 16.3 AI 对话、Memory、计划和环境变量隔离

[INFERRED · HIGH] AI 对话、消息、浏览器会话、截图、Memory、计划、环境变量和任务默认按 `userId` 隔离；不能继续把聊天只存浏览器 localStorage 后宣称跨设备恢复完成。

[INFERRED · HIGH] Memory 的作用域应至少支持 `user`、`connection`、`project`、`shared`；`shared` 也必须有 ACL，不是管理员全局可读。

[INFERRED · HIGH] AI 环境变量的名称、值、是否暴露给 AI、是否允许用户读取和是否允许共享都应独立授权；任何 API 返回都不能泄露未授权值。

[INFERRED · HIGH] AI 计划/任务的创建者默认拥有控制权；协作者可以被授予观察、确认或控制；删除、重试、远程写入和执行命令必须再次确认并审计。

### 16.4 AI 后台任务与确认

[INFERRED · HIGH] AI 后台任务创建接口必须检查用户的 `taskBackground` 权限、额度和目标资源 ACL，然后立即返回不可预测的 `taskId`。

[INFERRED · HIGH] 任务事件不能只保存在 SSE/HTTP 响应中；应持久化为可按用户授权读取的事件流，支持浏览器关闭后重连和分页回放。

[INFERRED · HIGH] 页面关闭后若任务等待确认，系统应向用户下次登录后的工作区恢复待确认卡；确认提交时再次验证任务尚未过期、用户仍有权限且资源 ACL 未撤销。

[INFERRED · HIGH] 管理员可以看到 AI 用量和失败统计；默认不能看到用户私有对话全文和 prompt，除非用户共享或触发有审计的 break-glass 读取。

## 17. 前述终端、Deep Link、笔记与文件传输方案的逐项权限接入

[INFERRED · HIGH] 本文第 2–7 节中的每项能力都必须叠加下面的用户/ACL 条件；没有这些条件，技术实现仍然只是单用户版本。

| 前述能力 | 多用户归属 | 必须新增的权限逻辑 |
|---|---|---|
| 持久登录会话 | [INFERRED · HIGH] `auth_sessions.userId` | [INFERRED · HIGH] 会话只恢复所属用户；密码修改、暂停、角色变化和 logout 可撤销；WebSocket 使用同一认证主体。 |
| WTerm 终端视口/scrollback | [INFERRED · HIGH] 当前用户的 terminal session/workspace | [INFERRED · HIGH] DOM、buffer snapshot、scrollback 和 AI 读取不能跨用户；共享终端必须显式 `observe/control`。 |
| 监控订阅 | [INFERRED · HIGH] 当前用户 + 连接资源 | [INFERRED · HIGH] 订阅前检查 `observe`；关闭/撤销后停止 stats channel；不允许通过 connectionId 猜测其他用户主机。 |
| Deep Link 临时连接 | [INFERRED · HIGH] 发起用户 | [INFERRED · HIGH] prepare token 绑定 `userId`、过期时间和来源；临时资源不写入公共资产；只允许发起用户消费。 |
| JumpServer/JMS token | [INFERRED · HIGH] 发起用户 + 一次性 token | [INFERRED · HIGH] 不写日志/数据库明文；重复消费、跨用户消费和共享都拒绝。 |
| 笔记 | [INFERRED · HIGH] note owner + note ACL | [INFERRED · HIGH] CRUD、搜索、导入导出、连接关联、回收站和 AI 工具均按 owner/ACL过滤；默认私有。 |
| 笔记中的 SSH/Telnet/JMS 链接 | [INFERRED · HIGH] 点击者 | [INFERRED · HIGH] 进入点击者自己的 transient UI；解析出的连接不自动继承笔记拥有者的凭据或权限。 |
| AI 笔记工具 | [INFERRED · HIGH] AI task owner | [INFERRED · HIGH] `notesRead/notesWrite` + note ACL + revision 检查；写入仍走确认策略。 |
| AI 浏览器会话/截图 | [INFERRED · HIGH] conversation/task owner | [INFERRED · HIGH] session 名称不能成为授权凭据；截图 URL 需要当前用户和资源检查。 |
| RDP Agent/文件传输 | [INFERRED · HIGH] user + connection + agent | [INFERRED · HIGH] Agent token、RDP tab、drive handle、读写操作四层绑定；管理员不能因平台角色读取用户私有 Agent。 |
| 用户自定义页面 | [INFERRED · HIGH] `userSettings.userId` | [INFERRED · HIGH] CSS/脚本和工作区按用户加载；系统默认与个人 override 分开。 |
| 远程命令/任务 | [INFERRED · HIGH] task owner + target ACL | [INFERRED · HIGH] 浏览器关闭不取消；任务事件和控制操作按任务 ACL；每次工具调用重新授权。 |

[INFERRED · HIGH] 本文前述方案建议的文件传输 WebSocket 不能只验证一次 RDP 连接；每个端点初始化、drive attach、handle 操作和二进制请求都要绑定已认证用户、连接 ID、Agent ID 与权限快照/实时 ACL。

[INFERRED · HIGH] 本文前述方案建议的笔记 `notes` 表应在原有字段上增加 owner、共享和 revision 语义；AI 工具 `note_list/search/get/create/update/delete` 必须调用统一授权服务，而不是直接读 settings。

[INFERRED · HIGH] 本文前述方案建议的 Deep Link transient token 必须绑定用户；未登录流程在登录回跳后只能交给同一用户的 session，不能把原始 fragment 传给另一个登录账号。

## 18. 数据模型与迁移目标

### 18.1 用户与认证

[INFERRED · HIGH] 目标 `users` 表建议至少包含以下字段；字段名可按现有 camelCase 风格落地，但语义不可省略：

```sql
users(
  userId TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'active',
  email TEXT,
  passwordHash TEXT NOT NULL,
  defaultPassword INTEGER NOT NULL DEFAULT 0,
  passwordChangedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  lastLoginAt INTEGER
);
```

[INFERRED · HIGH] 用户名可以修改，但所有外键、会话、ACL、任务和审计记录使用 `userId`；用户名变化不能让资源丢失或换主。

```sql
auth_sessions(
  sessionId TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  userId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastSeenAt INTEGER NOT NULL,
  idleExpiresAt INTEGER NOT NULL,
  absoluteExpiresAt INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0,
  revokedAt INTEGER,
  revokeReason TEXT,
  userAgentHash TEXT,
  ipPrefix TEXT
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(userId);
```

[INFERRED · HIGH] Cookie 只保存随机 token，数据库保存哈希；内存 cache 可以加速，但 SQLite 必须是可恢复的权威来源。

### 18.2 用户设置和工作区

```sql
userSettings(
  userId TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updatedAt INTEGER NOT NULL,
  PRIMARY KEY(userId, key)
);

workspaces(
  workspaceId TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  clientId TEXT NOT NULL,
  name TEXT NOT NULL,
  stateJson TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updatedAt INTEGER NOT NULL,
  UNIQUE(userId, clientId, workspaceId)
);
CREATE INDEX idx_workspaces_user_client ON workspaces(userId, clientId, updatedAt DESC);
```

[INFERRED · HIGH] 工作区 `stateJson` 只能存资源 ID、布局和非秘密状态；服务端写入前应做 schema 校验和大小限制。

### 18.3 资源和 ACL

[INFERRED · HIGH] 现有 connections、proxies、ssh_keys、jump_hosts、agent_tokens 等表都应增加 `ownerUserId`、`visibility`、`createdByUserId` 和必要的版本字段。

```sql
resourceAcl(
  resourceType TEXT NOT NULL,
  resourceId TEXT NOT NULL,
  subjectType TEXT NOT NULL DEFAULT 'user',
  subjectId TEXT NOT NULL,
  capabilitiesJson TEXT NOT NULL,
  grantedByUserId TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER,
  revokedAt INTEGER,
  PRIMARY KEY(resourceType, resourceId, subjectType, subjectId)
);
CREATE INDEX idx_resource_acl_subject ON resourceAcl(subjectType, subjectId, revokedAt, expiresAt);
CREATE INDEX idx_resource_acl_resource ON resourceAcl(resourceType, resourceId, revokedAt);
```

[INFERRED · HIGH] ACL 表不应把秘密写入 capabilities；ACL 只表示能力，秘密仍在资源加密字段中。

[INFERRED · HIGH] 连接依赖可以使用 `resourceType/resourceId` 统一表达，也可以在业务表中保留外键；授权服务必须递归检查依赖，防止共享 connection 时意外暴露 proxy/ssh key/jump host。

### 18.4 终端、协同和任务

```sql
terminalSessions(
  terminalSessionId TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL,
  connectionId TEXT NOT NULL,
  protocol TEXT NOT NULL,
  backendRef TEXT,
  status TEXT NOT NULL,
  ptyRows INTEGER,
  ptyCols INTEGER,
  createdAt INTEGER NOT NULL,
  lastSeenAt INTEGER NOT NULL,
  endedAt INTEGER
);

sessionAcl(
  terminalSessionId TEXT NOT NULL,
  userId TEXT NOT NULL,
  role TEXT NOT NULL,
  grantedByUserId TEXT NOT NULL,
  expiresAt INTEGER,
  PRIMARY KEY(terminalSessionId, userId)
);

backgroundTasks(
  taskId TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL,
  taskType TEXT NOT NULL,
  targetResourceType TEXT,
  targetResourceId TEXT,
  status TEXT NOT NULL,
  backendRef TEXT,
  commandSummary TEXT,
  resultJson TEXT,
  exitCode INTEGER,
  createdAt INTEGER NOT NULL,
  startedAt INTEGER,
  updatedAt INTEGER NOT NULL,
  finishedAt INTEGER,
  cancelRequestedAt INTEGER
);

taskEvents(
  eventId TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  eventType TEXT NOT NULL,
  payloadJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  UNIQUE(taskId, seq)
);
CREATE INDEX idx_tasks_owner_status ON backgroundTasks(ownerUserId, status, updatedAt DESC);
CREATE INDEX idx_task_events_task_seq ON taskEvents(taskId, seq);
```

[INFERRED · HIGH] `backendRef` 只能保存不含密码的远端 tmux 名称、Worker ID 或代理句柄；实际秘密由受授权的服务端连接层读取。

### 18.5 AI、笔记与审计

```sql
aiProviders(
  providerId TEXT PRIMARY KEY,
  ownerUserId TEXT,
  scope TEXT NOT NULL DEFAULT 'user',
  encryptedConfig TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

aiAccessGrants(
  userId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  capabilitiesJson TEXT NOT NULL,
  modelAllowlistJson TEXT,
  quotaJson TEXT,
  grantedByUserId TEXT NOT NULL,
  expiresAt INTEGER,
  PRIMARY KEY(userId, providerId)
);

notes(
  noteId TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  groupPath TEXT NOT NULL DEFAULT '',
  tagsJson TEXT NOT NULL DEFAULT '[]',
  linkedConnectionIdsJson TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  deletedAt INTEGER
);

aiConversations(
  conversationId TEXT PRIMARY KEY,
  ownerUserId TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

auditEvents(
  eventId TEXT PRIMARY KEY,
  actorUserId TEXT,
  targetUserId TEXT,
  resourceType TEXT,
  resourceId TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadataJson TEXT NOT NULL DEFAULT '{}',
  createdAt INTEGER NOT NULL
);
```

[INFERRED · HIGH] AI 对话消息、任务事件和笔记正文应按数据保留策略分开存储；管理员审计页面默认只显示元数据和脱敏摘要，不把正文复制进活动日志。

[INFERRED · HIGH] 所有新表迁移必须支持旧库重复执行、失败回滚、备份恢复和旧版本启动检查；迁移完成前不得启用多用户入口。

## 19. 服务端授权架构与 API 约定

### 19.1 统一授权模块

[INFERRED · HIGH] 建议新增 `authz.js` 或等价服务，提供统一函数：

```js
requireUser(req)
requireRole(req, 'admin')
can(user, action, resource)
assertCan(user, action, resource)
listVisibleResources(user, type, filters)
filterToolResources(user, resources)
```

[INFERRED · HIGH] 所有业务路由只能通过这些函数判断，不能在每个文件里复制一套“如果 username === admin”的逻辑。

[INFERRED · HIGH] WebSocket 在 upgrade 时解析并绑定认证主体；连接后的每条消息仍通过会话/资源授权检查，尤其是 `input`、`resize`、`stats-request`、Docker、SFTP、RDP proxy 和 file-transfer 消息。

[INFERRED · HIGH] AI 工具执行器必须接收 `{ userId, sessionId, taskId, signal }` 上下文，并在工具真正访问资源前调用 `assertCan`；前端传入的 `context.connections` 只能作为提示，不能作为权限证据。

### 19.2 认证和 bootstrap API

```text
GET  /api/auth/me
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/change-password
POST /api/auth/forgot-password/request
POST /api/auth/forgot-password/reset
GET  /api/me/bootstrap
GET  /api/me/sessions
DELETE /api/me/sessions/:id
```

[INFERRED · HIGH] `/api/me/bootstrap` 返回当前用户基本资料、角色、有效个人设置、平台策略摘要、可见资源摘要、工作区列表、未完成任务和待确认事项，但不返回任何秘密。

[INFERRED · HIGH] `GET /api/auth/me` 和 WebSocket 使用同一个持久认证会话解析器；不能出现 HTTP 仍认为登录、WebSocket 却用另一份内存 Map 失败的双重身份来源。

### 19.3 用户管理 API

```text
GET    /api/admin/users
POST   /api/admin/users
GET    /api/admin/users/:userId
PATCH  /api/admin/users/:userId
POST   /api/admin/users/:userId/suspend
POST   /api/admin/users/:userId/force-password-reset
POST   /api/admin/users/:userId/revoke-sessions
DELETE /api/admin/users/:userId
GET    /api/admin/users/:userId/grants
PUT    /api/admin/users/:userId/grants
```

[INFERRED · HIGH] 这些接口只允许管理员角色，并且每个写操作都写审计；返回用户列表时不返回密码哈希、TOTP Secret、Passkey 公钥内部敏感字段或 AI API Key。

### 19.4 资源和分享 API

```text
GET    /api/connections
POST   /api/connections
GET    /api/connections/:id
PUT    /api/connections/:id
DELETE /api/connections/:id
GET    /api/resources/:type/:id/shares
PUT    /api/resources/:type/:id/shares
DELETE /api/resources/:type/:id/shares/:subjectId
POST   /api/resources/:type/:id/transfer
```

[INFERRED · HIGH] 现有 connections API 应保留兼容路径，但内部必须改为 `resourceService`；旧的 `readJSON(CONNECTIONS_FILE)` 直接读写路径应在迁移后删除或只作为一次性导入器。

[INFERRED · HIGH] `/open`、`/credentials`、`/test` 和 WebSocket 连接接口都必须复用同一个资源授权函数；只保护列表和编辑接口是不完整的。

### 19.5 工作区和任务 API

```text
GET  /api/me/workspaces
GET  /api/me/workspaces/:id
PUT  /api/me/workspaces/:id
POST /api/me/workspaces/:id/restore
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:taskId
GET  /api/tasks/:taskId/events?after=
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/retry
POST /api/tasks/:taskId/confirm
PUT  /api/tasks/:taskId/shares
```

[INFERRED · HIGH] 任务接口返回 404 或结构化 403 时不能泄露另一个用户的任务存在性；事件分页必须按 task ACL 过滤。

### 19.6 AI API

```text
GET  /api/ai/status
GET  /api/ai/effective-policy
GET  /api/ai/providers
POST /api/ai/providers
PUT  /api/ai/providers/:id
DELETE /api/ai/providers/:id
POST /api/ai/tasks
GET  /api/ai/tasks/:id
GET  /api/ai/tasks/:id/events
POST /api/ai/tasks/:id/confirm
POST /api/ai/tasks/:id/cancel
```

[INFERRED · HIGH] 原有 `/api/ai/chat` 可以暂时保留为短请求兼容接口，但必须在服务端根据 policy 和资源 ACL 授权；长任务和需要页面关闭后继续的操作必须迁移到 `/api/ai/tasks`。

### 19.7 错误协议

[INFERRED · HIGH] 建议所有接口统一返回非敏感的 `code`、用户可读 `message`、`retryable` 和可选 `resourceType`：

```json
{
  "error": {
    "code": "forbidden_resource_control",
    "message": "当前账号没有控制此资源的权限",
    "retryable": false
  }
}
```

[INFERRED · HIGH] `app_session_expired`、`network_timeout`、`ssh_auth_failed`、`resource_revoked`、`task_cancelled` 和 `ai_policy_denied` 必须分开，前端不能把所有错误都显示成“请重新登录”。

## 20. 前端功能与页面结构

### 20.1 登录后恢复页

[INFERRED · HIGH] 登录成功后可显示一个短暂恢复面板：正在恢复工作区、恢复 N 个终端、重新订阅 M 个任务、X 个资源已失效；用户可以取消恢复但不能绕过授权。

[INFERRED · HIGH] 终端栏应区分“我的连接”“管理员共享”“其他用户共享”“临时连接”，并显示权限徽标，例如“只读”“可操作”“可执行”。

[INFERRED · HIGH] 任务中心应显示“运行中”“等待确认”“已完成”“失败”“已取消”，并把任务拥有者、目标资源来源和当前用户可执行动作展示清楚。

### 20.2 管理员控制台

[INFERRED · HIGH] 管理员页面至少包含：用户列表、用户详情、账号状态、密码/MFA 操作、资源授权、AI policy、全局设置、审计日志、任务治理和共享资源列表。

[INFERRED · HIGH] “给 A 授权设备”界面应提供资源搜索、权限档位展开预览、有效期、是否允许协同和撤销按钮；提交前显示“这不会把密码暴露给 A”。

[INFERRED · HIGH] 管理员连接列表默认只显示管理员拥有或明确共享给管理员的资源；用户私有资源不会通过全局搜索混入。

### 20.3 用户页面

[INFERRED · HIGH] 普通用户设置页面包含个人资料、修改密码、找回邮箱、MFA、外观、终端、工作区、个人 AI、Memory、笔记和 Agent 管理；系统安全、用户管理和平台备份入口不可见且服务端也拒绝。

[INFERRED · HIGH] 连接详情显示资源所有者和共享状态；用户可以“分享给管理员/指定用户”，但默认不勾选任何对象。

[INFERRED · HIGH] 用户看到管理员共享设备时，UI 应明确哪些功能不可用，而不是点击后才收到模糊错误；按钮隐藏只是体验优化，服务端拒绝仍必须存在。

### 20.4 协同 UI

[INFERRED · HIGH] 终端标题栏显示当前观察者、控制者、控制锁剩余时间和“申请控制/释放控制”按钮；失去控制权时输入区域变为只读。

[INFERRED · HIGH] RDP/VNC 显示观察者数量、输入控制者和文件传输权限；高影响动作需要二次确认和对应 capability。

[INFERRED · HIGH] 笔记和 AI 任务共享面板复用同一 ACL 组件，避免用户在不同页面面对互相矛盾的权限语义。

### 20.5 Deep Link 临时连接

[INFERRED · HIGH] 本文前述方案要求所有 Deep Link 最终进入现有连接弹窗的 transient mode；在多用户版本中，该 modal 的 draft、一次性 token、临时 tab 和输出都归发起用户，不写入公共连接库。

[INFERRED · HIGH] 如果 Deep Link 指向管理员共享设备，只有拥有 `use` 的用户可以继续；如果指向用户私有设备，只有资源拥有者或显式 ACL 用户可以使用；解析成功不等于授权成功。

[INFERRED · HIGH] transient mode 仍只保留“测试连接”和“连接”两个业务动作；连接成功后临时 tab 也必须带 owner/session 信息，不能被另一用户通过猜 tabId 恢复。

## 21. 数据迁移与兼容策略

### 21.1 迁移前保护

[INFERRED · HIGH] 实施前必须备份 SQLite、旧 JSON、加密密钥和部署配置，并在副本数据库上执行迁移演练；没有可验证回滚点不得改生产库。

[INFERRED · HIGH] 迁移工具必须输出统计而不是敏感内容：用户数、连接数、设置项数、待处理秘密数、错误数和迁移版本；日志不得打印密码、私钥、API Key 或 token。

### 21.2 旧用户和资源归属

[INFERRED · HIGH] 现有第一个管理员用户迁移为 `role=admin`，生成稳定 `userId`；现有连接、代理、SSH 密钥和跳板机默认归该管理员所有，以保持单用户安装升级后的原有可用性。

[INFERRED · HIGH] 迁移后的普通用户默认看不到这些旧资源，管理员必须显式共享；这比把旧资源错误暴露给所有新用户安全。

[INFERRED · HIGH] 现有全局 AI provider、skills、Memory 和计划迁移为管理员私有或系统默认资源；普通用户只有在管理员授予 AI policy 和资源权限后才能使用。

[INFERRED · HIGH] 浏览器 localStorage 中的旧 AI 对话无法从服务端可靠判断账号归属；首次登录时可提供“导入到当前用户”动作，默认不自动把旧聊天复制给所有用户。

[INFERRED · HIGH] 现有全局外观迁移为 `adminDefaults`；普通用户首次登录使用管理员默认值，后续保存个人覆盖进入 `userSettings`。

### 21.3 旧接口切换

[INFERRED · HIGH] 迁移完成后，连接、代理、密钥、跳板机、活动和设置的读写必须统一通过 SQLite/service layer；保留旧 JSON 只用于导入、备份兼容或明确只读诊断。

[INFERRED · HIGH] 所有旧接口都应先加授权包裹，再逐步替换数据源；不能先把全局接口暴露给普通用户，再依赖后续清理。

[INFERRED · HIGH] 旧的按用户名存储 TOTP/重置码/Passkey 关联在迁移时改为 `userId` 外键；用户名重命名后相关数据仍然归同一用户。

### 21.4 兼容与回滚

[INFERRED · HIGH] 数据库加入 schema version 和 migration journal；每个 migration 可重复执行，失败时事务回滚，应用启动时拒绝使用半迁移状态。

[INFERRED · HIGH] 发布初期可以提供只读兼容开关，但不能让新用户写入旧全局 JSON；否则双写会造成权限漂移。

[INFERRED · HIGH] 回滚应用版本时必须保留新表和数据，旧版本若不理解新表应安全停止或只读，不能把多用户数据压回单用户结构而造成泄露。

---

## 22. 统一分阶段实施顺序

[INFERRED · HIGH] 多用户与任务生命周期不能作为最后补丁加入。统一实施顺序必须先建立身份、归属和授权，再让监控、WTerm、Deep Link、笔记、AI 与文件传输接入这些边界。

### Stage 0：冻结基线、可观测性与安全测试骨架

- [INFERRED · HIGH] 固定目标提交、数据库副本、WTerm 版本和浏览器矩阵；建立可重复的旧库升级测试。
- [INFERRED · HIGH] 增加 HTTP/WS 结构化错误、terminal resize/render/scroll、stats duration、auth failure、task state 和 ACL deny 指标；日志不记录秘密。
- [INFERRED · HIGH] 先建立三用户（admin/A/B）跨用户越权测试骨架，覆盖 HTTP、WebSocket、AI tool、导出、Deep Link 和 Agent 文件传输。

### Stage 1：不可变用户身份与持久认证会话

- [INFERRED · HIGH] 为用户生成不可变 `userId`，增加 role/status，迁移 TOTP、Passkey、重置码和审计外键。
- [INFERRED · HIGH] 新建 SQLite `auth_sessions`，Cookie 保存随机 SID、数据库只保存哈希；实现 idle/absolute TTL、remember、撤销和多副本一致解析。
- [INFERRED · HIGH] WebSocket Upgrade 绑定同一认证主体，连接后不再重复从旧内存 Map 推断身份；修复“服务重启后随机要求登录”。
- [INFERRED · HIGH] 完成每用户改密、找回密码、会话列表/撤销、暂停账号和最后一个管理员保护。

### Stage 2：资源 ownership、ACL 与旧全局数据源收敛

- [INFERRED · HIGH] 给 connection/proxy/SSH key/jump host/Agent token 等资源增加 owner；现有旧资源迁移给初始管理员。
- [INFERRED · HIGH] 实现统一 `authz/resource-service/sharing-service`，完成 capability、依赖资源检查、分享/撤销、秘密不外泄和审计。
- [INFERRED · HIGH] 所有连接列表、详情、test/open/credentials、SSH/RDP/VNC WS、SFTP、Docker 和批量执行改走同一资源服务。
- [INFERRED · HIGH] 停止生产代码直接读写旧 `connections.json/settings.json`；旧 JSON 仅保留一次性迁移和明确的兼容导入用途。

### Stage 3：个人设置与工作区恢复

- [INFERRED · HIGH] 将设置拆成 system settings、admin defaults 和 user settings；普通用户只能修改策略允许的个人覆盖。
- [INFERRED · HIGH] 建立 `userId + clientId + workspaceId` 工作区，保存页面、标签、布局、面板和任务引用，不保存密码、私钥或 API Key。
- [INFERRED · HIGH] 实现 `/api/me/bootstrap` 与启动恢复状态机；账号切换时销毁前一个用户的 iframe、AI 状态、缓存和待确认项。
- [INFERRED · HIGH] 恢复前重新计算 ACL；已撤销或删除资源显示失效占位，不通过旧 tabId 重连。

### Stage 4：监控闪烁与采集负载修复

- [INFERRED · HIGH] 拆静态、动态和进程采集；打开监控时显式 subscribe，关闭或撤权后 unsubscribe。
- [INFERRED · HIGH] 前端使用稳定 DOM、keyed reconcile、持久 Chart 实例和真实 ring buffer；将 Chart.js 本地化。
- [INFERRED · HIGH] stats subscribe 前检查资源 `observe` capability，并为序号、延迟、关闭面板和权限撤销补 E2E。

### Stage 5：固定并修复 Zephyr WTerm fork

- [INFERRED · HIGH] vendoring `@wterm/dom/core 0.1.9`，建立 upstream 基线测试、固定版本和产物哈希；不引入 xterm.js。
- [INFERRED · HIGH] 在 WTerm 内实现公开 viewport state/event、程序滚动抑制、精确 bottom 和单次 render commit；Zephyr 页面改用公开 API。
- [INFERRED · HIGH] buffer snapshot 由 WTerm core 提供，并受 terminal session `observe`/AI tool 权限约束。

### Stage 6：WTerm resize/reflow 与旧补丁清理

- [INFERRED · HIGH] 增加稳定 row id、ResizeDelta、语义 anchor 和离屏原子 DOM commit。
- [INFERRED · HIGH] 删除六个私有 monkey patch、多阶段滚动 timer、旧 pixel scrollTop 恢复、PTY-only resize 和文本快照回灌。
- [INFERRED · HIGH] 通过桌面/手机、长输出、宽字符、alternate screen、选择复制和 50 次 resize 循环门禁。

### Stage 7：持久 SSH 会话、后台任务与协同控制

- [INFERRED · HIGH] 建立 terminal sessions、background tasks、task events 和 session/task ACL；普通 WS detach 不销毁持久后端。
- [INFERRED · HIGH] SSH/Codex 长任务使用远端 tmux、持久 Agent 或 Worker，并记录 backend ref、日志、状态与退出码。
- [INFERRED · HIGH] 实现 observer/controller lease、控制权申请/释放、权限撤销、任务分享和真实操作者审计。
- [INFERRED · HIGH] 验证浏览器关闭、网络中断、Node 重启、容器重启和多浏览器重连；不得重发最后输入。

### Stage 8：AI 多用户策略、Provider 隔离与后台 AI 任务

- [INFERRED · HIGH] 实现 `disabled/admin_shared/self_managed/both`，Provider ownership、模型白名单、额度、并发和工具 capability。
- [INFERRED · HIGH] 将对话、Memory、计划、环境变量、浏览器会话和截图按 userId 隔离；共享管理员 Provider 不返回 Key。
- [INFERRED · HIGH] 新建 AI task Worker、持久事件和 waiting-confirmation；关闭页面只断开订阅。
- [INFERRED · HIGH] 每次 AI 工具执行重新检查用户 policy、资源 ACL、任务状态和确认条件。

### Stage 9：笔记存储、API 与完整 UI

- [INFERRED · HIGH] 实现 owner/ACL/revision/soft-delete/FTS 的 notes service，再交付主导航三栏桌面 UI、移动分层 UI、CodeMirror 编辑/预览、搜索、分组、标签、关联和导入导出。
- [INFERRED · HIGH] 终端笔记侧窗和“当前连接”过滤只显示当前用户可读笔记；完整 UI、主题、移动端和可访问性测试全部通过才算交付。

### Stage 10：AI 笔记工具

- [INFERRED · HIGH] 增加 `note_list/search/get/create/update/delete`，接入 `notesRead/notesWrite`、note ACL、revision 冲突和确认策略。
- [INFERRED · HIGH] AI 不自动注入全部笔记正文；先搜索再按需读取，写操作记录真实任务/用户并保持正文不进入普通活动日志。

### Stage 11：HTTPS Deep Link、临时连接 UI 与一次性凭据

- [INFERRED · HIGH] 先交付 SSH/JMS SSH/SFTP；所有入口进入现有连接 modal 的 transient mode，底部只有“测试连接”和“连接”。
- [INFERRED · HIGH] token 绑定 userId、Same-Origin、短 TTL 和原子消费；密码/JMS token 不进入 query、localStorage、资产库或日志。
- [INFERRED · HIGH] 笔记链接、登录回跳和工作区临时 tab 接入同一 parser/authz，覆盖跨用户消费和重复消费测试。

### Stage 12：Telnet 与原生协议接管

- [INFERRED · HIGH] 完成 Telnet transport 后才开放 `telnet://`，并明确明文风险。
- [INFERRED · HIGH] Android/桌面壳注册 `ssh/telnet/jms`；Web 版保持 HTTPS/web+ fallback，不虚假宣称纯网页接管系统 scheme。

### Stage 13：RDP 文件传输二进制 WebSocket 重构

- [INFERRED · HIGH] 新增 Go WASM file transfer 层与 Node file-transfer WS，使用二进制帧、requestId 和 4-8 路流水线，删除 sync XHR/base64 主路径。
- [INFERRED · HIGH] 每个 WS、Agent、drive、handle 和读写请求绑定 userId、connectionId、sessionId 与 `fileRead/fileWrite` capability。
- [INFERRED · HIGH] 100MB LAN 基准目标不低于 40 MB/s且主线程无传输 Long Task；不支持 SAB/Atomics 的平台使用经过测试的兼容路径。

### Stage 14：全面迁移、灰度与发布

- [INFERRED · HIGH] 在副本库演练迁移/回滚，关闭旧全局写路径，运行完整 Node/Go/浏览器/移动端/权限/并发/重启矩阵。
- [INFERRED · HIGH] 灰度观察越权拒绝、WS 401、异常重连、任务恢复、AI 用量、监控和文件传输指标；没有跨用户安全与恢复证据不得标记完成。

---

## 23. 文件级修改与新增模块清单

### 23.1 现有文件

| 文件 | 统一改造内容 |
|---|---|
| `server.js` | [INFERRED · HIGH] 持久认证、统一 authz 接线、用户管理、资源过滤、工作区/任务 API、SSH/RDP/VNC/SFTP/Docker/Agent WS 授权、stats subscribe、Deep Link 和 notes route 接线。 |
| `storage.js` | [INFERRED · HIGH] userId/role/status、auth sessions、user settings、workspaces、resource/session/task ACL、tasks/events、notes、AI resources、audit 与可重复 migration。 |
| `ai-agent-service.js` | [INFERRED · HIGH] effective AI policy、Provider ownership、后台 task、用户隔离对话/Memory/plan/env/browser、工具级 ACL、notes 工具与确认。 |
| `stats.js` | [INFERRED · HIGH] 静态/动态/进程采集拆分、缓存、sample sequence、超时隔离和订阅参数。 |
| `public/app.js` | [INFERRED · HIGH] bootstrap、账号切换清理、工作区恢复、共享资源/用户管理/任务中心/个人设置/Notes/Deep Link transient UI 与 AI task 事件。 |
| `public/app.html` | [INFERRED · HIGH] 用户管理、资源分享、AI policy、恢复面板、任务中心、完整 Notes 工作区和 transient connection 状态元素。 |
| `public/terminal.js` | [INFERRED · HIGH] terminal owner/session ACL、协同 observer/controller、持久 attach、权限撤销；改用 WTerm 公开 API并删除旧 monkey patch/多阶段恢复。 |
| `public/terminal.html` | [INFERRED · HIGH] 固定 Zephyr WTerm 产物，移除运行时 Chart CDN，加载拆分后的 terminal 模块。 |
| `public/style.css` | [INFERRED · HIGH] 用户/共享/权限/恢复/协同/Notes/transient UI；全部复用现有主题变量并清理操纵 WTerm 私有布局的 override。 |
| `public/rdp-fs-provider.js` | [INFERRED · HIGH] 删除 sync XHR/base64 主路径，仅保留 Agent 状态和 drive 生命周期，接入授权后的二进制 WS。 |
| `rdp-wasm/rdpefs.go` | [INFERRED · HIGH] IRP 数据层改用 file transfer 同步接口，保留协议、handle 和 NT status 逻辑。 |
| `file-agent-manager.js` | [INFERRED · HIGH] Agent ownership/token scope、按用户/连接/会话授权和二进制转发。 |
| `package.json` / `package-lock.json` | [INFERRED · HIGH] 固定 WTerm fork、Chart 本地依赖、测试脚本和精确产物版本；不加入 xterm.js。 |
| `Dockerfile` / `compose.yml` | [INFERRED · HIGH] 构建固定前端/WASM 产物、持久数据库与 task worker，并提供安全的迁移/健康检查。 |
| `FREEZE/INDEX.md` | [INFERRED · HIGH] 指向本文唯一统一方案，删除独立多用户规格入口。 |

### 23.2 建议新增服务模块

```text
authz.js                    # 角色、策略和 capability 的单一授权入口
user-service.js             # 用户生命周期、密码、MFA、找回与会话撤销
session-store.js            # SQLite 持久 App session
resource-service.js         # owner-aware 资源 CRUD 与依赖解析
sharing-service.js          # ACL、权限档位、过期和撤销
workspace-service.js        # userId/clientId/workspace 恢复
collaboration-service.js    # observer/controller lease
task-service.js             # 持久任务、事件、确认和 task ACL
task-worker.js              # SSH/AI 后台执行与重启恢复
ai-policy-service.js        # 管理员策略与用户 effective policy
notes-service.js            # owner/ACL/revision/FTS 笔记服务
deeplink-service.js         # user-bound transient token 与 parser
telnet-session.js           # Telnet IAC/NAWS/TTYPE transport
file-transfer-ws.js         # 授权后的二进制 RDP Agent 文件传输
migration-multi-user.js     # 可重复、可审计的多用户迁移
```

### 23.3 建议新增前端与 WTerm 模块

```text
vendor/wterm-zephyr/packages/core/
vendor/wterm-zephyr/packages/dom/
vendor/wterm-zephyr/tests/
public/open.html
public/open.js
public/notes.js
public/user-admin.js
public/user-settings.js
public/sharing-ui.js
public/workspace-restore.js
public/task-center.js
public/terminal-runtime.js
public/terminal-layout.js
public/terminal-mobile-input.js
public/terminal-monitor.js
```

### 23.4 建议新增测试

```text
tests/authz.test.mjs
tests/user-isolation.test.mjs
tests/session-store.test.mjs
tests/resource-sharing.test.mjs
tests/workspace-restore.test.mjs
tests/task-persistence.test.mjs
tests/ai-policy.test.mjs
tests/ai-task-resume.test.mjs
tests/notes-storage.test.mjs
tests/notes-api.test.mjs
tests/ai-notes-tools.test.mjs
tests/deeplink-parser.test.mjs
tests/deeplink-transient-token.test.mjs
tests/deeplink-transient-ui.test.mjs
tests/stats-sampler.test.mjs
tests/wterm-viewport.test.mjs
tests/wterm-resize-anchor.test.mjs
tests/wterm-render-commit.test.mjs
tests/file-transfer-ws.test.mjs
tests/e2e/session-restart.spec.mjs
tests/e2e/cross-user-isolation.spec.mjs
tests/e2e/workspace-task-restore.spec.mjs
tests/e2e/collaboration-control.spec.mjs
tests/e2e/wterm-resize-scroll.spec.mjs
tests/e2e/monitor-stability.spec.mjs
tests/e2e/deeplink-transient-ui.spec.mjs
tests/e2e/notes-ui.spec.mjs
tests/e2e/rdp-file-transfer.spec.mjs
rdp-wasm/file_transfer.go
rdp-wasm/file_transfer_test.go
```

---

## 24. 测试与验收矩阵

### 24.1 账号隔离

[INFERRED · HIGH] 创建用户 A、B 和管理员；A 创建私有连接、笔记、AI provider、任务和工作区；B 与管理员登录后，所有列表、搜索、详情、导出、WebSocket、AI tool 和截图接口都不能读到 A 的私有对象。

[INFERRED · HIGH] A 退出后同一浏览器登录 B，页面不显示 A 的 tab、聊天、主题、待确认项、任务或缓存输出；B 关闭再打开只恢复 B 的工作区。

[INFERRED · HIGH] 修改 A 的密码、暂停 A、撤销 A 的会话后，A 的 HTTP、WebSocket、任务控制和 AI 确认都按策略失效；B 和管理员的会话不受错误影响。

### 24.2 资源共享

[INFERRED · HIGH] 管理员只给 A 某台设备 `observer`，A 能看但不能输入、执行或修改；升级为 `operator` 后输入可用，仍不能编辑；撤销后已建立连接收到权限变化。

[INFERRED · HIGH] A 新建设备后管理员列表看不到；A 只共享 `observe` 给管理员后，管理员能观察但不能读取密码、输入或编辑；A 撤销后访问立即停止。

[INFERRED · HIGH] 共享 connection 依赖 proxy/jump/key 的组合测试覆盖：缺少依赖授权时连接被拒绝，不会 fallback 到全局资源或泄露依赖名称/秘密。

### 24.3 工作区和任务恢复

[INFERRED · HIGH] 设备 A 关闭浏览器，SSH tmux 长任务继续；等待一段时间后重新登录，原 tab 恢复、历史日志回放、实时输出继续，且不重复发送最后一条输入。

[INFERRED · HIGH] 在任务运行中重启 Node/Docker 容器后，任务状态、日志和用户 ACL 仍可读取；服务重启不应把有效 App Cookie 随机变成需要重新登录。

[INFERRED · HIGH] 两个浏览器实例以同一用户登录时工作区不互相覆盖；一个用户共享任务给另一个用户后，观察者能看，未授予控制权者不能取消或确认。

[INFERRED · HIGH] RDP/VNC 关闭后重新打开能重新建立授权通道；目标系统断线重连差异必须在验收报告中明确记录，不把远端会话保留误报为 Zephyr 保证。

### 24.4 AI 权限

[INFERRED · HIGH] 管理员将 A 设为 `disabled` 时，A 的 AI UI、API、WebSocket、编辑器补全和后台任务都拒绝；切换到 `admin_shared` 后只能使用白名单 provider/model。

[INFERRED · HIGH] A 添加自己的 provider 后，A 可以使用，管理员不能读取 API Key；管理员关闭 `self_managed` 后 A 不能新增或调用，但历史配置按保留策略处理。

[INFERRED · HIGH] A 的 AI 只能列出 A 有权访问的连接和笔记；即使 AI 模型生成了其他用户的 ID，工具执行器也拒绝。

[INFERRED · HIGH] AI 任务在浏览器关闭后继续；任务进入确认状态时重新打开可恢复确认卡，未经用户点击不会执行敏感动作。

### 24.5 前述技术功能

[INFERRED · HIGH] Deep Link token 跨用户消费、重复消费、过期消费和未登录回跳账号切换都被拒绝；transient 连接不会写入主机库。

[INFERRED · HIGH] 笔记 CRUD、全文搜索、导入导出、连接关联、AI note 工具和 revision 冲突都进行 owner/ACL 测试；A 的笔记链接不能让 B 获得连接权限。

[INFERRED · HIGH] WTerm 输出/scrollback、监控 stats、RDP file-transfer 的所有入口都通过用户和资源授权；用户撤销共享后不再接收新数据。

### 24.6 安全和工程门禁

[INFERRED · HIGH] 运行静态扫描禁止业务代码直接用 `username === 'admin'` 代替授权、直接读取旧全局 connections/settings、把 API Key/password 写入日志或把前端 context 当权限依据。

[INFERRED · HIGH] API、WebSocket、AI tool、后台 Worker、导出、Deep Link、Agent 文件传输和协同锁都要有自动化跨用户越权测试；只测页面按钮不算通过。

[INFERRED · HIGH] 数据迁移、回滚、服务重启、多实例、并发双消费 token、并发修改 ACL、并发任务控制和数据库锁竞争都必须在 CI 或独立验收环境验证。

### 24.7 技术功能与发布门禁

- [INFERRED] 每次提交运行 Node syntax、unit、storage migration、API integration 和 Playwright desktop/mobile。**置信度：HIGH。**
- [INFERRED] 源码门禁禁止 Zephyr 业务层重新出现 `term._doRender`、`term._scheduleRender`、`term._scrollToBottom`、`term._shouldScrollToBottom` 等 WTerm 私有耦合；私有实现只能存在固定 WTerm fork 内并由其自身测试覆盖。**置信度：HIGH。**
- [INFERRED] 数据库迁移必须支持旧库升级、重复执行和失败回滚。**置信度：HIGH。**
- [INFERRED] Deep Link/notes 日志做 secret scanner，测试密码和 JMS token 不得出现在日志快照。**置信度：HIGH。**
- [INFERRED] 灰度指标至少包括：终端异常重连率、WS 401、SSH auth failure、resize/分钟、scroll correction/分钟、监控 render duration、stats exec duration。**置信度：HIGH。**
- [INFERRED] 固定 WTerm fork 每次发布必须验证源码提交、WASM/JS 产物哈希和 API contract；禁止静默回退 npm 原版或在 node_modules 上做未测试临时修改。**置信度：HIGH。**
- [INFERRED] 笔记与 Deep Link transient UI 必须通过桌面/手机及所有主题视觉回归；只有后端/API 通过不算功能完成。**置信度：HIGH。**
- [INFERRED] 数据库 session/notes 和 Deep Link schema 必须向前兼容；回滚不得删除用户笔记或将临时连接写入主机库。**置信度：HIGH。**
- [INFERRED · HIGH] CI 必须额外运行跨用户 HTTP/WS/AI/导出/Deep Link/Agent 越权矩阵；只验证 UI 隐藏不算权限测试。**置信度：HIGH。**
- [INFERRED · HIGH] 发布 artifact 必须记录 schema version、WTerm fork hash、WASM hash 和 migration compatibility；服务重启恢复测试必须使用真实持久卷。**置信度：HIGH。**

---

## 25. 不应采用的伪修复

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
- [INFERRED · HIGH] **不要**只在前端按 username 过滤列表；HTTP、WebSocket、Worker、AI tool、导出和文件传输都必须服务端授权。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**用可修改 username 作为资源外键；必须使用不可变 userId。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**让管理员角色隐式读取所有用户密码、私钥、AI Key、笔记和对话；秘密读取必须是独立 capability 或受审计 break-glass。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**把共享 connection 视为自动共享 proxy、jump host、SSH key 和 Agent；依赖必须在服务端安全解析。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**把终端标签写入未命名空间的 localStorage 后宣称工作区隔离；恢复必须按 userId + clientId 且重新计算 ACL。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**让 AI system prompt 或前端 context 充当权限；每个工具执行点必须调用统一 authz。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**把后台任务继续运行建立在 Node 内存 Map、浏览器 fetch 或单个 WebSocket 上。**置信度：HIGH。**
- [INFERRED · HIGH] **不要**在迁移期间长期双写旧 JSON 与新 owner-aware SQLite；这会造成权限漂移和数据分叉。**置信度：HIGH。**

---

## 26. 最终验收定义

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

### 多用户、权限、恢复与持久任务

[INFERRED · HIGH] 多用户功能只有在以下条件全部满足时才能标记为“可用”，不能因为登录页能创建第二个账号就宣称完成：

1. [INFERRED · HIGH] 用户、会话、资源、工作区、任务、AI、笔记和 Agent token 都有明确 owner 或 system scope。
2. [INFERRED · HIGH] 所有 HTTP、WebSocket、Worker、AI tool、导出和 Deep Link 入口都经过服务端 ACL。
3. [INFERRED · HIGH] A 的私有资源默认不出现在 B/管理员列表，A 可选择共享且可撤销。
4. [INFERRED · HIGH] 管理员可以逐项控制 A 对管理员设备的发现、连接、观察、控制、执行、文件和编辑权限。
5. [INFERRED · HIGH] 每个用户可以独立改密、找回密码、配置 MFA 和个人页面；管理员全局配置不会覆盖用户个人 override。
6. [INFERRED · HIGH] AI 支持禁用、管理员共享、用户自带和混合模式；provider、对话、任务、Memory 和秘密按用户隔离。
7. [INFERRED · HIGH] 浏览器关闭后，持久 SSH/AI 任务继续；重新打开只恢复当前用户有权访问的工作区和任务。
8. [INFERRED · HIGH] 本文的 Deep Link、笔记、WTerm、监控和 RDP 文件传输方案全部接入用户/ACL/任务模型。
9. [INFERRED · HIGH] 数据库迁移、服务重启、多设备并发、权限撤销和跨用户安全测试通过，且日志无秘密泄露。
10. [INFERRED · HIGH] 管理员私有资源治理边界、break-glass 是否开启、RDP 断线重连限制和自定义 JavaScript 安全边界在 UI/文档中明确说明。

### 产品完成边界

- [INFERRED · HIGH] Zephyr 只有在用户、会话、资源、工作区、任务、AI、笔记和 Agent token 都有 owner/system scope，且所有入口完成服务端 ACL 后，才能称为多用户平台。**置信度：HIGH。**
- [INFERRED · HIGH] 浏览器关闭后 SSH/AI 持久任务继续，重新打开只恢复当前用户仍有权访问的页面和任务；不重放输入、不自动批准。**置信度：HIGH。**
- [INFERRED · HIGH] 用户私有资源默认不向管理员公开；管理员设备按 capability 分享；AI 默认不给普通用户，开放方式由明确 policy 决定。**置信度：HIGH。**
- [KNOWN · HIGH] 当前仓库尚未实现本文全部内容；本文是统一实施与验收规格，不是当前能力说明。**置信度：HIGH。**

---

## 27. 参考源码位置

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
- [KNOWN · HIGH] 当前多用户相关基线：`storage.js` 的 `users/connections/settings/passkeys/password_reset_codes` 表与迁移；`server.js` 的内存 `sessions/sshTerminalSessions`、认证、连接和设置路由；`ai-agent-service.js` 的全局 AI settings、同步 `/api/ai/chat` 与工具执行器。**置信度：HIGH。**
- [KNOWN · HIGH] 当前页面恢复相关基线：`public/app.js` 的内存 `terminalTabs/activeTerminalTab/visualLayout`、tab 参数 `sessionStorage` 与本地 AI chat storage；实施前需以目标提交重新定位行号。**置信度：HIGH。**
