import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../public/preview/preview-wasm.js', import.meta.url), 'utf8');
function harness({ fetchError, execCode = 0 } = {}) {
    const events = [], files = new Map();
    let created = 0;
    const ffmpeg = {
        load: async () => {},
        writeFile: async (name, data) => { events.push(['write', name]); files.set(name, data); },
        exec: async (args) => { events.push(['exec', args]); await new Promise(r => setTimeout(r, 2)); files.set(args.at(-1), new Uint8Array([1, 2, 3])); return execCode; },
        readFile: async name => { events.push(['read', name]); return files.get(name); },
        deleteFile: async name => { events.push(['delete', name]); files.delete(name); },
    };
    const context = { window: {}, Uint8Array, Blob, TextEncoder, console,
        URL: { createObjectURL: () => `blob:test-${++created}`, revokeObjectURL: url => events.push(['revoke', url]) },
        fetch: async (url, opts) => {
            events.push(['fetch', url, opts]);
            if (fetchError) throw fetchError;
            return { ok: true, headers: { get: () => '3' }, arrayBuffer: async () => new Uint8Array([3, 4, 5]).buffer };
        },
        loadTestFfmpeg: async () => ffmpeg,
    };
    // Replace only the loader boundary; execute all production decision/queue/cleanup code.
    vm.runInNewContext(source.replace('ffmpegPromise = import(FFMPEG_URL).then(async (mod) => {', 'ffmpegPromise = Promise.resolve({ FFmpeg: function () { return loadTestFfmpegObject; } }).then(async (mod) => {'), { ...context, loadTestFfmpegObject: ffmpeg });
    return { api: context.window.ZephyrPreviewWasm, events, files };
}

test('direct audio support must match the file format, not an unrelated codec', async () => {
    const h = harness();
    for (const [name, audio] of [['x.mp3', { aac: true }], ['x.flac', { mp3: true }], ['x.wav', { opus: true }]]) {
        const result = await h.api.prepareMedia('/stream', { kind: 'audio', name, capabilities: { audio } });
        assert.equal(result.mode, 'TRANSCODED', name);
    }
    assert.equal((await h.api.prepareMedia('/mp3', { kind: 'audio', name: 'x.mp3', capabilities: { audio: { mp3: true } } })).mode, 'DIRECT');
});

test('MP4/WebM direct support checks their own container capabilities', async () => {
    const h = harness();
    assert.equal((await h.api.prepareMedia('/stream', { name: 'x.mp4', capabilities: { video: { vp8: true } } })).mode, 'TRANSCODED');
    assert.equal((await h.api.prepareMedia('/stream', { name: 'x.webm', capabilities: { video: { h264: true } } })).mode, 'TRANSCODED');
    assert.equal((await h.api.prepareMedia('/mp4', { name: 'x.mp4', capabilities: { video: { h264: true } } })).mode, 'DIRECT');
});

test('forceTranscode overrides supported extension after real decoder rejection', async () => {
    const h = harness();
    const result = await h.api.prepareMedia('/stream', { name: 'x.mp4', capabilities: { video: { h264: true } }, forceTranscode: true });
    assert.equal(result.mode, 'TRANSCODED');
    assert.equal(result.owned, true);
    assert.equal(h.files.size, 0);
    const args = h.events.find(e => e[0] === 'exec')[1];
    assert.ok(args.includes('yuv420p'));
});

test('concurrent windows serialize download/transcode/cleanup and use distinct files', async () => {
    const h = harness();
    const results = await Promise.all(['a.avi', 'b.avi', 'c.aiff'].map(name => h.api.prepareMedia('/'+name, { kind: name.endsWith('aiff') ? 'audio' : 'video', name })));
    assert.equal(new Set(results.map(r => r.url)).size, 3);
    const steps = h.events.map(e => e[0]);
    assert.deepEqual(steps, Array(3).fill(['fetch', 'write', 'exec', 'read', 'delete', 'delete']).flat());
    assert.equal(new Set(h.events.filter(e => e[0] === 'write').map(e => e[1])).size, 3);
    assert.equal(h.files.size, 0);
});

test('failed transcode cleans its files and does not poison the queue', async () => {
    const h = harness({ execCode: 1 });
    await assert.rejects(h.api.prepareMedia('/bad', { name: 'bad.avi' }), /转码失败/);
    await assert.rejects(h.api.prepareMedia('/second', { name: 'second.avi' }), /转码失败/);
    assert.equal(h.events.filter(e => e[0] === 'exec').length, 2);
    assert.equal(h.files.size, 0);
});

test('aborted queued requests never download or write to WASM', async () => {
    const h = harness();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(h.api.prepareMedia('/closed', { name: 'closed.avi', signal: controller.signal }), { name: 'AbortError' });
    assert.equal(h.events.length, 0);
});

test('direct URLs are not revoked; converted blob URLs are released', async () => {
    const h = harness();
    h.api.releaseMedia({ url: '/stream', owned: false });
    const p = await h.api.prepareMedia('/avi', { name: 'x.avi' }); h.api.releaseMedia(p);
    assert.deepEqual(h.events.filter(e => e[0] === 'revoke'), [['revoke', p.url]]);
});
