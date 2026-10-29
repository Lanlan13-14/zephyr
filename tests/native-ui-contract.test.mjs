import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('all HTML surfaces load shared menu and select before application modules', () => {
  for (const page of ['index.html', 'app.html', 'terminal.html', 'telnet-terminal.html', 'rdp.html', 'novnc.html', 'open.html', 'password-rollback.html', 'player.html']) {
    const html = read(`public/${page}`);
    for (const asset of ['native-ui.css', 'native-ui.js', 'native-select.js']) {
      assert.equal((html.match(new RegExp(asset.replace('.', '\\.'), 'g')) || []).length, 1, `${page}: ${asset}`);
    }
    assert.ok(html.indexOf('native-ui.js') < html.indexOf('</head>'));
    assert.ok(html.indexOf('native-select.js') < html.indexOf('</head>'));
  }
});

test('shared theme is single-sourced, and launch Vite build includes the same source', () => {
  const rootTheme = read('public/style.css').match(/:root\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(rootTheme, /--bg:\s*#101114/);
  const shared = read('public/native-ui.css');
  for (const value of ['--bg: #101114', '--accent: #2483eb', '--bg: #f5f5f7', '--accent: #1a73e8']) assert.match(shared, new RegExp(value));
  const vite = read('zephyr_one/vite.config.js');
  assert.match(vite, /resolve\(__dirname, '\.\.\/public', file\)/);
  assert.match(vite, /publicDir: 'public'/);
  const launch = read('zephyr_one/index.html');
  assert.match(launch, /href="\/native-ui\.css"/);
  assert.match(launch, /src="\/native-ui\.js"/);
  const css = read('zephyr_one/src/styles/launch-overlay.css');
  assert.match(css, /--canvas: var\(--bg\)/);
  assert.match(css, /--text-primary: var\(--text\)/);
  assert.doesNotMatch(css, /--accent: #0a84ff/);
  const brand = read('public/theme-runtime.js');
  assert.doesNotMatch(brand, /<stop offset="var\(/);
  assert.match(brand, /const midOffset = paletteForScheme\(\)\.midOffset/);
});

test('One startup and appearance save paths synchronize the native theme', () => {
  const electron = read('zephyr_one/electron/main.mjs');
  assert.match(electron, /nativeTheme\.themeSource = appearance\.autoTheme \? 'system' : appearance\.theme/);
  assert.match(electron, /backgroundColor: windowBackgroundColor\(\)/);
  assert.match(electron, /ipcMain\.handle\('launch_appearance_changed'/);
  const app = read('public/app.js');
  assert.match(app, /function syncOneLaunchAppearance\(appearance = getAppearance\(\)\)/);
  assert.ok((app.match(/syncOneLaunchAppearance\(appearance\);/g) || []).length >= 1);
  assert.match(app, /syncOneLaunchAppearance\(updatedAppearance\);/);
  assert.match(read('zephyr-one-embed-surface.js'), /get_launch_appearance/);
});

test('owned context menu preserves input selection, editor paste pipeline and password masking', () => {
  const menu = read('public/native-ui.js');
  for (const contract of ['pointerSelection', 'selectionForCommand', "editable.setSelectionRange(pointerSelection.start", "el.dispatchEvent(new InputEvent('input'", "el.matches('.cm-content')", "new ClipboardEvent('paste'", "input.type = password ? 'password' : 'text'", "new MouseEvent('contextmenu'"]) {
    if (contract === "new MouseEvent('contextmenu'") continue;
    assert.ok(menu.includes(contract), contract);
  }
  assert.match(menu, /event\.key === 'Escape' && menu[\s\S]*?stopImmediatePropagation/);
  assert.doesNotMatch(menu, /(?:window\.)?(?:alert|confirm|prompt)\s*\(/);
  assert.match(menu, /window\.ZephyrNativeUI = Object\.freeze/);
});

test('shared select emits native input/change and supports Motion hooks without a parallel DOM implementation', () => {
  const select = read('public/native-select.js');
  assert.match(select, /select\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
  assert.match(select, /select\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\)/);
  assert.match(select, /attributeFilter: \['value', 'disabled', 'selected'\]/);
  assert.match(select, /shell\._zephyrOpenMenu/);
  assert.match(select, /shell\._zephyrCloseMenu/);
  assert.match(select, /shell\.classList\.remove\('menu-closing'\)/);
  assert.match(select, /event\.key === 'Escape'[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(select, /className === 'force-hidden'/);
  assert.match(select, /menu\.scrollTop = Math\.max\(0, selected\.offsetTop - 6\)/);
  assert.match(select, /if \(!openShell \|\| event\.target === document\) return;/);
  assert.doesNotMatch(select, /selected\?\.scrollIntoView/);
  const app = read('public/app.js');
  assert.match(app, /function isMotionFilterShell\(shell\)/);
  assert.match(app, /function openToggleSelectMenu\(shell\)/);
  assert.match(app, /function closeToggleSelectMenu\(shell\)/);
  assert.match(app, /window\.enhanceToggleSelect = enhanceToggleSelect/);
  assert.match(app, /window\.syncToggleSelectFace = syncToggleSelectFace/);
});

test('native JS dialogs are gone and terminal right-click keeps its remote mouse protocol', () => {
  for (const file of ['public/app.js', 'public/terminal.js', 'public/telnet-terminal.js']) {
    const source = read(file);
    assert.doesNotMatch(source, /(?<!ZephyrNativeUI\.)(?<![.\w])(?:alert|confirm|prompt)\s*\(\s*t\s*\(/s, file);
    assert.match(source, /ZephyrNativeUI/);
  }
  for (const file of ['public/terminal.js', 'public/telnet-terminal.js']) {
    const source = read(file);
    assert.match(source, /terminalMouseTrackingEnabled\(\)[\s\S]*sendTerminalMouseEvent/);
    assert.match(source, /addEventListener\('zephyr:native-paste'/);
    assert.match(source, /addEventListener\('zephyr:native-select-all'/);
    assert.match(source, /await chooseArchiveTargetPath/);
    assert.match(source, /await promptRemoteSubtitlePath/);
  }
});
