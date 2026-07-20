import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import historyModule from '../terminal-history-service.js';
import { TerminalHistoryIndexer } from '../terminal-history-indexer.mjs';
const { TerminalHistoryService } = historyModule;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zephyr-history-index-'));
  const history = new TerminalHistoryService({ root, maxSessionBytes: 64 * 1024 * 1024 });
  return { root, history, indexer: new TerminalHistoryIndexer({ history, root }) };
}

test('indexer emits evicted logical lines with style runs', async () => {
  const { root, history, indexer } = fixture();
  history.open({ userId: 'u', sessionId: 's', cols: 20, rows: 4 });
  let output = '';
  for (let i = 0; i < 1010; i++) output += `\x1b[38;2;12;34;56mline-${String(i).padStart(4, '0')}\x1b[0m\r\n`;
  history.appendOutput('u', 's', Buffer.from(output));
  const result = await indexer.index('u', 's');
  assert.ok(result.lines >= 5, JSON.stringify(result));
  const page = await indexer.readPage('u', 's', { limit: 20 });
  assert.ok(page.lines.length >= 5);
  assert.equal(page.lines[0].runs[0].fgRgb, 0x0c2238);
  assert.match(page.lines[0].runs.map(r => r.text).join(''), /^line-0000/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('index checkpoint resumes without duplicating indexed lines', async () => {
  const { root, history, indexer } = fixture();
  history.open({ userId: 'u', sessionId: 's', cols: 12, rows: 3 });
  let first = ''; for (let i = 0; i < 1005; i++) first += `A${i}\r\n`;
  history.appendOutput('u', 's', first);
  await indexer.index('u', 's');
  const before = await indexer.readPage('u', 's', { limit: 500 });
  history.appendOutput('u', 's', 'AFTER-CHECKPOINT\r\n'.repeat(20));
  const restarted = new TerminalHistoryIndexer({ history: new TerminalHistoryService({ root }), root });
  const result = await restarted.index('u', 's');
  assert.ok(result.indexed > 0);
  const after = await restarted.readPage('u', 's', { limit: 500 });
  const seqs = after.lines.map(line => line.seq);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.ok(after.lines.length >= before.lines.length);
  fs.rmSync(root, { recursive: true, force: true });
});

test('logical history pagination is scoped by user', async () => {
  const { root, history, indexer } = fixture();
  for (const [user, prefix] of [['u1', 'ONE'], ['u2', 'TWO']]) {
    history.open({ userId: user, sessionId: 'same', cols: 10, rows: 2 });
    history.appendOutput(user, 'same', `${prefix}\r\n`.repeat(1005));
    await indexer.index(user, 'same');
  }
  const one = await indexer.readPage('u1', 'same', { limit: 20 });
  const two = await indexer.readPage('u2', 'same', { limit: 20 });
  assert.ok(one.lines.every(line => line.runs.map(r => r.text).join('').includes('ONE')));
  assert.ok(two.lines.every(line => line.runs.map(r => r.text).join('').includes('TWO')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('indexer drains more than one 2000-record batch without gaps', async () => {
  const {root,history}=fixture(); const sid='many'; history.open({userId:'u',sessionId:sid,cols:20,rows:4});
  for(let i=0;i<2505;i++) history.appendOutput('u',sid,Buffer.from(`r-${i}\r\n`));
  const ix=new TerminalHistoryIndexer({history,root,checkpointEvery:10000});
  const result=await ix.index('u',sid);
  assert.equal(result.indexed,2505);
  const state=JSON.parse(fs.readFileSync(ix._paths('u',sid).state,'utf8'));
  assert.equal(state.lastSeq,2505);
  fs.rmSync(root,{recursive:true,force:true});
});

test('indexer replays rotated journal segments in sequence order', async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zephyr-history-rotate-'));
  const history=new TerminalHistoryService({root,maxSessionBytes:1024*1024,maxSegments:4});
  history.open({userId:'u',sessionId:'rot',cols:20,rows:4});
  for(let i=0;i<40;i++) history.appendOutput('u','rot',Buffer.from(`${String(i).padStart(3,'0')}:`+'x'.repeat(32*1024)+'\r\n'));
  assert.ok(fs.existsSync(`${history._journal('u','rot')}.1`));
  const ix=new TerminalHistoryIndexer({history,root,checkpointEvery:10000});
  const result=await ix.index('u','rot');
  assert.ok(result.indexed>0);
  const state=JSON.parse(fs.readFileSync(ix._paths('u','rot').state,'utf8'));
  const records=history.readRecords('u','rot',{after:0,limit:2000});
  assert.equal(state.lastSeq,records.at(-1).seq);
  fs.rmSync(root,{recursive:true,force:true});
});
// sparse pagination test follows
test('sparse pages remain contiguous beyond 256 lines',async()=>{
 const {root,history}=fixture();history.open({userId:'u',sessionId:'pages',cols:20,rows:4});
 let text='';for(let i=0;i<1700;i++)text+=`row-${i}\r\n`;history.appendOutput('u','pages',Buffer.from(text));
 const ix=new TerminalHistoryIndexer({history,root,checkpointEvery:10000});const newest=await ix.readPage('u','pages',{limit:200});
 const older=await ix.readPage('u','pages',{beforeSeq:newest.beforeSeq,limit:200});
 assert.equal(older.lines.at(-1).seq+1,newest.lines[0].seq);assert.ok(fs.existsSync(ix._paths('u','pages').sparse));fs.rmSync(root,{recursive:true,force:true});
});
test('forward page starts after requested sequence',async()=>{
 const {root,history}=fixture();history.open({userId:'u',sessionId:'fwd',cols:20,rows:4});let text='';for(let i=0;i<1300;i++)text+=`f-${i}\r\n`;history.appendOutput('u','fwd',Buffer.from(text));
 const ix=new TerminalHistoryIndexer({history,root});const p=await ix.readPage('u','fwd',{afterSeq:10,limit:25});assert.equal(p.lines[0].seq,11);assert.equal(p.lines.length,25);fs.rmSync(root,{recursive:true,force:true});
});
