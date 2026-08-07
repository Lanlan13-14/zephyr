const { spawn } = require('child_process');
const path = require('path');

function loadJsonLanguageService() {
    try { return require('vscode-json-languageservice'); } catch { return null; }
}

function loadYamlTransport() {
    try {
        const { StreamMessageReader, StreamMessageWriter } = require('vscode-languageserver/node');
        const { createMessageConnection } = require('vscode-jsonrpc/node');
        return { StreamMessageReader, StreamMessageWriter, createMessageConnection };
    } catch {
        return null;
    }
}

function isJsonRpcMessage(message) {
    return message && typeof message === 'object' && (message.method || Object.prototype.hasOwnProperty.call(message, 'id'));
}

function wireJsonLanguageServer(ws) {
    const service = loadJsonLanguageService();
    if (!service) {
        ws.close(1011, 'JSON language service is unavailable on this platform');
        return;
    }
    const { getLanguageService, TextDocument } = service;
    const documents = new Map();
    const jsonService = getLanguageService({});
    const send = (payload) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };
    const notifyDiagnostics = async (uri) => {
        const doc = documents.get(uri);
        if (!doc) return;
        const jsonDoc = jsonService.parseJSONDocument(doc);
        const diagnostics = await jsonService.doValidation(doc, jsonDoc);
        send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
    };
    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (!isJsonRpcMessage(msg)) return;
        const id = msg.id;
        try {
            if (msg.method === 'initialize') {
                send({ jsonrpc: '2.0', id, result: {
                    capabilities: {
                        textDocumentSync: 1,
                        completionProvider: { resolveProvider: false, triggerCharacters: ['"', ':'] },
                        hoverProvider: true,
                        documentFormattingProvider: true,
                    }
                }});
            } else if (msg.method === 'initialized') {
                return;
            } else if (msg.method === 'textDocument/didOpen') {
                const td = msg.params?.textDocument;
                if (!td?.uri) return;
                documents.set(td.uri, TextDocument.create(td.uri, 'json', td.version || 1, td.text || ''));
                notifyDiagnostics(td.uri);
            } else if (msg.method === 'textDocument/didChange') {
                const uri = msg.params?.textDocument?.uri;
                const current = documents.get(uri);
                const text = msg.params?.contentChanges?.[0]?.text;
                if (!uri || !current || typeof text !== 'string') return;
                documents.set(uri, TextDocument.create(uri, 'json', msg.params.textDocument.version || current.version + 1, text));
                notifyDiagnostics(uri);
            } else if (msg.method === 'textDocument/didClose') {
                const uri = msg.params?.textDocument?.uri;
                documents.delete(uri);
                send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
            } else if (msg.method === 'textDocument/completion') {
                const uri = msg.params?.textDocument?.uri;
                const doc = documents.get(uri);
                const result = doc ? await jsonService.doComplete(doc, msg.params.position, jsonService.parseJSONDocument(doc)) : { isIncomplete: false, items: [] };
                send({ jsonrpc: '2.0', id, result });
            } else if (msg.method === 'textDocument/hover') {
                const uri = msg.params?.textDocument?.uri;
                const doc = documents.get(uri);
                const result = doc ? await jsonService.doHover(doc, msg.params.position, jsonService.parseJSONDocument(doc)) : null;
                send({ jsonrpc: '2.0', id, result });
            } else if (msg.method === 'textDocument/formatting') {
                const uri = msg.params?.textDocument?.uri;
                const doc = documents.get(uri);
                const result = doc ? jsonService.format(doc, undefined, { tabSize: 2, insertSpaces: true }) : [];
                send({ jsonrpc: '2.0', id, result });
            } else if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
                send({ jsonrpc: '2.0', id, result: null });
            }
        } catch (error) {
            if (Object.prototype.hasOwnProperty.call(msg, 'id')) send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message || String(error) } });
        }
    });
}

function startYamlLanguageServer(ws) {
    const transport = loadYamlTransport();
    if (!transport) {
        ws.close(1011, 'YAML language service is unavailable on this platform');
        return;
    }
    const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = transport;
    const bin = path.join(__dirname, 'node_modules', 'yaml-language-server', 'bin', 'yaml-language-server');
    const child = spawn(process.execPath, [bin, '--stdio'], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
    });
    const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
    connection.onNotification((method, params) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    });
    connection.onRequest((method, params) => {
        if (method === 'workspace/configuration') {
            return (params?.items || []).map((item) => ({
                validate: true,
                hover: true,
                completion: true,
                format: { enable: true, singleQuote: false, bracketSpacing: true, proseWrap: 'preserve', printWidth: 100 },
                schemas: {},
                schemaStore: { enable: true, url: 'https://www.schemastore.org/api/json/catalog.json' },
                kubernetesCRDStore: { enable: true },
                yamlVersion: '1.2',
                customTags: [],
                disableDefaultProperties: false,
                maxItemsComputed: 5000,
                keyOrdering: false,
            }));
        }
        if (method === 'client/registerCapability' || method === 'client/unregisterCapability') return null;
        if (method === 'workspace/workspaceFolders') return null;
        if (method === 'workspace/configuration') return [];
        return null;
    });
    connection.listen();
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (!isJsonRpcMessage(msg)) return;
        try {
            if (msg.method && Object.prototype.hasOwnProperty.call(msg, 'id')) connection.sendRequest(msg.method, msg.params).then(
                (result) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })),
                (error) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: error.code || -32603, message: error.message || String(error) } }))
            );
            else if (msg.method) connection.sendNotification(msg.method, msg.params);
        } catch (error) {
            if (Object.prototype.hasOwnProperty.call(msg, 'id') && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: error.message || String(error) } }));
        }
    });
    const cleanup = () => {
        try { connection.dispose(); } catch {}
        try { child.kill(); } catch {}
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
    child.stderr.on('data', (chunk) => console.warn('[editor-yaml-lsp]', String(chunk).trim()));
    child.on('exit', () => { if (ws.readyState === ws.OPEN) ws.close(); });
}

function handleEditorLspConnection(ws, req) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const language = String(url.searchParams.get('language') || 'yaml').toLowerCase();
    if (language === 'json') wireJsonLanguageServer(ws);
    else startYamlLanguageServer(ws);
}

module.exports = { handleEditorLspConnection };
