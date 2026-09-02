import { t } from './i18n/runtime.js?v=20260902-monitor-docker1';

const exact = new Set([
    '修改登录密码', '通过邮箱重置令牌重置密码', '开启 TOTP 两步验证', '关闭 TOTP 两步验证',
    '更新系统设置', '清理登录事件日志', '绑定 Passkey', '删除 Passkey', '导入数据备份',
    '删除代理', '删除 SSH 密钥', '删除跳板机',
]);

const prefixRules = [
    ['用户登录：', '用户登录：{name}', 'name'],
    ['修改登录用户名：', '修改登录用户名：{name}', 'name'],
    ['新增连接：', '新增连接：{name}', 'name'],
    ['编辑连接：', '编辑连接：{name}', 'name'],
    ['删除连接：', '删除连接：{id}', 'id'],
    ['打开连接：', '打开连接：{name}', 'name'],
    ['临时 RDP 连接授权：', '临时 RDP 连接授权：{target}', 'target'],
    ['更新系统设置：', '更新系统设置：{section}', 'section'],
    ['发送测试邮件：', '发送测试邮件：{target}', 'target'],
    ['Passkey 登录：', 'Passkey 登录：{name}', 'name'],
    ['新增代理：', '新增代理：{name}', 'name'],
    ['编辑代理：', '编辑代理：{name}', 'name'],
    ['新增 SSH 密钥：', '新增 SSH 密钥：{name}', 'name'],
    ['编辑 SSH 密钥：', '编辑 SSH 密钥：{name}', 'name'],
    ['新增跳板机：', '新增跳板机：{name}', 'name'],
    ['编辑跳板机：', '编辑跳板机：{name}', 'name'],
];

const testConnection = /^测试连接：(.+?) - (.*)$/s;
const remoteExecute = /^远程执行：(\d+) 台服务器$/;

export function localizeActivityMessage(message) {
    const raw = String(message || '');
    if (!raw) return raw;
    if (exact.has(raw)) return t(raw);
    for (const [prefix, key, param] of prefixRules) {
        if (raw.startsWith(prefix)) return t(key, { [param]: raw.slice(prefix.length) });
    }
    let match = raw.match(testConnection);
    if (match) return t('测试连接：{name} - {result}', { name: match[1], result: match[2] });
    match = raw.match(remoteExecute);
    if (match) return t('远程执行：{count} 台服务器', { count: match[1] });
    return raw;
}
