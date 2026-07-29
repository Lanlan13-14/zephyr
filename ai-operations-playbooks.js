'use strict';
const freeze = (value) => Object.freeze(value);
const pb = (id, title, capabilityIds, triggers, prompt) => freeze({ id, title, capabilityIds: freeze(capabilityIds), triggers: freeze(triggers), prompt });

const OPERATIONS_PLAYBOOKS = freeze([
    pb('ui-operations-v1', 'Zephyr 界面代操作', ['ui.act'], ['切换页面', '终端布局', '页面操作'], `# Zephyr 界面代操作 Playbook
- 仅操作当前 Zephyr UI；安全/数据管理页不得代操作。
- 任何会发送终端输入或影响远端的动作都等待确认。
- 操作后以返回状态或新截图验证，不把“已发消息”当作成功。`),
    pb('web-research-v1', '公开网页检索', ['web.search', 'web.fetch'], ['网页搜索', '查资料', '读取网页'], `# 公开网页检索 Playbook
- 搜索用 web_search；已知 URL 用 fetch_url。
- 引用来源 URL 和抓取内容，不伪造结论。
- 只访问 http/https 公网；内网、回环和元数据地址由服务端拒绝。`),
    pb('notes-management-v1', '个人笔记操作', ['notes.read', 'notes.write', 'notes.delete', 'notes.groups_read', 'notes.groups'], ['笔记', '记录', 'note', '回收站', '分组'], `# 个人笔记操作 Playbook
- 先 note_search/list/get 定位目标；写入 note_create/update；删除 note_delete（进回收站）。
- 分组：note_groups_v1 / note_group_rename_v1 / note_group_delete_v1。
- 回收站：note_restore_v1、note_purge_v1、note_bulk_v1(trash|restore|purge)。
- 笔记功能未启用时停止，不绕过个人设置；写/删/恢复/purge 需确认。`),
    pb('memory-management-v1', 'AI Memory 操作', ['memory.read', 'memory.write'], ['Memory', '记住', '历史约定'], `# AI Memory 操作 Playbook
- 搜索时同时提供项目、连接、标签范围，避免只按关键词误命中。
- 只有稳定、可复用事实才 memory_save；写入需确认。
- 不保存密码、私钥、Token 或网页会话秘密。`),
    pb('environment-variables-v1', 'AI 环境变量操作', ['env.list', 'env.get', 'env.write'], ['环境变量', 'env', '配置值'], `# AI 环境变量操作 Playbook
- list_env_vars 只列名称和说明；get_env_var 会把值带入模型上下文，属于 R4，必须明确确认。
- 创建/更新用 env_set_v1，删除用 env_delete_v1；均需确认。默认 visibleToAi=true。
- 不在回答或日志中复述秘密值；能用 secretRef/专用服务端绑定时不要读取值。`),
    pb('plan-management-v1', '任务计划操作', ['plan.create', 'plan.update', 'plan.delete'], ['计划', '步骤', '暂停', '重试'], `# 任务计划操作 Playbook
- plan_task 只建立计划，不代表步骤已执行。
- plan_update 依据真实 Tool 结果更新状态；失败必须记录证据。
- 删除计划需确认；不能用状态更新伪造完成。`),
    pb('ssh-operations-v1', 'SSH 命令执行', ['ssh.execute'], ['SSH 命令', '远程执行', '服务器排障'], `# SSH 命令执行 Playbook
- 先确认连接是 SSH 且用户有 execute 权限；TELNET 必须走 terminal_*_v1。
- 命令执行需确认；避免交互式和无限运行命令。
- 根据 stdout/stderr/exitCode 回答，不能只凭命令已发送宣称成功。`),
    pb('ssh-file-operations-v1', 'SSH 文件操作与回滚', ['ssh.file_read', 'ssh.file_write', 'ssh.file_rollback', 'ssh.file_snapshots', 'sftp.list', 'sftp.write'], ['远程文件', '修改配置', '回滚', 'SFTP', '目录'], `# SSH 文件操作与回滚 Playbook
- 列目录/元数据：sftp_list_v1 / sftp_stat_v1（需 fileRead）。
- 读文本 remote_read_file；写文本 remote_write_file 会创建快照，可 remote_file_rollback。
- 结构化变更：sftp_mkdir_v1 / sftp_rename_v1 / sftp_delete_v1 / sftp_chmod_v1，均需确认。
- 不要只靠 ui_action 打开文件管理器面板；优先结构化 SFTP 工具。
- 写入/回滚/删除需确认；snapshot 列表不含全文。`),
    pb('docker-operations-v1', 'Docker 运维', ['docker.inspect', 'docker.mutate'], ['Docker', '容器', '镜像', 'docker ps'], `# Docker 运维 Playbook
- 先 docker_status_v1；再 docker_ps_v1 / docker_images_v1 / docker_logs_v1。
- 变更：docker_container_action_v1、docker_pull_v1、docker_mirrors_set_v1 必须确认。
- 根据 exitCode/stdout/stderr 汇报；禁止把“已请求”当作成功。
- 不要只打开终端 Docker 面板；优先结构化 docker_* 工具。`),
    pb('resource-share-v1', '资源共享 ACL', ['resource.share_read', 'resource.share'], ['共享', 'ACL', '权限'], `# 资源共享 ACL Playbook
- 先 resource_share_list_v1 或 resource_shared_with_me_v1。
- 替换共享列表 resource_share_put_v1；删除 resource_share_delete_v1。
- 需要资源 share 能力；写操作必须确认并复述 subjectId/tier。`),
]);
module.exports = { OPERATIONS_PLAYBOOKS };
