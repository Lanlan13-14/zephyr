import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(mobileRoot, 'tools', 'package-ios-unsigned.sh'), 'utf8');

test('iOS packager emits a device executable without main.swift conflict', () => {
  assert.match(script, /ZephyrOneMobileApp\.swift/);
  assert.doesNotMatch(script, /\/main\.swift/);
  assert.match(script, /arm64-apple-ios17\.0/);
  assert.match(script, /grep -Eq 'platform IOS\$'/);
});

test('iOS local workspace persists rows and keeps secrets in Keychain', () => {
  assert.match(script, /JSONDecoder\(\)\.decode\(\[Connection\]\.self/);
  assert.match(script, /JSONEncoder\(\)\.encode\(snapshot\(\)\)/);
  assert.match(script, /\.completeFileProtection/);
  assert.match(script, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  assert.match(script, /LocalSecretStore\.apply/);
});

test('iOS artifact is verified unsigned', () => {
  assert.match(script, /codesign --remove-signature/);
  assert.match(script, /test ! -d "\$ARCHIVED_APP_DIR\/_CodeSignature"/);
  assert.match(script, /test ! -f "\$ARCHIVED_APP_DIR\/embedded\.mobileprovision"/);
  assert.match(script, /! codesign -dv "\$ARCHIVED_APP_DIR"/);
});
