import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freeze = path.join(root, 'FREEZE', 'zephyr one');
const specPath = path.join(freeze, 'ZEPHYR_ONE.md');
const spec = fs.readFileSync(specPath, 'utf8');
const json = (relative) => JSON.parse(fs.readFileSync(path.join(freeze, relative), 'utf8'));

function includesAll(values, label) {
  for (const value of values) assert.ok(spec.includes(value), `${label} missing ${value}`);
}

test('Zephyr One uses one unified narrative contract and keeps reviewed copies', () => {
  assert.ok(fs.existsSync(specPath));
  assert.equal(fs.readdirSync(freeze).filter((name) => name.endsWith('.md')).length, 1);
  assert.ok(Buffer.byteLength(spec, 'utf8') > 30_000);
  for (const relative of [
    'contracts/openapi-mobile-v1.json', 'contracts/entity-registry.json',
    'contracts/error-registry.json', 'contracts/ai-capability-baseline.json',
    'contracts/schemas/secret-envelope.schema.json',
    'contracts/test-vectors/sync-v1.json',
    'branding/manifest.json', 'branding/source/zephyr-one-frost.svg',
    'references/bottom-floating-island.jpg', 'references/terminal-ime-open.jpg',
    'original-uploads/zephyr-one-icons.zip', 'demo.html',
  ]) assert.ok(fs.existsSync(path.join(freeze, relative)), `missing frozen copy ${relative}`);
});

test('the unified contract freezes all platforms, parity and one-second startup', () => {
  includesAll([
    'Kotlin + Jetpack Compose', 'Swift + SwiftUI', 'Tauri 2 + Rust',
    'SSH、Telnet、RDP、VNC、SFTP', 'capability parity manifest',
    '不得超过 1,000ms', '真实可操作产品页面', '不得出现应用自建 Splash',
    'BootGate', 'Android ready 空白门',
  ], 'product/startup contract');
});

test('Link and shared security reflect the current product decisions', () => {
  includesAll([
    'Client Token 不再是 One 绑定前置', 'Passkey', 'MFA', '不使用 QUIC',
    'HTTPS/TLS 1.3 + WSS', 'iCloud 类双向同步', 'tombstone',
    'Shared-to-me 正式模式只允许 strict broker/relay', '必须废弃',
    'Relay 不可用时失败', '实时重验',
  ], 'Link/shared contract');
});

test('frozen OpenAPI and registries retain the implemented compatibility contracts', () => {
  const api = json('contracts/openapi-mobile-v1.json');
  assert.equal(api.openapi, '3.1.0');
  for (const route of [
    '/api/auth/login', '/api/auth/totp/verify',
    '/api/mobile/v1/capabilities', '/api/mobile/v1/devices/bind',
    '/api/mobile/v1/sync/bootstrap', '/api/mobile/v1/sync/changes',
    '/api/mobile/v1/sync/push', '/api/mobile/v1/shared',
  ]) assert.ok(api.paths[route], `OpenAPI missing ${route}`);

  const entities = new Set(json('contracts/entity-registry.json').entities.map((entity) => entity.type));
  for (const type of ['connection', 'proxy', 'sshKey', 'jumpHost', 'note', 'clientToken', 'fileSyncConfig']) {
    assert.ok(entities.has(type), `registry missing ${type}`);
  }

  const errors = new Set(json('contracts/error-registry.json').errors.map((error) => error.code));
  for (const code of ['sync_conflict', 'cursor_expired', 'device_proof_invalid', 'shared_relay_unavailable']) {
    assert.ok(errors.has(code), `error registry missing ${code}`);
  }
});

test('mobile v1 compatibility routes remain mounted during Link v2 planning', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'mobile-v1-routes.js'), 'utf8');
  assert.match(server, /require\('\.\/mobile-v1-routes'\)/);
  assert.match(server, /mountRoutes\(app\)/);
  for (const route of ['/api/mobile/v1/sync/push', '/api/mobile/v1/shared', '/api/mobile/v1/file-bridge/lease']) {
    assert.ok(routes.includes(route));
  }
});
