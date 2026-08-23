// Node<->Go kind/channel registry parity. The §15 lanes only stay isolated if
// both ends agree on which kind owns which channel. This test reads the Go
// codec source and asserts the Node registry is identical, so a one-sided edit
// fails the build instead of silently splitting the lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const codec = require('../link-v2-codec.js');

function goConstInts(src) {
    // Parse `KindXxx = N` constants from the Go codec registry block.
    const out = {};
    for (const m of src.matchAll(/^\t(Kind[A-Za-z]+)\s*=\s*(\d+)\s*$/gm)) {
        out[m[1]] = Number(m[2]);
    }
    return out;
}

test('Node KIND registry matches the Go codec registry', () => {
    const go = readFileSync(join(root, 'zephyr-link/internal/codec/codec.go'), 'utf8');
    const goKinds = goConstInts(go);
    const expect = {
        KindSyncOp: codec.KIND.SYNC_OP,
        KindSyncAck: codec.KIND.SYNC_ACK,
        KindBlobManifest: codec.KIND.BLOB_MANIFEST,
        KindBlobChunk: codec.KIND.BLOB_CHUNK,
        KindBlobHave: codec.KIND.BLOB_HAVE,
        KindWake: codec.KIND.WAKE,
        KindRelay: codec.KIND.RELAY,
        KindControl: codec.KIND.CONTROL,
        KindSecret: codec.KIND.SECRET,
        KindFileBridge: codec.KIND.FILE_BRIDGE,
        KindSharedTerminal: codec.KIND.SHARED_TERMINAL,
        KindSharedRemote: codec.KIND.SHARED_REMOTE,
        KindSharedNote: codec.KIND.SHARED_NOTE,
        KindSharedFile: codec.KIND.SHARED_FILE,
        KindAI: codec.KIND.AI,
    };
    for (const [name, nodeVal] of Object.entries(expect)) {
        assert.ok(name in goKinds, `Go registry missing ${name}`);
        assert.equal(nodeVal, goKinds[name], `${name}: Node=${nodeVal} Go=${goKinds[name]}`);
    }
    // Same cardinality: no Go kind is left unmapped on the Node side.
    assert.equal(Object.keys(goKinds).length, Object.keys(expect).length,
        'Go has kinds the Node registry does not mirror');
});

test('Node kind→channel mapping matches the Go kindChannel table', () => {
    const go = readFileSync(join(root, 'zephyr-link/internal/codec/codec.go'), 'utf8');
    const goKinds = goConstInts(go);
    // Parse `KindXxx: ChannelYyy,` entries from the Go kindChannel map.
    const goChannel = {};
    const chanName = {};
    for (const m of go.matchAll(/^\t(Channel[A-Za-z]+)\s+Channel\s*=\s*"([^"]+)"\s*$/gm)) {
        chanName[m[1]] = m[2];
    }
    for (const m of go.matchAll(/^\t(Kind[A-Za-z]+):\s*(Channel[A-Za-z]+),$/gm)) {
        goChannel[m[1]] = chanName[m[2]];
    }
    const nodeToGo = {
        SYNC_OP: 'KindSyncOp', SYNC_ACK: 'KindSyncAck', BLOB_MANIFEST: 'KindBlobManifest',
        BLOB_CHUNK: 'KindBlobChunk', BLOB_HAVE: 'KindBlobHave', WAKE: 'KindWake',
        RELAY: 'KindRelay', CONTROL: 'KindControl', SECRET: 'KindSecret',
        FILE_BRIDGE: 'KindFileBridge', SHARED_TERMINAL: 'KindSharedTerminal',
        SHARED_REMOTE: 'KindSharedRemote', SHARED_NOTE: 'KindSharedNote',
        SHARED_FILE: 'KindSharedFile', AI: 'KindAI',
    };
    for (const [nodeName, goName] of Object.entries(nodeToGo)) {
        const nodeChan = codec.channelOf(codec.KIND[nodeName]);
        assert.ok(nodeChan, `Node channelOf missing ${nodeName}`);
        assert.equal(nodeChan, goChannel[goName],
            `${nodeName}: Node channel=${nodeChan} Go channel=${goChannel[goName]}`);
    }
});

test('every Node KIND maps to a channel and pack/unpack still round-trips', () => {
    for (const [name, kind] of Object.entries(codec.KIND)) {
        assert.ok(codec.hasKind(kind), `KIND.${name} has no channel mapping`);
    }
    // New kinds still encode/decode identically to the frozen wire shape.
    for (const kind of [codec.KIND.CONTROL, codec.KIND.SECRET, codec.KIND.AI]) {
        const secret = kind === codec.KIND.SECRET;
        const packed = codec.pack({ kind, body: { probe: 'x'.repeat(400) }, secret });
        const fr = codec.unpack(packed);
        assert.equal(fr.kind, kind);
        assert.equal(fr.secret, secret);
    }
});
