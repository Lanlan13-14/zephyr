import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { AiSessionFs } from '../ai-session-fs.js';
import { policyForExtendedTool } from '../ai-extended-capabilities.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ws-'));
}

test('workspace write/read/list stay inside session dirs', async () => {
  const dataDir = tmpDir();
  const api = new AiSessionFs({ dataDir });
  await api.writeWorkspaceFile('u1', 's1', 'workspace/notes/a.md', '# hello\nworld');
  const listed = await api.listWorkspace('u1', 's1', { dir: 'workspace' });
  assert.ok(listed.items.some((i) => i.name === 'notes' || i.path.includes('notes')));
  const read = await api.readWorkspaceFile('u1', 's1', 'workspace/notes/a.md');
  assert.match(read.content, /# hello/);
  await assert.rejects(() => api.writeWorkspaceFile('u1', 's1', 'uploads/x.txt', 'nope'), /路径必须位于|非法路径|bad_path/);
  await assert.rejects(() => api.readWorkspaceFile('u1', 's1', '../etc/passwd'), /路径必须位于|非法路径|bad_path/);
});

test('workspace tools are registered and write requires confirmation policy', () => {
  const agent = readFileSync(path.resolve(import.meta.dirname, '../ai-agent-service.js'), 'utf8');
  assert.match(agent, /name: 'workspace_list_v1'/);
  assert.match(agent, /name: 'workspace_read_v1'/);
  assert.match(agent, /name: 'workspace_write_v1'/);
  assert.match(agent, /name: 'user_attachment_read_v1'/);
  assert.match(agent, /case 'workspace_list_v1'/);
  const writePol = policyForExtendedTool('workspace_write_v1');
  assert.equal(writePol.confirmation, 'always');
  assert.equal(writePol.risk, 'R1');
  const listPol = policyForExtendedTool('workspace_list_v1');
  assert.equal(listPol.confirmation, 'never');
  assert.equal(listPol.readOnly, true);
});
