import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/app.html', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const docker = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');

test('settings sidebar exposes notes toggle and admin user management', () => {
  assert.match(html, /data-settings="notes"/);
  assert.match(html, /id="notesEnabledInput"/);
  assert.match(html, /id="adminSettingsTab"[^>]*data-settings="admin"/);
  assert.match(html, /id="adminAddUserBtn"/);
  assert.match(js, /\/api\/me\/settings/);
  assert.match(js, /'notes\.enabled'/);
});

test('AI settings UI exposes and persists notesRead/notesWrite independently', () => {
  assert.match(html, /id="aiPermNotesRead"/);
  assert.match(html, /id="aiPermNotesWrite"/);
  assert.match(js, /notesRead:\s*\$\('#aiPermNotesRead'\)\.checked/);
  assert.match(js, /notesWrite:\s*\$\('#aiPermNotesWrite'\)\.checked/);
});

test('custom TLS certificate paths and data volume are configurable', () => {
  assert.match(server, /process\.env\.ZEPHYR_DATA_DIR/);
  assert.match(server, /process\.env\.ZEPHYR_HTTPS_DIR/);
  assert.match(server, /process\.env\.HTTPS_CERT_FILE/);
  assert.match(server, /process\.env\.HTTPS_KEY_FILE/);
  assert.match(docker, /VOLUME \["\/app\/data"\]/);
  assert.match(docker, /ENV ZEPHYR_DATA_DIR=\/app\/data/);
});
test('AI Provider UI exposes all-user, all-admin and multi-user sharing', () => {
  assert.match(html, /id="aiProviderShareUsers"/);
  assert.match(html, /id="aiProviderShareAdmins"/);
  assert.match(html, /id="aiProviderShareTargets"/);
  assert.match(js, /\/api\/ai\/share-targets/);
  assert.match(js, /sharedUserIds:\s*Array\.from\(aiProviderSelectedUserIds\)/);
  assert.match(js, /shareWithUsers:\s*!!\$\('#aiProviderShareUsers'\)\.checked/);
  assert.match(js, /shareWithAdmins:\s*!!\$\('#aiProviderShareAdmins'\)\.checked/);
});