import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(MOBILE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(MOBILE, rel), 'utf8');
const engine = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/SshjEngine.kt');
const security = read('android/protocol-ssh/src/main/kotlin/one/zephyr/mobile/protocol/ssh/AndroidSshSecurity.kt');
const appRules = read('android/app/proguard-rules.pro');
const consumerRules = read('android/protocol-ssh/consumer-rules.pro');
const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/zephyr-one-mobile.yml'), 'utf8');

function assertRuntimeGuards({ engineSrc, securitySrc, appRulesSrc, consumerRulesSrc, workflowSrc }) {
  assert.match(engineSrc, /AndroidSshSecurity\.configure\(\)/,
    'every SSH engine must configure Android JCE before constructing SSHClient');
  assert.match(securitySrc, /SecurityUtils\.setSecurityProvider\(null\)/,
    'Android SSH must not pin the cut-down BC provider');
  assert.match(securitySrc, /SecurityUtils\.setRegisterBouncyCastle\(false\)/,
    'SSHJ must not reflectively register external BC on Android');
  assert.match(securitySrc, /synchronized\(this\)/,
    'the global SSHJ security switch must be initialized once');
  assert.doesNotMatch(appRulesSrc, /-keep class org\.bouncycastle\.\*\*/,
    'app R8 rules must not retain external BouncyCastleProvider');
  assert.doesNotMatch(consumerRulesSrc, /-keep class org\.bouncycastle\.\*\*/,
    'library consumer rules must not retain external BouncyCastleProvider');
  assert.match(appRulesSrc, /-keep class com\.hierynomus\.sshj\.\*\*/,
    'OpenSSH v1 parser factory still needs to survive R8');
  assert.match(engineSrc, /var stage = ConnectStage\.TRANSPORT/);
  assert.match(engineSrc, /stage = ConnectStage\.AUTHENTICATION/);
  assert.match(engineSrc, /stage = ConnectStage\.PTY/);
  assert.match(engineSrc, /stage = ConnectStage\.SHELL/);
  assert.doesNotMatch(engineSrc, /fun mapError\(error: Exception\): MobileError/,
    'generic ssh_connect_failed must not hide the failing phase');
  assert.match(workflowSrc,
    /Lcom\/hierynomus\/sshj\/userauth\/keyprovider\/OpenSSHKeyV1KeyFile;/,
    'release APK must prove the OpenSSH v1 parser survived R8');
  assert.match(workflowSrc,
    /Lorg\/bouncycastle\/jce\/provider\/BouncyCastleProvider;/,
    'release APK must be scanned for the conflicting BC provider');
  assert.match(workflowSrc, /external BouncyCastleProvider must not ship in the Android APK/);
  assert.match(workflowSrc, /Lnet\/i2p\/crypto\/eddsa\/EdDSAPublicKey;/,
    'release APK must retain Ed25519 signing support');
}

const current = {
  engineSrc: engine,
  securitySrc: security,
  appRulesSrc: appRules,
  consumerRulesSrc: consumerRules,
  workflowSrc: workflow,
};

test('Android SSH uses platform JCE and rejects the pre21 BC collision', () => {
  assertRuntimeGuards(current);
});

test('mutation guards catch provider collision and generic diagnostics', () => {
  assert.throws(
    () => assertRuntimeGuards({
      ...current,
      securitySrc: security.replace('SecurityUtils.setRegisterBouncyCastle(false)', 'SecurityUtils.setRegisterBouncyCastle(true)'),
    }),
    /reflectively register external BC/,
  );
  assert.throws(
    () => assertRuntimeGuards({
      ...current,
      appRulesSrc: appRules + '\n-keep class org.bouncycastle.** { *; }\n',
    }),
    /must not retain external/,
  );
  assert.throws(
    () => assertRuntimeGuards({
      ...current,
      engineSrc: engine.replace('stage = ConnectStage.AUTHENTICATION', '// stage lost'),
    }),
    /AUTHENTICATION/,
  );
  assert.throws(
    () => assertRuntimeGuards({
      ...current,
      workflowSrc: workflow.replace(
        "grep -aFq 'Lcom/hierynomus/sshj/userauth/keyprovider/OpenSSHKeyV1KeyFile;'",
        "true # no v1 check",
      ),
    }),
    /OpenSSH v1 parser/,
  );
});
