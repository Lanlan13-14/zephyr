import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, 'android', rel), 'utf8');
const engine = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
const loader = read('protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshPrivateKeyLoader.kt');
const loaderTest = read('protocol-ssh/src/test/kotlin/one/zephyr/mobile/protocol/ssh/SshPrivateKeyLoaderTest.kt');
const host = read('feature-sessions/src/main/kotlin/one/zephyr/mobile/feature/sessions/SshTerminalHost.kt');
const root = read('app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneRoot.kt');
const tester = read('app/src/main/kotlin/one/zephyr/mobile/app/SshConnectionTester.kt');
const pool = read('app/src/main/kotlin/one/zephyr/mobile/app/ManagedSshSessionPool.kt');
const pane = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt');
const history = read('feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpEditorHistory.kt');
const historyTest = read('feature-notes/src/test/kotlin/one/zephyr/mobile/feature/notes/SftpEditorHistoryTest.kt');
const adapter = read('app/src/main/kotlin/one/zephyr/mobile/app/SshjSftpPort.kt');
const proguard = read('app/proguard-rules.pro');
const consumer = read('protocol-ssh/consumer-rules.pro');

function assertKeyLoginGuards({ loaderSrc, engineSrc, hostSrc, rootSrc, testerSrc, poolSrc, proguardSrc, consumerSrc }) {
  assert.match(loaderSrc, /OpenSSHKeyV1KeyFile/);
  assert.match(loaderSrc, /KeyFormat\.OpenSSHv1\s*->\s*OpenSSHKeyV1KeyFile\(\)/);
  assert.match(loaderSrc, /fun isEncrypted/);
  assert.match(loaderSrc, /openSshV1CipherName/);
  assert.match(loaderSrc, /openssh-key-v1/);
  assert.doesNotMatch(loaderSrc, /pem\.contains\("bcrypt"/);
  assert.match(engineSrc, /SshPrivateKeyLoader\.load\(/);
  assert.match(engineSrc, /private suspend fun <T> withSftp/);
  assert.match(engineSrc, /suspend fun <T> withSftp\(block: suspend/);
  assert.doesNotMatch(engineSrc, /OpenSSHKeyFile\(\)\.also/);
  assert.doesNotMatch(engineSrc, /PKCS8KeyFile\(\)\.also/);
  assert.doesNotMatch(loaderSrc, /bouncycastle/);
  assert.doesNotMatch(loaderSrc, /EncryptionException/);
  assert.match(hostSrc, /isNullOrBlankChars/);
  assert.match(hostSrc, /!privateKey\.isNullOrBlankChars\(\)/);
  assert.match(rootSrc, /takeUnlessBlankSecret/);
  assert.match(rootSrc, /replacementPassword \?: stored\.password/);
  assert.match(rootSrc, /replacementKey \?: stored\.privateKey/);
  assert.doesNotMatch(rootSrc, /if \(replacementPassword != null \|\| replacementKey != null\)/);
  assert.match(testerSrc, /privateKey != null && privateKey\.isNotEmpty\(\)/);
  assert.match(poolSrc, /privateKey != null && privateKey\.isNotEmpty\(\)/);
  assert.match(proguardSrc, /keep class com\.hierynomus\.sshj\.\*\* \{ \*; \}/);
  assert.match(consumerSrc, /keep class com\.hierynomus\.sshj\.\*\* \{ \*; \}/);
}

function assertEditorGuards({ paneSrc, historySrc, adapterSrc, engineSrc }) {
  assert.match(paneSrc, /TextFieldValue/);
  assert.match(paneSrc, /SftpEditorHistory/);
  assert.match(paneSrc, /if \(file\.dirty\) delay\(140\)/);
  assert.match(paneSrc, /onValueChange = \{ draft = it \}/);
  assert.doesNotMatch(paneSrc, /val history = \(current\.undo \+ current\.text\)\.takeLast/);
  assert.match(historySrc, /coalesceMs/);
  assert.match(historySrc, /isSmallSingleRegionEdit/);
  assert.match(adapterSrc, /engine\.stat\(session\(handle\), path\)/);
  assert.doesNotMatch(adapterSrc, /engine\.readFile\(session\(handle\), path, EDIT_READ_LIMIT\)/);
  assert.match(engineSrc, /fun <T> withSftp/);
  assert.match(engineSrc, /this\.client\.newSFTPClient\(\)/);
}

const currentKey = {
  loaderSrc: loader,
  engineSrc: engine,
  hostSrc: host,
  rootSrc: root,
  testerSrc: tester,
  poolSrc: pool,
  proguardSrc: proguard,
  consumerSrc: consumer,
};

test('modern OpenSSH private keys go through the v1 loader', () => {
  assertKeyLoginGuards(currentKey);
  assert.match(loaderTest, /modernOpenSshEd25519IsOpenSshV1NotLegacyPem/);
  assert.match(loaderTest, /encryptedOpenSshKeyRequiresThePassphrase/);
  assert.match(loaderTest, /deletingTheV1BranchWouldSendModernKeysToTheLegacyParser/);
  assert.match(loaderTest, /assertFalse\(ED25519_ENCRYPTED\.contains\("bcrypt"\)\)/);
});

test('SFTP editor typing no longer snapshots the whole file per keystroke', () => {
  assertEditorGuards({
    paneSrc: pane,
    historySrc: history,
    adapterSrc: adapter,
    engineSrc: engine,
  });
  assert.match(historyTest, /successiveKeystrokesShareOneUndoEntry/);
  assert.match(historyTest, /deletingTheCoalesceWindowWouldSnapshotEveryCharacter/);
});

test('guards reject the pre20 key parser and per-keystroke undo', () => {
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      loaderSrc: loader.replace('KeyFormat.OpenSSHv1 -> OpenSSHKeyV1KeyFile()', 'KeyFormat.OpenSSHv1 -> OpenSSHKeyFile()'),
    }),
    /OpenSSHv1/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      loaderSrc: loader.replace('openSshV1CipherName', 'pem.contains("bcrypt") || openSshV1CipherName'),
    }),
    /bcrypt/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      engineSrc: engine.replace('SshPrivateKeyLoader.load(', 'OpenSSHKeyFile().also { it.init(StringReader('),
    }),
    /SshPrivateKeyLoader/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      proguardSrc: proguard.replace('-keep class com.hierynomus.sshj.** { *; }\n', ''),
    }),
    /hierynomus/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      rootSrc: root.replaceAll('takeUnlessBlankSecret', 'identity'),
    }),
    /takeUnlessBlankSecret/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      engineSrc: engine.replaceAll('suspend fun <T> withSftp', 'fun <T> withSftp'),
    }),
    /suspend fun <T> withSftp/,
  );
  assert.throws(
    () => assertKeyLoginGuards({
      ...currentKey,
      loaderSrc: loader.replace(
        'import net.schmizz.sshj.userauth.password.PasswordUtils',
        'import org.bouncycastle.openssl.EncryptionException\nimport net.schmizz.sshj.userauth.password.PasswordUtils',
      ),
    }),
    /bouncycastle/,
  );
  assert.throws(
    () => assertEditorGuards({
      paneSrc: pane.replace('onValueChange = { draft = it }', 'onValueChange = { onChange(it, file.encoding, file.lineEnding, file.tabSize, file.wrap) }'),
      historySrc: history,
      adapterSrc: adapter,
      engineSrc: engine,
    }),
    /draft = it/,
  );
  assert.throws(
    () => assertEditorGuards({
      paneSrc: pane,
      historySrc: history,
      adapterSrc: adapter.replace(
        'engine.stat(session(handle), path)',
        'engine.readFile(session(handle), path, EDIT_READ_LIMIT)',
      ),
      engineSrc: engine,
    }),
    /engine\.stat/,
  );
});

test('python replica of cipher probe and undo coalesce stays in lockstep', () => {
  const replica = path.join(ROOT, 'tests', 'ssh-key-and-sftp-editor-replica.py');
  const result = spawnSync('python3', [replica], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ssh-key-and-sftp-editor-replica: ok/);
});
