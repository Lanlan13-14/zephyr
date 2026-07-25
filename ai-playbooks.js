'use strict';

const PLAYBOOKS = Object.freeze([
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
- 新建连接：用 connection_create_v1。它支持 SSH、TELNET、RDP、VNC，但不能接收密码、私钥、API Key 或 Token；秘密凭据只能走人类专属界面。
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
