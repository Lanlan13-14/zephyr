import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const from=app.indexOf('function armRemoteCommandTimeout('),to=app.indexOf('function sendRemoteToolCommand(',from);
test('confirmed snippet commands reuse Ctrl+C timeout and cannot affect a replacement session',()=>{
 const session={id:'a',timeoutTimer:9,timeoutStopFallback:8},sessions=new Map([['a',session]]),timers=[],cleared=[],posted=[],toasts=[];
 const context={remoteExecSessions:sessions,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:id=>cleared.push(id),postRemoteExecMessage:(s,msg)=>posted.push([s,msg]),remoteExecLabel:()=> 'server',toast:s=>toasts.push(s),t:s=>s};
 vm.createContext(context);vm.runInContext(app.slice(from,to),context);
 context.armRemoteCommandTimeout(session,3);
 assert.deepEqual(cleared,[9,8]);assert.equal(timers[0].ms,3000);
 timers[0].fn();assert.equal(posted.length,1);assert.equal(posted[0][1].type,'remote-exec-timeout');assert.equal(timers[1].ms,2000);
 timers[1].fn();assert.equal(toasts.length,1);
 context.armRemoteCommandTimeout(session,3);sessions.set('a',{id:'a'});timers[2].fn();assert.equal(posted.length,1);
 context.armRemoteCommandTimeout(session,null);assert.equal(timers.length,3);assert.equal(session.timeoutTimer,null);
});
test('batch empty state is terminal same single line and shortcut editor is independent',()=>{
 const html=fs.readFileSync(new URL('../public/app.html',import.meta.url),'utf8');
 assert.match(html,/data-settings="shortcuts" data-i18n="快捷键"/);
 assert.match(html,/id="settings-shortcuts">\s*<section id="terminalShortcutSettings"/);
 assert.doesNotMatch(html.slice(html.indexOf('id="settings-appearance"'),html.indexOf('id="settings-beian"')),/terminalShortcutSettings/);
 const placeholder=app.slice(app.indexOf("empty.dataset.remotePlaceholder = ''"),app.indexOf("const tabs = document.getElementById('remoteStageTabs')",app.indexOf("empty.dataset.remotePlaceholder = ''")));
 assert.match(placeholder,/暂无打开的终端窗口/);assert.doesNotMatch(placeholder,/terminal-empty-dot|在左侧勾选/);
});
