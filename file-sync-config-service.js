'use strict';

const { getMobileV1ChangeBridge } = require('./mobile-v1-change-bridge');
const { MobileStoreError } = require('./mobile-v1-store');

const ENTITY_TYPE = 'fileSyncConfig';
const MIN_INTERVAL_SEC = 30;
const MAX_INTERVAL_SEC = 86400;
const DEVICE_LOCAL_FIELDS = new Set([
    'networkPolicy',
    'safPath',
    'safUri',
    'safTreeUri',
    'localPath',
    'lastLocalAttemptAt',
    'localError',
]);

function clampInterval(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 300;
    return Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, Math.floor(number)));
}

function revisionOf(row) {
    return Math.max(1, Number(row?.config_revision || 1));
}

function tableExists(db, table) {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function ensureColumn(db, table, column, definition) {
    if (!tableExists(db, table)) return;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((candidate) => candidate.name === column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

function samePublicConfig(left, right) {
    if (!left || !right) return false;
    return left.clientId === right.clientId
        && left.ownerUserId === right.ownerUserId
        && left.deviceName === right.deviceName
        && left.enabled === right.enabled
        && left.automaticEnabled === right.automaticEnabled
        && left.syncIntervalSec === right.syncIntervalSec;
}

/**
 * Canonical service for the small, non-secret part of a One device's sync
 * configuration.
 *
 * `mobile_devices` is authoritative when both generations contain the same
 * id for the same owner. A legacy-only `one_clients.client_id` remains its own
 * stable id; migration never generates a replacement id and never joins rows
 * that belong to different accounts.
 */
class FileSyncConfigService {
    constructor({ db, store, changeBridge, now = () => Date.now() } = {}) {
        if (!db) throw new TypeError('FileSyncConfigService requires a SQLite db');
        this.db = db;
        this.now = now;
        this._ensureSchema();
        this.changeBridge = changeBridge || getMobileV1ChangeBridge(db, store ? { store } : {});
        /* The bridge may have created mobile_devices after the first pass. */
        this._ensureSchema();
        this.reconcileAll();
    }

    _ensureSchema() {
        ensureColumn(this.db, 'mobile_devices', 'config_revision', 'INTEGER NOT NULL DEFAULT 1');
        ensureColumn(this.db, 'one_clients', 'automatic_enabled', 'INTEGER NOT NULL DEFAULT 1');
        ensureColumn(this.db, 'one_clients', 'config_revision', 'INTEGER NOT NULL DEFAULT 1');
        if (tableExists(this.db, 'mobile_devices')) {
            this.db.exec('UPDATE mobile_devices SET config_revision = 1 WHERE config_revision IS NULL OR config_revision < 1');
        }
        if (tableExists(this.db, 'one_clients')) {
            this.db.exec('UPDATE one_clients SET automatic_enabled = 1 WHERE automatic_enabled IS NULL');
            this.db.exec('UPDATE one_clients SET config_revision = 1 WHERE config_revision IS NULL OR config_revision < 1');
        }
    }

    _mobile(ownerUserId, clientId) {
        if (!tableExists(this.db, 'mobile_devices')) return null;
        return this.db.prepare(`SELECT * FROM mobile_devices
            WHERE owner_user_id = ? AND device_id = ?`).get(String(ownerUserId), String(clientId)) || null;
    }

    _legacy(ownerUserId, clientId) {
        if (!tableExists(this.db, 'one_clients')) return null;
        return this.db.prepare(`SELECT * FROM one_clients
            WHERE owner_user_id = ? AND client_id = ?`).get(String(ownerUserId), String(clientId)) || null;
    }

    _anyOwner(clientId) {
        const id = String(clientId || '');
        const mobile = tableExists(this.db, 'mobile_devices')
            ? this.db.prepare('SELECT owner_user_id FROM mobile_devices WHERE device_id = ?').get(id)
            : null;
        const legacy = tableExists(this.db, 'one_clients')
            ? this.db.prepare('SELECT owner_user_id FROM one_clients WHERE client_id = ?').get(id)
            : null;
        return [mobile?.owner_user_id, legacy?.owner_user_id].filter(Boolean).map(String);
    }

    _authority(ownerUserId, clientId) {
        const mobile = this._mobile(ownerUserId, clientId);
        if (mobile) return { source: 'mobile', row: mobile };
        const legacy = this._legacy(ownerUserId, clientId);
        return legacy ? { source: 'legacy', row: legacy } : null;
    }

    _project(authority) {
        if (!authority?.row) return null;
        const row = authority.row;
        const mobile = authority.source === 'mobile';
        const revokedAt = row.revoked_at == null ? null : Number(row.revoked_at);
        return {
            /* v1 device_id and legacy client_id intentionally share this wire id. */
            clientId: String(mobile ? row.device_id : row.client_id),
            ownerUserId: String(row.owner_user_id),
            deviceName: String(row.device_name || ''),
            enabled: !!row.enabled && revokedAt == null,
            automaticEnabled: !!row.automatic_enabled && revokedAt == null,
            syncIntervalSec: clampInterval(row.sync_interval_sec),
            /* The frozen registry calls the entity revision syncRevision. */
            syncRevision: revisionOf(row),
        };
    }

    /** Public sync projection. It intentionally contains no credential or key metadata. */
    read(ownerUserId, clientId, { includeRevoked = false } = {}) {
        const authority = this._authority(ownerUserId, clientId);
        if (!authority) return null;
        if (!includeRevoked && authority.row.revoked_at != null) return null;
        return this._project(authority);
    }

    list(ownerUserId) {
        const owner = String(ownerUserId || '');
        const byId = new Map();
        const mobileIds = new Set();
        if (tableExists(this.db, 'mobile_devices')) {
            for (const row of this.db.prepare(`SELECT * FROM mobile_devices
                WHERE owner_user_id = ? ORDER BY created_at DESC`).all(owner)) {
                const id = String(row.device_id);
                mobileIds.add(id);
                if (row.revoked_at == null) byId.set(id, this._project({ source: 'mobile', row }));
            }
        }
        if (tableExists(this.db, 'one_clients')) {
            for (const row of this.db.prepare(`SELECT * FROM one_clients
                WHERE owner_user_id = ? ORDER BY created_at DESC`).all(owner)) {
                const id = String(row.client_id);
                if (!mobileIds.has(id) && row.revoked_at == null) {
                    byId.set(id, this._project({ source: 'legacy', row }));
                }
            }
        }
        return [...byId.values()];
    }

    residency(ownerUserId, clientId) {
        if (this._authority(ownerUserId, clientId)) return 'owned';
        return this._anyOwner(clientId).length ? 'foreign' : 'missing';
    }

    _assertLocalFieldsStayLocal(patch) {
        for (const field of Object.keys(patch || {})) {
            if (!DEVICE_LOCAL_FIELDS.has(field)) continue;
            throw new MobileStoreError(
                'invalid_request',
                `${field} is device-local and cannot be synchronized`,
                400,
                { details: { field, residency: 'device-local' } },
            );
        }
    }

    _requireAuthority(ownerUserId, clientId, { includeRevoked = false } = {}) {
        const authority = this._authority(ownerUserId, clientId);
        if (!authority) {
            throw new MobileStoreError('client_not_found', 'Device sync configuration not found', 404);
        }
        if (!includeRevoked && authority.row.revoked_at != null) {
            throw new MobileStoreError('client_revoked', 'Device has been revoked', 403);
        }
        return authority;
    }

    _assertExpectedRevision(current, expectedRevision) {
        if (expectedRevision == null) return;
        const expected = Number(expectedRevision);
        if (!Number.isInteger(expected) || expected !== Number(current.syncRevision)) {
            throw new MobileStoreError('revision_conflict', 'File sync configuration revision conflict', 409, {
                details: { expectedRevision: expected, currentRevision: current.syncRevision },
            });
        }
    }

    update(ownerUserId, clientId, patch = {}, {
        expectedRevision,
        actorDeviceId = null,
        mutationReceipt = null,
    } = {}) {
        this._assertLocalFieldsStayLocal(patch);
        const authority = this._requireAuthority(ownerUserId, clientId);
        const before = this._project(authority);
        this._assertExpectedRevision(before, expectedRevision ?? patch.expectedRevision ?? patch.baseRevision);

        const next = {
            ...before,
            deviceName: patch.deviceName === undefined
                ? before.deviceName
                : String(patch.deviceName || '').slice(0, 120),
            enabled: patch.enabled === undefined ? before.enabled : !!patch.enabled,
            automaticEnabled: patch.automaticEnabled === undefined
                ? before.automaticEnabled
                : !!patch.automaticEnabled,
            syncIntervalSec: patch.syncIntervalSec === undefined
                ? before.syncIntervalSec
                : clampInterval(patch.syncIntervalSec),
        };
        if (samePublicConfig(before, next)) return before;

        return this.changeBridge.runMutation({
            entityType: ENTITY_TYPE,
            entityId: before.clientId,
            action: 'upsert',
            user: { userId: before.ownerUserId },
            before,
            after: () => this.read(before.ownerUserId, before.clientId),
            actorDeviceId,
            mutationReceipt,
        }, () => {
            const nextRevision = before.syncRevision + 1;
            if (authority.source === 'mobile') {
                const result = this.db.prepare(`UPDATE mobile_devices SET
                    device_name = ?, enabled = ?, automatic_enabled = ?, sync_interval_sec = ?,
                    config_revision = ?, last_seen_at = ?
                    WHERE owner_user_id = ? AND device_id = ? AND config_revision = ? AND revoked_at IS NULL`).run(
                    next.deviceName, next.enabled ? 1 : 0, next.automaticEnabled ? 1 : 0,
                    next.syncIntervalSec, nextRevision, this.now(), before.ownerUserId,
                    before.clientId, before.syncRevision,
                );
                if (Number(result.changes || 0) !== 1) this._throwConcurrent(before);
            } else {
                const result = this.db.prepare(`UPDATE one_clients SET
                    device_name = ?, enabled = ?, automatic_enabled = ?, sync_interval_sec = ?,
                    config_revision = ?, last_seen_at = ?
                    WHERE owner_user_id = ? AND client_id = ? AND config_revision = ? AND revoked_at IS NULL`).run(
                    next.deviceName, next.enabled ? 1 : 0, next.automaticEnabled ? 1 : 0,
                    next.syncIntervalSec, nextRevision, this.now(), before.ownerUserId,
                    before.clientId, before.syncRevision,
                );
                if (Number(result.changes || 0) !== 1) this._throwConcurrent(before);
            }
            this.reconcileIdentity(before.ownerUserId, before.clientId);
            return this.read(before.ownerUserId, before.clientId);
        });
    }

    _throwConcurrent(before) {
        const current = this.read(before.ownerUserId, before.clientId, { includeRevoked: true });
        throw new MobileStoreError('revision_conflict', 'File sync configuration changed concurrently', 409, {
            details: { expectedRevision: before.syncRevision, currentRevision: current?.syncRevision || 0 },
        });
    }

    setEnabled(ownerUserId, clientId, enabled, options) {
        return this.update(ownerUserId, clientId, { enabled }, options);
    }

    setAutomaticEnabled(ownerUserId, clientId, automaticEnabled, options) {
        return this.update(ownerUserId, clientId, { automaticEnabled }, options);
    }

    setInterval(ownerUserId, clientId, syncIntervalSec, options) {
        return this.update(ownerUserId, clientId, { syncIntervalSec }, options);
    }

    revoke(ownerUserId, clientId, reason = 'revoked_by_user', { expectedRevision } = {}) {
        const authority = this._requireAuthority(ownerUserId, clientId, { includeRevoked: true });
        const before = this._project(authority);
        if (authority.row.revoked_at != null) {
            return { ok: true, clientId: before.clientId, revoked: true, duplicate: true };
        }
        this._assertExpectedRevision(before, expectedRevision);

        this.changeBridge.runMutation({
            entityType: ENTITY_TYPE,
            entityId: before.clientId,
            action: 'delete',
            revision: before.syncRevision + 1,
            user: { userId: before.ownerUserId },
            before,
            after: null,
        }, () => {
            const revokedAt = this.now();
            if (authority.source === 'mobile') {
                const result = this.db.prepare(`UPDATE mobile_devices SET
                    revoked_at = ?, revoke_reason = ?, enabled = 0, automatic_enabled = 0,
                    refresh_token_hash = NULL, refresh_generation = refresh_generation + 1,
                    config_revision = config_revision + 1
                    WHERE owner_user_id = ? AND device_id = ? AND config_revision = ? AND revoked_at IS NULL`).run(
                    revokedAt, String(reason || 'revoked_by_user').slice(0, 200),
                    before.ownerUserId, before.clientId, before.syncRevision,
                );
                if (Number(result.changes || 0) !== 1) this._throwConcurrent(before);
            } else {
                const result = this.db.prepare(`UPDATE one_clients SET
                    revoked_at = ?, revoke_reason = ?, enabled = 0, automatic_enabled = 0,
                    device_token_hash = NULL, config_revision = config_revision + 1
                    WHERE owner_user_id = ? AND client_id = ? AND config_revision = ? AND revoked_at IS NULL`).run(
                    revokedAt, String(reason || 'revoked_by_user').slice(0, 120),
                    before.ownerUserId, before.clientId, before.syncRevision,
                );
                if (Number(result.changes || 0) !== 1) this._throwConcurrent(before);
            }
            this._revokeCompatibilityRow(before.ownerUserId, before.clientId, revokedAt);
            return true;
        });
        return { ok: true, clientId: before.clientId, revoked: true };
    }

    _revokeCompatibilityRow(ownerUserId, clientId, revokedAt) {
        if (!tableExists(this.db, 'one_clients')) return;
        this.db.prepare(`UPDATE one_clients SET
            revoked_at = COALESCE(revoked_at, ?), enabled = 0, automatic_enabled = 0,
            device_token_hash = NULL
            WHERE owner_user_id = ? AND client_id = ?`).run(revokedAt, String(ownerUserId), String(clientId));
    }

    /**
     * Wrap bind/rebind writes so a newly visible config and changed safe fields
     * enter the same transaction as the credential rotation.
     */
    runBindingMutation({ ownerUserId, clientId }, write) {
        const owner = String(ownerUserId || '');
        const id = String(clientId || '');
        const before = this.read(owner, id);
        return this.changeBridge.runMutation({
            entityType: ENTITY_TYPE,
            entityId: id,
            action: 'upsert',
            user: { userId: owner },
            before,
            after: () => this.read(owner, id),
        }, () => {
            const result = write();
            this.reconcileIdentity(owner, id);
            return result;
        });
    }

    /** v1 wins only for an exact same-owner identity; account boundaries win first. */
    reconcileIdentity(ownerUserId, clientId) {
        const mobile = this._mobile(ownerUserId, clientId);
        const legacy = this._legacy(ownerUserId, clientId);
        if (!mobile || !legacy) return this._project(mobile
            ? { source: 'mobile', row: mobile }
            : (legacy ? { source: 'legacy', row: legacy } : null));

        if (mobile.revoked_at != null) {
            this._revokeCompatibilityRow(ownerUserId, clientId, Number(mobile.revoked_at));
        } else if (legacy.revoked_at == null) {
            this.db.prepare(`UPDATE one_clients SET
                device_name = ?, enabled = ?, automatic_enabled = ?, sync_interval_sec = ?,
                config_revision = ?
                WHERE owner_user_id = ? AND client_id = ?`).run(
                String(mobile.device_name || ''), mobile.enabled ? 1 : 0,
                mobile.automatic_enabled ? 1 : 0, clampInterval(mobile.sync_interval_sec),
                revisionOf(mobile), String(ownerUserId), String(clientId),
            );
        }
        return this.read(ownerUserId, clientId, { includeRevoked: true });
    }

    reconcileAll() {
        if (!tableExists(this.db, 'mobile_devices') || !tableExists(this.db, 'one_clients')) return 0;
        const rows = this.db.prepare(`SELECT m.owner_user_id AS ownerUserId, m.device_id AS clientId
            FROM mobile_devices m INNER JOIN one_clients l
              ON l.owner_user_id = m.owner_user_id AND l.client_id = m.device_id`).all();
        for (const row of rows) this.reconcileIdentity(row.ownerUserId, row.clientId);
        return rows.length;
    }
}

module.exports = {
    FileSyncConfigService,
    DEVICE_LOCAL_FIELDS,
    MIN_INTERVAL_SEC,
    MAX_INTERVAL_SEC,
    clampInterval,
};
