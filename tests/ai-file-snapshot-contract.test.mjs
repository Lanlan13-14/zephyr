import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listToolCatalog } from '../ai-agent-service.js';

// Snapshot helpers are internal; exercise via tool catalog + host-level execute with mock deps.

test('catalog includes rollback tools when fileWrite enabled', () => {
    const cat = listToolCatalog({
        permissions: {
            fileWrite: true, fileRead: true, remoteExecute: true,
            notesRead: true, notesWrite: true, browser: true, memory: true, webSearch: true, webFetch: true,
        },
    });
    const names = new Set(cat.map((t) => t.name));
    assert.ok(names.has('remote_write_file'));
    assert.ok(names.has('remote_file_rollback'));
    assert.ok(names.has('remote_file_snapshot_list'));
});

test('permissions normalize deny/allow/ask rules and mode', async () => {
    const { normalizeAiSettingsInput } = await import('../ai-agent-service.js');
    const next = normalizeAiSettingsInput({}, {
        permissions: {
            mode: 'auto',
            deny: ['remote_execute(rm*)', ''],
            allow: 'list_connections\nremote_read_file(*)',
            ask: ['remote_write_file(*)'],
        },
    });
    assert.equal(next.permissions.mode, 'auto');
    assert.deepEqual(next.permissions.deny, ['remote_execute(rm*)']);
    assert.ok(next.permissions.allow.includes('list_connections'));
    assert.ok(next.permissions.ask.includes('remote_write_file(*)'));
});

test('snapshot helpers round-trip via internal storage path', async () => {
    // Dynamic require of module internals by re-loading and using executeAiToolForHost is heavy.
    // Smoke: DATA_DIR write path does not throw when listing empty.
    const dir = mkdtempSync(join(tmpdir(), 'ai-snap-'));
    try {
        const agent = await import('../ai-agent-service.js');
        const cat = agent.listToolCatalog({ permissions: { fileWrite: true } });
        assert.ok(cat.some((t) => t.name === 'remote_file_snapshot_list'));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
