import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const motion = readFileSync(new URL('../public/vendor/zephyr-motion/motion.js', import.meta.url), 'utf8');

test('AI layout buttons use Motion.morph FLIP geometry', () => {
  assert.match(app, /async function applyAiPanelLayout\(layout, \{ animate = true \} = \{\}\)/);
  assert.match(app, /const fromRect = p\.getBoundingClientRect\(\)/);
  assert.match(app, /await Motion\.morph\(p, fromRect,/);
  assert.match(app, /preset: 'shape'/);
  assert.match(app, /radiusVisualFrom: fromRadius/);
  assert.match(app, /radiusCompensate: true/);
});

test('AI layout animation supports interruption and retargeting', () => {
  assert.match(app, /let aiPanelLayoutMotionToken = 0/);
  assert.match(app, /const token = \+\+aiPanelLayoutMotionToken/);
  assert.match(app, /Motion\.stop\(p\); Motion\.release\(p\)/);
  assert.match(app, /token === aiPanelLayoutMotionToken/);
});

test('layout menu closes independently before panel geometry morph', () => {
  assert.match(app, /closeAiPanelLayoutMenu\(\);\s*void applyAiPanelLayout\(layout, \{ animate: true \}\)/);
});

test('legacy CSS geometry transition is disabled for AI panel only', () => {
  assert.match(css, /AI layout rectangles are animated exclusively by Motion\.morph/);
  assert.match(css, /\.ai-agent-panel\.file-manager\.layout-animating\s*\{[\s\S]*?transition: none !important/);
  assert.doesNotMatch(css, /#aiAgentPanel\.layout-animating\s*\{[^}]*transition:\s*left/);
});

test('motion engine exposes shape morph primitive', () => {
  assert.match(motion, /morph\(el, fromRect, opts = \{\}\)/);
  assert.match(motion, /preset: opts\.preset \?\? 'shape'/);
});
