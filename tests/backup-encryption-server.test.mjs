import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import backupModule from '../backup-encryption.js';
import sqliteModule from '../sqlite-driver.js';
import { createSecureTestDataDir, removeSecureTestDataDir } from './helpers/secure-data-dir.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const { CURRENT_MAGIC, PUBLIC_DEFAULT_SECRET, requireStrongBackupSecret } = backupModule;
const { createDatabase } = sqliteModule;

async function freePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    return port;
}

async function startServer({ envFileContent, externalEnv = {} } = {}) {
    const dataFixture = createSecureTestDataDir('zephyr-backup-key-server-');
    const dataDir = dataFixture.dataDir;
    let child = null;
    try {
        if (envFileContent !== undefined) fs.writeFileSync(path.join(dataDir, '.env'), envFileContent, { mode: 0o600 });
        const port = await freePort();
        const aiPort = await freePort();
        const startupChallenge = crypto.randomBytes(32).toString('hex');
        const env = {
            ...process.env,
            HTTP_ENABLED: 'true',
            HTTPS_ENABLED: 'false',
            PORT: String(port),
            ZEPHYR_BIND_HOST: '127.0.0.1',
            ZEPHYR_AI_HOST_LISTEN: `127.0.0.1:${aiPort}`,
            ZEPHYR_AI_PLATFORM_HOST_URL: `http://127.0.0.1:${aiPort}`,
            ZEPHYR_DATA_DIR: dataDir,
            ZEPHYR_DATA_MLKEM768_KEY_FILE: path.join(dataDir, 'crypto', 'key.json'),
            ZEPHYR_ONE_EMBEDDED: '1',
            ZEPHYR_ONE_STARTUP_CHALLENGE: startupChallenge,
            ZEPHYR_ONE_USE_BUILTIN_SQLITE: '1',
            NODE_ENV: 'production',
        };
        delete env.ENCRYPTION_KEY;
        delete env.ZEPHYR_BACKUP_KEY_PROVENANCE;
        delete env.WEBDAV_BACKUP_KEY;
        delete env.WEBDAV_CREDENTIAL_KEY;
        Object.assign(env, externalEnv);
        child = spawn(process.execPath, ['server.js'], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let output = '';
        child.stdout.on('data', (chunk) => { output += chunk; });
        child.stderr.on('data', (chunk) => { output += chunk; });
        const base = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + 60_000;
        let ready = false;
        while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null) {
                throw new Error(`server exited ${child.exitCode ?? child.signalCode}:\n${output.slice(-3000)}`);
            }
            try {
                const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1_000) });
                if (response.ok) {
                    ready = true;
                    break;
                }
            } catch {}
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error(`server startup timeout:\n${output.slice(-3000)}`);

        const bootstrap = await fetch(`${base}/__zephyr_one/bootstrap`, {
            method: 'POST',
            headers: { 'x-zephyr-one-bootstrap-challenge': startupChallenge },
            redirect: 'manual',
        });
        assert.equal(bootstrap.status, 204);
        const cookie = (bootstrap.headers.get('set-cookie') || '').split(';')[0];
        assert.match(cookie, /^zephyr_sid=/);

        async function stop() {
            if (child.exitCode === null) {
                child.kill('SIGTERM');
                await new Promise((resolve) => {
                    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 8_000);
                    child.once('exit', () => { clearTimeout(timer); resolve(); });
                });
            }
            removeSecureTestDataDir(dataFixture);
        }
        return { base, child, cookie, dataDir, output: () => output, stop };
    } catch (error) {
        if (child?.exitCode === null) {
            child.kill('SIGKILL');
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 2_000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        removeSecureTestDataDir(dataFixture);
        throw error;
    }
}

async function assertExportRejected(server, originalEnv, configuredSecret) {
    const response = await fetch(`${server.base}/api/data/export`, { headers: { cookie: server.cookie } });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.code, 'backup_key_configuration_required');
    assert.equal(fs.readFileSync(path.join(server.dataDir, '.env'), 'utf8'), originalEnv,
        'unsafe legacy configuration must require explicit rotation');
    if (configuredSecret) assert.equal(server.output().includes(configuredSecret), false, 'backup key must not enter logs');
}

test('real export provisions fresh installs and fails closed for missing, unattested, default, short, and weak keys', async () => {
    const unattested = crypto.randomBytes(32).toString('base64url');
    const generatedOnDisk = crypto.randomBytes(32).toString('base64url');
    const externalOverride = crypto.createHash('sha256').update('predictable-external-backup-key-v1').digest('base64url');
    assert.doesNotThrow(() => requireStrongBackupSecret(externalOverride),
        'the mixed-source case must exercise provenance rather than a known-weak denylist');
    const unsafe = [
        { name: 'missing', secret: '', content: 'PUBLIC_ORIGIN=http://localhost:3000\n' },
        { name: 'unattested', secret: unattested, content: `ENCRYPTION_KEY=${unattested}\nPUBLIC_ORIGIN=http://localhost:3000\n` },
        {
            name: 'external key cannot inherit generated disk provenance',
            secret: externalOverride,
            content: `ENCRYPTION_KEY=${generatedOnDisk}\nZEPHYR_BACKUP_KEY_PROVENANCE=zephyr-generated-csprng-v1\nPUBLIC_ORIGIN=http://localhost:3000\n`,
            externalEnv: { ENCRYPTION_KEY: externalOverride },
        },
        { name: 'public default', secret: PUBLIC_DEFAULT_SECRET, content: `ENCRYPTION_KEY=${PUBLIC_DEFAULT_SECRET}\nPUBLIC_ORIGIN=http://localhost:3000\n` },
        { name: 'short', secret: 'short-backup-key', content: 'ENCRYPTION_KEY=short-backup-key\nPUBLIC_ORIGIN=http://localhost:3000\n' },
        { name: 'low entropy', secret: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', content: 'ENCRYPTION_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\nPUBLIC_ORIGIN=http://localhost:3000\n' },
    ];
    const servers = [];
    try {
        const configurations = [
            { name: 'fresh install', options: undefined },
            ...unsafe.map(({ name, content, externalEnv }) => ({
                name,
                options: { envFileContent: content, externalEnv },
            })),
        ];
        const started = new Array(configurations.length);
        const startupConcurrency = 2;
        for (let offset = 0; offset < configurations.length; offset += startupConcurrency) {
            const results = await Promise.allSettled(configurations
                .slice(offset, offset + startupConcurrency)
                .map((configuration) => startServer(configuration.options)));
            results.forEach((result, index) => {
                if (result.status !== 'fulfilled') return;
                started[offset + index] = result.value;
                servers.push(result.value);
            });
            const failedIndex = results.findIndex((result) => result.status === 'rejected');
            if (failedIndex >= 0) {
                const failure = results[failedIndex].reason;
                failure.message = `${configurations[offset + failedIndex].name} startup failed: ${failure.message}`;
                throw failure;
            }
        }
        const [fresh, ...unsafeServers] = started;

        const freshResponse = await fetch(`${fresh.base}/api/data/export`, { headers: { cookie: fresh.cookie } });
        if (freshResponse.status !== 200) assert.fail(`fresh export failed: ${freshResponse.status} ${await freshResponse.text()}`);
        const archive = Buffer.from(await freshResponse.arrayBuffer());
        assert.equal(archive.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC), true);
        const generated = Object.fromEntries(fs.readFileSync(path.join(fresh.dataDir, '.env'), 'utf8')
            .trim().split(/\r?\n/).map((line) => line.split(/=(.*)/s).slice(0, 2))).ENCRYPTION_KEY;
        assert.equal(Buffer.from(generated, 'base64url').length, 32);
        assert.doesNotThrow(() => requireStrongBackupSecret(generated));
        assert.equal(fresh.output().includes(generated), false, 'generated backup key must not enter logs');

        await Promise.all(unsafeServers.map((server, index) => (
            assertExportRejected(server, unsafe[index].content, unsafe[index].secret)
                .catch((error) => { error.message = `${unsafe[index].name}: ${error.message}`; throw error; })
        )));
    } finally {
        await Promise.allSettled(servers.map((server) => server.stop()));
    }
});

test('export fails closed while a second SQLite connection blocks a WAL checkpoint, then succeeds after release', async () => {
    const secret = crypto.randomBytes(32).toString('base64url');
    const server = await startServer({
        externalEnv: {
            ENCRYPTION_KEY: secret,
            ZEPHYR_BACKUP_KEY_PROVENANCE: 'operator-attested-csprng-v1',
        },
    });
    const databaseFile = path.join(server.dataDir, 'zephyr.db');
    const reader = createDatabase(databaseFile, { forceBuiltin: true });
    try {
        // Keep a pre-write read snapshot open so the server's settings write
        // leaves WAL frames that FULL cannot checkpoint.
        reader.exec('BEGIN');
        reader.prepare('SELECT username FROM users LIMIT 1').get();

        const mutation = await fetch(`${server.base}/api/me/settings`, {
            method: 'PUT',
            headers: {
                'content-type': 'application/json',
                cookie: server.cookie,
                origin: server.base,
            },
            body: JSON.stringify({ appearance: { theme: 'checkpoint-lock-test' } }),
        });
        assert.equal(mutation.status, 200, await mutation.text());
        assert.ok(fs.statSync(`${databaseFile}-wal`).size > 0, 'the lock scenario must contain WAL frames');

        const blocked = await fetch(`${server.base}/api/data/export`, { headers: { cookie: server.cookie } });
        const body = await blocked.json();
        assert.equal(blocked.status, 503);
        assert.equal(body.code, 'backup_export_checkpoint_incomplete');
        assert.equal(body.retryable, true);
        assert.equal(blocked.headers.get('content-disposition'), null, 'a failed checkpoint must not start a download');
        assert.doesNotMatch(String(body.error || ''), /sqlite|wal|busy|databaseFile/i);
        assert.equal(fs.readdirSync(server.dataDir).some((name) => /(?:backup|export).*\.zip/i.test(name)), false,
            'a failed checkpoint must not leave an archive or export temporary file');

        reader.exec('COMMIT');
        const recovered = await fetch(`${server.base}/api/data/export`, { headers: { cookie: server.cookie } });
        if (recovered.status !== 200) assert.fail(`recovered export failed: ${recovered.status} ${await recovered.text()}`);
        const archive = Buffer.from(await recovered.arrayBuffer());
        assert.equal(archive.subarray(0, CURRENT_MAGIC.length).equals(CURRENT_MAGIC), true);
    } finally {
        try { reader.exec('ROLLBACK'); } catch {}
        reader.close();
        await server.stop();
    }
});
