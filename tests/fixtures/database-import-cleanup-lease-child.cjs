'use strict';

const fs = require('fs');
const path = require('path');
const {
    acquireImportCleanupLease,
} = require('../../database-import-install-journal');

const [mode, directoryArg] = process.argv.slice(2);
const dataDir = path.resolve(directoryArg || '');
const databaseFile = path.join(dataDir, 'zephyr.db');
const keyFile = path.join(dataDir, 'crypto', 'key.json');

function emit(message) {
    fs.writeSync(1, `${JSON.stringify(message)}\n`);
}

function hold() {
    setInterval(() => {}, 1_000);
}

function waitForPublicationBarrier() {
    const barrier = path.join(dataDir, '.zephyr-import-cleanup-publish-go');
    emit({ event: 'publish_ready' });
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(barrier)) {
        if (Date.now() >= deadline) throw new Error('cleanup lease publication barrier timed out');
        Atomics.wait(signal, 0, 0, 10);
    }
}

function acquire(beforeCleanupLeasePublish = null) {
    return acquireImportCleanupLease({
        dataDir,
        databaseFile,
        keyFile,
        beforeCleanupLeasePublish,
    });
}

function attempt(beforeCleanupLeasePublish = null) {
    try {
        const lease = acquire(beforeCleanupLeasePublish);
        emit({ event: 'result', ok: true, lease });
        hold();
    } catch (error) {
        emit({ event: 'result', ok: false, message: error?.message || String(error) });
    }
}

if (mode === 'hold') {
    attempt();
} else if (mode === 'race') {
    const startFile = path.join(dataDir, '.zephyr-import-cleanup-race-go');
    emit({ event: 'ready' });
    const wait = setInterval(() => {
        if (!fs.existsSync(startFile)) return;
        clearInterval(wait);
        attempt();
    }, 5);
} else if (mode === 'publish-race') {
    attempt(waitForPublicationBarrier);
} else {
    throw new Error(`unsupported cleanup lease child mode: ${mode}`);
}
