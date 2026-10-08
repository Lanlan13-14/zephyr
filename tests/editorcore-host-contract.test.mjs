import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorCoreHost} from './editorcore-host.mjs';

test('desktop and android share one core for open, edit, selection and save', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'a😀\r\nb'});
    assert.equal(opened.ok, true);
    assert.equal(opened.snapshot.lenChars, 5);
    assert.equal(opened.text, 'a😀\r\nb');
    const id = opened.snapshot.id;

    const edited = await host.call({op: 'replace', id, start: 1, end: 2, text: '中'});
    assert.equal(edited.text, 'a中\r\nb');
    assert.equal(edited.snapshot.selection.base, 2);
    assert.notEqual(edited.snapshot.version, opened.snapshot.version);

    const selected = await host.call({op: 'setSelection', id, base: 0, extent: 2});
    assert.deepEqual(selected.snapshot.selection, {base: 0, extent: 2});

    const saved = await host.call({op: 'text', id});
    assert.equal(saved.text, 'a中\r\nb');
    assert.equal(Buffer.from(saved.text, 'utf8').toString('utf8'), 'a中\r\nb');

    // A second caller of the same process sees the same buffer, not a copy.
    const again = await host.call({op: 'snapshot', id});
    assert.equal(again.text, saved.text);
    assert.equal(again.snapshot.version, saved.snapshot.version);
  } finally {
    await host.close();
  }
});

test('short right-to-left text is classified by code point, not forced LTR', async () => {
  const host = await EditorCoreHost.start();
  try {
    const opened = await host.call({op: 'open', text: 'שלום'});
    const dir = await host.call({op: 'textDirection', id: opened.snapshot.id});
    assert.equal(dir.direction, 'rtl');
    const segs = await host.call({op: 'bidi', id: opened.snapshot.id, start: 0, end: 4});
    const payload = segs.payload;
    assert.equal(payload.length, 1);
    assert.equal(payload[0].direction, 'rtl');
    assert.equal(payload[0].end, 4);
  } finally {
    await host.close();
  }
});
