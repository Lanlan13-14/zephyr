'use strict';

const { HttpError } = require('./authz');

const TERMINAL_READ_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 160 },
        maxChars: { type: 'number', minimum: 1000, maximum: 120000 },
    },
    required: ['sessionId'],
    additionalProperties: false,
});

const TERMINAL_SEND_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 160 },
        text: { type: 'string', minLength: 1, maxLength: 20000 },
        appendNewline: { type: 'boolean' },
    },
    required: ['sessionId', 'text'],
    additionalProperties: false,
});

const TERMINAL_WAIT_SCHEMA = Object.freeze({
    type: 'object',
    properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 160 },
        pattern: { type: 'string', minLength: 1, maxLength: 500 },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        timeoutMs: { type: 'number', minimum: 100, maximum: 120000 },
        pollMs: { type: 'number', minimum: 50, maximum: 2000 },
        maxChars: { type: 'number', minimum: 1000, maximum: 120000 },
    },
    required: ['sessionId', 'pattern'],
    additionalProperties: false,
});

function clipTail(value = '', maxChars = 30000) {
    const text = String(value || '');
    const max = Math.max(1000, Math.min(120000, Number(maxChars) || 30000));
    return text.length > max ? `[前面已截断 ${text.length - max} 字符]\n${text.slice(-max)}` : text;
}

function publicSession(session = {}, text = '', maxChars = 30000) {
    const conn = session.connectionConfig || {};
    const protocol = String(session.protocol || conn.protocol || 'SSH').toUpperCase();
    return {
        sessionId: String(session.id || ''),
        connectionId: String(session.connectionId || conn.id || ''),
        protocol,
        name: String(conn.name || ''),
        host: String(conn.host || ''),
        port: Number(conn.port) || (protocol === 'TELNET' ? 23 : 22),
        username: String(conn.username || ''),
        connected: !session.closed,
        cols: Number(session.pty?.cols) || 0,
        rows: Number(session.pty?.rows) || 0,
        createdAt: Number(session.createdAt || 0),
        lastActive: Number(session.lastActive || 0),
        text: clipTail(text, maxChars),
        originalLength: String(text || '').length,
        truncated: String(text || '').length > Math.max(1000, Math.min(120000, Number(maxChars) || 30000)),
    };
}

function findOwnedSession(sessions, user, sessionId) {
    const session = sessions.get(String(sessionId || ''));
    const owned = session && user && (session.userId ? session.userId === user.userId : session.username === user.username);
    if (!session || session.closed || !owned) throw new HttpError(404, 'resource_not_found_or_inaccessible', '终端会话不存在或无权访问');
    const protocol = String(session.protocol || 'SSH').toUpperCase();
    if (!['SSH', 'TELNET'].includes(protocol)) throw new HttpError(400, 'invalid_terminal_protocol', '标准终端操作仅支持 SSH 或 TELNET 会话');
    return session;
}

function readSession(sessions, history, user, args) {
    const session = findOwnedSession(sessions, user, args.sessionId);
    let text = '';
    try { text = history.replayTail(session.userId || user.userId, session.id, Math.max(4096, Math.min(256000, Number(args.maxChars) * 4 || 120000))).data || ''; } catch {}
    if (!text && Array.isArray(session.outputBuffer)) text = session.outputBuffer.join('');
    return publicSession(session, text, args.maxChars || 30000);
}

function writeSession(session, text) {
    const protocol = String(session.protocol || 'SSH').toUpperCase();
    if (protocol === 'TELNET') {
        if (!session.telnetSocket || session.telnetSocket.destroyed) throw new HttpError(409, 'terminal_not_writable', 'TELNET 会话已断开');
        const payload = session.telnetDecoder ? session.telnetDecoder.encode(text) : Buffer.from(text, 'utf8');
        session.telnetSocket.write(payload);
    } else {
        if (!session.sshStream || !session.sshStream.writable) throw new HttpError(409, 'terminal_not_writable', 'SSH 会话已断开');
        session.sshStream.write(text);
    }
    session.lastActive = Date.now();
}

function sendSession(sessions, history, user, args) {
    const session = findOwnedSession(sessions, user, args.sessionId);
    const text = String(args.text || '') + (args.appendNewline === false ? '' : '\n');
    writeSession(session, text);
    return {
        session: readSession(sessions, history, user, { sessionId: session.id, maxChars: 12000 }),
        sentChars: text.length,
        appendNewline: args.appendNewline !== false,
        verification: 'terminal_read_or_wait_required',
    };
}

function matcherFor(args) {
    const source = String(args.pattern || '');
    if (args.regex) {
        try { return new RegExp(source, args.caseSensitive ? '' : 'i'); }
        catch { throw new HttpError(400, 'invalid_wait_pattern', '等待正则表达式无效'); }
    }
    const needle = args.caseSensitive ? source : source.toLowerCase();
    return { test(value) { const haystack = args.caseSensitive ? String(value) : String(value).toLowerCase(); return haystack.includes(needle); } };
}

async function waitSession(sessions, history, user, args, signal = null) {
    const timeoutMs = Math.max(100, Math.min(120000, Number(args.timeoutMs) || 15000));
    const pollMs = Math.max(50, Math.min(2000, Number(args.pollMs) || 250));
    const matcher = matcherFor(args);
    const deadline = Date.now() + timeoutMs;
    let snapshot = readSession(sessions, history, user, args);
    while (true) {
        if (matcher.test(snapshot.text)) return { matched: true, pattern: String(args.pattern), waitedMs: timeoutMs - Math.max(0, deadline - Date.now()), session: snapshot };
        if (Date.now() >= deadline) return { matched: false, pattern: String(args.pattern), waitedMs: timeoutMs, session: snapshot };
        if (signal?.aborted) throw Object.assign(new Error('AI 请求已停止'), { name: 'AbortError' });
        await new Promise((resolve, reject) => {
            let timer = null;
            const cleanup = () => { if (signal) signal.removeEventListener('abort', abort); };
            const done = () => { cleanup(); resolve(); };
            const abort = () => { if (timer) clearTimeout(timer); cleanup(); reject(Object.assign(new Error('AI 请求已停止'), { name: 'AbortError' })); };
            timer = setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now())));
            if (signal) signal.addEventListener('abort', abort, { once: true });
        });
        snapshot = readSession(sessions, history, user, args);
    }
}

module.exports = {
    TERMINAL_READ_SCHEMA,
    TERMINAL_SEND_SCHEMA,
    TERMINAL_WAIT_SCHEMA,
    findOwnedSession,
    readSession,
    sendSession,
    waitSession,
    publicSession,
};
