import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * The in-app icon must be the product's own mark, not a placeholder.
 *
 * Written after a reported bug that every existing icon suite passed straight
 * through: `tests/zephyr-one-icon-artifacts.test.mjs` proved the *installer*
 * icons were correct, and `zephyr-one-brand-mark.test.mjs` proved
 * `zephyrFaviconHref()` emitted the right SVG -- but nothing checked what the
 * shipped HTML actually references. Every page carried
 *
 *     <link rel="icon" href="data:image/svg+xml,...<text>WIND EMOJI</text>...">
 *
 * so the icon on screen was an emoji glyph. app.js and client.js overwrite it
 * via setFavicon(), but that runs inside applyAppearance(), after the appearance
 * fetch resolves -- so the emoji still paints first. And rdp.html, novnc.html,
 * terminal.html and telnet-terminal.html never call setFavicon at all, which
 * made the emoji the only icon those pages ever had.
 *
 * The assertions below are about the bytes that ship, which is the layer the
 * other suites left uncovered.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

/* Pages that ship a favicon link. player/open/password-rollback deliberately
 * have none -- they are transient handoff pages -- so they are not listed. */
const PAGES = [
    'app.html',
    'index.html',
    'rdp.html',
    'novnc.html',
    'terminal.html',
    'telnet-terminal.html',
];

const ZEPHYR_MARK = '/zephyr-mark.svg';
const ONE_MARK = '/zephyr-one-mark.svg';

/** The one form the icon link may take. Compared verbatim, not by substring.
 *
 * A substring check is what let a real regression through: the first fix for
 * this bug replaced `<link rel="icon"[^>]*>`, whose `[^>]*` stops at the first
 * `>` inside the old data: URL, so every page ended up with the correct link
 * followed by the tail of the emoji SVG as bare text in <head>. Both
 * substring assertions still passed. An exact line comparison cannot. */
const ICON_LINK = '<link rel="icon" type="image/svg+xml" href="/zephyr-mark.svg">';

/** `<text>` anywhere in <head> means a glyph is standing in for the mark. */
const GLYPH_IN_HEAD = /<text[\s>]/i;

/** Everything up to </head>, which is where an icon link and its debris live. */
function headOf(html) {
    const end = html.indexOf('</head>');
    assert.ok(end > 0, 'every page must have a <head>');
    return html.slice(0, end);
}

test('both product marks ship as real files', () => {
    for (const rel of [`public${ZEPHYR_MARK}`, `public${ONE_MARK}`]) {
        assert.ok(existsSync(path.join(root, rel)), `${rel} must exist`);
    }

    const zephyr = read(`public${ZEPHYR_MARK}`);
    const one = read(`public${ONE_MARK}`);

    /* Vector, not a raster: these are rendered at 16px in a tab and at 32px+ in
     * a task switcher, and one bitmap cannot serve both without softening -- the
     * blurriness half of the same bug report. */
    for (const svg of [zephyr, one]) {
        assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(svg, /viewBox="0 0 200 200"/);
    }

    /* The One mark is the same wind strokes plus the wordmark. If these two ever
     * become identical, the products stop being distinguishable in the tab. */
    assert.notEqual(zephyr, one, 'the two products must not share one mark');
    assert.match(one, />O</, 'the One mark must carry its wordmark');
    assert.match(one, />ne</, 'the One mark must carry its wordmark');
    assert.doesNotMatch(zephyr, />ne</, 'the Zephyr mark must not carry the One wordmark');

    /* No white plate inline. The app-icon SVGs carry `rect rx="44" fill=#ffffff`
     * so the light strokes stay visible on a light taskbar; in a dark UI that
     * same plate is a white square punched behind the mark. */
    assert.doesNotMatch(zephyr, /rx="44"/, 'no white plate in the inline mark');
    assert.doesNotMatch(one, /rx="44"/, 'no white plate in the inline mark');

    /* Literal colours only. A `data:` URL and a <link href> both render outside
     * the document, where a CSS custom property resolves to nothing -- the mark
     * would come out unpainted. */
    assert.doesNotMatch(zephyr, /var\(--/, 'a linked SVG cannot resolve CSS vars');
    assert.doesNotMatch(one, /var\(--/, 'a linked SVG cannot resolve CSS vars');
});

test('no shipped page falls back to a glyph favicon', () => {
    for (const page of PAGES) {
        const head = headOf(read(`public/${page}`));

        /* Exactly one icon link, and it must be the expected line verbatim.
         * Counting matters as much as matching: a second link would win or lose
         * by document order, which is not something to leave to chance. */
        const links = head.match(/<link rel="icon"[^\n]*/g) || [];
        assert.equal(links.length, 1, `${page} must ship exactly one icon link`);
        assert.equal(
            links[0].trim(),
            ICON_LINK,
            `${page} icon link must be exactly the real mark, with no leftover markup`,
        );

        /* And no glyph markup anywhere in <head>. This is the assertion that
         * catches a partially-replaced link, where the correct href is present
         * but the old emoji SVG's tail survives as text beside it. */
        assert.doesNotMatch(
            head,
            GLYPH_IN_HEAD,
            `${page} must not leave glyph markup in <head>`,
        );
    }
});

test('the icon is correct on first paint, not only after a fetch', () => {
    /* The distinction that made the bug survive review: an icon applied by
     * JavaScript is right eventually, but the static link is what paints first.
     * On the four session pages there is no later correction at all. */
    const NEVER_CORRECTS = ['rdp.html', 'novnc.html', 'terminal.html', 'telnet-terminal.html'];
    for (const page of NEVER_CORRECTS) {
        const html = read(`public/${page}`);
        assert.ok(
            html.includes(`href="${ZEPHYR_MARK}"`),
            `${page} has no runtime setFavicon, so its static link must be the real mark`,
        );
    }

    /* And where a runtime correction does exist, it must still be reachable:
     * these two own setFavicon, so a rename would silently strand it. */
    for (const script of ['app.js', 'client.js']) {
        const source = read(`public/${script}`);
        assert.match(source, /function setFavicon\(/, `${script} must keep setFavicon`);
        assert.match(source, /zephyrFaviconHref/, `${script} must source the mark from theme-runtime`);
    }
});

test('One rewrites the favicon to its own mark', () => {
    const { applyEmbeddedSurface, FAVICON_LINK, ONE_FAVICON_LINK } = require(
        path.join(root, 'zephyr-one-embed-surface.js'),
    );

    /* The exported constants must match what app.html actually contains, or the
     * edit no-ops and One ships branded as Zephyr. */
    const html = read('public/app.html');
    assert.ok(html.includes(FAVICON_LINK), 'FAVICON_LINK must match app.html verbatim');

    const { html: out, applied } = applyEmbeddedSurface(html);
    assert.ok(applied.includes('one-favicon'), 'the favicon edit must run');
    assert.ok(out.includes(ONE_FAVICON_LINK), 'One must serve the One mark');
    assert.ok(!out.includes(FAVICON_LINK), 'the Zephyr mark must not survive in One');

    /* Idempotent: sendEmbeddedAppPage() transforms on every request. */
    assert.equal(applyEmbeddedSurface(out).html, out, 'the transform must be idempotent');
});

test('the linked marks match what theme-runtime paints', async () => {
    /* Drift guard, and the reason the files are generated rather than hand-drawn:
     * the runtime mark and the linked mark are two copies of one drawing, and a
     * redraw that touched only theme-runtime.js would leave the tab showing the
     * old artwork. Comparing against the real function rather than a copy of its
     * output is what makes that impossible. */
    const attrs = new Map([['data-color-scheme', 'frost']]);
    const install = (product) => {
        globalThis.document = {
            documentElement: {
                dataset: product ? { zephyrProduct: product } : {},
                getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
                setAttribute: (name, value) => attrs.set(name, String(value)),
                style: {
                    getPropertyValue: () => '',
                    setProperty: () => {},
                    removeProperty: () => {},
                },
            },
        };
    };
    const url = new URL('../public/theme-runtime.js', import.meta.url);
    const decode = (href) => {
        const prefix = 'data:image/svg+xml,';
        assert.ok(href.startsWith(prefix), 'favicon must be an inline SVG data URL');
        return decodeURIComponent(href.slice(prefix.length));
    };

    try {
        install('');
        const zephyrModule = await import(`${url.href}?zephyr=${Math.random()}`);
        assert.equal(
            decode(zephyrModule.zephyrFaviconHref()),
            read(`public${ZEPHYR_MARK}`).trim(),
            'public/zephyr-mark.svg must equal what theme-runtime paints for Zephyr',
        );

        install('one');
        const oneModule = await import(`${url.href}?one=${Math.random()}`);
        assert.equal(
            decode(oneModule.zephyrFaviconHref()),
            read(`public${ONE_MARK}`).trim(),
            'public/zephyr-one-mark.svg must equal what theme-runtime paints for One',
        );
    } finally {
        delete globalThis.document;
    }
});
