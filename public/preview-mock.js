import { t } from './i18n/runtime.js?v=20260728-ai-handle-only-drag1';

const previewEnabled = location.protocol === 'http:' && location.hostname === 'localhost' && location.port === '5173';

const now = Date.now();
const previewConnections = [
    {
        id: 'preview-ssh-prod',
        name: t('生产 Web 节点'),
        host: '10.24.8.12',
        port: 22,
        protocol: 'SSH',
        username: 'deploy',
        remark: '**Nginx + Node.js**\n\n华东区生产环境，只读示例数据。',
        tags: [t('生产'), 'Web'],
        connectionMode: 'direct',
        createdAt: now - 1000 * 60 * 60 * 24 * 45,
        updatedAt: now - 1000 * 60 * 60 * 24 * 2,
        lastConnectedAt: now - 1000 * 60 * 18,
        owner: 'own',
        capabilities: ['view', 'use', 'edit', 'delete'],
    },
    {
        id: 'preview-rdp-office',
        name: t('设计工作站'),
        host: '192.168.10.36',
        port: 3389,
        protocol: 'RDP',
        username: 'designer',
        remark: 'Windows 11 工作站\n\n用于 UI 与浏览器兼容性测试。',
        tags: [t('办公'), 'Windows'],
        connectionMode: 'direct',
        createdAt: now - 1000 * 60 * 60 * 24 * 24,
        updatedAt: now - 1000 * 60 * 60 * 9,
        lastConnectedAt: now - 1000 * 60 * 60 * 3,
        owner: 'own',
        capabilities: ['view', 'use', 'edit', 'delete'],
    },
    {
        id: 'preview-telnet-lab',
        name: t('实验室交换机'),
        host: '172.16.4.8',
        port: 23,
        protocol: 'TELNET',
        username: 'observer',
        remark: t('网络实验设备，共享观察权限。'),
        tags: [t('实验室'), t('网络')],
        connectionMode: 'jump',
        createdAt: now - 1000 * 60 * 60 * 24 * 12,
        updatedAt: now - 1000 * 60 * 60 * 24,
        lastConnectedAt: now - 1000 * 60 * 60 * 26,
        owner: 'shared',
        capabilities: ['view', 'observe'],
    },
];

const previewActivities = [
    { id: 'evt_01JZ7N5F9P', time: now - 1000 * 60 * 18, message: t('连接到生产 Web 节点'), type: 'info', userId: 'preview-user', actor: 'demo', category: t('连接'), outcome: t('成功'), connectionId: 'preview-ssh-prod', protocol: 'SSH', target: '10.24.8.12:22', sourceIp: '192.168.1.28', durationMs: 428 },
    { id: 'evt_01JZ7MBC2K', time: now - 1000 * 60 * 60 * 3, message: t('断开设计工作站'), type: 'info', userId: 'preview-user', actor: 'demo', category: t('连接'), outcome: t('成功'), connectionId: 'preview-rdp-office', protocol: 'RDP', target: '192.168.10.36:3389', sourceIp: '192.168.1.28', durationMs: 96 },
    { id: 'evt_01JZ6QB8RE', time: now - 1000 * 60 * 60 * 26, message: t('查看实验室交换机'), type: 'info', userId: 'preview-user', actor: 'demo', category: t('连接'), outcome: t('成功'), connectionId: 'preview-telnet-lab', protocol: 'TELNET', target: '172.16.4.8:23', sourceIp: '192.168.1.28', durationMs: 214 },
    { id: 'evt_01JYY8N44W', time: now - 1000 * 60 * 60 * 24 * 5, message: t('用户登录：demo'), type: 'info', userId: 'preview-user', actor: 'demo', category: t('账户'), outcome: t('成功'), sourceIp: '192.168.1.28', durationMs: 182 },
    { id: 'evt_01JXPQ2G7A', time: now - 1000 * 60 * 60 * 24 * 16, message: t('测试连接：生产 Web 节点 - 连接超时'), type: 'error', userId: 'preview-user', actor: 'demo', category: t('连接'), outcome: t('失败'), connectionId: 'preview-ssh-prod', protocol: 'SSH', target: '10.24.8.12:22', sourceIp: '192.168.1.28', durationMs: 30000 },
    { id: 'evt_01JW1CV19S', time: now - 1000 * 60 * 60 * 24 * 42, message: t('更新系统设置：appearance'), type: 'info', userId: 'preview-user', actor: 'demo', category: t('系统'), outcome: t('成功'), sourceIp: '192.168.1.28', durationMs: 74 },
];

let previewSshKeys = [
    { id: 'preview-key-prod', name: t('生产环境 Deploy Key'), privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\npreview-production-key\n-----END OPENSSH PRIVATE KEY-----', passphrase: '******', remark: t('华东生产 Web 节点'), createdAt: now - 1000 * 60 * 60 * 24 * 38, updatedAt: now - 1000 * 60 * 60 * 24 * 4 },
    { id: 'preview-key-github', name: 'GitHub CI Key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\npreview-github-ci-key\n-----END OPENSSH PRIVATE KEY-----', passphrase: '', remark: t('Actions 部署专用，只读仓库'), createdAt: now - 1000 * 60 * 60 * 24 * 19, updatedAt: now - 1000 * 60 * 60 * 24 * 2 },
    { id: 'preview-key-lab', name: t('实验室运维密钥'), privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\npreview-lab-key\n-----END OPENSSH PRIVATE KEY-----', passphrase: '******', remark: t('交换机与测试服务器'), createdAt: now - 1000 * 60 * 60 * 24 * 8, updatedAt: now - 1000 * 60 * 60 * 9 },
];

let previewProxies = [
    { id: 'preview-proxy-prod', name: t('生产出口代理'), type: 'socks5', host: '10.24.0.18', port: 1080, username: 'deploy', password: '******', createdAt: now - 1000 * 60 * 60 * 24 * 31, updatedAt: now - 1000 * 60 * 60 * 7 },
    { id: 'preview-proxy-office', name: t('办公网络代理'), type: 'http', host: '192.168.10.15', port: 8080, username: '', password: '', createdAt: now - 1000 * 60 * 60 * 24 * 18, updatedAt: now - 1000 * 60 * 60 * 24 * 2 },
    { id: 'preview-proxy-lab', name: t('实验室链路'), type: 'socks5', host: '172.16.4.20', port: 1081, username: 'observer', password: '******', createdAt: now - 1000 * 60 * 60 * 24 * 9, updatedAt: now - 1000 * 60 * 60 * 15 },
];

function previewProxySummary(proxy) {
    return { ...proxy, password: proxy.password ? '******' : '', hasPassword: !!proxy.password };
}

function previewSshKeySummary(key) {
    return { ...key, privateKey: key.privateKey ? '******' : '', passphrase: key.passphrase ? '******' : '', hasPrivateKey: !!key.privateKey, hasPassphrase: !!key.passphrase };
}

let previewSettings = {
    version: '3.0.0 Preview',
    appearance: {
        brandName: 'Zephyr',
        brandIcon: '🌬️',
        theme: 'light',
        autoThemeEnabled: false,
        colorScheme: 'frost',
    },
    terminal: {
        maxWindows: 3,
        minimizedKeepAlive: 0,
        smartbarOrder: 'old-first',
        shortcutPlatform: 'auto',
        allowLigatures: false,
    },
    workspace: { sessionPersistence: true },
    notes: { enabled: false },
    ai: { enabled: false, providers: [] },
    security: {},
    captcha: {},
    mail: {},
    beian: { show: false },
    snippets: [
        { id: 'preview-snippet-docker', name: t('查看 Docker 状态'), command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"', group: 'Docker', autoRun: true, updatedAt: now - 1000 * 60 * 60 * 5 },
        { id: 'preview-snippet-system', name: t('系统资源概览'), command: 'uptime\nfree -h\ndf -h', group: 'Linux', autoRun: false, updatedAt: now - 1000 * 60 * 60 * 24 },
        { id: 'preview-snippet-logs', name: t('查看服务日志'), command: 'journalctl -u nginx -n 100 --no-pager', group: t('运维'), autoRun: true, updatedAt: now - 1000 * 60 * 60 * 24 * 3 },
    ],
};

function jsonResponse(data, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    }));
}

function requestPath(input) {
    const value = input instanceof Request ? input.url : input;
    return new URL(String(value), location.origin).pathname;
}

function requestMethod(input, init = {}) {
    return String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
}

function requestBody(init = {}) {
    if (typeof init.body !== 'string') return {};
    try { return JSON.parse(init.body); } catch { return {}; }
}

if (previewEnabled && !globalThis.__zephyrPreviewMockInstalled) {
    globalThis.__zephyrPreviewMockInstalled = true;
    globalThis.__zephyrPreviewMode = true;
    const nativeFetch = globalThis.fetch.bind(globalThis);

    globalThis.fetch = (input, init = {}) => {
        const path = requestPath(input);
        const method = requestMethod(input, init);
        const body = requestBody(init);
        if (!path.startsWith('/api/')) return nativeFetch(input, init);

        if (path === '/api/public/settings') return jsonResponse({
            defaultUsername: 'demo',
            appearance: previewSettings.appearance,
            captcha: { enabled: false },
            showBeian: false,
        });
        if (path === '/api/auth/me') return jsonResponse({
            user: { userId: 'preview-user', username: 'demo', role: 'user', isSuperAdmin: false },
            mustChangePassword: false,
            instanceId: 'preview',
        });
        if (path === '/api/auth/login' && method === 'POST') return jsonResponse({ ok: true });
        if (path === '/api/auth/logout' && method === 'POST') return jsonResponse({ ok: true });
        if (path === '/api/connections' && method === 'GET') return jsonResponse({ connections: previewConnections, activities: previewActivities });
        if (path === '/api/activities' && method === 'GET') {
            const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
            const from = Number(url.searchParams.get('from')) || 0;
            const to = Number(url.searchParams.get('to')) || 0;
            return jsonResponse({ activities: previewActivities.filter((activity) => (!from || activity.time >= from) && (!to || activity.time <= to)) });
        }
        if (path === '/api/activities' && method === 'DELETE') return jsonResponse({ ok: true });
        if (path === '/api/me/settings' && method === 'GET') return jsonResponse({ settings: previewSettings, overrides: { mail: { notifyLogin: true } } });
        if (path === '/api/me/settings' && method === 'PUT') {
            previewSettings = {
                ...previewSettings,
                ...body,
                appearance: { ...(previewSettings.appearance || {}), ...(body.appearance || {}) },
                terminal: { ...(previewSettings.terminal || {}), ...(body.terminal || {}) },
                workspace: { ...(previewSettings.workspace || {}), ...(body.workspace || {}) },
            };
            return jsonResponse({ ok: true, settings: previewSettings, overrides: body });
        }
        if (path === '/api/ai/providers') return jsonResponse({ providers: [] });
        if (path === '/api/security/status') return jsonResponse({ user: { username: '', email: '', totpEnabled: false }, passkeys: [] });
        if (path === '/api/security/login-events/mine') return jsonResponse({ events: [] });
        if (path === '/api/proxies' && method === 'GET') return jsonResponse({ proxies: previewProxies.map(previewProxySummary) });
        if (path === '/api/proxies' && method === 'POST') {
            const proxy = { id: `preview-proxy-${Date.now()}`, name: body.name || t('未命名代理'), type: body.type || 'socks5', host: body.host || '', port: Number(body.port) || 1080, username: body.username || '', password: body.password || '', createdAt: Date.now(), updatedAt: Date.now() };
            previewProxies.unshift(proxy);
            return jsonResponse({ proxy: previewProxySummary(proxy) });
        }
        const proxyMatch = path.match(/^\/api\/proxies\/([^/]+)$/);
        if (proxyMatch && method === 'PUT') {
            const index = previewProxies.findIndex((proxy) => proxy.id === proxyMatch[1]);
            if (index < 0) return jsonResponse({ error: t('代理不存在') }, 404);
            const previous = previewProxies[index];
            previewProxies[index] = { ...previous, ...body, port: Number(body.port) || previous.port, password: body.password === '******' ? previous.password : body.password, updatedAt: Date.now() };
            return jsonResponse({ proxy: previewProxySummary(previewProxies[index]) });
        }
        if (proxyMatch && method === 'DELETE') {
            previewProxies = previewProxies.filter((proxy) => proxy.id !== proxyMatch[1]);
            return jsonResponse({ ok: true });
        }
        const proxyOpenMatch = path.match(/^\/api\/proxies\/([^/]+)\/open$/);
        if (proxyOpenMatch && method === 'POST') {
            const proxy = previewProxies.find((item) => item.id === proxyOpenMatch[1]);
            return proxy ? jsonResponse({ proxy: { ...proxy, hasPassword: !!proxy.password } }) : jsonResponse({ error: t('代理不存在') }, 404);
        }
        if (path === '/api/ssh-keys' && method === 'GET') return jsonResponse({ sshKeys: previewSshKeys.map(previewSshKeySummary) });
        if (path === '/api/ssh-keys' && method === 'POST') {
            const sshKey = { id: `preview-key-${Date.now()}`, name: body.name || t('未命名密钥'), privateKey: body.privateKey || '', passphrase: body.passphrase || '', remark: body.remark || '', createdAt: Date.now(), updatedAt: Date.now() };
            previewSshKeys.unshift(sshKey);
            return jsonResponse({ sshKey: previewSshKeySummary(sshKey) });
        }
        const sshKeyMatch = path.match(/^\/api\/ssh-keys\/([^/]+)$/);
        if (sshKeyMatch && method === 'PUT') {
            const index = previewSshKeys.findIndex((key) => key.id === sshKeyMatch[1]);
            if (index < 0) return jsonResponse({ error: t('SSH 密钥不存在') }, 404);
            const previous = previewSshKeys[index];
            previewSshKeys[index] = { ...previous, ...body, privateKey: body.privateKey === '******' ? previous.privateKey : body.privateKey, passphrase: body.passphrase === '******' ? previous.passphrase : body.passphrase, updatedAt: Date.now() };
            return jsonResponse({ sshKey: previewSshKeySummary(previewSshKeys[index]) });
        }
        if (sshKeyMatch && method === 'DELETE') {
            previewSshKeys = previewSshKeys.filter((key) => key.id !== sshKeyMatch[1]);
            return jsonResponse({ ok: true });
        }
        const sshKeyOpenMatch = path.match(/^\/api\/ssh-keys\/([^/]+)\/open$/);
        if (sshKeyOpenMatch && method === 'POST') {
            const sshKey = previewSshKeys.find((key) => key.id === sshKeyOpenMatch[1]);
            return sshKey ? jsonResponse({ sshKey: { ...sshKey, hasPrivateKey: !!sshKey.privateKey, hasPassphrase: !!sshKey.passphrase } }) : jsonResponse({ error: t('SSH 密钥不存在') }, 404);
        }
        if (/^\/api\/me\/workspaces\/[^/]+\/restore$/.test(path) && method === 'POST') return jsonResponse({ workspace: null, inaccessible: 0, autoReplay: false });
        if (/^\/api\/me\/workspaces\/[^/]+$/.test(path) && method === 'DELETE') return jsonResponse({ ok: true });
        if (/^\/api\/me\/workspaces\/[^/]+$/.test(path) && method === 'PUT') return jsonResponse({
            workspace: { workspaceId: path.split('/').pop(), revision: Number(body.revision || 0) + 1, state: body.state || {} },
        });

        console.info('[preview-mock] Unhandled API request', method, path);
        return jsonResponse({ error: `预览模式暂未模拟 ${method} ${path}` }, 404);
    };
}
