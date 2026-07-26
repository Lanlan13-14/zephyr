import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('../scripts/docker-entrypoint-ai.sh',import.meta.url),'utf8');
test('entrypoint migrates legacy same-container Tool Host targets',()=>{
 assert.match(script,/https:\/\/127\.0\.0\.1:3443/);
 assert.match(script,/http:\/\/127\.0\.0\.1:3000/);
 assert.match(script,/http:\/\/127\.0\.0\.1:3080/);
});
test('legacy URL resolves to dedicated loopback listener',()=>{
 const marker='printf "%s" "$ZEPHYR_AI_PLATFORM_HOST_URL"; exit 0';
 const patched=script.replace('exec node server.js',marker);
 const r=spawnSync('/bin/sh',['-c',patched],{env:{...process.env,ZEPHYR_AI_PLATFORM_HOST_URL:'https://127.0.0.1:3443',ZEPHYR_AI_ADMIN_TOKEN:'test-token'},encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.equal(r.stdout.trim().split('\n').at(-1),'http://127.0.0.1:3080');
});
