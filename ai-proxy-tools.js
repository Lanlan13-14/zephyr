'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');

const PROXY_TYPES = Object.freeze(['socks5', 'http']);

const PROXY_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        query: { type: 'string', maxLength: 200 },
        type: { type: 'string', enum: PROXY_TYPES },
        limit: { type: 'number', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
});

const PROXY_GET_SCHEMA = Object.freeze({
    type: 'object',
    properties: { proxyId: { type: 'string', minLength: 1 } },
    required: ['proxyId'],
    additionalProperties: false,
});

const PROXY_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        host: { type: 'string', minLength: 1, maxLength: 255 },
        port: { type: 'number', minimum: 1, maximum: 65535 },
        type: { type: 'string', enum: PROXY_TYPES },
        username: { type: 'string', maxLength: 120 },
    },
    required: ['name', 'host', 'port'],
    additionalProperties: false,
});

const PROXY_UPDATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        proxyId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        host: { type: 'string', minLength: 1, maxLength: 255 },
        port: { type: 'number', minimum: 1, maximum: 65535 },
        type: { type: 'string', enum: PROXY_TYPES },
        username: { type: 'string', maxLength: 120 },
    },
    required: ['proxyId', 'expectedRevision'],
    additionalProperties: false,
});

const PROXY_DELETE_SCHEMA = Object.freeze({
    type: 'object',
    properties: { proxyId: { type: 'string', minLength: 1 }, expectedRevision: { type: 'number', exclusiveMinimum: 0 } },
    required: ['proxyId', 'expectedRevision'],
    additionalProperties: false,
});

function revisionOf(proxy) {
    return Math.max(1, Number(proxy?.revision) || 1);
}

function assertRevision(proxy, expectedRevision) {
    if (revisionOf(proxy) !== Number(expectedRevision)) {
        throw new HttpError(409, 'revision_conflict', '代理已被其他操作修改，请重新读取后再重试', true);
    }
}

function normalize(input = {}) {
    const type = String(input.type || 'socks5').toLowerCase();
    if (!PROXY_TYPES.includes(type)) throw new HttpError(400, 'invalid_proxy_type', '代理类型仅支持 socks5 或 http');
    const name = String(input.name || '').trim();
    const host = String(input.host || '').trim();
    const port = Number(input.port) || 0;
    if (!name || !host || port < 1 || port > 65535) throw new HttpError(400, 'invalid_proxy', '代理名称、主机和端口不能为空');
    return {
        name: name.slice(0, 120),
        host: host.slice(0, 255),
        port,
        type,
        username: String(input.username || '').trim().slice(0, 120),
    };
}

function publicProxy(proxy = {}) {
    return {
        id: String(proxy.id || ''),
        name: String(proxy.name || ''),
        host: String(proxy.host || ''),
        port: Number(proxy.port) || 0,
        type: String(proxy.type || 'socks5'),
        username: String(proxy.username || ''),
        hasPassword: !!proxy.hasPassword || !!proxy.password,
        revision: revisionOf(proxy),
    };
}

function createProxy(user, args, resourceService) {
    const data = normalize(args);
    const saved = resourceService.createOwned(user, 'proxy', {
        id: crypto.randomUUID(),
        ...data,
        password: '',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    return publicProxy(saved);
}

function updateProxy(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'proxy', String(args.proxyId), 'edit');
    assertRevision(current, args.expectedRevision);
    const next = normalize({
        name: args.name ?? current.name,
        host: args.host ?? current.host,
        port: args.port ?? current.port,
        type: args.type ?? current.type,
        username: args.username ?? current.username,
    });
    const saved = resourceService.updateOwned(user, 'proxy', String(args.proxyId), {
        ...next,
        password: current.password || '',
        updatedAt: Date.now(),
    });
    return publicProxy(saved);
}

function deleteProxy(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'proxy', String(args.proxyId), 'delete');
    assertRevision(current, args.expectedRevision);
    resourceService.deleteOwned(user, 'proxy', String(args.proxyId));
    return { proxyId: String(args.proxyId), deleted: true, revision: revisionOf(current) };
}

module.exports = {
    PROXY_LIST_SCHEMA,
    PROXY_GET_SCHEMA,
    PROXY_CREATE_SCHEMA,
    PROXY_UPDATE_SCHEMA,
    PROXY_DELETE_SCHEMA,
    createProxy,
    updateProxy,
    deleteProxy,
    publicProxy,
    revisionOf,
};
