import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const IOS = path.join(ROOT, 'ios');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const chrome = read(path.join(ANDROID, 'feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteChrome.kt'));
const screen = read(path.join(ANDROID, 'feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteScreen.kt'));
const routes = read(path.join(ANDROID, 'feature-remote/src/main/kotlin/one/zephyr/mobile/feature/remote/RemoteRoutes.kt'));
const engine = read(path.join(ANDROID, 'protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/AndroidRdpEngine.kt'));
const root = read(path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'));
const container = read(path.join(ANDROID, 'app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt'));
const jni = read(path.join(ANDROID, 'protocol-rdp/src/main/cpp/zephyr_rdp_jni.c'));
const policy = read(path.join(ANDROID, 'protocol-rdp/src/main/kotlin/one/zephyr/mobile/protocol/rdp/RdpDisplayPolicy.kt'));
const iosChrome = read(path.join(IOS, 'Sources/ZephyrUI/RemoteViewModel.swift'));
const iosView = read(path.join(IOS, 'Sources/ZephyrUI/Views/RemoteView.swift'));

test('RDP tool strip matches the demo operation page and not the old dock', () => {
  assert.match(chrome, /POINTER_MODE, KEYBOARD, QUALITY, RESOLUTION, FPS, FIT, ZOOM/);
  assert.match(chrome, /CLIPBOARD, DRIVE, SHORTCUTS, JOYSTICK, CAD, RECONNECT, DISCONNECT/);
  assert.doesNotMatch(chrome, /SOUND, CHANNELS, DRIVE, CERTIFICATE, RECONNECT/);
  assert.match(screen, /ToolsPanel\(/);
  assert.match(screen, /RemoteIntent\.ToggleToolsPanel/);
  assert.match(screen, /remote_mouse_left/);
  assert.match(screen, /ClickRipple\(/);
  assert.doesNotMatch(screen, /DockRow\(/);
});

test('tools panel auto-hides after five seconds like the demo', () => {
  assert.match(chrome, /const val AUTO_HIDE_MS = 5_000L/);
  assert.match(chrome, /toolsPanelVisible/);
  assert.match(screen, /RemoteIntent\.HideChrome/);
});

test('opening an RDP session auto-connects through the packaged FreeRDP engine', () => {
  assert.match(container, /AndroidRdpEngine\(/);
  assert.doesNotMatch(container, /UnavailableRdpEngine\(/);
  assert.match(root, /val autoConnect = account\.sessions\.find\(route\.sessionId\)\?\.restoredFromWorkspace != true/);
  const rdpRoute = root.slice(root.indexOf('RdpRemoteRoute('));
  assert.match(rdpRoute, /autoConnect = autoConnect/);
  const vncRoute = root.slice(root.indexOf('VncRemoteRoute('));
  assert.match(vncRoute, /autoConnect = autoConnect/);
});

test('quality cycles map onto FreeRDP gfx and wallpaper flags', () => {
  assert.match(policy, /RdpQuality\.PERFORMANCE -> NativeFlags/);
  assert.match(policy, /gfx = false/);
  assert.match(engine, /RdpDisplayPolicy\.nativeFlags\(request\.quality\)/);
  assert.match(jni, /native_config\.gfx = \(\*env\)->GetBooleanField/);
  assert.match(jni, /disableWallpaper/);
});

test('disconnect pops the open remote window instead of leaving a dead overlay', () => {
  assert.match(routes, /RemoteIntent\.Disconnect -> \{[\s\S]*viewModel\.disconnect\(\)[\s\S]*onBack\(\)/);
  assert.match(screen, /SessionTransport\.CLOSED/);
  assert.match(screen, /RemoteIntent\.Back/);
  assert.match(iosView, /case \.closed, \.minimised:/);
  assert.match(iosView, /dismiss\(\)/);
});

test('iOS operation chrome uses the same RDP tool set', () => {
  assert.match(iosChrome, /\.pointerMode, \.keyboard, \.quality, \.resolution, \.fps, \.fit, \.zoom/);
  assert.match(iosChrome, /\.clipboard, \.fileDrive, \.shortcuts, \.joystick, \.cad/);
  assert.match(iosView, /toolsPanel\(/);
  assert.match(iosView, /viewModel\.connect\(\)/);
  assert.match(iosView, /zephyrNavigationBarHidden\(true\)/);
  assert.doesNotMatch(iosView, /\.navigationBarHidden\(true\)/);
  assert.doesNotMatch(iosView, /case \.sound:/);
  assert.doesNotMatch(iosView, /case \.certificate:/);
});
