'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');

const CONNECTION_PROTOCOLS = Object.freeze(['SSH', 'TELNET', 'RDP', 'VNC']);
const CONNECTION_MODES = Object.freeze(['direct', 'proxy', 'jump']);

const CONNECTION_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        protocol: { type: 'string', enum: CONNECTION_PROTOCOLS },
        host: { type: 'string', minLength: 1, maxLength: 255 },
        port: { type: 'number', minimum: 1, maximum: 65535 },
        username: { type: 'string', maxLength: 120 },
        sshKeyId: { type: 'string', maxLength: 120 },
        sshKeySecretRef: { type: 'string', maxLength: 4000 },
        remark: { type: 'string', maxLength: 20000 },
        tags: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 50 },
        connectionMode: { type: 'string', enum: CONNECTION_MODES },
        proxyId: { type: 'string', maxLength: 120 },
        jumpHostIds: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 12 },
        encoding: { type: 'string', maxLength: 80 },
    },
    required: ['name', 'protocol', 'host'],
    additionalProperties: false,
});

const CONNECTION_UPDATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
        protocol: { type: 'string', enum: CONNECTION_PROTOCOLS },
        name: { type: 'string', minLength: 1, maxLength: 120 },
        host: { type: 'string', minLength: 1, maxLength: 255 },
        port: { type: 'number', minimum: 1, maximum: 65535 },
        username: { type: 'string', maxLength: 120 },
        sshKeyId: { type: 'string', maxLength: 120 },
        sshKeySecretRef: { type: 'string', maxLength: 4000 },
        remark: { type: 'string', maxLength: 20000 },
        tags: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 50 },
        connectionMode: { type: 'string', enum: CONNECTION_MODES },
        proxyId: { type: 'string', maxLength: 120 },
        jumpHostIds: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 12 },
        encoding: { type: 'string', maxLength: 80 },
    },
    required: ['connectionId', 'expectedRevision'],
    additionalProperties: false,
});

const CONNECTION_DELETE_SCHEMA = Object.freeze({
    type: 'object',
    properties: { connectionId: { type: 'string', minLength: 1 }, expectedRevision: { type: 'number', exclusiveMinimum: 0 } },
    required: ['connectionId', 'expectedRevision'],
    additionalProperties: false,
});

const CONNECTION_TEST_SCHEMA = Object.freeze({
    type: 'object',
    properties: { connectionId: { type: 'string', minLength: 1 }, timeoutSeconds: { type: 'number', minimum: 1, maximum: 30 } },
    required: ['connectionId'],
    additionalProperties: false,
});

const CONNECTION_OPEN_SCHEMA = Object.freeze({
    type: 'object',
    properties: { connectionId: { type: 'string', minLength: 1 } },
    required: ['connectionId'],
    additionalProperties: false,
});

function defaultPort(protocol) {
    if (protocol === 'TELNET') return 23;
    if (protocol === 'RDP') return 3389;
    if (protocol === 'VNC') return 5900;
    return 22;
}

function strings(value, limit = 50) {
    return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function revisionOf(connection) {
    return Math.max(1, Number(connection?.revision) || 1);
}

function conflict() {
    return new HttpError(409, 'revision_conflict', '连接已被其他操作修改，请重新读取后再重试', true);
}

function assertRevision(connection, expectedRevision) {
    if (revisionOf(connection) !== Number(expectedRevision)) throw conflict();
}

function applyProtocolRules(connection) {
    const protocol = String(connection.protocol || 'SSH').toUpperCase();
    if (!CONNECTION_PROTOCOLS.includes(protocol)) throw new HttpError(400, 'invalid_protocol', '不支持的连接协议');
    connection.protocol = protocol;
    connection.port = Number(connection.port) || defaultPort(protocol);
    connection.tags = strings(connection.tags);
    connection.connectionMode = CONNECTION_MODES.includes(connection.connectionMode) ? connection.connectionMode : 'direct';
    connection.sshKeyId = String(connection.sshKeyId || '');
    connection.encoding = String(connection.encoding || 'utf-8').slice(0, 80);
    if (protocol === 'TELNET') {
        connection.connectionMode = 'direct';
        connection.proxyId = null;
        connection.jumpHostId = null;
        connection.jumpHostIds = [];
        connection.sshKeyId = '';
        connection.privateKey = '';
    } else {
        connection.proxyId = connection.connectionMode === 'proxy' ? (connection.proxyId || null) : null;
        connection.jumpHostIds = connection.connectionMode === 'jump' ? strings(connection.jumpHostIds, 12) : [];
        connection.jumpHostId = connection.jumpHostIds[0] || null;
    }
    if (!String(connection.name || '').trim() || !String(connection.host || '').trim() || (protocol === 'SSH' && !String(connection.username || '').trim())) {
        throw new HttpError(400, 'invalid_connection', protocol === 'SSH' ? '名称、主机、用户名不能为空' : '名称、主机不能为空');
    }
    return connection;
}

function publicConnection(connection) {
    return {
        id: connection.id,
        name: connection.name,
        protocol: connection.protocol,
        host: connection.host,
        port: connection.port,
        username: connection.username,
        tags: connection.tags || [],
        remark: connection.remark || '',
        connectionMode: connection.connectionMode || 'direct',
        proxyId: connection.proxyId || '',
        jumpHostIds: connection.jumpHostIds || [],
        hasSshKey: !!connection.sshKeyId,
        encoding: connection.encoding || 'utf-8',
        hasPassword: !!connection.hasPassword,
        hasPrivateKey: !!connection.hasPrivateKey,
        revision: revisionOf(connection),
    };
}

function createConnection(user, args, resourceService) {
    const protocol = String(args.protocol || '').toUpperCase();
    const conn = applyProtocolRules({
        id: crypto.randomUUID(),
        name: String(args.name || '').trim(),
        protocol,
        host: String(args.host || '').trim(),
        port: args.port,
        username: String(args.username || '').trim(),
        password: '',
        privateKey: '',
        sshKeyId: String(args.sshKeyId || ''),
        remark: String(args.remark || ''),
        tags: args.tags || [],
        connectionMode: args.connectionMode || 'direct',
        proxyId: args.proxyId || null,
        jumpHostIds: args.jumpHostIds || [],
        encoding: args.encoding || 'utf-8',
        revision: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastConnectedAt: null,
    });
    return publicConnection(resourceService.createConnection(user, conn));
}

function updateConnection(user, args, resourceService) {
    const saved = resourceService.updateConnection(user, String(args.connectionId), (current) => {
        assertRevision(current, args.expectedRevision);
        const next = { ...current };
        for (const key of ['protocol', 'name', 'host', 'username', 'remark', 'sshKeyId', 'encoding', 'connectionMode', 'proxyId']) {
            if (args[key] !== undefined) next[key] = typeof args[key] === 'string' ? String(args[key]) : args[key];
        }
        if (args.port !== undefined) next.port = Number(args.port);
        if (args.tags !== undefined) next.tags = args.tags;
        if (args.jumpHostIds !== undefined) next.jumpHostIds = args.jumpHostIds;
        // Credentials are intentionally excluded from AI-facing schemas.
        // Dedicated human-only credential flows own those fields.
        return applyProtocolRules(next);
    });
    return publicConnection(saved);
}

function deleteConnection(user, args, resourceService) {
    const current = resourceService.getConnection(user, String(args.connectionId));
    assertRevision(current, args.expectedRevision);
    resourceService.deleteConnection(user, String(args.connectionId));
    return { connectionId: String(args.connectionId), deleted: true, revision: revisionOf(current) };
}

module.exports = {
    CONNECTION_CREATE_SCHEMA,
    CONNECTION_UPDATE_SCHEMA,
    CONNECTION_DELETE_SCHEMA,
    CONNECTION_TEST_SCHEMA,
    CONNECTION_OPEN_SCHEMA,
    createConnection,
    updateConnection,
    deleteConnection,
    publicConnection,
    revisionOf,
};
