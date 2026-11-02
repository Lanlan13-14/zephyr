import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const motion=readFileSync(new URL('../public/vendor/zephyr-motion/motion.js',import.meta.url),'utf8');
const spec=readFileSync(new URL('../public/zephyr-terminal-spec.css',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('all floating panels use their computed radius rather than a hardcoded final corner',()=>{
 const open=motion.slice(motion.indexOf('async panelOpenWasm('),motion.indexOf('async panelCloseWasm('));
 assert.match(open,/const toRadius = .*getComputedStyle\(panel\)\.borderTopLeftRadius/);
 assert.match(open,/'--z-morph-r': toRadius/);
 assert.match(open,/releaseCssVarChannels\(panel, Object\.keys\(units\)\)/);
});
test('dock completion owns its generation and invokes cleanup only once',()=>{
 const dock=motion.slice(motion.indexOf('async panelDockMorph('),motion.indexOf('async smartbarPickerMorph('));
 assert.match(dock,/this\._genOf\(primaryPanel\) !== snapshots\.get\(primaryPanel\)\?\.token/);
 assert.match(dock,/releaseCssVarChannels\(dt, Object\.keys\(dockUnits\)\)/);
 assert.doesNotMatch(dock,/guard\(\);\s*cleanupAll\(\)/);
});
test('desktop history drawer is non-modal and never dims or blurs the conversation',()=>{
 const drawer=spec.slice(spec.indexOf('#aiAgentPanel.pinned.sidebar-open .ai-sidebar-backdrop'),spec.indexOf('/* 侧边磁贴或窄窗下输入胶囊'));
 assert.match(drawer,/background: transparent !important/);assert.match(drawer,/backdrop-filter: none !important/);assert.match(drawer,/pointer-events: auto !important/);
});
test('AI floating shell does not override active shared morph geometry',()=>{
 assert.match(spec,/#aiAgentPanel\.ai-agent-panel\.file-manager:not\(\.z-panel-morphing\)\s*\{[^}]*border-radius: 16px/);
 const dock=app.slice(app.indexOf('function toggleAiPanelDockState('),app.indexOf('function openAiUnifiedMorePopover('));
 assert.doesNotMatch(dock,/applySplitSlideState\(\{ animate: true \}\)/);
 assert.match(dock,/Motion\.panelDockMorph/);
});

test('AI alone uses stable target-layout compositor scaling and real fade',()=>{
 assert.match(motion,/function prepareAiCompositeMorph[\s\S]*?panel\.id !== 'aiAgentPanel'/);
 assert.match(motion,/aiCompositeMorph === '1'[\s\S]*?v \/ base/);
 assert.match(spec,/#aiAgentPanel\.ai-agent-panel\.z-panel-morphing\s*\{\s*opacity:var\(--z-morph-opacity,1\)!important/);
 assert.match(spec,/transform:scale\(var\(--ai-panel-sx,1\),var\(--ai-panel-sy,1\)\)!important/);
 assert.match(spec,/#aiAgentPanel\[data-ai-composite-morph="1"\] \.ai-agent-sidebar/);
});
