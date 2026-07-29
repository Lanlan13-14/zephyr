'use strict';

const DOCKER_STATUS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
    },
    required: ['connectionId'],
    additionalProperties: false,
});

const DOCKER_PS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        all: { type: 'boolean' },
        limit: { type: 'number', minimum: 1, maximum: 500 },
    },
    required: ['connectionId'],
    additionalProperties: false,
});

const DOCKER_IMAGES_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        limit: { type: 'number', minimum: 1, maximum: 500 },
    },
    required: ['connectionId'],
    additionalProperties: false,
});

const DOCKER_CONTAINER_ACTION_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'remove', 'pause', 'unpause'] },
        container: { type: 'string', minLength: 1, maxLength: 200 },
        force: { type: 'boolean' },
    },
    required: ['connectionId', 'action', 'container'],
    additionalProperties: false,
});

const DOCKER_LOGS_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        container: { type: 'string', minLength: 1, maxLength: 200 },
        tail: { type: 'number', minimum: 1, maximum: 2000 },
        timestamps: { type: 'boolean' },
    },
    required: ['connectionId', 'container'],
    additionalProperties: false,
});

const DOCKER_PULL_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        image: { type: 'string', minLength: 1, maxLength: 300 },
        timeoutSeconds: { type: 'number', minimum: 10, maximum: 600 },
    },
    required: ['connectionId', 'image'],
    additionalProperties: false,
});

const DOCKER_MIRRORS_GET_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
    },
    required: ['connectionId'],
    additionalProperties: false,
});

const DOCKER_MIRRORS_SET_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        connectionId: { type: 'string', minLength: 1, maxLength: 160 },
        mirrors: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 20 },
        restart: { type: 'boolean' },
    },
    required: ['connectionId', 'mirrors'],
    additionalProperties: false,
});

function shellQuote(value = '') {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function parseJsonLines(raw = '') {
    return String(raw || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return { raw: line }; }
        });
}

function publicContainer(item = {}) {
    return {
        id: String(item.ID || item.Id || item.id || '').slice(0, 64),
        name: String(item.Names || item.Name || item.names || '').replace(/^\//, ''),
        image: String(item.Image || item.image || ''),
        status: String(item.Status || item.status || ''),
        state: String(item.State || item.state || ''),
        ports: String(item.Ports || item.ports || ''),
        createdAt: String(item.CreatedAt || item.createdAt || ''),
    };
}

function publicImage(item = {}) {
    return {
        id: String(item.ID || item.Id || item.id || '').slice(0, 80),
        repository: String(item.Repository || item.repository || ''),
        tag: String(item.Tag || item.tag || ''),
        size: String(item.Size || item.size || ''),
        createdAt: String(item.CreatedAt || item.createdAt || ''),
    };
}

function containerActionCommand(action, container, { force = false } = {}) {
    const target = shellQuote(container);
    switch (action) {
        case 'start': return `docker start ${target}`;
        case 'stop': return `docker stop ${target}`;
        case 'restart': return `docker restart ${target}`;
        case 'pause': return `docker pause ${target}`;
        case 'unpause': return `docker unpause ${target}`;
        case 'remove': return force ? `docker rm -f ${target}` : `docker rm ${target}`;
        default: {
            const error = new Error(`不支持的 docker action: ${action}`);
            error.code = 'invalid_docker_action';
            throw error;
        }
    }
}

function normalizeMirrors(list = []) {
    return [...new Set((Array.isArray(list) ? list : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 20);
}

function mirrorsSetScript(mirrors = []) {
    const mirrorsJson = JSON.stringify(normalizeMirrors(mirrors));
    const py = [
        'import json,sys',
        'src,dst,mirrors_raw=sys.argv[1],sys.argv[2],sys.argv[3]',
        'try:',
        '  data=json.load(open(src))',
        'except Exception:',
        '  data={}',
        'if not isinstance(data,dict): data={}',
        'data["registry-mirrors"]=json.loads(mirrors_raw)',
        'json.dump(data, open(dst,"w"), indent=2)',
        'print("ok")',
    ].join('\n');
    return [
        'set -e',
        'TMP=$(mktemp)',
        'OUT=$(mktemp)',
        'if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json > "$TMP"; else printf \'{}\' > "$TMP"; fi',
        `python3 -c ${shellQuote(py)} "$TMP" "$OUT" ${shellQuote(mirrorsJson)}`,
        'if [ -w /etc/docker ] || [ "$(id -u)" = "0" ]; then mkdir -p /etc/docker && cp "$OUT" /etc/docker/daemon.json; else sudo -n mkdir -p /etc/docker && sudo -n cp "$OUT" /etc/docker/daemon.json; fi',
        'rm -f "$TMP" "$OUT"',
        'echo __DOCKER_MIRRORS_SAVED__=1',
    ].join('\n');
}

module.exports = {
    DOCKER_STATUS_SCHEMA,
    DOCKER_PS_SCHEMA,
    DOCKER_IMAGES_SCHEMA,
    DOCKER_CONTAINER_ACTION_SCHEMA,
    DOCKER_LOGS_SCHEMA,
    DOCKER_PULL_SCHEMA,
    DOCKER_MIRRORS_GET_SCHEMA,
    DOCKER_MIRRORS_SET_SCHEMA,
    shellQuote,
    parseJsonLines,
    publicContainer,
    publicImage,
    containerActionCommand,
    normalizeMirrors,
    mirrorsSetScript,
};
