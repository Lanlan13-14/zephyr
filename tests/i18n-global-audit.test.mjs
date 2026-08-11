import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    missingI18nPythonReason,
    resolveI18nPython,
    runI18nPython,
} from './helpers/i18n-python-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = resolveI18nPython(root);
const pythonTestOptions = { skip: python ? false : missingI18nPythonReason };

test('all frontend i18n references resolve without destructive markup', pythonTestOptions, () => {
    const output = runI18nPython(python, ['scripts/audit-i18n.py'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
    });
    assert.match(output, /missing zh=0 en=0 identity en=0/);
    assert.match(output, /duplicate_i18n_attrs=0 nested_data_i18n=0 static_page_findings=0/);
});

function frontendJsFiles() {
    const files = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'vendor' || entry.name === 'editor') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) files.push(path.relative(root, full));
        }
    };
    walk(path.join(root, 'public'));
    return files.sort();
}

test('frontend HTML templates contain no untranslated Chinese UI nodes', pythonTestOptions, () => {
    const files = frontendJsFiles();
    for (const file of files) {
        const output = runI18nPython(python, ['scripts/audit-js-ui-templates.py', file], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.match(output, /findings=0/, file);
    }
});

test('frontend user-visible calls contain no untranslated Chinese literals', pythonTestOptions, () => {
    const files = frontendJsFiles();
    for (const file of files) {
        const output = runI18nPython(python, ['scripts/audit-js-visible-calls.py', file], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
        });
        assert.match(output, /findings=0/, file);
    }
});

test('every frontend module that imports i18n uses a cache-busted runtime URL', () => {
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
        assert.match(fs.readFileSync(file, 'utf8'), /i18n\/runtime\.js\?v=[A-Za-z0-9._-]+/, path.relative(root, file));
    }
});
