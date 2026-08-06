/**
 * one-client-manager.js — Zephyr One client registry + data sync
 *
 * Binding rules (product):
 * - Client must log in as a Zephyr user (password + TOTP when enabled).
 * - Owner must already have at least one File Agent Token on the main server.
 * - Bind links a One device to one token; sync is only allowed for bound, non-revoked devices.
 * - Delete / revoke a One client requires password or TOTP (verifySensitiveAccess).
 * - Token delete / reset-all also go through sensitive verification (enforced at route layer).
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowMs() {
    return Date.now();
}

class OneClientError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

class OneClientManager {
    /**
     * @param {object} opts
     * @param {import('better-sqlite3').Database} opts.db
     * @param {import('./file-agent-manager').FileAgentManager} opts.fileAgentManager
     * @param {object} opts.resourceService
     * @param {object} opts.notesService
     * @param {object} opts.userSettingsService
     * @param {object} opts.storage
     * @param {Function} [opts.log]
     */
    constructor(opts) {
        this.db = opts.db;
        this.fileAgentManager = opts.fileAgentManager;
        this.resourceService = opts.resourceService;
        this.notesService = opts.notesService;
        this.userSettingsService = opts.userSettingsService;
        this.storage = opts.storage;
        this.log = opts.log || console.log;
        this._ensureSchema();
        this.stmtInsert = this.db.prepare(`INSERT INTO one_clients
            (client_id, owner_user_id, owner_username, device_name, platform, app_version,
             token_id, device_token_hash, enabled, sync_interval_sec, last_sync_at, last_seen_at,
             created_at, revoked_at, revoke_reason, device_fingerprint, sync_revision)
            VALUES (@clientId, @ownerUserId, @ownerUsername, @deviceName, @platform, @appVersion,
             @tokenId, @deviceTokenHash, 1, @syncIntervalSec, NULL, @lastSeenAt,
             @createdAt, NULL, NULL, @deviceFingerprint, 0)`);
        this.stmtGet = this.db.prepare('SELECT * FROM one_clients WHERE client_id = ?');
        this.stmtGetByTokenHash = this.db.prepare('SELECT * FROM one_clients WHERE device_token_hash = ? AND revoked_at IS NULL');
        this.stmtListByUser = this.db.prepare('SELECT * FROM one_clients WHERE owner_user_id = ? ORDER BY created_at DESC');
        this.stmtTouch = this.db.prepare('UPDATE one_clients SET last_seen_at = ?, app_version = COALESCE(?, app_version), platform = COALESCE(?, platform), device_name = COALESCE(?, device_name) WHERE client_id = ?');
        this.stmtSetInterval = this.db.prepare('UPDATE one_clients SET sync_interval_sec = ?, last_seen_at = ? WHERE client_id = ? AND revoked_at IS NULL');
        this.stmtMarkSync = this.db.prepare('UPDATE one_clients SET last_sync_at = ?, last_seen_at = ?, sync_revision = sync_revision + 1 WHERE client_id = ?');
        this.stmtRevoke = this.db.prepare('UPDATE one_clients SET revoked_at = ?, revoke_reason = ?, enabled = 0, device_token_hash = NULL WHERE client_id = ? AND owner_user_id = ? AND revoked_at IS NULL');
        this.stmtEnable = this.db.prepare('UPDATE one_clients SET enabled = ?, last_seen_at = ? WHERE client_id = ? AND owner_user_id = ? AND revoked_at IS NULL');
        this.stmtDelete = this.db.prepare('DELETE FROM one_clients WHERE client_id = ? AND owner_user_id = ?');
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS one_clients (
                client_id TEXT PRIMARY KEY,
                owner_user_id TEXT NOT NULL,
                owner_username TEXT NOT NULL,
                device_name TEXT,
                platform TEXT,
                app_version TEXT,
                token_id TEXT NOT NULL,
                device_token_hash TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                sync_interval_sec INTEGER NOT NULL DEFAULT 300,
                last_sync_at INTEGER,
                last_seen_at INTEGER,
                created_at INTEGER NOT NULL,
                revoked_at INTEGER,
                revoke_reason TEXT,
                device_fingerprint TEXT,
                sync_revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_one_clients_owner ON one_clients(owner_user_id);
            CREATE INDEX IF NOT EXISTS idx_one_clients_token_hash ON one_clients(device_token_hash);
        `);
    }

    _rowPublic(row, { includeTokenId = true } = {}) {
        if (!row) return null;
        return {
            clientId: row.client_id,
            ownerUserId: row.owner_user_id,
            ownerUsername: row.owner_username,
            deviceName: row.device_name || '',
            platform: row.platform || '',
            appVersion: row.app_version || '',
            tokenId: includeTokenId ? row.token_id : undefined,
            enabled: !!row.enabled && !row.revoked_at,
            syncIntervalSec: Number(row.sync_interval_sec || 300),
            lastSyncAt: row.last_sync_at ? Number(row.last_sync_at) : null,
            lastSeenAt: row.last_seen_at ? Number(row.last_seen_at) : null,
            createdAt: Number(row.created_at || 0),
            revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
            revokeReason: row.revoke_reason || null,
            syncRevision: Number(row.sync_revision || 0),
            deviceFingerprint: row.device_fingerprint || null,
        };
    }

    listForUser(userId) {
        return this.stmtListByUser.all(userId).map((r) => this._rowPublic(r));
    }

    get(clientId) {
        return this._rowPublic(this.stmtGet.get(clientId));
    }

    /**
     * Bind / re-bind a Zephyr One device after successful user login.
     * Requires an existing File Agent token owned by the user.
     */
    bind(user, {
        clientId,
        deviceName,
        platform,
        appVersion,
        tokenId,
        token,
        syncIntervalSec,
        deviceFingerprint,
    } = {}) {
        if (!user?.userId || !user?.username) throw new OneClientError('unauthorized', '未登录', 401);
        const id = String(clientId || '').trim().slice(0, 80);
        if (!id) throw new OneClientError('invalid_client', 'clientId 不能为空');

        const tokens = this.fileAgentManager.listTokens(user.username, { includeToken: true });
        if (!tokens.length) {
            throw new OneClientError(
                'token_required',
                '请先在主端设置 → Zephyr Client 中新增 Token，再绑定 Zephyr One',
                400,
            );
        }

        let tokenRecord = null;
        if (tokenId) {
            tokenRecord = tokens.find((t) => t.id === tokenId) || null;
        }
        if (!tokenRecord && token) {
            tokenRecord = tokens.find((t) => t.token === String(token).trim()) || null;
        }
        if (!tokenRecord) {
            // Allow binding by token id without includeToken if only id known from list endpoint
            const listed = this.fileAgentManager.listTokens(user.username);
            if (tokenId) tokenRecord = listed.find((t) => t.id === tokenId) || null;
        }
        if (!tokenRecord) {
            throw new OneClientError('token_not_found', 'Token 不存在或不属于当前用户', 404);
        }

        const interval = clampInterval(syncIntervalSec);
        const existing = this.stmtGet.get(id);
        const deviceToken = crypto.randomBytes(32).toString('base64url');
        const deviceTokenHash = sha256(deviceToken);
        const ts = nowMs();

        if (existing) {
            if (existing.owner_user_id !== user.userId) {
                throw new OneClientError('client_owned_by_other', 'clientId 已被其他账号绑定', 409);
            }
            this.db.prepare(`UPDATE one_clients SET
                device_name = ?, platform = ?, app_version = ?, token_id = ?,
                device_token_hash = ?, enabled = 1, sync_interval_sec = ?,
                last_seen_at = ?, revoked_at = NULL, revoke_reason = NULL,
                device_fingerprint = COALESCE(?, device_fingerprint)
                WHERE client_id = ?`).run(
                String(deviceName || existing.device_name || 'Zephyr One').slice(0, 120),
                String(platform || existing.platform || '').slice(0, 40),
                String(appVersion || existing.app_version || '').slice(0, 40),
                tokenRecord.id,
                deviceTokenHash,
                interval,
                ts,
                deviceFingerprint ? String(deviceFingerprint).slice(0, 200) : null,
                id,
            );
        } else {
            this.stmtInsert.run({
                clientId: id,
                ownerUserId: user.userId,
                ownerUsername: user.username,
                deviceName: String(deviceName || 'Zephyr One').slice(0, 120),
                platform: String(platform || '').slice(0, 40),
                appVersion: String(appVersion || '').slice(0, 40),
                tokenId: tokenRecord.id,
                deviceTokenHash,
                syncIntervalSec: interval,
                lastSeenAt: ts,
                createdAt: ts,
                deviceFingerprint: deviceFingerprint ? String(deviceFingerprint).slice(0, 200) : null,
            });
        }

        const row = this.stmtGet.get(id);
        return {
            client: this._rowPublic(row),
            deviceToken,
            // Convenience: return token metadata (not secret unless just created flow)
            token: {
                id: tokenRecord.id,
                name: tokenRecord.name,
            },
        };
    }

    resolveDeviceToken(deviceToken) {
        const raw = String(deviceToken || '').trim();
        if (!raw) return null;
        const row = this.stmtGetByTokenHash.get(sha256(raw));
        if (!row || row.revoked_at || !row.enabled) return null;
        return row;
    }

    requireLiveClient(row) {
        if (!row) throw new OneClientError('client_not_found', '客户端不存在', 404);
        if (row.revoked_at) throw new OneClientError('client_revoked', '客户端已被主端删除/吊销', 403);
        if (!row.enabled) throw new OneClientError('client_disabled', '客户端同步已禁用', 403);
        // Token must still exist on main server
        const tokens = this.fileAgentManager.listTokens(row.owner_username);
        if (!tokens.some((t) => t.id === row.token_id)) {
            throw new OneClientError('token_missing', '关联 Token 已删除，请重新绑定', 403);
        }
        return row;
    }

    updateInterval(userId, clientId, syncIntervalSec) {
        const row = this.stmtGet.get(clientId);
        if (!row || row.owner_user_id !== userId) throw new OneClientError('client_not_found', '客户端不存在', 404);
        if (row.revoked_at) throw new OneClientError('client_revoked', '客户端已吊销', 403);
        const interval = clampInterval(syncIntervalSec);
        this.stmtSetInterval.run(interval, nowMs(), clientId);
        return this.get(clientId);
    }

    setEnabled(userId, clientId, enabled) {
        const row = this.stmtGet.get(clientId);
        if (!row || row.owner_user_id !== userId) throw new OneClientError('client_not_found', '客户端不存在', 404);
        if (row.revoked_at) throw new OneClientError('client_revoked', '客户端已吊销', 403);
        this.stmtEnable.run(enabled ? 1 : 0, nowMs(), clientId, userId);
        return this.get(clientId);
    }

    /**
     * Delete / revoke a One client — caller must already pass verifySensitiveAccess.
     */
    revoke(userId, clientId, reason = 'revoked_by_user') {
        const row = this.stmtGet.get(clientId);
        if (!row || row.owner_user_id !== userId) throw new OneClientError('client_not_found', '客户端不存在', 404);
        this.stmtRevoke.run(nowMs(), String(reason || 'revoked_by_user').slice(0, 120), clientId, userId);
        // Hard delete row after revoke so list stays clean; keep revoke semantics via response.
        this.stmtDelete.run(clientId, userId);
        return { ok: true, clientId, revoked: true };
    }

    /**
     * Build a user-scoped sync snapshot for Zephyr One.
     * Secrets for owned resources are included (client is authenticated as owner).
     */
    buildSnapshot(user, clientRow) {
        this.requireLiveClient(clientRow);
        const connections = this.resourceService.listConnections(user).map((pub) => {
            try {
                if (pub.owner === 'own') {
                    const full = this.resourceService.getConnection(user, pub.id, { reveal: true });
                    return {
                        ...pub,
                        password: full.password || '',
                        privateKey: full.privateKey || '',
                        secretsIncluded: true,
                    };
                }
            } catch {
                /* fall through to public */
            }
            return { ...pub, secretsIncluded: false };
        });

        let notes = { notes: [], total: 0 };
        try {
            notes = this.notesService.list(user, { limit: 500, offset: 0 });
            // list may omit content; fetch full for owned notes
            notes = {
                ...notes,
                notes: (notes.notes || []).map((n) => {
                    try {
                        return this.notesService.get
                            ? this.notesService.get(user, n.noteId)
                            : n;
                    } catch {
                        return n;
                    }
                }),
            };
        } catch (err) {
            this.log('[one-client] notes snapshot failed:', err.message);
        }

        // Prefer get() if available
        if (typeof this.notesService.get === 'function') {
            notes.notes = (notes.notes || []).map((n) => {
                try {
                    return this.notesService.get(user, n.noteId || n.id);
                } catch {
                    return n;
                }
            });
        }

        const proxies = safeList(() => this.resourceService.listOwned(user, 'proxy'));
        const sshKeys = safeList(() => this.resourceService.listOwned(user, 'sshKey')).map((k) => ({
            ...k,
            // listOwned usually masks private key; try reveal-like open is not available here
            privateKey: k.privateKey && k.privateKey !== '******' ? k.privateKey : '',
            hasPrivateKey: !!(k.hasPrivateKey || k.privateKey),
        }));
        // Attempt raw key reveal for owned keys
        const sshKeysFull = sshKeys.map((k) => {
            try {
                const raw = this.storage.getSshKeyRaw?.(k.id);
                if (raw && raw.ownerUserId === user.userId) {
                    return {
                        ...k,
                        privateKey: raw.privateKey || '',
                        passphrase: raw.passphrase || '',
                        secretsIncluded: true,
                    };
                }
            } catch {
                /* ignore */
            }
            return { ...k, secretsIncluded: false };
        });

        const jumpHosts = safeList(() => this.resourceService.listOwned(user, 'jumpHost'));
        const settings = this.userSettingsService.effective(user);
        const tokens = this.fileAgentManager.listTokens(user.username); // no secrets

        this.stmtMarkSync.run(nowMs(), nowMs(), clientRow.client_id);
        const refreshed = this.stmtGet.get(clientRow.client_id);

        return {
            ok: true,
            generatedAt: nowMs(),
            revision: Number(refreshed?.sync_revision || 0),
            client: this._rowPublic(refreshed),
            user: {
                userId: user.userId,
                username: user.username,
                role: user.role,
                email: user.email || '',
                totpEnabled: !!user.totpEnabled,
            },
            data: {
                connections,
                proxies,
                sshKeys: sshKeysFull,
                jumpHosts,
                notes: notes.notes || [],
                notesMeta: { total: notes.total || (notes.notes || []).length },
                settings,
                agentTokens: tokens,
            },
        };
    }

    mountRoutes(app, { requireUser, getSessionUser, verifySensitiveAccess, resolveUserById, resolveUserByUsername }) {
        const sendErr = (res, err) => {
            const status = err.status || (err.code === 'not_found' ? 404 : 400);
            res.status(status).json({ ok: false, error: { code: err.code || 'error', message: err.message } });
        };

        // Middleware: session user OR One device token
        const requireOneAuth = (req, res, next) => {
            // Prefer existing session
            if (req.user?.userId) {
                req.oneAuth = { type: 'session', user: req.user };
                return next();
            }
            const header = String(req.headers.authorization || '');
            const m = header.match(/^Bearer\s+(.+)$/i);
            const bodyToken = req.body?.deviceToken || req.headers['x-zephyr-one-token'];
            const deviceToken = (m && m[1]) || bodyToken;
            if (deviceToken) {
                const row = this.resolveDeviceToken(deviceToken);
                if (row) {
                    try {
                        this.requireLiveClient(row);
                        const user = resolveUserById(row.owner_user_id) || resolveUserByUsername(row.owner_username);
                        if (!user || user.status === 'suspended' || user.status === 'deleted') {
                            return res.status(403).json({ ok: false, error: { code: 'account_unavailable', message: '账号不可用' } });
                        }
                        req.oneAuth = { type: 'device', user, clientRow: row, deviceToken };
                        req.user = {
                            userId: user.userId,
                            username: user.username,
                            role: user.role,
                            isSuperAdmin: !!user.isSuperAdmin,
                        };
                        return next();
                    } catch (err) {
                        return sendErr(res, err);
                    }
                }
            }
            // Fall back to requireUser for session-only routes
            return requireUser(req, res, () => {
                req.oneAuth = { type: 'session', user: req.user };
                next();
            });
        };

        // GET /api/one/clients — list bound One devices for current user (web settings)
        app.get('/api/one/clients', requireUser, (req, res) => {
            res.json({ ok: true, clients: this.listForUser(req.user.userId) });
        });

        // POST /api/one/clients/bind — login session required
        app.post('/api/one/clients/bind', requireUser, (req, res) => {
            try {
                const result = this.bind(req.user, req.body || {});
                res.json({ ok: true, ...result });
            } catch (err) {
                sendErr(res, err);
            }
        });

        // PATCH /api/one/clients/:clientId — interval / enable (session owner)
        app.patch('/api/one/clients/:clientId', requireUser, (req, res) => {
            try {
                const body = req.body || {};
                let client;
                if (body.syncIntervalSec != null) {
                    client = this.updateInterval(req.user.userId, req.params.clientId, body.syncIntervalSec);
                }
                if (body.enabled != null) {
                    client = this.setEnabled(req.user.userId, req.params.clientId, !!body.enabled);
                }
                if (!client) client = this.get(req.params.clientId);
                if (!client || client.ownerUserId !== req.user.userId) {
                    throw new OneClientError('client_not_found', '客户端不存在', 404);
                }
                res.json({ ok: true, client });
            } catch (err) {
                sendErr(res, err);
            }
        });

        // DELETE /api/one/clients/:clientId — requires password or TOTP
        app.delete('/api/one/clients/:clientId', requireUser, (req, res) => {
            try {
                if (!verifySensitiveAccess) throw new OneClientError('unsupported', '敏感验证不可用', 500);
                verifySensitiveAccess(req, req.body?.secret ?? req.query?.secret);
                const out = this.revoke(req.user.userId, req.params.clientId, req.body?.reason || 'deleted_from_settings');
                res.json({ ok: true, ...out });
            } catch (err) {
                sendErr(res, err);
            }
        });

        // POST /api/one/clients/:clientId/revoke — alias with JSON body secret
        app.post('/api/one/clients/:clientId/revoke', requireUser, (req, res) => {
            try {
                if (!verifySensitiveAccess) throw new OneClientError('unsupported', '敏感验证不可用', 500);
                verifySensitiveAccess(req, req.body?.secret);
                const out = this.revoke(req.user.userId, req.params.clientId, req.body?.reason || 'revoked_from_settings');
                res.json({ ok: true, ...out });
            } catch (err) {
                sendErr(res, err);
            }
        });

        // POST /api/one/sync/pull — device token or session + clientId
        app.post('/api/one/sync/pull', requireOneAuth, (req, res) => {
            try {
                let clientRow = req.oneAuth.clientRow || null;
                const clientId = req.body?.clientId || clientRow?.client_id;
                if (!clientRow) {
                    clientRow = this.stmtGet.get(clientId);
                    if (!clientRow || clientRow.owner_user_id !== req.user.userId) {
                        throw new OneClientError('client_not_found', '客户端未绑定', 404);
                    }
                }
                if (req.body?.syncIntervalSec != null) {
                    this.updateInterval(req.user.userId, clientRow.client_id, req.body.syncIntervalSec);
                    clientRow = this.stmtGet.get(clientRow.client_id);
                }
                this.stmtTouch.run(
                    nowMs(),
                    req.body?.appVersion || null,
                    req.body?.platform || null,
                    req.body?.deviceName || null,
                    clientRow.client_id,
                );
                const user = resolveUserById(req.user.userId) || resolveUserByUsername(req.user.username);
                const snapshot = this.buildSnapshot(user, this.stmtGet.get(clientRow.client_id));
                res.json(snapshot);
            } catch (err) {
                sendErr(res, err);
            }
        });

        // GET /api/one/sync/status
        app.get('/api/one/sync/status', requireOneAuth, (req, res) => {
            try {
                const clientId = req.query.clientId || req.oneAuth.clientRow?.client_id;
                const row = this.stmtGet.get(clientId);
                if (!row || row.owner_user_id !== req.user.userId) {
                    throw new OneClientError('client_not_found', '客户端未绑定', 404);
                }
                const tokens = this.fileAgentManager.listTokens(req.user.username);
                res.json({
                    ok: true,
                    client: this._rowPublic(row),
                    hasAgentToken: tokens.length > 0,
                    tokenLinked: tokens.some((t) => t.id === row.token_id),
                });
            } catch (err) {
                sendErr(res, err);
            }
        });
    }
}

function clampInterval(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return 300;
    // 30s – 24h
    return Math.max(30, Math.min(86400, Math.floor(n)));
}

function safeList(fn) {
    try {
        const v = fn();
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

module.exports = { OneClientManager, OneClientError };
