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
export const PRESETS = {
  snappy: { response: 0.28, damping: 1.0 },  // buttons, small popovers, press feedback
  ui:     { response: 0.40, damping: 1.0 },  // default repositioning
  gentle: { response: 0.55, damping: 1.0 },  // large surfaces, slow pans
  sheet:  { response: 0.30, damping: 0.80 }, // drawers / sheets (gesture-driven)
  morph:  { response: 0.45, damping: 0.92 }, // shared-element transitions, hint of overshoot
  dock:   { response: 0.22, damping: 0.95 }, // dock magnification follow
  island: { response: 0.34, damping: 0.86 }, // dynamic-island style fluidity
  bouncy: { response: 0.40, damping: 0.72 }, // ONLY after a flick/throw
};

/** Resolve a preset name or {response, damping} object to numbers. */
export function resolvePreset(p, fallback = 'ui') {
  if (p && typeof p === 'object') {
    const r = Number(p.response), d = Number(p.damping);
    if (r > 0 && d > 0) return { response: r, damping: d };
  }
  return PRESETS[p] || PRESETS[fallback] || PRESETS.ui;
}
