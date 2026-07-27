import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = readFileSync(path.join(root, 'server.js'), 'utf8');
const entrypoint = readFileSync(path.join(root, 'scripts/docker-entrypoint-ai.sh'), 'utf8');
const demo = readFileSync(path.join(root, 'internal/motion-feel.html'), 'utf8');

test('motion demo is not part of the public static directory', () => {
  assert.equal(existsSync(path.join(root, 'public/motion-feel.html')), false);
  assert.equal(existsSync(path.join(root, 'internal/motion-feel.html')), true);
});

test('motion demo defaults closed and requires super admin plus runtime marker', () => {
  assert.match(server, /const MOTION_DEMO_ENABLE_FILE = '\/tmp\/zephyr-motion-demo\.enabled'/);
  assert.match(server, /const MOTION_DEMO_FILE = path\.join\(__dirname, 'internal', 'motion-feel\.html'\)/);
  assert.match(server, /if \(!fs\.existsSync\(MOTION_DEMO_ENABLE_FILE\)\) return res\.status\(404\)/);
  assert.match(server, /function requireMotionDemoEnabled/);
  assert.match(server, /app\.get\('\/motion-feel\.html', requireMotionDemoEnabled, requireSuperAdmin, serveMotionDemo\)/);
  assert.match(server, /app\.get\('\/motion-feel', requireMotionDemoEnabled, requireSuperAdmin, serveMotionDemo\)/);
  assert.match(server, /X-Robots-Tag': 'noindex, nofollow, noarchive'/);
  assert.match(server, /Cache-Control': 'no-store, private'/);
});

test('container restart always removes the temporary enable marker', () => {
  assert.match(entrypoint, /rm -f \/tmp\/zephyr-motion-demo\.enabled/);
  assert.match(entrypoint, /docker exec <container> touch \/tmp\/zephyr-motion-demo\.enabled/);
});

test('internal demo imports only the public motion runtime', () => {
  assert.match(demo, /from '\/vendor\/zephyr-motion\/index\.js\?v=20260727-ai-rdp-vision1'/);
  assert.doesNotMatch(demo, /fetch\(|WebSocket|XMLHttpRequest|document\.cookie/);
});
