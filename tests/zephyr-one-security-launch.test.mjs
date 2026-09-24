import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const AUTH = read('zephyr_one/electron/auth.mjs');
const MAIN = read('zephyr_one/electron/main.mjs');
const PRELOAD = read('zephyr_one/electron/preload.cjs');
const WATCHERS = read('zephyr_one/electron/watchers.mjs');
const RUNTIME = read('zephyr_one/electron/runtime.mjs');
const SHELL = read('zephyr_one/src/main.js');
const HTML = read('zephyr_one/index.html');
const UI = read('zephyr-one-security-ui.js');
const HELLO = read('zephyr_one/electron/windows-hello.ps1');

test('auth_unlock unwraps the renderer { reason } payload', () => {
    assert.match(AUTH, /export function unlockReason\(payload/);
    assert.match(AUTH, /payload\.reason/);
    assert.match(MAIN, /unlock\(unlockReason\(payload\)\)/);
    assert.match(SHELL, /safeInvoke\('auth_unlock', \{ reason:/);
});

test('Windows Hello uses a STA helper file instead of an inline -Command script', () => {
    assert.equal(existsSync(path.join(root, 'zephyr_one/electron/windows-hello.ps1')), true);
    assert.match(AUTH, /windows-hello\.ps1/);
    assert.match(AUTH, /'-STA'/);
    assert.match(AUTH, /'-File', WINDOWS_HELLO_SCRIPT/);
    assert.match(HELLO, /CheckAvailabilityAsync/);
    assert.match(HELLO, /RequestVerificationAsync/);
    assert.match(HELLO, /exit 0/);
    assert.match(HELLO, /exit 2/);
    assert.doesNotMatch(AUTH, /\$asTaskGeneric = \(\[System\.WindowsRuntimeSystemExtensions\]/);
});

test('capabilities publish retries until the core accepts the MAC', () => {
    assert.match(WATCHERS, /published = response\.status === 200/);
    assert.match(WATCHERS, /tick\(\)\.catch\(\(\) => \{\}\);/);
    assert.match(WATCHERS, /if \(!base\) \{\s*published = false;/);
});

test('the boot window shows the launch overlay before Node is ready', () => {
    assert.match(HTML, /id="launchStage"/);
    assert.match(HTML, /id="iconSquircle"/);
    assert.match(HTML, /id="progressFill"/);
    assert.match(HTML, /launch-overlay\.css/);
    assert.match(SHELL, /createLaunchOverlay/);
    assert.match(SHELL, /listenRuntimeProgress/);
    assert.match(SHELL, /applyLaunchAppearance/);
    assert.match(SHELL, /await launch\.ready\(\)/);
    assert.match(PRELOAD, /runtime_progress/);
    assert.match(MAIN, /webContents\.send\('runtime_progress'/);
    assert.match(RUNTIME, /onProgress/);
    assert.match(RUNTIME, /readLaunchAppearance/);
    assert.match(RUNTIME, /writeLaunchAppearance/);
});

test('launch appearance follows palette, theme and window size', () => {
    const overlay = read('zephyr_one/src/js/shell/launch-overlay.js');
    for (const palette of ['frost', 'lava', 'asagi', 'cyber']) {
        assert.match(overlay, new RegExp(palette));
        assert.match(read('zephyr_one/src/styles/launch-overlay.css'), new RegExp(`data-palette="${palette}"`));
    }
    assert.match(overlay, /sizeForWindow/);
    assert.match(overlay, /prefers-reduced-motion/);
    assert.match(WATCHERS, /persistAppearance/);
    assert.match(WATCHERS, /nativeTheme\.shouldUseDarkColors/);
});

test('launch overlay CSS never transitions all and never uses display:none for motion', () => {
    const css = read('zephyr_one/src/styles/launch-overlay.css');
    assert.doesNotMatch(css, /transition:\s*all/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /transition: width/);
});

test('read/write launch appearance round-trips palette and theme', async () => {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(path.join(root, 'zephyr_one/electron/runtime.mjs')).href);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-launch-'));
    const saved = mod.writeLaunchAppearance(dir, { palette: 'lava', theme: 'light', autoTheme: false });
    assert.deepEqual(saved, { palette: 'lava', theme: 'light', autoTheme: false });
    assert.deepEqual(mod.readLaunchAppearance(dir), saved);
    assert.equal(mod.normalizeLaunchAppearance({ palette: 'nope' }).palette, 'frost');
});

test('the One security switch stays enabled so a broken authenticator can be turned off', () => {
    assert.match(UI, /toggle\.disabled = false/);
    assert.doesNotMatch(UI, /toggle\.disabled = caps\.known === true && caps\.available !== true/);
});

test('the overlay is visible in HTML before any JS runs', () => {
    assert.match(HTML, /id="iconSquircle" class="icon-squircle materialize"|class="icon-squircle materialize"/);
    assert.match(HTML, /class="logo-svg blossom"/);
    assert.match(HTML, /class="seed-point ignited"/);
    assert.match(HTML, /class="progress-container materialize"/);
    assert.match(HTML, /#bootGate\.launch-gate \{ min-height: 100dvh/);
    const overlay = read('zephyr_one/src/js/shell/launch-overlay.js');
    /* A replay may strip the classes, but only to re-add them after a reflow
     * once the window is visible. Stripping without putting them back would
     * leave the first paint blank. */
    assert.match(overlay, /classList\.remove\('materialize', 'blossom', 'ignited'\)/);
    assert.match(overlay, /classList\.add\('materialize'\)/);
    assert.match(read('zephyr_one/src/main.js'), /listenWindowShown/);
});

test('Windows packaged boot shows the overlay before the product window', () => {
    assert.doesNotMatch(MAIN, /if \(windowsRelease\) kick\(\)/);
    assert.match(MAIN, /startRuntime\(\)/);
    assert.match(MAIN, /\.then\(\(\) => enterProduct\(\)\)/);
    /* dom-ready, not ready-to-show: the window must be visible before the
     * blossom finishes, and the renderer replays on zephyr-one:shown. */
    assert.match(MAIN, /dom-ready/);
    assert.match(MAIN, /zephyr-one:shown/);
    assert.match(PRELOAD, /zephyr-one:shown/);
    assert.match(MAIN, /backgroundColor: '#090b0e'/);
    const loadAt = MAIN.indexOf('await mainWindow.loadFile');
    const enterAt = MAIN.indexOf('.then(() => enterProduct())');
    assert.ok(loadAt >= 0 && enterAt > loadAt);
});

test('the product window reserves an unlock before the OS prompt so the watcher cannot fail it', () => {
    assert.match(UI, /\/reserve/);
    const security = read('zephyr-one-security.js');
    assert.match(security, /reserve\(id\)/);
    assert.match(security, /unlock\/:id\/reserve/);
    assert.match(security, /!entry\.reservedBy/);
});

test('the product window completes unlocks over IPC instead of waiting on the 300ms watcher', () => {
    assert.match(UI, /security_complete_unlock/);
    assert.match(MAIN, /ipcMain\.handle\('security_complete_unlock'/);
    assert.match(WATCHERS, /export async function completeQueuedUnlock/);
    assert.match(WATCHERS, /unlock\.peek/);
    const security = read('zephyr-one-security.js');
    assert.match(security, /claimById/);
    assert.match(security, /unlock-queue\/:id/);
});

test('packaged assets resolve relative so file:// does not drop the overlay', () => {
    /* loadFile() serves dist/index.html over file://. Vite's default base '/'
     * makes href="/assets/main.css" resolve to the drive root, so the boot
     * window renders as unstyled HTML — a dead black screen with no overlay.
     * The build must emit relative asset URLs. */
    const vite = read('zephyr_one/vite.config.js');
    assert.match(vite, /^\s*base:\s*'\.\/',/m);
    /* In dev the source index.html references /src/... which is only valid
     * through the vite server; the packaged copy is what must be relative. */
    const distIndex = path.join(root, 'zephyr_one/dist/index.html');
    if (existsSync(distIndex)) {
        const index = readFileSync(distIndex, 'utf8');
        assert.match(index, /href="\.\.\/assets\/|href="\.\/assets\//);
        assert.doesNotMatch(index, /href="\/assets\//);
        assert.doesNotMatch(index, /src="\/assets\//);
    }
    /* The source page itself must not pin absolute /assets/ paths either —
     * everything under dist is emitted by vite with the base above. */
    const source = HTML;
    assert.doesNotMatch(source, /href="\/assets\//);
});

test('windows-hello.ps1 ships outside app.asar and is resolved on disk', () => {
    /* powershell.exe -File cannot open a path inside an archive; the helper
     * must be unpacked and resolved through process.resourcesPath. */
    const pkg = JSON.parse(read('zephyr_one/package.json'));
    assert.ok(Array.isArray(pkg.build.asarUnpack));
    assert.ok(pkg.build.asarUnpack.some((p) => p.includes('windows-hello.ps1')));
    assert.match(AUTH, /app\.asar\.unpacked/);
    assert.match(AUTH, /process\.resourcesPath/);
    assert.match(AUTH, /ZEPHYR_ONE_WINDOWS_HELLO_SCRIPT/);
    /* Missing script must fail with an actionable message, not a raw
     * PowerShell path error. */
    assert.match(AUTH, /安装包缺少 Windows Hello 脚本/);
});

test('bastion candidates come from the bound main via device-proof relay', () => {
    /* Desktop One has no locally connected Agents; the dropdown must pull
     * /api/mobile/v1/agent-bastions from the bound main end, and only fall
     * back to local Agents when unbound (hosted main keeps direct ones). */
    const sync = read('zephyr-one-link-sync.js');
    assert.match(sync, /async agentBastions\(\)/);
    assert.match(sync, /\/api\/mobile\/v1\/agent-bastions/);
    assert.match(sync, /app\.get\('\/api\/one\/link\/agent-bastions'/);
    assert.match(sync, /source: 'main'/);
    assert.match(sync, /source: 'local'/);
    const app = read('public/app.js');
    assert.match(app, /api\('\/api\/one\/link\/agent-bastions'\)/);
    assert.doesNotMatch(app, /api\('\/api\/rdp\/agent-bastions'\)/);
    /* Offline or non-bastion Agents must not appear as selectable hops. */
    assert.match(app, /a\.online !== false && a\.bastionEnabled !== false/);
    const server = read('server.js');
    assert.match(server, /listLocalBastionAgents/);
    assert.match(server, /mountZephyrOneLinkRoutes\(app, \{/);
});

test('embedded One validates agent: hops against the relayed main, not the local registry', () => {
    /* resolveRoutePlan used to require fileAgentManager.getAgentInfo(id) to
     * return an online Agent — impossible on a desktop One, so every dial
     * failed with "Agent 跳板不在线" even though the dropdown (relayed from
     * the main) had just offered the same id. */
    const server = read('server.js');
    const routePlan = server.slice(server.indexOf('function resolveRoutePlan'));
    assert.match(routePlan, /ZEPHYR_ONE_EMBEDDED\s*\?\s*resolveAgentBastion/);
    assert.match(routePlan, /Agent 跳板无权使用或已不可用/);
    const resolver = server.slice(server.indexOf('const resolveAgentBastion'), server.indexOf('const resourceService'));
    assert.match(resolver, /oneLinkSync\?\.binding/);
    assert.match(resolver, /relayed: true/);
    /* Hosted main keeps the direct-connection check. */
    assert.match(resolver, /!ZEPHYR_ONE_EMBEDDED && fileAgentManager/);
});

test('the windows uninstaller offers to wipe the pinned userData directory', () => {
    /* app.setPath pins Electron userData to %APPDATA%\com.zephyr.one, which
     * deleteAppDataOnUninstall never touches (it only removes
     * $APPDATA\<productName>); reinstalling therefore "kept" all data. The
     * custom uninstall section must offer a delete and cover the pinned
     * directory plus Local caches. */
    const pkg = JSON.parse(read('zephyr_one/package.json'));
    assert.strictEqual(pkg.build.nsis.include, 'build/installer.nsh');
    const nsh = read('zephyr_one/build/installer.nsh');
    assert.match(nsh, /!macro customUnInstall/);
    assert.match(nsh, /RMDir \/r "\$APPDATA\\com\.zephyr\.one"/);
    assert.match(nsh, /RMDir \/r "\$LOCALAPPDATA\\com\.zephyr\.one"/);
    /* The wipe must be a user choice, not silent data loss. */
    assert.match(nsh, /MB_YESNO/);
});

test('windows hello output is decoded as UTF-8 on both sides of the pipe', () => {
    /* zh-CN Windows defaults the console to GBK; without forcing the
     * codepage the failure path surfaced as mojibake in the security panel. */
    const ps1 = read('zephyr_one/electron/windows-hello.ps1');
    assert.match(ps1, /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
    assert.match(AUTH, /encoding: 'utf8'/);
    /* The mapper strips BOM/control bytes before matching protocol tokens. */
    assert.match(AUTH, /\\uFEFF/);
    assert.match(AUTH, /\[\\x00-\\x1f\]\+/);
});
