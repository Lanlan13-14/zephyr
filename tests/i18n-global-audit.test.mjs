import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('all frontend i18n references resolve without destructive markup', () => {
    const output = execFileSync('python3', ['scripts/audit-i18n.py'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.match(output, /missing zh=0 en=0 identity en=0/);
    assert.match(output, /duplicate_i18n_attrs=0 nested_data_i18n=0 static_page_findings=0/);
});

test('every frontend module that imports i18n uses the current cache revision', () => {
    const current = '20260726-i18n-fix2';
    const publicDir = path.join(root, 'public');
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'vendor' || entry.name === 'editor') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(?:js|html)$/.test(entry.name)) files.push(full);
        }
    };
    walk(publicDir);
    const importing = files.filter((file) => fs.readFileSync(file, 'utf8').includes('i18n/runtime.js'));
    assert.ok(importing.length > 0);
    for (const file of importing) {
        assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`i18n/runtime\\.js\\?v=${current}`), path.relative(root, file));
    }
});
