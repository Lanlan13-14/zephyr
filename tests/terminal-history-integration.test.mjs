import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
const root=path.resolve(import.meta.dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const service=fs.readFileSync(path.join(root,'terminal-history-service.js'),'utf8');

test('server creates configured history service',()=>{
 assert.match(server,/require\('\.\/terminal-history-service'\)/);
 assert.match(server,/new TerminalHistoryService\(\{/);
 assert.match(server,/TERMINAL_HISTORY_DIR/);
 assert.match(server,/TERMINAL_HISTORY_MAX_SEGMENTS/);
});
test('Node output is batched and ordered with resize close',()=>{
 assert.match(server,/queueSshSessionHistory\(session, bytes\)/);
 assert.match(server,/flushSshSessionHistory\(attachedSshSession\)/);
 assert.match(server,/terminalHistory\.appendResize/);
 assert.match(server,/flushSshSessionHistory\(session\);\n\s*try \{ terminalHistory\.close/);
});
test('attach replay prefers persisted journal',()=>{
 assert.match(server,/terminalHistory\.replayTail\(session\.userId, session\.id\)\.data/);
});
test('history routes are authenticated and scoped',()=>{
 assert.match(server,/terminal-history\/:sessionId\/lines', requireUser/);
 assert.match(server,/readPage\(req\.user\.userId, req\.params\.sessionId/);
});
test('journal is bounded segmented and hash named',()=>{
 assert.match(service,/MAX_RECORD_DATA_BYTES/);
 assert.match(service,/_base\(userId, sessionId\).*createHash\('sha256'\)/);
 assert.match(service,/maxSegments/);
 assert.match(service,/maxUserBytes/);
 assert.match(service,/cleanupExpired\(now = Date\.now\(\)\)/);
});
