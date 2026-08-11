import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertAssetVersion, singleAssetVersion } from './helpers/cache-version.mjs';

const root = path.resolve(import.meta.dirname, '..');
const terminal = fs.readFileSync(path.join(root, 'public', 'terminal.js'), 'utf8');
const style = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const imagePreview = fs.readFileSync(path.join(root, 'public', 'preview', 'image', 'image-preview.js'), 'utf8');
const mediaPreview = fs.readFileSync(path.join(root, 'public', 'preview', 'media', 'media-preview.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'terminal.html'), 'utf8');
const appHtml = fs.readFileSync(path.join(root, 'public', 'app.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

test('image and media previews use shared floating-panel close motion', () => {
    for (const selector of [
        '.image-preview-modal.panel-opening',
        '.image-preview-modal.panel-closing',
        '.media-preview-modal.panel-opening',
        '.media-preview-modal.panel-closing',
    ]) assert.match(style, new RegExp(selector.replaceAll('.', '\\.')));

    for (const source of [imagePreview, mediaPreview]) {
        const closeAt = source.indexOf('close() {');
        assert.ok(closeAt > 0, 'preview close method must exist');
        const closeBody = source.slice(closeAt, closeAt + 1700);
        assert.match(closeBody, /classList\.add\('panel-closing'\)/);
        assert.match(closeBody, /event\.target !== this\.modal \|\| event\.animationName !== 'floatingPanelCloseToButton'/);
        assert.match(closeBody, /addEventListener\('animationend', onAnimationEnd\)/);
        assert.match(closeBody, /setTimeout\(remove, 360\)/);
    }
    assert.match(imagePreview, /classList\.add\('panel-opening'\)/);
    assert.match(mediaPreview, /classList\.add\('panel-opening'\)/);
});

test('monitor thumb geometry is CSS-driven and shadow-free', () => {
    const updateAt = terminal.indexOf('function updateMonitorTabThumb');
    assert.ok(updateAt > 0, 'monitor thumb updater must exist');
    const updateBody = terminal.slice(updateAt, terminal.indexOf('function finishMonitorPageSwitch', updateAt));
    assert.doesNotMatch(updateBody, /getBoundingClientRect|--monitor-tab-thumb-x|--monitor-tab-thumb-width/);
    assert.match(style, /\.monitor-tab-thumb\s*\{[\s\S]*?transform:\s*translate3d\(3px, 0, 0\)/);
    assert.match(style, /\.monitor-tabs\[data-monitor-page="1"\] \.monitor-tab-thumb\s*\{\s*transform:\s*translate3d\(calc\(100% \+ 3px\), 0, 0\)/);
    assert.match(style, /\.monitor-tab-thumb\s*\{[\s\S]*?box-shadow:\s*none;/);
    assert.match(style, /\.monitor-tabs\.switching \.monitor-tab-thumb\s*\{\s*box-shadow:\s*none;/);
});

test('preview and monitor assets carry their current cache-busts', () => {
    const appStyleVersion = singleAssetVersion(appHtml, 'style.css', 'app shell style');
    const terminalVersion = singleAssetVersion(html, 'terminal.js', 'terminal page script');
    assertAssetVersion(html, 'style.css', appStyleVersion, 'terminal page style');
    assertAssetVersion(sw, 'style.css', appStyleVersion, 'service worker style');
    assertAssetVersion(sw, 'terminal.js', terminalVersion, 'service worker terminal script');
    for (const asset of ['image-preview.css', 'media-preview.css', 'image-preview.js', 'media-preview.js']) {
        singleAssetVersion(html, asset, `${asset} preview asset`);
    }
});
