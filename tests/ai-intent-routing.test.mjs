import test from'node:test';
import assert from'node:assert/strict';
import{createRequire}from'node:module';
const require=createRequire(import.meta.url);
const{preferredToolsForUserMessage,buildIntentRoutingHint}=require('../ai-intent-routing');
test('machine list intent routes directly to connection_list_v1',()=>{
 assert.deepEqual(preferredToolsForUserMessage('列出现有机器列表').map(x=>x.name),['connection_list_v1']);
});
test('open machine intent uses list then open',()=>{
 assert.deepEqual(preferredToolsForUserMessage('连接生产服务器').map(x=>x.name),['connection_list_v1','connection_open_v1']);
});
test('remote command intent uses list then remote_execute',()=>{
 const tools=preferredToolsForUserMessage('在生产服务器上执行命令 uname -a');
 assert.deepEqual(tools.map(x=>x.name),['connection_list_v1','remote_execute']);
 assert.match(buildIntentRoutingHint('在生产服务器上执行命令 uname -a'),/执行约束，不是建议/);
});
test('generic chat does not force a tool route',()=>{
 assert.deepEqual(preferredToolsForUserMessage('你好，解释一下 SSH 是什么'),[]);
});
