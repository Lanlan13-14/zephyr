import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const aiAgent = require('../ai-agent-service.js');
const capabilities = require('../ai-capabilities.js');
const sftpTools = require('../ai-sftp-tools.js');
const dockerTools = require('../ai-docker-tools.js');
const agentTools = require('../ai-agent-device-tools.js');
const { preferredToolsForUserMessage } = require('../ai-intent-routing.js');
const defaults = require('../ai-defaults.js');

const EXPECTED = [
  'sftp_list_v1', 'sftp_stat_v1', 'sftp_mkdir_v1', 'sftp_rename_v1', 'sftp_delete_v1', 'sftp_chmod_v1',
  'docker_status_v1', 'docker_ps_v1', 'docker_images_v1', 'docker_container_action_v1', 'docker_logs_v1', 'docker_pull_v1', 'docker_mirrors_get_v1', 'docker_mirrors_set_v1',
  'agent_file_write_text_v1',
  'resource_share_list_v1', 'resource_share_put_v1', 'resource_share_delete_v1', 'resource_shared_with_me_v1',
  'note_groups_v1', 'note_group_rename_v1', 'note_group_delete_v1', 'note_restore_v1', 'note_purge_v1', 'note_bulk_v1',
  'env_set_v1', 'env_delete_v1',
  'remote_desktop_cert_status_v1', 'remote_desktop_cert_decide_v1',
];

test('surface gap tools are in catalog with capability bindings', () => {
  const catalog = aiAgent.listToolCatalog({});
  for (const name of EXPECTED) {
    assert.ok(catalog.some((item) => item.name === name), `missing catalog tool ${name}`);
  }
  assert.equal(catalog.find((item) => item.name === 'sftp_list_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'sftp_delete_v1').confirmation, 'always');
  assert.equal(catalog.find((item) => item.name === 'docker_ps_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'docker_container_action_v1').confirmation, 'always');
  assert.equal(catalog.find((item) => item.name === 'agent_file_write_text_v1').confirmation, 'always');
  assert.equal(catalog.find((item) => item.name === 'resource_share_list_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'note_groups_v1').risk, 'R0');
  assert.equal(catalog.find((item) => item.name === 'env_set_v1').confirmation, 'always');
});

test('sftp path and mode helpers reject escapes', () => {
  assert.equal(sftpTools.normalizeRemotePath('var/log'), '/var/log');
  assert.throws(() => sftpTools.normalizeRemotePath('/etc/../secret'), (e) => e.code === 'invalid_remote_path');
  assert.equal(sftpTools.modeFromString('755'), 0o755);
  assert.throws(() => sftpTools.modeFromString('999'), (e) => e.code === 'invalid_mode');
});

test('docker helpers quote and map actions', () => {
  assert.equal(dockerTools.shellQuote("a'b"), `'a'\\''b'`);
  assert.match(dockerTools.containerActionCommand('restart', 'nginx'), /docker restart/);
  assert.deepEqual(dockerTools.normalizeMirrors([' https://m1 ', 'https://m1', 'https://m2']), ['https://m1', 'https://m2']);
  assert.match(dockerTools.mirrorsSetScript(['https://m1']), /registry-mirrors/);
});

test('agent write schema and path normalization exist', () => {
  assert.ok(agentTools.AGENT_FILE_WRITE_TEXT_SCHEMA);
  assert.equal(agentTools.normalizeAgentPath('a/../b.txt'), '/b.txt');
});

test('intent routing hits sftp and docker structured tools', () => {
  const sftp = preferredToolsForUserMessage('帮我用 SFTP 列一下 /etc 目录');
  assert.equal(sftp[1].name, 'sftp_list_v1');
  const docker = preferredToolsForUserMessage('看看这台机器 Docker 容器');
  assert.ok(docker.some((item) => item.name === 'docker_status_v1'));
  assert.ok(docker.some((item) => item.name === 'docker_ps_v1'));
});

test('guidance version is 18 for full surface gap release', () => {
  assert.equal(defaults.DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION, 18);
  assert.ok(capabilities.CAPABILITIES.some((item) => item.id === 'sftp.list'));
  assert.ok(capabilities.CAPABILITIES.some((item) => item.id === 'docker.mutate'));
  assert.ok(capabilities.CAPABILITIES.some((item) => item.id === 'resource.share_read'));
});
