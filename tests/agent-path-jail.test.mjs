import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveUnderShare } = require('../agent-path-jail.js');

const ROOT = '/tmp/zephyr-share';

function ok(requested, opts) {
  const result = resolveUnderShare(ROOT, requested, opts);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function denied(requested, opts) {
  const result = resolveUnderShare(ROOT, requested, opts);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_escape');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'absolute') && result.ok, false);
  return result;
}

test('empty and dot stay inside the share', () => {
  assert.equal(ok('').relative, '.');
  assert.equal(ok('.').relative, '.');
  assert.equal(ok('foo').relative, 'foo');
  assert.equal(ok('foo/bar').relative, 'foo/bar');
});

test('foo/../bar normalizes inside the share', () => {
  assert.equal(ok('foo/../bar').relative, 'bar');
});

test('parent traversal is path_escape', () => {
  denied('..');
  denied('../x');
  denied('foo/../../etc');
  denied('foo/./../../etc');
});

test('absolute unix paths are rejected', () => {
  denied('/etc/passwd');
  denied('/tmp/zephyr-share/../passwd');
});

test('windows drive, UNC and ADS are rejected', () => {
  denied('C:\\Windows', { win32: true });
  denied('C:/Windows', { platform: 'win32' });
  denied('\\\\server\\share', { win32: true });
  denied('foo:bar', { win32: true });
});

test('nul bytes are rejected', () => {
  denied('foo\0bar');
});

test('symlink realpath that leaves the root is rejected', () => {
  const result = resolveUnderShare(ROOT, 'link', {
    realpath: () => '/etc/passwd',
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_escape');
});

test('realpath is checked for every existing parent, not only the final path', () => {
  const calls = [];
  const result = resolveUnderShare(ROOT, 'link/secret.txt', {
    realpath(target) {
      calls.push(target);
      if (target.endsWith('/link')) return '/etc';
      if (target.endsWith('/secret.txt')) return '/etc/secret.txt';
      return null;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_escape');
  assert.ok(calls.some((item) => item.endsWith('/link')));
});

test('realpath symlink to sibling with a shared string prefix is rejected', () => {
  const result = resolveUnderShare(ROOT, 'link', {
    realpath: () => `${ROOT}-outside/secret.txt`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_escape');
});

test('missing share root fails closed', () => {
  const result = resolveUnderShare('', 'foo');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'path_escape');
});
