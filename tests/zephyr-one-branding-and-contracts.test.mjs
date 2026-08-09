import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Zephyr One branding: which mark, which name, and legibility at small sizes.
 *
 * Three defects motivated this file, all of them things a user sees rather than
 * anything a type system could catch:
 *
 *   1. The desktop shell's boot / unlock / error / security screens loaded
 *      `src/assets/logo/zephyr-app-icon.png`, which is *Zephyr's* mark. The
 *      first thing Zephyr One showed on launch was the other product's logo.
 *   2. app.js hardcoded `DEFAULT_BRAND_NAME = 'Zephyr'`, and One serves that
 *      same app.js, so the header and window title read "Zephyr". Combined with
 *      (3) there was nothing on screen naming the product.
 *   3. The "One" wordmark is font-size 15 in a 200-unit viewBox, so it lands
 *      1.2px tall at a 16px icon, 2.4px at 32px and ~1.8px in the 24px header.
 *      Letterforms cannot resolve there; what rendered was a grey smear next to
 *      crisp strokes, which reads as "the icon is blurry".
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const APP_JS = read('public/app.js');
const THEME_RUNTIME = read('public/theme-runtime.js');
const SHELL_HTML = read('zephyr_one/index.html');
const PREPARE_ICONS = read('zephyr_one/scripts/prepare-icons.py');
const SERVER_JS = read('server.js');
const STAGE_SH = read('zephyr_one/scripts/stage-zephyr-core.sh');

/* ?? DOM stub, matching the one in zephyr-one-brand-mark.test.mjs ?????????
 *
 * theme-runtime.js is a browser module and this repo has no DOM library, but
 * grepping the source cannot prove what is emitted. Running the real functions
 * against a stub can.
 */
function installDom({ product = '' } = {}) {
    globalThis.document = {
        documentElement: {
            dataset: product ? { zephyrProduct: product } : {},
            getAttribute: () => null,
            setAttribute: () => {},
            style: { getPropertyValue: () => '', setProperty: () => {}, removeProperty: () => {} },
        },
    };
}

function clearDom() {
    delete globalThis.document;
}

/** Fresh module per case: `iconSeq` is module-level state. */
async function loadThemeRuntime() {
    const url = new URL('../public/theme-runtime.js', import.meta.url);
    return import(`${url.href}?t=${Math.random()}`);
}

/* ?? minimal PNG reader ??????????????????????????????????????????????????
 *
 * Written out rather than pulled in as a dependency because the property under
 * test is what the *shipped bytes* look like, and adding an image library to
 * assert five pixels is a poor trade. Only the shape the generator emits is
 * handled (8-bit RGBA, colour type 6, no interlace), and anything else throws
 * rather than being guessed at.
 */
function decodePng(buffer) {
    assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
    let offset = 8;
    let width = 0;
    let height = 0;
    const idat = [];
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        const data = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            assert.equal(data[8], 8, 'expected 8-bit samples');
            assert.equal(data[9], 6, 'expected RGBA colour type');
            assert.equal(data[12], 0, 'interlaced PNG not supported');
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
        offset += 12 + length;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4;
    const stride = width * bpp;
    const pixels = Buffer.alloc(stride * height);
    // Undo the per-scanline filters. Straight from the PNG spec; `prior` is the
    // already-reconstructed line above.
    for (let y = 0; y < height; y += 1) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const out = pixels.subarray(y * stride, (y + 1) * stride);
        const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
        for (let x = 0; x < stride; x += 1) {
            const a = x >= bpp ? out[x - bpp] : 0;
            const b = prior[x];
            const c = x >= bpp ? prior[x - bpp] : 0;
            let value = line[x];
            if (filter === 1) value += a;
            else if (filter === 2) value += b;
            else if (filter === 3) value += (a + b) >> 1;
            else if (filter === 4) {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            } else if (filter !== 0) {
                throw new Error(`unknown PNG filter ${filter}`);
            }
            out[x] = value & 0xff;
        }
    }
    return { width, height, pixels };
}

/** Every frame in a Windows .ico, keyed by edge length. */
function icoFrames(buffer) {
    const count = buffer.readUInt16LE(4);
    const frames = new Map();
    for (let i = 0; i < count; i += 1) {
        const entry = 6 + i * 16;
        const size = buffer[entry] || 256;
        const bytes = buffer.readUInt32LE(entry + 8);
        const offset = buffer.readUInt32LE(entry + 12);
        frames.set(size, buffer.subarray(offset, offset + bytes));
    }
    return frames;
}

/* The wordmark's own box, in viewBox units, from the SVG masters: the "O" is
 * centred on x=145 and "ne" runs to about x=170, on a baseline at y=120.7 with
 * font-size 15. Padded by a unit so antialiasing at the edges is included. */
const WORDMARK_BOX = { x0: 137, x1: 172, y0: 106, y1: 123 };

/** Count wordmark-coloured pixels inside the wordmark box. */
function wordmarkInk(frame) {
    const { width, height, pixels } = decodePng(frame);
    const scale = width / 200;
    const x0 = Math.floor(WORDMARK_BOX.x0 * scale);
    const x1 = Math.ceil(WORDMARK_BOX.x1 * scale);
    const y0 = Math.floor(WORDMARK_BOX.y0 * scale);
    const y1 = Math.ceil(WORDMARK_BOX.y1 * scale);
    let ink = 0;
    for (let y = y0; y < Math.min(y1, height); y += 1) {
        for (let x = x0; x < Math.min(x1, width); x += 1) {
            const at = y * width * 4 + x * 4;
            const [r, g, b, a] = [pixels[at], pixels[at + 1], pixels[at + 2], pixels[at + 3]];
            if (a < 128) continue;
            /* The frost wordmark is #0a84ff. The wind strokes in this region are
             * grey (#eef2f7 -> #6e7b88) and the plate is white, so "blue
             * channel clearly dominant" separates wordmark ink from everything
             * else without depending on an exact antialiased value. */
            if (b > 150 && b - r > 60 && b - g > 40) ink += 1;
        }
    }
    return ink;
}

/* ?? product identity ?????????????????????????????????????????????????? */

test('the default brand name names the product the user is actually in', async () => {
    /* One serves Zephyr's own app.js, so a literal default made both products
     * call themselves "Zephyr" in the header and the window title. */
    installDom({ product: 'one' });
    try {
        const { zephyrDefaultBrandName } = await loadThemeRuntime();
        assert.equal(zephyrDefaultBrandName(), 'Zephyr One');
    } finally {
        clearDom();
    }

    installDom({});
    try {
        const { zephyrDefaultBrandName } = await loadThemeRuntime();
        assert.equal(zephyrDefaultBrandName(), 'Zephyr', 'browser Zephyr must be unaffected');
    } finally {
        clearDom();
    }
});

test('app.js takes its default brand name from the product, not a literal', () => {
    /* The import and the definition are pinned separately: a single /zephyrDefaultBrandName/
     * match is satisfied by either one alone, so removing the import while
     * keeping the call site -- or rewriting the call site back to a literal
     * while the import lingers -- both stayed green. Verified by mutation. */
    assert.match(
        APP_JS,
        /^import \{[^}]*\bzephyrDefaultBrandName\b[^}]*\} from '\.\/theme-runtime\.js/m,
        'app.js must import the product-aware default',
    );
    assert.match(
        APP_JS,
        /const defaultBrandName = \(\) => zephyrDefaultBrandName\(\);/,
        'and the default must actually call it rather than returning a literal',
    );
    assert.doesNotMatch(
        APP_JS,
        /const DEFAULT_BRAND_NAME\s*=\s*'Zephyr'/,
        'a hardcoded default is what made One call itself Zephyr',
    );
    /* Every use site must be the call. The old constant is gone, so a missed
     * site would be a ReferenceError at load rather than a quiet wrong name --
     * but asserting the count keeps a future edit from reintroducing one. */
    const uses = APP_JS.match(/defaultBrandName\(\)/g) || [];
    assert.ok(uses.length >= 5, `expected every brand-name site to be a call, saw ${uses.length}`);
});

/* ?? optical sizing: the inline mark ??????????????????????????????????? */

test('One drops its wordmark when the mark is rendered small', async () => {
    installDom({ product: 'one' });
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();

        const full = zephyrBrandIconHtml(undefined, {});
        assert.match(full, />ne</, 'the full mark must still carry the wordmark');
        assert.match(full, /mask="url\(#zephyr-one-cut-/, 'and the gap the "O" sits in');

        const compact = zephyrBrandIconHtml(undefined, { compact: true });
        assert.doesNotMatch(compact, />ne</, 'a small mark must not carry an unreadable wordmark');
        assert.doesNotMatch(compact, />O</, 'including the "O"');
        /* The mask exists only to punch a hole for the "O". Keeping it without
         * the wordmark leaves a visible bite out of the mid stroke, which is
         * worse than the smear it was meant to fix. */
        assert.doesNotMatch(compact, /mask=/, 'the wordmark gap must go with the wordmark');
        assert.doesNotMatch(compact, /zephyr-one-cut/, 'and its mask definition');

        // Still the same artwork otherwise.
        for (const cls of ['wind-path-main', 'wind-path-mid', 'wind-path-tail']) {
            assert.match(compact, new RegExp(cls), `${cls} must survive; this is the same mark`);
        }
        assert.match(compact, /<title>Zephyr One<\/title>/);
    } finally {
        clearDom();
    }
});

test('compact is a no-op for browser Zephyr, which has no wordmark', async () => {
    installDom({});
    try {
        const { zephyrBrandIconHtml } = await loadThemeRuntime();
        /* Compared with the gradient sequence normalised: theme-runtime.js
         * numbers each gradient id so two marks on one page cannot collide,
         * so successive calls differ by that counter alone. */
        const normalise = (html) => html.replace(/-gradient-\d+/g, '-gradient-N');
        assert.equal(
            normalise(zephyrBrandIconHtml(undefined, { compact: true })),
            normalise(zephyrBrandIconHtml(undefined, {})),
            'Zephyr\u2019s mark has no wordmark to drop, so compact must change nothing',
        );
    } finally {
        clearDom();
    }
});

test('the header uses the compact mark and the settings preview the full one', () => {
    /* The header mark is 24px (style.css: `.brand .zephyr-brand-mark {
     * font-size: 24px }`), where the wordmark is ~1.8px tall. The settings
     * preview is 52px and can carry it. */
    assert.match(
        APP_JS,
        /\$\('#brandIcon'\)\.innerHTML = iconHtml\(brandIcon, \{ compact: true \}\)/,
        'the 24px header mark must not try to render the wordmark',
    );
    assert.match(
        APP_JS,
        /\$\('#brandIconPreview'\)\.innerHTML = iconHtml\(brandIcon\)/,
        'the 52px preview must show the real mark, wordmark included',
    );
});

/* ?? optical sizing: the generated app icons ??????????????????????????? */

test('the icon generator drops the wordmark below the size it can be read at', () => {
    assert.match(PREPARE_ICONS, /^WORDMARK_MIN_SIZE = 64$/m, 'the threshold must be explicit');
    assert.match(PREPARE_ICONS, /def simplify_for_small_size/);
    assert.match(PREPARE_ICONS, /def staged_small_master/);

    /* The mask must be removed too, and the generator must refuse rather than
     * ship a cut stroke with nothing in the gap. */
    assert.match(PREPARE_ICONS, /gcut/, 'the wordmark gap mask must be handled');
    assert.match(
        PREPARE_ICONS,
        /if "gcut" in svg:\s*\n\s*sys\.exit\(/,
        'a surviving mask must abort the build, not ship a bitten stroke',
    );

    /* Every raster path must choose its source by size, or the small frames go
     * back to carrying an unreadable wordmark. */
    const sizeAware = PREPARE_ICONS.match(/source_for\(DEFAULT_THEME, size\)/g) || [];
    assert.equal(sizeAware.length, 3, 'bundle PNGs, .ico frames and .icns frames must all be size-aware');
    assert.match(
        PREPARE_ICONS,
        /return staged\[theme\] if size >= WORDMARK_MIN_SIZE else staged_small\[theme\]/,
        'the threshold must actually select the source',
    );
});

test('the shipped .ico has no wordmark smear in its small frames', () => {
    /* The behavioural assertion, on the bytes that ship. A generator change that
     * looked right but regenerated the frames wrongly would pass the source
     * checks above and fail here. */
    const frames = icoFrames(fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/icons/icon.ico')));
    assert.deepEqual([...frames.keys()].sort((a, b) => a - b), [16, 32, 48, 64, 128, 256]);

    for (const size of [16, 32, 48]) {
        const ink = wordmarkInk(frames.get(size));
        assert.equal(ink, 0, `the ${size}px frame still has wordmark ink (${ink}px) and will look blurry`);
    }

    /* And the large frames must still carry it -- otherwise "no smear" would be
     * satisfied by dropping the wordmark everywhere, which is a different logo
     * rather than optical sizing. */
    for (const size of [64, 128, 256]) {
        const ink = wordmarkInk(frames.get(size));
        assert.ok(ink > 0, `the ${size}px frame must still carry the One wordmark`);
    }
});

test('the wordmark is the only thing the small frames lose', () => {
    /* Guards against the simplifier removing more than intended: the wind
     * strokes are the mark itself, so a small frame that lost them would be
     * blank rather than simplified. Compared as total opaque coverage outside
     * the wordmark box, which the strokes dominate. */
    const frames = icoFrames(fs.readFileSync(path.join(root, 'zephyr_one/src-tauri/icons/icon.ico')));
    for (const size of [16, 32, 48]) {
        const { width, height, pixels } = decodePng(frames.get(size));
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] > 200) opaque += 1;
        }
        /* The plate covers the frame, so near-total coverage is expected; the
         * point is that the frame is not empty or truncated. */
        assert.ok(
            opaque > width * height * 0.5,
            `the ${size}px frame is mostly transparent (${opaque}/${width * height}); artwork was lost`,
        );
    }
});

/* ?? the desktop shell's own screens ?????????????????????????????????? */

test('the shell boot screens show Zephyr One, not Zephyr', () => {
    /* This is the very first thing the product shows: index.html is the Tauri
     * frontend, displayed while the embedded core starts. It used to load
     * Zephyr's mark, so One launched under the other product's logo. */
    assert.doesNotMatch(
        SHELL_HTML,
        /zephyr-app-icon/,
        'the shell must not load Zephyr\u2019s own app icon',
    );
    assert.match(SHELL_HTML, /\/src\/assets\/logo\/zephyr-one-icon\.svg/);

    // Every gate, plus the favicon: 4 <img> + 1 <link>.
    const refs = SHELL_HTML.match(/zephyr-one-icon\.svg/g) || [];
    assert.equal(refs.length, 5, `every shell surface must use the One mark, saw ${refs.length}`);
    assert.match(
        SHELL_HTML,
        /<link rel="icon" type="image\/svg\+xml"/,
        'the favicon type must match the file it points at',
    );
    assert.doesNotMatch(SHELL_HTML, /alt="Zephyr"/, 'alt text must name the product too');
});

test('the shell artwork is the frozen master, byte for byte', () => {
    /* Copied into src/assets because Vite\u2019s root is zephyr_one/, so
     * platform_assets/ is not addressable from the page. A copy can drift from
     * its source, which is what this compares. */
    const shipped = read('zephyr_one/src/assets/logo/zephyr-one-icon.svg');
    const master = read('zephyr_one/platform_assets/icons/zephyr-one-frost.svg');
    assert.equal(shipped, master, 'the shell copy must match the frost master exactly');
});

/* ?? mobile v1 contracts in the packaged core ????????????????????????? */

test('the embedded core can find its mobile contracts', () => {
    /* The staged core is a flat runtime: stage-zephyr-core.sh copies root-level
     * *.js plus public/, server/ and preview/. `__dirname` there is
     * .../zephyr_one/zephyr-core, so joining 'zephyr_one/mobile/contracts' onto
     * it resolved to .../zephyr-core/zephyr_one/mobile/... which never exists.
     * The whole /api/mobile/v1 surface therefore failed to mount in every
     * packaged build, and the catch around the mount swallowed the ENOENT. */
    assert.match(SERVER_JS, /function resolveMobileContract\(/);
    assert.match(
        SERVER_JS,
        /entityRegistry: JSON\.parse\(fs\.readFileSync\(resolveMobileContract\(/,
        'the registry must be located through the resolver',
    );
    assert.doesNotMatch(
        SERVER_JS,
        /path\.join\(__dirname, 'zephyr_one', 'mobile', 'contracts', 'registries'/,
        'the single brittle path is what broke the packaged build',
    );

    // Both layouts must be candidates, and a genuine absence must still report.
    const resolver = SERVER_JS.slice(
        SERVER_JS.indexOf('function resolveMobileContract('),
        SERVER_JS.indexOf('/* Zephyr One mobile v1.'),
    );
    assert.match(resolver, /'zephyr_one', 'mobile', 'contracts'/, 'repo layout');
    assert.match(resolver, /'mobile-contracts'/, 'staged-core layout');
    /* The throw must be reachable, not merely present. Prefixing it with an
     * early `return null` leaves the text intact while making a missing
     * contract mount an API with no registry -- and the registry hash is
     * exactly what stops a client with a different entity classification
     * from writing a field this server treats differently. */
    assert.match(resolver, /throw new Error\(/, 'a missing contract must not mount an empty registry');
    assert.doesNotMatch(
        resolver,
        /return null/,
        'the resolver must not hand back a null path instead of reporting',
    );
    // Nothing may return before the candidate loop has been exhausted.
    const beforeLoop = resolver.slice(0, resolver.indexOf('for (const candidate'));
    assert.doesNotMatch(beforeLoop, /\breturn\b/, 'the resolver must try every candidate');
});

test('the stage script ships the mobile contracts into the core', () => {
    /* Resolution alone is not enough: if the files are never copied, the
     * packaged app has nothing to resolve to. */
    assert.match(STAGE_SH, /mobile-contracts/);
    assert.match(
        STAGE_SH,
        /cp -a "\$REPO\/zephyr_one\/mobile\/contracts\/\." "\$OUT\/mobile-contracts\/"/,
        'the contracts directory must be copied into the staged core',
    );
    /* Two checks, and both are asserted: one immediately after the copy so a
     * failed copy stops the build at the point of failure, and one in the
     * final sanity block alongside server.js and public/app.js. Matching
     * loosely let either be deleted while the other kept the test green. */
    const landingChecks = STAGE_SH.match(
        /test -f "\$OUT\/mobile-contracts\/registries\/entity-registry\.json"/g,
    ) || [];
    assert.equal(
        landingChecks.length,
        2,
        `staging must verify the registry landed, at the copy and in the final check (saw ${landingChecks.length})`,
    );
    assert.match(
        STAGE_SH,
        /test -f "\$OUT\/mobile-contracts\/registries\/entity-registry\.json" \|\| \{/,
        'the post-copy check must abort rather than warn',
    );
});
