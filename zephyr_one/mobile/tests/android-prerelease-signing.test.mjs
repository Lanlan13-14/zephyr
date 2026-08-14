/*
 * The sideload APK must keep one signing identity across machines.
 *
 * assembleDebug used to pick up ~/.android/debug.keystore. CI creates a
 * fresh one on every runner, so zom-v1.0.0pre1 and pre2 could not update
 * each other. This suite pins the committed PKCS12, its SHA-256, and the
 * Gradle wiring that every installable build type must use it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_ROOT = path.join(MOBILE_ROOT, 'android');
const KEYSTORE = path.join(ANDROID_ROOT, 'app/signing/zephyr-one-prerelease.p12');
const GRADLE = path.join(ANDROID_ROOT, 'app/build.gradle.kts');
const EXPECTED_SHA256 =
  'E1:AA:E3:16:75:50:8F:B9:F8:3F:24:83:6D:A2:B0:CB:49:5E:4C:71:57:2A:2F:3A:A9:10:46:B6:1C:AF:ED:8A';
const STORE_PASS = 'zephyr-one-prerelease';
const ALIAS = 'zephyr-one';

test('the committed pre-release keystore is a non-empty PKCS12', () => {
  const stat = fs.statSync(KEYSTORE);
  assert.ok(stat.isFile(), KEYSTORE);
  assert.ok(stat.size > 1000, 'keystore is too small to hold a 2048-bit key');
});

test('keystore SHA-256 matches the documented sideload identity', () => {
  const result = spawnSync(
    'keytool',
    [
      '-list',
      '-keystore', KEYSTORE,
      '-storetype', 'PKCS12',
      '-storepass', STORE_PASS,
      '-alias', ALIAS,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const match = result.stdout.match(/SHA-?256\)?:\s*([0-9A-F:]+)/i);
  assert.ok(match, 'keytool did not print a SHA-256 fingerprint\n' + result.stdout);
  assert.equal(match[1].toUpperCase(), EXPECTED_SHA256);
});

test('debug, release and optimized prerelease sign with the committed PKCS12', () => {
  const gradle = fs.readFileSync(GRADLE, 'utf8');
  const buildTypes = gradle.slice(gradle.indexOf('buildTypes {'));
  assert.match(gradle, /create\("prerelease"\)/);
  assert.match(gradle, /storeFile = file\("signing\/zephyr-one-prerelease\.p12"\)/);
  assert.match(gradle, /keyAlias = "zephyr-one"/);
  const debugBlock = buildTypes.match(/debug\s*\{[\s\S]*?\n        \}/);
  const releaseBlock = buildTypes.match(/release\s*\{[\s\S]*?\n        \}/);
  const prereleaseBlock = buildTypes.match(/create\("prerelease"\)\s*\{[\s\S]*?\n        \}/);
  assert.ok(debugBlock, 'debug buildType missing');
  assert.ok(releaseBlock, 'release buildType missing');
  assert.ok(prereleaseBlock, 'prerelease buildType missing');
  assert.match(debugBlock[0], /signingConfig = signingConfigs\.getByName\("prerelease"\)/);
  assert.match(releaseBlock[0], /signingConfig = signingConfigs\.getByName\("prerelease"\)/);
  assert.match(prereleaseBlock[0], /applicationIdSuffix = "\.debug"/);
  assert.match(prereleaseBlock[0], /signingConfig = signingConfigs\.getByName\("prerelease"\)/);
  assert.match(prereleaseBlock[0], /isDebuggable = false/);
  assert.match(prereleaseBlock[0], /isMinifyEnabled = true/);
  assert.match(prereleaseBlock[0], /isShrinkResources = true/);
});

test('Android rendering explicitly keeps hardware acceleration enabled', () => {
  const manifest = fs.readFileSync(path.join(ANDROID_ROOT, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:hardwareAccelerated="true"/);
});
