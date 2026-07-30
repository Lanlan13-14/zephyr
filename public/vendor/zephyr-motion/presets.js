/**
 * presets.js — Apple-semantic spring presets (WWDC 2018 parameterisation).
 *
 * response: seconds, how quickly the value approaches the target.
 * damping : ratio; 1.0 = critically damped (default for UI, no overshoot),
 *           < 1.0 bounces — reserve bounce for momentum-driven gestures.
 *
 * Reference points Apple ships:
 *   move/reposition (PiP)   damping 1.0  response 0.4
 *   rotation                damping 0.8  response 0.4
 *   drawer / sheet          damping 0.8  response 0.3
 */
export const MOTION_STANDARDS = Object.freeze({
  iosCardGeometryOpen: 1,
  iosCardGeometryClose: 2,
  iosCardFlipOpen: 3,
  iosCardFlipClose: 4,
  iosCardContent: 5,
  iosCardScrim: 6,
});

export const STANDARD_FALLBACKS = Object.freeze({
  [MOTION_STANDARDS.iosCardGeometryOpen]: { response: 0.44, damping: 1.00 },
  [MOTION_STANDARDS.iosCardGeometryClose]: { response: 0.34, damping: 1.00 },
  [MOTION_STANDARDS.iosCardFlipOpen]: { response: 0.50, damping: 0.90 },
  [MOTION_STANDARDS.iosCardFlipClose]: { response: 0.38, damping: 0.96 },
  [MOTION_STANDARDS.iosCardContent]: { response: 0.32, damping: 1.00 },
  [MOTION_STANDARDS.iosCardScrim]: { response: 0.42, damping: 1.00 },
});

export const PRESETS = {
  snappy:  { response: 0.28, damping: 1.0 },  // buttons, small popovers, press feedback
  ui:      { response: 0.40, damping: 1.0 },  // default repositioning (Apple PiP move)
  gentle:  { response: 0.55, damping: 1.0 },  // large surfaces, slow pans
  sheet:   { response: 0.30, damping: 0.80 }, // drawers / sheets (gesture-driven)
  morph:   { response: 0.45, damping: 0.92 }, // shared-element / generic morph
  // iOS SpringBoard — prefer critically damped (no bounce).
  // 对齐参考实现（iOS True Morph）：open 0.52s / close 0.42s 的"干脆退出"。
  // shape 0.42 → 视觉收敛 ~0.65s；shapeClose 0.30 → ~0.5s（关比开快 0.12s）。
  shape:   { response: 0.42, damping: 1.0 }, // icon→app geometry (critically damped)
  // 关：临界阻尼。欠阻尼（0.88）在非等比 FLIP 上 x/y/sx/sy 各自过冲不同步 →
  // 肉眼成「上下乱弹」而不是干净的 soft settle。Apple WWDC：bounce 留给有动量的手势，
  // 按钮 dismiss 无 flick 不该 overshoot。
  shapeClose: { response: 0.32, damping: 1.0 },
  content: { response: 0.34, damping: 1.0 },  // chrome fade after geometry leads
  contentClose: { response: 0.22, damping: 1.0 },

  scrim:   { response: 0.50, damping: 1.0 },  // dim with home
  home:    { response: 0.55, damping: 1.0 },  // wallpaper recede (matches shape time)
  icon:    { response: 0.45, damping: 1.0 },
  dock:    { response: 0.18, damping: 0.95 },
  // macOS panel / popover / toolbar window — snappy, critically damped
  // (shorter than SpringBoard app open; similar to menu/popover ~250–320ms feel)
  mac:     { response: 0.32, damping: 1.0 },
  macClose:{ response: 0.28, damping: 1.0 },
  // Island: less bouncy than before — liquid via non-uniform scale, not bounce
  island:  { response: 0.42, damping: 0.92 },
  islandPress: { response: 0.22, damping: 0.95 },
  bouncy:  { response: 0.40, damping: 0.72 },
};

/** Resolve a preset name or {response, damping} object to numbers. */
export function resolvePreset(p, fallback = 'ui') {
  if (p && typeof p === 'object') {
    const r = Number(p.response), d = Number(p.damping);
    if (r > 0 && d > 0) return { response: r, damping: d };
  }
  return PRESETS[p] || PRESETS[fallback] || PRESETS.ui;
}
