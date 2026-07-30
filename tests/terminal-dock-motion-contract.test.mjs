import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');

function extractFn(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert.ok(m, `${name} missing`);
    const brace = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = brace; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, j + 1);
        }
    }
    throw new Error(`failed to extract ${name}`);
}

test('terminal smartbar dock uses Motion.dockMagnifyPointer from motion-feel §9', () => {
    const updateFn = extractFn(appJs, 'updateDockMagnification');
    assert.match(updateFn, /Motion\.dockMagnifyPointer/);
    assert.match(updateFn, /itemSelector:\s*DOCK_MAGNIFY_SELECTOR|itemSelector:\s*['"]\.smartbar-session, \.smartbar-add['"]/);
    assert.match(updateFn, /maxScale:\s*1\.26/);
    assert.match(updateFn, /preset:\s*'dock'/);
    // 横栏 influence / maxLift
    assert.match(updateFn, /influence:\s*142/);
    assert.match(updateFn, /maxLift:\s*15/);
});

test('fullscreen vertical dock uses dedicated dockMagnifyVerticalPointer', () => {
    const updateFn = extractFn(appJs, 'updateDockMagnification');
    assert.match(updateFn, /Motion\.dockMagnifyVerticalPointer/);
    assert.match(updateFn, /maxScale:\s*1\.22/);
    assert.match(updateFn, /maxLift:\s*12/);
    assert.match(updateFn, /maxSpread:\s*8/);
    // 上浮不侧弹
    assert.doesNotMatch(updateFn, /outward:\s*'left'/);
    assert.doesNotMatch(updateFn, /maxPop:/);
    assert.doesNotMatch(updateFn, /vertical:\s*verticalDock/);
});

test('dock leave/reset uses Motion.dockMagnifyReset spring return', () => {
    const resetFn = extractFn(appJs, 'resetDockMagnification');
    assert.match(resetFn, /Motion\.dockMagnifyReset/);
    assert.match(resetFn, /preset:\s*'snappy'/);
    assert.match(resetFn, /itemSelector:\s*DOCK_MAGNIFY_SELECTOR|itemSelector:\s*['"]\.smartbar-session, \.smartbar-add['"]/);
});

test('CSS hover no longer fights dock spring channels', () => {
    assert.doesNotMatch(styleCss, /\.smartbar-session:hover,\s*\n\.smartbar-add:hover\s*\{\s*--dock-scale/);
    assert.doesNotMatch(styleCss, /\.smartbar-session:hover \+ \.smartbar-session[\s\S]*?--dock-scale:\s*1\.045/);
    // transform still driven by CSS vars for Motion channels
    assert.match(styleCss, /translate3d\(var\(--dock-shift, 0px\), var\(--dock-lift\), 0\) scale\(var\(--dock-scale\)\) rotateZ\(var\(--dock-rotate\)\)/);
    assert.match(styleCss, /filter: blur\(var\(--dock-blur, 0px\)\)/);
});

test('pointermove path warms motion engine before first dock hover', () => {
    assert.match(appJs, /updateDockMagnification\(e\.clientX, dock, e\.clientY\)/);
    assert.match(appJs, /sshKeyMotion\._ensure\(\)/);
    assert.match(appHtml, /app\.js\?v=\d{8}-[a-z0-9-]+/);
});

test('fullscreen compact dock centers icons and keeps them above bar chrome', () => {
    // 竖栏：栏体材质在 ::before(z0)；dock/图标更高；紧凑 padding
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-panel::before/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-panel[\s\S]*?overflow:\s*visible/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-dock[\s\S]*?z-index:\s*2/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-dock[\s\S]*?overflow:\s*visible/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-dock[\s\S]*?padding:\s*4px 0 6px/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-session[\s\S]*?transform-origin:\s*50% 100%/);
    assert.match(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-session[\s\S]*?z-index:\s*3/);
    // 整栏下移，给上浮留顶部安全区
    assert.match(styleCss, /top:\s*calc\(env\(safe-area-inset-top\) \+ 56px\)/);
    assert.doesNotMatch(styleCss, /body\.terminal-custom-fullscreen-open[\s\S]*?\.smartbar-dock[\s\S]{0,120}?padding:\s*48px 0 12px/);
});

test('session icon body opacity matches plus icon surface fill', () => {
    // 禁止 active 会话用 accent-soft-bg 洗成半透明；与 + 同 surface 实底。
    assert.match(styleCss, /\.smartbar-session-icon,\s*\n\.smartbar-add-icon\s*\{[\s\S]*?var\(--surface\) 96%/);
    assert.match(styleCss, /\.smartbar-session\.active \.smartbar-session-icon\s*\{[\s\S]*?var\(--surface\) 96%/);
    assert.doesNotMatch(styleCss, /\.smartbar-session\.active \.smartbar-session-icon[^{]*\{[^}]*accent-soft-bg/);
});

test('dock icons layer above bar chrome without lengthening the bar', () => {
    // 栏体材质恢复为 panel 本体（与原先同一套 surface 渐变 + backdrop）；不拆 ::before。
    // 图标靠 overflow:visible + 负 margin 顶 padding 露头，不拉长栏。
    // fullscreen vertical dock may use scoped panel::before for chrome under icons
    assert.match(styleCss, /\.smartbar-panel\s*\{[\s\S]*?backdrop-filter:\s*blur\(30px\) saturate\(1\.75\)/);
    assert.match(styleCss, /\.smartbar-panel\s*\{[\s\S]*?color-mix\(in srgb, var\(--surface\) 86%, transparent\)/);
    assert.match(styleCss, /\.smartbar-panel\s*\{[\s\S]*?overflow:\s*visible/);
    assert.match(styleCss, /\.smartbar-dock\s*\{[\s\S]*?z-index:\s*2/);
    assert.match(styleCss, /\.smartbar-dock\s*\{[\s\S]*?margin-top:\s*-36px/);
    assert.match(styleCss, /\.smartbar-dock\s*\{[\s\S]*?min-height:\s*108px/);
    assert.match(styleCss, /\.smartbar-session,\s*\n\.smartbar-add\s*\{[\s\S]*?z-index:\s*3/);
    assert.doesNotMatch(styleCss, /\.smartbar-dock\s*\{[\s\S]{0,180}?min-height:\s*136px/);
});
