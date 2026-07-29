'use strict';

const CONNECTION_LIST_RE = /(?:列出|显示|查看|有哪些|有什么|现有|全部).{0,10}(?:机器|主机|服务器|连接|设备)|(?:机器|主机|服务器|连接|设备).{0,10}(?:列表|有哪些|有什么|全部)/i;
const CONNECTION_OPEN_RE = /(?:连接|打开|进入|登录到?|连到)\s*(.+?)(?:机器|主机|服务器|连接)?(?:[，,。.!！]|$)/i;
const REMOTE_EXEC_RE = /(?:在|到|连接到?)\s*(.+?)(?:机器|主机|服务器|连接)?(?:上|里|中)\s*(?:执行|运行|跑|敲)\s*(?:命令)?[：:]?\s*([\s\S]+)/i;
const CURRENT_TERMINAL_EXEC_RE = /(?:当前|这个|正在使用的|活跃的).{0,10}(?:SSH|TELNET|终端|shell).{0,14}(?:执行|运行|跑|输入|敲|发送)|(?:在|往).{0,8}(?:当前|这个|活跃的).{0,8}(?:SSH|TELNET|终端|shell).{0,10}(?:执行|运行|输入|发送)/i;
const REMOTE_DESKTOP_RE = /(?:当前|这个|正在使用的|活跃的).{0,12}(?:RDP|VNC|远程桌面)|(?:在|往|操作).{0,8}(?:RDP|VNC|远程桌面)/i;
const REMOTE_DESKTOP_CERT_RE = /(?:证书|certificate|未验证|不受信任|不受信|self[- ]?signed|fingerprint|忽略提示|信任证书|接受证书)/i;
const SFTP_RE = /(?:SFTP|列目录|文件管理|chmod|mkdir|远程目录|ls\s+\/)/i;
const DOCKER_RE = /(?:Docker|容器|镜像|docker\s+ps|docker\s+logs|registry-mirrors|镜像源)/i;

function stripTarget(value = '') {
    return String(value || '').trim().replace(/^(?:这台|当前|那个)\s*/i, '').replace(/\s*(?:机器|主机|服务器|连接)$/i, '').trim();
}

function preferredToolsForUserMessage(message = '') {
    const text = String(message || '').trim();
    if (!text) return [];
    if (DOCKER_RE.test(text)) return [
        { name: 'connection_list_v1', reason: '先匹配 SSH 目标连接' },
        { name: 'docker_status_v1', reason: '确认 Docker 是否可用' },
        { name: 'docker_ps_v1', reason: '列容器；变更再用 docker_container_action_v1 并确认' },
    ];
    if (SFTP_RE.test(text)) return [
        { name: 'connection_list_v1', reason: '先匹配 SSH 目标连接' },
        { name: 'sftp_list_v1', reason: '结构化列目录，不要只打开文件管理器 UI' },
        { name: 'sftp_stat_v1', reason: '需要元数据时 stat；写操作用 sftp_* 或 remote_write_file' },
    ];
    if (REMOTE_DESKTOP_CERT_RE.test(text) || (REMOTE_DESKTOP_RE.test(text) && /证书|certificate|未验证|信任|fingerprint/i.test(text))) return [
        { name: 'remote_desktop_cert_status_v1', reason: '先读取 RDP 证书对话框与 connectionPhase；证书框不在远程画面上' },
        { name: 'remote_desktop_cert_decide_v1', reason: '仅在 certPhase=pending 时 accept/reject；必须确认并展示 fingerprint' },
        { name: 'remote_desktop_capture_v1', reason: '证书接受且连接成功后再截取远程画面' },
    ];
    if (REMOTE_DESKTOP_RE.test(text)) return [
        { name: 'remote_desktop_cert_status_v1', reason: '若卡在证书对话框先处理证书，不要对 HTML 层盲点' },
        { name: 'remote_desktop_capture_v1', reason: '先获取当前 RDP/VNC 客户端渲染帧并让视觉模型观察' },
        { name: 'remote_desktop_action_v1', reason: '只在同一个远程桌面 tabId/captureId 上执行点击、文本或快捷键' },
        { name: 'remote_desktop_verify_v1', reason: '根据操作后新帧和 actionId 验证闭环' },
    ];
    if (CURRENT_TERMINAL_EXEC_RE.test(text)) return [
        { name: 'terminal_read_v1', reason: '直接读取上下文中的当前活跃终端；sessionId 可省略，禁止猜 connectionId' },
        { name: 'terminal_send_v1', reason: '向同一个当前活跃 SSH/TELNET 会话实际发送用户命令' },
        { name: 'terminal_wait_v1', reason: '等待并验证同一终端会话的执行结果' },
    ];
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
        REMOTE_DESKTOP_RE.test(String(message || '')) || REMOTE_DESKTOP_CERT_RE.test(String(message || ''))
            ? '这是执行约束，不是建议。目标表面是 RDP/VNC：禁止调用 browser_* 或把远程桌面里的网页交给内置浏览器。若 certPhase=pending，只能用 remote_desktop_cert_*，禁止 mouse 点证书按钮。已连接后才 capture→action→verify。'
            : '这是执行约束，不是建议。当前终端链路应省略 sessionId 或使用上下文给出的 activeTerminalSessionId，绝对不要枚举、猜 connectionId 或添加 ssh:/telnet: 前缀。除非 Tool 返回 0 个/多个候选或明确错误，否则不要改成教程回答，也不要要求用户提供 ID。',
    ].join('\n');
}

module.exports = { preferredToolsForUserMessage, buildIntentRoutingHint };
