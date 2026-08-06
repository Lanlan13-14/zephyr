const dict = {
  'zh-CN': {
    '使用设备解锁进入应用': '使用设备解锁进入应用',
    '支持系统密码、指纹、面容等': '支持系统密码、指纹、面容等',
    '解锁': '解锁',
    '首页': '首页',
    '连接': '连接',
    '文件同步': '文件同步',
    '设置': '设置',
    '原生客户端': '原生客户端',
    '整合 Zephyr 主端能力与 Agent 文件映射，支持系统级解锁。':
      '整合 Zephyr 主端能力与 Agent 文件映射，支持系统级解锁。',
    '主端连接': '主端连接',
    'Token': 'Token',
    '平台': '平台',
    '通过已配置的 Zephyr 主端访问 SSH / RDP / VNC。':
      '通过已配置的 Zephyr 主端访问 SSH / RDP / VNC。',
    '打开主端': '打开主端',
    '主端地址': '主端地址',
    '保存': '保存',
    '与 Zephyr Agent 相同：填写 HTTPS 地址，不要手动写 wss://。':
      '与 Zephyr Agent 相同：填写 HTTPS 地址，不要手动写 wss://。',
    '整合 Zephyr Agent：本机目录映射为 RDP 虚拟磁盘。初版保留协议与连接，完整双向同步后续版本。':
      '整合 Zephyr Agent：本机目录映射为 RDP 虚拟磁盘。初版保留协议与连接，完整双向同步后续版本。',
    '未连接': '未连接',
    '连接设置': '连接设置',
    '设备名称': '设备名称',
    '共享目录': '共享目录',
    '选择': '选择',
    '权限：': '权限：',
    '只读': '只读',
    '读写': '读写',
    '10 分钟后自动关闭共享': '10 分钟后自动关闭共享',
    '启动连接': '启动连接',
    '停止共享': '停止共享',
    '保存设置': '保存设置',
    '传输统计': '传输统计',
    '请求次数：': '请求次数：',
    '传输量：': '传输量：',
    '文件同步（预留）': '文件同步（预留）',
    '初版不写文件同步逻辑，仅保留入口与配置位置。后续版本将支持 Zephyr ↔ 本机目录的自动同步策略。':
      '初版不写文件同步逻辑，仅保留入口与配置位置。后续版本将支持 Zephyr ↔ 本机目录的自动同步策略。',
    '即将推出': '即将推出',
    '通用': '通用',
    '安全': '安全',
    'Token 备份': 'Token 备份',
    '关于': '关于',
    '外观': '外观',
    '主题色板': '主题色板',
    '语言': '语言',
    '应用解锁': '应用解锁',
    '不再使用 Zephyr 账号密码作为本地门禁。进入应用时调用各端原生能力（系统密码 / 指纹 / 面容）。':
      '不再使用 Zephyr 账号密码作为本地门禁。进入应用时调用各端原生能力（系统密码 / 指纹 / 面容）。',
    '启动时要求解锁': '启动时要求解锁',
    '进入后台后重新锁定': '进入后台后重新锁定',
    '测试解锁': '测试解锁',
    'Token 相互备份': 'Token 相互备份',
    'Zephyr Agent 与 Zephyr One 共用同一套 File Agent Token。可从主端导入、导出到本地，或推送回主端实现相互备份。':
      'Zephyr Agent 与 Zephyr One 共用同一套 File Agent Token。可从主端导入、导出到本地，或推送回主端实现相互备份。',
    '从主端导入': '从主端导入',
    '导出本地备份': '导出本地备份',
    '从备份恢复': '从备份恢复',
    '尚无本地 Token': '尚无本地 Token',
    '导入需要主端登录会话 Cookie；也可粘贴已复制的 Token 明文。':
      '导入需要主端登录会话 Cookie；也可粘贴已复制的 Token 明文。',
    '手动添加 Token': '手动添加 Token',
    '添加': '添加',
    '设置项由原「Zephyr Agent」改名为「文件同步」。初版仅保留位置与 Agent 连接能力，不实现自动文件同步策略。':
      '设置项由原「Zephyr Agent」改名为「文件同步」。初版仅保留位置与 Agent 连接能力，不实现自动文件同步策略。',
    '启用自动文件同步（预留）': '启用自动文件同步（预留）',
    '默认同步目录（预留）': '默认同步目录（预留）',
    '版本：': '版本：',
    '原生多端客户端 · 整合 Zephyr Agent · 与 Zephyr 共享 Token':
      '原生多端客户端 · 整合 Zephyr Agent · 与 Zephyr 共享 Token',
    '未配置': '未配置',
    '无': '无',
    '{n} 个本地 Token': '{n} 个本地 Token',
    '连接信息已保存': '连接信息已保存',
    '请填写主端地址和 Token': '请填写主端地址和 Token',
    '请选择共享目录': '请选择共享目录',
    '共享目录路径': '共享目录路径',
    '未命名 Token': '未命名 Token',
    '使用': '使用',
    '删除': '删除',
    '请粘贴 Token': '请粘贴 Token',
    '已添加': '已添加',
    '已填入 Token': '已填入 Token',
    '已复制 Token 备份 JSON': '已复制 Token 备份 JSON',
    '已下载 Token 备份': '已下载 Token 备份',
    '粘贴 Token 备份 JSON': '粘贴 Token 备份 JSON',
    '已恢复 {n} 个 Token': '已恢复 {n} 个 Token',
    '从主端导入需要已登录会话；请在主端复制 Token 后使用手动添加，或粘贴备份 JSON。':
      '从主端导入需要已登录会话；请在主端复制 Token 后使用手动添加，或粘贴备份 JSON。',
    '已保存主端地址': '已保存主端地址',
    '请先填写主端地址': '请先填写主端地址',
    '解锁 Zephyr One': '解锁 Zephyr One',
    '测试解锁 Zephyr One': '测试解锁 Zephyr One',
    '解锁成功': '解锁成功',
    '解锁失败': '解锁失败',
    '当前平台未提供系统解锁能力': '当前平台未提供系统解锁能力',
    '本机支持生物识别 + 系统密码回退': '本机支持生物识别 + 系统密码回退',
    '本机支持系统密码 / 设备凭证解锁': '本机支持系统密码 / 设备凭证解锁',
    '未检测到系统解锁能力（开发模式可直接进入）':
      '未检测到系统解锁能力（开发模式可直接进入）',
    '开发模式：无原生解锁，点击解锁直接进入':
      '开发模式：无原生解锁，点击解锁直接进入',
    '连接中': '连接中...',
    '认证中': '认证中...',
    '已连接': '已连接',
    '重连中': '重连中...',
    '已停止': '已停止',
    '连接错误': '连接错误',
    '账号绑定与数据同步': '账号绑定与数据同步',
    '需使用 Zephyr 用户名/密码登录；若开启两步验证须输入动态码。主端必须先新增 Client Token，然后才能绑定并开启同步。':
      '需使用 Zephyr 用户名/密码登录；若开启两步验证须输入动态码。主端必须先新增 Client Token，然后才能绑定并开启同步。',
    '绑定状态：': '绑定状态：',
    '用户名': '用户名',
    '密码': '密码',
    '两步验证码': '两步验证码',
    'Client Token（主端已创建）': 'Client Token（主端已创建）',
    '也可在下方粘贴 Token 明文（若下拉为空请先登录）。': '也可在下方粘贴 Token 明文（若下拉为空请先登录）。',
    '登录并绑定': '登录并绑定',
    '解除本地绑定': '解除本地绑定',
    '同步设置': '同步设置',
    '启用自动数据同步': '启用自动数据同步',
    '更新间隔（秒）': '更新间隔（秒）',
    '立即同步': '立即同步',
    '最近快照': '最近快照',
    '账号数据同步': '账号数据同步',
    '在设置 → 文件同步 中登录 Zephyr 账号并绑定设备后，将按间隔同步连接、笔记、密钥元数据等到本机。':
      '在设置 → 文件同步 中登录 Zephyr 账号并绑定设备后，将按间隔同步连接、笔记、密钥元数据等到本机。',
    '打开同步设置': '打开同步设置',
    '从主端刷新列表': '从主端刷新列表',
    '已绑定：{user}': '已绑定：{user}',
    '未绑定': '未绑定',
    '已绑定 {user}，可在设置中管理同步间隔。': '已绑定 {user}，可在设置中管理同步间隔。',
    '尚未绑定 Zephyr 账号': '尚未绑定 Zephyr 账号',
    '从未': '从未',
    '上次错误：': '上次错误：',
    '最近同步：': '最近同步：',
    '尚无快照': '尚无快照',
    '连接 {c} · 笔记 {n} · 代理 {p} · 密钥 {k}': '连接 {c} · 笔记 {n} · 代理 {p} · 密钥 {k}',
    '选择 Token': '选择 Token',
    '主端尚无 Client Token，请先在设置 → Zephyr Client 新增 Token':
      '主端尚无 Client Token，请先在设置 → Zephyr Client 新增 Token',
    '请填写主端地址、用户名和密码': '请填写主端地址、用户名和密码',
    '请输入两步验证码后再次点击登录并绑定': '请输入两步验证码后再次点击登录并绑定',
    '请选择或粘贴主端 Client Token': '请选择或粘贴主端 Client Token',
    '绑定成功': '绑定成功',
    '已解除本地绑定': '已解除本地绑定',
    '请先登录绑定 Zephyr 账号': '请先登录绑定 Zephyr 账号',
    '已刷新主端 Token 列表（{n}）': '已刷新主端 Token 列表（{n}）',
    '请先登录绑定并关联 Client Token': '请先登录绑定并关联 Client Token',
    '同步完成': '同步完成',
    'Zephyr Agent 与 Zephyr One 共用同一套 Client Token。绑定后会自动拉取主端 Token 列表元数据；也可本地导入导出。':
      'Zephyr Agent 与 Zephyr One 共用同一套 Client Token。绑定后会自动拉取主端 Token 列表元数据；也可本地导入导出。',
  },
  'en': {
    '使用设备解锁进入应用': 'Unlock with device credentials',
    '支持系统密码、指纹、面容等': 'System password, fingerprint, Face ID, etc.',
    '解锁': 'Unlock',
    '首页': 'Home',
    '连接': 'Connections',
    '文件同步': 'File Sync',
    '设置': 'Settings',
    '原生客户端': 'Native client',
    '整合 Zephyr 主端能力与 Agent 文件映射，支持系统级解锁。':
      'Native Zephyr client with integrated Agent and system unlock.',
    '主端连接': 'Server',
    'Token': 'Token',
    '平台': 'Platform',
    '通过已配置的 Zephyr 主端访问 SSH / RDP / VNC。':
      'Access SSH / RDP / VNC via your Zephyr server.',
    '打开主端': 'Open server',
    '主端地址': 'Server URL',
    '保存': 'Save',
    '与 Zephyr Agent 相同：填写 HTTPS 地址，不要手动写 wss://。':
      'Same as Zephyr Agent: use HTTPS URL, do not type wss://.',
    '整合 Zephyr Agent：本机目录映射为 RDP 虚拟磁盘。初版保留协议与连接，完整双向同步后续版本。':
      'Integrated Zephyr Agent: map a local folder as RDP drive. v1 keeps protocol/connection; full sync later.',
    '未连接': 'Disconnected',
    '连接设置': 'Connection',
    '设备名称': 'Device name',
    '共享目录': 'Shared folder',
    '选择': 'Browse',
    '权限：': 'Access:',
    '只读': 'Read-only',
    '读写': 'Read/Write',
    '10 分钟后自动关闭共享': 'Auto-stop sharing after 10 minutes',
    '启动连接': 'Start',
    '停止共享': 'Stop',
    '保存设置': 'Save',
    '传输统计': 'Transfer stats',
    '请求次数：': 'Requests: ',
    '传输量：': 'Bytes: ',
    '文件同步（预留）': 'File sync (reserved)',
    '初版不写文件同步逻辑，仅保留入口与配置位置。后续版本将支持 Zephyr ↔ 本机目录的自动同步策略。':
      'v1 reserves the entry only. Automatic sync policies come later.',
    '即将推出': 'Coming soon',
    '通用': 'General',
    '安全': 'Security',
    'Token 备份': 'Token backup',
    '关于': 'About',
    '外观': 'Appearance',
    '主题色板': 'Palette',
    '语言': 'Language',
    '应用解锁': 'App unlock',
    '不再使用 Zephyr 账号密码作为本地门禁。进入应用时调用各端原生能力（系统密码 / 指纹 / 面容）。':
      'No local Zephyr password gate. Uses OS credentials / biometrics.',
    '启动时要求解锁': 'Require unlock on launch',
    '进入后台后重新锁定': 'Lock when backgrounded',
    '测试解锁': 'Test unlock',
    'Token 相互备份': 'Mutual token backup',
    'Zephyr Agent 与 Zephyr One 共用同一套 File Agent Token。可从主端导入、导出到本地，或推送回主端实现相互备份。':
      'Zephyr Agent and Zephyr One share File Agent tokens. Import/export for mutual backup.',
    '从主端导入': 'Import from server',
    '导出本地备份': 'Export local backup',
    '从备份恢复': 'Restore backup',
    '尚无本地 Token': 'No local tokens',
    '导入需要主端登录会话 Cookie；也可粘贴已复制的 Token 明文。':
      'Server import needs a logged-in session; or paste a revealed token.',
    '手动添加 Token': 'Add token manually',
    '添加': 'Add',
    '设置项由原「Zephyr Agent」改名为「文件同步」。初版仅保留位置与 Agent 连接能力，不实现自动文件同步策略。':
      'Settings label renamed from “Zephyr Agent” to “File Sync”. v1 keeps Agent connect only.',
    '启用自动文件同步（预留）': 'Enable auto file sync (reserved)',
    '默认同步目录（预留）': 'Default sync folder (reserved)',
    '版本：': 'Version: ',
    '原生多端客户端 · 整合 Zephyr Agent · 与 Zephyr 共享 Token':
      'Native multi-platform client · Agent integrated · shared tokens',
    '未配置': 'Not set',
    '无': 'None',
    '{n} 个本地 Token': '{n} local token(s)',
    '连接信息已保存': 'Saved',
    '请填写主端地址和 Token': 'Server URL and Token are required',
    '请选择共享目录': 'Pick a shared folder',
    '共享目录路径': 'Shared folder path',
    '未命名 Token': 'Untitled token',
    '使用': 'Use',
    '删除': 'Delete',
    '请粘贴 Token': 'Paste a token',
    '已添加': 'Added',
    '已填入 Token': 'Token filled',
    '已复制 Token 备份 JSON': 'Token backup copied',
    '已下载 Token 备份': 'Token backup downloaded',
    '粘贴 Token 备份 JSON': 'Paste token backup JSON',
    '已恢复 {n} 个 Token': 'Restored {n} token(s)',
    '从主端导入需要已登录会话；请在主端复制 Token 后使用手动添加，或粘贴备份 JSON。':
      'Server import needs a session. Copy token from Zephyr or paste backup JSON.',
    '已保存主端地址': 'Server URL saved',
    '请先填写主端地址': 'Set server URL first',
    '解锁 Zephyr One': 'Unlock Zephyr One',
    '测试解锁 Zephyr One': 'Test unlock Zephyr One',
    '解锁成功': 'Unlocked',
    '解锁失败': 'Unlock failed',
    '当前平台未提供系统解锁能力': 'System unlock unavailable on this platform',
    '本机支持生物识别 + 系统密码回退': 'Biometrics + device credential available',
    '本机支持系统密码 / 设备凭证解锁': 'Device credential unlock available',
    '未检测到系统解锁能力（开发模式可直接进入）':
      'No system unlock detected (dev mode can enter directly)',
    '开发模式：无原生解锁，点击解锁直接进入':
      'Dev mode: no native unlock — tap Unlock to enter',
    '连接中': 'Connecting...',
    '认证中': 'Authenticating...',
    '已连接': 'Online',
    '重连中': 'Reconnecting...',
    '已停止': 'Stopped',
    '连接错误': 'Error',
    '账号绑定与数据同步': 'Account bind & data sync',
    '需使用 Zephyr 用户名/密码登录；若开启两步验证须输入动态码。主端必须先新增 Client Token，然后才能绑定并开启同步。':
      'Sign in with Zephyr username/password (and TOTP if enabled). The server must have a Client Token before binding/sync.',
    '绑定状态：': 'Bind status: ',
    '用户名': 'Username',
    '密码': 'Password',
    '两步验证码': 'TOTP code',
    'Client Token（主端已创建）': 'Client Token (created on server)',
    '也可在下方粘贴 Token 明文（若下拉为空请先登录）。': 'Or paste a token (login first if the list is empty).',
    '登录并绑定': 'Sign in & bind',
    '解除本地绑定': 'Unbind locally',
    '同步设置': 'Sync settings',
    '启用自动数据同步': 'Enable automatic data sync',
    '更新间隔（秒）': 'Interval (seconds)',
    '立即同步': 'Sync now',
    '最近快照': 'Latest snapshot',
    '账号数据同步': 'Account data sync',
    '在设置 → 文件同步 中登录 Zephyr 账号并绑定设备后，将按间隔同步连接、笔记、密钥元数据等到本机。':
      'After binding in Settings → File Sync, connections/notes/keys sync on an interval.',
    '打开同步设置': 'Open sync settings',
    '从主端刷新列表': 'Refresh from server',
    '已绑定：{user}': 'Bound: {user}',
    '未绑定': 'Not bound',
    '已绑定 {user}，可在设置中管理同步间隔。': 'Bound as {user}. Manage interval in Settings.',
    '尚未绑定 Zephyr 账号': 'Zephyr account not bound',
    '从未': 'Never',
    '上次错误：': 'Last error: ',
    '最近同步：': 'Last sync: ',
    '尚无快照': 'No snapshot yet',
    '连接 {c} · 笔记 {n} · 代理 {p} · 密钥 {k}': 'Connections {c} · Notes {n} · Proxies {p} · Keys {k}',
    '选择 Token': 'Select token',
    '主端尚无 Client Token，请先在设置 → Zephyr Client 新增 Token':
      'No Client Token on server — create one in Settings → Zephyr Client first',
    '请填写主端地址、用户名和密码': 'Server URL, username and password are required',
    '请输入两步验证码后再次点击登录并绑定': 'Enter TOTP, then tap Sign in & bind again',
    '请选择或粘贴主端 Client Token': 'Select or paste a Client Token',
    '绑定成功': 'Bound',
    '已解除本地绑定': 'Local bind cleared',
    '请先登录绑定 Zephyr 账号': 'Bind a Zephyr account first',
    '已刷新主端 Token 列表（{n}）': 'Refreshed server token list ({n})',
    '请先登录绑定并关联 Client Token': 'Bind account and link a Client Token first',
    '同步完成': 'Sync complete',
    'Zephyr Agent 与 Zephyr One 共用同一套 Client Token。绑定后会自动拉取主端 Token 列表元数据；也可本地导入导出。':
      'Agent and One share Client Tokens. Binding refreshes token metadata; local import/export still works.',
  },
};

let locale = 'zh-CN';

export function setLocale(next) {
  locale = dict[next] ? next : 'zh-CN';
}

export function getLocale() {
  return locale;
}

export function t(key) {
  const table = dict[locale] || dict['zh-CN'];
  return table[key] ?? dict['zh-CN'][key] ?? key;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  });
}
