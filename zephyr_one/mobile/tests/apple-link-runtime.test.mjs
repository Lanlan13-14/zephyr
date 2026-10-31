import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const core = 'zephyr_one/mobile/ios/Sources/ZephyrCore/';

test('Apple channel is a real C archive call, not a subprocess or listener stub', () => {
  const native = read(core + 'AppleLinkChannel.swift');
  for (const name of ['ZephyrLinkCreate', 'ZephyrLinkCall', 'ZephyrLinkDestroy', 'ZephyrLinkBuildInfo', 'ZephyrLinkFree']) {
    assert.ok(native.includes(name));
    assert.ok(read('zephyr_one/mobile/ios/Sources/CZephyrLink/include/CZephyrLink.h').includes(name));
    assert.ok(read('zephyr-link/cmd/zephyr-link-apple/main.go').includes('//export ' + name));
  }
  assert.doesNotMatch(native, /Process\(|URLSession|127\.0\.0\.1/);
  assert.match(native, /let previous = tail[\s\S]*await previous\?\.value/);
  assert.match(native, /hello\["pending"\] == \.boolean\(true\)/);
  assert.match(native, /"insecure": \.boolean\(false\)/);
  assert.match(native, /case \.object\(let ack\)/);
  const runtime = read('zephyr-link/internal/mobile/runtime.go');
  assert.match(runtime, /path != "\/link\/dial" && path != "\/link\/dial\/finish" && path != "\/link\/push"/);
  assert.match(runtime, /CloseEmbeddedSessions\(\)/);
  assert.doesNotMatch(runtime, /net\.Listen|httptest/);
});

test('production binding defaults to a generation checked native Link channel', () => {
  const factory = read(core + 'MobileBindingCoordinator.swift');
  assert.match(factory, /native: try AppleLinkNativeRuntime\(\)/);
  assert.match(factory, /credentials\.credentials\(for: sideEffectLease\) != nil/);
  assert.match(factory, /signingIdentity\.signLinkHandshake\(transcript\)/);
  assert.match(factory, /channel: activeChannel/);
  assert.match(factory, /ownedLinkChannel\?\.disable\(\)/);
  assert.match(factory, /await ownedLinkChannel\?\.close\(\)/);
  assert.doesNotMatch(factory, /else \{\s*transport = httpsTransport/);
  const identity = read(core + 'DeviceIdentityStore.swift');
  assert.match(identity, /zephyr-zsl2-handshake-v1\\0/);
  assert.match(identity, /p1363Signature\(fromDER: der\)/);
});

test('CI rebuilds the current archive for both actual target triples and executes it', () => {
  const workflow = read('.github/workflows/zephyr-one-mobile.yml');
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /rebuild-apple-link-runtime\.sh host/);
  assert.match(workflow, /rebuild-apple-link-runtime\.sh ios-device/);
  assert.match(workflow, /ZEPHYR_LINK_APPLE_ARCHIVE:.*\.link-apple-ios\/libzephyr_link\.a/);
  const build = read('scripts/rebuild-apple-link-runtime.sh');
  assert.match(build, /git clone --shared --no-checkout/);
  assert.match(build, /go build -buildvcs=true -trimpath -buildmode=c-archive/);
  const tests = read('zephyr_one/mobile/ios/Tests/ZephyrCoreTests/AppleLinkChannelTests.swift');
  assert.match(tests, /AppleLinkNativeRuntime\.buildInfo\(\)/);
  assert.match(tests, /vcs\.modified/);
  assert.match(tests, /vcs\.revision/);
});
