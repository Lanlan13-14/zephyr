import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

function extractFunction(source, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} missing`);
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    throw new Error(`${name} unterminated`);
}

test('runtime run route reads locale from the declared contextObj', () => {
    assert.match(server, /const contextObj = req\.body\?\.context \|\| \{\};/);
    assert.match(server, /buildSystemCompose\(ai, contextText, memories, contextObj\.locale \|\| 'zh-CN'\)/);
    assert.doesNotMatch(server, /buildSystemCompose\(ai, contextText, memories, context\.locale/);
});

test('runtime run route appends deterministic tool routing for common machine intents', () => {
    assert.match(server, /buildIntentRoutingHint\(req\.body\?\.message \|\| ''\)/);
    // S1: routing rides volatile tail (routingHint), not stable systemCompose.prompt
    assert.match(server, /systemCompose\.routingHint = intentHint/);
});

test('generic ReferenceError is not mislabeled as context-window overflow', () => {
    const source = `${extractFunction(app, 'formatAiRequestFailure')}\nthis.formatAiRequestFailure = formatAiRequestFailure;`;
    const sandbox = { t: (value) => value };
    vm.runInNewContext(source, sandbox);
    const generic = sandbox.formatAiRequestFailure(new ReferenceError('context is not defined'));
    assert.equal(generic, '请求失败：context is not defined');
    assert.doesNotMatch(generic, /压缩摘要/);

    const oversized = sandbox.formatAiRequestFailure(new Error('maximum context length exceeded'));
    assert.match(oversized, /压缩摘要/);
});
