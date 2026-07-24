# Animation / motion plans

Ordered migration for Zephyr UI motion. **Physics + semantic API land first;
production CSS/keyframes stay until a later explicit wire-up.**

Stamp baseline: `ef3592d`.

| # | Plan | Severity | Status | Depends on |
|---|------|----------|--------|------------|
| 001 | [Unify single Motion runtime](./001-unify-motion-runtime.md) | HIGH | TODO | — |
| 002 | [Semantic present/sheet/popover API](./002-semantic-present-api.md) | HIGH | **DONE (API only)** | — (implemented without waiting on 001) |
| 003 | Connection FLIP → Motion morph | HIGH | TODO (plan text pending) | 001, 002 |
| 004 | Dock multi-channel spring | MEDIUM | TODO (plan text pending) | 001, 002 |
| 005 | CSS token bridge + dead keyframe prune | LOW | TODO (plan text pending) | 002 |

## Execution order

1. **002 (done)** — semantic recipes on `zephyr-motion` only. No `app.js` / `style.css` behavior change.
2. **001** — drop dual `zephyr-anim` boot; production loads Motion only.
3. **003** — connection modal FLIP via `Motion.morph` / `sharedElement`.
4. **004** — dock CSS vars via `Motion.cssVars` with preset `dock`.
5. **005** — document preset↔CSS ease map; remove unused `@keyframes`.

## Hard product rule (current)

> **Do not replace live CSS animations until the API is ready and a plan explicitly migrates that surface.**

Verified for 002:

- `public/app.js` has no `Motion.present/sheet/popover/cssVars` call sites
- existing keyframes (`connectionCardIn`, `floatingPanelOpenFromButton`, …) unchanged
- feel demos + contract tests cover the new API

## How to feel-check API work

Open `tests/motion-feel.html` (served from repo static root):

- sections 6–8: present/dismiss, popover origin, sheet+scrim
- self-test title → `MOTION_PASS`

```bash
node --test tests/motion-semantic-api-contract.test.mjs \
  tests/motion-spring-js.test.mjs tests/motion-runtime.test.mjs tests/motion-abi.test.mjs
```
