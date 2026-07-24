# Zephyr motion audit (2026-07-24)

Baseline: production `public/app.js` + `style.css` + `floating-panel.js` vs `public/vendor/zephyr-motion`.

**Rule in force:** APIs + `motion-feel.html` only — **no production wiring**.

## Production motion surface

| Kind | Count / note |
|------|----------------|
| `@keyframes` | 52 (≈11 uses=0 dead) |
| CSS `transition` | 200+ |
| `app.js` `style.transition` | 28 |
| WAAPI `.animate` | 3 (dock launch etc.) |
| `Motion.*` in production | **0** |
| Boot | `zephyr-anim-init` only (not zephyr-motion) |

## Should animate / already CSS

### Signature (must match iOS / macOS)

| Surface | Production today | Apple/mac target | Engine API | Demo |
|---------|------------------|------------------|------------|------|
| 新建/编辑连接 open/close | layout top/left/width/height FLIP + home scale .92 + scrim | SpringBoard continuous surface | `connectionOpen` / `connectionClose` → `iosAppOpen` | B + connection aliases |
| 终端底栏浮窗 (files/docker/info/snippets) | CSS keyframes `floatingPanelOpenFromButton` via `animatePanelFromButton` | macOS panel from dock/button, origin-aware, interruptible | **`macPanel` / `macPanelOpen` / `macPanelClose`** | **§8 新建** |
| Smartbar shelf | `smartbarPanelMacClose` keyframes | Dock shelf rise | **`shelf`** | listRecipes only (light) |
| 窗口灵动岛菜单 | class + CSS vars / keyframes | Island expand | `islandExpand` | A |
| Dock 四通道 magnify | hard setProperty + half zephyr-anim | Near-follow spring | `cssVars` | recipe gallery / incomplete dedicated demo |
| Toast | class + CSS transition | Banner short travel stack | `toast` / `toastPush` | 6b |

### Chrome feedback

| Surface | Production | Engine | Demo |
|---------|------------|--------|------|
| Buttons press | inconsistent | `press` multi-el | §5 |
| Share/temp switches | CSS track only | `switchThumb` | §5 |
| List enter | keyframes | `playStagger` | §4 |
| Shake | login keyframe | `shake` | §5 |

## Violates Apple logic (in production CSS)

| Issue | Where | Why (skill) | Engine stance |
|-------|-------|-------------|---------------|
| Close uses ease-in-ish curve | `floatingPanelCloseToButton` `cubic-bezier(.4,0,.2,1)` | Enter/exit should be ease-out / spring; ease-in feels laggy | `macPanel` close uses `shapeClose` critically damped |
| Layout property FLIP | connection modal top/left/width/height | Perf + hard to interrupt | `connectionOpen` transform-only |
| Frosted blur over home | some scrims/dock glass | Dim ≠ frost icons | pure opacity scrim |
| Multi-phase keyframe handoff | island fluid* (often dead) | Brick-wall velocity on reverse | single-spring expand |
| Dead island fluid keyframes still in CSS | uses=0 | Dead inventory ≠ quality | ignore until wire |

## Gaps: need motion but engine missing or weak

| Need | Engine | Action |
|------|--------|--------|
| clip-path channel for liquid island | ✅ `clipInset` + CLIP_CH writers | demo §10 |
| island w/h CSS vars | ✅ `islandSize` | API ready |
| dock 4-channel magnify | ✅ `dockMagnify` / `dockMagnifyPointer` / `Reset` | demo §9 |
| AI panel product name | ✅ `aiPanelOpen` / `Close` | demo §10 |
| true height layout accordion | ❌ (prefer FLIP) | use morph/cssVars |
| multi-segment WAAPI dock launch | weak | `sharedElement` + one spring when wiring |
| production connection source HTML mirror | partial (`_ensureSourceVisual`) | enough for API; wire clones real card |

**API-layer completeness (2026-07-24 late):** standard interfaces for Zephyr signature + chrome are in place. Remaining work is **runtime unify + production wire**, not more APIs.

## API inventory (standard, not applied)

```
to set stop morph morphTo track drag press stagger
present dismiss popover sheet sequence cssVars sharedElement
play playStagger recipe listRecipes
toast toastDismiss toastPush
switchThumb scrim
islandDots islandExpand islandCollapse islandSquish
iosAppOpen iosAppClose appIconTransition
connectionOpen connectionClose
macPanel macPanelOpen macPanelClose setOriginFromAnchor
shelf
```

## Wiring order (later)

1. Unify runtime (drop zephyr-anim-init → Motion)
2. `openModal` → `connectionOpen`
3. `animatePanelFromButton` → `macPanel`
4. smartbar shelf → `shelf`
5. toast / press / switch thumbs
6. dock cssVars four-channel
7. prune dead keyframes

## Demo URL

http://103.240.198.233:8089/motion-feel.html?v=audit3
