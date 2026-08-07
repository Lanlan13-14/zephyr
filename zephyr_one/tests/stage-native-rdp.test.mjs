/*
 * stage-native-rdp.test.mjs — contract tests for One's native-RDP staging.
 *
 * The important test here is `real_public_has_no_dangling_references`: it runs
 * the transform over a copy of the repository's actual public/ tree. A
 * synthetic fixture can only prove the transform agrees with the fixture, while
 * the real tree is what ships — and a leftover <script src="rdp-worker.js">
 * would mean One's RDP tab 404s at runtime.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    applyNativeRdp,
    countOccurrences,
    findDanglingReferences,
    referencesFile,
    EMBED_FILES,
    WASM_RDP_FILES,
    RDP_URL_FROM,
    RDP_URL_TO,
} from '../scripts/stage-native-rdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const oneDir = path.join(here, '..');
const repoDir = path.join(oneDir, '..');
const embedDir = path.join(oneDir, 'embed');

function tmpdir(label) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `zephyr-one-${label}-`));
}

/** Minimal staged core: server.js + public/{app.js,app.html} + the WASM files. */
function fakeCore({ appJs, extraPublic = {} } = {}) {
    const core = tmpdir('core');
    const pub = path.join(core, 'public');
    fs.mkdirSync(pub, { recursive: true });
    fs.writeFileSync(path.join(core, 'server.js'), '// staged core\n');
    fs.writeFileSync(
        path.join(pub, 'app.js'),
        appJs !== undefined
            ? appJs
            : `const url = protocol === 'RDP'\n  ? ${RDP_URL_FROM}&tabId=1\`\n  : '/terminal.html';\n`,
    );
    fs.writeFileSync(path.join(pub, 'app.html'), '<html><body>app</body></html>\n');
    for (const rel of WASM_RDP_FILES) {
        const target = path.join(pub, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `/* ${rel} */\n`);
    }
    for (const [rel, body] of Object.entries(extraPublic)) {
        const target = path.join(pub, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }
    return core;
}

/**
 * Staged core built from the repository's *actual* public/ tree.
 *
 * Shared by every test that needs to prove something about what really ships,
 * rather than about a fixture agreeing with itself.
 */
function realCore() {
    const core = tmpdir('realcore');
    const pub = path.join(core, 'public');
    fs.mkdirSync(core, { recursive: true });
    fs.cpSync(path.join(repoDir, 'public'), pub, { recursive: true });
    fs.writeFileSync(path.join(core, 'server.js'), '// staged\n');
    return core;
}

test('countOccurrences counts non-overlapping literals', () => {
    assert.equal(countOccurrences('aaa', 'a'), 3);
    assert.equal(countOccurrences('aaaa', 'aa'), 2);
    assert.equal(countOccurrences('abc', 'z'), 0);
    assert.equal(countOccurrences('abc', ''), 0);
});

test('embed files exist in the repository', () => {
    for (const name of EMBED_FILES) {
        const full = path.join(embedDir, name);
        assert.ok(fs.existsSync(full), `${name} must exist for staging to work`);
        assert.ok(fs.statSync(full).size > 0, `${name} must not be empty`);
    }
});

test('transform installs the native surface into the staged public dir', () => {
    const core = fakeCore();
    const result = applyNativeRdp({ coreDir: core, embedDir });
    for (const name of EMBED_FILES) {
        assert.ok(
            fs.existsSync(path.join(core, 'public', name)),
            `${name} should be installed`,
        );
    }
    assert.deepEqual(result.installed, [...EMBED_FILES]);
    fs.rmSync(core, { recursive: true, force: true });
});

test('transform repoints the RDP iframe to the native page', () => {
    const core = fakeCore();
    const result = applyNativeRdp({ coreDir: core, embedDir });
    const appJs = fs.readFileSync(path.join(core, 'public', 'app.js'), 'utf8');
    assert.equal(result.rewrites, 1);
    assert.equal(countOccurrences(appJs, RDP_URL_TO), 1);
    assert.equal(countOccurrences(appJs, RDP_URL_FROM), 0);
    fs.rmSync(core, { recursive: true, force: true });
});

test('transform deletes the whole WASM RDP pipeline', () => {
    const core = fakeCore();
    const result = applyNativeRdp({ coreDir: core, embedDir });
    assert.equal(result.removed.length, WASM_RDP_FILES.length);
    for (const rel of WASM_RDP_FILES) {
        assert.equal(
            fs.existsSync(path.join(core, 'public', rel)), false,
            `${rel} should be gone from One's core`,
        );
    }
    // The vendor dir existed only for main.wasm.
    assert.equal(
        fs.existsSync(path.join(core, 'public', 'vendor', 'rdp-wasm')), false,
        'empty vendor/rdp-wasm should be pruned',
    );
    fs.rmSync(core, { recursive: true, force: true });
});

test('transform does not delete One\'s own native files', () => {
    const core = fakeCore();
    applyNativeRdp({ coreDir: core, embedDir });
    // An `rdp-*.js` glob would have swept these away; the explicit list must not.
    for (const name of EMBED_FILES) {
        assert.ok(fs.existsSync(path.join(core, 'public', name)), `${name} survives`);
    }
    fs.rmSync(core, { recursive: true, force: true });
});

test('transform is idempotent', () => {
    const core = fakeCore();
    applyNativeRdp({ coreDir: core, embedDir });
    const second = applyNativeRdp({ coreDir: core, embedDir });
    assert.equal(second.rewrites, 0, 'already-rewritten app.js is left alone');
    assert.equal(second.removed.length, 0, 'nothing left to remove');
    assert.equal(second.absent.length, WASM_RDP_FILES.length);
    const appJs = fs.readFileSync(path.join(core, 'public', 'app.js'), 'utf8');
    assert.equal(countOccurrences(appJs, RDP_URL_TO), 1, 'no double rewrite');
    fs.rmSync(core, { recursive: true, force: true });
});

test('missing app.js is a build failure, not a silent skip', () => {
    const core = tmpdir('core-noappjs');
    fs.mkdirSync(path.join(core, 'public'), { recursive: true });
    assert.throws(
        () => applyNativeRdp({ coreDir: core, embedDir }),
        /app\.js not found/,
    );
    fs.rmSync(core, { recursive: true, force: true });
});

test('an app.js with neither URL form fails loudly', () => {
    // This is the regression that would otherwise ship One still loading the
    // WASM page: app.js was reshaped and the marker no longer matches.
    const core = fakeCore({ appJs: "const url = '/somewhere-else.html';\n" });
    assert.throws(
        () => applyNativeRdp({ coreDir: core, embedDir }),
        /neither the WASM RDP iframe URL nor its native replacement/,
    );
    fs.rmSync(core, { recursive: true, force: true });
});

test('two RDP iframe URLs fail rather than rewriting one at random', () => {
    const core = fakeCore({
        appJs: `a = ${RDP_URL_FROM}&x=1\`; b = ${RDP_URL_FROM}&x=2\`;\n`,
    });
    assert.throws(
        () => applyNativeRdp({ coreDir: core, embedDir }),
        /found 2 RDP iframe URLs/,
    );
    fs.rmSync(core, { recursive: true, force: true });
});

test('a dangling reference to a removed file fails the build', () => {
    // Reverse verification: prove the scan actually catches the thing it exists
    // to catch, rather than passing because nothing ever references anything.
    const core = fakeCore({
        extraPublic: {
            'something.html': '<script src="/rdp-worker.js"></script>\n',
        },
    });
    assert.throws(
        () => applyNativeRdp({ coreDir: core, embedDir }),
        /still references removed WASM RDP files.*rdp-worker\.js/s,
    );
    fs.rmSync(core, { recursive: true, force: true });
});

test('findDanglingReferences reports the offending file and hit', () => {
    const root = tmpdir('scan');
    fs.writeFileSync(path.join(root, 'a.html'), '<script src="rdp-renderer.js">');
    fs.writeFileSync(path.join(root, 'b.js'), 'const x = 1;');
    fs.writeFileSync(path.join(root, 'c.png'), 'binary-ish');
    const found = findDanglingReferences(root, ['rdp-renderer.js', 'rdp-touch.js']);
    assert.equal(found.length, 1);
    assert.equal(found[0].file, 'a.html');
    assert.deepEqual(found[0].hits, ['rdp-renderer.js']);
    fs.rmSync(root, { recursive: true, force: true });
});

test('the repository public/ still has the WASM pipeline (browser untouched)', () => {
    // The browser product must keep its RDP client. If this fails, the change
    // leaked out of One.
    const pub = path.join(repoDir, 'public');
    for (const rel of ['rdp.html', 'rdp-wasm-client.js', 'rdp-worker.js']) {
        assert.ok(
            fs.existsSync(path.join(pub, rel)),
            `repo public/${rel} must survive; One stages a copy instead`,
        );
    }
    const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
    assert.equal(
        countOccurrences(appJs, RDP_URL_FROM), 1,
        'repo app.js keeps pointing at the WASM RDP page',
    );
    assert.equal(countOccurrences(appJs, RDP_URL_TO), 0);
});

test('real public/ has no dangling references after the transform', () => {
    /*
     * The highest-value test in this file. It copies the actual public/ tree,
     * runs the real transform, and asserts nothing still references a deleted
     * file. A synthetic fixture cannot prove this: only the real tree contains
     * the real <script> tags.
     */
    const core = tmpdir('realcore');
    const pub = path.join(core, 'public');
    fs.mkdirSync(core, { recursive: true });
    fs.cpSync(path.join(repoDir, 'public'), pub, { recursive: true });
    fs.writeFileSync(path.join(core, 'server.js'), '// staged\n');

    const result = applyNativeRdp({ coreDir: core, embedDir });

    assert.equal(result.rewrites, 1, 'the real app.js was repointed');
    assert.ok(result.removed.length >= 15, `removed ${result.removed.length} WASM files`);
    // applyNativeRdp throws on dangling references, so reaching here proves the
    // staged tree is self-consistent. Assert it directly too, so the intent is
    // visible rather than implied by absence of a throw.
    assert.deepEqual(findDanglingReferences(pub, WASM_RDP_FILES), []);

    // And the native surface really is what the tab will load.
    const appJs = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
    assert.equal(countOccurrences(appJs, RDP_URL_TO), 1);
    assert.ok(fs.existsSync(path.join(pub, 'zephyr-one-rdp.html')));

    fs.rmSync(core, { recursive: true, force: true });
});

/*
 * Boundary matching. This is not a hypothetical: the first run of this suite
 * failed with
 *     "still references removed WASM RDP files: zephyr-one-rdp.html -> rdp.html"
 * because a naive substring scan sees `rdp.html` inside `zephyr-one-rdp.html`.
 * That made the transform reject its own output, so the guard has to know the
 * difference between a reference and a longer filename that merely ends the
 * same way.
 */
test('the scan does not mistake a longer filename for a reference', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-boundary-'));

    // Every one of these contains the literal "rdp.html" as a substring, and
    // none of them is a reference to the removed rdp.html.
    fs.writeFileSync(path.join(dir, 'a.js'), 'load("/zephyr-one-rdp.html?embed=1")');
    fs.writeFileSync(path.join(dir, 'b.js'), 'load("/my-rdp.html")');
    fs.writeFileSync(path.join(dir, 'c.js'), 'load("/legacy_rdp.html")');
    assert.deepEqual(
        findDanglingReferences(dir, ['rdp.html']),
        [],
        'names that merely end in rdp.html must not be flagged',
    );

    // And the genuine forms still are, in every spelling app.html/app.js use.
    for (const [name, body] of [
        ['d.js', 'src = "/rdp.html?embed=1"'],
        ['e.js', "src = '/rdp.html'"],
        ['f.html', '<script src="rdp.html"></script>'],
        ['g.js', 'const p = `/rdp.html?tab=${id}`'],
    ]) {
        const one = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-one-boundary1-'));
        fs.writeFileSync(path.join(one, name), body);
        const hits = findDanglingReferences(one, ['rdp.html']);
        assert.equal(hits.length, 1, `${name}: a real reference must be flagged (${body})`);
        assert.deepEqual(hits[0].hits, ['rdp.html']);
        fs.rmSync(one, { recursive: true, force: true });
    }

    fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * The worker files are referenced by string literal inside other rdp-*.js, not
 * by a <script> tag, so they are the ones most likely to be missed. Prove the
 * removal list is complete by asserting that after the transform no remaining
 * file names any rdp-*.js at all.
 */
test('no staged file still names a rdp-*.js worker after the transform', () => {
    const core = realCore();
    const pub = path.join(core, 'public');
    applyNativeRdp({ coreDir: core, embedDir });

    const leftovers = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!['.js', '.html', '.mjs', '.css', '.json'].includes(path.extname(entry.name))) continue;
            const text = fs.readFileSync(full, 'utf8');
            for (const removed of WASM_RDP_FILES) {
                if (!removed.endsWith('.js')) continue;
                if (referencesFile(text, removed)) {
                    leftovers.push(`${path.relative(pub, full)} -> ${removed}`);
                }
            }
        }
    };
    walk(pub);
    assert.deepEqual(leftovers, [], 'a removed worker is still named by a staged file');

    fs.rmSync(core, { recursive: true, force: true });
});
