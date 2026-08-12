import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('pinned FreeRDP rejects cliprdr totalLength before generic reassembly allocates', () => {
  const patch = read('native/freerdp-core/patches/freerdp-3.30.0-cliprdr-reassembly-limit.patch');
  const build = read('native/freerdp-core/scripts/build-freerdp.sh');
  const attributes = read('../.gitattributes');

  assert.match(attributes, /^\*\.sh text eol=lf$/m);
  assert.doesNotMatch(build.replaceAll('\r\n', '\n'), /\r/, 'shell scripts must not contain stray CR bytes');

  assert.match(patch, /FREERDP_ZEPHYR_CLIPRDR_MAX_PAYLOAD_BYTES \(4U \* 1024U \* 1024U\)/);
  assert.match(patch, /totalLength > FREERDP_ZEPHYR_CLIPRDR_MAX_MESSAGE_BYTES/);
  assert.match(patch, /dataLength > totalLength - position/);
  const additions = patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
  const totalLengthCheck = additions.indexOf(
    'totalLength > FREERDP_ZEPHYR_CLIPRDR_MAX_MESSAGE_BYTES',
  );
  const firstFragment = additions.indexOf('+\tif (dataFlags & CHANNEL_FLAG_FIRST)');
  const ensureCapacity = additions.indexOf('+\tif (!Stream_EnsureRemainingCapacity');
  assert.ok(totalLengthCheck >= 0, 'totalLength limit must be an added patch line');
  assert.ok(firstFragment >= 0, 'first-fragment branch must be an added patch line');
  assert.ok(ensureCapacity >= 0, 'capacity check must be an added patch line');
  assert.ok(
    totalLengthCheck < firstFragment && totalLengthCheck < ensureCapacity,
    'added totalLength check must precede the added first-fragment branch and EnsureCapacity',
  );

  assert.match(build, /TAG="3\.30\.0"/);
  assert.match(build, /COMMIT="6b107f0aadbabc47941c5a5b893b88c01792af6d"/);
  for (const state of ['UPSTREAM', 'PATCHED']) {
    for (const lineEnding of ['LF', 'CRLF']) {
      assert.match(build, new RegExp(`ADDIN_${state}_${lineEnding}_SHA256="[a-f0-9]{64}"`));
      assert.match(build, new RegExp(`CHANNELS_${state}_${lineEnding}_SHA256="[a-f0-9]{64}"`));
    }
  }

  assert.match(
    build,
    /matches_hash_pair\(\) \{\s*\[ "\$addin_hash" = "\$1" \] && \[ "\$channels_hash" = "\$2" \]\s*\}/,
  );
  const hashPairCalls = [...build.matchAll(
    /matches_hash_pair "\$(ADDIN|CHANNELS)_(UPSTREAM|PATCHED)_(LF|CRLF)_SHA256" "\$(ADDIN|CHANNELS)_(UPSTREAM|PATCHED)_(LF|CRLF)_SHA256"/g,
  )];
  assert.equal(hashPairCalls.length, 6, 'every audited state must be checked as a complete pair');
  for (const [, firstFile, firstState, firstEnding, secondFile, secondState, secondEnding] of hashPairCalls) {
    assert.equal(firstFile, 'ADDIN');
    assert.equal(secondFile, 'CHANNELS');
    assert.equal(firstState, secondState);
    assert.equal(firstEnding, secondEnding);
  }
  assert.doesNotMatch(
    build,
    /\[ "\$addin_hash" = "\$ADDIN_(?:UPSTREAM|PATCHED)_(?:LF|CRLF)_SHA256" \][\s\S]{0,200}\|\|[\s\S]{0,200}\[ "\$channels_hash" = "\$CHANNELS_(?:UPSTREAM|PATCHED)_(?:LF|CRLF)_SHA256" \]/,
    'addin.c and channels.h hashes must never be independently ORed together',
  );
  assert.match(
    build,
    /git -C "\$SRC" apply --check --unidiff-zero --whitespace=error-all "\$PATCH_FILE"/,
  );
  assert.match(
    build,
    /git -C "\$SRC" apply --unidiff-zero --whitespace=error-all "\$PATCH_FILE"/,
  );
  assert.match(build, /FREERDP_ZEPHYR_CLIPRDR_REASSEMBLY_LIMIT 1/);
});

test('shim and Rust retain independent bounded malformed-payload checks', () => {
  const c = read('native/freerdp-core/zephyr_rdp.c');
  const header = read('native/freerdp-core/zephyr_rdp.h');
  const rust = read('src-tauri/src/rdp/session.rs');

  assert.match(header, /ZEPHYR_RDP_MAX_CLIPBOARD_UTF16_BYTES \(4u \* 1024u \* 1024u\)/);
  assert.match(c, /bytes % sizeof\(uint16_t\)/);
  assert.match(c, /read_utf16le_unit\(data \+ bytes - sizeof\(uint16_t\)\) != 0/);
  assert.match(c, /ZEPHYR_RDP_EV_CLIPBOARD, \(int32_t\)bytes/);
  assert.doesNotMatch(c, /on_server_format_data_response[\s\S]{0,900}malloc/);
  assert.match(rust, /bytes_len > MAX_CLIPBOARD_UTF16_BYTES/);
  assert.match(rust, /utf8_len\.checked_add/);
  assert.match(rust, /String::with_capacity\(utf8_len\)/);
});
