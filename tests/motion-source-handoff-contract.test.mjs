import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const motion = readFileSync(path.join(root, 'public/vendor/zephyr-motion/motion.js'), 'utf8');
const app = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const css = readFileSync(path.join(root, 'public/style.css'), 'utf8');

function block(source, signature) {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `${signature} missing`);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for (let i = brace; i < source.length; i++) {
        if (source[i] === '{') depth++;
        if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unclosed ${signature}`);
}

test('hideSource atomically suppresses authored opacity/transform animations', () => {
    const src = block(motion, 'hideSource(surfaceEl, sourceEl)');
    assert.match(motion, /_sourcePaint:\s*new WeakMap\(\)/);
    assert.match(src, /setProperty\('transition', 'none', 'important'\)/);
    assert.match(src, /setProperty\('animation', 'none', 'important'\)/);
    assert.match(src, /setProperty\('opacity', '0', 'important'\)/);
    assert.match(src, /sourceEl\.dataset\.motionHidden = '1'/);
    assert.match(src, /void sourceEl\.offsetWidth/);
    assert.ok(src.indexOf("transition', 'none'") < src.indexOf("opacity', '0'"), 'transition must be disabled before opacity changes');
});

test('restoreSource keeps transition disabled through atomic twin handoff', () => {
    const src = block(motion, 'restoreSource(sourceEl)');
    assert.match(src, /setProperty\('transition', 'none', 'important'\)/);
    assert.match(src, /void sourceEl\.offsetWidth/);
    assert.match(src, /requestAnimationFrame\(\(\) =>/);
    assert.match(src, /_restoreInlinePaint\(sourceEl, 'transition'/);
    assert.ok(src.indexOf('void sourceEl.offsetWidth') < src.indexOf('requestAnimationFrame'), 'source must paint before transitions return');
});

test('modal arm does not pre-hide a source before the engine captures its original paint', () => {
    const src = block(app, 'armMotionModalOpen(Motion, modal, card, inner, trigger, motionClass)');
    assert.doesNotMatch(src, /trigger\.style\.opacity = '0'/);
    assert.doesNotMatch(src, /trigger\.style\.pointerEvents = 'none'/);
    assert.match(src, /delete trigger\.dataset\.motionHidden/);
});

test('AI add-provider has one press transform owner', () => {
    assert.doesNotMatch(css, /#aiAddProviderBtn\.connection-pressing\s*\{/);
    assert.match(app, /Motion\.press\(btn, \{ scale: 0\.96, preset: 'snappy' \}\)/);
});

test('all modal open paths still use the shared iOS engine handoff', () => {
    for (const [fn, trigger] of [
        ['openSshKeyModal', 'sshKeyModalTrigger'],
        ['openProxyModal', 'proxyModalTrigger'],
        ['openAiProviderModal', 'aiProviderModalTrigger'],
    ]) {
        const src = block(app, `${fn}(`);
        assert.match(src, new RegExp(`Motion\\.iosAppOpen\\(card, ${trigger}`));
        assert.match(src, /cloneSource:\s*true/);
        assert.match(src, /hideSource:\s*true/);
    }
});
