import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const WEB = read('public/app.js');
const ICONS = read('zephyr_one/mobile/android/core-ui/src/main/kotlin/one/zephyr/mobile/ui/icon/ZephyrIcons.kt');
const SCREEN = read('zephyr_one/mobile/android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt');
const ROUTES = read('zephyr_one/mobile/android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionRoutes.kt');
const DRAFT = read('zephyr_one/mobile/android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionDraft.kt');
const VM = read('zephyr_one/mobile/android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorViewModel.kt');

const NAMES = {
    windows: 'OsWindows', macos: 'OsMacos', ubuntu: 'OsUbuntu', debian: 'OsDebian',
    arch: 'OsArch', alpine: 'OsAlpine', raspberry: 'OsRaspberry', redhat: 'OsRedhat', linux: 'OsLinux',
};
/* Every glyph is authored in the 0..24 box the web app declares as its viewBox.
 * The artwork inside that box is not square, and shrinking the viewport to the
 * artwork's extent is what cropped and stretched the glyphs on One's cards. */

function webPath(key) {
    const block = WEB.match(/const CONNECTION_OS_ICONS = \{[\s\S]*?\n\};/)[0];
    const start = block.indexOf(`\n    ${key}:`);
    const end = block.indexOf('\n    ', start + 5);
    return block.slice(start, end).match(/d="([^"]*)"/)[1].replace(/\s+/g, ' ').trim();
}

function androidLine(name) {
    return ICONS.split('\n').find((line) => line.trim().startsWith(`val ${name}:`));
}

test('One system glyphs use the web path verbatim and the path real viewport', () => {
    for (const [key, name] of Object.entries(NAMES)) {
        const line = androidLine(name);
        assert.ok(line, `${name} missing`);
        const path = line.match(/fill\("[^"]+", "(.*?)"/)[1].replace(/\s+/g, ' ').trim();
        assert.equal(path, webPath(key), `${key} path drifted from the web app`);
        assert.doesNotMatch(line, /viewport/, `${key} must keep the shared 24 viewport`);
    }
});

test('the web icon choices are all editable on One and sync back', () => {
    for (const key of ['auto', ...Object.keys(NAMES), 'unknown']) {
        assert.match(SCREEN, new RegExp(`"${key}" to`), `${key} missing from the editor options`);
    }
    assert.match(SCREEN, /data class Icon\(val value: String\) : EditorIntent/);
    assert.match(ROUTES, /is EditorIntent\.Icon -> viewModel\.setIcon/);
    assert.match(VM, /fun setIcon\(value: String\)/);
    // No reader here means the change never enters the field mask, so it cannot sync.
    assert.match(DRAFT, /"icon" to \{ c: Connection -> c\.icon \}/);
});
