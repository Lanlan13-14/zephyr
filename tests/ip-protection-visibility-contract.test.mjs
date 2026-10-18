import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  IPV4_OR_IPV6_RE,
  isIpProtectionEnabled,
  scrubIpLiterals,
  scrubIpWhenProtected,
  formatProtectedName,
  applyIpProtectionState,
} from '../public/vendor/zephyr-pro/app-continuity-guard-pro.js';

const appHtml = readFileSync(new URL('../public/app.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const specCss = readFileSync(new URL('../public/zephyr-terminal-spec.css', import.meta.url), 'utf8');
const sftpProJs = readFileSync(new URL('../public/vendor/zephyr-pro/terminal-sftp-pro.js', import.meta.url), 'utf8');

test('IP Protection Mode defaults to false (disabled)', () => {
  assert.equal(isIpProtectionEnabled({}), false);
  assert.equal(isIpProtectionEnabled({ ipProtection: false }), false);
  assert.equal(isIpProtectionEnabled({ ipProtection: true }), true);
});

test('scrubIpWhenProtected preserves IP when disabled and scrubs IPv4/IPv6 when enabled', () => {
  const sample = 'root@103.240.198.233:22 · [2001:db8::1]:2222';
  assert.equal(scrubIpWhenProtected(sample, 'SSH', { ipProtection: false }), sample);
  const scrubbed = scrubIpWhenProtected(sample, 'SSH', { ipProtection: true });
  assert.ok(!scrubbed.includes('103.240.198.233'), 'IPv4 literal must be scrubbed when ipProtection is true');
  assert.ok(!scrubbed.includes('2001:db8::1'), 'IPv6 literal must be scrubbed when ipProtection is true');
});

test('formatProtectedName masks connection names containing raw IP addresses when enabled', () => {
  assert.equal(formatProtectedName('prod-web', 'SSH', { ipProtection: true }), 'prod-web');
  assert.equal(formatProtectedName('10.0.1.23', 'SSH', { ipProtection: true }), 'SSH 主机');
  assert.equal(formatProtectedName('10.0.1.23', 'SSH', { ipProtection: false }), '10.0.1.23');
});

test('app.html and app.js wire #ipProtectionToggle and broadcast ip-protection-change to child iframes', () => {
  assert.match(appHtml, /id="ipProtectionToggle"/);
  assert.match(appJs, /type:\s*'ip-protection-change'/);
  assert.match(appJs, /isIpProtectionEnabled\(settings\)/);
  assert.match(appJs, /formatProtectedName\(/);
});

test('whitelist contract: Monitor Card (#infoModal.open) and Edit Modals (#connModal.show / #proxyModal.show / #jumpHostModal.show) remain visible while all other surfaces hide IPs', () => {
  assert.match(specCss, /body\.ip-protection-on\s+\.terminal-window-titlebar\s+\.z1-host/);
  assert.match(specCss, /body\.ip-protection-on\s+#infoModal\.open\s+\[data-stat="ipv4"\]/);
  assert.match(specCss, /body\.ip-protection-on\s+#connModal\.show\s+#connHost/);
  assert.match(sftpProJs, /syncTerminalChildIpProtection/);
});
