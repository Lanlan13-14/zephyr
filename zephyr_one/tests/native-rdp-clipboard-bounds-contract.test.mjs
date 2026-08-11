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

  assert.match(patch, /FREERDP_ZEPHYR_CLIPRDR_MAX_PAYLOAD_BYTES \(4U \* 1024U \* 1024U\)/);
  assert.match(patch, /totalLength > FREERDP_ZEPHYR_CLIPRDR_MAX_MESSAGE_BYTES/);
  assert.match(patch, /dataLength > totalLength - position/);
  assert.ok(
    patch.indexOf('totalLength > FREERDP_ZEPHYR_CLIPRDR_MAX_MESSAGE_BYTES')
      < patch.indexOf('if (dataFlags & CHANNEL_FLAG_FIRST)'),
    'totalLength check must precede Stream_New/EnsureCapacity',
  );

  assert.match(build, /TAG="3\.30\.0"/);
  assert.match(build, /COMMIT="6b107f0aadbabc47941c5a5b893b88c01792af6d"/);
  assert.match(build, /ADDIN_UPSTREAM_SHA256=/);
  assert.match(build, /CHANNELS_UPSTREAM_SHA256=/);
  assert.match(build, /git -C "\$SRC" apply --check "\$PATCH_FILE"/);
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
