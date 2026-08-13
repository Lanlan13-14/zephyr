import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('runtime hands the authenticated session to a top-level loopback window', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  assert.match(runtime, /const LOCAL_APP_LABEL: &str = "local-app"/);
  assert.match(runtime, /const LOCAL_APP_PATH: &str = "\/app\.html\?zephyrOne=1"/);
  assert.match(runtime, /WebviewWindowBuilder::new\([\s\S]*LOCAL_APP_LABEL/);
  const prepare = runtime.slice(runtime.indexOf('fn prepare_local_app_window'), runtime.indexOf('fn provision_session'));
  const enter = runtime.slice(runtime.indexOf('pub fn enter'), runtime.indexOf('#[derive(Deserialize)]', runtime.indexOf('pub fn enter')));
  assert.match(prepare, /\.visible\(false\)/);
  assert.match(prepare, /let cookie = session_cookie\(sid\);[\s\S]*\.set_cookie\(cookie\)/);
  assert.doesNotMatch(prepare, /\.navigate\(|\.show\(|main\.hide\(/);
  assert.match(enter, /\.navigate\(target\)[\s\S]*\.show\(\)[\s\S]*main\.hide\(\)/);
  assert.match(runtime, /\.http_only\(true\)/);
  assert.match(runtime, /\.same_site\(tauri::webview::cookie::SameSite::Strict\)/);
  assert.doesNotMatch(runtime, /SameSite::None/);
  assert.doesNotMatch(runtime, /\.secure\(true\)/);
});

test('local product navigation and window lifecycle fail closed', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  assert.match(runtime, /url\.origin\(\) == origin\.origin\(\)/);
  assert.match(runtime, /\.on_navigation\(/);
  assert.match(runtime, /NewWindowResponse::Deny/);
  assert.match(runtime, /WindowEvent::CloseRequested[\s\S]*stop\(&close_app\)[\s\S]*\.exit\(0\)/);
  assert.match(runtime, /get_webview_window\("main"\)[\s\S]*main\.hide\(\)/);
});

test('trusted shell explicitly enters only after runtime_start returns', () => {
  const main = read('src/main.js');
  const commands = read('src-tauri/src/commands/mod.rs');
  const lib = read('src-tauri/src/lib.rs');
  const start = main.indexOf("await safeInvoke('runtime_start')");
  const enter = main.indexOf("await safeInvoke('runtime_enter')", start);

  assert.ok(start >= 0 && enter > start);
  assert.match(commands, /pub async fn runtime_enter\([\s\S]*window\.label\(\) != "main"[\s\S]*spawn_blocking\(move \|\| runtime::enter\(&app\)\)/);
  assert.match(lib, /commands::runtime_enter,/);
});

test('release autostart starts only the child and defers every WebView operation', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  assert.match(runtime, /spawn_autostart[\s\S]*ensure_started_inner\(&app, false\)/);
  assert.match(runtime, /waiting for trusted shell startup grace[\s\S]*sleep\(Duration::from_secs\(2\)\)[\s\S]*ensure_started_inner\(&app, false\)/);
  assert.match(runtime, /pub fn ensure_started[\s\S]*ensure_started_inner\(app, true\)/);
  assert.match(runtime, /if provision_webview && !st\.session_ready/);
  assert.match(runtime, /st\.startup_challenge = if provision_webview \{[\s\S]*Some\(startup_challenge\)/);
});

test('startup diagnostics identify the trusted handoff stages', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  const commands = read('src-tauri/src/commands/mod.rs');
  assert.match(runtime, /pub\(crate\) fn append_runtime_log/);
  assert.match(commands, /runtime_enter command entered/);
  assert.match(commands, /runtime_start command entered/);
  assert.match(commands, /runtime_start command completed/);
  assert.match(commands, /runtime_enter command completed/);
  assert.match(commands, /runtime_enter command failed/);
  assert.match(commands, /local_app_ready command completed/);
  assert.match(commands, /local_app_ready command failed/);
});

test('restart destroys the stale origin window before installing a new session', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  const prepare = runtime.slice(runtime.indexOf('fn prepare_local_app_window'), runtime.indexOf('fn provision_session'));
  const teardown = prepare.indexOf('teardown_local_app_resources(app)');
  const create = prepare.indexOf('WebviewWindowBuilder::new');
  const cookie = prepare.indexOf('let cookie = session_cookie(sid)');

  assert.ok(teardown >= 0 && teardown < create && create < cookie);
  assert.match(runtime, /fn restarted_local_app_requires_the_new_port_origin/);
  assert.match(runtime, /assert!\(!navigation_allowed\(&new_origin, &old_origin, false\)\)/);
});

test('local-app receives only UI-ready and owner-checked native RDP commands', () => {
  const trusted = JSON.parse(read('src-tauri/capabilities/default.json'));
  const localApp = JSON.parse(read('src-tauri/capabilities/local-app.json'));

  assert.deepEqual(trusted.windows, ['main']);
  assert.ok(trusted.permissions.some((permission) => permission.startsWith('fs:')));
  assert.ok(trusted.permissions.some((permission) => permission.startsWith('process:')));
  assert.ok(trusted.permissions.some((permission) => permission.startsWith('shell:')));
  assert.equal(localApp.local, false);
  assert.deepEqual(localApp.windows, ['local-app']);
  assert.deepEqual(localApp.remote.urls, ['http://127.0.0.1:*/*']);
  assert.ok(localApp.permissions.includes('allow-local-app-ready'));
  assert.deepEqual(localApp.permissions.sort(), ['allow-local-app-ready', 'allow-local-app-restart', 'allow-rdp-bridge']);
  for (const forbidden of ['fs:', 'http:', 'process:', 'shell:', 'dialog:', 'store:', 'core:']) {
    assert.ok(!localApp.permissions.some((permission) => permission.startsWith(forbidden)));
  }
});

test('UI-ready marker is bound to the exact product window and current core', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  const commands = read('src-tauri/src/commands/mod.rs');
  const embedded = read('src/rdp/native-rdp-embedded.js');
  const localApp = JSON.parse(read('src-tauri/capabilities/local-app.json'));

  assert.match(commands, /pub async fn local_app_ready\([\s\S]*spawn_blocking\(move \|\|[\s\S]*runtime::mark_local_app_ready\(&app, &window\)/);
  assert.match(runtime, /window\.label\(\) != LOCAL_APP_LABEL/);
  assert.match(runtime, /current_url\.origin\(\)\.ascii_serialization\(\) != expected_origin/);
  assert.match(runtime, /current_url\.path\(\) != "\/app\.html" \|\| current_url\.query\(\) != Some\("zephyrOne=1"\)/);
  assert.match(runtime, /ZEPHYR_ONE_UI_READY_NONCE/);
  assert.match(runtime, /"instanceId": instance_id/);
  assert.match(runtime, /LOCAL_APP_READY_SCRIPT:[\s\S]*dataset\.appReady === '1'/);
  assert.match(runtime, /document\.readyState === 'complete'/);
  assert.match(runtime, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(runtime, /\.initialization_script\(LOCAL_APP_READY_SCRIPT\)/);
  assert.match(runtime, /invoke\?\.\('local_app_ready'\)/);
  assert.match(embedded, /tauriInvoke\('rdp_bridge'/);
  assert.doesNotMatch(localApp.permissions.join('\n'), /rdp-native/);
});

test('every stop tears down the local product capability before stopping the core', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  const commands = read('src-tauri/src/commands/mod.rs');
  const lib = read('src-tauri/src/lib.rs');
  const teardown = runtime.slice(runtime.indexOf('fn teardown_local_app_resources'), runtime.indexOf('fn terminate_runtime'));
  const stop = runtime.slice(runtime.indexOf('pub fn stop'), runtime.indexOf('pub fn info'));

  assert.match(teardown, /delete_cookie\(session_cookie\(""\)\)/);
  assert.match(teardown, /window\.destroy\(\)/);
  assert.match(teardown, /close_owner_sessions\(&broker, LOCAL_APP_LABEL\)/);
  assert.match(teardown, /clear_owner_captures\(LOCAL_APP_LABEL\)/);
  assert.match(runtime, /fn teardown_and_terminate[\s\S]*teardown_local_app_resources\(app\)[\s\S]*terminate_runtime\(st\)/);
  assert.match(stop, /teardown_and_terminate\(app, &mut st\)/);
  assert.match(commands, /pub fn runtime_stop\(app: AppHandle\)[\s\S]*runtime::stop\(&app\)/);
  assert.match(lib, /RunEvent::Exit[\s\S]*runtime::stop\(handle\)/);
});

test('top-level recovery uses a narrow local-app restart capability', () => {
  const runtime = read('src-tauri/src/runtime/mod.rs');
  const commands = read('src-tauri/src/commands/mod.rs');
  const lib = read('src-tauri/src/lib.rs');
  const localApp = JSON.parse(read('src-tauri/capabilities/local-app.json'));
  const recovery = runtime.slice(runtime.indexOf('fn authorize_local_app_recovery'), runtime.indexOf('#[derive(Deserialize)]', runtime.indexOf('fn authorize_local_app_recovery')));
  const restart = runtime.slice(runtime.indexOf('pub fn restart_from_local_app'), runtime.indexOf('pub fn mark_local_app_ready'));

  assert.match(runtime, /event\.source !== window \|\| event\.origin !== location\.origin/);
  assert.match(runtime, /event\.data\?\.type !== 'zephyr-one:restart'/);
  assert.match(runtime, /invoke\?\.\('local_app_restart'\)/);
  assert.match(recovery, /window\.label\(\) != LOCAL_APP_LABEL/);
  assert.match(recovery, /recovery_url_allowed\(&current_url, &st\.local_app_origin\)/);
  assert.match(runtime, /fn recovery_url_allowed[\s\S]*url\.path\(\) == "\/"[\s\S]*url\.query\(\)\.is_none\(\)/);
  assert.match(restart, /stop\(app\)\?[\s\S]*ensure_started\(app\)\?[\s\S]*enter\(app\)/);
  assert.match(commands, /pub async fn local_app_restart[\s\S]*spawn_blocking\(move \|\| runtime::restart_from_local_app\(&app, &window\)\)/);
  assert.match(lib, /commands::local_app_restart,/);
  assert.ok(localApp.permissions.includes('allow-local-app-restart'));
});
