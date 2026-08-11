'use strict';

const IMPORT_SESSION_REVOKE_REASON = 'database-import';

/* These names are security boundaries, not user supplied identifiers. SQLite
 * treats ASCII object names case-insensitively, while sqlite_master preserves
 * their spelling. A candidate with `PassKeys` would otherwise evade an exact
 * sqlite_master lookup even though product queries use `passkeys`. */
const AUTH_TABLES = Object.freeze({
    users: { required: false, columns: ['username', 'totpEnabled', 'totpSecret'] },
    auth_sessions: { required: true, columns: ['token_hash', 'revoked_at', 'revoke_reason'] },
    password_reset_codes: { required: true, columns: ['used'] },
    password_rollback_tokens: { required: true, columns: ['used'] },
    mobile_devices: { required: false, columns: ['refresh_token_hash', 'refresh_generation', 'revoked_at', 'revoke_reason'] },
    mobile_device_proof_challenges: { required: false, columns: [] },
    mobile_sensitive_grants: { required: false, columns: [] },
    passkeys: { required: false, columns: [] },
    deeplink_tokens: { required: false, columns: ['credential_enc', 'consumed_at'] },
    encrypted_client_tokens: { required: false, columns: ['secret_ciphertext', 'secret_digest', 'revision', 'updated_at', 'deleted_at'] },
});

function importAuthStateError(message) {
    const error = new Error(message);
    error.code = 'import_auth_state_validation_failed';
    return error;
}

function foldedObjectName(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('en-US');
}

function quoteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`;
}

function schemaObjects(db) {
    return db.prepare(`SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`).all();
}

function tableColumns(db, table) {
    return new Set(db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all()
        .map((row) => String(row.name || '')));
}

/**
 * Validate the part of an imported schema that is about to revoke credentials.
 * This deliberately has no "repair" path: installing a malformed backup is
 * less safe than rejecting it while it is still isolated.
 */
function validateImportedAuthenticationSchema(db) {
    if (!db || typeof db.prepare !== 'function') {
        throw importAuthStateError('candidate authentication validation requires a database');
    }
    const objects = schemaObjects(db);

    // Trigger bodies can turn UPDATE/DELETE into a successful no-op (for
    // example RAISE(IGNORE)). Zephyr persists no triggers, so every candidate
    // trigger is rejected before we issue a credential-changing statement.
    const trigger = objects.find((row) => row.type === 'trigger');
    if (trigger) throw importAuthStateError(`candidate database contains a disallowed trigger: ${trigger.name}`);

    const present = new Set();
    for (const [table, spec] of Object.entries(AUTH_TABLES)) {
        const folded = foldedObjectName(table);
        const matching = objects.filter((row) => foldedObjectName(row.name) === folded);
        if (matching.length > 1) {
            throw importAuthStateError(`candidate database has ambiguous authentication object: ${table}`);
        }
        if (!matching.length) {
            if (spec.required) throw importAuthStateError(`candidate database is missing required authentication table: ${table}`);
            continue;
        }
        const object = matching[0];
        if (object.type !== 'table' || object.name !== table) {
            throw importAuthStateError(`candidate database has non-canonical authentication table: ${object.name}`);
        }
        const columns = tableColumns(db, table);
        for (const column of spec.columns) {
            if (!columns.has(column)) {
                throw importAuthStateError(`candidate authentication table ${table} is missing required column: ${column}`);
            }
        }
        present.add(table);
    }
    return present;
}

function tableExists(db, table) {
    const matches = schemaObjects(db).filter((row) => foldedObjectName(row.name) === foldedObjectName(table));
    return matches.length === 1 && matches[0].type === 'table' && matches[0].name === table;
}

function count(db, sql, ...params) {
    const row = db.prepare(sql).get(...params);
    return Number(row?.count || 0);
}

function requireZero(db, sql, label) {
    if (count(db, sql) !== 0) throw importAuthStateError(`candidate authentication cleanup verification failed: ${label}`);
}

function resolveDatabase(candidateStorageOrDb) {
    if (candidateStorageOrDb && typeof candidateStorageOrDb.rawDb === 'function') return candidateStorageOrDb.rawDb();
    return candidateStorageOrDb;
}

function assertPostInvalidationState(db, tables, mobileGenerations) {
    requireZero(db, 'SELECT COUNT(*) AS count FROM auth_sessions WHERE revoked_at IS NULL', 'active sessions remain');
    requireZero(db, 'SELECT COUNT(*) AS count FROM password_reset_codes WHERE used = 0', 'active password reset codes remain');
    requireZero(db, 'SELECT COUNT(*) AS count FROM password_rollback_tokens WHERE used = 0', 'active password rollback tokens remain');
    if (tables.has('users')) {
        requireZero(db, `SELECT COUNT(*) AS count FROM users
            WHERE COALESCE(totpEnabled, 0) != 0 OR NULLIF(totpSecret, '') IS NOT NULL`, 'TOTP credentials remain');
    }
    if (tables.has('mobile_devices')) {
        requireZero(db, `SELECT COUNT(*) AS count FROM mobile_devices
            WHERE refresh_token_hash IS NOT NULL OR revoked_at IS NULL`, 'active mobile device credentials remain');
        const rows = db.prepare('SELECT rowid AS import_rowid, refresh_generation FROM mobile_devices').all();
        if (rows.length !== mobileGenerations.size || rows.some((row) => mobileGenerations.get(Number(row.import_rowid)) !== Number(row.refresh_generation))) {
            throw importAuthStateError('candidate authentication cleanup verification failed: mobile refresh generation invariant');
        }
    }
    if (tables.has('mobile_device_proof_challenges')) requireZero(db, 'SELECT COUNT(*) AS count FROM mobile_device_proof_challenges', 'mobile proof challenges remain');
    if (tables.has('mobile_sensitive_grants')) requireZero(db, 'SELECT COUNT(*) AS count FROM mobile_sensitive_grants', 'mobile sensitive grants remain');
    if (tables.has('passkeys')) requireZero(db, 'SELECT COUNT(*) AS count FROM passkeys', 'passkeys remain');
    if (tables.has('deeplink_tokens')) {
        requireZero(db, `SELECT COUNT(*) AS count FROM deeplink_tokens
            WHERE credential_enc IS NOT NULL OR consumed_at IS NULL`, 'active deeplink credentials remain');
    }
    if (tables.has('encrypted_client_tokens')) {
        requireZero(db, `SELECT COUNT(*) AS count FROM encrypted_client_tokens
            WHERE NULLIF(secret_ciphertext, '') IS NOT NULL OR secret_digest IS NOT NULL OR deleted_at IS NULL`, 'active client token credentials remain');
    }
}

function invalidateImportedAuthenticationState(db, {
    now = Date.now(),
    reason = IMPORT_SESSION_REVOKE_REASON,
    beforeCommit = null,
    verifiedTables = null,
} = {}) {
    if (!db || typeof db.transaction !== 'function') {
        throw new Error('database import authentication invalidation requires a transactional database');
    }
    const revokedAt = Number(now);
    if (!Number.isSafeInteger(revokedAt) || revokedAt < 1) {
        throw new Error('database import authentication invalidation requires a valid timestamp');
    }
    const revokeReason = String(reason || IMPORT_SESSION_REVOKE_REASON).slice(0, 80);
    const tables = verifiedTables || new Set(Object.keys(AUTH_TABLES).filter((table) => tableExists(db, table)));
    for (const required of ['auth_sessions', 'password_reset_codes', 'password_rollback_tokens']) {
        if (!tables.has(required)) throw new Error(`database import authentication invalidation requires ${required}`);
    }

    const statements = {
        revokeSessions: db.prepare('UPDATE auth_sessions SET revoked_at = ?, revoke_reason = ? WHERE revoked_at IS NULL'),
        resetCodes: db.prepare('UPDATE password_reset_codes SET used = 1 WHERE used = 0'),
        rollbackTokens: db.prepare('UPDATE password_rollback_tokens SET used = 1 WHERE used = 0'),
        clearTotp: tables.has('users') ? db.prepare('UPDATE users SET totpEnabled = 0, totpSecret = NULL WHERE COALESCE(totpEnabled, 0) != 0 OR totpSecret IS NOT NULL') : null,
        mobileDevices: tables.has('mobile_devices') ? db.prepare(`UPDATE mobile_devices
            SET refresh_token_hash = NULL, refresh_generation = refresh_generation + 1,
                revoked_at = ?, revoke_reason = ?`) : null,
        proofChallenges: tables.has('mobile_device_proof_challenges') ? db.prepare('DELETE FROM mobile_device_proof_challenges') : null,
        sensitiveGrants: tables.has('mobile_sensitive_grants') ? db.prepare('DELETE FROM mobile_sensitive_grants') : null,
        passkeys: tables.has('passkeys') ? db.prepare('DELETE FROM passkeys') : null,
        deeplinks: tables.has('deeplink_tokens') ? db.prepare('UPDATE deeplink_tokens SET consumed_at = COALESCE(consumed_at, ?), credential_enc = NULL') : null,
        clientTokens: tables.has('encrypted_client_tokens') ? db.prepare(`UPDATE encrypted_client_tokens
            SET secret_ciphertext = '', secret_digest = NULL,
                revision = revision + CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END,
                updated_at = CASE WHEN deleted_at IS NULL THEN ? ELSE updated_at END,
                deleted_at = COALESCE(deleted_at, ?)`) : null,
    };

    return db.transaction(() => {
        const mobileGenerations = new Map();
        if (tables.has('mobile_devices')) {
            for (const row of db.prepare('SELECT rowid AS import_rowid, refresh_generation FROM mobile_devices').all()) {
                mobileGenerations.set(Number(row.import_rowid), Number(row.refresh_generation) + 1);
            }
        }
        const result = {
            sessions: statements.revokeSessions.run(revokedAt, revokeReason).changes,
            resetCodes: statements.resetCodes.run().changes,
            rollbackTokens: statements.rollbackTokens.run().changes,
            // TOTP is intentionally not exposed in the legacy result shape.
            // Callers use the return value for audit counts predating TOTP.
            _totpCleared: statements.clearTotp?.run().changes || 0,
            mobileDevices: statements.mobileDevices?.run(revokedAt, revokeReason).changes || 0,
            proofChallenges: statements.proofChallenges?.run().changes || 0,
            sensitiveGrants: statements.sensitiveGrants?.run().changes || 0,
            passkeys: statements.passkeys?.run().changes || 0,
            deeplinks: statements.deeplinks?.run(revokedAt).changes || 0,
            clientTokens: statements.clientTokens?.run(revokedAt, revokedAt).changes || 0,
        };
        if (verifiedTables) assertPostInvalidationState(db, tables, mobileGenerations);
        delete result._totpCleared;
        if (typeof beforeCommit === 'function') beforeCommit(result);
        return result;
    })();
}

/**
 * The install flow calls this only on a database still rooted in a private
 * candidate directory. It validates object identity and then commits all
 * authentication invalidation and its postconditions as one transaction.
 */
function prepareAndValidateImportedAuthenticationState(candidateStorageOrDb, options = {}) {
    const db = resolveDatabase(candidateStorageOrDb);
    const tables = validateImportedAuthenticationSchema(db);
    return invalidateImportedAuthenticationState(db, { ...options, verifiedTables: tables });
}

module.exports = {
    AUTH_TABLES,
    IMPORT_SESSION_REVOKE_REASON,
    invalidateImportedAuthenticationState,
    prepareAndValidateImportedAuthenticationState,
    validateImportedAuthenticationSchema,
};
