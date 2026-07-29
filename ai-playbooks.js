'use strict';

const { OPERATIONS_PLAYBOOKS } = require('./ai-operations-playbooks');

const PLAYBOOKS = Object.freeze([
    ...OPERATIONS_PLAYBOOKS,
    Object.freeze({
        id: 'capability-discovery-v1',
        title: '能力发现与工具选择',
        capabilityIds: Object.freeze(['capability.search']),
        triggers: Object.freeze(['能做什么', '接口', '工具', '能力', 'help']),
        prompt: `# 能力发现与工具选择 Playbook

- 当用户任务不属于当前已加载的明确操作规程，或你不确定该调用哪个 Zephyr Tool 时，先调用 capability_search。
- 按返回的 capabilityId、toolIds、risk、confirmation、playbookId 选择下一步；不要凭名称猜接口，也不要用 browser_* 去探测 Zephyr 自己的界面。
- 只要 capability_search 返回 humanOnlyReason，就向用户说明该动作必须由本人在安全界面完成；不得尝试寻找秘密读取、密码修改或 MFA 绕过接口。`,
    }),
    Object.freeze({
        id: 'ssh-key-management-v1',
        title: 'SSH 密钥元数据操作',
        capabilityIds: Object.freeze(['sshkey.list', 'sshkey.get', 'sshkey.validate', 'sshkey.rename', 'sshkey.metadata_update', 'sshkey.delete']),
        triggers: Object.freeze(['SSH 密钥', '私钥', '密钥库', 'fingerprint', '指纹']),
        prompt: `# SSH 密钥元数据操作 Playbook

- 查找密钥用 ssh_key_list_v1；查看指纹、算法、是否有口令和 revision 用 ssh_key_get_v1；格式校验用 ssh_key_validate_v1。
- 改名用 ssh_key_rename_v1，改备注用 ssh_key_update_metadata_v1，删除用 ssh_key_delete_v1；写操作都必须先读取 revision 并传 expectedRevision。
- 私钥、口令、导入、生成、查看和替换是 humanOnly。绝不让用户在聊天中粘贴私钥或口令，绝不尝试通过 Tool 读取它们。
- revision_conflict 时重新 ssh_key_get_v1；不要盲目重试。`,
    }),
    Object.freeze({
        id: 'proxy-management-v1',
        title: '代理资产操作',
        capabilityIds: Object.freeze(['proxy.list', 'proxy.get', 'proxy.create', 'proxy.update', 'proxy.delete']),
        triggers: Object.freeze(['代理', 'SOCKS5', 'HTTP 代理', 'proxy']),
        prompt: `# 代理资产操作 Playbook

- 查找代理先 proxy_list_v1；查看、修改或删除先 proxy_get_v1 获得 proxyId 和 revision。
- 创建用 proxy_create_v1；修改用 proxy_update_v1；删除用 proxy_delete_v1。修改/删除必须传刚读取的 expectedRevision。
- AI 标准接口绝不接收或读取代理密码。用户需要保存、修改或查看代理密码时，转到人类专属安全界面，不能要求用户把密码发给模型。
- revision_conflict 时重新 proxy_get_v1，不盲目重试。`,
    }),
    Object.freeze({
        id: 'jump-host-management-v1',
        title: '跳板机资产操作',
        capabilityIds: Object.freeze(['jumphost.list', 'jumphost.get', 'jumphost.create', 'jumphost.update', 'jumphost.delete']),
        triggers: Object.freeze(['跳板机', '堡垒机', 'jump host', 'bastion']),
        prompt: `# 跳板机资产操作 Playbook

- 查找跳板机先 jump_host_list_v1；查看、修改或删除先 jump_host_get_v1 获取 jumpHostId 和 revision。
- 创建用 jump_host_create_v1；它只能引用当前用户可使用的 SSH 连接，不能引用 TELNET/RDP/VNC。
- 修改用 jump_host_update_v1，删除用 jump_host_delete_v1；必须传刚读取的 expectedRevision。
- 跳板机本身不保存密码；引用连接的凭据始终由服务端解析，绝不进入模型上下文。
- revision_conflict 时重新 jump_host_get_v1；不要盲目重试。`,
    }),
    Object.freeze({
        id: 'snippet-management-v1',
        title: '个人代码片段操作',
        capabilityIds: Object.freeze(['snippet.list', 'snippet.get', 'snippet.create', 'snippet.update', 'snippet.delete']),
        triggers: Object.freeze(['代码片段', '命令片段', 'snippet', '常用命令']),
        prompt: `# 个人代码片段操作 Playbook

- 查找片段用 snippet_list_v1；查看、修改或删除先 snippet_get_v1 获取 snippetId 和 revision。
- 创建用 snippet_create_v1；修改用 snippet_update_v1；删除用 snippet_delete_v1。所有写操作需要确认，修改/删除必须传 expectedRevision。
- autoRun=true 仅表示用户在终端选择该片段时默认执行；创建或修改片段本身不会执行命令。
- 片段是当前用户私有设置，不能跨用户读取或修改。
- revision_conflict 时重新 snippet_get_v1；不要盲目重试。`,
    }),
    Object.freeze({
        id: 'secret-ref-binding-v1',
        title: '不透明凭据引用绑定',
        capabilityIds: Object.freeze(['secretref.list', 'secretref.bind_ssh_key']),
        triggers: Object.freeze(['secretRef', '已保存密钥', '绑定 SSH 密钥', '不透露凭据']),
        prompt: `# 不透明凭据引用绑定 Playbook

- 当创建/修改 SSH 连接需要使用已保存密钥时，先 secret_ref_list_v1({kind:'ssh_key', query})；返回的 secretRef 是短期、不透明、用户绑定的引用，不包含私钥或口令。
- 把返回的 secretRef 作为 sshKeySecretRef 传给 connection_create_v1 或 connection_update_v1；服务端验证签名、有效期、用户和 use 权限后只保存资源 ID，模型永远看不到秘密。
- 不得解析、记录、猜测或向用户复述 secretRef 内部内容；过期或权限变化时重新 secret_ref_list_v1。
- secretRef 只能用于允许的目标字段，当前仅支持 SSH 密钥绑定。代理 secretRef 只用于能力发现，不能把代理密码复制进连接字段。
- 创建、修改连接仍需确认和 revision 保护；secretRef 不会绕过确认、ACL 或 humanOnly 的秘密查看边界。`,
    }),
    Object.freeze({
        id: 'agent-device-files-v1',
        title: 'Zephyr Agent 设备文件操作',
        capabilityIds: Object.freeze(['agent.list', 'agent.get', 'agent.files_read', 'agent.files_write']),
        triggers: Object.freeze(['Zephyr Agent', '手机文件', '设备文件', 'Agent 共享目录', '本地设备']),
        prompt: `# Zephyr Agent 设备文件操作 Playbook

- 先 agent_list_v1 找在线设备；再 agent_get_v1 确认 agentId、shareName、platform、appVersion、readOnly 和 capabilities。
- 浏览用 agent_file_list_v1，元数据用 agent_file_stat_v1；读取文本用 agent_file_read_text_v1，单次最多 256 KiB，二进制内容不进入模型上下文。
- 创建目录、重命名、删除分别用 agent_file_mkdir_v1 / agent_file_rename_v1 / agent_file_delete_v1；写操作需要确认，readOnly=true 时不得尝试绕过。
- 路径必须是 Agent 共享根内的规范绝对路径；禁止删除根目录，递归删除前明确范围和影响。
- Agent Token 的生成、查看、重置和撤销属于人类安全配置，不向模型暴露；设备离线时不要把离线误报为文件不存在。`,
    }),
    Object.freeze({
        id: 'remote-desktop-closed-loop-v1',
        title: 'RDP/VNC captureId 闭环操作',
        capabilityIds: Object.freeze([
            'remotedesktop.capture',
            'remotedesktop.action',
            'remotedesktop.verify',
            'remotedesktop.cert_status',
            'remotedesktop.cert_decide',
        ]),
        triggers: Object.freeze(['RDP', 'VNC', '远程桌面', '截图', '点击桌面', 'captureId', '证书', '未验证证书']),
        prompt: `# RDP/VNC captureId 闭环操作 Playbook

- 打开 RDP 后若连接停在证书对话框，先 remote_desktop_cert_status_v1。证书框是 Zephyr HTML 层，不在远程桌面 framebuffer 上；禁止用 remote_desktop_mouse 点「连接」。
- certPhase=pending 时：向用户复述 host/subject/fingerprint/reasons，再 remote_desktop_cert_decide_v1({ decision:'accept'|'reject', remember? })。接受未受信证书属于安全决策，必须等确认。accept 后等待 connectionPhase=connected 再 capture。
- 每次观察先 remote_desktop_capture_v1；客户端渲染器会上传最新 RDP/VNC 帧，Runtime 会把它作为真正图片输入交给视觉模型。不得对 RDP/VNC 使用终端文本 Tool。
- 模型必须先观察图片，再用 remote_desktop_action_v1；必须绑定同一 tabId 的最新 captureId，鼠标坐标基于该截图像素。stale_capture 时只允许重新截图并重试同一动作一次；第二次仍 stale_capture 必须停止并报告，禁止继续循环。
- 动作后重新调用 remote_desktop_capture_v1 取得新视觉帧，再用 actionId、beforeCaptureId、afterCaptureId 调用 remote_desktop_verify_v1；只有 verified=true 才能继续判断业务目标。
- captureId 变化只能证明画面更新，不自动证明业务目标成功；必须观察新图中的成功/错误状态。
- 目标是 RDP/VNC 时禁止调用 browser_*；远程桌面里的浏览器仍属于远程桌面表面。禁止盲点坐标、复用旧图或把操作请求当作完成。任何 clientError、截图不可用或 verify=false 都必须如实报告。`,
    }),
    Object.freeze({
        id: 'browser-automation-v1',
        title: '外部网页 elementRef 自动化',
        capabilityIds: Object.freeze(['browser.inspect', 'browser.click', 'browser.type']),
        triggers: Object.freeze(['网页代操作', '浏览器点击', '填写表单', 'elementRef', 'DOM']),
        prompt: `# 外部网页 elementRef 自动化 Playbook

- 导航后先 browser_inspect_v1；它返回 elementRef 和 domRevision。点击用 browser_click_v1，输入用 browser_type_v1，必须原样传这两个字段。
- 不再让模型拼 CSS selector 或依赖截图坐标点击普通 DOM。页面导航、等待、滚动或重新检查后，旧 elementRef 视为失效。
- stale_dom_revision / stale_element_ref 时重新 browser_inspect_v1，不猜新引用，不盲目重试旧引用。
- 输入、点击都可能提交数据或触发状态变化，按 Tool 风险等待确认；不得在网页表单中输入密码、Token、私钥或其他模型不可见秘密。
- 每次操作后根据返回的预览和页面文本验证结果；必要时 browser_wait 后重新 inspect。`,
    }),
    Object.freeze({
        id: 'terminal-session-ops-v1',
        title: 'SSH/TELNET 实际会话操作',
        capabilityIds: Object.freeze(['terminal.read', 'terminal.send', 'terminal.wait']),
        triggers: Object.freeze(['当前终端', 'SSH 会话', 'TELNET 会话', '发送输入', '等待提示符', '终端输出']),
        prompt: `# SSH/TELNET 实际会话操作 Playbook

- 使用 terminal_read_v1 读取指定 sessionId 的服务端权威输出；它同时支持 SSH 和 TELNET，不依赖终端 iframe 是否当前可见。
- 使用 terminal_send_v1 向活跃会话发送文本；默认追加换行，会实际影响远端，必须等待确认。只填入而不发送的纯 UI 行为仍用 ui_action run:false。
- 发送后用 terminal_wait_v1 等待明确提示符、成功标志或错误文本；超时时根据返回的最新输出判断，不能声称成功。
- TELNET 不支持 remote_execute/SFTP；必须使用 terminal_send_v1 + terminal_wait_v1。SSH 后台非交互命令仍优先 remote_execute；用户明确要求在当前可见 shell 中操作时才用 terminal_send_v1。
- 不猜 sessionId：优先使用当前 Zephyr 上下文里的 activeTerminalSessionId，或省略 sessionId 让 terminal_*_v1 默认选当前活跃会话；也可用 terminalOutputs 中明确列出的真实 sessionId。禁止把 connectionId 当成 sessionId 或自行添加 ssh:/telnet: 前缀。歧义时先 terminal_read_v1 验证目标。`,
    }),
    Object.freeze({
        id: 'asset-management-v1',
        title: '连接资产操作',
        capabilityIds: Object.freeze([
            'connection.list', 'connection.get', 'connection.create', 'connection.update',
            'connection.rename', 'connection.delete', 'connection.test', 'connection.open',
        ]),
        triggers: Object.freeze(['连接', '服务器', '设备', '主机', '改名', '新增', '删除', '测试连通性', '打开连接']),
        prompt: `# 连接资产操作 Playbook

## 工具选择
- 用户说“找/列出/哪个连接”：调用 connection_list_v1；按 name、host、tag、remark 过滤。不要要求用户提供 ID。
- 要查看、改名、修改或删除时：先 connection_get_v1 获取 connectionId 和 revision。
- 新建连接：用 connection_create_v1。它支持 SSH、TELNET、RDP、VNC，但不能接收密码、私钥、API Key 或 Token；要绑定已保存 SSH 密钥时先 secret_ref_list_v1，再传 sshKeySecretRef。
- 修改连接：用 connection_update_v1，必须传刚读取的 expectedRevision；未提供字段保持不变。
- 仅改名：优先 connection_rename_v1，必须传刚读取的 expectedRevision。
- 删除：用 connection_delete_v1，必须传刚读取的 expectedRevision；先明确目标名称、主机和删除影响。
- 测试已保存连接：用 connection_test_v1，不要创建临时连接，也不要要求模型拿到凭据。
- 打开已保存连接：用 connection_open_v1，不要把“打开”误用成 create/update/test。

## 协议规则
- SSH：可以后续使用 SSH 命令和文件 Tool；创建 SSH 必须有用户名。
- TELNET：只能 direct；使用后续 TELNET 会话 Tool，不得伪装成 SSH exec。
- RDP/VNC：打开后先获取远程桌面截图，再按视觉闭环操作；不得用 SSH Tool。

## 验证与恢复
- create/update/rename 后必须依据返回的 connection 和 revision 说明结果。
- revision_conflict 表示其他操作已改过资源；重新 connection_get_v1，再依据新 revision 继续，禁止盲目重试。
- 权限不足或资源不存在时不尝试猜 ID、绕过 ACL 或要求密码。
- 所有 R1/R2/R3 操作会要求用户确认；确认未完成时只说明待确认动作。`,
    }),
]);

function playbooksForCapabilities(capabilityIds = []) {
    const wanted = new Set((Array.isArray(capabilityIds) ? capabilityIds : []).map(String));
    return PLAYBOOKS.filter((playbook) => playbook.capabilityIds.some((id) => wanted.has(id)));
}

module.exports = { PLAYBOOKS, playbooksForCapabilities };
