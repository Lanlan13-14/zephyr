import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = '/root/zephyr';
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('1. Terminal maxWindows supports 1, 2, 3, and 4 across HTML, frontend, and backend services', () => {
  const appHtml = read('public/app.html');
  assert.match(appHtml, /<option value="3"[^>]*>三窗<\/option>/);
  assert.match(appHtml, /<option value="4"[^>]*>四窗<\/option>/);

  const appJs = read('public/app.js');
  assert.match(appJs, /Math\.min\(4,\s*Math\.max\(1,\s*Number\.isFinite\(value\)\s*\?\s*value\s*:\s*4\)\)/);

  const storageJs = read('storage.js');
  assert.match(storageJs, /maxWindows:\s*4,/);

  const personalSvc = read('personal-settings-section-service.js');
  assert.match(personalSvc, /'terminal\.maxWindows'/);

  const userSettingsSvc = read('user-settings-service.js');
  assert.match(userSettingsSvc, /'terminal\.maxWindows'/);
});

test('2. Window opening order is reversed so newest window is always slot-1 (1,2,3 in 3-pane; clockwise 1,2,4,3 in 4-pane)', () => {
  const appJs = read('public/app.js');
  assert.match(appJs, /function computeDefaultVisualLayout\(\)\s*\{\s*return orderedVisibleIds\(\)\.slice\(\)\.reverse\(\);\s*\}/);
  assert.match(appJs, /layout-\$\{Math\.min\(count,\s*4\)\}/);
});

test('3. 3-window (10% | 80% | 10%) and 4-window (2x2 clockwise 1,2,4,3) CSS and WASM splitDockSlide are wired', () => {
  const specCss = read('public/zephyr-terminal-spec.css');
  assert.match(specCss, /\.terminal-workspace-grid\.layout-3:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-1:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-3:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-2:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-3:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-3:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-4:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-1:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-4:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-2:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-4:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-3:not\(\.terminal-window-morphing\)/);
  assert.match(specCss, /\.terminal-workspace-grid\.layout-4:not\(\.compact\):not\(\.broadcast-input-active\)\s*>\s*\.terminal-window\.slot-4:not\(\.terminal-window-morphing\)/);

  const motionJs = read('public/vendor/zephyr-motion/motion.js');
  assert.match(motionJs, /if\s*\(layoutCount\s*===\s*3\s*&&\s*!broadcastActive\)/);
  assert.match(motionJs, /const desiredSlot2Left\s*=\s*Math\.round\(\(wsWidth\s*-\s*paneW\)\s*\/\s*2\)/);
  assert.match(motionJs, /if\s*\(layoutCount\s*===\s*4\s*&&\s*!broadcastActive\)/);
  assert.match(motionJs, /'--split-cam-x':\s*camX/);
  assert.match(motionJs, /'--split-cam-y':\s*camY/);
});

test('4. Card flip target rect and side-slide entrance support 1, 2, 3, and 4 windows', () => {
  const appJs = read('public/app.js');
  assert.match(appJs, /if\s*\(vw\s*>=\s*761\s*&&\s*visibleCount\s*===\s*4\)/);
  assert.match(appJs, /if\s*\(vw\s*>=\s*761\s*&&\s*visibleCount\s*===\s*3\)/);
  assert.match(appJs, /else if\s*\(totalCount\s*===\s*3\)/);
  assert.match(appJs, /else if\s*\(totalCount\s*===\s*4\)/);
  assert.match(appJs, /Motion\.terminalWindowAvoidance\(win4,\s*fromBox4,\s*toBox4/);
});

test('5. 4-window outer-only dock constraint and 3-window dynamic middle-window dock side migration & restoration', () => {
  const appJs = read('public/app.js');
  assert.match(appJs, /if\s*\(activeSlotNum\s*===\s*1\)\s*slotSide\s*=\s*'middle-force-right'/);
  assert.match(appJs, /else if\s*\(activeSlotNum\s*===\s*3\)\s*slotSide\s*=\s*'middle-force-left'/);
  assert.match(appJs, /else\s*slotSide\s*=\s*'middle-active'/);
  assert.match(appJs, /win\.classList\.contains\('slot-1'\)\s*\|\|\s*win\.classList\.contains\('slot-3'\)\)\s*slotSide\s*=\s*'left'/);
  assert.match(appJs, /win\.classList\.contains\('slot-2'\)\s*\|\|\s*win\.classList\.contains\('slot-4'\)\)\s*slotSide\s*=\s*'right'/);

  const sftpPro = read('public/vendor/zephyr-pro/terminal-sftp-pro.js');
  assert.match(sftpPro, /window\.__zephyrUserPreferredDockSide/);
  assert.match(sftpPro, /nextSlotSide\s*===\s*'middle-force-left'/);
  assert.match(sftpPro, /nextSlotSide\s*===\s*'middle-force-right'/);
  assert.match(sftpPro, /nextSlotSide\s*===\s*'middle-active'\s*\|\|\s*nextSlotSide\s*===\s*'single'/);
});

test('6. Terminal toolbar includes #terminalAiBtn synced with host AI state and toggles #aiAgentPanel', () => {
  const sftpPro = read('public/vendor/zephyr-pro/terminal-sftp-pro.js');
  assert.match(sftpPro, /id:\s*'terminalAiBtn'/);
  assert.match(sftpPro, /type:\s*'zephyr-toggle-ai-panel'/);
  assert.match(sftpPro, /d\.type\s*===\s*'zephyr-ai-state'/);

  const appJs = read('public/app.js');
  assert.match(appJs, /function broadcastAiStateToTerminalFrames\(\)/);
  assert.match(appJs, /d\.type\s*===\s*'zephyr-toggle-ai-panel'/);
});
