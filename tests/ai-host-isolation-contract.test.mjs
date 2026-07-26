import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const bridge=fs.readFileSync(new URL('../ai-runtime-bridge.js',import.meta.url),'utf8');
const docker=fs.readFileSync(new URL('../Dockerfile',import.meta.url),'utf8');
test('platform Tool RPC is mounted only on dedicated loopback app',()=>{
 assert.match(server,/const aiHostApp = express\(\)/);
 assert.match(server,/registerAiHostRoutes\(aiHostApp, aiHostDeps\)/);
 assert.doesNotMatch(server,/registerAiHostRoutes\(app, aiHostDeps\)/);
 assert.match(server,/aiHostServer\.listen\(aiHostListen\.port, aiHostListen\.host/);
 assert.match(server,/req\.url\.startsWith\('\/internal\/'\)/);
 assert.match(bridge,/loopback_only/);
});
test('container points Go runtime at non-published loopback host',()=>{
 assert.match(docker,/ZEPHYR_AI_PLATFORM_HOST_URL=http:\/\/127\.0\.0\.1:3080/);
 assert.doesNotMatch(docker,/EXPOSE\s+3080/);
});
test('runtime fails closed when platform catalog is unavailable',()=>{
 const go=fs.readFileSync(new URL('../zephyr-ai/internal/server/server.go',import.meta.url),'utf8');
 assert.match(go,/platform_tools_unavailable/);
 assert.match(go,/http\.StatusServiceUnavailable/);
});
