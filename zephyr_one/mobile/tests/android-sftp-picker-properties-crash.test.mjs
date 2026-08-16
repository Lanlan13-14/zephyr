import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobile = path.resolve(here, '..');
const repo = path.resolve(mobile, '..', '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

function assertPickerAndPropertiesGuards({ versions, app, workflow, sftp }) {
  assert.match(versions, /^fragment\s*=\s*"1\.8\.5"$/m,
    'Fragment must override Biometric alpha transitive Fragment 1.2.5');
  assert.match(versions, /androidx-fragment\s*=\s*\{\s*module\s*=\s*"androidx\.fragment:fragment",\s*version\.ref\s*=\s*"fragment"\s*\}/,
    'the version catalog must expose the pinned Fragment');
  assert.match(app, /implementation\(libs\.androidx\.fragment\)/,
    'the application must resolve the compatible FragmentActivity implementation');
  assert.match(workflow, /META-INF\/androidx\.fragment_fragment\.version[\s\S]*?1\.8\.5/,
    'release validation must inspect the resolved APK, not trust only Gradle source');
  assert.match(sftp, /ActivityResultContracts\.GetMultipleContents\(\)/,
    'SFTP upload must remain a system multi-document picker');
  assert.match(sftp, /ActivityResultContracts\.CreateDocument\("\*\/\*"\)/,
    'SFTP download must remain a system create-document picker');

  const properties = sftp.match(/is SftpDialog\.Properties -> AlertDialog\(([\s\S]*?)\n\s*is SftpDialog\.Chmod ->/u)?.[1];
  assert.ok(properties, 'missing SFTP properties dialog');
  assert.doesNotMatch(properties, /verticalScroll\s*\(/,
    'AlertDialog already scrolls its bounded text body; properties must not nest scrolling');
}

test('SFTP upload, download and properties retain crash guards', () => {
  assertPickerAndPropertiesGuards({
    versions: read('android/gradle/libs.versions.toml'),
    app: read('android/app/build.gradle.kts'),
    workflow: fs.readFileSync(path.join(repo, '.github/workflows/zephyr-one-mobile.yml'), 'utf8'),
    sftp: read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt'),
  });
});

test('guards reject pre19 picker and nested-scroll regressions', () => {
  const current = {
    versions: read('android/gradle/libs.versions.toml'),
    app: read('android/app/build.gradle.kts'),
    workflow: fs.readFileSync(path.join(repo, '.github/workflows/zephyr-one-mobile.yml'), 'utf8'),
    sftp: read('android/feature-notes/src/main/kotlin/one/zephyr/mobile/feature/notes/SftpBrowserPane.kt'),
  };
  assert.throws(
    () => assertPickerAndPropertiesGuards({ ...current, versions: current.versions.replace('fragment = "1.8.5"', 'fragment = "1.2.5"') }),
    /Fragment must override/,
  );
  assert.throws(
    () => assertPickerAndPropertiesGuards({ ...current, app: current.app.replace('implementation(libs.androidx.fragment)', '') }),
    /application must resolve/,
  );
  assert.throws(
    () => assertPickerAndPropertiesGuards({
      ...current,
      sftp: current.sftp.replace('Column {\n                        current.lines.forEach', 'Column(Modifier.verticalScroll(rememberScrollState())) {\n                        current.lines.forEach'),
    }),
    /must not nest scrolling/,
  );
});
