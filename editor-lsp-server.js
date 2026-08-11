const childProcess = require('child_process');
const path = require('path');

const spawn = (...args) => childProcess.spawn(...args);

const MAX_FRAME_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 20;
const MAX_JSON_NODES = 20000;
const MAX_PENDING_REQUESTS = 64;
const MAX_OPEN_DOCUMENTS = 64;
const OFFLINE_CHILD_ENV = 'ZEPHYR_EDITOR_LSP_OFFLINE_CHILD';
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 1000;
const DEFAULT_ADMISSION_LIMITS = Object.freeze({
    maxConnections: 32,
    maxConnectionsPerOwner: 4,
    maxYamlChildren: 16,
    maxYamlChildrenPerOwner: 2,
    globalRateLimit: 120,
    ownerRateLimit: 12,
    rateWindowMs: 60 * 1000,
});

const CLIENT_METHODS = new Map([
    ['initialize', 'request'],
    ['initialized', 'notification'],
    ['shutdown', 'request'],
    ['exit', 'notification'],
    ['$/cancelRequest', 'notification'],
    ['textDocument/didOpen', 'notification'],
    ['textDocument/didChange', 'notification'],
    ['textDocument/didClose', 'notification'],
    ['textDocument/completion', 'request'],
    ['textDocument/hover', 'request'],
    ['textDocument/formatting', 'request'],
]);
const YAML_CLIENT_METHODS = new Map([
    ['textDocument/definition', 'request'],
    ['textDocument/prepareRename', 'request'],
    ['textDocument/rename', 'request'],
]);

if (process.env[OFFLINE_CHILD_ENV] === '1') installOfflineChildGuard();

class RpcPolicyError extends Error {
    constructor(code, message, id = null, suppressResponse = false) {
        super(message);
        this.code = code;
        this.id = id;
        this.suppressResponse = suppressResponse;
    }
}

function installOfflineChildGuard() {
    const blockedError = () => Object.assign(new Error('External schema access is disabled'), { code: 'ERR_NETWORK_ACCESS_DENIED' });
    const blockedChildError = () => Object.assign(new Error('Child process creation is disabled'), { code: 'ERR_CHILD_PROCESS_DISABLED' });
    const blockSync = () => { throw blockedError(); };
    const blockAsync = () => Promise.reject(blockedError());
    const blockChildSync = () => { throw blockedChildError(); };

    for (const moduleName of ['http', 'https']) {
        const protocol = require(moduleName);
        protocol.request = blockSync;
        protocol.get = blockSync;
    }
    for (const moduleName of ['net', 'tls']) {
        const protocol = require(moduleName);
        protocol.connect = blockSync;
        protocol.createConnection = blockSync;
    }
    globalThis.fetch = blockAsync;
    try {
        const requestLight = require('request-light');
        requestLight.xhr = blockAsync;
    } catch {}
    try {
        for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
            Object.defineProperty(childProcess, method, {
                value: blockChildSync,
                configurable: false,
                enumerable: true,
                writable: false,
            });
        }
        Object.freeze(childProcess);
    } catch {}
}

function positiveLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

class EditorLspAdmissionController {
    constructor(options = {}) {
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.limits = {
            maxConnections: positiveLimit(options.maxConnections, DEFAULT_ADMISSION_LIMITS.maxConnections),
            maxConnectionsPerOwner: positiveLimit(options.maxConnectionsPerOwner, DEFAULT_ADMISSION_LIMITS.maxConnectionsPerOwner),
            maxYamlChildren: positiveLimit(options.maxYamlChildren, DEFAULT_ADMISSION_LIMITS.maxYamlChildren),
            maxYamlChildrenPerOwner: positiveLimit(options.maxYamlChildrenPerOwner, DEFAULT_ADMISSION_LIMITS.maxYamlChildrenPerOwner),
            globalRateLimit: positiveLimit(options.globalRateLimit, DEFAULT_ADMISSION_LIMITS.globalRateLimit),
            ownerRateLimit: positiveLimit(options.ownerRateLimit, DEFAULT_ADMISSION_LIMITS.ownerRateLimit),
            rateWindowMs: positiveLimit(options.rateWindowMs, DEFAULT_ADMISSION_LIMITS.rateWindowMs),
        };
        this.connectionCount = 0;
        this.yamlChildCount = 0;
        this.ownerConnections = new Map();
        this.ownerYamlChildren = new Map();
        this.globalAttempts = [];
        this.ownerAttempts = new Map();
    }

    _prune(timestamps, now) {
        const cutoff = now - this.limits.rateWindowMs;
        let firstLive = 0;
        while (firstLive < timestamps.length && timestamps[firstLive] <= cutoff) firstLive += 1;
        if (firstLive) timestamps.splice(0, firstLive);
        return timestamps;
    }

    _increment(map, key) {
        map.set(key, (map.get(key) || 0) + 1);
    }

    _decrement(map, key) {
        const next = (map.get(key) || 0) - 1;
        if (next > 0) map.set(key, next);
        else map.delete(key);
    }

    admit(ownerId, language) {
        const owner = String(ownerId || '').trim();
        if (!owner || owner.length > 128) return { ok: false, reason: 'identity' };
        const now = this.now();
        const ownerAttempts = this._prune(this.ownerAttempts.get(owner) || [], now);
        if (ownerAttempts.length >= this.limits.ownerRateLimit) return { ok: false, reason: 'owner_rate' };
        ownerAttempts.push(now);
        this.ownerAttempts.set(owner, ownerAttempts);

        this._prune(this.globalAttempts, now);
        if (this.globalAttempts.length >= this.limits.globalRateLimit) return { ok: false, reason: 'global_rate' };
        this.globalAttempts.push(now);

        const yaml = language === 'yaml';
        if (this.connectionCount >= this.limits.maxConnections) return { ok: false, reason: 'global_connections' };
        if ((this.ownerConnections.get(owner) || 0) >= this.limits.maxConnectionsPerOwner) {
            return { ok: false, reason: 'owner_connections' };
        }
        if (yaml && this.yamlChildCount >= this.limits.maxYamlChildren) return { ok: false, reason: 'global_children' };
        if (yaml && (this.ownerYamlChildren.get(owner) || 0) >= this.limits.maxYamlChildrenPerOwner) {
            return { ok: false, reason: 'owner_children' };
        }

        this.connectionCount += 1;
        this._increment(this.ownerConnections, owner);
        if (yaml) {
            this.yamlChildCount += 1;
            this._increment(this.ownerYamlChildren, owner);
        }
        let released = false;
        return {
            ok: true,
            ownerId: owner,
            release: () => {
                if (released) return;
                released = true;
                this.connectionCount = Math.max(0, this.connectionCount - 1);
                this._decrement(this.ownerConnections, owner);
                if (yaml) {
                    this.yamlChildCount = Math.max(0, this.yamlChildCount - 1);
                    this._decrement(this.ownerYamlChildren, owner);
                }
            },
        };
    }

    snapshot(ownerId = '') {
        const owner = String(ownerId || '');
        return {
            connections: this.connectionCount,
            yamlChildren: this.yamlChildCount,
            ownerConnections: this.ownerConnections.get(owner) || 0,
            ownerYamlChildren: this.ownerYamlChildren.get(owner) || 0,
        };
    }
}

const defaultAdmissionController = new EditorLspAdmissionController();

function loadJsonLanguageService() {
    try { return require('vscode-json-languageservice'); } catch { return null; }
}

function loadYamlTransport() {
    try {
        const {
            StreamMessageReader,
            StreamMessageWriter,
            createMessageConnection,
        } = require('vscode-languageserver-protocol/node');
        return { StreamMessageReader, StreamMessageWriter, createMessageConnection };
    } catch {
        return null;
    }
}

function frameByteLength(raw) {
    if (typeof raw === 'string') return Buffer.byteLength(raw, 'utf8');
    if (Buffer.isBuffer(raw)) return raw.length;
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return raw.byteLength;
    return Buffer.byteLength(String(raw), 'utf8');
}

function decodeRawFrame(raw) {
    if (frameByteLength(raw) > MAX_FRAME_BYTES) {
        throw new RpcPolicyError(-32600, 'Invalid Request');
    }
    if (typeof raw === 'string') return raw;
    if (Buffer.isBuffer(raw)) return raw.toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
    return String(raw);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeDecode(value) {
    let decoded = String(value);
    for (let i = 0; i < 2; i += 1) {
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) break;
            decoded = next;
        } catch {
            break;
        }
    }
    return decoded;
}

function isForbiddenExternalReference(value) {
    const decoded = safeDecode(value).trim();
    const compact = decoded.replace(/[\u0000-\u0020]+/g, '');
    return /(?:^|[^a-z0-9+.-])(?:https?|file):(?:\/\/|\\\\)/i.test(compact)
        || /^[a-z]:[\\/]/i.test(decoded)
        || /^\\\\[^\\]/.test(decoded)
        || /^\/\/[^/]/.test(decoded);
}

function isSafeDocumentUri(value) {
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) return false;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'file:' || parsed.hostname || parsed.username || parsed.password || parsed.port) return false;
        const decodedPath = safeDecode(parsed.pathname);
        if (!decodedPath.startsWith('/') || decodedPath.includes('\0') || decodedPath.includes('\\')) return false;
        return !decodedPath.split('/').includes('..');
    } catch {
        return false;
    }
}

function hasSchemaDirective(text, language) {
    if (language === 'yaml') {
        return /^\s*#\s*(?:yaml-language-server\s*:.*?\$schema(?:=|:\s*)|\$schema:\s*)\S+/im.test(text);
    }
    return /["']\$schema["']\s*:\s*["']\s*(?:(?:https?|file):|\\\\|\/\/|[a-z]:[\\/])/i.test(text);
}

function isDocumentTextPath(pathParts) {
    if (pathParts.length < 2 || pathParts[pathParts.length - 1] !== 'text') return false;
    return pathParts.includes('textDocument') || pathParts.includes('contentChanges');
}

function isPermittedFileUriPath(pathParts) {
    const leaf = pathParts[pathParts.length - 1];
    if (leaf === 'rootUri') return pathParts.includes('params');
    return leaf === 'uri' && pathParts.includes('textDocument');
}

function inspectJsonValue(value, language, state, pathParts = [], depth = 0) {
    if (depth > MAX_JSON_DEPTH) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
    state.nodes += 1;
    if (state.nodes > MAX_JSON_NODES) throw new RpcPolicyError(-32602, 'Invalid params', state.id);

    if (typeof value === 'string') {
        const bytes = Buffer.byteLength(value, 'utf8');
        if (isDocumentTextPath(pathParts)) {
            if (bytes > MAX_DOCUMENT_BYTES || hasSchemaDirective(value, language)) {
                throw new RpcPolicyError(-32602, 'Invalid params', state.id);
            }
            return;
        }
        if (bytes > MAX_STRING_BYTES) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
        if (isPermittedFileUriPath(pathParts)) {
            if (!isSafeDocumentUri(value)) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
            return;
        }
        if (isForbiddenExternalReference(value)) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
        return;
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000) {
            throw new RpcPolicyError(-32602, 'Invalid params', state.id);
        }
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            inspectJsonValue(value[index], language, state, pathParts.concat(String(index)), depth + 1);
        }
        return;
    }
    if (!isPlainObject(value)) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new RpcPolicyError(-32602, 'Invalid params', state.id);
        if (Buffer.byteLength(key, 'utf8') > 256 || isForbiddenExternalReference(key)) {
            throw new RpcPolicyError(-32602, 'Invalid params', state.id);
        }
        inspectJsonValue(value[key], language, state, pathParts.concat(key), depth + 1);
    }
}

function validateMethodParams(message) {
    const params = message.params;
    if (message.method === 'initialize') {
        if (!isPlainObject(params)) throw new RpcPolicyError(-32602, 'Invalid params', message.id);
        return;
    }
    if (message.method === 'initialized' || message.method === 'shutdown' || message.method === 'exit') return;
    if (!isPlainObject(params)) throw new RpcPolicyError(-32602, 'Invalid params', message.id);

    if (message.method === '$/cancelRequest') {
        if (!hasOwn(params, 'id') || (typeof params.id !== 'string' && typeof params.id !== 'number')) {
            throw new RpcPolicyError(-32602, 'Invalid params', message.id);
        }
        return;
    }
    const textDocument = params.textDocument;
    if (!isPlainObject(textDocument) || !isSafeDocumentUri(textDocument.uri)) {
        throw new RpcPolicyError(-32602, 'Invalid params', message.id);
    }
    if (message.method === 'textDocument/didOpen' && typeof textDocument.text !== 'string') {
        throw new RpcPolicyError(-32602, 'Invalid params', message.id);
    }
    if (message.method === 'textDocument/didChange') {
        if (!Array.isArray(params.contentChanges) || params.contentChanges.length < 1 || params.contentChanges.length > 128) {
            throw new RpcPolicyError(-32602, 'Invalid params', message.id);
        }
        for (const change of params.contentChanges) {
            if (!isPlainObject(change) || typeof change.text !== 'string') {
                throw new RpcPolicyError(-32602, 'Invalid params', message.id);
            }
        }
    }
}

function parseClientMessage(raw, language = 'yaml') {
    let message;
    try {
        message = JSON.parse(decodeRawFrame(raw));
    } catch (error) {
        if (error instanceof RpcPolicyError) throw error;
        throw new RpcPolicyError(-32700, 'Parse error');
    }
    const id = isPlainObject(message) && hasOwn(message, 'id') ? message.id : null;
    if (!isPlainObject(message) || message.jsonrpc !== '2.0' || !hasOwn(message, 'method') || typeof message.method !== 'string') {
        throw new RpcPolicyError(-32600, 'Invalid Request', id);
    }
    if (message.method.length < 1 || message.method.length > 128) {
        throw new RpcPolicyError(-32600, 'Invalid Request', id);
    }
    if (hasOwn(message, 'id') && !((typeof id === 'string' && id.length <= 128) || (typeof id === 'number' && Number.isFinite(id)))) {
        throw new RpcPolicyError(-32600, 'Invalid Request');
    }
    const mode = CLIENT_METHODS.get(message.method)
        || (language === 'yaml' ? YAML_CLIENT_METHODS.get(message.method) : undefined);
    if (!mode) throw new RpcPolicyError(-32601, 'Method not found', id, !hasOwn(message, 'id'));
    if ((mode === 'request') !== hasOwn(message, 'id')) {
        throw new RpcPolicyError(-32600, 'Invalid Request', id);
    }
    if (hasOwn(message, 'params') && message.params !== null && typeof message.params !== 'object') {
        throw new RpcPolicyError(-32602, 'Invalid params', id);
    }
    try {
        inspectJsonValue(message, language, { id, nodes: 0 });
        validateMethodParams(message);
    } catch (error) {
        if (error instanceof RpcPolicyError && mode === 'notification') error.suppressResponse = true;
        throw error;
    }
    return message;
}

function positionToOffset(text, position) {
    if (!isPlainObject(position)
        || !Number.isInteger(position.line)
        || !Number.isInteger(position.character)
        || position.line < 0
        || position.character < 0) {
        throw new RpcPolicyError(-32602, 'Invalid params');
    }
    let lineStart = 0;
    for (let line = 0; line < position.line; line += 1) {
        const newline = text.indexOf('\n', lineStart);
        if (newline < 0) throw new RpcPolicyError(-32602, 'Invalid params');
        lineStart = newline + 1;
    }
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd;
    if (lineStart + position.character > contentEnd) throw new RpcPolicyError(-32602, 'Invalid params');
    return lineStart + position.character;
}

function applyDocumentChanges(currentText, changes, language) {
    let text = currentText;
    for (const change of changes) {
        if (!hasOwn(change, 'range')) {
            text = change.text;
        } else {
            if (!isPlainObject(change.range)) throw new RpcPolicyError(-32602, 'Invalid params');
            const start = positionToOffset(text, change.range.start);
            const end = positionToOffset(text, change.range.end);
            if (start > end) throw new RpcPolicyError(-32602, 'Invalid params');
            text = text.slice(0, start) + change.text + text.slice(end);
        }
        if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES || hasSchemaDirective(text, language)) {
            throw new RpcPolicyError(-32602, 'Invalid params');
        }
    }
    return text;
}

function safeInitializeParams() {
    return {
        processId: null,
        rootUri: null,
        capabilities: {
            workspace: { configuration: true },
            textDocument: {
                completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
                hover: { contentFormat: ['markdown', 'plaintext'] },
                formatting: { dynamicRegistration: false },
            },
        },
    };
}

function safeYamlConfiguration() {
    return {
        validate: true,
        hover: true,
        completion: true,
        format: { enable: true, singleQuote: false, bracketSpacing: true, proseWrap: 'preserve', printWidth: 100 },
        schemas: {},
        schemaStore: { enable: false },
        kubernetesCRDStore: { enable: false, url: '' },
        yamlVersion: '1.2',
        customTags: [],
        disableDefaultProperties: false,
        maxItemsComputed: 5000,
        keyOrdering: false,
    };
}

function sendJson(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') <= MAX_FRAME_BYTES) ws.send(encoded);
}

function sendRpcError(ws, error) {
    if (error.suppressResponse) return;
    sendJson(ws, {
        jsonrpc: '2.0',
        id: error.id ?? null,
        error: { code: error.code || -32603, message: error.message || 'Internal error' },
    });
}

function decodeOrReject(ws, raw, language) {
    try {
        return parseClientMessage(raw, language);
    } catch (error) {
        sendRpcError(ws, error instanceof RpcPolicyError ? error : new RpcPolicyError(-32603, 'Internal error'));
        return null;
    }
}

function killChildProcessTree(child, options = {}) {
    const pid = Number(child?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        try { child?.kill?.('SIGKILL'); } catch {}
        return;
    }
    const platform = options.platform || process.platform;
    const spawnProcess = options.spawnProcess || spawn;
    const processKill = options.processKill || process.kill.bind(process);
    if (platform === 'win32') {
        try {
            const killer = spawnProcess('taskkill', ['/pid', String(pid), '/t', '/f'], {
                stdio: 'ignore',
                windowsHide: true,
            });
            killer?.once?.('error', () => {
                try { child.kill('SIGKILL'); } catch {}
            });
            killer?.unref?.();
            return;
        } catch {}
    } else {
        try {
            processKill(-pid, 'SIGKILL');
            return;
        } catch {}
    }
    try { child.kill('SIGKILL'); } catch {}
}

function timeoutValue(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function createLspConnectionLifecycle(ws, options = {}) {
    const initializationTimeoutMs = timeoutValue(options.initializationTimeoutMs, DEFAULT_INITIALIZATION_TIMEOUT_MS);
    const idleTimeoutMs = timeoutValue(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    const abortController = new AbortController();
    const openDocuments = new Set();
    let initialized = false;
    let pendingRequests = 0;
    let stopped = false;
    let initializationTimer = null;
    let idleTimer = null;

    const clearTimer = (timer) => {
        if (timer) cancel(timer);
    };
    const refreshIdleTimer = () => {
        clearTimer(idleTimer);
        idleTimer = null;
        if (stopped || !initialized || openDocuments.size || pendingRequests) return;
        idleTimer = schedule(() => {
            terminate(1001, 'Language server idle timeout');
        }, idleTimeoutMs);
        idleTimer?.unref?.();
    };
    const terminate = (closeCode, closeReason, closeSocket = true) => {
        if (stopped) return;
        stopped = true;
        clearTimer(initializationTimer);
        clearTimer(idleTimer);
        initializationTimer = null;
        idleTimer = null;
        abortController.abort();
        try { options.onTerminate?.(); } catch {}
        if (closeSocket && ws.readyState === ws.OPEN) {
            try { ws.close(closeCode, closeReason); } catch {}
        }
    };

    ws.once('close', () => terminate(null, '', false));
    ws.once('error', () => terminate(null, '', false));
    initializationTimer = schedule(() => {
        terminate(1008, 'Language server initialization timed out');
    }, initializationTimeoutMs);
    initializationTimer?.unref?.();

    return {
        signal: abortController.signal,
        get initialized() { return initialized; },
        get stopped() { return stopped; },
        get pendingRequests() { return pendingRequests; },
        get openDocumentCount() { return openDocuments.size; },
        markInitialized() {
            if (stopped || initialized) return;
            initialized = true;
            clearTimer(initializationTimer);
            initializationTimer = null;
            refreshIdleTimer();
        },
        touch() {
            refreshIdleTimer();
        },
        openDocument(uri) {
            if (stopped) return;
            openDocuments.add(uri);
            refreshIdleTimer();
        },
        closeDocument(uri) {
            openDocuments.delete(uri);
            refreshIdleTimer();
        },
        beginRequest() {
            if (stopped) return () => {};
            pendingRequests += 1;
            refreshIdleTimer();
            let ended = false;
            return () => {
                if (ended) return;
                ended = true;
                pendingRequests = Math.max(0, pendingRequests - 1);
                refreshIdleTimer();
            };
        },
        terminate,
    };
}

function wireJsonLanguageServer(ws, options = {}) {
    const lifecycle = createLspConnectionLifecycle(ws, options);
    const service = loadJsonLanguageService();
    if (!service) {
        lifecycle.terminate(1011, 'JSON language service is unavailable');
        return lifecycle;
    }
    const { getLanguageService, TextDocument } = service;
    const documents = new Map();
    const pendingRequestIds = new Set();
    const jsonService = getLanguageService({
        schemaRequestService: () => Promise.reject(new Error('External schemas are disabled')),
    });
    const notifyDiagnostics = async (uri) => {
        const doc = documents.get(uri);
        if (!doc) return;
        try {
            const jsonDoc = jsonService.parseJSONDocument(doc);
            const diagnostics = await jsonService.doValidation(doc, jsonDoc);
            sendJson(ws, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
        } catch {}
    };
    ws.on('message', async (raw) => {
        if (lifecycle.stopped) return;
        const msg = decodeOrReject(ws, raw, 'json');
        if (!msg) return;
        lifecycle.touch();
        const id = msg.id;
        let pendingKey = null;
        let endRequest = () => {};
        if (hasOwn(msg, 'id')) {
            pendingKey = `${typeof id}:${String(id)}`;
            if (pendingRequestIds.size >= MAX_PENDING_REQUESTS || pendingRequestIds.has(pendingKey)) {
                sendRpcError(ws, new RpcPolicyError(-32600, 'Invalid Request', id));
                return;
            }
            pendingRequestIds.add(pendingKey);
            endRequest = lifecycle.beginRequest();
        }
        try {
            if (msg.method === 'initialize') {
                sendJson(ws, { jsonrpc: '2.0', id, result: {
                    capabilities: {
                        textDocumentSync: 1,
                        completionProvider: { resolveProvider: false, triggerCharacters: ['"', ':'] },
                        hoverProvider: true,
                        documentFormattingProvider: true,
                    }
                }});
            } else if (msg.method === 'initialized') {
                lifecycle.markInitialized();
                return;
            } else if (msg.method === 'exit') {
                lifecycle.terminate(1000, 'Language server exited');
                return;
            } else if (msg.method === 'shutdown') {
                sendJson(ws, { jsonrpc: '2.0', id, result: null });
            } else if (msg.method === 'textDocument/didOpen') {
                const td = msg.params.textDocument;
                if (!documents.has(td.uri) && documents.size >= MAX_OPEN_DOCUMENTS) {
                    throw new RpcPolicyError(-32602, 'Invalid params', id);
                }
                documents.set(td.uri, TextDocument.create(td.uri, 'json', td.version || 1, td.text));
                lifecycle.openDocument(td.uri);
                void notifyDiagnostics(td.uri);
            } else if (msg.method === 'textDocument/didChange') {
                const uri = msg.params.textDocument.uri;
                const current = documents.get(uri);
                const text = msg.params.contentChanges[0].text;
                if (!current) throw new RpcPolicyError(-32602, 'Invalid params', id);
                documents.set(uri, TextDocument.create(uri, 'json', msg.params.textDocument.version || current.version + 1, text));
                void notifyDiagnostics(uri);
            } else if (msg.method === 'textDocument/didClose') {
                const uri = msg.params.textDocument.uri;
                documents.delete(uri);
                lifecycle.closeDocument(uri);
                sendJson(ws, { jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
            } else if (msg.method === 'textDocument/completion') {
                const uri = msg.params.textDocument.uri;
                const doc = documents.get(uri);
                const result = doc ? await jsonService.doComplete(doc, msg.params.position, jsonService.parseJSONDocument(doc)) : { isIncomplete: false, items: [] };
                sendJson(ws, { jsonrpc: '2.0', id, result });
            } else if (msg.method === 'textDocument/hover') {
                const uri = msg.params.textDocument.uri;
                const doc = documents.get(uri);
                const result = doc ? await jsonService.doHover(doc, msg.params.position, jsonService.parseJSONDocument(doc)) : null;
                sendJson(ws, { jsonrpc: '2.0', id, result });
            } else if (msg.method === 'textDocument/formatting') {
                const uri = msg.params.textDocument.uri;
                const doc = documents.get(uri);
                const result = doc ? jsonService.format(doc, undefined, { tabSize: 2, insertSpaces: true }) : [];
                sendJson(ws, { jsonrpc: '2.0', id, result });
            }
        } catch (error) {
            if (hasOwn(msg, 'id')) {
                sendRpcError(ws, error instanceof RpcPolicyError ? error : new RpcPolicyError(-32603, 'Language server request failed', id));
            }
        } finally {
            if (pendingKey) pendingRequestIds.delete(pendingKey);
            endRequest();
        }
    });
    return lifecycle;
}

function startYamlLanguageServer(ws, options = {}) {
    let cleanupRuntime = () => {};
    const lifecycle = createLspConnectionLifecycle(ws, {
        ...options,
        onTerminate: () => {
            cleanupRuntime();
            options.onTerminate?.();
        },
    });
    const transport = options.transport || loadYamlTransport();
    if (!transport) {
        lifecycle.terminate(1011, 'YAML language service is unavailable');
        return lifecycle;
    }
    const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = transport;
    const bin = path.join(__dirname, 'node_modules', 'yaml-language-server', 'bin', 'yaml-language-server');
    const spawnProcess = options.spawnProcess || spawn;
    let child;
    let connection;
    try {
        child = spawnProcess(process.execPath, ['--require', __filename, bin, '--stdio'], {
            cwd: __dirname,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, [OFFLINE_CHILD_ENV]: '1', NODE_ENV: process.env.NODE_ENV || 'production' },
        });
        child.once('error', () => {
            lifecycle.terminate(1011, 'YAML language service failed');
        });
        connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    } catch {
        if (child) killChildProcessTree(child, { spawnProcess });
        lifecycle.terminate(1011, 'YAML language service failed');
        return lifecycle;
    }
    const openDocuments = new Map();
    const pendingRequests = new Set();
    let stderrReported = false;
    let cleanedUp = false;

    cleanupRuntime = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        try { connection.dispose(); } catch {}
        try {
            (options.killChildTree || killChildProcessTree)(child, { spawnProcess });
        } catch {
            try { child.kill('SIGKILL'); } catch {}
        }
    };

    try {
        connection.onNotification((method, params) => {
            if (method === 'textDocument/publishDiagnostics') {
                sendJson(ws, { jsonrpc: '2.0', method, params });
            }
        });
        connection.onRequest((method, params) => {
            if (method === 'workspace/configuration') {
                const items = Array.isArray(params?.items) ? params.items.slice(0, 32) : [];
                return items.map(() => safeYamlConfiguration());
            }
            if (method === 'client/registerCapability' || method === 'client/unregisterCapability') return null;
            if (method === 'workspace/workspaceFolders') return [];
            throw Object.assign(new Error('Method not found'), { code: -32601 });
        });
        connection.listen();
    } catch {
        lifecycle.terminate(1011, 'YAML language service failed');
        return lifecycle;
    }

    ws.on('message', (raw) => {
        if (lifecycle.stopped) return;
        const msg = decodeOrReject(ws, raw, 'yaml');
        if (!msg) return;
        lifecycle.touch();
        const id = msg.id;
        try {
            if (msg.method === 'textDocument/didOpen') {
                const uri = msg.params.textDocument.uri;
                if (!openDocuments.has(uri) && openDocuments.size >= MAX_OPEN_DOCUMENTS) {
                    throw new RpcPolicyError(-32602, 'Invalid params', id);
                }
                openDocuments.set(uri, msg.params.textDocument.text);
                lifecycle.openDocument(uri);
            } else if (msg.method === 'textDocument/didChange') {
                const uri = msg.params.textDocument.uri;
                if (!openDocuments.has(uri)) throw new RpcPolicyError(-32602, 'Invalid params', id);
                try {
                    openDocuments.set(uri, applyDocumentChanges(openDocuments.get(uri), msg.params.contentChanges, 'yaml'));
                } catch (error) {
                    if (error instanceof RpcPolicyError) {
                        error.id = id;
                        error.suppressResponse = !hasOwn(msg, 'id');
                    }
                    throw error;
                }
            } else if (msg.method === 'textDocument/didClose') {
                openDocuments.delete(msg.params.textDocument.uri);
                lifecycle.closeDocument(msg.params.textDocument.uri);
            } else if (msg.method === 'initialized') {
                lifecycle.markInitialized();
            }

            const params = msg.method === 'initialize' ? safeInitializeParams() : msg.params;
            if (hasOwn(msg, 'id')) {
                const pendingKey = `${typeof id}:${String(id)}`;
                if (pendingRequests.size >= MAX_PENDING_REQUESTS || pendingRequests.has(pendingKey)) {
                    throw new RpcPolicyError(-32600, 'Invalid Request', id);
                }
                pendingRequests.add(pendingKey);
                const endRequest = lifecycle.beginRequest();
                let request;
                try {
                    request = connection.sendRequest(msg.method, params);
                } catch (error) {
                    pendingRequests.delete(pendingKey);
                    endRequest();
                    throw error;
                }
                Promise.resolve(request).then(
                    (result) => sendJson(ws, { jsonrpc: '2.0', id, result }),
                    () => sendRpcError(ws, new RpcPolicyError(-32603, 'Language server request failed', id))
                ).finally(() => {
                    pendingRequests.delete(pendingKey);
                    endRequest();
                });
            } else {
                connection.sendNotification(msg.method, params);
                if (msg.method === 'exit') lifecycle.terminate(1000, 'Language server exited');
            }
        } catch (error) {
            if (hasOwn(msg, 'id')) {
                sendRpcError(ws, error instanceof RpcPolicyError ? error : new RpcPolicyError(-32603, 'Language server request failed', id));
            }
        }
    });

    child.stderr.on('data', () => {
        if (!stderrReported) {
            stderrReported = true;
            console.warn('[editor-yaml-lsp] language server reported an error');
        }
    });
    child.on('exit', () => {
        if (!cleanedUp) {
            cleanedUp = true;
            try { connection.dispose(); } catch {}
        }
        lifecycle.terminate(1011, 'YAML language service stopped');
    });
    return lifecycle;
}

function handleEditorLspConnection(ws, req, context = {}) {
    let language;
    try {
        const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
        language = String(url.searchParams.get('language') || 'yaml').toLowerCase();
    } catch {
        ws.close(1008, 'Invalid language server request');
        return null;
    }
    if (language !== 'json' && language !== 'yaml') {
        ws.close(1008, 'Unsupported editor language');
        return null;
    }

    const admissionController = context.admissionController || defaultAdmissionController;
    const lease = admissionController.admit(context.ownerId, language);
    if (!lease.ok) {
        ws.close(lease.reason === 'identity' ? 1008 : 1013, 'Language server capacity unavailable');
        return null;
    }
    const runtimeOptions = {
        initializationTimeoutMs: context.initializationTimeoutMs,
        idleTimeoutMs: context.idleTimeoutMs,
        setTimeout: context.setTimeout,
        clearTimeout: context.clearTimeout,
        spawnProcess: context.spawnProcess,
        killChildTree: context.killChildTree,
        transport: context.transport,
        onTerminate: lease.release,
    };
    try {
        return language === 'json'
            ? wireJsonLanguageServer(ws, runtimeOptions)
            : startYamlLanguageServer(ws, runtimeOptions);
    } catch {
        lease.release();
        if (ws.readyState === ws.OPEN) ws.close(1011, 'Language service failed');
        return null;
    }
}

module.exports = {
    handleEditorLspConnection,
    EditorLspAdmissionController,
    startYamlLanguageServer,
    wireJsonLanguageServer,
    _security: {
        CLIENT_METHODS,
        YAML_CLIENT_METHODS,
        MAX_FRAME_BYTES,
        createLspConnectionLifecycle,
        hasSchemaDirective,
        applyDocumentChanges,
        isForbiddenExternalReference,
        isSafeDocumentUri,
        killChildProcessTree,
        parseClientMessage,
        safeYamlConfiguration,
    },
};
