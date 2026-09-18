import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const zh = JSON.parse(await readFile(new URL('../public/i18n/locales/zh-CN.json', import.meta.url), 'utf8'));
const en = JSON.parse(await readFile(new URL('../public/i18n/locales/en.json', import.meta.url), 'utf8'));
const fam = await readFile(new URL('../file-agent-manager.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const one = await readFile(new URL('../one-client-manager.js', import.meta.url), 'utf8');

test('settings Agent panel drops the leftover Client Token lecture', () => {
  const panel = html.match(/<div class="settings-panel" id="settings-agent">([\s\S]*?)<div class="settings-panel" id="settings-link">/);
  assert.ok(panel, 'settings-agent panel present');
  assert.doesNotMatch(panel[1], />Zephyr Client</);
  assert.doesNotMatch(panel[1], /不再需要 Client Token/);
  assert.doesNotMatch(panel[1], /设备绑定（enrollment）/);
  assert.match(panel[1], /已绑定的 Zephyr Agent/);
  assert.match(panel[1], /已绑定的 Zephyr One/);
});

test('Agent rows say last connected, One rows still say last sync', () => {
  assert.match(js, /kind === 'agent' \? '最近连接：' : '最近同步：'/);
  assert.match(js, /kind === 'agent' \? \(c\.lastSeenAt \|\| c\.lastSyncAt\) : c\.lastSyncAt/);
  assert.equal(zh['最近连接：'], '最近连接：');
  assert.equal(en['最近连接：'], 'Last connected: ');
  assert.equal(zh['最近同步：'], '最近同步：');
  assert.equal(en['最近同步：'], 'Last sync: ');
});

test('Agent hello and ping persist lastSeenAt onto the enrolled device', () => {
  assert.match(fam, /this\.onAgentSeen = typeof options\.onAgentSeen === 'function'/);
  assert.match(fam, /this\._recordAgentSeen\(conn\)/);
  assert.match(fam, /_handlePing\(agentId, ws, msg\)[\s\S]*this\._recordAgentSeen\(conn\)/);
  assert.match(server, /fileAgentManager\.onAgentSeen = \(\{ deviceId, appVersion \} = \{\}\) => \{/);
  assert.match(server, /store\.touchDevice\(deviceId, \{ appVersion \}\)/);
  assert.match(one, /lastSeenAt: online\?\.lastSeenAt \|\| client\.lastSeenAt/);
});
