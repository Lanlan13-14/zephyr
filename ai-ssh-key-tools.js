'use strict';

const crypto = require('crypto');
const { createHash } = require('crypto');
const { HttpError } = require('./authz');

const SSH_KEY_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: { query: { type: 'string', maxLength: 200 }, limit: { type: 'number', minimum: 1, maximum: 200 } },
    additionalProperties: false,
});
const SSH_KEY_GET_SCHEMA = Object.freeze({
    type: 'object', properties: { sshKeyId: { type: 'string', minLength: 1 } }, required: ['sshKeyId'], additionalProperties: false,
});
const SSH_KEY_RENAME_SCHEMA = Object.freeze({
    type: 'object',
    properties: { sshKeyId: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1, maxLength: 120 }, expectedRevision: { type: 'number', exclusiveMinimum: 0 } },
    required: ['sshKeyId', 'name', 'expectedRevision'], additionalProperties: false,
});
const SSH_KEY_UPDATE_METADATA_SCHEMA = Object.freeze({
    type: 'object',
    properties: { sshKeyId: { type: 'string', minLength: 1 }, remark: { type: 'string', maxLength: 20000 }, expectedRevision: { type: 'number', exclusiveMinimum: 0 } },
    required: ['sshKeyId', 'expectedRevision'], additionalProperties: false,
});
const SSH_KEY_DELETE_SCHEMA = Object.freeze({
    type: 'object', properties: { sshKeyId: { type: 'string', minLength: 1 }, expectedRevision: { type: 'number', exclusiveMinimum: 0 } }, required: ['sshKeyId', 'expectedRevision'], additionalProperties: false,
});
const SSH_KEY_VALIDATE_SCHEMA = Object.freeze({
    type: 'object', properties: { sshKeyId: { type: 'string', minLength: 1 } }, required: ['sshKeyId'], additionalProperties: false,
});

function revisionOf(key) { return Math.max(1, Number(key?.revision) || 1); }
function assertRevision(key, expectedRevision) {
    if (revisionOf(key) !== Number(expectedRevision)) throw new HttpError(409, 'revision_conflict', 'SSH 密钥元数据已被其他操作修改，请重新读取后再重试', true);
}
function fingerprint(privateKey = '') {
    const digest = createHash('sha256').update(String(privateKey || ''), 'utf8').digest('base64').replace(/=+$/g, '');
    return `SHA256:${digest}`;
}
function classify(privateKey = '') {
    const first = String(privateKey || '').split(/\r?\n/).find((line) => line.trim()) || '';
    const match = first.match(/^-----BEGIN ([A-Z0-9 ]+) PRIVATE KEY-----$/);
    return match ? match[1].replace(/ PRIVATE KEY$/, '').toLowerCase() : 'unknown';
}
function publicKey(key = {}) {
    const rawPrivateKey = key.privateKey && key.privateKey !== '******' ? String(key.privateKey) : '';
    return {
        id: String(key.id || ''),
        name: String(key.name || ''),
        remark: String(key.remark || ''),
        hasPrivateKey: key.hasPrivateKey !== undefined ? !!key.hasPrivateKey : !!rawPrivateKey,
        hasPassphrase: key.hasPassphrase !== undefined ? !!key.hasPassphrase : !!key.passphrase,
        algorithm: rawPrivateKey ? classify(rawPrivateKey) : '',
        fingerprint: rawPrivateKey ? fingerprint(rawPrivateKey) : '',
        revision: revisionOf(key),
    };
}
function listKeys(user, args, resourceService) {
    const query = String(args.query || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 100));
    return resourceService.listOwned(user, 'sshKey')
        .filter((key) => !query || [key.name, key.remark].some((value) => String(value || '').toLowerCase().includes(query)))
        .slice(0, limit).map(publicKey);
}
function validateKey(key) {
    const privateKey = String(key.privateKey || '');
    const valid = /^-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]+ PRIVATE KEY-----$/.test(privateKey.trim());
    return { valid, algorithm: classify(privateKey), fingerprint: privateKey ? fingerprint(privateKey) : '', hasPassphrase: !!key.passphrase };
}
function renameKey(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'sshKey', String(args.sshKeyId), 'edit');
    assertRevision(current, args.expectedRevision);
    const saved = resourceService.updateOwned(user, 'sshKey', String(args.sshKeyId), {
        name: String(args.name || '').trim(), privateKey: current.privateKey || '', passphrase: current.passphrase || '', remark: current.remark || '', updatedAt: Date.now(),
    });
    return publicKey(saved);
}
function updateMetadata(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'sshKey', String(args.sshKeyId), 'edit');
    assertRevision(current, args.expectedRevision);
    const saved = resourceService.updateOwned(user, 'sshKey', String(args.sshKeyId), {
        name: current.name, privateKey: current.privateKey || '', passphrase: current.passphrase || '', remark: args.remark === undefined ? current.remark || '' : String(args.remark), updatedAt: Date.now(),
    });
    return publicKey(saved);
}
function deleteKey(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'sshKey', String(args.sshKeyId), 'delete');
    assertRevision(current, args.expectedRevision);
    resourceService.deleteOwned(user, 'sshKey', String(args.sshKeyId));
    return { sshKeyId: String(args.sshKeyId), deleted: true, revision: revisionOf(current) };
}

module.exports = {
    SSH_KEY_LIST_SCHEMA, SSH_KEY_GET_SCHEMA, SSH_KEY_RENAME_SCHEMA, SSH_KEY_UPDATE_METADATA_SCHEMA, SSH_KEY_DELETE_SCHEMA, SSH_KEY_VALIDATE_SCHEMA,
    publicKey, listKeys, validateKey, renameKey, updateMetadata, deleteKey, revisionOf,
};
