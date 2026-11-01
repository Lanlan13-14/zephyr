import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {validateTerminalShortcuts}=require('../terminal-shortcut-validator.js');
const {UserSettingsService}=require('../user-settings-service.js');
test('shortcut validator preserves order, labels and triple key combinations without sharing objects',()=>{
 const list=[{id:'cad',label:'Remote login',keys:['Ctrl','Alt','Delete']},{id:'escape',keys:['Escape']}];
 assert.deepEqual(validateTerminalShortcuts(list),list);const clean=validateTerminalShortcuts(list);clean[0].keys.pop();assert.equal(list[0].keys.length,3);
 assert.deepEqual(validateTerminalShortcuts([]),[]);
});
test('rejects over-limit/unknown/ambiguous key chords and duplicate IDs atomically',()=>{
 for(const list of [null,{},Array.from({length:129},(_,i)=>({id:`x${i}`,keys:['A']})),[{id:'x',keys:['Ctrl','Alt','Shift','Delete']}],[{id:'x',keys:['A','B']}],[{id:'x',keys:['Hyper']}],[{id:'x',keys:['Ctrl','Ctrl','C']}],[{id:'__proto__.x',keys:['A']}],[{id:'x',keys:['A'],payload:'oops'}],[{id:'x',keys:['A']},{id:'x',keys:['B']}],[{id:'x',label:'x'.repeat(81),keys:['A']}],[{id:'x',keys:['Ctrl','Alt']}]]) assert.throws(()=>validateTerminalShortcuts(list),TypeError);
});
test('personal shortcut order persists across service reload and remains isolated by account',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zephyr-shortcuts-'));
 const old=process.env.ZEPHYR_DATA_DIR;process.env.ZEPHYR_DATA_DIR=dir;
 delete require.cache[require.resolve('../storage.js')];delete require.cache[require.resolve('../secret-crypto.js')];
 const storage=require('../storage.js');storage.init({hashPassword:p=>`hash:${p}`});
 try{
 const service=new UserSettingsService(storage.rawDb(),storage);
 const list=[{id:'z',keys:['Ctrl','Alt','Delete']},{id:'a',label:'Escape',keys:['Escape']}];
 service.putUserOverrides('alice',{terminal:{shortcuts:list}});
 assert.deepEqual(new UserSettingsService(storage.rawDb(),storage).effective({userId:'alice'}).terminal.shortcuts,list);
 assert.equal(service.getUserOverrides('bob').terminal?.shortcuts,undefined);
 assert.throws(()=>service.putUserOverrides('alice',{terminal:{shortcuts:[{id:'bad',keys:['A','B']}]}}));
 assert.deepEqual(service.getUserOverrides('alice').terminal.shortcuts,list);
 service.putUserOverrides('alice',{terminal:{shortcuts:[]}});assert.deepEqual(service.getUserOverrides('alice').terminal.shortcuts,[]);
 }finally{storage.close();fs.rmSync(dir,{recursive:true,force:true});if(old===undefined)delete process.env.ZEPHYR_DATA_DIR;else process.env.ZEPHYR_DATA_DIR=old;}
});

test('service accepts exactly the canonical encodable chord vocabulary across supported keys',async()=>{
 const {SUPPORTED_SHORTCUT_KEYS,encodeShortcutKeys,normalizeShortcutKeys}=await import('../public/terminal-shortcuts.js');
 const modifiers=['Ctrl','Alt','Shift','Meta'];
 for(const key of SUPPORTED_SHORTCUT_KEYS){
  for(const mods of [[],...modifiers.map(m=>[m]),...modifiers.flatMap((m,i)=>modifiers.slice(i+1).map(n=>[m,n]))]){
   let normalized,valid=true;
   try{normalized=normalizeShortcutKeys([...mods,key]);if(!(normalized.length===1&&modifiers.includes(normalized[0])))encodeShortcutKeys(normalized);}catch{valid=false;}
   if(!normalized||!valid)continue;
   assert.doesNotThrow(()=>validateTerminalShortcuts([{id:'test',keys:normalized}]),normalized.join('+'));
  }
 }
});
