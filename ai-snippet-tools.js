'use strict';

const crypto = require('crypto');
const { HttpError } = require('./authz');

const SNIPPET_LIST_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        query: { type: 'string', maxLength: 200 },
        group: { type: 'string', maxLength: 80 },
        autoRun: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 500 },
    },
    additionalProperties: false,
});

const SNIPPET_GET_SCHEMA = Object.freeze({
    type: 'object',
    properties: { snippetId: { type: 'string', minLength: 1 } },
    required: ['snippetId'],
    additionalProperties: false,
});

const SNIPPET_CREATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1, maxLength: 60 },
        command: { type: 'string', minLength: 1, maxLength: 20000 },
        group: { type: 'string', maxLength: 40 },
        autoRun: { type: 'boolean' },
    },
    required: ['name', 'command'],
    additionalProperties: false,
});

const SNIPPET_UPDATE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        snippetId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
        name: { type: 'string', minLength: 1, maxLength: 60 },
        command: { type: 'string', minLength: 1, maxLength: 20000 },
        group: { type: 'string', maxLength: 40 },
        autoRun: { type: 'boolean' },
    },
    required: ['snippetId', 'expectedRevision'],
    additionalProperties: false,
});

const SNIPPET_DELETE_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        snippetId: { type: 'string', minLength: 1 },
        expectedRevision: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['snippetId', 'expectedRevision'],
    additionalProperties: false,
});

function revisionOf(item) {
    return Math.max(1, Number(item?.revision) || 1);
}

function assertRevision(item, expectedRevision) {
    if (revisionOf(item) !== Number(expectedRevision)) {
        throw new HttpError(409, 'revision_conflict', '代码片段已被其他操作修改，请重新读取后再重试', true);
    }
}

function normalize(input = {}, old = null) {
    const name = String(input.name ?? old?.name ?? '').trim();
    const command = String(input.command ?? old?.command ?? '');
    if (!name || !command.trim()) throw new HttpError(400, 'invalid_snippet', '代码片段名称和命令不能为空');
    return {
        id: String(input.snippetId || input.id || old?.id || crypto.randomUUID()).slice(0, 120),
        name: name.slice(0, 60),
        command: command.slice(0, 20000),
        group: String(input.group ?? old?.group ?? '').trim().slice(0, 40),
        autoRun: input.autoRun !== undefined ? !!input.autoRun : !!old?.autoRun,
        revision: revisionOf(old),
        createdAt: Number(old?.createdAt || Date.now()),
        updatedAt: Date.now(),
    };
}

function publicSnippet(item = {}) {
    return {
        id: String(item.id || ''),
        name: String(item.name || ''),
        command: String(item.command || ''),
        group: String(item.group || ''),
        autoRun: !!item.autoRun,
        revision: revisionOf(item),
        createdAt: Number(item.createdAt || 0),
        updatedAt: Number(item.updatedAt || 0),
    };
}

function listSnippets(user, args, userSettingsService) {
    const overrides = userSettingsService.getUserOverrides(user.userId);
    let snippets = Array.isArray(overrides.snippets) ? overrides.snippets : [];
    const query = String(args.query || '').trim().toLowerCase();
    const group = String(args.group || '').trim().toLowerCase();
    if (query) snippets = snippets.filter((item) => [item.name, item.command, item.group].some((value) => String(value || '').toLowerCase().includes(query)));
    if (group) snippets = snippets.filter((item) => String(item.group || '').toLowerCase() === group);
    if (args.autoRun !== undefined) snippets = snippets.filter((item) => !!item.autoRun === !!args.autoRun);
    return snippets.slice(0, Math.max(1, Math.min(500, Number(args.limit) || 100))).map(publicSnippet);
}

function getSnippet(user, snippetId, userSettingsService) {
    const item = listSnippets(user, { limit: 500 }, userSettingsService).find((snippet) => snippet.id === String(snippetId));
    if (!item) throw new HttpError(404, 'resource_not_found_or_inaccessible', '代码片段不存在或无权访问');
    return item;
}

function writeSnippets(user, snippets, userSettingsService) {
    userSettingsService.putUserOverrides(user.userId, { snippets: snippets.slice(0, 500) });
}

function createSnippet(user, args, userSettingsService) {
    const current = listSnippets(user, { limit: 500 }, userSettingsService);
    const item = normalize(args);
    item.revision = 1;
    writeSnippets(user, [item, ...current], userSettingsService);
    return publicSnippet(item);
}

function updateSnippet(user, args, userSettingsService) {
    const current = listSnippets(user, { limit: 500 }, userSettingsService);
    const index = current.findIndex((item) => item.id === String(args.snippetId));
    if (index < 0) throw new HttpError(404, 'resource_not_found_or_inaccessible', '代码片段不存在或无权访问');
    assertRevision(current[index], args.expectedRevision);
    const item = normalize(args, current[index]);
    item.revision = revisionOf(current[index]) + 1;
    current[index] = item;
    writeSnippets(user, current, userSettingsService);
    return publicSnippet(item);
}

function deleteSnippet(user, args, userSettingsService) {
    const current = listSnippets(user, { limit: 500 }, userSettingsService);
    const index = current.findIndex((item) => item.id === String(args.snippetId));
    if (index < 0) throw new HttpError(404, 'resource_not_found_or_inaccessible', '代码片段不存在或无权访问');
    assertRevision(current[index], args.expectedRevision);
    const [deleted] = current.splice(index, 1);
    writeSnippets(user, current, userSettingsService);
    return { snippetId: String(args.snippetId), deleted: true, revision: revisionOf(deleted) };
}

module.exports = {
    SNIPPET_LIST_SCHEMA,
    SNIPPET_GET_SCHEMA,
    SNIPPET_CREATE_SCHEMA,
    SNIPPET_UPDATE_SCHEMA,
    SNIPPET_DELETE_SCHEMA,
    listSnippets,
    getSnippet,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    publicSnippet,
    revisionOf,
};
