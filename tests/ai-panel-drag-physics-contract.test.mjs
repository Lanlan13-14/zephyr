import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const motion = readFileSync(new URL('../public/vendor/zephyr-motion/motion.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('Motion.drag supports handle threshold dynamic bounds and filter veto', () => {
  assert.match(motion, /activationThreshold/);
  assert.match(motion, /typeof opts\.bounds === 'function'/);
  assert.match(motion, /handle = null/);
  assert.match(motion, /filter = null/);
  assert.match(motion, /onActivate/);
  assert.match(motion, /onRelease/);
  assert.match(motion, /engine\.project\(/);
  assert.match(motion, /engine\.rubberbandClamp\(/);
  assert.match(motion, /if \(handlers\.onStart\?\.\(startInfo\) === false\) return;/);
});

test('AI panel uses Motion.drag only on top gray handle', () => {
  assert.match(app, /Motion\.drag\(panel/);
  assert.match(app, /handle:\s*dragHandle/);
  assert.match(app, /Only the top gray \.panel-drag-handle owns physical dragging/);
  assert.match(app, /activationThreshold:\s*4/);
  assert.match(app, /rubberband:\s*true/);
  assert.match(app, /bounds:\s*aiPanelDragBounds/);
  assert.match(app, /bakeAiPanelTransform/);
  assert.match(app, /ensureAiPanelPhysicsDrag/);
});

test('traffic-light hard drag is precise; gray strip uses physics', () => {
  assert.match(app, /startAiPanelHardDrag/);
  assert.match(app, /Hold-and-drag on ⋯ = precise hard drag/);
  assert.match(app, /Motion\.drag\(panel/);
  assert.match(app, /handle:\s*dragHandle/);
  assert.match(app, /Only the top gray \.panel-drag-handle owns physical dragging/);
  assert.match(app, /Three-dot traffic light is separately wired to precise hard drag/);
  assert.match(app, /data-ai-agent-layout/);
});

test('title bar and content are not bound as drag fallbacks', () => {
  assert.doesNotMatch(app, /panel\.querySelector\('\.panel-titlebar'\)\?\.addEventListener\('pointerdown'/);
  assert.match(app, /fallback is still limited to gray strip/);
});
