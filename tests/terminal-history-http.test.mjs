import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import historyModule from '../terminal-history-service.js';
import { TestServer } from './test-server.mjs';
const { TerminalHistoryService }=historyModule;
let server,cookie,userId;
before(async()=>{server=new TestServer();await server.start();const boot=await server.bootstrapAdmin('history-api-pass-1');cookie=boot.cookie;const me=await server.api(cookie,'GET','/api/auth/me');userId=me.body.user.userId;});
after(async()=>{await server.cleanup();});

test('logical history endpoint is authenticated and returns styled lines',async()=>{
  const history=new TerminalHistoryService({root:path.join(server.dir,'terminal-history')});
  const sessionId='history-http-session';history.open({userId,sessionId,cols:20,rows:4});
  let output='\x1b[38;2;9;8;7m';for(let i=0;i<1010;i++)output+=`http-${i}\r\n`;
  history.appendOutput(userId,sessionId,Buffer.from(output));
  const unauth=await server.api('', 'GET', `/api/terminal-history/${sessionId}/lines?limit=20`);
  assert.equal(unauth.status,401);
  const page=await server.api(cookie,'GET',`/api/terminal-history/${sessionId}/lines?limit=20`);
  assert.equal(page.status,200,JSON.stringify(page.body));
  assert.ok(page.body.lines.length>0);
  assert.equal(page.body.lines[0].runs[0].fgRgb,0x090807);
  const older=await server.api(cookie,'GET',`/api/terminal-history/${sessionId}/lines?limit=2&beforeSeq=${page.body.lines.at(-1).seq}`);
  assert.equal(older.status,200);
});
