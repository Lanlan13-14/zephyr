'use strict';

const CONNECTION_LIST_RE = /(?:列出|显示|查看|有哪些|有什么|现有|全部).{0,10}(?:机器|主机|服务器|连接|设备)|(?:机器|主机|服务器|连接|设备).{0,10}(?:列表|有哪些|有什么|全部)/i;
const CONNECTION_OPEN_RE = /(?:连接|打开|进入|登录到?|连到)\s*(.+?)(?:机器|主机|服务器|连接)?(?:[，,。.!！]|$)/i;
const REMOTE_EXEC_RE = /(?:在|到|连接到?)\s*(.+?)(?:机器|主机|服务器|连接)?(?:上|里|中)\s*(?:执行|运行|跑|敲)\s*(?:命令)?[：:]?\s*([\s\S]+)/i;

function stripTarget(value = '') {
    return String(value || '').trim().replace(/^(?:这台|当前|那个)\s*/i, '').replace(/\s*(?:机器|主机|服务器|连接)$/i, '').trim();
}

function preferredToolsForUserMessage(message = '') {
    const text = String(message || '').trim();
    if (!text) return [];
    const exec = text.match(REMOTE_EXEC_RE);
    if (exec) return [
        { name: 'connection_list_v1', reason: `先匹配 SSH 目标：${stripTarget(exec[1]) || '当前目标'}` },
        { name: 'remote_execute', reason: '匹配唯一连接后执行用户给出的命令并检查结果' },
    ];
    if (CONNECTION_LIST_RE.test(text)) return [
        { name: 'connection_list_v1', reason: '用户明确要求列出现有机器或连接，立即读取资产列表' },
    ];
    const open = text.match(CONNECTION_OPEN_RE);
    if (open && stripTarget(open[1])) return [
        { name: 'connection_list_v1', reason: `先匹配连接：${stripTarget(open[1])}` },
        { name: 'connection_open_v1', reason: '唯一匹配后在 Zephyr 页面实际打开连接' },
    ];
    return [];
}

function buildIntentRoutingHint(message = '') {
    const tools = preferredToolsForUserMessage(message);
    if (!tools.length) return '';
    return [
        '【Zephyr 确定性工具路由】',
        ...tools.map((item, index) => `${index + 1}. ${item.name}：${item.reason}`),
        '这是执行约束，不是建议。除非 Tool 返回 0 个/多个候选或明确错误，否则不要改成教程回答，也不要要求用户提供 connectionId。',
    ].join('\n');
}

module.exports = { preferredToolsForUserMessage, buildIntentRoutingHint };
