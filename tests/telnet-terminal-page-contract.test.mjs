/**
 * Telnet has its own terminal page — no SFTP/Docker/stats chrome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('..', import.meta.url);
const html = fs.readFileSync(new URL('../public/telnet-terminal.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../public/telnet-terminal.js', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sshHtml = fs.readFileSync(new URL('../public/terminal.html', import.meta.url), 'utf8');

test('telnet-terminal.html exists and loads telnet-terminal.js', () => {
    assert.match(html, /telnet-terminal\.js\?v=/);
    assert.match(html, /Telnet 终端/);
    assert.doesNotMatch(html, /id="fileBtn"/);
    assert.doesNotMatch(html, /id="infoBtn"/);
    assert.doesNotMatch(html, /id="dockerBtn"/);
    assert.doesNotMatch(html, /id="fileManager"/);
    assert.doesNotMatch(html, /id="dockerPanel"/);
    assert.doesNotMatch(html, /id="infoModal"/);
});

test('SSH terminal.html still has file/docker/info chrome', () => {
    assert.match(sshHtml, /id="fileBtn"/);
    assert.match(sshHtml, /id="dockerBtn"/);
    assert.match(sshHtml, /id="infoBtn"/);
    assert.match(sshHtml, /id="fileManager"/);
});

test('app.js routes TELNET tabs to telnet-terminal page', () => {
    assert.match(appJs, /page === 'telnet-terminal'/);
    assert.match(appJs, /\/telnet-terminal\.html\?embed=1/);
    assert.match(appJs, /protocol === 'TELNET' \? 'telnet-terminal' : 'terminal'/);
});

test('telnet-terminal.js defaults connect protocol to TELNET and stubs SFTP entrypoints', () => {
    assert.match(js, /protocol: params\.protocol \|\| params\.transientOverrides\?\.protocol \|\| 'TELNET'/);
    assert.match(js, /const fileBtn = null/);
    assert.match(js, /const dockerBtn = null/);
    assert.match(js, /const infoBtn = null/);
    assert.match(js, /function showFileManager\(\) \{\s*return;/);
});
