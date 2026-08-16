import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const pane = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt');
const kinds = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshFileKinds.kt');
const policy = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpOpenPolicy.kt');
const port = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpPort.kt');
const engine = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
const adapter = read('app/src/main/kotlin/one/zephyr/mobile/app/SshjSftpPort.kt');

test('SFTP browser keeps desktop file-manager actions in the drawer', () => {
  for (const needle of [
    '新建文件夹', '新建文件', '上传文件', '粘贴', '复制', '剪切', '重命名', '删除',
    '压缩', '权限', '下载', '属性', '解压到', '图片预览', '媒体预览',
    '覆盖远端', '兼容', 'GetMultipleContents', 'CreateDocument',
    'SftpTextEditor', 'SftpPreviewPane', 'VideoView', 'MediaPlayer', 'BitmapFactory',
  ]) {
    assert.match(pane, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(pane, /BackHandler/);
  assert.match(pane, /未保存/);
  assert.match(pane, /port\.write\(/);
  assert.match(pane, /canonicalPath/);
  assert.match(pane, /parentPath/);
});

test('desktop extension tables and clipboard conflict modes are encoded', () => {
  assert.match(kinds, /val IMAGE = setOf/);
  assert.match(kinds, /"heic"/);
  assert.match(kinds, /val VIDEO = setOf/);
  assert.match(kinds, /"mkv"/);
  assert.match(kinds, /val AUDIO = setOf/);
  assert.match(kinds, /val ARCHIVE = setOf/);
  assert.match(kinds, /fun compressCommand/);
  assert.match(kinds, /fun extractCommand/);
  assert.match(policy, /enum class SftpOpenKind/);
  assert.match(policy, /SftpPasteConflictMode/);
  assert.match(kinds, /uniqueCopyName/);
  assert.match(kinds, /复制/);
});

test('SFTP engine can chmod, range-read, create-write and exec', () => {
  assert.match(port, /suspend fun chmod/);
  assert.match(port, /suspend fun readRange/);
  assert.match(port, /suspend fun exec/);
  assert.match(engine, /override suspend fun chmod/);
  assert.match(engine, /override suspend fun readFileRange/);
  assert.match(engine, /RenameFlags\.OVERWRITE/);
  assert.match(adapter, /override suspend fun exec/);
  assert.match(adapter, /override suspend fun chmod/);
});
