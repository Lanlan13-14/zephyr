import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { colorCss, runStyle } from '../public/terminal-remote-history.js';

const root=path.resolve(import.meta.dirname,'..');
const terminal=fs.readFileSync(path.join(root,'public/terminal.js'),'utf8');
const remote=fs.readFileSync(path.join(root,'public/terminal-remote-history.js'),'utf8');
const style=fs.readFileSync(path.join(root,'public/style.css'),'utf8');

test('remote history preserves indexed and RGB colors',()=>{
  assert.equal(colorCss(1,undefined,''),'var(--term-color-1)');
  assert.equal(colorCss(256,0x0c2238,''),'rgb(12,34,56)');
  assert.match(runStyle({fg:1,bg:256,flags:1|8,text:'x'}),/font-weight:bold/);
  assert.match(runStyle({fg:1,bg:256,flags:1|8,text:'x'}),/text-decoration:underline/);
});

test('terminal creates one remote history controller and adopts canonical session id',()=>{
  assert.match(terminal,/createTerminalRemoteHistory\(\{/);
  assert.match(terminal,/terminalHistorySessionId = String\(msg\.sessionId\)/);
  assert.match(terminal,/terminalRemoteHistory\?\.setSession/);
});

test('pagination uses beforeSeq and preserves the scroll anchor',()=>{
  assert.match(remote,/beforeSeq/);
  assert.match(remote,/wrapper\.scrollTop \+= wrapper\.scrollHeight-before/);
  assert.match(remote,/if\(up&&top<=/);
  assert.match(remote,/maxCachedRows=2000/);
});

test('remote history lives outside WTerm managed grid',()=>{
  assert.match(remote,/wrapper\.insertBefore\(el,grid\)/);
  assert.match(style,/\.term-remote-history/);
  assert.match(style,/\.term-remote-history-row/);
});
