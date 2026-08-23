import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

test('tools home keeps a single Zephyr Link row', () => {
  const catalog = read('zephyr_one/mobile/android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolsCatalog.kt');
  assert.match(catalog, /ToolSection\.FILE_SYNC -> listOf\(ToolEntry\.FILE_SYNC\)/);
  assert.doesNotMatch(
    catalog,
    /ToolSection\.FILE_SYNC -> listOf\(ToolEntry\.FILE_SYNC, ToolEntry\.CLIENT_TOKEN\)/,
  );

  const demo = read('FREEZE/zephyr one/demo.html');
  const tools = demo.slice(demo.indexOf('section-title">文件同步'), demo.indexOf('section-title">服务器'));
  assert.match(tools, /文件同步/);
  assert.doesNotMatch(tools, /Client Token/);

  const routes = read('zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/DestinationRoutes.kt');
  assert.doesNotMatch(routes, /ToolEntry\.CLIENT_TOKEN/);
  const root = read('zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  assert.doesNotMatch(root, /onOpenTokens/);
  const ios = read('zephyr_one/mobile/ios/Sources/ZephyrUI/Views/RootSurfaces.swift');
  assert.match(ios, /toolSection\("Zephyr Link", destinations: \[\.fileSync\]\)/);
  assert.doesNotMatch(ios, /toolSection\("Zephyr Link", destinations: \[\.fileSync, \.clientToken\]\)/);
});

test('binding screen is browser enrollment, not password plus Client Token', () => {
  const screen = read('zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/BindingScreen.kt');
  assert.match(screen, /startEnrollment/);
  assert.match(screen, /在系统浏览器批准/);
  assert.match(screen, /Intent\.ACTION_VIEW/);
  assert.doesNotMatch(screen, /Token ID/);
  assert.doesNotMatch(screen, /再次输入密码或 TOTP/);
  assert.doesNotMatch(screen, /BindStep\.TOKEN/);
  assert.doesNotMatch(screen, /completeBinding\(/);
});

test('file sync page can start bind from local mode and no longer invents devices', () => {
  const screen = read('zephyr_one/mobile/android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/ToolScreens.kt');
  assert.match(screen, /onBind: \(\(\) -> Unit\)\? = null/);
  assert.match(screen, /绑定主端/);
  assert.doesNotMatch(screen, /Pixel 8 Pro/);
  assert.doesNotMatch(screen, /one-mobile-prod/);
  const root = read('zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
  assert.match(root, /onBind = if \(account\.isLocalMode\) \(\{ route = RootRoute\.ServerBinding \}\) else null/);
});

test('server mounts Link v2 enrollment and login can return to the approval page', () => {
  const server = read('server.js');
  assert.match(server, /link-v2-enrollment/);
  assert.match(server, /linkV2EnrollmentApi\.mount\(app\)/);
  const client = read('public/client.js');
  assert.match(client, /function safeReturnTo/);
  assert.match(client, /next\.startsWith\('\/link\/approve'\)/);
  const capabilities = read('mobile-v1-routes.js');
  assert.match(capabilities, /linkEnrollment: true/);
});
