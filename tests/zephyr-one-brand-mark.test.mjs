import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zephyr One brand mark + app icon contracts.
 *
 * Zephyr One embeds the *main* product UI, so without this the header would
 * show Zephyr's own wind mark and the two products would be visually
 * indistinguishable. The One mark is the same wind strokes carrying an "One"
 * wordmark, and it must stay byte-identical to the shipped artwork in
 * zephyr_one/platform_assets/icons/ — if the SVGs are redrawn, the inline mark
 * has to follow, and that drift is exactly what these tests catch.
 *
 * theme-runtime.js is a browser ES module, and this repo has no DOM library.
 * Rather than grep the source (which cannot prove what is emitted, and would
 * not have caught the ReferenceError this file was written after), a minimal
 * documentElement stub is installed so the real functions run and their output
 * is asserted.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const ONE_ICON_DIR = 'zephyr_one/platform_assets/icons';
const RUNTIME_ICON_DIR = 'zephyr_one/src-tauri/runtime-icons';
const BUNDLE_ICON_DIR = 'zephyr_one/src-tauri/icons';
const PALETTES = ['frost', 'lava', 'asagi', 'cyber'];

/* ── minimal DOM ─────────────────────────────────────────────────────── */

/** Install the smallest documentElement theme-runtime.js actually touches. */
function installDom({ product = '', scheme = 'frost', inlineVars = {} } = {}) {
    const attrs = new Map();
    if (scheme) attrs.set('data-color-scheme', scheme);
    globalThis.document = {
        documentElement: {
            dataset: product ? { zephyrProduct: product } : {},
            getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
            setAttribute: (name, value) => attrs.set(name, String(value)),
            style: {
                getPropertyValue: (name) => inlineVars[name] || '',
                setProperty: (name, value) => { inlineVars[name] = value; },
                removeProperty: (name) => { delete inlineVars[name]; },
            },
        },
    };
}

function clearDom() {
    delete globalThis.document;
}

/** Fresh module instance per case: `iconSeq` is module state. */
async function loadThemeRuntime() {
    const url = new URL('../public/theme-runtime.js', import.meta.url);
    // Cache-bust so each test gets its own module registry entry.
    return import(`${url.href}?t=${Math.random()}`);
}

/* ── artwork parsing ─────────────────────────────────────────────────── */

/** Pull the three stroke paths, in document order, out of an SVG. */
function pathsOf(svg) {
    return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

function gradientStopsOf(svg) {
    return [...svg.matchAll(/stop-color="(#[0-9a-f]{6})"/gi)].map((m) => m[1].toLowerCase());
}

/** frost is the palette baked into the installer icon and the fallback. */
function iconPalettes() {
    const source = read('public/theme-runtime.js');
    const block = source.match(/const ICON_PALETTES = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
    assert.ok(block, 'ICON_PALETTES must exist in theme-runtime.js');
    const out = {};
    for (const palette of PALETTES) {
        const entry = block[1].match(new RegExp(`${palette}:\\s*\\{([^}]+)\\}`));
        assert.ok(entry, `${palette} palette must exist`);
        const field = (key) => {
            const m = entry[1].match(new RegExp(`${key}:\\s*'([^']+)'`));
            assert.ok(m, `${palette}.${key} must exist`);
            return m[1].toLowerCase();
        };
        out[palette] = {
            main: field('main'), mid: field('mid'), dark: field('dark'),
            title: field('title'), dotB: field('dotB'), midOffset: field('midOffset'),
        };
    }
    return out;
}

/* ── tests ───────────────────────────────────────────────────────────── */

test('the four One palette SVGs ship and differ only in colour', () => {
    const bodies = PALETTES.map((name) => {
        const rel = `${ONE_ICON_DIR}/zephyr-one-${name}.svg`;
        assert.ok(existsSync(path.join(root, rel)), `${rel} must exist`);
        return read(rel);
    });

    // Geometry is shared; only stop-colors / fills may differ. Normalising every
    // hex to a placeholder must collapse all four to one string.
    const normalised = bodies.map((b) => b.replace(/#[0-9a-f]{6}/gi, '#hex'));
    for (let i = 1; i < normalised.length; i += 1) {
        assert.equal(normalised[i], normalised[0], `${PALETTES[i]} geometry must match frost`);
    }

    // Each palette's gradient must use its own three ramp colours.
    const palettes = iconPalettes();
    bodies.forEach((svg, i) => {
        const name = PALETTES[i];
        assert.deepEqual(
            gradientStopsOf(svg),
            [palettes[name].main, palettes[name].mid, palettes[name].dark],
            `${name} gradient must be its ICON_PALETTES ramp`,
        );
        assert.ok(svg.includes(palettes[name].title), `${name} wordmark must use its title colour`);
    });
});

test('the app-icon SVG keeps its white plate but the inline mark does not', async () => {
    // The plate exists so light-grey strokes stay visible on a light OS taskbar.
    // Inline it would punch a white square into a dark UI.
    const artwork = read(`${ONE_ICON_DIR}/zephyr-one-frost.svg`);
    assert.match(artwork, /<rect width="200" height="200" rx="44" fill="#ffffff"\/>/);

    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        const html = zephyrBrandIconHtml();
        assert.doesNotMatch(html, /rx="44"/, 'inline mark must not carry the plate');
        assert.doesNotMatch(html, /fill="#ffffff"\/><\/svg>/);
    } finally {
        clearDom();
    }
});

test('inline One mark reproduces the shipped artwork geometry exactly', async () => {
    const artworkPaths = pathsOf(read(`${ONE_ICON_DIR}/zephyr-one-frost.svg`));
    assert.equal(artworkPaths.length, 3, 'artwork must have main/mid/tail strokes');

    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        const html = zephyrBrandIconHtml();
        assert.deepEqual(pathsOf(html), artworkPaths, 'inline paths must equal the artwork paths');

        // The wordmark's "O" sits where Zephyr's dot-a would be, so the mid
        // stroke is masked there and dot-a is absent.
        assert.match(html, /<mask id="zephyr-one-cut-\d+"/);
        assert.match(html, /<ellipse cx="145" cy="115" rx="5" ry="4\.8"/);
        assert.match(html, /class="wind-path-mid"[^>]*mask="url\(#zephyr-one-cut-\d+\)"/);
        assert.doesNotMatch(html, /zephyr-icon-dot-a/, 'the "O" replaces dot-a');
        assert.match(html, /zephyr-icon-dot-b/, 'dot-b at (75,125) is kept');

        // Wordmark, split so the "O" can be centred in the masked gap.
        assert.match(html, /<text x="145" y="120\.7" text-anchor="middle">O<\/text>/);
        assert.match(html, /<text x="152\.4" y="120\.7">ne<\/text>/);

        // Colours must come from the shared CSS vars, which is what makes the
        // mark follow the active colour scheme with no extra wiring.
        assert.match(html, /var\(--zephyr-icon-grad-start,/);
        assert.match(html, /var\(--zephyr-icon-grad-mid,/);
        assert.match(html, /var\(--zephyr-icon-grad-end,/);
        assert.match(html, /fill="var\(--zephyr-icon-title,/);

        // The stroke widths live in style.css, keyed off these classes.
        for (const cls of ['wind-path-main', 'wind-path-mid', 'wind-path-tail']) {
            assert.ok(html.includes(`class="${cls}"`), `${cls} must be present for the CSS widths`);
        }
    } finally {
        clearDom();
    }
});

test('the product marker is what selects the One mark', async () => {
    // Zephyr proper must be untouched by all of this.
    installDom({ product: '' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        const html = zephyrBrandIconHtml();
        assert.doesNotMatch(html, />ne</, 'Zephyr mark must not carry the wordmark');
        assert.doesNotMatch(html, /zephyr-one-cut/, 'Zephyr mark must not be masked');
        assert.match(html, /zephyr-icon-dot-a/, 'Zephyr mark keeps its dot-a');
        assert.match(html, /M 85 95 C 110 110, 135 135, 155 130/, 'Zephyr keeps its own tail');
    } finally {
        clearDom();
    }

    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        assert.match(zephyrBrandIconHtml(), />ne</);
    } finally {
        clearDom();
    }
});

test('a user-uploaded icon still wins over the product mark', async () => {
    // brandIcon is a user setting; One must not hijack a deliberate override.
    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        assert.equal(zephyrBrandIconHtml(dataUrl), `<img src="${dataUrl}" alt="">`);
        assert.equal(zephyrBrandIconHtml('🚀'), '🚀');
    } finally {
        clearDom();
    }
});

test('gradient and mask ids are unique per call', async () => {
    // The header, the settings preview and the login logo can all be on one
    // page; duplicate ids would make every mark resolve to the first gradient.
    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        const ids = [];
        for (let i = 0; i < 3; i += 1) {
            const html = zephyrBrandIconHtml();
            ids.push(html.match(/id="(zephyr-one-gradient-\d+)"/)[1]);
            ids.push(html.match(/id="(zephyr-one-cut-\d+)"/)[1]);
        }
        assert.equal(new Set(ids).size, ids.length, `ids must be unique: ${ids.join(',')}`);
    } finally {
        clearDom();
    }
});

test('the One favicon uses literal palette colours for every scheme', async () => {
    // A `data:` URL renders outside the document, so CSS custom properties
    // resolve to nothing there — every colour must be baked in.
    const palettes = iconPalettes();
    for (const scheme of PALETTES) {
        installDom({ product: 'one', scheme });
        try {
            const { zephyrFaviconHref } = await loadThemeRuntime();
            const href = zephyrFaviconHref();
            assert.ok(href.startsWith('data:image/svg+xml,'), 'favicon must be an inline SVG');
            const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));

            assert.doesNotMatch(svg, /var\(--/, 'favicon must contain no CSS vars');
            assert.deepEqual(
                gradientStopsOf(svg),
                [palettes[scheme].main, palettes[scheme].mid, palettes[scheme].dark],
                `${scheme} favicon ramp`,
            );
            assert.ok(svg.includes(palettes[scheme].title), `${scheme} wordmark colour`);
            assert.match(svg, />ne</, 'favicon must be the One mark');
            assert.match(svg, /<mask id="gcut"/);
            assert.doesNotMatch(svg, /rx="44"/, 'favicon needs no plate');

            // Same geometry as the inline mark and the artwork.
            assert.deepEqual(pathsOf(svg), pathsOf(read(`${ONE_ICON_DIR}/zephyr-one-frost.svg`)));
        } finally {
            clearDom();
        }
    }
});

test('Zephyr favicon is unchanged when the marker is absent', async () => {
    installDom({ product: '', scheme: 'frost' });
    try {
        const { zephyrFaviconHref } = await loadThemeRuntime();
        const svg = decodeURIComponent(zephyrFaviconHref().slice('data:image/svg+xml,'.length));
        assert.doesNotMatch(svg, />ne</);
        assert.doesNotMatch(svg, /<mask/);
        assert.match(svg, /circle cx="145" cy="115" r="4\.5"/, 'Zephyr keeps dot-a');
    } finally {
        clearDom();
    }
});

test('the embedded surface injects the product marker exactly once', async () => {
    const { applyEmbeddedSurface } = await import('../zephyr-one-embed-surface.js');
    const html = read('public/app.html');

    assert.doesNotMatch(html, /data-zephyr-product/, 'app.html must not ship the marker');

    const first = applyEmbeddedSurface(html);
    assert.ok(first.applied.includes('mark-one-product'));
    assert.match(first.html, /<html lang="zh-CN" data-theme="dark" data-zephyr-product="one">/);
    assert.equal(first.html.match(/data-zephyr-product/g).length, 1);

    // Idempotent: a second pass must not add a second attribute.
    const second = applyEmbeddedSurface(first.html);
    assert.equal(second.html.match(/data-zephyr-product/g).length, 1);
    assert.ok(second.skipped.includes('mark-one-product'));
});

test('runtime icon PNGs exist for every palette and are real PNGs', () => {
    const files = readdirSync(path.join(root, RUNTIME_ICON_DIR)).sort();
    assert.deepEqual(files, PALETTES.map((p) => `zephyr-one-${p}.png`).sort());

    for (const palette of PALETTES) {
        const buf = readFileSync(path.join(root, RUNTIME_ICON_DIR, `zephyr-one-${palette}.png`));
        assert.deepEqual(
            [...buf.subarray(0, 8)],
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            `${palette} must be a PNG`,
        );
        // IHDR width/height are big-endian u32 at offsets 16 and 20.
        assert.equal(buf.readUInt32BE(16), 128, `${palette} width`);
        assert.equal(buf.readUInt32BE(20), 128, `${palette} height`);
    }
});

test('bundle icons are regenerated from the One artwork, not Agent', () => {
    // A stale Agent-derived icon would ship an installer that looks like Agent.
    const png = readFileSync(path.join(root, BUNDLE_ICON_DIR, 'icon.png'));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 512);

    // The One artwork has an opaque plate, Agent's PNG is fully transparent at
    // the centre-top. Sampling is out of scope here, so assert the far cheaper
    // invariant: One's bundle icon must not be byte-identical to Agent's.
    const agent = path.join(root, 'zephyr_agent/assets/icons/zephyr-agent-frost.png');
    if (existsSync(agent)) {
        assert.notEqual(
            readFileSync(agent).toString('base64'),
            png.toString('base64'),
            'bundle icon must be generated from the One artwork',
        );
    }

    const ico = readFileSync(path.join(root, BUNDLE_ICON_DIR, 'icon.ico'));
    assert.deepEqual([...ico.subarray(0, 4)], [0x00, 0x00, 0x01, 0x00], 'ICO header');
    const icns = readFileSync(path.join(root, BUNDLE_ICON_DIR, 'icon.icns'));
    assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns', 'ICNS magic');
});

test('the Rust side embeds one artwork per palette and defaults to frost', () => {
    const rs = read('zephyr_one/src-tauri/src/icon/mod.rs');

    for (const palette of PALETTES) {
        assert.ok(
            rs.includes(`include_bytes!("../../runtime-icons/zephyr-one-${palette}.png")`),
            `${palette} artwork must be embedded`,
        );
    }
    // frost is the palette baked into the installer icon, so the runtime
    // fallback must agree or first launch would show two different icons.
    assert.match(rs, /const DEFAULT_THEME: &str = "frost";/);

    // macOS has no per-window icon; pretending otherwise would be a silent no-op.
    assert.match(rs, /#\[cfg\(target_os = "macos"\)\]/);
    assert.match(rs, /applied: false/);

    // Reading the core's own HTTP API avoids granting IPC to a remote origin.
    assert.match(rs, /api\/me\/settings/);
    assert.match(rs, /settings.*appearance.*colorScheme|"colorScheme"/s);

    // Cargo must enable the feature Image::from_bytes lives behind.
    assert.match(
        read('zephyr_one/src-tauri/Cargo.toml'),
        /tauri = \{ version = "2", features = \["image-png"\] \}/,
        'Image::from_bytes requires the image-png feature',
    );

    // The command has to be reachable from JS.
    assert.match(read('zephyr_one/src-tauri/src/lib.rs'), /commands::set_theme_icon/);
});

test('the icon generator is wired into npm and reads the One SVGs', () => {
    const pkg = JSON.parse(read('zephyr_one/package.json'));
    assert.equal(pkg.scripts.icons, 'python3 scripts/prepare-icons.py');

    const script = read('zephyr_one/scripts/prepare-icons.py');
    assert.match(script, /platform_assets\/icons|platform_assets" \/ "icons/);
    assert.match(script, /runtime-icons/);
    for (const palette of PALETTES) {
        assert.ok(script.includes(palette), `${palette} must be generated`);
    }
    // Mobile is gone; the generator must not reference Agent's PNG any more.
    assert.doesNotMatch(script, /zephyr_agent/, 'One icons must come from One artwork');
});
