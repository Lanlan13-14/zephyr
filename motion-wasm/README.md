# zephyr-motion

Physics-based animation engine for the Zephyr UI. Go (wasm) core + thin JS
runtime, implementing Apple's fluid-interface motion model (WWDC 2018):
springs everywhere, interruptible retargeting, velocity handoff, momentum
projection, rubber-band boundaries.

**Status: foundation layer.** Existing CSS/JS animations are untouched;
surfaces migrate onto this engine phase by phase (see repo plans).

## Layout

```
motion-wasm/                     Go module (physics core + wasm ABI)
  motion/                        pure-Go physics — natively testable
    spring.go                    analytic damped-harmonic-oscillator solver
    engine.go                    slot pool + shared frame buffer
    tracker.go                   gesture velocity (weighted least squares)
    physics.go                   momentum projection + rubber-banding
    bezier.go                    cubic-bezier sampler (non-spring fallback)
    testdata/motion-golden.json  golden vectors (Go = wasm = JS)
  abi.go                         shared ABI implementation
  main_tinygo.go                 //export front-end (CI artifact)
  main_stdgo.go                  //go:wasmexport front-end (local verify)

public/vendor/zephyr-motion/     JS runtime (what app code imports)
  zephyr_motion.wasm             committed artifact (built by CI, TinyGo)
  runtime.js                     backend selection (wasm → JS), rAF loop,
                                 bindings, onRest, reduced-motion
  motion.js                      high-level API: to/set/stop/morph/morphTo/
                                 track/drag/press/stagger
  spring.js                      pure-JS mirror of the Go physics (fallback)
  presets.js                     Apple response/damping presets
  index.js                       entry; exposes window.Motion
```

## Parameters, not durations

Springs take **response** (seconds to approach target) and **damping**
(ratio; 1.0 = critically damped). They have no fixed duration — settle time
emerges, which is exactly why retargeting mid-flight stays smooth.

| preset  | response | damping | use |
|---------|----------|---------|-----|
| snappy  | 0.28 | 1.00 | buttons, small popovers |
| ui      | 0.40 | 1.00 | default repositioning (Apple move/PiP) |
| gentle  | 0.55 | 1.00 | large surfaces |
| sheet   | 0.30 | 0.80 | drawers/sheets (Apple drawer) |
| morph   | 0.45 | 0.92 | shared-element transitions |
| dock    | 0.22 | 0.95 | dock magnification |
| island  | 0.34 | 0.86 | dynamic-island fluidity |
| bouncy  | 0.40 | 0.72 | ONLY after a flick/throw |

## Rules for call sites

1. Interactive motion = `Motion.to/set/stop` — never `el.style.transition`.
2. Gestures: `Motion.track` / `Motion.drag` (1:1 follow → project → snap →
   velocity handoff). No input lockouts during any animation.
3. Only transform / opacity / filter / CSS custom properties are driven.
   `w`/`h` channels exist for special cases (layout cost — prefer FLIP).
4. Reduced motion is honored inside the engine; call sites get it for free.

## Build & test

```sh
# physics (native, no wasm needed)
cd motion-wasm && go test ./...

# JS fallback + runtime (no artifact needed)
node --test tests/motion-spring-js.test.mjs tests/motion-runtime.test.mjs

# wasm ABI — against the committed artifact (CI builds it):
node --test tests/motion-abi.test.mjs

# wasm ABI — against a local standard-Go verification build:
scripts/build-motion-wasm.sh --local
ZEPHYR_MOTION_WASM=/tmp/zephyr_motion_stdgo.wasm \
ZEPHYR_WASM_EXEC="$(go env GOROOT)/lib/wasm/wasm_exec.js" \
node --test tests/motion-abi.test.mjs

# regenerate golden vectors after intentionally changing the math
cd motion-wasm && UPDATE_GOLDEN=1 go test ./motion -run TestGoldenVectors
```

CI (`.github/workflows/motion-wasm.yml`): Go tests → JS tests → TinyGo
build → ABI tests against the real artifact → commits the rebuilt
`zephyr_motion.wasm` to main.

## ABI contract (wasm ↔ runtime.js)

ids/counts/flags `int32`, values `float64`. Frame buffer is a shared
`Float64Array`, stride 3 per slot: `[value, velocity, active]`; JS re-reads
`engine_buffer_ptr/len` whenever memory grows. Trackers 0–7 are a fixed
pool. TinyGo exports memory as `memory`, stdgo as `mem` — both handled.

## Feel-check page

Open `tests/motion-feel.html`: interrupt/retarget, flick-with-snap drag,
shared-element morph, stagger, press feedback, reduced-motion toggle, plus
automated self-tests (title flips to `MOTION_PASS`).
