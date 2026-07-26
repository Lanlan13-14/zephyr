'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');

const JUMP_HOST_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'number', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
});

const JUMP_HOST_GET_SCHEMA = Object.freeze({
    type: 'object',
    properties: { jumpHostId: { type: 'string', minLength: 1 } },
    required: ['jumpHostId'],
    additionalProperties: false,
});

const JUMP_HOST_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        connectionId: { type: 'string', minLength: 1, maxLength: 120 },
    },
    required: ['name', 'connectionId'],
    additionalProperties: false,
});

const JUMP_HOST_UPDATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        jumpHostId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        connectionId: { type: 'string', minLength: 1, maxLength: 120 },
    },
    required: ['jumpHostId', 'expectedRevision'],
    additionalProperties: false,
});

const JUMP_HOST_DELETE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        jumpHostId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['jumpHostId', 'expectedRevision'],
    additionalProperties: false,
});

function revisionOf(item) {
    return Math.max(1, Number(item?.revision) || 1);
}

function assertRevision(item, expectedRevision) {
    if (revisionOf(item) !== Number(expectedRevision)) {
        throw new HttpError(409, 'revision_conflict', '跳板机已被其他操作修改，请重新读取后再重试', true);
    }
}

function normalize(input = {}) {
    const name = String(input.name || '').trim();
    const connectionId = String(input.connectionId || '').trim();
    if (!name || !connectionId) throw new HttpError(400, 'invalid_jump_host', '跳板机名称和 SSH 连接不能为空');
    return { name: name.slice(0, 120), connectionId: connectionId.slice(0, 120) };
}

function assertSshConnection(user, connectionId, resourceService) {
    const connection = resourceService.getConnection(user, String(connectionId));
    if (String(connection.protocol || '').toUpperCase() !== 'SSH') {
        throw new HttpError(400, 'invalid_jump_connection', '跳板机必须引用 SSH 连接');
    }
    if (!Array.isArray(connection.capabilities) || !connection.capabilities.includes('use')) {
        throw new HttpError(403, 'forbidden_jump_connection', '无权使用该 SSH 连接作为跳板机');
    }
    return connection;
}

function publicJumpHost(item = {}, connection = null) {
    return {
        id: String(item.id || ''),
        name: String(item.name || ''),
        connectionId: String(item.connectionId || ''),
        connection: connection ? {
            id: String(connection.id || ''),
            name: String(connection.name || ''),
            host: String(connection.host || ''),
            port: Number(connection.port) || 22,
            username: String(connection.username || ''),
            protocol: String(connection.protocol || 'SSH').toUpperCase(),
        } : null,
        revision: revisionOf(item),
    };
}

function createJumpHost(user, args, resourceService) {
    const data = normalize(args);
    const connection = assertSshConnection(user, data.connectionId, resourceService);
    const saved = resourceService.createOwned(user, 'jumpHost', {
        id: crypto.randomUUID(),
        ...data,
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });
    return publicJumpHost(saved, connection);
}

function updateJumpHost(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'jumpHost', String(args.jumpHostId), 'edit');
    assertRevision(current, args.expectedRevision);
    const data = normalize({
        name: args.name ?? current.name,
        connectionId: args.connectionId ?? current.connectionId,
    });
    const connection = assertSshConnection(user, data.connectionId, resourceService);
    const saved = resourceService.updateOwned(user, 'jumpHost', String(args.jumpHostId), {
        ...data,
        updatedAt: Date.now(),
    });
    return publicJumpHost(saved, connection);
}

function deleteJumpHost(user, args, resourceService) {
    const current = resourceService.getRawAuthorized(user, 'jumpHost', String(args.jumpHostId), 'delete');
    assertRevision(current, args.expectedRevision);
    resourceService.deleteOwned(user, 'jumpHost', String(args.jumpHostId));
    return { jumpHostId: String(args.jumpHostId), deleted: true, revision: revisionOf(current) };
}

module.exports = {
    JUMP_HOST_LIST_SCHEMA,
    JUMP_HOST_GET_SCHEMA,
    JUMP_HOST_CREATE_SCHEMA,
    JUMP_HOST_UPDATE_SCHEMA,
    JUMP_HOST_DELETE_SCHEMA,
    createJumpHost,
    updateJumpHost,
    deleteJumpHost,
    publicJumpHost,
    revisionOf,
};
