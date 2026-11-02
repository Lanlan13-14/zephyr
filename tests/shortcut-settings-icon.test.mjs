import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=f=>readFileSync(new URL('../'+f,import.meta.url),'utf8');
test('settings shortcut mask shares terminal and batch keyboard glyph exactly',()=>{
 const css=read('public/zephyr-terminal-spec.css');
 const block=css.match(/\.settings-tab\[data-settings="shortcuts"\]::before\s*\{([^}]+)\}/)[1];
 const svg=decodeURIComponent(block.match(/data:image\/svg\+xml,([^"]+)/)[1]);
 const normalize=s=>s.replace(/<\/?svg\b[^>]*>/g,'').replace(/'/g,'"').replace(/\s+/g,' ').trim();
 const expected=read('public/terminal.html').match(/id="shortcutBtn"[^>]*>(<svg[\s\S]*?<\/svg>)/)[1];
 const batch=read('public/app.html').match(/id="remoteShortcutBtn"[^>]*>(<svg[\s\S]*?<\/svg>)/)[1];
 assert.equal(normalize(svg),normalize(expected));
 assert.equal(normalize(batch),normalize(expected));
 assert.match(svg,/stroke-width='1\.85'/);
});
