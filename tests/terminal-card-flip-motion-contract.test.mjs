import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');
function fn(name) {
  const i = js.indexOf(`function ${name}(`); assert.ok(i >= 0, `${name} missing`);
  const sigEnd = js.indexOf(') {', i); const b = js.indexOf('{', sigEnd); let d = 0;
  for (let j = b; j < js.length; j++) {
    if (js[j] === '{') d++;
    else if (js[j] === '}' && !--d) return js.slice(i, j + 1);
  }
  throw new Error(`unterminated ${name}`);
}
/**
 * Function body with comments stripped. Negative assertions ("this function
 * must not hardcode a layout class") have to look at code only — otherwise a
 * comment explaining the bug is enough to fail the test.
 */
function code(name) {
  return fn(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
test('open splits matched geometry and dual-face rotation across Go springs', () => {
  const open = fn('playTerminalCardFlipOpen');
  assert.match(open, /Motion\.to\(surface,\s*\{[\s\S]*scaleX:\s*1[\s\S]*scaleY:\s*1[\s\S]*\},\s*\{\s*standard:\s*S\.iosCardFlipOpen\s*\}\)/);
  assert.match(open, /Motion\.to\(rotor,\s*\{\s*rotateY:\s*-180\s*\},\s*\{\s*standard:\s*S\.iosCardFlipOpen\s*\}\)/);
  const surfaceCall = /Motion\.to\(surface,\s*\{([^}]*)\}/.exec(open)?.[1] || '';
  assert.doesNotMatch(surfaceCall, /rotateY/);
  assert.doesNotMatch(css, /terminal-card-flip-rotor\s*\{[^}]*transform:\s*none\s*!important/);
  assert.match(open, /setTimeout\(resolve, 700\)/);
  assert.match(open, /Motion\.set\(rotor, \{ rotateY: -180 \}\)/);
  assert.doesNotMatch(open, /Motion\.cssVars\(nav, \{ '--terminal-card-shelf-padding'/);
  assert.match(open, /response:\s*0\.22, damping:\s*1/);
  assert.match(open, /Motion\.set\(nav, \{ y: shelfFrom - shelfTo \}/);
  assert.match(open, /Motion\.to\(nav, \{ y: 0 \}/);
  assert.match(open, /transformOrigin:\s*'50% 50%'/);
  assert.match(open, /const x0\s*=\s*\(origin\.left\s*\+\s*origin\.width\s*\/\s*2\)/);
  assert.match(open, /const y0\s*=\s*\(origin\.top\s*-\s*topBound\s*\+\s*origin\.height\s*\/\s*2\)/);
});
test('real operation window mounts synchronously and authorization runs in parallel', () => {
  const connect = fn('openConnectionWithCardFlip');
  assert.match(connect, /mountConnectionLocallyForCardFlip\(connection/);
  assert.match(connect, /const authorize = api\(`\/api\/connections\/\$\{id\}\/open`/);
  assert.match(connect, /const flight = playTerminalCardFlipOpen/);
  assert.ok(connect.indexOf('mountConnectionLocallyForCardFlip') < connect.indexOf('playTerminalCardFlipOpen'));
  assert.ok(connect.indexOf('const authorize = api') < connect.indexOf('await flight'));
  assert.doesNotMatch(connect, /tabId = await openConnection/);
  assert.doesNotMatch(connect, /await sshKeyMotion\._ensure/);
  // The mount must go through the single layout owner. Hardcoding a layout
  // class here left an already-open window auto-placed into an implicit grid
  // row, i.e. two terminals stacked vertically instead of side-by-side.
  const mount = code('mountConnectionLocallyForCardFlip');
  assert.match(mount, /renderTerminalWorkspace\(\)/);
  assert.doesNotMatch(mount, /layout-\$\{|layout-1|layout-2|layout-3/);
  assert.doesNotMatch(mount, /workspace\.className\s*=/);
  assert.doesNotMatch(mount, /visualLayout\s*=\s*\[tabId\]/);
  // …and the layout owner is still what builds the live window synchronously.
  assert.match(fn('renderTerminalWorkspace'), /createTerminalWindowElement\(t\)/);
  const back = fn('paintTerminalCardFlipBack');
  assert.match(back, /back\.appendChild\(liveWin\)/);
  assert.doesNotMatch(back, /terminal-card-flip-window-fallback|cloneNode/);
});
test('handoff moves the same live node with no second entrance animation', () => {
  const hand = code('finishTerminalCardFlipOpenHandoff');
  assert.match(hand, /restoreCardFlipHostedWindow\(\)/);
  assert.match(hand, /animation:\s*'none'/);
  assert.match(hand, /transform:\s*'none'/);
  assert.doesNotMatch(hand, /iosCardContent|contentClose/);
  assert.match(hand, /classList\.remove\('terminal-card-flip-preparing', 'terminal-card-flip-animating', 'terminal-card-flip-handoff'\)/);
  // The handoff must NOT pin the workspace to a single cell. With "multiple
  // terminals per page" enabled and a session already open, the real layout is
  // 2 or 3 tracks; forcing layout-1 auto-placed the windows into implicit rows
  // (vertical stack instead of side-by-side).
  assert.doesNotMatch(hand, /workspace\.className\s*=\s*`terminal-workspace terminal-workspace-grid layout-1/);
  assert.doesNotMatch(hand, /visualLayout = \[win\.dataset\.window\]/);
  // The renderer is the single source of truth for layout-N / slot-N / splitters.
  assert.match(hand, /syncVisualLayout\(\{ preserve: true \}\)/);
  assert.match(hand, /renderTerminalWorkspace\(\)/);
  // Restore first, then render: the renderer only reuses a window it can find
  // under #terminalWorkspace, otherwise it would build a second live iframe.
  assert.ok(hand.indexOf('restoreCardFlipHostedWindow()') < hand.indexOf('renderTerminalWorkspace()'));
  // Flip-only !important pins must be released, otherwise this window can never
  // be moved by a later layout morph (author-important outranks WAAPI).
  assert.match(hand, /releaseCardFlipWindowPins\(win\)/);
  const release = fn('releaseCardFlipWindowPins');
  assert.match(release, /delete win\.dataset\.cardFlipRadius/);
  assert.match(release, /removeProperty\('transform'\)/);
  assert.match(release, /removeProperty\('transition'\)/);
  assert.match(release, /removeProperty\('filter'\)/);
  // The flip always ends full-stage, so a multi-window layout must morph into
  // its slot instead of snapping.
  assert.match(hand, /const stageRect = win\.getBoundingClientRect\(\)/);
  assert.match(hand, /animateTerminalWindowLayoutFrom\(new Map\(\[\[win\.dataset\.window, stageRect\]\]\)/);
});
test('one radius is shared by source, both faces, hosted page and final page', () => {
  const connect = fn('openConnectionWithCardFlip');
  assert.match(connect, /--terminal-card-radius/);
  assert.match(connect, /liveWin\.dataset\.cardFlipRadius/);
  const open = fn('playTerminalCardFlipOpen');
  assert.match(open, /const radiusCss\s*=\s*`\$\{radius\}px`/);
  assert.match(open, /border-radius:\$\{radiusCss\}/);
  assert.match(css, /terminal-window\[data-card-flip-radius\][\s\S]*border-radius:\s*var\(--terminal-card-radius/);
  assert.match(css, /terminal-card-flip-back > \.terminal-window\[data-card-flip-hosted="1"\][\s\S]*border-radius:\s*inherit/);
});
test('close holds -180 and shrinks through Go geometry standard', () => {
  const close = fn('playTerminalCardFlipClose');
  assert.match(close, /sEnd\s*=\s*0\.01/);
  assert.match(close, /rotateY:\s*-180/);
  assert.match(close, /iosCardGeometryClose/);
});
test('dual-face DOM and no CSS transition owner', () => {
  assert.match(html, /data-terminal-card-rotor/);
  assert.match(html, /data-terminal-card-front/);
  assert.match(html, /data-terminal-card-back/);
  assert.match(css, /backface-visibility:\s*hidden/);
  assert.match(css, /terminal-card-flip-back \{ transform:\s*rotateY\(180deg\)/);
  assert.doesNotMatch(fn('playTerminalCardFlipOpen'), /\.animate\(|@keyframes|style\.transition\s*=\s*'transform/);
});

test('terminal close uses one Motion path before removal', () => {
  const close = fn('closeTerminalTab'); const motion = fn('playTerminalWindowCloseMotion');
  assert.match(close, /terminal-window\[data-window=/);
  assert.match(close, /const closeMotion = playTerminalWindowCloseMotion\(win\)/);
  assert.match(close, /await Promise\.all\(\[[\s\S]*closeMotion/);
  assert.match(close, /await closeMotion/);
  assert.ok(close.indexOf('const closeMotion = playTerminalWindowCloseMotion(win)') < close.indexOf('terminalTabs = terminalTabs.filter'));
  assert.match(motion, /Motion\.tween\(win,[\s\S]*scaleX: 0\.01,[\s\S]*scaleY: 0\.01,[\s\S]*opacity: 0/);
  assert.match(motion, /duration: 360/); assert.match(motion, /bezier: \[0\.32, 0\.72, 0, 1\]/);
  assert.match(css, /terminal-window\.motion-closing/);
  assert.doesNotMatch(css, /terminal-window\.closing\s*\{/);
});
