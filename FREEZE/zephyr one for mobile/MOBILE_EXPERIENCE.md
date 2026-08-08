# Zephyr One 移动原生体验与视觉系统

> [KNOWN] 产品定位：Zephyr One 不是“能连 SSH 的 Zephyr Lite”，而是 Zephyr 的 Android/iOS 原生客户端。除 [`PRODUCT_REQUIREMENTS.md`](PRODUCT_REQUIREMENTS.md) 明确排除的 Web 部署/账号管理面外，功能必须与 Zephyr 对齐；移动端重构是为了获得更好的交互，不是删功能。
>
> [INFERRED] 本文冻结视觉、交互和动画原则；具体业务字段仍以 Zephyr service、entity registry 和 screen catalog 为准。

## 1. 设计目标

1. [KNOWN] **能力完整**：所有有移动用途的 Zephyr 能力都有原生入口、完整状态、真实服务和测试，不用“手机不适合”当删功能理由。
2. [KNOWN] **平台原生**：iOS 与 Android 共用 Zephyr 品牌和信息架构，但分别遵守平台导航、返回、sheet、菜单、字体、安全区、触觉和系统控件习惯。
3. [INFERRED] **内容优先**：连接、终端、远程桌面、文件和正文占主屏；chrome 在需要时出现，不把桌面 Web 顶栏/侧栏压缩进手机。
4. [INFERRED] **直接操控**：拖动、缩放、远程指针、sheet、返回和浮岛 selection 都实时跟手；动画只解释状态变化，不延迟操作。
5. [KNOWN] **协议与 UI 解耦**：Termux/FreeRDP/VNC 候选提供行为和协议核心参考，不决定 Zephyr One 的视觉层级、导航和数据权限。
6. [INFERRED] **渐进披露而非功能隐藏**：常用项在首层，复杂设置按 section/sheet/搜索展开；被折叠不等于被删除。

## 2. 一个品牌，两套平台语法

### 2.1 共享 Zephyr 品牌

- [KNOWN] Frost/Lava/Asagi/Cyber 四套色板、图标几何、品牌 mark 和连接协议语义共享。
- [INFERRED] 共享 design tokens：颜色语义、spacing/radius 层级、状态图标、协议色、mono 字体用途、motion 语义名称。
- [INFERRED] 不共享硬编码像素布局；Android 使用 dp/sp，iOS 使用 pt/Dynamic Type。
- [INFERRED] 品牌色只用于 selection、primary action、协议状态和少量高价值 emphasis，不把整屏染成主题色。

### 2.2 iOS 表现

- [KNOWN] 所有 push 进入的二级及更深页面必须支持从左边缘开始的 interactive swipe-back；手势 1:1 驱动当前页和上一页，支持中途取消。没有“只有点左上角才能返回”的普通页面。
- [KNOWN] 优先使用 `NavigationStack`/UIKit 原生 interactive pop；不得通过隐藏系统 back button、错误替换 navigation delegate、全屏 horizontal drag 或透明 overlay 意外关闭 `interactivePopGestureRecognizer`。
- [KNOWN] 需要自定义 Zephyr 转场时使用可交互 transition/`UIViewPropertyAnimator` 并与 percent-driven progress 对接；视觉可定制，但 edge arbitration、取消、速度延续和 accessibility escape 保留系统语义。
- [KNOWN] 横向 pager、terminal selection、RDP/VNC direct touch、AI panel drag 不得吞掉 iOS 左边缘返回：边缘保留优先级；远程指针从安全内缩区开始，必须碰边时提供明确 pointer-lock/返回处理。
- [KNOWN] 根页面、modal/sheet 和 destructive confirmation 不伪装成 push：根页无 pop；sheet 用 interactive dismiss；有脏数据时显示确认但不永久禁用后续右滑。
- [INFERRED] `NavigationSplitView` 在 iPad collapse 后同样保留 compact column 的 interactive pop；外接键盘 `⌘[`/Escape 与右滑结果一致。
- [INFERRED] 表单采用 grouped/list section；紧凑选择使用 `Menu`/popover，复杂编辑与确认使用 system sheet/full-screen cover。
- [INFERRED] sheet 使用系统 detent、interactive dismiss 和键盘避让；有未保存数据时拦截 dismiss 并说明。
- [INFERRED] 触觉使用 `UISelectionFeedbackGenerator`/`UIImpactFeedbackGenerator`/`UINotificationFeedbackGenerator`，只在 selection 改变、snap、成功和错误时触发。
- [INFERRED] 字体优先 SF Pro/SF Mono 与 Dynamic Type；不得固定字号导致最大无障碍字体截断。
- [INFERRED] iPad 使用 `NavigationSplitView`、多栏资料/设置和可选外接键盘命令；不把手机浮岛拉成横跨整屏长条。

### 2.3 Android 表现

- [KNOWN] 使用 AndroidX/Compose 的返回事件和 `PredictiveBackHandler` progress，但不采用效果差、与 Zephyr One 空间层级不一致的默认应用内 predictive-back 视觉；应用内 push/pop、浮窗、sheet 由 One 实现自己的 progress-driven 返回动画。
- [KNOWN] 自定义的是返回**视觉和空间映射**，不是私造返回协议：系统 back progress 是唯一手势真源，必须支持 commit/cancel、3-button back、hardware Escape/back 和 accessibility action；返回业务逻辑不绑在动画完成回调上。
- [KNOWN] 返回动画 1:1 跟随 progress，从当前 presentation state 开始；取消回弹到原位，commit 延续当前速度完成。底层 destination 从手势开始就可见，不能在松手后才截屏/创建。
- [INFERRED] push/pop 使用水平 shared-axis：当前页最多移动约 28% 宽度并轻微降 elevation/opacity，底层页从小幅反向 offset 到 0；不整页 scale、不橡皮筋、不夸张 parallax。RTL 方向自动镜像。
- [KNOWN] 根 Activity 返回系统主页/跨任务时交还系统动画；One 不覆盖系统级 home/task transition。自定义只管 App 内 navigation、AI overlay 和自有 sheet。
- [INFERRED] 表单脏状态、selection mode、AI overlay 与普通 navigation 使用单一职责 callback stack；一次手势只改变一个层级。
- [INFERRED] floating island 保留 Zephyr 品牌，但 touch target、ripple/press state、system bars 与 Android edge-to-edge 规则一致。
- [INFERRED] 触觉通过 platform haptic APIs；不用自制固定震动替代系统语义。
- [INFERRED] 字体跟随用户 fontScale；终端字号单独可调，但普通 UI 不绕过系统字号。
- [INFERRED] Android 平板/折叠屏使用 window size class：compact 单列、medium 双栏、expanded 导航/内容/详情；配置变化不丢会话。

### 2.4 不能为了“统一”做的事

- [KNOWN] 不在 iOS 模仿 Android 返回键/ripple，不在 Android 模仿 iOS 全局 edge swipe。
- [INFERRED] 不强制两个平台 sheet 的 detent、context menu、toolbar placement 和 destructive confirmation 像素相同。
- [KNOWN] 不自绘系统键盘、文件选择器、生物识别、权限弹窗或分享面板。
- [INFERRED] 不把玻璃模糊当品牌本身；材质只表示浮层层级，性能/对比度不允许时退为高不透明 tonal surface。

## 3. 响应式信息架构

| 宽度/场景 | 布局 |
| --- | --- |
| compact phone portrait | [KNOWN] 四入口浮岛 + 单层内容；详情 push/full screen |
| phone landscape | [INFERRED] 缩短 chrome；终端/RDP/VNC 进入 edge-to-edge；非沉浸页仍可双栏 |
| foldable half-open | [INFERRED] 避开 hinge；列表/详情分置两区，不跨折痕放主操作 |
| iPad/Android tablet | [INFERRED] NavigationSplitView/自适应三栏；浮岛最大宽固定 |
| hardware keyboard/mouse | [KNOWN] keyboard shortcuts、hover/secondary click、wheel、pointer capture；不只支持触屏 |
| IME open | [KNOWN] 根浮岛与 session dock 隐藏；terminal shortcuts 贴 IME；viewport resize |

[INFERRED] 页面复杂度通过二级导航、搜索、section collapse 和 contextual actions 消化；不得为维持“四入口”而删服务器设置、备份恢复、AI 或 Client Token。

## 4. 视觉语言

### 4.1 Surfaces

- [INFERRED] 背景、content surface、elevated card、floating chrome、modal scrim 五级；每级有明确用途，不叠无意义卡片。
- [INFERRED] 列表优先使用分组和间距，不给每一行套阴影卡片。
- [INFERRED] 浮岛、session dock 和 selection toolbar 才使用 floating surface；普通 top bar 不做第二层玻璃。
- [INFERRED] terminal/RDP/VNC 是沉浸式工作面，chrome 默认最少，点击/边缘手势呼出。

### 4.2 Typography

- [INFERRED] 页面标题、section title、body、caption、mono data 五级；主机、端口、fingerprint、命令、路径使用 mono，不把普通正文全设 mono。
- [INFERRED] 数字状态使用 tabular figures，防止延迟/FPS/进度变化时跳动。
- [INFERRED] 终端字体必须支持清晰区分 `0/O`、`1/l/I`、常用 Nerd Font glyph fallback 和 CJK；fallback 不得改变 cell width。

### 4.3 Color and status

- [KNOWN] protocol color 是辅助识别，不替代协议文字/图标。
- [INFERRED] 成功/警告/错误/离线/待同步/冲突有独立语义色并满足对比度；状态不可只靠红绿。
- [INFERRED] terminal ANSI palette 与 App chrome 主题分离；切 App 主题不得重写服务器输出颜色。
- [INFERRED] RDP/VNC framebuffer 不受 App 色彩滤镜影响。

## 5. Motion 原则

### 5.1 何时动画

- [INFERRED] 动画只服务于：来源→目标空间关系、状态连续性、层级变化、手势跟随、完成/错误反馈。
- [INFERRED] 数据 refresh、终端输出、远程 framebuffer、日志 tail 不做装饰动画；优先降低 latency。
- [INFERRED] destructive action 不用俏皮 bounce；错误可轻微 haptic/颜色反馈，不摇晃整屏。

### 5.2 原生能力

- [KNOWN] Android gesture-driven motion 使用 Compose `Animatable` + `snapTo/animateTo`；导航使用 Compose enter/exit transition，系统返回使用 predictive-back progress。
- [KNOWN] iOS 使用 SwiftUI transaction/spring 和系统 navigation/sheet；需要可交互中断或 UIKit surface 时使用 `UIViewPropertyAnimator`，它支持动态修改动画。
- [INFERRED] keyboard、popover、context menu、haptic、iOS sheet/navigation 等系统已提供且体验合格的 transition 不重复实现；Android 应用内 predictive-back 视觉按 §2.3 自定义，但仍使用系统 progress/commit/cancel。
- [INFERRED] 动画从当前 presentation value 开始，允许中途反向；用户点击后的业务动作不等待动画完成。

### 5.3 House motion

| 场景 | 规则 |
| --- | --- |
| press | [INFERRED] 0–100ms 内反馈；scale 0.97–0.99，仅卡片/浮岛项，不缩整页 |
| floating island selection | [INFERRED] critical damping、无 overshoot、可重定向；标签短 crossfade |
| sheet | [INFERRED] 跟随系统；自定义 drag 1:1，释放速度交给 spring |
| list insert/delete | [INFERRED] subtle placement/opacity；批量变更不同时飞入数十行 |
| sync state | [INFERRED] phase icon/content transition；进度连续，不循环炫技 |
| terminal/RDP toolbar | [INFERRED] 120–180ms fade/offset；出现不挤压 viewport |
| remote pointer | [KNOWN] 不做补间追帧；按协议位置立即更新，避免视觉延迟 |

### 5.4 Reduced motion 与节能

- [KNOWN] iOS Reduce Motion / Android animator duration scale 和 accessibility 状态必须被尊重。
- [INFERRED] Reduced Motion 下取消位移 spring、parallax、shared-axis，改为短 crossfade/即时切换；gesture 仍 1:1 跟手。
- [INFERRED] 低电量/热限制下停掉无限装饰动画，不降低 terminal/RDP/VNC 输入优先级。
- [INFERRED] 动画期间不得阻塞 semantics tree、点击命中或后退。

## 6. 移动端功能重构方法

| Zephyr Web 模式 | One 原生转换 | 不允许 |
| --- | --- | --- |
| 顶栏 + 左侧 tab | [INFERRED] 四根入口 + stack/split detail | 缩成汉堡菜单后丢入口 |
| 大型 modal 表单 | [INFERRED] 分 section sheet/full screen editor | 一屏塞全部字段 |
| hover action | [INFERRED] swipe/context menu/toolbar + 可发现主操作 | 只有长按才能找到关键功能 |
| 多终端网格 | [INFERRED] 手机 session switcher；平板 split | 手机上缩成四个不可读小窗 |
| 桌面右键 | [INFERRED] context menu/secondary click/long press | 只做触屏而不支持鼠标 |
| 文件拖放 | [INFERRED] share sheet/document picker/drop on tablet | 自制文件浏览权限绕过系统 |
| dense settings | [INFERRED] 搜索 + section + role/capability gate | 以“太复杂”为由删除 |
| toast-only error | [KNOWN] inline state + retry + requestId diagnostics | 模糊“失败”toast |

## 7. 体验性能门

- [INFERRED] 触摸/按键视觉反馈必须在下一帧出现；不因等待网络冻结。
- [INFERRED] 60Hz 设备交互帧预算 16.7ms，120Hz 设备 8.3ms；remote decode/render 与 UI chrome 分线程/队列。
- [INFERRED] terminal 输入到本地 glyph commit p95 ≤ 50ms；CJK composition 不重复提交。
- [INFERRED] RDP/VNC 手势只更新 transform/pointer，网络发送合并但最后位置不丢；UI thread 不做像素格式转换。
- [INFERRED] 长列表 2,000 connection、10,000 sync entity、100,000 行 scrollback 不一次性 compose/render。
- [INFERRED] 动画性能测试用系统 profiler、jank stats 和 XCTest metrics；“看起来顺”不是验收证据。

## 8. 无障碍

- [COMMON] Android touch target 至少 48dp；iOS 至少 44pt。
- [KNOWN] TalkBack/VoiceOver 要能读出 connection、protocol、status、selected、conflict 和 action；终端 accessibility 需单独 spike，不能仅暴露一个黑色画布。
- [INFERRED] 外接键盘可以完成根导航、搜索、切会话、终端快捷键、关闭 sheet 和确认；焦点不被动画丢失。
- [INFERRED] context dock/extra keys 报告 modifier latched/locked 状态，不只变颜色。
- [INFERRED] 远程桌面提供“触控板模式”给精细操作；direct touch 不是唯一模式。

## 9. 体验验收矩阵

每个核心 flow 必须在以下组合验证：

```text
Android compact / tablet / foldable
Android gesture nav / 3-button nav
Android Gboard / Samsung / hardware keyboard / mouse

iPhone compact / large / landscape
iPad split view / Stage Manager / hardware keyboard / trackpad

light / dark / Frost / Lava / Asagi / Cyber
normal / largest font
Reduce Motion / screen reader
online / high latency / packet loss / offline
```

[KNOWN] 只有静态截图通过不能验收交互；必须有 gesture trace、IME、动画中断、旋转/resize、后台恢复和真机录屏证据。

### 9.1 返回专项验收

- [KNOWN] Android：0/25/50/75/100% back progress 几何采样；commit、cancel、反向、快速连做、3-button、hardware back、RTL、60/120Hz；一次手势只 pop 一层。
- [KNOWN] Android：根页交还系统 home/task；AI expanded→half→peek→closed→page pop 的层级顺序逐步验证。
- [KNOWN] iOS：每个 push route 自动遍历 edge swipe 30% cancel 与 70% commit；自定义 back button、scroll view、pager、map/remote surface、AI overlay、RTL、Reduce Motion 均测试。
- [KNOWN] iOS：测试不能只调用 `dismiss/pop`；XCUITest/真机必须从物理左边缘拖动并验证上一页在手势期间可见。
- [INFERRED] frame/jank 证据中不得出现返回首帧空白、底层页晚创建、手势取消跳变或完成后重复 pop。

## 10. 发布硬门：不是阉割版

- [KNOWN] 需求矩阵中 Zephyr 有移动用途的能力必须全部为 Android implemented + iOS implemented + server compatible + automated test + 真机验收。
- [KNOWN] 可以改变布局、入口、交互和平台表现；不能降低字段、协议、ACL、同步、错误处理或操作能力。
- [KNOWN] 平台不允许完全等价后台行为时，必须提供前台实现、系统调度和明确状态，不得直接删除功能。
- [KNOWN] 成熟协议库只能减少重复造协议轮子，不能成为删 Zephyr feature、复用旧 UI 或跳过原生体验的理由。
- [KNOWN] 任一核心页面只是 WebView、任一必需能力被列为“以后再说”、或 Android/iOS 只有一端完整，都不得称为 Zephyr One 正式版。
