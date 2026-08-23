import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..', '..');
const mobile = path.join(repo, 'zephyr_one', 'mobile');
const read = (file) => fs.readFileSync(path.join(mobile, file), 'utf8');
const readRepo = (file) => fs.readFileSync(path.join(repo, file), 'utf8');

test('Android ships and drives the embedded Go Link core instead of re-implementing ZSL', () => {
  // The Go Link binary must be packaged next to the AI runtime.
  const so = path.join(mobile, 'android/app/src/main/jniLibs/arm64-v8a/libzephyr_link.so');
  assert.ok(fs.existsSync(so), 'libzephyr_link.so must be packaged');
  assert.ok(fs.statSync(so).size > 1024 * 1024, 'Link runtime binary is suspiciously small');

  // Kotlin owns only the process lifecycle and the loopback client — never the protocol.
  const proc = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkProcess.kt');
  assert.match(proc, /libzephyr_link\.so/);
  assert.match(proc, /nativeLibraryDir/);
  assert.ok(proc.includes('127.0.0.1'), 'loopback readiness parse');
  const api = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkApi.kt');
  assert.match(api, /\/link\/dial/);
  // The Kotlin side must not contain any ZSL/KEM primitive — that lives in Go only.
  // It may name the loopback /link/mlkem/* routes, but never the crypto primitives.
  assert.doesNotMatch(api, /x25519|X25519|hkdf|Hkdf|mlkem\.Encapsulate|mlkem\.Decapsulate|mlkem\.GenerateKey/i);

  // The container exposes the embedded Link core and client.
  const container = read('android/app/src/main/kotlin/one/zephyr/mobile/app/di/AppContainer.kt');
  assert.match(container, /EmbeddedLinkProcess/);
  assert.match(container, /EmbeddedLinkApi/);
});

test('Kotlin drives device-identity ML-KEM through the Go core loopback routes', () => {
  const api = read('android/app/src/main/kotlin/one/zephyr/mobile/app/EmbeddedLinkApi.kt');
  assert.match(api, /mlkemGenerate/);
  assert.match(api, /mlkemEncapsulate/);
  assert.match(api, /mlkemDecapsulate/);
  assert.match(api, /\/link\/mlkem\/generate/);
  assert.match(api, /\/link\/mlkem\/encapsulate/);
  assert.match(api, /\/link\/mlkem\/decapsulate/);

  const node = readRepo('zephyr-link/internal/link/node.go');
  assert.match(node, /\/link\/mlkem\/generate/);
  assert.match(node, /\/link\/mlkem\/encapsulate/);
  assert.match(node, /\/link\/mlkem\/decapsulate/);
  assert.match(node, /GenerateMLKEM768/);
  assert.match(node, /EncapsulateMLKEM768/);
  assert.match(node, /DecapsulateMLKEM768/);
});

test('Go Link core exposes the embedded dial route the Kotlin client calls', () => {
  const node = readRepo('zephyr-link/internal/link/node.go');
  assert.match(node, /\/link\/dial/);
  assert.match(node, /HandshakeInitiator/);
  // The Android entrypoint is a loopback process with a stdout readiness line.
  const main = readRepo('zephyr-link/cmd/zephyr-link-android/main.go');
  assert.match(main, /127\.0\.0\.1:0/);
  assert.match(main, /os\.Stdin\.Read/);
});

test('embedded Link runtime has a CI freshness gate like the AI runtime', () => {
  const workflow = readRepo('.github/workflows/zephyr-one-mobile.yml');
  assert.match(workflow, /libzephyr_link\.so/);
  assert.match(workflow, /zephyr-link/);
  assert.match(workflow, /cmd\/zephyr-link-android/);
});
