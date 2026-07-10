import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const read = (path) => fs.readFile(new URL(`../${path}`, import.meta.url), 'utf8');

function idsIn(html) {
    return [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
}

test('toolbar range is the only viewport zoom writer', async () => {
    const [touch, client] = await Promise.all([read('public/rdp-touch.js'), read('public/rdp-wasm-client.js')]);
    for (const forbidden of ['onZoomChange', 'rdpScaleZoom', 'zoomSlider', 'rdpResizeDisplay', 'applyViewTransform']) {
        assert.equal(touch.includes(forbidden), false, `touch controller must not reference ${forbidden}`);
    }
    const writes = [...client.matchAll(/\brdpScaleZoom\s*=/g)];
    assert.equal(writes.length, 2, 'only declaration and slider input may write rdpScaleZoom');
    const sliderStart = client.indexOf("zoomSlider.addEventListener('input'");
    assert.ok(sliderStart >= 0);
    assert.ok(writes[1].index > sliderStart && writes[1].index < sliderStart + 300);
});

test('touch settings persist through UI, API and storage layers', async () => {
    const files = await Promise.all([
        read('public/app.html'),
        read('public/app.js'),
        read('public/rdp-wasm-client.js'),
        read('server.js'),
        read('storage.js'),
    ]);
    for (const field of ['rdpTouchMode', 'rdpTouchSensitivity']) {
        for (const [index, source] of files.entries()) {
            assert.ok(source.includes(field), `${field} missing from persistence layer ${index}`);
        }
    }
});

test('modified pages have unique element ids', async () => {
    for (const path of ['public/app.html', 'public/rdp.html']) {
        const ids = idsIn(await read(path));
        assert.equal(new Set(ids).size, ids.length, `${path} contains duplicate ids`);
    }
});

test('T6 floating toolbar was not introduced', async () => {
    const files = await Promise.all([read('public/rdp.html'), read('public/rdp-wasm-client.js')]);
    const joined = files.join('\n');
    for (const id of ['rdpFloatBar', 'fbZoomIn', 'fbZoomOut', 'rdpEdgeTrigger']) {
        assert.equal(joined.includes(id), false, `${id} must remain absent`);
    }
});

test('horizontal wheel is exported and capability-advertised', async () => {
    const [main, grdp, pdu] = await Promise.all([
        read('rdp-wasm/main.go'),
        read('rdp-wasm/grdp-patch/grdp.go'),
        read('rdp-wasm/grdp-patch/protocol/pdu/pdu.go'),
    ]);
    assert.ok(main.includes('rdpMouseHScroll'));
    assert.ok(main.includes('MouseHWheel'));
    assert.ok(grdp.includes('PTRFLAGS_HWHEEL'));
    assert.ok(pdu.includes('INPUT_FLAG_MOUSE_HWHEEL'));
});
