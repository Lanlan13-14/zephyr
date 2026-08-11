import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqliteDriverModule from '../sqlite-driver.js';
import importAuthStateModule from '../database-import-auth-state.js';

const { createDatabase } = sqliteDriverModule;
const { prepareAndValidateImportedAuthenticationState } = importAuthStateModule;

function withDatabase(run) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-import-auth-state-'));
    const db = createDatabase(path.join(directory, 'candidate.db'), { forceBuiltin: true });
    try {
        return run(db);
    } finally {
        db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function createRequiredSchema(db) {
    db.exec(`
        CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, revoked_at INTEGER, revoke_reason TEXT);
        CREATE TABLE password_reset_codes (id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE password_rollback_tokens (id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0);
    `);
}

test('candidate authentication validation rejects case-variant tables instead of silently skipping them', () => {
    withDatabase((db) => {
        createRequiredSchema(db);
        db.exec('CREATE TABLE PassKeys (credential TEXT PRIMARY KEY);');
        assert.throws(
            () => prepareAndValidateImportedAuthenticationState(db, { now: 100 }),
            (error) => error?.code === 'import_auth_state_validation_failed' && /non-canonical authentication table/.test(error.message),
        );
    });
});

test('candidate authentication validation rejects a trigger which would convert revocation into zero changes', () => {
    withDatabase((db) => {
        createRequiredSchema(db);
        db.exec(`
            INSERT INTO auth_sessions VALUES ('active', NULL, NULL);
            CREATE TRIGGER ignore_revoke BEFORE UPDATE ON auth_sessions
            BEGIN SELECT RAISE(IGNORE); END;
        `);
        assert.throws(
            () => prepareAndValidateImportedAuthenticationState(db, { now: 100 }),
            (error) => error?.code === 'import_auth_state_validation_failed' && /disallowed trigger/.test(error.message),
        );
        assert.equal(db.prepare('SELECT revoked_at FROM auth_sessions').get().revoked_at, null);
    });
});

test('candidate authentication validation fails closed for absent required tables but permits absent optional legacy families', () => {
    withDatabase((db) => {
        db.exec('CREATE TABLE auth_sessions (token_hash TEXT PRIMARY KEY, revoked_at INTEGER, revoke_reason TEXT);');
        assert.throws(
            () => prepareAndValidateImportedAuthenticationState(db, { now: 100 }),
            /missing required authentication table: password_reset_codes/,
        );
    });

    withDatabase((db) => {
        createRequiredSchema(db);
        db.exec(`INSERT INTO auth_sessions VALUES ('active', NULL, NULL);
            INSERT INTO password_reset_codes VALUES ('reset', 0);
            INSERT INTO password_rollback_tokens VALUES ('rollback', 0);`);
        assert.deepEqual(prepareAndValidateImportedAuthenticationState(db, { now: 100 }), {
            sessions: 1,
            resetCodes: 1,
            rollbackTokens: 1,
            mobileDevices: 0,
            proofChallenges: 0,
            sensitiveGrants: 0,
            passkeys: 0,
            deeplinks: 0,
            clientTokens: 0,
        });
    });
});

test('candidate preparation atomically removes every supported imported credential family and verifies its invariants', () => {
    withDatabase((db) => {
        createRequiredSchema(db);
        db.exec(`
            CREATE TABLE users (username TEXT PRIMARY KEY, totpEnabled INTEGER, totpSecret TEXT);
            CREATE TABLE mobile_devices (
                device_id TEXT PRIMARY KEY, refresh_token_hash TEXT,
                refresh_generation INTEGER NOT NULL, revoked_at INTEGER, revoke_reason TEXT
            );
            CREATE TABLE mobile_device_proof_challenges (nonce_hash TEXT PRIMARY KEY);
            CREATE TABLE mobile_sensitive_grants (grant_hash TEXT PRIMARY KEY);
            CREATE TABLE passkeys (id TEXT PRIMARY KEY);
            CREATE TABLE deeplink_tokens (token_hash TEXT PRIMARY KEY, credential_enc TEXT, consumed_at INTEGER);
            CREATE TABLE encrypted_client_tokens (
                id TEXT PRIMARY KEY, secret_ciphertext TEXT NOT NULL, secret_digest BLOB,
                revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
            );
            INSERT INTO users VALUES ('admin', 1, 'encrypted-totp');
            INSERT INTO auth_sessions VALUES ('active', NULL, NULL);
            INSERT INTO password_reset_codes VALUES ('reset', 0);
            INSERT INTO password_rollback_tokens VALUES ('rollback', 0);
            INSERT INTO mobile_devices VALUES ('device', 'refresh-hash', 7, NULL, NULL);
            INSERT INTO mobile_device_proof_challenges VALUES ('proof');
            INSERT INTO mobile_sensitive_grants VALUES ('grant');
            INSERT INTO passkeys VALUES ('passkey');
            INSERT INTO deeplink_tokens VALUES ('link', 'credential', NULL);
            INSERT INTO encrypted_client_tokens VALUES ('client', 'ciphertext', X'0102', 4, 2, NULL);
        `);

        const result = prepareAndValidateImportedAuthenticationState({ rawDb: () => db }, { now: 1234 });
        assert.deepEqual(result, {
            sessions: 1,
            resetCodes: 1,
            rollbackTokens: 1,
            mobileDevices: 1,
            proofChallenges: 1,
            sensitiveGrants: 1,
            passkeys: 1,
            deeplinks: 1,
            clientTokens: 1,
        });
        assert.deepEqual({ ...db.prepare('SELECT totpEnabled, totpSecret FROM users').get() }, { totpEnabled: 0, totpSecret: null });
        assert.deepEqual({ ...db.prepare('SELECT revoked_at, revoke_reason FROM auth_sessions').get() }, { revoked_at: 1234, revoke_reason: 'database-import' });
        assert.equal(db.prepare('SELECT used FROM password_reset_codes').get().used, 1);
        assert.equal(db.prepare('SELECT used FROM password_rollback_tokens').get().used, 1);
        assert.deepEqual({ ...db.prepare('SELECT refresh_token_hash, refresh_generation, revoked_at, revoke_reason FROM mobile_devices').get() }, {
            refresh_token_hash: null, refresh_generation: 8, revoked_at: 1234, revoke_reason: 'database-import',
        });
        for (const table of ['mobile_device_proof_challenges', 'mobile_sensitive_grants', 'passkeys']) {
            assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
        }
        assert.deepEqual({ ...db.prepare('SELECT credential_enc, consumed_at FROM deeplink_tokens').get() }, { credential_enc: null, consumed_at: 1234 });
        assert.deepEqual({ ...db.prepare('SELECT secret_ciphertext, secret_digest, revision, updated_at, deleted_at FROM encrypted_client_tokens').get() }, {
            secret_ciphertext: '', secret_digest: null, revision: 5, updated_at: 1234, deleted_at: 1234,
        });
    });
});
