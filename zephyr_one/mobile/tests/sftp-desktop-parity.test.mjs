import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const pane = [
  'feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt',
  'feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/MobilePreviewPane.kt',
  'feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/RawImageViewer.kt',
  'feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/RawMediaPlayer.kt',
].map(read).join('\n');
const kinds = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshFileKinds.kt');
const policy = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpOpenPolicy.kt');
const port = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpPort.kt');
const engine = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
const adapter = read('app/src/main/kotlin/one/zephyr/mobile/app/SshjSftpPort.kt');

test('SFTP browser keeps desktop file-manager actions in the drawer', () => {
  for (const needle of [
    '新建文件夹', '新建文件', '上传文件', '粘贴', '复制', '剪切', '重命名', '删除',
    '压缩', '权限', '下载', '属性', '解压到', '预览本地图片 / 音视频', '预览服务器 / Agent RAW 地址',
    '覆盖远端', '兼容', 'GetMultipleContents', 'CreateDocument',
    'SftpTextEditor', 'MobilePreviewPane', 'RawImageViewer', 'RawMediaPlayer', 'LibVLC',
    'writeStream', 'readStream', 'bundleCommand', 'upsertEditor', '搜目录', '大纲', '格式化', '撤回',
    '预览本地图片 / 音视频', '预览服务器 / Agent RAW 地址',
    'openSelected', '正在自动连接', 'sourceConnectionId',
  ]) {
    assert.match(pane, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('library SFTP opens hosts like the terminal rail', () => {
  const notes = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SnippetScreens.kt');
  const tabs = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpHostTabs.kt');
  assert.match(tabs, /fun open\(/);
  assert.match(tabs, /fun close\(/);
  assert.match(notes, /SftpHostPicker/);
  assert.match(notes, /SftpHostRail/);
  assert.match(notes, /再开一台主机/);
  assert.match(notes, /ActionSheet/);
});

test('SFTP drawer expands fully and browser has navigation/edit safety', () => {
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
  assert.match(port, /fun execStream/);
  assert.match(port, /suspend fun readStream/);
  assert.match(port, /suspend fun writeStream/);
  assert.match(engine, /override suspend fun chmod/);
  assert.match(engine, /override suspend fun readFileRange/);
  assert.match(engine, /override fun execStream/);
  // The stream's read/join loops block. Collected from the Compose main thread
  // (Docker logs), they must run on the IO dispatcher or the UI freezes. The
  // engine's scope is itself built on that dispatcher, so a bare scope.launch
  // and an explicit scope.launch(io) are the same pool; both count.
  const execStreamBody = engine.slice(engine.indexOf('override fun execStream'), engine.indexOf('override fun execStream') + 4000);
  assert.match(execStreamBody, /scope\.launch(\(io\))?/);
  assert.equal(execStreamBody.match(/scope\.launch(\(io\))?/g)?.length, 4);
  assert.match(engine, /override suspend fun readFileStream/);
  assert.match(engine, /override suspend fun writeFileStream/);
  assert.match(engine, /RenameFlags\.OVERWRITE/);
  assert.match(adapter, /override suspend fun exec/);
  assert.match(adapter, /override suspend fun chmod/);
  assert.match(adapter, /override fun execStream/);
  assert.match(adapter, /override suspend fun readStream/);
  assert.match(adapter, /override suspend fun writeStream/);
  assert.match(adapter, /pool\.acquire\(connectionId\)/);
});
