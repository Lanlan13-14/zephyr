/*
 * stage-native-rdp.mjs — turn a staged Zephyr core into One's native-RDP core.
 *
 * Three things happen here, and all three are One-only. The repository's own
 * `public/` is never touched, so the browser product keeps its Go/WASM RDP
 * client byte-for-byte.
 *
 *   1. Install One's native RDP surface (zephyr-one-rdp.html + its client and
 *      the folder-mapping settings overlay) into the staged public/.
 *   2. Repoint app.js's remote-desktop iframe from /rdp.html to
 *      /zephyr-one-rdp.html.
 *   3. Delete the entire Go/WASM RDP pipeline from the staged public/.
 *
 * Why (3) is a deletion and not merely "stop loading it":
 *   Leaving 7,500 lines of dead JS plus a multi-megabyte main.wasm in the
 *   installer would still ship a second, unused RDP implementation — the one
 *   this change exists to retire. Deleting it makes "One has one RDP stack" a
 *   property of the artifact instead of a claim in a comment.
 *
 * Why the dangling-reference scan exists:
 *   Removing files that something still <script>-tags would produce a 404 at
 *   runtime and an RDP tab that silently never starts. The scan turns that into
 *   a build failure naming the offending file, which is the only way this stays
 *   correct as public/ evolves.
 */

import fs from 'node:fs';
import path from 'node:path';

/** One-only files copied into the staged public/. */
export const EMBED_FILES = Object.freeze([
    'zephyr-one-rdp.html',
    'zephyr-one-rdp.js',
    'zephyr-one-rdp-settings.js',
]);

/**
 * The Go/WASM RDP pipeline, removed from One's core.
 *
 * This is an explicit list rather than a `rdp-*.js` glob: a glob would also
 * sweep up One's own `zephyr-one-rdp*.js` (installed moments earlier) and would
 * silently absorb any future file whose removal was never considered.
 */
export const WASM_RDP_FILES = Object.freeze([
    'rdp.html',
    'rdp-wasm-client.js',
    'rdp-wasm-memory.js',
    'rdp-wasm-runtime.js',
    'rdp-worker.js',
    'rdp-worker-bridge.js',
    'rdp-worker-frame-scheduler.js',
    'rdp-worker-probe.js',
    'rdp-renderer.js',
    'rdp-video-decoder.js',
    'rdp-audio-scheduler.js',
    'rdp-input-channel.js',
    'rdp-touch.js',
    'rdp-mobile-keyboard.js',
    'rdp-render-command-queue.js',
    'rdp-resolution-policy.js',
    'rdp-trace.js',
    'rdp-diagnostics.js',
    'rdp-fs-provider.js',
    'vendor/rdp-wasm/main.wasm',
]);

/** app.js's remote-desktop iframe URL, and its One replacement. */
export const RDP_URL_FROM = '`/rdp.html?embed=1';
export const RDP_URL_TO = '`/zephyr-one-rdp.html?embed=1';

/** Extensions worth scanning for references to the removed files. */
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json']);

/**
 * Count non-overlapping occurrences of a literal substring.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number}
 */
export function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
        count += 1;
        index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
}

/**
 * Find text files under `root` that still reference any removed basename.
 *
 * Matching is on the basename (`rdp-worker.js`) rather than the full relative
 * path because references appear as `/rdp-worker.js`, `./rdp-worker.js` and
 * bare `rdp-worker.js` across the tree.
 *
 * @param {string} root directory to scan
 * @param {string[]} removed relative paths that were deleted
 * @returns {{file: string, hits: string[]}[]}
 */
/**
 * Does `text` reference the file `name`, as opposed to merely containing its
 * name inside a longer filename?
 *
 * This distinction is not academic. `zephyr-one-rdp.html` contains the literal
 * substring `rdp.html`, so a plain `text.includes(name)` reports One's *own*
 * native page — the replacement this transform just installed — as a dangling
 * reference to the WASM page it replaced. The build then fails on its own
 * output.
 *
 * A reference is therefore only counted when the character immediately before
 * the match is not a filename character, which is true for every real reference
 * form (`/rdp.html`, `"rdp.html`, `'rdp.html`, `=rdp.html`, or at offset 0) and
 * false for `zephyr-one-rdp.html`.
 *
 * @param {string} text
 * @param {string} name bare filename, e.g. `rdp.html`
 * @returns {boolean}
 */
export function referencesFile(text, name) {
    let index = text.indexOf(name);
    while (index !== -1) {
        const before = index === 0 ? '' : text[index - 1];
        if (!/[A-Za-z0-9_-]/.test(before)) return true;
        index = text.indexOf(name, index + name.length);
    }
    return false;
}

export function findDanglingReferences(root, removed) {
    const names = removed.map((rel) => path.basename(rel));
    const offenders = [];

    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!TEXT_EXT.has(path.extname(entry.name))) continue;
            let text;
            try {
                text = fs.readFileSync(full, 'utf8');
            } catch {
                continue;
            }
            const hits = names.filter((name) => referencesFile(text, name));
            if (hits.length) {
                offenders.push({ file: path.relative(root, full), hits });
            }
        }
    };

    walk(root);
    return offenders;
}

/**
 * Apply the native-RDP transform to a staged core.
 *
 * @param {object} options
 * @param {string} options.coreDir staged core (contains server.js + public/)
 * @param {string} options.embedDir One's embed/ directory
 * @returns {{installed: string[], removed: string[], absent: string[], rewrites: number}}
 * @throws {Error} when app.js is missing, when its RDP URL is not found (which
 *   would leave One loading the WASM page), or when a removed file is still
 *   referenced.
 */
export function applyNativeRdp({ coreDir, embedDir }) {
    const publicDir = path.join(coreDir, 'public');
    const appJs = path.join(publicDir, 'app.js');
    if (!fs.existsSync(appJs)) {
        throw new Error(`stage-native-rdp: ${appJs} not found; stage the core first`);
    }

    // 1. Install One's surface.
    const installed = [];
    for (const name of EMBED_FILES) {
        const src = path.join(embedDir, name);
        if (!fs.existsSync(src)) {
            throw new Error(`stage-native-rdp: missing embed file ${src}`);
        }
        fs.copyFileSync(src, path.join(publicDir, name));
        installed.push(name);
    }

    // 2. Repoint the iframe. Asserted to match exactly once: zero means app.js
    //    changed shape and One would keep loading the WASM page; more than one
    //    means there is a second call site this transform is not reasoning
    //    about.
    const before = fs.readFileSync(appJs, 'utf8');
    const already = countOccurrences(before, RDP_URL_TO);
    const hits = countOccurrences(before, RDP_URL_FROM);
    let rewrites = 0;
    if (hits === 1) {
        fs.writeFileSync(appJs, before.split(RDP_URL_FROM).join(RDP_URL_TO));
        rewrites = 1;
    } else if (hits > 1) {
        throw new Error(
            `stage-native-rdp: found ${hits} RDP iframe URLs in app.js; expected exactly 1`,
        );
    } else if (already !== 1) {
        throw new Error(
            'stage-native-rdp: app.js contains neither the WASM RDP iframe URL nor its '
            + 'native replacement; the remote-desktop tab would not open',
        );
    }

    // 3. Delete the WASM pipeline.
    const removed = [];
    const absent = [];
    for (const rel of WASM_RDP_FILES) {
        const target = path.join(publicDir, rel);
        if (fs.existsSync(target)) {
            fs.rmSync(target, { force: true });
            removed.push(rel);
        } else {
            absent.push(rel);
        }
    }
    // vendor/rdp-wasm exists only to hold main.wasm.
    const vendorDir = path.join(publicDir, 'vendor', 'rdp-wasm');
    if (fs.existsSync(vendorDir)) {
        try {
            if (fs.readdirSync(vendorDir).length === 0) fs.rmdirSync(vendorDir);
        } catch { /* non-empty or racing; harmless */ }
    }

    // 4. Fail loudly on anything still pointing at the removed files.
    const dangling = findDanglingReferences(publicDir, WASM_RDP_FILES);
    if (dangling.length) {
        const detail = dangling
            .map((item) => `${item.file} -> ${item.hits.join(', ')}`)
            .join('; ');
        throw new Error(
            `stage-native-rdp: staged core still references removed WASM RDP files: ${detail}`,
        );
    }

    return { installed, removed, absent, rewrites };
}

/* CLI: `node scripts/stage-native-rdp.mjs <coreDir> [embedDir]` */
const invokedDirectly = process.argv[1]
    && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
    const coreDir = process.argv[2];
    if (!coreDir) {
        console.error('usage: node scripts/stage-native-rdp.mjs <coreDir> [embedDir]');
        process.exit(2);
    }
    const embedDir = process.argv[3]
        || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'embed');
    try {
        const result = applyNativeRdp({ coreDir, embedDir });
        console.log(
            `stage-native-rdp: installed ${result.installed.length}, `
            + `removed ${result.removed.length} WASM files, `
            + `app.js rewrites ${result.rewrites}`
            + (result.absent.length ? `, already absent ${result.absent.length}` : ''),
        );
    } catch (error) {
        console.error(String(error.message || error));
        process.exit(1);
    }
}
