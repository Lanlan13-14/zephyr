import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('zephyr-cell/security');

test('Cell command allowlist source defaults deny and keeps rm off the list', () => {
  const impl = fs.readFileSync(path.join(root, 'command_allowlist.go'), 'utf8');
  const tests = fs.readFileSync(path.join(root, 'command_allowlist_test.go'), 'utf8');
  assert.match(impl, /type CommandAllowlist struct/);
  assert.match(impl, /DefaultCellCommands/);
  assert.match(impl, /return false/);
  assert.doesNotMatch(impl, /"rm"/);
  assert.match(tests, /rm must be denied/);
  assert.match(tests, /empty list must deny everything/);
});

test('Cell Session.Exec consults the allowlist before the engine', () => {
  const coordinator = fs.readFileSync(path.resolve('zephyr-cell/core/coordinator.go'), 'utf8');
  assert.match(coordinator, /defaultCellCommands\.Allow\(cmd\)/);
  assert.match(coordinator, /ErrCodePermissionDenied/);
  const exec = coordinator.slice(coordinator.indexOf('func (s *Session) Exec'), coordinator.indexOf('s.Engine.Exec'));
  assert.match(exec, /Allow\(cmd\)/);
});
