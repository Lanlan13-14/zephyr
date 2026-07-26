import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('personal settings response injects unified built-in Skill', () => {
    assert.match(server, /function withRuntimeMeta\(settings\)/);
    assert.match(server, /skills: mergeZephyrDefaultSkills\(result\.ai\.skills \|\| \[\]\)/);
});

test('settings UI renders unified built-in Skill as read-only', () => {
    assert.match(app, /skill\.id === 'zephyr-unified-operator'/);
    assert.match(app, /s\.builtin[\s\S]*?内置只读/);
    assert.match(app, /内置 Skill 不可修改/);
    assert.match(app, /内置 Skill 不可删除/);
});
