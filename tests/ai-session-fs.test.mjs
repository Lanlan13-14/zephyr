import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiSessionFs } from '../ai-session-fs.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-ai-fs-'));
}

test('put/list/get/delete attachment roundtrip', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const item = await fsApi.putAttachment('u1', 's1', { name: 'shot.png', mime: 'image/png', buffer: png });
  assert.equal(item.kind, 'image');
  assert.ok(item.id);
  const list = await fsApi.listAttachments('u1', 's1');
  assert.equal(list.length, 1);
  const got = await fsApi.getAttachment('u1', 's1', item.id);
  assert.equal(got.name, 'shot.png');
  const { data } = await fsApi.readAttachmentBytes('u1', 's1', item.id);
  assert.deepEqual(data, png);
  await fsApi.deleteAttachment('u1', 's1', item.id);
  assert.equal((await fsApi.listAttachments('u1', 's1')).length, 0);
});

test('buildUserParts emits image_url parts without dumping into content string only', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  const item = await fsApi.putAttachment('u1', 's1', { name: 'a.png', mime: 'image/png', buffer: png });
  const { parts, inventory } = await fsApi.buildUserParts('u1', 's1', [item.id], { allowImage: true });
  assert.ok(parts.some((p) => p.type === 'image_url' && String(p.imageUrl || '').startsWith('data:image/png;base64,')));
  assert.ok(parts.some((p) => p.type === 'text' && /附件清单/.test(p.text)));
  assert.equal(inventory[0].id, item.id);
});

test('buildUserParts skips image bytes when allowImage=false', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
  const item = await fsApi.putAttachment('u1', 's1', { name: 'a.png', mime: 'image/png', buffer: png });
  const { parts } = await fsApi.buildUserParts('u1', 's1', [item.id], { allowImage: false });
  assert.equal(parts.some((p) => p.type === 'image_url'), false);
  assert.ok(parts.some((p) => /attached file|attached image|附件/.test(p.text || '')));
});

test('rejects oversize files', async () => {
  const dataDir = tmpDir();
  const fsApi = new AiSessionFs({ dataDir, maxFileBytes: 16 });
  await assert.rejects(
    () => fsApi.putAttachment('u1', 's1', { name: 'big.bin', mime: 'application/octet-stream', buffer: Buffer.alloc(32) }),
    /file_too_large|不能超过/
  );
});
