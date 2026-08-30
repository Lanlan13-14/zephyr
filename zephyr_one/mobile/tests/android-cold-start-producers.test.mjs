import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(mobile, relative), 'utf8');

test('restore paints before sockets and keep-alive is a disclosed dataSync service', () => {
  const application = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ZephyrOneApplication.kt');
  const onCreate = application.slice(application.indexOf('override fun onCreate()'));
  const afterLaunch = onCreate.slice(onCreate.indexOf('applicationScope.launch'));
  const beforeReady = afterLaunch.slice(0, afterLaunch.indexOf('readyState.value = true'));
  const afterReady = afterLaunch.slice(afterLaunch.indexOf('readyState.value = true'));

  assert.match(afterLaunch, /RdpAndroidRuntime\.installHome\(filesDir\)/);
  assert.doesNotMatch(onCreate.slice(0, onCreate.indexOf('applicationScope.launch')), /RdpAndroidRuntime\.installHome/);
  assert.doesNotMatch(beforeReady, /startNetworkProducers/);
  assert.doesNotMatch(beforeReady, /bootstrapRestoredBinding/);
  assert.match(afterReady, /startNetworkProducers/);
  assert.match(afterReady, /bootstrapRestoredBinding/);
  assert.match(afterReady, /ConnectionKeepAliveService\.start/);
  assert.ok(
    afterReady.indexOf('ConnectionKeepAliveService.start') < afterReady.indexOf('startNetworkProducers'),
    'keep-alive disclosure must start before sockets',
  );

  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.app\.sync\.ConnectionKeepAliveService"/);
  assert.match(manifest, /android:foregroundServiceType="dataSync"/);

  const wake = read('android/core-sync/src/main/kotlin/one/zephyr/mobile/sync/WakeCoordinator.kt');
  assert.match(wake, /fun onHoldAliveChanged/);
  assert.match(wake, /foreground \|\| holdAlive/);

  const coordinator = read('android/app/src/main/kotlin/one/zephyr/mobile/app/binding/BindingCoordinator.kt');
  assert.match(coordinator, /prepared\.graph\.startNetworkProducers\(\)/);
  assert.match(coordinator, /graph\.startNetworkProducers\(\)/);
});
