import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function duplicateI18nAttributes(html) {
    const duplicate = [];
    for (const tag of html.match(/<[^<>]+>/g) || []) {
        const attrs = [...tag.matchAll(/\s(data-i18n(?:-[\w-]+)?)=(?:"[^"]*"|'[^']*')/g)].map((m) => m[1]);
        for (const attr of new Set(attrs)) {
            if (attrs.filter((name) => name === attr).length > 1) duplicate.push({ tag, attr });
        }
    }
    return duplicate;
}

test('app and terminal pages have no duplicate data-i18n attributes', () => {
    for (const file of ['public/app.html', 'public/terminal.html']) {
        const duplicate = duplicateI18nAttributes(read(file));
        assert.deepEqual(duplicate, [], file);
    }
});

test('app keeps live controls when static labels are translated', () => {
    const html = read('public/app.html');
    assert.match(html, /<label><span data-i18n="开始日期">开始日期<\/span><input id="activityStartDate" type="date"><\/label>/);
    assert.match(html, /<label><span data-i18n="大背景">大背景<\/span><div class="zephyr-color-picker"/);
    assert.match(html, /<label><span data-i18n="背景强度">背景强度<\/span> <span id="terminalBgOpacityValue">35%<\/span><\/label>/);
});

test('terminal and telnet pages retain distinct single-source controls', () => {
    const terminal = read('public/terminal.html');
    const telnet = read('public/telnet-terminal.html');
    for (const html of [terminal, telnet]) {
        assert.match(html, /id="statusText" data-i18n="连接中\.\.\."/);
        assert.match(html, /id="disconnectBtn"/);
        assert.match(html, /id="snippetBtn"/);
        assert.match(html, /data-i18n="⚡ 代码片段"/);
        assert.match(html, /data-i18n="⌨️ 快捷键"/);
        assert.match(html, /data-i18n-placeholder="在此输入命令，Enter 发送，Shift\+Enter 换行\.\.\."/);
        assert.match(html, /data-i18n-aria-label="移动端辅助键栏"/);
    }
});

test('terminal, telnet, RDP, login, and deep-link static audit batches are clean', () => {
    const python = process.platform === 'win32' ? 'python' : 'python3';
    for (const page of ['public/terminal.html', 'public/telnet-terminal.html', 'public/rdp.html', 'public/index.html', 'public/open.html']) {
        const output = execFileSync(python, ['scripts/i18n-page-audit.py', page], { cwd: root, encoding: 'utf8' });
        assert.match(output, /findings=0/, page);
    }
});
