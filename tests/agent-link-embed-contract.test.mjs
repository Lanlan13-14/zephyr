import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('non-Android Agent hosts exec zephyr-link-embed, not a second protocol', () => {
  const factory = read('zephyr_agent/lib/agent/link_runtime_factory.dart');
  assert.match(factory, /Platform\.isAndroid\) return PlatformLinkFileRuntime/);
  assert.match(factory, /return HostLinkFileRuntime/);

  const host = read('zephyr_agent/lib/agent/host_link_file_runtime.dart');
  assert.match(host, /\/link\/dial/);
  assert.match(host, /\/link\/tunnel\/start/);
  assert.match(host, /\/link\/identity\/jwk/);
  assert.match(host, /\/link\/identity\/enrollment-proof/);
  assert.match(host, /linkPeerRoot/);

  const embed = read('zephyr_agent/lib/agent/link_embed_process.dart');
  assert.match(embed, /zephyr-link-embed/);
  assert.match(embed, /ZEPHYR_LINK_IDENTITY_DIR/);
  assert.match(embed, /127\.0\.0\.1:/);
});

test('Go embed entry enables persistent identity and prints the loopback addr', () => {
  const main = read('zephyr-link/cmd/zephyr-link-embed/main.go');
  assert.match(main, /EnablePersistentIdentity/);
  assert.match(main, /ZEPHYR_LINK_IDENTITY_DIR/);
  assert.match(main, /127\.0\.0\.1:0/);
  assert.match(main, /os\.Stdout\.WriteString\(listener\.Addr\(\)\.String/);
  assert.match(main, /os\.Stdin\.Read/);
});

test('Android still signs in the host and does not enable identity', () => {
  const android = read('zephyr-link/cmd/zephyr-link-android/main.go');
  assert.doesNotMatch(android, /EnablePersistentIdentity/);
  const api = read('zephyr_agent/android_host/EmbeddedLinkApi.kt');
  assert.match(api, /AndroidKeyStore/);
  assert.match(api, /\/link\/dial\/finish/);
});

test('CI bundles zephyr-link-embed on linux/windows/macos/ios', () => {
  const wf = read('.github/workflows/agent.yml');
  assert.match(wf, /bundle_link_runtime\.sh linux/);
  assert.match(wf, /bundle_link_runtime\.sh windows/);
  assert.match(wf, /bundle_link_runtime\.sh macos/);
  assert.match(wf, /bundle_link_runtime\.sh ios/);
  const script = read('zephyr_agent/tool/bundle_link_runtime.sh');
  assert.match(script, /cmd\/zephyr-link-embed/);
  assert.match(script, /GOOS="\$goos"/);
});

test('Zft2 lane uses the runtime port, not a hard-coded MethodChannel', () => {
  const lane = read('zephyr_agent/lib/agent/zft2_link_lane.dart');
  assert.match(lane, /LinkFileRuntime _runtime/);
  assert.match(lane, /_runtime\.zft2LocalPort/);
  assert.doesNotMatch(lane, /MethodChannel\('com\.zephyr\.agent\/link'\)/);
});
