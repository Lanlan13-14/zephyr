import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const android = fs.readFileSync(path.join(root, 'zephyr_one/mobile/android/feature-connections/src/main/kotlin/one/zephyr/mobile/feature/connections/ConnectionEditorScreen.kt'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'zephyr_one/mobile/ios/Sources/ZephyrUI/Views/ConnectionEditorView.swift'), 'utf8');
const rootKt = fs.readFileSync(path.join(root, 'zephyr_one/mobile/android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt'), 'utf8');

test('RDP folder mapping is chosen on the connection editor', () => {
  assert.match(android, /文件夹映射/);
  assert.match(android, /PickDriveDirectory/);
  assert.match(android, /点这里选本机目录/);
  assert.doesNotMatch(android, /下载\/ZephyrDrive/);
  assert.match(ios, /选择本机目录/);
  assert.match(ios, /pickDriveDirectory/);
  assert.doesNotMatch(ios, /文件同步目录意图/);
});

test('the editor authorizes a directory without opening tools settings', () => {
  assert.match(rootKt, /onPickDriveDirectory = pickDriveDirectory/);
  assert.match(rootKt, /connectionShares\.choose/);
  assert.match(rootKt, /ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION/);
});
