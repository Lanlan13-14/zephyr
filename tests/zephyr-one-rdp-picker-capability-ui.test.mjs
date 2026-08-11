import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'zephyr-one-rdp-settings.js'), 'utf8');

function functionBody(name, nextName) {
    const start = source.indexOf('function ' + name + '(');
    const end = source.indexOf('function ' + nextName + '(', start);
    assert.ok(start >= 0, name + ' must exist');
    assert.ok(end > start, name + ' must be followed by ' + nextName);
    return source.slice(start, end);
}

test('the native picker request is explicitly bound to the current connection', () => {
    const body = functionBody('pickFolder', 'captureMappingSave');
    assert.match(body, /body:\s*JSON\.stringify\(\{\s*connectionId:\s*connectionId\s*\}\)/);
    assert.match(body, /connectionId:\s*connectionId/);
    assert.match(body, /request\.id\s*=\s*String\(data\.id\)/);
    assert.match(body, /pollPick\(request,\s*Date\.now\(\) \+ POLL_TIMEOUT_MS\)/);
});

test('page polling retains only a non-sensitive label and selected boolean', () => {
    const body = functionBody('pollPick', 'pickErrorText');
    const activeCheck = body.indexOf('if (!isActivePicker(request))');
    const labelWrite = body.indexOf('request.folderLabel = String(data.folderLabel)');
    assert.ok(activeCheck >= 0 && activeCheck < labelWrite, 'validate before retaining display metadata');
    assert.match(body, /data\.selected !== true \|\| !data\.folderLabel/);
    assert.match(body, /resolve\(request\)/);
    assert.match(body, /Date\.now\(\) > deadline\) \{\s*disposePicker\(request\)/);
    assert.doesNotMatch(body, /data\.(?:path|capability)|request\.(?:path|capability)/);
});

test('mapping save submits enablement and device name only', () => {
    const body = functionBody('saveMapping', 'pollPick');
    assert.match(body, /snapshot\.connectionId !== connectionId/);
    assert.match(body, /enabled:\s*enabled/);
    assert.match(body, /deviceName:\s*enabled \? snapshot\.deviceName : ''/);
    assert.doesNotMatch(body, /pickerCapability|snapshot\.folder|folder:\s*/);
});

test('stale and cross-connection picker responses are discarded without durable client storage', () => {
    const pick = functionBody('pickFolder', 'captureMappingSave');
    const poll = functionBody('pollPick', 'pickErrorText');
    const observer = functionBody('installSaveObserver', 'ensureHintNode');
    assert.match(pick, /if \(!isActivePicker\(picked\)\) throw stalePickerError\(\)/);
    assert.match(pick, /disposePicker\(picked\)/);
    assert.match(poll, /if \(!isActivePicker\(request\)\) \{\s*reject\(stalePickerError\(\)\)/);
    assert.match(observer, /mappingSave\.connectionId === currentConnectionId\(\)/);
    assert.match(observer, /mappingSave\.connectionId !== currentConnectionId\(\)/);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|dataset|console)\b/);
    assert.doesNotMatch(source, /\b(?:pickerCapability|openCapability|folderGrant)\b/);
    assert.doesNotMatch(source, /data\.path|request\.path|snapshot\.folder/);
});

test('successful native selection is already mapped when the page sees it', () => {
    const body = functionBody('pickFolder', 'captureMappingSave');
    assert.match(body, /folder\.value = picked\.folderLabel/);
    assert.match(body, /Folder selected and mapped\./);
    assert.doesNotMatch(body, /retainPicker|saveMapping\(/);
});
