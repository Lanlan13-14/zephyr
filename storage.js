const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getAppVersion } = require('./version');
const { DEFAULT_ZEPHYR_AI_GUIDANCE_VERSION, DEFAULT_ZEPHYR_SYSTEM_PROMPT, cloneDefaultZephyrSkills } = require('./ai-defaults');
const secretCrypto = require('./secret-crypto');

const DATA_DIR = path.join(__dirname, 'data');
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
    return { ...plain, port: Number(plain.port) || 22, tags: json(plain.tags, []), jumpHostIds: json(plain.jumpHostIds, plain.jumpHostId ? [plain.jumpHostId] : []), sshKeyId: plain.sshKeyId || '', lastConnectedAt: plain.lastConnectedAt || null, rdpSoundMode: plain.rdpSoundMode || 'local', rdpClipboard: plain.rdpClipboard === 0 ? false : true, rdpMicrophone: !!plain.rdpMicrophone, rdpCamera: !!plain.rdpCamera, rdpStorage: !!plain.rdpStorage, rdpLocation: !!plain.rdpLocation, rdpResolution: plain.rdpResolution || '1080p', rdpQuality: plain.rdpQuality || 'balanced', rdpFps: Number(plain.rdpFps) || 30, rdpDomain: plain.rdpDomain || '' };
}

function rowToSshKey(row, { includeSecret = false } = {}) {
    if (!row) return null;
    const plain = decryptSshKey(row);
    const out = { ...plain, hasPrivateKey: hasSecretValue(plain.privateKey), hasPassphrase: hasSecretValue(plain.passphrase), privateKey: plain.privateKey ? '******' : '', passphrase: plain.passphrase ? '******' : '' };
    if (includeSecret) {
        out.privateKey = plain.privateKey || '';
        out.passphrase = plain.passphrase || '';
    }
    return out;
}

function rowToProxy(row) {
    if (!row) return null;
    const plain = decryptProxy(row);
    return { ...plain, type: plain.type || 'socks5', port: Number(plain.port) || 1080, hasPassword: hasSecretValue(plain.password), password: plain.password ? '******' : '' };
}

function rowToJumpHost(row) { return row ? { ...row } : null; }

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
        mail: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', adminEmail: '', notifyLoginSuccess: true, notifyLoginFailure: true, geoLookupEnabled: true },
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
            terminalBackground: { type: 'none', url: '', fit: 'cover', opacity: 0.35 },
            terminalFontColor: '',
        },
        terminal: {
            maxWindows: 3,
            minimizedKeepAlive: 0,
            smartbarOrder: 'old-first',
            shortcutPlatform: 'auto',
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
            lastConnectedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS ssh_keys (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            privateKey TEXT NOT NULL,
            passphrase TEXT,
            remark TEXT,
            createdAt INTEGER,
            updatedAt INTEGER
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
            updatedAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS jump_hosts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            connectionId TEXT NOT NULL,
            createdAt INTEGER,
            updatedAt INTEGER
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
            createdAt INTEGER
        );
    `);

    addColumnIfMissing('users', 'email', 'TEXT');
    addColumnIfMissing('users', 'totpEnabled', 'INTEGER DEFAULT 0');
    addColumnIfMissing('users', 'totpSecret', 'TEXT');
    addColumnIfMissing('users', 'failedLoginCount', 'INTEGER DEFAULT 0');
    addColumnIfMissing('users', 'lockedUntil', 'INTEGER');
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
    addColumnIfMissing('connections', 'rdpDomain', "TEXT DEFAULT ''");
    addColumnIfMissing('proxies', 'type', "TEXT DEFAULT 'socks5'");
    secretCrypto.ensureKeyPair();

    if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
        const legacy = readJSONFile(USERS_FILE, { users: [] });
        const users = legacy.users?.length ? legacy.users : [{ username: 'admin', passwordHash: hashPassword('admin'), defaultPassword: true, createdAt: now() }];
        const stmt = db.prepare('INSERT OR REPLACE INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt) VALUES (@username,@passwordHash,@defaultPassword,@createdAt,@updatedAt)');
        users.forEach((u) => stmt.run({ username: u.username, passwordHash: u.passwordHash, defaultPassword: u.defaultPassword ? 1 : 0, createdAt: u.createdAt || now(), updatedAt: u.updatedAt || null }));
    }
    if (db.prepare('SELECT COUNT(*) AS c FROM connections').get().c === 0) {
        const legacy = readJSONFile(CONNECTIONS_FILE, { connections: [], activities: [] });
        const cstmt = db.prepare(`INSERT OR REPLACE INTO connections (id,name,host,port,protocol,username,password,privateKey,remark,tags,connectionMode,proxyId,jumpHostId,jumpHostIds,sshKeyId,createdAt,updatedAt,lastConnectedAt)
            VALUES (@id,@name,@host,@port,@protocol,@username,@password,@privateKey,@remark,@tags,@connectionMode,@proxyId,@jumpHostId,@jumpHostIds,@sshKeyId,@createdAt,@updatedAt,@lastConnectedAt)`);
        (legacy.connections || []).forEach((c) => { const safe = encryptConnection({ id: c.id, name: c.name, host: c.host, port: c.port || 22, protocol: c.protocol || 'SSH', username: c.username || '', password: c.password || '', privateKey: c.privateKey || '', remark: c.remark || '', tags: JSON.stringify(c.tags || []), connectionMode: c.connectionMode || 'direct', proxyId: c.proxyId || null, jumpHostId: c.jumpHostId || null, jumpHostIds: JSON.stringify(Array.isArray(c.jumpHostIds) && c.jumpHostIds.length ? c.jumpHostIds : (c.jumpHostId ? [c.jumpHostId] : [])), sshKeyId: c.sshKeyId || null, createdAt: c.createdAt || now(), updatedAt: c.updatedAt || now(), lastConnectedAt: c.lastConnectedAt || null }); cstmt.run(safe); });
        const astmt = db.prepare('INSERT OR REPLACE INTO activities (id,time,message,type) VALUES (@id,@time,@message,@type)');
        (legacy.activities || []).forEach((a) => astmt.run({ id: a.id, time: a.time || now(), message: a.message || '', type: a.type || 'info' }));
    }
    const legacySettings = readJSONFile(SETTINGS_FILE, {});
    const defaults = defaultSettings(legacySettings);
    Object.entries(defaults).forEach(([key, value]) => setSettingDefault(key, value));
    const migrated = migratePlaintextSecrets();
    if (migrated) { try { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); } catch {} }
    if ((getSettings().version || '0') !== APP_VERSION) updateSettings({ ...defaults, ...getSettings(), version: APP_VERSION });
    ensureAiGuidanceDefaults();
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

function normalizeUser(u) { const plain = decryptUser(u); return { ...plain, defaultPassword: !!plain.defaultPassword, totpEnabled: !!plain.totpEnabled }; }
function getUsersStore() { return { users: db.prepare('SELECT * FROM users ORDER BY createdAt').all().map(normalizeUser) }; }
function saveUsersStore(store) {
    const tx = db.transaction((users) => { db.prepare('DELETE FROM users').run(); const stmt = db.prepare('INSERT INTO users (username,passwordHash,defaultPassword,createdAt,updatedAt,email,totpEnabled,totpSecret,failedLoginCount,lockedUntil) VALUES (@username,@passwordHash,@defaultPassword,@createdAt,@updatedAt,@email,@totpEnabled,@totpSecret,@failedLoginCount,@lockedUntil)'); users.forEach((u) => { const safe = encryptUser(u); stmt.run({ ...safe, email: safe.email || '', totpEnabled: safe.totpEnabled ? 1 : 0, totpSecret: safe.totpSecret || null, failedLoginCount: Number(safe.failedLoginCount) || 0, lockedUntil: safe.lockedUntil || null, defaultPassword: safe.defaultPassword ? 1 : 0 }); }); });
    tx(store.users || []);
}
function getUser(username) { const u = db.prepare('SELECT * FROM users WHERE username=?').get(username); return u ? normalizeUser(u) : null; }
function getFirstUser() { const u = db.prepare('SELECT * FROM users ORDER BY createdAt LIMIT 1').get(); return u ? normalizeUser(u) : null; }
function updateUser(username, values) { const old = getUser(username); if (!old) return null; const next = { ...old, ...values, updatedAt: now(), defaultPassword: values.defaultPassword ?? old.defaultPassword ? 1 : 0, totpEnabled: values.totpEnabled ?? old.totpEnabled ? 1 : 0 }; const safe = encryptUser(next); db.prepare('UPDATE users SET passwordHash=@passwordHash, defaultPassword=@defaultPassword, updatedAt=@updatedAt, email=@email, totpEnabled=@totpEnabled, totpSecret=@totpSecret, failedLoginCount=@failedLoginCount, lockedUntil=@lockedUntil WHERE username=@username').run({ ...safe, email: safe.email || '', totpSecret: safe.totpSecret || null, failedLoginCount: Number(safe.failedLoginCount) || 0, lockedUntil: safe.lockedUntil || null }); return getUser(username); }
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
        db.prepare('DELETE FROM connections').run();
        const cstmt = db.prepare(`INSERT INTO connections (id,name,host,port,protocol,username,password,privateKey,remark,tags,connectionMode,proxyId,jumpHostId,jumpHostIds,sshKeyId,rdpSoundMode,rdpClipboard,rdpMicrophone,rdpCamera,rdpStorage,rdpLocation,rdpResolution,rdpQuality,rdpFps,rdpDomain,createdAt,updatedAt,lastConnectedAt) VALUES (@id,@name,@host,@port,@protocol,@username,@password,@privateKey,@remark,@tags,@connectionMode,@proxyId,@jumpHostId,@jumpHostIds,@sshKeyId,@rdpSoundMode,@rdpClipboard,@rdpMicrophone,@rdpCamera,@rdpStorage,@rdpLocation,@rdpResolution,@rdpQuality,@rdpFps,@rdpDomain,@createdAt,@updatedAt,@lastConnectedAt)`);
        (store.connections || []).forEach((c) => { const safe = encryptConnection({ ...c, tags: JSON.stringify(c.tags || []), jumpHostIds: JSON.stringify(Array.isArray(c.jumpHostIds) && c.jumpHostIds.length ? c.jumpHostIds : (c.jumpHostId ? [c.jumpHostId] : [])), connectionMode: c.connectionMode || 'direct', proxyId: c.proxyId || null, jumpHostId: c.jumpHostId || null, sshKeyId: c.sshKeyId || null, rdpSoundMode: c.rdpSoundMode || 'local', rdpClipboard: c.rdpClipboard !== false ? 1 : 0, rdpMicrophone: c.rdpMicrophone ? 1 : 0, rdpCamera: c.rdpCamera ? 1 : 0, rdpStorage: c.rdpStorage ? 1 : 0, rdpLocation: c.rdpLocation ? 1 : 0, rdpResolution: c.rdpResolution || '1080p', rdpQuality: c.rdpQuality || 'balanced', rdpFps: c.rdpFps || 30, rdpDomain: c.rdpDomain || '' }); cstmt.run(safe); });
        db.prepare('DELETE FROM activities').run();
        const astmt = db.prepare('INSERT INTO activities (id,time,message,type) VALUES (@id,@time,@message,@type)');
        (store.activities || []).slice(0, 100).forEach((a) => astmt.run({ id: a.id, time: a.time, message: a.message, type: a.type || 'info' }));
    });
    tx();
}
function getActivities(limit = 50) { return db.prepare('SELECT * FROM activities ORDER BY time DESC LIMIT ?').all(limit); }
function addActivity(activity) { db.prepare('INSERT INTO activities (id,time,message,type) VALUES (@id,@time,@message,@type)').run(activity); }
function clearActivities() { db.prepare('DELETE FROM activities').run(); }

function listProxies() { return db.prepare('SELECT * FROM proxies ORDER BY createdAt DESC').all().map(rowToProxy); }
function getProxyRaw(id) { return decryptProxy(db.prepare('SELECT * FROM proxies WHERE id=?').get(id)); }
function saveProxy(p) { const safe = encryptProxy(p); db.prepare(`INSERT OR REPLACE INTO proxies (id,name,host,port,type,username,password,createdAt,updatedAt) VALUES (@id,@name,@host,@port,@type,@username,@password,@createdAt,@updatedAt)`).run({ ...safe, type: safe.type || 'socks5' }); return rowToProxy(db.prepare('SELECT * FROM proxies WHERE id=?').get(p.id)); }
function deleteProxy(id) { db.prepare('DELETE FROM proxies WHERE id=?').run(id); }
function listSshKeys() { return db.prepare('SELECT * FROM ssh_keys ORDER BY createdAt DESC').all().map((row) => rowToSshKey(row)); }
function getSshKeyRaw(id) { return decryptSshKey(db.prepare('SELECT * FROM ssh_keys WHERE id=?').get(id)); }
function saveSshKey(k) { const safe = encryptSshKey(k); db.prepare(`INSERT OR REPLACE INTO ssh_keys (id,name,privateKey,passphrase,remark,createdAt,updatedAt) VALUES (@id,@name,@privateKey,@passphrase,@remark,@createdAt,@updatedAt)`).run({ ...safe, passphrase: safe.passphrase || '', remark: safe.remark || '' }); return rowToSshKey(db.prepare('SELECT * FROM ssh_keys WHERE id=?').get(k.id)); }
function deleteSshKey(id) { db.prepare('DELETE FROM ssh_keys WHERE id=?').run(id); }
function listJumpHosts() { return db.prepare('SELECT * FROM jump_hosts ORDER BY createdAt DESC').all().map(rowToJumpHost); }
function saveJumpHost(j) { db.prepare(`INSERT OR REPLACE INTO jump_hosts (id,name,connectionId,createdAt,updatedAt) VALUES (@id,@name,@connectionId,@createdAt,@updatedAt)`).run(j); return rowToJumpHost(db.prepare('SELECT * FROM jump_hosts WHERE id=?').get(j.id)); }
function deleteJumpHost(id) { db.prepare('DELETE FROM jump_hosts WHERE id=?').run(id); }

function addLoginEvent(e) { db.prepare('INSERT INTO login_events (id,username,ip,region,userAgent,success,reason,time) VALUES (@id,@username,@ip,@region,@userAgent,@success,@reason,@time)').run({ ...e, success: e.success ? 1 : 0 }); }
function listLoginEvents(limit = 100) { return db.prepare('SELECT * FROM login_events ORDER BY time DESC LIMIT ?').all(limit); }
function clearLoginEvents() { db.prepare('DELETE FROM login_events').run(); }
function getIpBan(ip) { return db.prepare('SELECT * FROM ip_bans WHERE ip=?').get(ip); }
function saveIpBan(b) { db.prepare('INSERT OR REPLACE INTO ip_bans (ip,failedCount,bannedUntil,updatedAt) VALUES (@ip,@failedCount,@bannedUntil,@updatedAt)').run(b); return getIpBan(b.ip); }
function clearIpBan(ip) { db.prepare('DELETE FROM ip_bans WHERE ip=?').run(ip); }
function listIpBans() { return db.prepare('SELECT * FROM ip_bans ORDER BY updatedAt DESC').all(); }
function createResetCode(c) { db.prepare('INSERT INTO password_reset_codes (id,username,email,codeHash,expiresAt,used,createdAt) VALUES (@id,@username,@email,@codeHash,@expiresAt,0,@createdAt)').run(c); }
function findResetCode(username, email) { return db.prepare('SELECT * FROM password_reset_codes WHERE username=? AND email=? AND used=0 ORDER BY createdAt DESC LIMIT 1').get(username, email); }
function markResetCodeUsed(id) { db.prepare('UPDATE password_reset_codes SET used=1 WHERE id=?').run(id); }
function listPasskeys(username) { return db.prepare('SELECT * FROM passkeys WHERE username=? ORDER BY createdAt DESC').all(username).map((p) => ({ ...p, transports: json(p.transports, []) })); }
function savePasskey(p) { db.prepare('INSERT OR REPLACE INTO passkeys (id,username,credentialId,publicKey,counter,transports,createdAt,lastUsedAt) VALUES (@id,@username,@credentialId,@publicKey,@counter,@transports,@createdAt,@lastUsedAt)').run({ ...p, transports: JSON.stringify(p.transports || []) }); }
function getPasskeyByCredentialId(credentialId) { const p = db.prepare('SELECT * FROM passkeys WHERE credentialId=?').get(credentialId); return p ? { ...p, transports: json(p.transports, []) } : null; }
function updatePasskeyCounter(id, counter) { db.prepare('UPDATE passkeys SET counter=?, lastUsedAt=? WHERE id=?').run(counter, now(), id); }
function deletePasskey(username, id) { db.prepare('DELETE FROM passkeys WHERE username=? AND id=?').run(username, id); }
function rawDb() { return db; }
function close() { if (db) { db.close(); db = null; } }

module.exports = { init, getUsersStore, saveUsersStore, getUser, getFirstUser, updateUser, renameUser, getConnectionsStore, saveConnectionsStore, getSettings, updateSettings, addActivity, clearActivities, listProxies, getProxyRaw, saveProxy, deleteProxy, listSshKeys, getSshKeyRaw, saveSshKey, deleteSshKey, listJumpHosts, saveJumpHost, deleteJumpHost, addLoginEvent, listLoginEvents, clearLoginEvents, getIpBan, saveIpBan, clearIpBan, listIpBans, createResetCode, findResetCode, markResetCodeUsed, listPasskeys, savePasskey, getPasskeyByCredentialId, updatePasskeyCounter, deletePasskey, rawDb, close };