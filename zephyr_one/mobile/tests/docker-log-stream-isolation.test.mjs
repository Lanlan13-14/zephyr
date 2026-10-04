import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(path, 'utf8');

test('docker log stream dials its own session and reports the underlying error', () => {
    const pool = read('android/app/src/main/kotlin/one/zephyr/mobile/app/ManagedSshSessionPool.kt');
    const port = read('android/app/src/main/kotlin/one/zephyr/mobile/app/LiveSshExecPort.kt');
    const panel = read('android/feature-tools/src/main/kotlin/one/zephyr/mobile/feature/tools/HostOpsPanels.kt');

    assert.match(pool, /suspend fun acquireEphemeral\(connectionId: String\)/);
    // The stream must not reuse the shared session the stats poller holds.
    const stream = port.slice(port.indexOf('fun execStreamEvents'), port.indexOf('fun execStreamEvents') + 900);
    assert.match(stream, /managed\.acquireEphemeral\(connectionId\)/);
    assert.doesNotMatch(stream, /managed\.acquire\(connectionId\)/);

    // A cause-less ConnectionException (sshj timeout wrap) must not hide the real reason,
    // and recomposition cancellation must not be reported as a read failure.
    assert.match(panel, /if \(failure is CancellationException\) throw failure/);
    assert.match(panel, /generateSequence\(failure\) \{ it\.cause \}/);
});
