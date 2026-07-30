# zephyr-motion — 标准接口文档

**状态：Go/WASM 标准接口 + 生产接线并行维护**
**日期：2026-07-30**
**原则：稳定交互使用 `standard` / 产品签名 API；调用方不复制底层 response/damping。**

入口：

```js
import { Motion, engine, PRESETS, resolvePreset } from './vendor/zephyr-motion/index.js';
// 或 window.Motion（index.js 自动暴露 + auto init）
await Motion.init({ capacity: 512 }); // 幂等
```

演示验收页默认关闭；容器内执行 `touch /tmp/zephyr-motion-demo.enabled` 后，超级管理员会话可访问 `/motion-feel.html`。容器重启自动关闭。离线可直接使用 `tests/motion-feel.html`。
合同测试：`tests/motion-semantic-api-contract.test.mjs`  
审计：`plans/MOTION-AUDIT-2026-07-24.md` · `plans/README.md`

---

## 1. 设计规则（接线时不可违反）

来自 Apple / Emil skill + 本仓库约定：

1. **可打断**：从当前呈现值 retarget，禁止输入锁死；禁用 keyframes 驱动手势。
2. **只动合成层**：`transform` / `opacity` / `filter` / CSS 变量；宽高优先 FLIP。
3. **弹簧参数**：`response` + `damping`（`damping: 1` = 临界阻尼，默认 UI 无弹）。
4. **禁止 `scale(0)`**：进入下限约 `0.95–0.96`（`DEFAULT_ENTER_SCALE`）。
5. **空间对称**：从哪边进从哪边出；popover origin = 触发器。
6. **dim ≠ frost**：scrim 用纯黑半透明；不要 `backdrop-filter` 糊住主屏图标。
7. **hideSource 默认 false**（工具栏按钮必须可见）；图标启动才 `hideSource: true`，且 **`restoreSource` 必须先 `release()`** 再清样式（防引擎通道把 opacity 写回 0）。
8. **循环装饰**（spin/pulse/loader）留在 CSS；`play()` 会拒绝 `CSS_ONLY_RECIPES`。

---

## 2. Presets（`presets.js`）

| 名 | response | damping | 用途 |
|----|----------|---------|------|
| `snappy` | 0.28 | 1.0 | 按钮、toast、小 popover |
| `ui` | 0.40 | 1.0 | 默认位移 |
| `gentle` | 0.55 | 1.0 | 大表面 |
| `sheet` | 0.30 | 0.80 | 抽屉（可轻微 overshoot） |
| `morph` | 0.45 | 0.92 | 共享元素 |
| `shape` | 0.55 | 1.0 | App/全屏几何 |
| `shapeClose` | 0.48 | 1.0 | 全屏关闭 |
| `content` / `contentClose` | 0.40 / 0.32 | 1.0 | 内容淡入出 |
| `scrim` | 0.50 | 1.0 | 遮罩 |
| `home` | 0.55 | 1.0 | 主屏退缩 |
| `icon` | 0.45 | 1.0 | 图标 |
| `mac` / `macClose` | 0.32 / 0.28 | 1.0 | **浮窗/菜单** |
| `dock` | 0.18 | 0.95 | Dock 跟手 |
| `island` / `islandPress` | 0.42 / 0.22 | 0.92 / 0.95 | 灵动岛 |
| `bouncy` | 0.40 | 0.72 | **仅**甩出后 |

```js
resolvePreset('mac') // → { response, damping }
resolvePreset({ response: 0.3, damping: 1 })
```

---

## 3. Go/WASM 标准动作接口

标准动作不是 JS 侧 preset 的别名。标准编号由 Go `motion.Standard` 定义，
通过 WASM ABI `engine_configure_standard(id, standard) -> 1|0` 配置槽位；
重新配置会保留当前呈现值与速度，因此可在飞行中反向或换目标。

```js
import { Motion, MOTION_STANDARDS } from './vendor/zephyr-motion/index.js';

await Motion.to(card, { rotateY: -180 }, {
  standard: MOTION_STANDARDS.iosCardFlipOpen,
});
```

| JS 标准名 | ABI 编号 | Go 参数 | 用途 |
|---|---:|---|---|
| `iosCardGeometryOpen` | 1 | response `0.44`, damping `1.00` | 小卡片到详情卡的 FLIP 几何；临界阻尼、无边缘抖动 |
| `iosCardGeometryClose` | 2 | `0.34`, `1.00` | 对称收回；关闭快于打开 |
| `iosCardFlipOpen` | 3 | `0.50`, `0.90` | `rotateY(0→-180)`；仅亚 1° soft settle |
| `iosCardFlipClose` | 4 | `0.38`, `0.96` | `rotateY(-180→0)`；近临界、快速回收 |
| `iosCardContent` | 5 | `0.32`, `1.00` | 正反面/详情内容淡入淡出 |
| `iosCardScrim` | 6 | `0.42`, `1.00` | 纯 dim 遮罩；不使用 backdrop blur |

### 3.1 iOS 双面卡片标准签名

```js
await Motion.iosCardOpen(cardSurface, sourceCard, {
  frontEl: cardSurface.querySelector('.face.front'),
  backEl: cardSurface.querySelector('.face.back'),
  scrim,
  radiusFrom: 28,
  radiusTo: 36,
});

await Motion.iosCardClose(cardSurface, sourceCard, {
  frontEl,
  backEl,
  scrim,
});
```

`iosCardTransition(surface, source, { open })` 是统一底层签名，open/close 是
可读别名。实现约束：

- 几何和 Y 轴旋转使用独立 Go 标准槽位；不可把两者压成同一曲线。
- 只动画 `transform` / `opacity` / 补偿圆角；不 tween `width/height`。
- 打开与关闭沿同一锚点路径，关闭更快；支持中途反向，不设 busy lock。
- 正反面需要 `backface-visibility: hidden`；容器需要 `perspective`，surface
  会自动设置 `transform-style: preserve-3d`。
- reduced-motion 由 runtime 直接跳终态；WASM 不可用时 JS 使用同参数 fallback。

---

## 4. 原子 API

| API | 说明 |
|-----|------|
| `init({ capacity })` | 启动引擎 |
| `to(el, props, { preset, delay, velocity, units })` | 弹簧到目标 |
| `set(el, props)` | 立即写值 |
| `stop(el, channels?)` | 停在当前值 |
| `value(el, ch)` | 读通道 |
| `release(el)` | 释放槽位 + 清理 managed 样式 |
| `isAnimating(el)` | 是否在飞 |
| `setReducedMotion(bool\|null)` | 减弱动态 |
| `morph(el, fromRect, opts)` / `morphTo(el, toRect, opts)` | FLIP；`radiusCompensate` 默认开 |
| `track` / `drag` | 手势 + 动量投影 |
| `press(el\|els, { scale: 0.97 })` | 按下反馈（支持 NodeList、键盘） |
| `stagger(els, props, { step })` | 交错 |
| `present` / `dismiss` | 语义进出（scale≥0.96） |
| `popover(el, trigger)` | origin-aware |
| `sheet(el, { edge, open, scrim })` | 边栏 |
| `sequence(steps)` | 步骤链 / wait |
| `cssVars(el, props, { units, preset })` | 多通道 CSS 变量 |
| `sharedElement` | morph + 藏源 + scrim |
| `play(el, recipeName)` / `playStagger` / `recipe` / `listRecipes` | 命名配方 |
| `crossfade` / `shake` / `attention` / `scrim` / `switchThumb` | 杂项反馈 |

**常用 props：** `x y scale scaleX scaleY rotate opacity radius blur saturate w h`  
**clip：** `clipTop/Right/Bottom/Left`（%）`clipRound`（px）→ `clip-path: inset(...)`  
**CSS 变量：** 任意 `--foo` + `units: { '--foo': 'px' }`

---

## 5. 产品级签名 API（接线对照表）

### 5.1 新建/编辑连接（iOS 主屏）

```js
// 现状：openModal / closeModal 用 top/left/width/height CSS transition
// 目标：
await Motion.connectionOpen(transitionLayer, sourceCardEl, {
  scrim: scrimEl,           // 纯黑 0.24，勿 backdrop-filter
  home: appShellEl,         // scale 0.92
  contentEl: modalContent,
  cloneSource: true,
  hideSource: true,         // 仅图标/卡片启动
  restoreSource: true,
});
await Motion.connectionClose(transitionLayer, sourceCardEl, { ... });
// 底层：iosAppOpen / iosAppClose
```

默认：`scrimOpacity: 0.24`，`homeScale: 0.92`，`homeBlur: 0`。

### 5.2 终端底栏浮窗（macOS 面板）

```js
// 现状：floating-panel.js animatePanelFromButton + CSS keyframes
// 目标：
await Motion.macPanel(panelEl, toolbarBtn, {
  open: true,
  mode: 'flip',          // 从按钮矩形 FLIP 长出（推荐）
  // mode: 'origin',     // 轻量 popover 缩放
  hideSource: false,     // 工具栏按钮必须保持可见
  contentEl: panelBody,
  radiusTo: 12,
});
await Motion.macPanel(panelEl, toolbarBtn, { open: false, mode: 'flip', hideSource: false });
// 别名：macPanelOpen / macPanelClose
// setOriginFromAnchor(panel, button) 可单独用
```

### 5.3 灵动岛窗口菜单

```js
await Motion.islandExpand({ grip, panel, opts: { radiusFrom: 11, radiusTo: 22, hideGrip: true } });
await Motion.islandCollapse({ grip, panel, opts: { radiusTo: 11, hidePanel: true } });
Motion.islandDots(grip, 'melt' | 'return' | 'squash');
Motion.islandSquish(grip, true|false);
Motion.islandSize(grip, { w: 214, h: 34 });
Motion.clipInset(el, { top:0, right:44, bottom:86, left:44, round:999 }); // 液体遮罩
```

### 5.4 Toast

```js
// 现状：classList + CSS transition
// 目标：
Motion.toastPush(hostEl, { text: '已保存', kind: 'success', duration: 2.6, edge: 'top' });
// 或手动：
Motion.toast(el, { edge: 'top', distance: 28 });
Motion.toastDismiss(el, { edge: 'top', thenRemove: true });
```

### 5.5 Dock 放大

```js
// 现状：updateDockMagnification 硬写 CSS 变量 + zephyr-anim 半套
// 目标（pointermove）：
Motion.dockMagnifyPointer(dockEl, e.clientX, e.clientY, {
  itemSelector: '.smartbar-session, .smartbar-add',
  vertical: false,
  maxScale: 1.26,
  maxLift: 15,
});
// pointerleave：
Motion.dockMagnifyReset(dockEl);
// 单图标：
Motion.dockMagnify(itemEl, { scale: 1.2, lift: -12, shift: 4, rotate: -1, blur: 0 });
```

CSS 需保留：

```css
transform: translate3d(var(--dock-shift), var(--dock-lift), 0)
  scale(var(--dock-scale)) rotateZ(var(--dock-rotate));
filter: blur(var(--dock-blur));
```

### 5.6 AI 面板 / Smartbar shelf

```js
Motion.aiPanelOpen(panel, triggerBtn, { contentEl, hideSource: false });
Motion.aiPanelClose(panel, triggerBtn, { contentEl });
Motion.shelf(panel, { open: true, edge: 'bottom', travel: 20 });
```

### 5.7 列表 / 配方

```js
Motion.play(el, 'connectionCardIn');
Motion.playStagger(cards, 'connectionCardIn', { step: 0.055 });
Motion.cardIn(el); Motion.cardOut(el);
Motion.floatPanelOpen(el); // recipe alias
// listRecipes() → { spring, cssOnly, signature }
```

### 5.8 反馈

```js
Motion.press(document.querySelectorAll('.btn'));
Motion.switchThumb(thumbEl, on, { travel: 20, trackFillEl, pop: true });
Motion.shake(el); Motion.attention(el);
```

---

## 6. hideSource 安全规则（接线必读）

| 场景 | hideSource |
|------|------------|
| 工具栏 / Dock 按钮 → 浮窗 | **`false`（默认）** |
| 主屏图标 → 全屏 | `true`，关闭必须 `restoreSource` / `restoreSources` |
| 实现 | 只改 CSS opacity；**禁止** `Motion.set(icon, { opacity: 0 })` |
| 恢复 | `restoreSource` **先 `release()`** 再清 style |

```js
Motion.hideSource(surface, icon);
// ...
Motion.restoreSources(surface); // finally 里永远调用
```

---

## 7. 推荐接线顺序（下次）

1. **统一 runtime**：`app.html` 只加载 `zephyr-motion`，移除 `zephyr-anim-init`（见 `plans/001-unify-motion-runtime.md`）。
2. **`openModal` / `closeModal` → `connectionOpen` / `connectionClose`**。
3. **`animatePanelFromButton` → `macPanel`**（`floating-panel.js` + terminal 各面板）。
4. **Toast / press / switch** 替换 class 硬切。
5. **`updateDockMagnification` → `dockMagnifyPointer`**。
6. **岛菜单 → `islandExpand`**（接受 transform 模型或继续 CSS vars + `islandSize`）。
7. **删 uses=0 的死 keyframes**（清单见 feel §11 / 审计文档）。

每步：先演示页手感 → 单表面接线 → contract 防回归。

---

## 8. 文件地图

```
public/vendor/zephyr-motion/
  index.js          入口 / window.Motion
  motion.js         全部高层 API（本文档主体）
  presets.js        PRESETS + resolvePreset
  runtime.js        wasm/JS 后端、rAF、reduced-motion
  spring.js         JS 物理 fallback
  zephyr_motion.wasm
  API.md            ← 本文件

tests/motion-feel.html              中文验收演示
internal/motion-feel.html           受容器临时开关 + 超级管理员会话保护的在线验收页
tests/motion-semantic-api-contract.test.mjs
plans/MOTION-AUDIT-2026-07-24.md
plans/001-unify-motion-runtime.md
plans/002-semantic-present-api.md
plans/README.md
motion-wasm/README.md               物理与 ABI
```

---

## 9. 演示节索引（`motion-feel.html`）

| 节 | 内容 |
|----|------|
| A | 灵动岛 expand/collapse |
| B | iOS 应用打开/关闭 |
| 配方目录 | play(recipe) 全表 |
| 1–2 | retarget / drag |
| 3 | Morph 下拉菜单 |
| 4 | playStagger 列表 |
| 5 | press / switch / shake |
| 6 / 6b | present / toast 堆叠 |
| 7 | popover / sheet / crossfade |
| 8 | macPanel 底栏浮窗 |
| 9 | dock 四通道 |
| 10 | AI / shelf / clipInset |
| 11 | 死 keyframes 名单 |

---

## 10. 明确不做 / 勿接线错误用法

- 不要把 `spin` / `pulse` / loader 改成 spring。  
- 不要对工具栏按钮默认 `hideSource: true`。  
- 不要用 layout 属性 tween 代替 `connectionOpen`。  
- 不要在未 `release` 时只靠 `style.opacity=''` 恢复图标。  
- 未接线前不要删生产 CSS keyframes（演示与回退仍依赖）。

**下次接线从第 6 节第 1 步开始。**
