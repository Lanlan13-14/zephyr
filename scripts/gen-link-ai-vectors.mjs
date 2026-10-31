import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {pack,KIND}=require('../link-v2-codec');
const vectors=[
  {name:'status',body:{op:'status'}},
  {name:'dispatch',body:{op:'ai.command.dispatch',requestId:'req1',conversationId:'conv1',prompt:'pwd',executionTarget:'remote_host'}},
  {name:'events',body:{op:'ai.stream.event',requestId:'req1',afterSeq:-1}},
  {name:'result',body:{op:'ai.command.result',requestId:'req1'}},
  {name:'cancel',body:{op:'ai.command.cancel',requestId:'req1'}},
  {name:'approval',body:{op:'ai.approval.decision',requestId:'req1',approvalId:'ask1',inputHash:'a'.repeat(64),approve:true,expiresAt:1700000000000,challenge:'a'.repeat(32),proof:Buffer.alloc(64).toString('base64')}},
].map(v=>({...v,kind:KIND.AI,hex:pack({kind:KIND.AI,body:v.body}).toString('hex')}));
const output=path.resolve('docs/zephyr-link/contracts/ai-rpc-host-v1.golden.json');
fs.writeFileSync(output,JSON.stringify({protocol:'ZSL-AI-RPC/1',vectors},null,2)+'\n');
console.log('Generated',vectors.length,'KindAI golden frames');
