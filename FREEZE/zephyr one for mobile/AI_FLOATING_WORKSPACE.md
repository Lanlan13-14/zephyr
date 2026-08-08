# Zephyr AI 移动浮窗与能力对齐合同

> [KNOWN] Zephyr AI 在 Zephyr 能做什么，在 Zephyr One 就必须能做什么；移动端只改变呈现、上下文桥接和确认交互，不删 tool、capability、risk、confirmation、playbook 或闭环验证。
>
> [KNOWN] 手机上 Zephyr AI 默认不是替换当前内容的独立全屏页，而是覆盖在当前页面/终端/远程桌面之上的原生浮动 workspace，使用户持续看见 AI 正在观察和操作的对象。

## 1. 单一能力真源

- [KNOWN] 服务端 `ai-capabilities.js`、`ai-extended-capabilities.js` 与模型可见 tool catalog 是唯一能力真源；One 不维护容易过期的手写工具子集。
- [KNOWN] 当前全权限 catalog 在基线 `8dd5b98` 有 116 个模型可见 tool；数量会随 Zephyr 演进，不能被硬编码成永久上限。
- [KNOWN] 每次连接主端后获取 `capabilityId/toolId/risk/confirmation/playbook/schema/state`；One UI 根据 registry 生成能力说明、trace、确认和失败恢复。
- [KNOWN] `humanOnly` 保持 human-only：Token enrollment、私钥导入/生成/查看、账号密码、秘密 reveal 不进入模型上下文；“能力一致”不等于放松安全边界。
- [KNOWN] Zephyr 新增 implemented AI capability 后，若 One 没有 host bridge 或原生观察面，compatibility CI 失败；不得静默隐藏。

## 2. 浮窗形态

### 2.1 手机 portrait

- [KNOWN] AI launcher 是页面级浮动 action；打开后先出现低 detent composer，不离开底层页面。
- [KNOWN] 面板有 `peek / half / expanded` 三态：peek 显示状态、输入和 stop；half 显示当前 conversation/trace；expanded 显示完整历史、附件、计划和设置。
- [KNOWN] 即使 expanded 也保留可见的底层 context strip/缩略 live surface 和“一键回到对象”；不能把用户锁进孤立聊天页。
- [INFERRED] 拖动只从 handle 开始；chat scroll、code block、terminal 和 remote gesture 不抢 panel drag。
- [INFERRED] 下拉关闭遵循系统 sheet 阈值与速度；run 活跃时关闭只隐藏 UI，不默认取消任务，状态进入 launcher badge/通知。

### 2.2 landscape / tablet

- [KNOWN] 横屏优先右侧浮动 rail/panel，让 terminal/RDP/VNC 保持主要宽度；用户可切左右。
- [INFERRED] iPad/Android expanded 可停靠为 320–480pt/dp side inspector，并可取消停靠恢复浮窗。
- [INFERRED] panel 尺寸/位置按 scene/window 保存，不跨不兼容尺寸照搬坐标。

### 2.3 IME 与沉浸 surface

- [KNOWN] AI composer 获取输入时，panel 随 IME resize；不得同时显示根浮岛、terminal context dock、AI composer 三层输入 chrome。
- [KNOWN] terminal/RDP/VNC 仍在 panel 后 live 渲染；AI 面板不能暂停 session、清空 selection 或改变 PTY/remote resolution，除非用户明确操作。
- [INFERRED] terminal 可用 compact overlay，RDP/VNC 默认 half/side；面板不覆盖 remote pointer 的最后位置和确认目标标记。

## 3. 用户必须看见 AI 在做什么

[KNOWN] 浮窗不能只是聊天文字，必须把 observation → proposed action → confirmation → execution → verification 做成可观察闭环：

1. **Context header**：当前 page、connection/session/resource、owner/capability 和 freshness。
2. **Live trace**：tool、risk、参数摘要、目标、开始/完成时间、结果；secret 永不展示。
3. **Target highlight**：原生页面高亮将操作的 row/field/action；terminal 高亮 session/range；RDP/VNC 显示 capture id 和 action marker。
4. **Confirmation card**：动作、影响、对象、revision、rollback、风险；R1–R4 遵守服务器 metadata。
5. **Verification**：执行后重新读取 authoritative state；远程桌面 before/after capture；写文件显示 snapshot/rollback id。
6. **Take over**：用户随时暂停 AI、收起 panel 并手工操作；恢复时重新观察，不沿用陈旧 targetRef。

[KNOWN] 底层页面发生导航、revision、session、frame 或 semantics version 变化时，旧引用失效；AI 必须重新 inspect/capture，不能点击旧坐标或旧 row。

## 4. 原生上下文桥接

- [KNOWN] Web `ui_action`/browser DOM 不能直接搬到原生 App；One 提供版本化 `NativeSurfaceBridge`，实现等价能力而不是删除 UI 操作。
- [INFERRED] 每个屏暴露脱敏 semantic tree：`surfaceId/version/nodeId/role/label/value/state/capabilities/bounds/actionIds`。
- [INFERRED] AI action 必须引用 `surfaceId + version + nodeId + actionId`；版本不匹配返回 stale reference 并强制重新 inspect。
- [KNOWN] password/privateKey/token/API key/Env value 的 node 不向模型暴露值；只能暴露 `hasValue` 或受限 human-only action。
- [INFERRED] Compose 语义与 SwiftUI/UIKit accessibility bridge 同时服务自动化和无障碍，但 AI action 仍经过业务 capability gate，不能把 accessibility action 当授权。

### 4.1 Terminal bridge

- [KNOWN] 完整支持 `terminal_read_v1 / terminal_send_v1 / terminal_wait_v1`；read 来源是 authoritative terminal model/scrollback，不是 OCR。
- [KNOWN] send 前显示目标 session、文本摘要和 R2 confirmation；输出等待/验证显示匹配位置与 freshness。
- [KNOWN] 用户手工输入、切 session 或进入 copy mode 后，待确认的 terminal target 重新验证。

### 4.2 RDP/VNC bridge

- [KNOWN] 完整支持 capture/action/verify/cert status/cert decide；captureId 与 surface generation 绑定。
- [KNOWN] AI 浮窗与 remote live surface 同时可见；操作 marker 显示 click/type/key 目标，用户可以在确认前检查。
- [KNOWN] orientation、resolution、zoom 或 viewport 改变使旧 captureId 失效；action 后必须取得 after capture 验证。

### 4.3 Files 与业务页面

- [KNOWN] SFTP/Agent 文件、Connection、Proxy、Key metadata、JumpHost、Snippet、Note、ACL、Docker、Workspace 直接调用 Zephyr canonical tool/service；原生页面同步显示结果和 revision。
- [KNOWN] AI 写文件前创建 snapshot，支持 rollback；Docker mutation、ACL、delete 等显示具体影响，不用统一“允许 AI 操作吗”空洞弹窗。

## 5. Zephyr AI 能力对齐分组

以下全部是 One 的必需能力面，不是可选 roadmap：

| 分组 | Zephyr capability/tool 行为 | One 原生表现 |
| --- | --- | --- |
| Discovery | capability search/playbook | 能力搜索、用途/risk/confirmation 说明 |
| Connection | list/get/create/update/rename/delete/test/open | 底层连接页实时高亮，revision/confirm 与 Zephyr 一致 |
| Proxy/Key/Jump/Snippet | 完整 metadata lifecycle；secretRef | 原生编辑 sheet；秘密仍 human-only/opaque ref |
| Terminal | read/send/wait | 浮窗 trace + 底层 terminal live output |
| Remote desktop | capture/action/verify/cert | live surface + capture/action marker + before/after |
| Agent/phone files | list/stat/read/write/mkdir/rename/delete | “文件同步”命名；目标 profile 与 readOnly 明示 |
| Notes | read/write/delete/groups/trash/bulk | 笔记页 live 更新、revision 与回收站行为一致 |
| SFTP/remote file | list/stat/read/write/snapshot/rollback/chmod | 文件页、diff/影响与 rollback id |
| Docker | status/ps/images/logs/action/pull/mirrors | Docker 页 live 状态；mutation confirmation |
| ACL/share | list/put/delete/shared-with-me | capability 与 expiry 明示，不泄漏 secret |
| Web/browser | search/fetch/navigate/inspect/click/type/scroll/key/wait/close | 外部浏览 session 的原生 preview；不是 App WebView UI |
| Memory/Env | search/save/list/get/set/delete | metadata/hasValue；R4 Env get 强确认且不持久显示 |
| Plan | create/update/delete | plan timeline，状态和取消可见 |
| Workspace/attachment | list/read/write/view | attachment preview、session workspace 与导出 |
| Subagent | profiles/task/parallel/fleet | task tree、锁冲突、子任务状态/取消 |
| Sandbox | status/whitelist exec | 隔离状态、命令与输出 trace |
| UI action | 当前原生界面语义操作 | `NativeSurfaceBridge` versioned node/action |

[KNOWN] AI Provider/模型、协作模式、run profile、permission mode、思考强度、用量、附件、消息编辑/取消、压缩摘要、对话历史、Memory/Skills/Env 入口和 provider sharing 都必须保留；手机用 picker/sheet/overflow 组织，不以顶部放不下为由删除。

- [KNOWN] One 的 AI run 始终请求 Zephyr 主端 runtime；shared Provider API Key、Env secret、Client Token 和 shared resource resolved credential 永不下发。One 只呈现脱敏 stream/trace/confirmation/result。
- [KNOWN] AI 读取/操作 shared-to-me Note、Connection、File、Docker 等时，每个 tool 调用由主端实时重验 ACL 与 note allowAiRead/Write；shared 内容不进 One conversation mirror、Memory、index 或 attachment cache，规则见 [`SHARED_RESOURCE_RESIDENCY.md`](SHARED_RESOURCE_RESIDENCY.md)。

## 6. 浮窗导航与返回

- [KNOWN] AI panel 是 overlay state，不向根 `NavigationStack` 推入普通 destination；打开/收起不破坏底层 navigation path。
- [KNOWN] Android back 顺序：关闭 panel 内 picker/menu/selection → 降一个 detent → 从 peek 收起 AI → 才交给底层 predictive back。每步都由可观察 state 决定，不在 gesture 完成后临时猜。
- [KNOWN] Android panel 的 detent/back motion 使用 back progress/drag progress 1:1；取消时回到当前 presentation state，完成时收起。不得让系统丑陋的默认跨页动画套在 panel 上。
- [KNOWN] iOS panel 内进入 conversation detail/settings 时也必须支持 interactive swipe-back；收起 panel 使用 system interactive sheet gesture，不能把左边缘全屏返回手势据为 panel drag。
- [INFERRED] 用户从底层页右滑/返回时，如果 AI 在 peek 且无 modal state，可先收起 AI 并保留底层页；再次返回才 pop page，防止一次手势造成两个层级变化。

## 7. Motion 与手势

- [KNOWN] AI 浮窗遵循项目 motion skill：响应快、直接操控、可中断、从 presentation state 开始、交接 release velocity、默认临界阻尼、只在物理 flick 中允许轻微 overshoot。
- [INFERRED] panel drag 每帧直接跟手；释放根据位置 + 速度投影选择 detent，不使用固定 300ms keyframe。
- [INFERRED] detent 变化不让底层 surface resize；只改变 overlay clipping/position，避免 terminal PTY 和 remote resolution 抖动。
- [INFERRED] confirmation card 从对应 trace/target anchor 出现；不要从屏幕中央随机放大。
- [KNOWN] Reduce Motion 下 detent 仍随手势 1:1，程序性开关改为短 fade/snap；live trace 不逐条飞入。
- [INFERRED] haptic 只用于 detent snap、要求确认、成功/错误；stream token、每个 tool event 不振动。

## 8. 性能与生命周期

- [KNOWN] AI stream、tool trace、terminal output、remote frame 分离状态流；AI token 更新不能让 terminal/RDP/VNC surface 重组或重绘。
- [INFERRED] chat 使用虚拟化列表；长 tool output 默认 summary，可展开/导出，不一次 layout 全文。
- [KNOWN] App 后台后按 Zephyr runId 恢复；浮窗隐藏不取消 run，显式 Stop 才取消。
- [INFERRED] 系统允许时用 live activity/notification 展示等待确认/完成，但通知不能越过敏感确认执行动作。
- [KNOWN] 旋转、fold、scene resize 后保留 conversation/run/context identity，重新计算 panel geometry；旧 surface/capture reference 作废。

## 9. 测试与发布门

1. [KNOWN] 从服务端真实 catalog 派生测试：每个 model-visible tool 恰有 One bridge 或标记为 server-only external browser，但不能缺失。
2. [KNOWN] risk、confirmation、playbook 与参数 schema 逐项相同；未知 tool 默认不可执行并提示升级。
3. [KNOWN] 浮窗打开时底层 connection/terminal/RDP/VNC 可见且继续更新。
4. [KNOWN] AI 操作的 target、trace、confirmation、result、verification 均可见；旧 reference 必须失败。
5. [KNOWN] Android panel back chain、custom progress animation、取消/反向；iOS 每个 panel 子层 interactive swipe-back 真机通过。
6. [KNOWN] TalkBack/VoiceOver 能在 panel 与底层 context 间有序切换；modal confirmation 正确 trap focus，panel 收起后焦点返回 launcher。
7. [KNOWN] 116-tool 基线只作为当前 fixture；CI 与 Zephyr catalog 动态 diff，新增能力必须先补 One adapter 才允许发版。
8. [KNOWN] shared Provider/Note/Connection/File canary 经 AI tool 执行后，One DB/Memory mirror/attachment cache/log/trace 中不得出现 Provider Key、Env value、Client Token、resolved credential 或 shared 正文持久副本。
9. [KNOWN] ACL/allowAiRead/allowAiWrite 在 run 中途撤销时，下一 tool call 立即失败并清当前 shared content page；不能靠 run 开始时授权继续到底。

任一情况下 Zephyr AI 必须打开独立全屏页才能操作、用户看不到目标 surface、One tool catalog 少于同版本 Zephyr、或 UI stream 使 terminal/remote 输入掉帧，均为发布阻断。
