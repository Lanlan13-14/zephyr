import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('app.html marks navigation, dashboard, settings tabs with data-i18n', () => {
    const html = read('public/app.html');
    assert.match(html, /data-i18n="仪表盘"/);
    assert.match(html, /data-i18n="设置"/);
    assert.match(html, /data-i18n="活动记录"/);
    assert.match(html, /data-i18n="个性化设置"/);
    assert.match(html, /data-i18n="连接列表 \(0\)"/);
    assert.match(html, /data-i18n-placeholder="搜索名称、IP、备注\.\.\."/);
    assert.doesNotMatch(html, /id="appLocaleBtn"/);
    assert.match(html, /data-settings="language"/);
    assert.match(html, /id="languageSelect"/);
    assert.doesNotMatch(html, /id="appLocaleSelect"/);
    assert.doesNotMatch(html, /id="appearanceLocaleSelect"/);
});

test('app.js imports i18n runtime and bootstraps in init()', () => {
    const js = read('public/app.js');
    assert.match(js, /from '\.\/i18n\/runtime\.js\?v=20260726-telnet-routes1'/);
    assert.match(js, /await initI18n\(\{ applyDom: true \}\);/);
    assert.match(js, /onLocaleChange\(/);
    assert.match(js, /function bindLocaleSelects\(\)/);
    assert.match(js, /function rerenderLocaleSensitiveContent\(\)/);
    assert.match(js, /const before = getLocale\(\);/);
    assert.match(js, /if \(getLocale\(\) === before\) rerenderLocaleSensitiveContent\(\);/);
    assert.match(js, /onLocaleChange\(\(\) => \{[\s\S]*?rerenderLocaleSensitiveContent\(\)/);
    assert.match(js, /renderSecurityLists,/);
    assert.match(js, /t\('暂无封禁 IP'\)/);
    assert.match(js, /t\('暂无登录事件'\)/);
    assert.match(js, /renderAiProviderList,/);
    assert.match(js, /t\('连接列表 \(\{count\}\)', \{ count: connections\.length \}\)/);
    assert.match(js, /t\('个性化设置已保存'\)/);
    assert.match(js, /t\('名称和图标已重置'\)/);
    assert.match(js, /t\('暂无连接，点击右上角添加新连接。'\)/);
    assert.doesNotMatch(js, /#appLocaleBtn/);
    assert.doesNotMatch(js, /openLanguageSettings/);
    assert.doesNotMatch(js, /`连接列表 \(\$\{connections\.length\}\)`/);
});

test('catalogs include batch 2 keys with en translations', () => {
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const required = [
        '主导航', '仪表盘', '活动', '终端', '远程执行', '笔记', '设置', '登出',
        '打开 AI 助理', '切换深浅色', '连接列表 (0)', '连接列表 ({count})',
        '＋ 添加新连接', '搜索名称、IP、备注...', '全部协议', '全部标签',
        '按创建时间', '按名称', '按最近连接', '按协议',
        '活动记录', '查看连接、账户与系统操作的详细记录。', '清理日志',
        '今天', '近 7 天', '近 30 天', '全部', '自定义',
        '开始日期', '至', '结束日期', '应用', '0 条记录', '{count} 条记录',
        '终端工作台', '从仪表盘点击“连接”打开 SSH 会话。',
        '展开/收回移动端 Dock',
        '暂无会话。点击仪表盘中的“连接”打开 SSH 会话。',
        '命令', '例如：uname -a && uptime', '超时（秒）', '批量执行',
        '暂无连接，点击右上角添加新连接。',
        '个性化设置', '界面语言', '界面语言会立即生效，并保存在本机。',
        '安全设置', '备案信息', '代理池', 'SSH 密钥库', '代码片段',
        'AI 助理', '数据管理', '邮件通知', '笔记功能', '多用户管理', '关于',
        '个性化设置已保存', '名称和图标已重置',
    ];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`);
        assert.notEqual(en[key], key, `en still source for ${key}`);
    }
});

test('app.html cache busts include current i18n fix revision', () => {
    const html = read('public/app.html');
    assert.match(html, /app\.js\?v=20260726-telnet-routes1/);
    assert.match(html, /style\.css\?v=20260726-telnet-routes1/);
    assert.match(html, /i18n\/runtime\.js\?v=20260726-telnet-routes1/);
});

test('app.html marks security settings panel with data-i18n', () => {
    const html = read('public/app.html');
    assert.match(html, /data-i18n="修改密码"/);
    assert.match(html, /data-i18n="请输入当前密码"/);
    assert.match(html, /data-i18n="TOTP 两步验证"/);
    assert.match(html, /data-i18n="关闭 TOTP"/);
    assert.match(html, /data-i18n="添加 Passkey"/);
    assert.match(html, /data-i18n="登录邮件通知"/);
    assert.match(html, /data-i18n="我的登录记录"/);
    assert.match(html, /data-i18n="IP 白名单与防爆破"/);
    assert.match(html, /data-i18n-placeholder="每行一个 IP 或 CIDR，例如 192\.168\.1\.0\/24"/);
    assert.match(html, /data-i18n="启用 CAPTCHA"/);
    assert.match(html, /data-i18n="保存 CAPTCHA"/);
});

test('catalogs include security panel keys with en translations', () => {
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const required = [
        '修改密码', '请输入当前密码', '请输入新密码', '请确认新密码', '保存密码',
        '修改个人信息', '请输入新用户名', '请输入新邮箱', '保存资料',
        'TOTP 两步验证', '请输入 6 位验证码', '确认开启', '请输入 TOTP 验证码', '关闭 TOTP',
        '添加 Passkey', '登录邮件通知', '接收登录邮件通知',
        '检测到我的账号登录时发送邮件提醒', '我的登录记录',
        'IP 白名单与防爆破', '启用 IP 白名单',
        '每行一个 IP 或 CIDR，例如 192.168.1.0/24',
        '启用防爆破封禁', '失败次数', '封禁分钟', '保存安全策略',
        '启用 CAPTCHA', '腾讯云验证码', '阿里云验证码 2.0',
        '显示/隐藏 CAPTCHA 密钥', '查看已保存 CAPTCHA 密钥', '保存 CAPTCHA',
    ];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`);
        assert.notEqual(en[key], key, `en still source for ${key}`);
    }
});

test('app.html marks appearance form with data-i18n', () => {
    const html = read('public/app.html');
    assert.match(html, /data-i18n="左上角标题"/);
    assert.match(html, /data-i18n="配色方案"/);
    assert.match(html, /data-i18n="凝霜蓝（默认）"/);
    assert.match(html, /data-i18n="跟随系统"/);
    assert.match(html, /data-i18n="自定义 CSS"/);
    assert.match(html, /data-i18n="SSH 终端自定义"/);
    assert.match(html, /data-i18n="未设置背景"/);
    assert.match(html, /data-i18n="保存外观"/);
    assert.match(html, /data-i18n="终端工作台"/);
    assert.match(html, /data-i18n="单窗"/);
    assert.match(html, /data-i18n="保存终端布局"/);
});

test('catalogs include appearance + terminal layout keys', () => {
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const required = [
        '左上角标题', '左上角图标', '当前图标', '配色方案',
        '凝霜蓝（默认）', '熔岩流 Lava Flow', '浅葱影 Asagi', '极夜青 Cyber Teal',
        '自定义 CSS/JS 与配色', '深浅模式', '跟随系统', '深色', '浅色',
        '大背景', '卡片背景', '主按钮', '按钮 Hover', '文字', '次级文字',
        '边框', '危险色', '成功色', '警告色',
        '自定义 CSS', '自定义 JS', 'SSH 终端自定义',
        '终端背景来源', '不使用自定义背景', '上传图片', '图片 URL', '未设置背景',
        '背景适配', '覆盖', '完整显示', '原始尺寸',
        '背景强度', '模糊强度',
        '启用自定义 SSH 终端字体颜色',
        '深色终端字体颜色', '浅色终端字体颜色',
        '留空自动取反色',
        '启用自定义终端背景色（所有配色模式生效）',
        '深色终端背景色', '浅色终端背景色',
        '启用自定义选中色（选中背景 + 选中文字，所有配色模式生效）',
        '深色 · 选中背景', '深色 · 选中文字',
        '浅色 · 选中背景', '浅色 · 选中文字',
        '留空沿用深色', '保存外观', '切换深色/浅色模式', '重置名称和图标',
        '终端工作台', '终端页面最多显示窗口数',
        '单窗', '双窗', '三窗', '最小化窗口保持连接数',
        '顶部终端栏排序', '从最早到最新', '从最新到最早',
        '文件菜单快捷键提示', '自动识别',
        '允许终端字体连字（仅同样式 run 内）', '保存终端布局',
    ];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`);
        assert.notEqual(en[key], key, `en still source for ${key}`);
    }
});

test('app.html marks small settings panels with data-i18n', () => {
    const html = read('public/app.html');
    assert.match(html, /data-i18n="备案信息设置"/);
    assert.match(html, /data-i18n-placeholder="ICP 备案号，例如：粤ICP备xxxx号"/);
    assert.match(html, /data-i18n="登录页显示备案信息"/);
    assert.match(html, /data-i18n="＋ 新建代理"/);
    assert.match(html, /data-i18n="＋ 新增 SSH 密钥"/);
    assert.match(html, /data-i18n="SSH 代码片段"/);
    assert.match(html, /data-i18n="＋ 新增代码片段"/);
});

test('catalogs include small panel + save toast keys', () => {
    const en = JSON.parse(read('public/i18n/locales/en.json'));
    const required = [
        '备案信息设置', 'ICP 备案号，例如：粤ICP备xxxx号',
        'ICP 备案链接，例如：https://beian.miit.gov.cn',
        '公安备案号，例如：粤公网安备 xxxx号', '公安备案链接',
        '登录页显示备案信息', '保存备案信息',
        '＋ 新建代理', '＋ 新增 SSH 密钥', 'SSH 代码片段', '＋ 新增代码片段',
        '备案信息已保存', '安全策略已保存', 'CAPTCHA 已保存',
        '邮件设置已保存', 'AI 助理设置已保存',
    ];
    for (const key of required) {
        assert.ok(Object.prototype.hasOwnProperty.call(en, key), `en missing ${key}`);
        assert.notEqual(en[key], key, `en still source for ${key}`);
    }
});

test('language settings panel uses toggle-select pattern', () => {
    const html = read('public/app.html');
    assert.match(html, /<div class="settings-panel" id="settings-language">/);
    assert.match(html, /<h2 data-i18n="语言">语言<\/h2>/);
    assert.match(html, /<select id="languageSelect">[\s\S]*?<option value="zh-CN">中文<\/option>[\s\S]*?<option value="en">English<\/option>/);
    assert.match(html, /data-i18n="选择界面显示语言，立即生效并保存到本机。"/);
    const js = read('public/app.js');
    assert.match(js, /'languageSelect'/);
    assert.match(js, /syncToggleSelectFace/);
});

test('app.js routes save toasts through t()', () => {
    const js = read('public/app.js');
    assert.match(js, /toast\(t\('备案信息已保存'\)\)/);
    assert.match(js, /toast\(t\('安全策略已保存'\)\)/);
    assert.match(js, /toast\(t\('CAPTCHA 已保存'\)\)/);
    assert.match(js, /toast\(t\('邮件设置已保存'\)\)/);
    assert.match(js, /toast\(t\('AI 助理设置已保存'\)\)/);
});
