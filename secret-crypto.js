const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ml_kem768 } = require('@noble/post-quantum/ml-kem.js');

const DATA_DIR = process.env.ZEPHYR_DATA_DIR
    ? path.resolve(process.env.ZEPHYR_DATA_DIR)
    : path.join(__dirname, 'data');
const DEFAULT_KEY_FILE = path.join(DATA_DIR, 'crypto', 'ml-kem-768-keypair.json');
const PREFIX = 'ZEPHYR_MLKEM768_V1:';
const ALG = 'ML-KEM-768+AES-256-GCM';
const AAD_PREFIX = 'zephyr-secret-field-v1';

let cachedKeyPair = null;
let cachedEnvKeyPair = undefined;

function b64(buf) { return Buffer.from(buf).toString('base64'); }
function unb64(value) { return Buffer.from(String(value || ''), 'base64'); }
function currentKeyFile() { return process.env.ZEPHYR_DATA_MLKEM768_KEY_FILE || DEFAULT_KEY_FILE; }

function readEnvKeyPair() {
    if (cachedEnvKeyPair !== undefined) return cachedEnvKeyPair;
    const publicKey = process.env.ZEPHYR_DATA_MLKEM768_PUBLIC_KEY_B64 || process.env.DATA_MLKEM768_PUBLIC_KEY_B64;
    const secretKey = process.env.ZEPHYR_DATA_MLKEM768_SECRET_KEY_B64 || process.env.DATA_MLKEM768_SECRET_KEY_B64;
    if (!publicKey && !secretKey) {
        cachedEnvKeyPair = null;
        return null;
    }
    if (!publicKey || !secretKey) throw new Error('ML-KEM-768 数据加密环境变量不完整，需要同时提供 PUBLIC_KEY_B64 和 SECRET_KEY_B64');
    cachedEnvKeyPair = { publicKey: unb64(publicKey), secretKey: unb64(secretKey), source: 'env' };
    return cachedEnvKeyPair;
}

function validateKeyPair(pair) {
    if (!pair?.publicKey || !pair?.secretKey) throw new Error('ML-KEM-768 数据加密密钥缺失');
    if (pair.publicKey.length !== 1184 || pair.secretKey.length !== 2400) throw new Error('ML-KEM-768 数据加密密钥长度无效');
    return pair;
}

function loadKeyPairFromFile() {
    const keyFile = currentKeyFile();
    if (!fs.existsSync(keyFile)) return null;
    const raw = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    return validateKeyPair({ publicKey: unb64(raw.publicKey), secretKey: unb64(raw.secretKey), source: 'file' });
}

function writeKeyPairToFile(pair) {
    const keyFile = currentKeyFile();
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    const payload = {
        version: 1,
        alg: 'ML-KEM-768',
        publicKey: b64(pair.publicKey),
        secretKey: b64(pair.secretKey),
        createdAt: Date.now(),
        warning: 'Keep this file secret. It is required to decrypt encrypted Zephyr data fields.',
    };
    fs.writeFileSync(keyFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch {}
}

function ensureKeyPair() {
    if (cachedKeyPair) return cachedKeyPair;
    cachedKeyPair = validateKeyPair(readEnvKeyPair() || loadKeyPairFromFile() || (() => {
        const generated = ml_kem768.keygen();
        writeKeyPairToFile(generated);
        return { ...generated, source: 'file' };
    })());
    return cachedKeyPair;
}

function resetKeyPairCache() { cachedKeyPair = null; cachedEnvKeyPair = undefined; }

function isEncryptedSecret(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

function deriveContentKey(sharedSecret, aad) {
    const salt = crypto.createHash('sha256').update(AAD_PREFIX).digest();
    const info = Buffer.from(`${ALG}:${aad || 'default'}`);
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(sharedSecret), salt, info, 32));
}

function encryptSecret(value, aad = 'secret') {
    if (value === undefined || value === null || value === '') return value ?? '';
    const text = String(value);
    if (isEncryptedSecret(text)) return text;
    const { publicKey } = ensureKeyPair();
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
    const iv = crypto.randomBytes(12);
    const key = deriveContentKey(sharedSecret, aad);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(String(aad || 'secret')));
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const record = {
        v: 1,
        alg: ALG,
        kem: 'ML-KEM-768',
        aead: 'AES-256-GCM',
        ct: b64(cipherText),
        iv: b64(iv),
        tag: b64(cipher.getAuthTag()),
        data: b64(encrypted),
    };
    return PREFIX + Buffer.from(JSON.stringify(record), 'utf8').toString('base64url');
}

function decryptSecret(value, aad = 'secret') {
    if (value === undefined || value === null || value === '') return value ?? '';
    const text = String(value);
    if (!isEncryptedSecret(text)) return text;
    let record;
    try {
        record = JSON.parse(Buffer.from(text.slice(PREFIX.length), 'base64url').toString('utf8'));
    } catch {
        throw new Error('加密字段格式损坏');
    }
    if (record.v !== 1 || record.alg !== ALG || record.kem !== 'ML-KEM-768') throw new Error('不支持的加密字段格式');
    try {
        const { secretKey } = ensureKeyPair();
        const sharedSecret = ml_kem768.decapsulate(unb64(record.ct), secretKey);
        const key = deriveContentKey(sharedSecret, aad);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(record.iv));
        decipher.setAAD(Buffer.from(String(aad || 'secret')));
        decipher.setAuthTag(unb64(record.tag));
        return Buffer.concat([decipher.update(unb64(record.data)), decipher.final()]).toString('utf8');
    } catch (err) {
        throw new Error(`无法解密加密字段，请检查 ML-KEM-768 数据密钥是否匹配：${err.message}`);
    }
}

function getKeyBackupFile() {
    if (readEnvKeyPair()) return null;
    const keyFile = currentKeyFile();
    return fs.existsSync(keyFile) ? { archivePath: 'crypto/ml-kem-768-keypair.json', filePath: keyFile } : null;
}

function restoreKeyBackup(buffer) {
    if (!buffer?.length) return false;
    const keyFile = currentKeyFile();
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(keyFile, buffer, { mode: 0o600 });
    try { fs.chmodSync(keyFile, 0o600); } catch {}
    resetKeyPairCache();
    ensureKeyPair();
    return true;
}

module.exports = {
    ALG,
    PREFIX,
    DEFAULT_KEY_FILE,
    currentKeyFile,
    ensureKeyPair,
    resetKeyPairCache,
    isEncryptedSecret,
    encryptSecret,
    decryptSecret,
    getKeyBackupFile,
    restoreKeyBackup,
};
