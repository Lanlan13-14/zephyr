const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getAppVersion } = require('./version');
const { DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION, DEFAULT_ZEPHYR_SYSTEM_PROMPT, cloneDefaultZephyrSkills } = require('./ai-defaults');
const secretCrypto = require('./secret-crypto');

const DATA_DIR = process.env.ZEPHYR_DATA_DIR ? path.resolve(process.env.ZEPHYR_DATA_DIR) : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'zephyr.db');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

let db;
const APP_VERSION = getAppVersion();

function now() { return Date.now(); }
function json(value, fallback) { try { return JSON.parse(value || ''); } catch { return fallback; } }
function readJSONFile(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function secretAad(scope, id, field) { return `${scope}:${id || 'global'}:${field}`; }
function encryptSecretField(value, scope, id, field) { return secretCrypto.encryptSecret(value, secretAad(scope, id, field)); }
function decryptSecretField(value, scope, id, field) { return secretCrypto.decryptSecret(value, secretAad(scope, id, field)); }
function hasSecretValue(value) { return Boolean(value); }

function decryptConnection(row) {
    if (!row) return null;
    return {
        ...row,
        password: decryptSecretField(row.password || '', 'connection', row.id, 'password'),
        privateKey: decryptSecretField(row.privateKey || '', 'connection', row.id, 'privateKey'),
    };
}

function encryptConnection(row) {
    if (!row) return row;
    return {
        ...row,
        password: encryptSecretField(row.password || '', 'connection', row.id, 'password'),
        privateKey: encryptSecretField(row.privateKey || '', 'connection', row.id, 'privateKey'),
    };
}

function decryptProxy(row) {
    if (!row) return null;
    return { ...row, password: decryptSecretField(row.password || '', 'proxy', row.id, 'password') };
}

function encryptProxy(row) {
    if (!row) return row;
    return { ...row, password: encryptSecretField(row.password || '', 'proxy', row.id, 'password') };
}

function decryptSshKey(row) {
    if (!row) return null;
    return {
        ...row,
        privateKey: decryptSecretField(row.privateKey || '', 'sshKey', row.id, 'privateKey'),
        passphrase: decryptSecretField(row.passphrase || '', 'sshKey', row.id, 'passphrase'),
    };
}

function encryptSshKey(row) {
    if (!row) return row;
    return {
        ...row,
        privateKey: encryptSecretField(row.privateKey || '', 'sshKey', row.id, 'privateKey'),
        passphrase: encryptSecretField(row.passphrase || '', 'sshKey', row.id, 'passphrase'),
    };
}

function decryptUser(row) {
    if (!row) return null;
    return { ...row, totpSecret: decryptSecretField(row.totpSecret || '', 'user', row.username, 'totpSecret') || null };
}

function encryptUser(row) {
    if (!row) return row;
    return { ...row, totpSecret: encryptSecretField(row.totpSecret || '', 'user', row.username, 'totpSecret') || null };
}

function cloneSettingsValue(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
}

function decryptSettingsValue(key, value) {
    const copy = cloneSettingsValue(value);
    if (typeof copy !== 'object' || copy === null) return copy;
    if (key === 'mail' && copy.pass) copy.pass = decryptSecretField(copy.pass, 'settings', 'mail', 'pass');
    if (key === 'captcha') {
        ['secretKey', 'tencentAppSecretKey', 'tencentSecretKey', 'aliyunAccessKeySecret'].forEach((field) => {
            if (copy[field]) copy[field] = decryptSecretField(copy[field], 'settings', 'captcha', field);
        });
    }
    if (key === 'ai' && Array.isArray(copy.providers)) {
        copy.providers = copy.providers.map((provider) => ({
            ...provider,
            apiKey: provider?.apiKey ? decryptSecretField(provider.apiKey, 'settings', 'ai', `provider:${provider.id || provider.name || 'default'}:apiKey`) : '',
        }));
    }
    if (key === 'ai' && Array.isArray(copy.envVars)) {
        copy.envVars = copy.envVars.map((envVar) => ({
            ...envVar,
            value: envVar?.value ? decryptSecretField(envVar.value, 'settings', 'ai', `env:${envVar.id || envVar.name || 'default'}:value`) : '',
        }));
    }
    return copy;
}

function encryptSettingsValue(key, value) {
    const copy = cloneSettingsValue(value);
    if (typeof copy !== 'object' || copy === null) return copy;
    if (key === 'mail' && copy.pass) copy.pass = encryptSecretField(copy.pass, 'settings', 'mail', 'pass');
    if (key === 'captcha') {
        ['secretKey', 'tencentAppSecretKey', 'tencentSecretKey', 'aliyunAccessKeySecret'].forEach((field) => {
            if (copy[field]) copy[field] = encryptSecretField(copy[field], 'settings', 'captcha', field);
        });
    }
    if (key === 'ai' && Array.isArray(copy.providers)) {
        copy.providers = copy.providers.map((provider) => ({
            ...provider,
            apiKey: provider?.apiKey ? encryptSecretField(provider.apiKey, 'settings', 'ai', `provider:${provider.id || provider.name || 'default'}:apiKey`) : '',
        }));
    }
    if (key === 'ai' && Array.isArray(copy.envVars)) {
        copy.envVars = copy.envVars.map((envVar) => ({
            ...envVar,
            value: envVar?.value ? encryptSecretField(envVar.value, 'settings', 'ai', `env:${envVar.id || envVar.name || 'default'}:value`) : '',
        }));
    }
    return copy;
}

function rowToConnection(row) {
    if (!row) return null;
    const plain = decryptConnection(row);
    return { ...plain, port: Number(plain.port) || 22, revision: Math.max(1, Number(plain.revision) || 1), tags: json(plain.tags, []), jumpHostIds: json(plain.jumpHostIds, plain.jumpHostId ? [plain.jumpHostId] : []), sshKeyId: plain.sshKeyId || '', lastConnectedAt: plain.lastConnectedAt || null, rdpSoundMode: plain.rdpSoundMode || 'local', rdpClipboard: plain.rdpClipboard === 0 ? false : true, rdpMicrophone: !!plain.rdpMicrophone, rdpCamera: !!plain.rdpCamera, rdpStorage: !!plain.rdpStorage, rdpLocation: !!plain.rdpLocation, rdpResolution: plain.rdpResolution || '1080p', rdpQuality: plain.rdpQuality || 'balanced', rdpFps: Number(plain.rdpFps) || 30, rdpPipeline: 'worker-gpu-v2', rdpTouchMode: plain.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(plain.rdpTouchSensitivity) || 1.5)), rdpDomain: plain.rdpDomain || '', ephemeral: !!plain.ephemeral, encoding: plain.encoding || 'utf-8' };
}

function rowToSshKey(row, { includeSecret = false } = {}) {
    if (!row) return null;
    const plain = decryptSshKey(row);
    const out = { ...plain, revision: Math.max(1, Number(plain.revision) || 1), hasPrivateKey: hasSecretValue(plain.privateKey), hasPassphrase: hasSecretValue(plain.passphrase), privateKey: plain.privateKey ? '******' : '', passphrase: plain.passphrase ? '******' : '' };
    if (includeSecret) {
        out.privateKey = plain.privateKey || '';
        out.passphrase = plain.passphrase || '';
    }
    return out;
}

function rowToProxy(row) {
    if (!row) return null;
    const plain = decryptProxy(row);
    return { ...plain, type: plain.type || 'socks5', port: Number(plain.port) || 1080, revision: Math.max(1, Number(plain.revision) || 1), hasPassword: hasSecretValue(plain.password), password: plain.password ? '******' : '' };
}

function rowToJumpHost(row) { return row ? { ...row, revision: Math.max(1, Number(row.revision) || 1) } : null; }

function columnExists(table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === column);
}

function addColumnIfMissing(table, column, definition) {
    if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function defaultSettings(legacySettings = {}) {
    return {
        version: APP_VERSION,
        security: {
            ipWhitelistEnabled: false,
            ipWhitelist: '',
            bruteForceEnabled: true,
            bruteForceMaxFailures: 5,
            bruteForceBanMinutes: 15,
        },
        captcha: { enabled: false, provider: 'turnstile', siteKey: '', secretKey: '', tencentCaptchaAppId: '', tencentAppSecretKey: '' },
        mail: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', adminEmail: '', notifyLoginSuccess: true, notifyLoginFailure: true, notifyLoginToUser: true, geoLookupEnabled: true },
        beian: { show: legacySettings.showBeian !== false, icp: legacySettings.icp || '', policeBeian: legacySettings.policeBeian || '', policeBeianUrl: legacySettings.policeBeianUrl || 'https://www.beian.gov.cn/portal/registerSystemInfo' },
        dataManage: { exportEncryptHint: true },
        appearance: {
            brandName: 'Zephyr',
            brandIcon: '🌬️',
            theme: 'auto',
            autoThemeEnabled: true,
            colorScheme: 'frost',
            customThemeMode: 'dark',
            customColors: {},
            customCss: '',
            customJs: '',
            terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35, blur: 0 },
            terminalFontColor: '',
        },
        terminal: {
            maxWindows: 3,
            minimizedKeepAlive: 0,
            smartbarOrder: 'old-first',
            shortcutPlatform: 'auto',
            allowLigatures: false,
        },
        ai: {
            enabled: false,
            assistantName: 'Zephyr AI',
            defaultProviderId: '',
            defaultModel: '',
            systemPrompt: '',
            defaultSystemPrompt: DEFAULT_ZEPHYR_SYSTEM_PROMPT,
            guidanceVersion: DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION,
            codeCompletionEnabled: true,
            context: { windowTokens: 64000, maxInputChars: 90000, keepMessages: 18, toolResultChars: 30000, memoryItems: 16, maxToolRounds: 0 },
            sensitive: { requireConfirmation: true, autoConfirm: false, autoConfirmDelayMs: 2500 },
            permissions: { webSearch: true, webFetch: true, browser: true, remoteExecute: true, fileRead: true, fileWrite: true, codeEdit: true, memory: true, env: true },
            planner: { enabled: true, requirePlanBeforeTools: false },
            memory: { enabled: true, maxItems: 500 },
            providers: [],
            skills: cloneDefaultZephyrSkills(),
            envVars: [],
        },
        icp: legacySettings.icp || '',
        policeBeian: legacySettings.policeBeian || '',
        policeBeianUrl: legacySettings.policeBeianUrl || 'https://www.beian.gov.cn/portal/registerSystemInfo',
        showBeian: legacySettings.showBeian !== false,
    };
}

function init({ hashPassword }) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    db.pragma('secure_delete = ON');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            passwordHash TEXT NOT NULL,
            defaultPassword INTEGER DEFAULT 0,
            createdAt INTEGER,
            updatedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER DEFAULT 22,
            protocol TEXT DEFAULT 'SSH',
            username TEXT,
            password TEXT,
            privateKey TEXT,
            remark TEXT,
            tags TEXT DEFAULT '[]',
            connectionMode TEXT DEFAULT 'direct',
            proxyId TEXT,
            jumpHostId TEXT,
            jumpHostIds TEXT DEFAULT '[]',
            sshKeyId TEXT,
            createdAt INTEGER,
            updatedAt INTEGER,
            revision INTEGER DEFAULT 1,
            lastConnectedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS ssh_keys (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            privateKey TEXT NOT NULL,
            passphrase TEXT,
            remark TEXT,
            createdAt INTEGER,
            updatedAt INTEGER,
            revision INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS activities (
            id TEXT PRIMARY KEY,
            time INTEGER NOT NULL,
            message TEXT NOT NULL,
            type TEXT DEFAULT 'info'
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS proxies (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            type TEXT DEFAULT 'socks5',
            username TEXT,
            password TEXT,
            createdAt INTEGER,
            updatedAt INTEGER,
            revision INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS jump_hosts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            connectionId TEXT NOT NULL,
            createdAt INTEGER,
            updatedAt INTEGER,
            revision INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS passkeys (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            credentialId TEXT NOT NULL UNIQUE,
            publicKey TEXT NOT NULL,
            counter INTEGER DEFAULT 0,
            transports TEXT DEFAULT '[]',
            createdAt INTEGER,
            lastUsedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS login_events (
            id TEXT PRIMARY KEY,
            username TEXT,
            ip TEXT,
            region TEXT,
            userAgent TEXT,
            success INTEGER,
            reason TEXT,
            time INTEGER
        );
        CREATE TABLE IF NOT EXISTS ip_bans (
            ip TEXT PRIMARY KEY,
            failedCount INTEGER DEFAULT 0,
            bannedUntil INTEGER,
            updatedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS password_reset_codes (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            email TEXT NOT NULL,
            codeHash TEXT NOT NULL,
            expiresAt INTEGER NOT NULL,
            used INTEGER DEFAULT 0,
            createdAt INTEGER,
            attemptCount INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            idle_expires_at INTEGER NOT NULL,
            absolute_expires_at INTEGER NOT NULL,
            remember INTEGER NOT NULL DEFAULT 0,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            revoked_at INTEGER,
            revoke_reason TEXT,
            user_agent_hash TEXT,
            ip_prefix TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(idle_expires_at, absolute_expires_at);
        CREATE TABLE IF NOT EXISTS resource_acl (
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            subject_type TEXT NOT NULL DEFAULT 'user',
            subject_id TEXT NOT NULL,
            capabilities_json TEXT NOT NULL,
            granted_by_user_id TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            expires_at INTEGER,
            revoked_at INTEGER,
            PRIMARY KEY (resource_type, resource_id, subject_type, subject_id)
        );
        CREATE INDEX IF NOT EXISTS idx_resource_acl_subject ON resource_acl(subject_type, subject_id, revoked_at, expires_at);
        CREATE INDEX IF NOT EXISTS idx_resource_acl_resource ON resource_acl(resource_type, resource_id, revoked_at);
        CREATE TABLE IF NOT EXISTS audit_events (
            event_id TEXT PRIMARY KEY,
            actor_user_id TEXT,
            target_user_id TEXT,
            resource_type TEXT,
            resource_id TEXT,
            action TEXT NOT NULL,
            outcome TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON audit_events(actor_user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS workspaces (
            workspace_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            name TEXT NOT NULL,
            state_json TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, client_id, workspace_id)
        );
        CREATE INDEX IF NOT EXISTS idx_workspaces_user_client ON workspaces(user_id, client_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, key)
        );
        CREATE TABLE IF NOT EXISTS notes (
            note_id TEXT PRIMARY KEY,
            owner_user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL DEFAULT '',
            group_path TEXT NOT NULL DEFAULT '',
            tags_json TEXT NOT NULL DEFAULT '[]',
            linked_connection_ids_json TEXT NOT NULL DEFAULT '[]',
            sort_order REAL,
            revision INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted_at INTEGER,
            visibility TEXT NOT NULL DEFAULT 'private',
            share_with_users INTEGER NOT NULL DEFAULT 0,
            share_with_admins INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notes_owner_updated ON notes(owner_user_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_owner_group ON notes(owner_user_id, group_path);
        CREATE INDEX IF NOT EXISTS idx_notes_visibility ON notes(owner_user_id, visibility);
        CREATE TABLE IF NOT EXISTS deeplink_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            source TEXT NOT NULL,
            draft_json TEXT NOT NULL,
            credential_enc TEXT,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_deeplink_tokens_user ON deeplink_tokens(user_id, expires_at);
    `);

    addColumnIfMissing('users', 'email', 'TEXT');
    addColumnIfMissing('users', 'totpEnabled', 'INTEGER DEFAULT 0');
    addColumnIfMissing('users', 'totpSecret', 'TEXT');
    addColumnIfMissing('users', 'failedLoginCount', 'INTEGER DEFAULT 0');
    addColumnIfMissing('users', 'lockedUntil', 'INTEGER');
    // Multi-user identity (FREEZE plan §11, §18.1): immutable userId + role + status.
    addColumnIfMissing('users', 'userId', 'TEXT');
    addColumnIfMissing('users', 'role', 'TEXT');
    addColumnIfMissing('users', 'status', 'TEXT');
    addColumnIfMissing('passkeys', 'userId', 'TEXT');
    addColumnIfMissing('password_reset_codes', 'userId', 'TEXT');
    addColumnIfMissing('password_reset_codes', 'attemptCount', 'INTEGER DEFAULT 0');
    // Resource ownership (FREEZE plan §12.1, §18.3)
    addColumnIfMissing('connections', 'ownerUserId', 'TEXT');
    addColumnIfMissing('connections', 'visibility', 'TEXT');
    addColumnIfMissing('connections', 'createdByUserId', 'TEXT');
    addColumnIfMissing('proxies', 'ownerUserId', 'TEXT');
    addColumnIfMissing('proxies', 'visibility', 'TEXT');
    addColumnIfMissing('proxies', 'createdByUserId', 'TEXT');
    addColumnIfMissing('ssh_keys', 'ownerUserId', 'TEXT');
    addColumnIfMissing('ssh_keys', 'visibility', 'TEXT');
    addColumnIfMissing('ssh_keys', 'createdByUserId', 'TEXT');
    addColumnIfMissing('jump_hosts', 'ownerUserId', 'TEXT');
    addColumnIfMissing('jump_hosts', 'visibility', 'TEXT');
    addColumnIfMissing('jump_hosts', 'createdByUserId', 'TEXT');
    addColumnIfMissing('users', 'lastLoginAt', 'INTEGER');
    addColumnIfMissing('activities', 'userId', 'TEXT');
    addColumnIfMissing('users', 'isSuperAdmin', 'INTEGER DEFAULT 0');
    addColumnIfMissing('notes', 'visibility', "TEXT NOT NULL DEFAULT 'private'");
    addColumnIfMissing('notes', 'share_with_users', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('notes', 'share_with_admins', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('connections', 'jumpHostIds', "TEXT DEFAULT '[]'");
    addColumnIfMissing('connections', 'sshKeyId', 'TEXT');
    addColumnIfMissing('connections', 'rdpSoundMode', "TEXT DEFAULT 'local'");
    addColumnIfMissing('connections', 'rdpClipboard', 'INTEGER DEFAULT 1');
    addColumnIfMissing('connections', 'rdpMicrophone', 'INTEGER DEFAULT 0');
    addColumnIfMissing('connections', 'rdpCamera', 'INTEGER DEFAULT 0');
    addColumnIfMissing('connections', 'rdpStorage', 'INTEGER DEFAULT 0');
    addColumnIfMissing('connections', 'rdpLocation', 'INTEGER DEFAULT 0');
    addColumnIfMissing('connections', 'rdpResolution', "TEXT DEFAULT '1080p'");
    addColumnIfMissing('connections', 'rdpQuality', "TEXT DEFAULT 'balanced'");
    addColumnIfMissing('connections', 'rdpFps', 'INTEGER DEFAULT 30');
    addColumnIfMissing('connections', 'rdpPipeline', "TEXT DEFAULT 'worker-gpu-v2'");
    const pipelineColumn = db.prepare("PRAGMA table_info(connections)").all().find((column) => column.name === 'rdpPipeline');
    if (pipelineColumn && String(pipelineColumn.dflt_value || '').replaceAll("'", '') !== 'worker-gpu-v2') {
        db.exec("ALTER TABLE connections RENAME COLUMN rdpPipeline TO rdpPipelineLegacyDefault");
        db.exec("ALTER TABLE connections ADD COLUMN rdpPipeline TEXT DEFAULT 'worker-gpu-v2'");
        db.exec("UPDATE connections SET rdpPipeline='worker-gpu-v2'");
        db.exec("ALTER TABLE connections DROP COLUMN rdpPipelineLegacyDefault");
    }
    db.prepare("UPDATE connections SET rdpPipeline='worker-gpu-v2' WHERE rdpPipeline IS NULL OR rdpPipeline='' OR rdpPipeline='legacy'").run();
    addColumnIfMissing('connections', 'rdpTouchMode', "TEXT DEFAULT 'direct'");
    addColumnIfMissing('connections', 'rdpTouchSensitivity', 'REAL DEFAULT 1.5');
    addColumnIfMissing('connections', 'rdpDomain', "TEXT DEFAULT ''");
    /* One-shot "临时连接": saved only for the active tab lifetime, then deleted. */
    addColumnIfMissing('connections', 'ephemeral', 'INTEGER DEFAULT 0');
    addColumnIfMissing('connections', 'encoding', "TEXT DEFAULT 'utf-8'");
    addColumnIfMissing('connections', 'revision', 'INTEGER DEFAULT 1');
    db.prepare('UPDATE connections SET revision=1 WHERE revision IS NULL OR revision < 1').run();
    addColumnIfMissing('proxies', 'type', "TEXT DEFAULT 'socks5'");
    addColumnIfMissing('proxies', 'revision', 'INTEGER DEFAULT 1');
    db.prepare('UPDATE proxies SET revision=1 WHERE revision IS NULL OR revision < 1').run();
    addColumnIfMissing('ssh_keys', 'revision', 'INTEGER DEFAULT 1');
    db.prepare('UPDATE ssh_keys SET revision=1 WHERE revision IS NULL OR revision < 1').run();
    addColumnIfMissing('jump_hosts', 'revision', 'INTEGER DEFAULT 1');
    db.prepare('UPDATE jump_hosts SET revision=1 WHERE revision IS NULL OR revision < 1').run();
    secretCrypto.ensureKeyPair();

    if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
        const legacy = readJSONFile(USERS_FILE, { users: [] });
        const users = legacy.users?.length ? legacy.users : [{ username: 'admin', passwordHash: hashPassword('admin'), defaultPassword: true, createdAt: now() }];
        const stmt = db.prepare('INSERT OR REPLACE INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt) VALUES (@username,@passwordHash,@defaultPassword,@createdAt,@updatedAt)');
        users.forEach((u) => stmt.run({ username: u.username, passwordHash: u.passwordHash, defaultPassword: u.defaultPassword ? 1 : 0, createdAt: u.createdAt || now(), updatedAt: u.updatedAt || null }));
    }
    if (db.prepare('SELECT COUNT(*) AS c FROM connections').get().c === 0) {
        const legacy = readJSONFile(CONNECTIONS_FILE, { connections: [], activities: [] });
        const cstmt = db.prepare(`INSERT OR REPLACE INTO connections (id,name,host,port,protocol,username,password,privateKey,remark,tags,connectionMode,proxyId,jumpHostId,jumpHostIds,sshKeyId,createdAt,updatedAt,revision,lastConnectedAt)
            VALUES (@id,@name,@host,@port,@protocol,@username,@password,@privateKey,@remark,@tags,@connectionMode,@proxyId,@jumpHostId,@jumpHostIds,@sshKeyId,@createdAt,@updatedAt,@revision,@lastConnectedAt)`);
        (legacy.connections || []).forEach((c) => { const safe = encryptConnection({ id: c.id, name: c.name, host: c.host, port: c.port || 22, protocol: c.protocol || 'SSH', username: c.username || '', password: c.password || '', privateKey: c.privateKey || '', remark: c.remark || '', tags: JSON.stringify(c.tags || []), connectionMode: c.connectionMode || 'direct', proxyId: c.proxyId || null, jumpHostId: c.jumpHostId || null, jumpHostIds: JSON.stringify(Array.isArray(c.jumpHostIds) && c.jumpHostIds.length ? c.jumpHostIds : (c.jumpHostId ? [c.jumpHostId] : [])), sshKeyId: c.sshKeyId || null, createdAt: c.createdAt || now(), updatedAt: c.updatedAt || now(), revision: Math.max(1, Number(c.revision) || 1), lastConnectedAt: c.lastConnectedAt || null }); cstmt.run(safe); });
        const astmt = db.prepare('INSERT OR REPLACE INTO activities (id,time,message,type) VALUES (@id,@time,@message,@type)');
        (legacy.activities || []).forEach((a) => astmt.run({ id: a.id, time: a.time || now(), message: a.message || '', type: a.type || 'info' }));
    }
    migrateUserIdentity();
    migrateResourceOwnership();
    migrateSuperAdmin();
    const legacySettings = readJSONFile(SETTINGS_FILE, {});
    const defaults = defaultSettings(legacySettings);
    Object.entries(defaults).forEach(([key, value]) => setSettingDefault(key, value));
    const migrated = migratePlaintextSecrets();
    if (migrated) { try { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); } catch {} }
    if ((getSettings().version || '0') !== APP_VERSION) updateSettings({ ...defaults, ...getSettings(), version: APP_VERSION });
    ensureAiGuidanceDefaults();
}

/*
 * Idempotent multi-user identity migration (FREEZE plan §18.1, §21.2):
 * - every user gets an immutable random userId
 * - pre-existing users (single-user installs) become role=admin so upgrades
 *   keep their full access; newly created users default to role=user
 * - status defaults to active
 * - passkeys / password reset codes switch from username to userId foreign key
 */
function migrateUserIdentity() {
    const crypto = require('crypto');
    const tx = db.transaction(() => {
        const users = db.prepare('SELECT username, userId, role, status FROM users').all();
        const byName = new Map();
        const seenIds = new Set();
        const upd = db.prepare('UPDATE users SET userId = ?, role = ?, status = ? WHERE username = ?');
        for (const u of users) {
            let userId = String(u.userId || '').trim();
            if (!userId || seenIds.has(userId)) userId = crypto.randomUUID();
            seenIds.add(userId);
            const role = String(u.role || '').trim() || 'admin';
            const status = String(u.status || '').trim() || 'active';
            if (userId !== u.userId || role !== u.role || status !== u.status) upd.run(userId, role, status, u.username);
            byName.set(u.username, userId);
        }
        db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_userId ON users(userId)');
        const pkUpd = db.prepare('UPDATE passkeys SET userId = ? WHERE username = ? AND (userId IS NULL OR userId = \'\')');
        const rcUpd = db.prepare('UPDATE password_reset_codes SET userId = ? WHERE username = ? AND (userId IS NULL OR userId = \'\')');
        for (const [username, userId] of byName) { pkUpd.run(userId, username); rcUpd.run(userId, username); }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (\'identityMigratedAt\', ?)').run(String(now()));
    });
    tx();
}

/*
 * Idempotent resource ownership migration (FREEZE plan §21.2): all pre-existing
 * connections/proxies/ssh keys/jump hosts belong to the first admin so upgraded
 * single-user installs keep working; other users never see them implicitly.
 */
function migrateResourceOwnership() {
    const tx = db.transaction(() => {
        const admin = db.prepare("SELECT userId FROM users WHERE role = 'admin' ORDER BY createdAt LIMIT 1").get()
            || db.prepare('SELECT userId FROM users ORDER BY createdAt LIMIT 1').get();
        if (!admin?.userId) return;
        for (const table of ['connections', 'proxies', 'ssh_keys', 'jump_hosts']) {
            db.prepare(`UPDATE ${table} SET ownerUserId = ? WHERE ownerUserId IS NULL OR ownerUserId = ''`).run(admin.userId);
            db.prepare(`UPDATE ${table} SET createdByUserId = ownerUserId WHERE createdByUserId IS NULL OR createdByUserId = ''`).run();
            db.prepare(`UPDATE ${table} SET visibility = 'private' WHERE visibility IS NULL OR visibility = ''`).run();
        }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (\'ownershipMigratedAt\', ?)').run(String(now()));
    });
    tx();
}

/*
 * Idempotent super-admin migration: the first user (earliest createdAt) gets
 * isSuperAdmin=1. Super admin can promote/demote other admins; regular admins
 * cannot (FREEZE plan §18.1 / §19.3).
 */
function migrateSuperAdmin() {
    const tx = db.transaction(() => {
        const existing = db.prepare('SELECT COUNT(*) as c FROM users WHERE isSuperAdmin = 1').get();
        if (existing && existing.c > 0) return;
        const first = db.prepare('SELECT userId FROM users ORDER BY createdAt LIMIT 1').get();
        if (first?.userId) {
            db.prepare('UPDATE users SET isSuperAdmin = 1, role = ? WHERE userId = ?').run('admin', first.userId);
        }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (\'superAdminMigratedAt\', ?)').run(String(now()));
    });
    tx();
}

function ensureAiGuidanceDefaults() {
    const settings = getSettings();
    const ai = settings.ai || {};
    let changed = false;
    const next = { ...ai };
    const shouldUpgradeGuidance = !String(next.defaultSystemPrompt || '').trim() || Number(next.guidanceVersion || 0) < DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION;
    if (shouldUpgradeGuidance) {
        next.defaultSystemPrompt = DEFAULT_ZEPHYR_SYSTEM_PROMPT;
        next.guidanceVersion = DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION;
        changed = true;
    }
    const contextDefaults = defaultSettings().ai.context;
    const oldDefaultContext = { windowTokens: 128000, maxInputChars: 180000, keepMessages: 40, toolResultChars: 60000, memoryItems: 28, maxToolRounds: 0 };
    const context = { ...(next.context || {}) };
    let contextChanged = false;
    Object.entries(contextDefaults).forEach(([key, value]) => {
        if (context[key] === undefined || context[key] === oldDefaultContext[key]) { context[key] = value; contextChanged = true; }
    });
    if (contextChanged) { next.context = context; changed = true; }
    const skills = Array.isArray(next.skills) ? next.skills.slice() : [];
    cloneDefaultZephyrSkills().forEach((skill) => {
        const idx = skills.findIndex((item) => item?.id === skill.id || item?.name === skill.name);
        if (idx < 0) { skills.unshift(skill); changed = true; }
        else if (shouldUpgradeGuidance && skill.id === 'zephyr-local-operator') {
            skills[idx] = { ...skills[idx], name: skill.name, description: skill.description, prompt: skill.prompt, updatedAt: Date.now() };
            changed = true;
        }
    });
    if (changed) updateSettings({ ai: { ...next, skills } });
}

function migratePlaintextSecrets() {
    let migrated = false;
    const tx = db.transaction(() => {
        const connStmt = db.prepare('UPDATE connections SET password=@password, privateKey=@privateKey WHERE id=@id');
        db.prepare('SELECT id,password,privateKey FROM connections').all().forEach((row) => {
            const password = row.password && !secretCrypto.isEncryptedSecret(row.password) ? encryptSecretField(row.password, 'connection', row.id, 'password') : row.password;
            const privateKey = row.privateKey && !secretCrypto.isEncryptedSecret(row.privateKey) ? encryptSecretField(row.privateKey, 'connection', row.id, 'privateKey') : row.privateKey;
            if (password !== row.password || privateKey !== row.privateKey) { connStmt.run({ id: row.id, password, privateKey }); migrated = true; }
        });

        const proxyStmt = db.prepare('UPDATE proxies SET password=@password WHERE id=@id');
        db.prepare('SELECT id,password FROM proxies').all().forEach((row) => {
            const password = row.password && !secretCrypto.isEncryptedSecret(row.password) ? encryptSecretField(row.password, 'proxy', row.id, 'password') : row.password;
            if (password !== row.password) { proxyStmt.run({ id: row.id, password }); migrated = true; }
        });

        const sshKeyStmt = db.prepare('UPDATE ssh_keys SET privateKey=@privateKey, passphrase=@passphrase WHERE id=@id');
        db.prepare('SELECT id,privateKey,passphrase FROM ssh_keys').all().forEach((row) => {
            const privateKey = row.privateKey && !secretCrypto.isEncryptedSecret(row.privateKey) ? encryptSecretField(row.privateKey, 'sshKey', row.id, 'privateKey') : row.privateKey;
            const passphrase = row.passphrase && !secretCrypto.isEncryptedSecret(row.passphrase) ? encryptSecretField(row.passphrase, 'sshKey', row.id, 'passphrase') : row.passphrase;
            if (privateKey !== row.privateKey || passphrase !== row.passphrase) { sshKeyStmt.run({ id: row.id, privateKey, passphrase }); migrated = true; }
        });

        const userStmt = db.prepare('UPDATE users SET totpSecret=@totpSecret WHERE username=@username');
        db.prepare('SELECT username,totpSecret FROM users').all().forEach((row) => {
            const totpSecret = row.totpSecret && !secretCrypto.isEncryptedSecret(row.totpSecret) ? encryptSecretField(row.totpSecret, 'user', row.username, 'totpSecret') : row.totpSecret;
            if (totpSecret !== row.totpSecret) { userStmt.run({ username: row.username, totpSecret }); migrated = true; }
        });

        const settingStmt = db.prepare('UPDATE settings SET value=@value WHERE key=@key');
        db.prepare('SELECT key,value FROM settings').all().forEach((row) => {
            const value = json(row.value, row.value);
            if (typeof value !== 'object' || value === null) return;
            const encrypted = JSON.stringify(encryptSettingsValue(row.key, value));
            if (encrypted !== row.value) { settingStmt.run({ key: row.key, value: encrypted }); migrated = true; }
        });
    });
    tx();
    return migrated;
}

function setSettingDefault(key, value) {
    db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)').run(key, JSON.stringify(encryptSettingsValue(key, value)));
}
function getSettings() {
    const out = {};
    db.prepare('SELECT key,value FROM settings').all().forEach((r) => {
        const value = json(r.value, r.value);
        out[r.key] = typeof value === 'object' && value !== null ? decryptSettingsValue(r.key, value) : value;
    });
    return out;
}
function updateSettings(values) {
    const current = getSettings();
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
    Object.entries(values || {}).forEach(([k, v]) => {
        const prepared = typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...(current[k] || {}), ...v } : (v ?? '');
        stmt.run(k, JSON.stringify(encryptSettingsValue(k, prepared)));
    });
    return getSettings();
}

function normalizeUser(u) {
    const plain = decryptUser(u);
    return {
        ...plain,
        defaultPassword: !!plain.defaultPassword,
        totpEnabled: !!plain.totpEnabled,
        role: plain.role || 'user',
        status: plain.status || 'active',
        isSuperAdmin: !!plain.isSuperAdmin,
        failedLoginCount: Number(plain.failedLoginCount) || 0,
        lockedUntil: plain.lockedUntil ? Number(plain.lockedUntil) : null,
    };
}
function getUsersStore() { return { users: db.prepare('SELECT * FROM users ORDER BY createdAt').all().map(normalizeUser) }; }
/* Legacy whole-store rewrite (used by writeJSON(USERS_FILE)). Preserves the
 * immutable identity fields (userId/role/status) of existing rows and assigns
 * fresh identity to genuinely new usernames. */
function saveUsersStore(store) {
    const crypto = require('crypto');
    const tx = db.transaction((users) => {
        const existing = new Map(db.prepare('SELECT username, userId, role, status FROM users').all().map((r) => [r.username, r]));
        db.prepare('DELETE FROM users').run();
        const stmt = db.prepare('INSERT INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt,email,totpEnabled,totpSecret,failedLoginCount,lockedUntil,userId,role,status) VALUES (@username,@passwordHash,@defaultPassword,@createdAt,@updatedAt,@email,@totpEnabled,@totpSecret,@failedLoginCount,@lockedUntil,@userId,@role,@status)');
        users.forEach((u) => {
            const safe = encryptUser(u);
            const prior = existing.get(u.username);
            stmt.run({ ...safe, email: safe.email || '', totpEnabled: safe.totpEnabled ? 1 : 0, totpSecret: safe.totpSecret || null, failedLoginCount: Number(safe.failedLoginCount) || 0, lockedUntil: safe.lockedUntil || null, defaultPassword: safe.defaultPassword ? 1 : 0, userId: prior?.userId || u.userId || crypto.randomUUID(), role: prior?.role || u.role || 'admin', status: prior?.status || u.status || 'active' });
        });
    });
    tx(store.users || []);
}
function getUser(username) { const u = db.prepare('SELECT * FROM users WHERE username=?').get(username); return u ? normalizeUser(u) : null; }
function getUserById(userId) { const u = db.prepare('SELECT * FROM users WHERE userId=?').get(String(userId || '')); return u ? normalizeUser(u) : null; }
/* Lightweight identity lookup for hot auth paths — no secret decryption. */
function getUserBrief(userId) { const u = db.prepare('SELECT userId, username, role, status, email, defaultPassword, isSuperAdmin FROM users WHERE userId=?').get(String(userId || '')); return u ? { ...u, defaultPassword: !!u.defaultPassword, isSuperAdmin: !!u.isSuperAdmin } : null; }
function getFirstUser() { const u = db.prepare('SELECT * FROM users ORDER BY createdAt LIMIT 1').get(); return u ? normalizeUser(u) : null; }
function listUsers() { return db.prepare('SELECT * FROM users ORDER BY createdAt').all().map(normalizeUser); }
function createUser({ username, passwordHash, email = '', role = 'user', status = 'active', defaultPassword = false, isSuperAdmin = 0 }) {
    const crypto = require('crypto');
    const ts = now();
    const userId = crypto.randomUUID();
    db.prepare('INSERT INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt,email,totpEnabled,totpSecret,failedLoginCount,lockedUntil,userId,role,status,isSuperAdmin) VALUES (?,?,?,?,?,?,0,NULL,0,NULL,?,?,?,?)')
        .run(String(username), String(passwordHash), defaultPassword ? 1 : 0, ts, ts, String(email || ''), userId, role === 'admin' ? 'admin' : 'user', ['active', 'invited', 'suspended'].includes(status) ? status : 'active', isSuperAdmin ? 1 : 0);
    return getUserById(userId);
}
function updateUser(username, values) { const old = getUser(username); if (!old) return null; const next = { ...old, ...values, updatedAt: now(), defaultPassword: values.defaultPassword ?? old.defaultPassword ? 1 : 0, totpEnabled: values.totpEnabled ?? old.totpEnabled ? 1 : 0 }; const safe = encryptUser(next); db.prepare('UPDATE users SET passwordHash=@passwordHash, defaultPassword=@defaultPassword, updatedAt=@updatedAt, email=@email, totpEnabled=@totpEnabled, totpSecret=@totpSecret, failedLoginCount=@failedLoginCount, lockedUntil=@lockedUntil WHERE username=@username').run({ ...safe, email: safe.email || '', totpSecret: safe.totpSecret || null, failedLoginCount: Number(safe.failedLoginCount) || 0, lockedUntil: safe.lockedUntil || null }); return getUser(username); }
function updateUserById(userId, values) {
    const old = getUserById(userId);
    if (!old) return null;
    const next = { ...old, ...values, updatedAt: now() };
    const safe = encryptUser(next);
    db.prepare('UPDATE users SET passwordHash=@passwordHash, defaultPassword=@defaultPassword, updatedAt=@updatedAt, email=@email, totpEnabled=@totpEnabled, totpSecret=@totpSecret, failedLoginCount=@failedLoginCount, lockedUntil=@lockedUntil, role=@role, status=@status, isSuperAdmin=@isSuperAdmin WHERE userId=@userId')
        .run({ ...safe, email: safe.email || '', totpSecret: safe.totpSecret || null, failedLoginCount: Number(safe.failedLoginCount) || 0, lockedUntil: safe.lockedUntil || null, defaultPassword: safe.defaultPassword ? 1 : 0, totpEnabled: safe.totpEnabled ? 1 : 0, role: safe.role === 'admin' ? 'admin' : 'user', status: ['active', 'invited', 'suspended', 'deleted'].includes(safe.status) ? safe.status : 'active', isSuperAdmin: safe.isSuperAdmin ? 1 : 0 });
    return getUserById(userId);
}
function renameUser(oldUsername, newUsername) {
    const old = getUser(oldUsername);
    if (!old) return null;
    if (!newUsername || oldUsername === newUsername) return old;
    if (getUser(newUsername)) throw new Error('用户名已存在');
    const tx = db.transaction(() => {
        db.prepare('UPDATE users SET username=?, updatedAt=? WHERE username=?').run(newUsername, now(), oldUsername);
        if (old.totpSecret) db.prepare('UPDATE users SET totpSecret=? WHERE username=?').run(encryptSecretField(old.totpSecret, 'user', newUsername, 'totpSecret'), newUsername);
        db.prepare('UPDATE passkeys SET username=? WHERE username=?').run(newUsername, oldUsername);
        db.prepare('UPDATE password_reset_codes SET username=? WHERE username=?').run(newUsername, oldUsername);
    });
    tx();
    return getUser(newUsername);
}
function getConnectionsStore() { return { connections: db.prepare('SELECT * FROM connections ORDER BY createdAt DESC').all().map(rowToConnection), activities: getActivities() }; }
function saveConnectionsStore(store) {
    const tx = db.transaction(() => {
        const existing = new Map(db.prepare('SELECT id, ownerUserId, visibility, createdByUserId FROM connections').all().map((r) => [r.id, r]));
        const fallbackOwner = db.prepare("SELECT userId FROM users WHERE role='admin' ORDER BY createdAt LIMIT 1").get()?.userId || '';
        db.prepare('DELETE FROM connections').run();
        const cstmt = db.prepare(`INSERT INTO connections (id,name,host,port,protocol,username,password,privateKey,remark,tags,connectionMode,proxyId,jumpHostId,jumpHostIds,sshKeyId,rdpSoundMode,rdpClipboard,rdpMicrophone,rdpCamera,rdpStorage,rdpLocation,rdpResolution,rdpQuality,rdpFps,rdpPipeline,rdpTouchMode,rdpTouchSensitivity,rdpDomain,ephemeral,encoding,createdAt,updatedAt,revision,lastConnectedAt,ownerUserId,visibility,createdByUserId) VALUES (@id,@name,@host,@port,@protocol,@username,@password,@privateKey,@remark,@tags,@connectionMode,@proxyId,@jumpHostId,@jumpHostIds,@sshKeyId,@rdpSoundMode,@rdpClipboard,@rdpMicrophone,@rdpCamera,@rdpStorage,@rdpLocation,@rdpResolution,@rdpQuality,@rdpFps,@rdpPipeline,@rdpTouchMode,@rdpTouchSensitivity,@rdpDomain,@ephemeral,@encoding,@createdAt,@updatedAt,@revision,@lastConnectedAt,@ownerUserId,@visibility,@createdByUserId)`);
        (store.connections || []).forEach((c) => { const prior = existing.get(c.id); const safe = encryptConnection({ ...c, tags: JSON.stringify(c.tags || []), jumpHostIds: JSON.stringify(Array.isArray(c.jumpHostIds) && c.jumpHostIds.length ? c.jumpHostIds : (c.jumpHostId ? [c.jumpHostId] : [])), connectionMode: c.connectionMode || 'direct', proxyId: c.proxyId || null, jumpHostId: c.jumpHostId || null, sshKeyId: c.sshKeyId || null, rdpSoundMode: c.rdpSoundMode || 'local', rdpClipboard: c.rdpClipboard !== false ? 1 : 0, rdpMicrophone: c.rdpMicrophone ? 1 : 0, rdpCamera: c.rdpCamera ? 1 : 0, rdpStorage: c.rdpStorage ? 1 : 0, rdpLocation: c.rdpLocation ? 1 : 0, rdpResolution: c.rdpResolution || '1080p', rdpQuality: c.rdpQuality || 'balanced', rdpFps: c.rdpFps || 30, rdpPipeline: 'worker-gpu-v2', rdpTouchMode: c.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(c.rdpTouchSensitivity) || 1.5)), rdpDomain: c.rdpDomain || '', ephemeral: c.ephemeral ? 1 : 0, encoding: c.encoding || 'utf-8', revision: Math.max(1, Number(c.revision) || 1), ownerUserId: c.ownerUserId || prior?.ownerUserId || fallbackOwner, visibility: c.visibility || prior?.visibility || 'private', createdByUserId: c.createdByUserId || prior?.createdByUserId || c.ownerUserId || prior?.ownerUserId || fallbackOwner }); cstmt.run(safe); });
        db.prepare('DELETE FROM activities').run();
        const astmt = db.prepare('INSERT INTO activities (id,time,message,type) VALUES (@id,@time,@message,@type)');
        (store.activities || []).slice(0, 100).forEach((a) => astmt.run({ id: a.id, time: a.time, message: a.message, type: a.type || 'info' }));
    });
    tx();
}
/* Row-level connection helpers (FREEZE plan §21.3 — production code stops
 * whole-store read/modify/write and uses these instead). */
function getConnectionById(id) { return rowToConnection(db.prepare('SELECT * FROM connections WHERE id=?').get(String(id || ''))); }
function insertConnection(conn) {
    const safe = encryptConnection({ ...conn, revision: Math.max(1, Number(conn.revision) || 1), tags: JSON.stringify(conn.tags || []), jumpHostIds: JSON.stringify(Array.isArray(conn.jumpHostIds) ? conn.jumpHostIds : []), connectionMode: conn.connectionMode || 'direct', proxyId: conn.proxyId || null, jumpHostId: conn.jumpHostId || null, sshKeyId: conn.sshKeyId || null, rdpSoundMode: conn.rdpSoundMode || 'local', rdpClipboard: conn.rdpClipboard !== false ? 1 : 0, rdpMicrophone: conn.rdpMicrophone ? 1 : 0, rdpCamera: conn.rdpCamera ? 1 : 0, rdpStorage: conn.rdpStorage ? 1 : 0, rdpLocation: conn.rdpLocation ? 1 : 0, rdpResolution: conn.rdpResolution || '1080p', rdpQuality: conn.rdpQuality || 'balanced', rdpFps: conn.rdpFps || 30, rdpPipeline: 'worker-gpu-v2', rdpTouchMode: conn.rdpTouchMode === 'relative' ? 'relative' : 'direct', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(conn.rdpTouchSensitivity) || 1.5)), rdpDomain: conn.rdpDomain || '', ephemeral: conn.ephemeral ? 1 : 0, encoding: conn.encoding || 'utf-8', ownerUserId: conn.ownerUserId || '', visibility: conn.visibility || 'private', createdByUserId: conn.createdByUserId || conn.ownerUserId || '' });
    db.prepare(`INSERT INTO connections (id,name,host,port,protocol,username,password,privateKey,remark,tags,connectionMode,proxyId,jumpHostId,jumpHostIds,sshKeyId,rdpSoundMode,rdpClipboard,rdpMicrophone,rdpCamera,rdpStorage,rdpLocation,rdpResolution,rdpQuality,rdpFps,rdpPipeline,rdpTouchMode,rdpTouchSensitivity,rdpDomain,ephemeral,encoding,createdAt,updatedAt,revision,lastConnectedAt,ownerUserId,visibility,createdByUserId) VALUES (@id,@name,@host,@port,@protocol,@username,@password,@privateKey,@remark,@tags,@connectionMode,@proxyId,@jumpHostId,@jumpHostIds,@sshKeyId,@rdpSoundMode,@rdpClipboard,@rdpMicrophone,@rdpCamera,@rdpStorage,@rdpLocation,@rdpResolution,@rdpQuality,@rdpFps,@rdpPipeline,@rdpTouchMode,@rdpTouchSensitivity,@rdpDomain,@ephemeral,@encoding,@createdAt,@updatedAt,@revision,@lastConnectedAt,@ownerUserId,@visibility,@createdByUserId)`).run(safe);
    return getConnectionById(conn.id);
}
function updateConnectionRow(conn) {
    const safe = encryptConnection({ ...conn, revision: Math.max(1, Number(conn.revision) || 1), tags: JSON.stringify(conn.tags || []), jumpHostIds: JSON.stringify(Array.isArray(conn.jumpHostIds) ? conn.jumpHostIds : []), rdpClipboard: conn.rdpClipboard !== false ? 1 : 0, rdpMicrophone: conn.rdpMicrophone ? 1 : 0, rdpCamera: conn.rdpCamera ? 1 : 0, rdpStorage: conn.rdpStorage ? 1 : 0, rdpLocation: conn.rdpLocation ? 1 : 0, rdpPipeline: 'worker-gpu-v2', rdpTouchSensitivity: Math.max(0.5, Math.min(3, Number(conn.rdpTouchSensitivity) || 1.5)), ephemeral: conn.ephemeral ? 1 : 0, encoding: conn.encoding || 'utf-8' });
    db.prepare(`UPDATE connections SET name=@name, host=@host, port=@port, protocol=@protocol, username=@username, password=@password, privateKey=@privateKey, remark=@remark, tags=@tags, connectionMode=@connectionMode, proxyId=@proxyId, jumpHostId=@jumpHostId, jumpHostIds=@jumpHostIds, sshKeyId=@sshKeyId, rdpSoundMode=@rdpSoundMode, rdpClipboard=@rdpClipboard, rdpMicrophone=@rdpMicrophone, rdpCamera=@rdpCamera, rdpStorage=@rdpStorage, rdpLocation=@rdpLocation, rdpResolution=@rdpResolution, rdpQuality=@rdpQuality, rdpFps=@rdpFps, rdpPipeline=@rdpPipeline, rdpTouchMode=@rdpTouchMode, rdpTouchSensitivity=@rdpTouchSensitivity, rdpDomain=@rdpDomain, ephemeral=@ephemeral, encoding=@encoding, visibility=@visibility, updatedAt=@updatedAt, revision=@revision, lastConnectedAt=@lastConnectedAt WHERE id=@id`).run(safe);
    return getConnectionById(conn.id);
}
function deleteConnectionRow(id) { db.prepare('DELETE FROM connections WHERE id=?').run(String(id || '')); }
function listAllConnectionRows() { return db.prepare('SELECT * FROM connections ORDER BY createdAt DESC').all().map(rowToConnection); }
/** Safety net: drop orphan one-shot connections older than ttlMs (default 6h). */
function cleanupExpiredEphemeralConnections(ttlMs = 6 * 60 * 60 * 1000) {
    const cutoff = now() - Math.max(60_000, Number(ttlMs) || 0);
    const rows = db.prepare('SELECT id FROM connections WHERE ephemeral = 1 AND createdAt < ?').all(cutoff);
    const del = db.prepare('DELETE FROM connections WHERE id=?');
    rows.forEach((r) => del.run(r.id));
    return rows.length;
}

function getActivities(limit = 50) { return db.prepare('SELECT * FROM activities ORDER BY time DESC LIMIT ?').all(limit); }
function getActivitiesForUser(userId, limit = 50) { return db.prepare('SELECT * FROM activities WHERE userId = ? ORDER BY time DESC LIMIT ?').all(String(userId), limit); }
function queryActivities({ userId = '', from = 0, to = 0, limit = 500 } = {}) {
    const conditions = [];
    const params = { limit: Math.max(1, Math.min(500, Number(limit) || 500)) };
    if (userId) { conditions.push('userId = @userId'); params.userId = String(userId); }
    if (from > 0) { conditions.push('time >= @from'); params.from = Number(from); }
    if (to > 0) { conditions.push('time <= @to'); params.to = Number(to); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    return db.prepare(`SELECT * FROM activities ${where} ORDER BY time DESC LIMIT @limit`).all(params);
}
function addActivity(activity) { db.prepare('INSERT INTO activities (id,time,message,type,userId) VALUES (@id,@time,@message,@type,@userId)').run({ ...activity, userId: activity.userId || null }); }
function clearActivities() { db.prepare('DELETE FROM activities').run(); }

function listProxies() { return db.prepare('SELECT * FROM proxies ORDER BY createdAt DESC').all().map(rowToProxy); }
function getProxyRaw(id) { return decryptProxy(db.prepare('SELECT * FROM proxies WHERE id=?').get(id)); }
function saveProxy(p) {
    const prior = db.prepare('SELECT ownerUserId, visibility, createdAt, revision FROM proxies WHERE id=?').get(p.id);
    const safe = encryptProxy(p);
    db.prepare(`INSERT OR REPLACE INTO proxies (id,name,host,port,type,username,password,createdAt,updatedAt,revision,ownerUserId,visibility) VALUES (@id,@name,@host,@port,@type,@username,@password,@createdAt,@updatedAt,@revision,@ownerUserId,@visibility)`)
        .run({ ...safe, type: safe.type || 'socks5', revision: Math.max(1, Number(safe.revision ?? prior?.revision) || 1), createdAt: safe.createdAt || prior?.createdAt || now(), ownerUserId: safe.ownerUserId || prior?.ownerUserId || '', visibility: safe.visibility || prior?.visibility || 'private' });
    return rowToProxy(db.prepare('SELECT * FROM proxies WHERE id=?').get(p.id));
}
function deleteProxy(id) { db.prepare('DELETE FROM proxies WHERE id=?').run(id); }
function listSshKeys() { return db.prepare('SELECT * FROM ssh_keys ORDER BY createdAt DESC').all().map((row) => rowToSshKey(row)); }
function getSshKeyRaw(id) { return decryptSshKey(db.prepare('SELECT * FROM ssh_keys WHERE id=?').get(id)); }
function saveSshKey(k) {
    const prior = db.prepare('SELECT ownerUserId, visibility, createdAt, revision FROM ssh_keys WHERE id=?').get(k.id);
    const safe = encryptSshKey(k);
    db.prepare(`INSERT OR REPLACE INTO ssh_keys (id,name,privateKey,passphrase,remark,createdAt,updatedAt,revision,ownerUserId,visibility) VALUES (@id,@name,@privateKey,@passphrase,@remark,@createdAt,@updatedAt,@revision,@ownerUserId,@visibility)`)
        .run({ ...safe, passphrase: safe.passphrase || '', remark: safe.remark || '', revision: Math.max(1, Number(safe.revision ?? prior?.revision) || 1), createdAt: safe.createdAt || prior?.createdAt || now(), ownerUserId: safe.ownerUserId || prior?.ownerUserId || '', visibility: safe.visibility || prior?.visibility || 'private' });
    return rowToSshKey(db.prepare('SELECT * FROM ssh_keys WHERE id=?').get(k.id));
}
function deleteSshKey(id) { db.prepare('DELETE FROM ssh_keys WHERE id=?').run(id); }
function listJumpHosts() { return db.prepare('SELECT * FROM jump_hosts ORDER BY createdAt DESC').all().map(rowToJumpHost); }
function saveJumpHost(j) {
    const prior = db.prepare('SELECT ownerUserId, visibility, createdAt, revision FROM jump_hosts WHERE id=?').get(j.id);
    db.prepare(`INSERT OR REPLACE INTO jump_hosts (id,name,connectionId,createdAt,updatedAt,revision,ownerUserId,visibility) VALUES (@id,@name,@connectionId,@createdAt,@updatedAt,@revision,@ownerUserId,@visibility)`)
        .run({ ...j, revision: Math.max(1, Number(j.revision ?? prior?.revision) || 1), createdAt: j.createdAt || prior?.createdAt || now(), ownerUserId: j.ownerUserId || prior?.ownerUserId || '', visibility: j.visibility || prior?.visibility || 'private' });
    return rowToJumpHost(db.prepare('SELECT * FROM jump_hosts WHERE id=?').get(j.id));
}
function deleteJumpHost(id) { db.prepare('DELETE FROM jump_hosts WHERE id=?').run(id); }

function addLoginEvent(e) { db.prepare('INSERT INTO login_events (id,username,ip,region,userAgent,success,reason,time) VALUES (@id,@username,@ip,@region,@userAgent,@success,@reason,@time)').run({ ...e, success: e.success ? 1 : 0 }); }
function listLoginEvents(limit = 100, username = '') {
    const max = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    if (username) return db.prepare('SELECT * FROM login_events WHERE username = ? ORDER BY time DESC LIMIT ?').all(String(username), max);
    return db.prepare('SELECT * FROM login_events ORDER BY time DESC LIMIT ?').all(max);
}
function clearLoginEvents() { db.prepare('DELETE FROM login_events').run(); }
function getIpBan(ip) { return db.prepare('SELECT * FROM ip_bans WHERE ip=?').get(ip); }
function saveIpBan(b) { db.prepare('INSERT OR REPLACE INTO ip_bans (ip,failedCount,bannedUntil,updatedAt) VALUES (@ip,@failedCount,@bannedUntil,@updatedAt)').run(b); return getIpBan(b.ip); }
function clearIpBan(ip) { db.prepare('DELETE FROM ip_bans WHERE ip=?').run(ip); }
function listIpBans() { return db.prepare('SELECT * FROM ip_bans ORDER BY updatedAt DESC').all(); }
function invalidateResetCodesForUser(username) {
    return db.prepare('UPDATE password_reset_codes SET used=1 WHERE username=? AND used=0').run(String(username || '')).changes;
}
function createResetCode(c) {
    if (c?.username) invalidateResetCodesForUser(c.username);
    db.prepare('INSERT INTO password_reset_codes (id,username,email,codeHash,expiresAt,used,createdAt,attemptCount) VALUES (@id,@username,@email,@codeHash,@expiresAt,0,@createdAt,0)').run(c);
}
function findResetCode(username, email) {
    return db.prepare('SELECT * FROM password_reset_codes WHERE username=? AND email=? AND used=0 ORDER BY createdAt DESC LIMIT 1').get(username, email);
}
function markResetCodeUsed(id) { db.prepare('UPDATE password_reset_codes SET used=1 WHERE id=?').run(id); }
/** Increment failed verify attempts for a reset token. Returns the new count. */
function recordResetCodeAttempt(id) {
    const row = db.prepare('SELECT attemptCount FROM password_reset_codes WHERE id=? AND used=0').get(id);
    if (!row) return 0;
    const next = (Number(row.attemptCount) || 0) + 1;
    db.prepare('UPDATE password_reset_codes SET attemptCount=? WHERE id=?').run(next, id);
    return next;
}
function listPasskeys(username) { return db.prepare('SELECT * FROM passkeys WHERE username=? ORDER BY createdAt DESC').all(username).map((p) => ({ ...p, transports: json(p.transports, []) })); }
function savePasskey(p) { db.prepare('INSERT OR REPLACE INTO passkeys (id,username,credentialId,publicKey,counter,transports,createdAt,lastUsedAt) VALUES (@id,@username,@credentialId,@publicKey,@counter,@transports,@createdAt,@lastUsedAt)').run({ ...p, transports: JSON.stringify(p.transports || []) }); }
function getPasskeyByCredentialId(credentialId) { const p = db.prepare('SELECT * FROM passkeys WHERE credentialId=?').get(credentialId); return p ? { ...p, transports: json(p.transports, []) } : null; }
function updatePasskeyCounter(id, counter) { db.prepare('UPDATE passkeys SET counter=?, lastUsedAt=? WHERE id=?').run(counter, now(), id); }
function deletePasskey(username, id) { db.prepare('DELETE FROM passkeys WHERE username=? AND id=?').run(username, id); }
function rawDb() { return db; }
function close() { if (db) { db.close(); db = null; } }

module.exports = { init, getUsersStore, saveUsersStore, getUser, getUserById, getUserBrief, getFirstUser, listUsers, createUser, updateUser, updateUserById, renameUser, getConnectionsStore, saveConnectionsStore, getConnectionById, insertConnection, updateConnectionRow, deleteConnectionRow, listAllConnectionRows, cleanupExpiredEphemeralConnections, getSettings, updateSettings, addActivity, getActivities, getActivitiesForUser, queryActivities, clearActivities, listProxies, getProxyRaw, saveProxy, deleteProxy, listSshKeys, getSshKeyRaw, saveSshKey, deleteSshKey, listJumpHosts, saveJumpHost, deleteJumpHost, addLoginEvent, listLoginEvents, clearLoginEvents, getIpBan, saveIpBan, clearIpBan, listIpBans, createResetCode, findResetCode, markResetCodeUsed, recordResetCodeAttempt, invalidateResetCodesForUser, listPasskeys, savePasskey, getPasskeyByCredentialId, updatePasskeyCounter, deletePasskey, rawDb, close };
