import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const vnc = fs.readFileSync(path.join(root, 'public/novnc.js'), 'utf8');
const rdp = fs.readFileSync(path.join(root, 'public/rdp-wasm-client.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/locales/zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'public/i18n/locales/en.json'), 'utf8'));

const required = [
  '历史预算策略',
  '按模型上下文窗口、系统提示、工具目录、输出预留和安全余量动态计算，不再按固定消息数截断。',
  '远程桌面画面已变化，请重新截图后再点击',
  '已实时截取最新远程桌面画面并签发 captureId',
  '请求前端实时截取并签发新 captureId',
  '读取 {count} 个远程桌面画面，captureId={captureId}',
  '远程桌面操作失败：{error}',
  '远程桌面动作闭环已验证',
  '发现 {count} 个可操作元素（DOM v{revision}）：{elements}',
  'AI 正在页面代操作：{target}',
  'VNC 画面已变化，请重新截图后再操作',
  'RDP Worker 尚未就绪',
  'RDP 截图像素无效',
  '未知 RDP 快捷键：{sequence}',
  '未知 RDP AI 动作：{control}',
  '确认执行工具：{tool}',
  '需要确认敏感操作：{summary}',
];

test('new AI user-facing strings exist in both locale catalogs', () => {
  for (const key of required) {
    assert.equal(zh[key], key, `missing zh key: ${key}`);
    assert.equal(typeof en[key], 'string', `missing en key: ${key}`);
    assert.ok(en[key].trim(), `empty en translation: ${key}`);
  }
});

test('new AI UI paths call t() instead of hardcoding Chinese', () => {
  assert.match(app, /t\('请求前端实时截取并签发新 captureId'\)/);
  assert.match(app, /t\('远程桌面操作失败：\{error\}'/);
  assert.match(app, /t\('发现 \{count\} 个可操作元素（DOM v\{revision\}）：\{elements\}'/);
  assert.match(app, /localizedAiConfirmationSummary/);
  assert.match(vnc, /t\('VNC 画面已变化，请重新截图后再操作'\)/);
  assert.match(rdp, /t\('RDP Worker 尚未就绪'\)/);
  assert.match(rdp, /t\('未知 RDP AI 动作：\{control\}'/);
  assert.match(service, /summaryKey: '确认执行工具：\{tool\}'/);
  assert.match(app, /localizedAiConfirmationSummary/);
  assert.doesNotMatch(app, /confirmation\?\.summary \|\| ''/);
});

test('confirmation payload exposes locale-neutral summary key and params', () => {
  const server = fs.readFileSync(path.join(root, 'ai-agent-service.js'), 'utf8');
  assert.match(server, /summaryKey: '确认执行工具：\{tool\}'/);
  assert.match(server, /summaryParams: \{ tool: toolName \}/);
});
