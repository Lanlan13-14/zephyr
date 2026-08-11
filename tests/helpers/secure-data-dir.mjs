import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function createSecureTestDataDir(prefix = 'zephyr-test-data-') {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryRoot, prefix));
    fs.chmodSync(root, 0o700);
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { mode: 0o700 });
    return { root, dataDir };
}

export function removeSecureTestDataDir(fixture) {
    if (!fixture?.root) return;
    let target = fixture.root;
    if (process.platform === 'win32') {
        const renamed = `${fixture.root}.cleanup-${process.pid}-${crypto.randomUUID()}`;
        try {
            fs.renameSync(fixture.root, renamed);
            target = renamed;
        } catch (error) {
            if (error?.code === 'ENOENT') return;
        }
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
