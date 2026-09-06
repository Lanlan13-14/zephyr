# Liquid Glass 工程规格（Android · core-ui glass 包）

> 状态：已落地（PR #104 → #106 → #107/#108 修复后形态）。
> 分支基线：`main` @ `7d4e422`（v1.1.537 / zom-v1.0.0pre61）。
> 源码位置：`zephyr_one/mobile/android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/glass/`
> 本文是对既有实现的规格化描述 + 扩展守则，不是新设计提案。所有数值均从代码读出，逐条可回溯。

---

## 1. 系统分层

```
┌─ 消费层 ────────────────────────────────────────────────┐
│ FloatingIsland（胶囊 + 选中滑块）                        │
│ liquidGlass() / LiquidButton / LiquidSurface（便捷 API） │
├─ 修饰符层 ──────────────────────────────────────────────┤
│ drawBackdrop / drawPlainBackdrop（DrawBackdropModifier） │
│ layerBackdrop（Backdrop.kt，源内容登记）                 │
├─ 特效层 ────────────────────────────────────────────────┤
│ BackdropEffectScope: blur / lens / vibrancy / opacity    │
│ / colorControls / colorFilter / runtimeShaderEffect      │
├─ 着色器层（AGSL，SDK 33+）──────────────────────────────┤
│ RoundedRectRefraction / +Dispersion / Highlight×2        │
├─ 平台层 ────────────────────────────────────────────────┤
│ Platform.kt: GlassRuntime 进程级降级开关                 │
└──────────────────────────────────────────────────────────┘
```

文件清单（契约测试 `android-liquid-glass-contract.test.mjs` 锁定 11 个文件）：
`Backdrop` `BackdropEffectScope` `DrawBackdropModifier` `Effects` `Highlight` `Internal` `LiquidGlass` `Platform` `RuntimeShader` `Shadow` `Shaders`。

## 2. 核心抽象

### 2.1 `Backdrop` 接口

```kotlin
interface Backdrop {
    val isCoordinatesDependent: Boolean
    fun DrawScope.drawBackdrop(density, coordinates, layerBlock)
}
```

- `LayerBackdrop`：离屏录制源内容的实现。`layerBackdrop()` 修饰符登记源节点；每次成功 record 后 `recordGeneration += 1`（mutableIntStateOf），消费方在 draw 时读它以获得失效驱动。**这条是 #107 修的：录完不通知，玻璃会一直采第一帧（常为空）。**
- `Combined2Backdrops`（`rememberCombinedBackdrop`）：按序绘制两个 backdrop，`isCoordinatesDependent` 取或。
- `LocalBackdrop`：组合注入点。`ZephyrOneRoot` 建 root `LayerBackdrop`，`CompositionLocalProvider(LocalBackdrop provides rootBackdrop)` + `.layerBackdrop(rootBackdrop)` 注入整树。

### 2.2 坐标映射

`LayerBackdrop.drawBackdrop` 用 `layerCoords.localPositionOf(coords)` 计算 `-offset` 平移后 `drawLayer`；坐标未挂载或已 detach 时异常回落到 `positionInWindow()` 差值，两个 backdrop 都拿不到时直接不画（安全空帧）。

### 2.3 `drawBackdrop` 绘制管线（DrawBackdropNode）

每帧顺序，**不可乱**：

1. `effectScope.update(this)` → `updateEffects()`（observeReads 包裹，状态变化自动失效）
2. `onDrawBehind`
3. `drawBackdropLayer`：`recordLayer(layer, size + 2*padding)` → 成功则 `layer.topLeft = (-pad, -pad)` → `drawLayer`；**record 失败 = 跳过本帧背景，不重试不崩溃**
4. `onDrawSurface`（表面色/tint）
5. `drawContent()`
6. `onDrawFront`
7. `exportedBackdrop` 存在时再 record 一份（behind→backdrop→surface→front）并 `notifyRecorded()`

布局层：`placeable.placeWithLayer`，`layoutLayerBlock = { clip = true; shape = shape; compositingStrategy = Offscreen }`。

**容错（#106/#108 定稿）**：整个 `draw()` 包 try/catch。单帧失败（0×0 record、Adreno quirk）只 warn + 画 surface/content，下一帧重试；**只有 AGSL 编译失败才 `disableShaders()`**（进程级），普通 draw 异常绝不再触发 `disableEffects()`。

### 2.4 padding（过扫描）语义

特效声明需要多大过扫描：`blur` 取 max，`lens` 把 padding 收缩 `refractionHeight`（折射吃掉模糊边缘）。`updateEffects` 每帧重算并写入 `graphicsLayer.renderEffect`。record 尺寸 = 内容 + 2×padding，`topLeft` 负偏移把过扫描移出可视区。SDK < 31 时 padding 恒 0、renderEffect 恒 null。

## 3. 着色器（AGSL）

移植自 [Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass)（Apache-2.0），包内保留出处注释。

| 着色器 | 用途 | 关键 uniform |
|---|---|---|
| `RoundedRectRefractionShaderString` | SDF 圆角矩形折射 | size / offset / cornerRadii / refractionHeight / refractionAmount / depthEffect |
| `RoundedRectRefractionWithDispersionShaderString` | 折射 + 色散（色差） | 上述 + chromaticAberration / dispersionIntensity |
| `DefaultHighlightShaderString` | 定向高光（angle/falloff，BlendMode.Plus） | color / angle / falloff |
| `AmbientHighlightShaderString` | 环境边缘光（BlendMode.SrcOver） | — |

**Adreno 安全守则（小米 HyperOS SIGSEGV 实证，勿回退）**：
- 一律用 `safeNormalize(v)`（len ≤ 1e-4 → 返回 0 向量），禁止裸 `normalize`。JVM 测试 `shadersNeverCallBareNormalizeOnAZeroVector` 扫全部四个着色器源码。
- `size.x < 1.0 || size.y < 1.0` 直接 `content.eval(coord)` 透传——首帧 island 可能 0×0。
- `height = max(refractionHeight, 1e-4)`、`denom = max(halfSize.x*halfSize.y, 1.0)` 防除零。
- `RuntimeShaderCacheImpl` 按 key 缓存实例；`createRuntimeShaderEffect` 抛错时 `disableShaders()` 并返回 null。

## 4. 平台降级阶梯

```
SDK ≥ 33（T）  AGSL 折射 + RenderEffect 全链
SDK 31–32（S） RenderEffect blur/colorFilter，无 AGSL 折射
SDK 26–30      无 GPU 玻璃 → onDrawSurface 纯色圆角
进程级开关     GlassRuntime.{shadersEnabled, effectsEnabled}
```

`GlassRuntime` 是 `@Volatile` 进程级 kill switch：`disableShaders()`（仅 AGSL）、`disableEffects()`（含 blur）、`resetForTests()`。判定入口 `isRuntimeShaderSupported()` / `isRenderEffectSupported()`，所有特效函数开头先查，不支持时静默 no-op——**调用方永远不用写 if(SDK)**。

## 5. 岛配方（FloatingIsland，Kyant `LiquidBottomTabs` 对齐版）

三层结构：内容 backdrop（root）→ 胶囊（自身导出）→ 选中滑块（`Combined(content, capsule)`）。

| 层 | backdrop | 效果 | 表面 |
|---|---|---|---|
| 胶囊 | `LocalBackdrop`（root） | blur 8dp；lens 12dp/24dp + CA；Highlight.Default（暗色 α0.6）；Shadow 32dp/offset16dp（暗 0.4/亮 0.16）；InnerShadow 8dp（暗 0.5/亮 0.2） | 暗 `#202020` 10% / 亮 white 10% |
| 滑块 | `Combined(root, capsule)` | lens 10dp/14dp + CA；无 Shadow；InnerShadow 8dp 黑 0.8 | white 8% |

**禁令（#107 实证）**：
- 胶囊与滑块上禁用 Material `Modifier.shadow`——投影层会把折射盖死。
- 表面 alpha 上限 ~0.30；默认 `liquidGlass` 的 `surfaces.floating` 0.82/0.70 是给不透明容器的，岛用 `drawBackdrop` 手写 10%/8%。
- 滑块 `graphicsLayer { compositingStrategy = Offscreen }` 必须保留（自采样需要）。

## 6. 扩展守则（给新表面接玻璃）

1. 全局有 root `LayerBackdrop`（`ZephyrOneRoot` 已注入），新表面默认 `LocalBackdrop.current` 即可。
2. 简单场景直接 `Modifier.liquidGlass(...)`；需要自定义分层才下沉到 `drawBackdrop`。
3. 需要"玻璃采玻璃"（嵌套）时：外层传 `exportedBackdrop = rememberLayerBackdrop()`，内层 `rememberCombinedBackdrop(outerContent, exported)`。
4. 动画元素（滑块、拖拽）必须 `placeWithLayer` + `layerBlock` 传入 `drawBackdrop`，否则 backdrop 坐标映射不跟随。
5. 新特效先写进 `BackdropEffectScope`（带 `isRenderEffectSupported()`/`isRuntimeShaderSupported()` 早退），不要在调用点拼 RenderEffect。
6. 新 AGSL 着色器必须：`safeNormalize`、0×0 透传、防除零，并加入 JVM 扫描测试的 source 列表。

## 7. 验证契约

| 测试 | 位置 | 锁什么 |
|---|---|---|
| `LiquidGlassTest` | core-ui JVM | 着色器源码含 SDF/无裸 normalize、Highlight/Shadow 默认值、Capsule outline、ShapeProvider 缓存、RuntimeShader 缓存 |
| `android-liquid-glass-contract.test.mjs` | mobile/tests (node) | 11 个文件存在、关键符号（`interface Backdrop`、`LocalBackdrop`、着色器名、`Modifier.liquidGlass`） |

契约测试与 JVM 测试必须随任何 glass 改动同步更新——改了实现不改契约 = CI 红或者契约失效。

## 8. 性能预算与已知陷阱

- 每个玻璃节点每帧 ≤ 2 次 record（自绘 + export）；record 是最贵的操作，嵌套层数 ≥ 3 需评审。
- `recordGeneration` 是唯一失效驱动：消费方 draw 读它，record 失败不 bump → 上一帧画面保留（比黑帧好）。
- `padding` 过大会放大 record 尺寸（blur 半径直接进 padding）。blur > 24dp 需给出理由。
- 历史踩坑（勿复发）：#106 首帧 0×0 record + `normalize(0)` SIGSEGV → 守卫入着色器；#107 LayerBackdrop 不通知 → recordGeneration；#108 单帧失败整进程关 GPU → 改为逐帧跳过；Material shadow/高 alpha 表面盖折射 → 岛配方定稿。