import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appHtml = readFileSync(path.join(root, 'public/app.html'), 'utf8');
const appJs = readFileSync(path.join(root, 'public/app.js'), 'utf8');
const styleCss = readFileSync(path.join(root, 'public/style.css'), 'utf8');

function extractFn(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const m = re.exec(src);
    assert.ok(m, `${name} missing`);
    const brace = src.indexOf('{', m.index);
    let depth = 0;
    for (let j = brace; j < src.length; j++) {
        const c = src[j];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, j + 1);
        }
    }
    throw new Error(`failed to extract ${name}`);
}

function normalizeOpts(block) {
    const open = block.match(/iosAppOpen\([\s\S]*?\{([\s\S]*?)\}\)/);
    const close = block.match(/iosAppClose\([\s\S]*?\{([\s\S]*?)\}\)/);
    assert.ok(open, 'iosAppOpen options missing');
    assert.ok(close, 'iosAppClose options missing');
    const pick = (body) => body
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, '').trim())
        .filter(Boolean)
        .map((l) => l.replace(/,$/, '').replace(/\s+/g, ' '))
        .filter((l) => !/^radiusFrom:/.test(l) && !/^radiusTo:/.test(l) && !/^contentEl:/.test(l))
        .join('\n');
    return { open: pick(open[1]), close: pick(close[1]) };
}

test('admin user modal markup mirrors ssh-key / proxy iosApp structure', () => {
    assert.match(appHtml, /id="adminUserModalScrim"/);
    assert.match(appHtml, /id="adminUserModalInner"[^>]*class="admin-user-modal-inner"/);
    assert.match(appHtml, /id="adminUserForm"[\s\S]*?id="adminUserModalInner"/);
    assert.match(appHtml, /id="adminAddUserBtn"/);
    assert.match(appHtml, /id="adminUserName"/);
    assert.match(appHtml, /id="adminUserPassword"/);
    assert.match(appHtml, /id="adminUserEmail"/);
    assert.match(appHtml, /id="adminUserRole"/);
    assert.match(appHtml, /id="adminUserMustChangePassword"/);
    const formIdx = appHtml.indexOf('id="adminUserForm"');
    const innerIdx = appHtml.indexOf('id="adminUserModalInner"');
    const headIdx = appHtml.indexOf('id="adminUserModalTitle"');
    assert.ok(formIdx > 0 && innerIdx > formIdx && headIdx > innerIdx);
});

test('admin user open/close use iosApp* only — no prompt/confirm dialogs', () => {
    assert.match(appJs, /function openAdminAddUserDialog/);
    assert.match(appJs, /function closeAdminUserModal/);
    assert.match(appJs, /function adminUserScrimSet/);
    assert.match(appJs, /function adminUserBtnRadius/);
    assert.match(appJs, /function saveAdminUser/);
    assert.match(appJs, /armMotionModalOpen\(Motion, modal, card, inner, adminUserModalTrigger, 'adminuser1'\)/);
    assert.match(appJs, /Motion\.iosAppOpen\(card, adminUserModalTrigger/);
    assert.match(appJs, /adminUserScrimSet\(/);
    assert.match(appJs, /mustChangePassword/);

    const openFn = extractFn(appJs, 'openAdminAddUserDialog');
    const closeFn = extractFn(appJs, 'closeAdminUserModal');
    assert.doesNotMatch(openFn, /\bprompt\s*\(/);
    assert.doesNotMatch(openFn, /\bconfirm\s*\(/);
    assert.doesNotMatch(openFn, /connection-home-blur/);
    assert.doesNotMatch(closeFn, /connection-home-blur/);
    assert.doesNotMatch(openFn, /connectionTransitionLayer/);
    assert.doesNotMatch(closeFn, /connectionTransitionLayer/);
    assert.doesNotMatch(openFn, /form\.reset|\$\('#adminUserForm'\)\?\.reset|resetAdminUserForm/);

    const ssh = extractFn(appJs, 'openSshKeyModal') + '\n' + extractFn(appJs, 'closeSshKeyModal');
    const admin = openFn + '\n' + closeFn;
    const a = normalizeOpts(ssh);
    const b = normalizeOpts(admin);
    assert.equal(b.open, a.open);
    assert.equal(b.close, a.close);
});

test('admin user CSS is motion-only card', () => {
    assert.match(styleCss, /#adminUserModalScrim/);
    assert.doesNotMatch(styleCss, /#adminUserModalScrim[^{]*\{[^}]*backdrop-filter/);
    assert.match(styleCss, /#adminUserModal \.admin-user-modal/);
    assert.match(styleCss, /\.admin-user-modal-inner/);
    assert.match(styleCss, /body\.adminuser1-blurring #adminUserModalScrim/);
    assert.match(styleCss, /#adminUserModal \.admin-user-modal[\s\S]*?transition:\s*none\s*!important/);
    assert.match(styleCss, /#adminAddUserBtn,\s*\n#adminAddUserBtn:hover/);
    assert.match(styleCss, /#adminAddUserBtn[\s\S]*?transform:\s*none\s*!important/);
});

test('admin user modal expands full content without internal max-height scroll lock', () => {
    assert.match(styleCss, /#adminUserModal \.admin-user-modal[\s\S]*?max-height:\s*none\s*!important/);
    assert.match(styleCss, /#adminUserModal \.admin-user-modal[\s\S]*?overflow:\s*visible\s*!important/);
    assert.match(styleCss, /#adminUserModal\.adminuser1[\s\S]*?overflow-y:\s*auto/);
    const openFn = extractFn(appJs, 'openAdminAddUserDialog');
    assert.match(openFn, /card\.style\.overflow = 'visible'/);
    assert.match(openFn, /card\.style\.maxHeight = 'none'/);
    // 添加用户按钮不进 Motion.press 名单（与代理一致，避免源按钮 scale 与 iosAppOpen 抢帧）
    assert.doesNotMatch(appJs, /for \(const id of \[[^\]]*'adminAddUserBtn'/);
    assert.match(appJs, /for \(const id of \['addSshKeyBtn', 'addSnippetBtn'\]\)/);
});

test('admin user finish path keeps atomic twin handoff', () => {
    const closeFn = extractFn(appJs, 'closeAdminUserModal');
    assert.match(closeFn, /clearSourceVisual:\s*false/);
    assert.match(closeFn, /restoreSource:\s*false/);
    assert.match(closeFn, /hideSurface:\s*false/);
    assert.match(closeFn, /release:\s*false/);
    assert.match(closeFn, /Motion\.restoreSource\(trigger\)/);
    assert.match(closeFn, /data-motion-source-visual[\s\S]*?remove\(\)/);
    assert.match(closeFn, /requestAnimationFrame\(\(\) => finish\(\)\)/);
});

test('admin user modal binds scrim / backdrop / Escape close and form submit', () => {
    assert.match(appJs, /\$\('#adminAddUserBtn'\)\?\.addEventListener\('click',\s*\(e\) => openAdminAddUserDialog\(e\.currentTarget\)\)/);
    assert.match(appJs, /\$\('#adminUserForm'\)\?\.addEventListener\('submit'/);
    assert.match(appJs, /\$\('#adminUserCloseBtn'\)\?\.addEventListener\('click',\s*closeAdminUserModal\)/);
    assert.match(appJs, /\$\('#adminUserCancelBtn'\)\?\.addEventListener\('click',\s*closeAdminUserModal\)/);
    assert.match(appJs, /if \(e\.target\.id === 'adminUserModal'\) closeAdminUserModal\(\)/);
    assert.match(appJs, /\$\('#adminUserModalScrim'\)\?\.addEventListener\('click'/);
    assert.match(appJs, /e\.key === 'Escape' && \$\('#adminUserModal'\)\?\.classList\.contains\('show'\)/);
    assert.match(appJs, /closeAdminUserModal\(\)/);
    assert.match(appJs, /\/api\/admin\/users[\s\S]*?mustChangePassword/);
});

test('admin user role select joins protocolFilter motion morph menu path', () => {
    // Same toggle-select shell as dashboard filters + Motion.morph(mac)/macClose.
    assert.match(appJs, /const TOGGLE_SELECT_IDS = \[[\s\S]*?'adminUserRole'/);
    assert.match(appJs, /const MOTION_FILTER_SELECT_IDS = \[[\s\S]*?'adminUserRole'/);
    assert.match(appJs, /enhanceToggleSelect\(\$\('#adminUserRole'\)\)/);
    assert.match(appJs, /syncToggleSelectFace\(\$\('#adminUserRole'\)\)/);
    assert.match(appJs, /Motion\.morph\(menu, from, \{[\s\S]*?preset:\s*'mac'/);
    assert.match(appJs, /Motion\.to\(menu, \{ opacity: 0, scale: 0\.94, y: -8, x: 0, blur: 0 \}, \{ preset: 'macClose' \}\)/);
});

test('admin user list hides soft-deleted cards after delete', () => {
    const renderFn = extractFn(appJs, 'renderAdminUsers');
    assert.match(renderFn, /status !== 'deleted'/);
    assert.match(renderFn, /const visible = \(Array\.isArray\(users\) \? users : \[\]\)\.filter/);
    assert.match(renderFn, /visible\.map\(/);
    assert.match(appJs, /data-admin-action="delete"/);
    assert.match(appJs, /method:\s*'DELETE'[\s\S]*?resourcePolicy:\s*'transfer-to-admin'/);
    assert.match(appJs, /await loadAdminUsers\(\)/);
});
