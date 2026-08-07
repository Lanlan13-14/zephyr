# Zephyr One 原生逐屏规格与 Zephyr 功能落点

> [KNOWN] 本目录的产品合同要求四入口浮岛、完整移动操作能力、服务器设置、备份恢复和文件同步。
>
> [INFERRED] 本文冻结每项 Zephyr 功能在 One 的页面归属，解决“功能要求存在但导航无落点”的问题。

## 1. 根导航

| 根入口 | 一级内容 | 不放入 |
| --- | --- | --- |
| 首页 | [KNOWN] 连接库、最近连接、搜索/筛选、活动摘要、同步状态 | [KNOWN] 多用户管理、账号安全 |
| 会话 | [KNOWN] SSH/Telnet/RDP/VNC 运行会话、断线/恢复、批量任务状态 | [KNOWN] 设置长表单 |
| 资料 | [KNOWN] SFTP 最近文件、下载、笔记、代码片段 | [KNOWN] SMTP/备案 |
| 工具 | [KNOWN] AI、远程批量、Docker/监控、Proxy、SSH Key、JumpHost、文件同步、服务器、备份恢复、外观、One 设置 | [KNOWN] 独立 Agent 页 |

- [KNOWN] 服务器设置路径固定为 `工具 → 服务器 → 设置`。
- [KNOWN] 备份恢复路径固定为 `工具 → 服务器 → 备份与恢复`。
- [KNOWN] Zephyr Client Token 路径固定为 `工具 → 文件同步 → Client Token`。
- [KNOWN] Root 浮岛只切换四个目的地；二级功能使用 NavigationStack/Navigation Compose，不新增第五项。

## 2. 全局页面状态合同

[INFERRED] 每个列表/详情/编辑页必须实现：

```text
initial-loading
content
empty
offline-with-cache
offline-no-cache
permission-denied
not-found-or-revoked
retryable-error
fatal-incompatible
saving-local
pending-sync
sync-conflict
```

- [KNOWN] local-first 保存先提交本地 DB + pending op；按钮完成态写“已保存，待同步”，不能把网络失败说成保存失败。
- [KNOWN] server-only 操作（登录、Token sensitive action、备份恢复、AI run）必须等服务端确认，不能 optimistic success。
- [KNOWN] capability 不足的 action 隐藏或禁用并显示原因；服务端拒绝后仍显示稳定错误。
- [INFERRED] destructive action 使用原生 dialog/sheet，不使用浏览器 prompt/confirm。
- [INFERRED] 所有错误页包含 requestId 的可复制诊断入口，但默认不显示 secret/host/user/path。

## 3. S01 启动与本地解锁

**入口**：App launch。

**状态**：
- [KNOWN] App Lock 未开启：直接读取本地镜像。
- [KNOWN] 已开启：BiometricPrompt/LocalAuthentication，允许平台设备凭据 fallback。
- [KNOWN] 系统认证不可用：显示设置不可用，不创建 One 专用密码。
- [INFERRED] 锁定时遮住 app switcher snapshot，清除内存中已解密 secret。

**测试**：成功、取消、锁定、系统无生物识别、回前台立即/1/5 分钟策略、屏幕捕获。

## 4. S02 主端与绑定

**流程页**：服务器地址 → capabilities → 账号密码 → TOTP/CAPTCHA → Token 选择 → 设备名/间隔 → bootstrap。

**字段**：
- baseUrl：HTTPS/WSS，显式自签证书 pairing。
- username/password：只在表单生命周期存在。
- TOTP：账号要求时出现。
- Client Token：只列当前账号 metadata；零 Token 显示主端创建引导。
- deviceName：1–120。
- interval：30 秒～24 小时。

**状态**：invalid URL、TLS untrusted、server too old、CAPTCHA system session、account locked、TOTP exhausted、zero Token、wrong-owner Token、bootstrap progress、bootstrap conflict/failure。

**保存**：绑定成功前不显示“已开启”；首次 bootstrap 完成后才进入文件同步已开启。

## 5. S10 首页/连接库

**顶部**：标题、全局搜索、同步状态按钮、账号菜单。

**内容**：最近连接、协议/标签/ownership/收藏筛选、连接卡片、活动摘要。

**卡片字段**：protocol、name、host:port、tags、remark、owner own/shared、capabilities、pending/conflict、最近连接时间。

**操作**：
- `use`：连接。
- `edit`：编辑。
- owner/create：复制。
- `delete`：删除。
- test：临时测试。
- 临时连接：不保存、session 结束或 TTL 后清理。

**空态**：新建连接、扫描 deep link、从主端同步。

## 6. S11 连接编辑器

**Section 顺序**：
1. 基础：name/protocol/host/port/username/domain/encoding。
2. 认证：password、saved SSH key、inline private key/passphrase。
3. 路由：direct/proxy/jump，jump 有序最多 8 级。
4. RDP 通道：sound/clipboard/mic/camera/location/storage。
5. RDP 显示：resolution/quality/fps/touch mode/sensitivity。
6. 文件同步目录意图：off/ask/local share/server bridge。
7. Metadata：tags/remark/share/ACL。
8. 固定操作：测试、保存、不保存直接连接。

**规则**：
- [KNOWN] masked secret 不回填真实值；“保持不变/替换/清除”三态明确。
- [KNOWN] 选中的 dependency 必须有 `use`；被撤销时显示“路由需要修复”。
- [KNOWN] Telnet 清除 SSH key/private key，保留 in-band password 和 proxy/jump。
- [KNOWN] RDP 枚举和默认值按 `ZEPHYR_PARITY.md`。
- [INFERRED] 有未保存修改时返回需确认；配置改变 protocol 时只清除不兼容字段，其他字段保留草稿。

## 7. S20 会话列表

**分组**：连接中、已连接、断线可恢复、已最小化、历史任务。

**行项目**：协议、连接名、状态、延迟/时长、sessionId、本地/主端执行、权限变化。

**操作**：恢复、重连、关闭、详情；批量关闭必须确认。

- [KNOWN] 工作区恢复不自动连接、不自动重放命令。
- [KNOWN] ACL revoked 的 tab 保留说明但不可恢复，reason=`resource_revoked`。

## 8. S21 SSH/Telnet 终端

**布局**：terminal viewport + 快捷键矩阵 + terminal context dock。

**Dock**：键盘、文件、片段、笔记、会话、断开。

**IME**：
- [KNOWN] 打开时隐藏 root 浮岛/context dock；快捷键矩阵贴 IME；viewport resize；PTY rows/cols 同步。
- [KNOWN] CJK composition 期间不滚，commit 后最多一次校正。
- [KNOWN] 用户上滑阅读时远端输出不抢滚动；在底部时保持跟随。
- [KNOWN] 唯一 surface controller 处理 tap/input/composition/enter/output/viewport。

**Telnet 差异**：明文警示；encoding；无 SFTP dock；auto-login 状态。

## 9. S22 RDP

**Surface**：全屏原生渲染；悬浮工具条按触控显示/隐藏。

**工具**：键盘、direct/relative touch、剪贴板、声音、分辨率、文件 drive、证书、重连、断开。

**权限**：会话真正请求麦克风/摄像头/位置/文件时再申请；拒绝单通道不退出会话。

**证书页**：subject、issuer、validity、SHA-256 fingerprint、首次/已变更；变化默认阻断。

**文件 drive**：显示 profile、授权有效性、最终只读值；只读 provider 层执行。

## 10. S23 VNC

**工具**：键盘、指针模式、缩放、剪贴板、画质/颜色、重连、断开。

**错误**：认证失败、unsupported security type、证书/TLS 扩展不可用、pixel format unsupported；禁止未知弱模式自动降级。

## 11. S30 资料首页

**入口卡片**：文件、笔记、代码片段、下载。

**最近文件**只显示用户主动浏览/下载 metadata；路径默认不进 telemetry。

## 12. S31 SFTP 文件管理

**结构**：连接选择 → breadcrumb → 文件列表/网格 → preview/editor。

**操作与 capability**：list/stat/read/download=`fileRead`；upload/new/edit/rename/delete=`fileWrite`。

**状态**：连接断开、权限撤销、目录不存在、编码、下载暂停/继续、mtime conflict、hash mismatch。

**编辑器**：读取时记录 mtime/hash；保存冲突打开 compare/另存/覆盖确认；不静默覆盖。

## 13. S32 笔记

**手机**：列表 → 全屏编辑；平板：group/list/editor 多栏。

**功能**：搜索、group/tag/filter、Markdown 编辑/预览、关联连接、分享、AI read/write、回收站、导入/导出、bulk。

**限制**：标题 200、正文 1 MiB、标签 100、关联 100、bulk 200。

**冲突**：显示 base/local/server，支持三方 merge、保留本机、服务端、复制为新笔记。

## 14. S33 代码片段

**字段**：name 60、command 20000、group 40、autoRun，最多 500。

**操作**：编辑、删除、复制、插入当前终端、执行。

- [KNOWN] 插入不需要 execute；实际执行需要 connection `execute`，危险命令仍经确认策略。
- [INFERRED] 删除进入同步 tombstone；不整包覆盖其他设备新增的 snippet。

## 15. S40 工具首页

**Section**：
- 远程操作：批量执行、Docker、监控、日志。
- 资源：Proxy、SSH Key、JumpHost。
- AI。
- 文件同步。
- 服务器：设置、备份与恢复、运行状态。
- One：外观、语言、本地解锁、网络、诊断。

## 16. S41 批量执行

**字段**：SSH targets、command、timeout 1–300 秒、concurrency 默认 4、fail-fast。

**结果**：逐主机 status/stdout/stderr/exit code/duration/cancel；denied target 独立显示，不因一台失败取消全部，除非 fail-fast。

**安全**：每个 target 要 `execute`；命令审计只保存截断 metadata，不把秘密/stdout 整段塞进核心 sync。

## 17. S42 Docker/监控/日志

**入口**：选择有 `use/observe/control` 能力的 SSH connection。

**页面**：Docker status/containers/images/logs；CPU/memory/disk/network；服务日志 tail/search/export。

**操作映射**：observe 只读；control 可 start/stop/restart；execute 才允许任意命令。

**离线**：显示最后 snapshot 时间，不把旧值说成实时。

## 18. S43 Proxy / SSH Key / JumpHost

- Proxy：name/host/port/type/username/password，默认 SOCKS5:1080。
- SSH Key：name/privateKey/passphrase/remark，secret 三态编辑。
- JumpHost：name + SSH connection dependency。

**共同**：owner/shared/capability、revision conflict、share sheet、依赖引用删除保护。

## 19. S44 AI

**页面**：会话列表、聊天、Provider/模型选择、附件、计划/Memory/Skills/Env、运行权限确认。

**运行**：SSE/stream events；取消 run；permission 请求用原生 confirmation sheet；后台中断后可按 runId 恢复事件。

**安全**：共享 Provider 不展示 API Key；Env 只显示 hasValue；notes read/write 分权；工具继续由主端 capability registry 执行。

**离线**：已同步历史可读、草稿可写；发送按钮显示需要联网。

## 20. S45 文件同步

**主卡**：总开关、automatic 开关、目标间隔、网络策略、立即同步、当前 phase/实体/字节进度、上次尝试/成功、冲突、错误。

**二级**：
- 绑定详情。
- 冲突中心。
- One 设备。
- Client Token。
- 本机共享目录/文件桥接。
- 诊断。

**操作规则**：automatic 关闭仍允许立即同步；解绑前敏感验证；“暂停”不删镜像；“解绑并删本地镜像”先 revoke 后清本机。

## 21. S46 Client Token

**列表**：name/id/created/updated/lastUsed/关联 One/旧 Agent 数；secret 默认隐藏。

**操作**：创建、改名、查看、复制、旋转、删除、重置全部。

**敏感门**：查看/旋转/删除/重置需要当前密码或 TOTP；grant 单次、action+target 绑定。

**影响预览**：旋转/删除前列出会断开的 One/Agent；重置全部要求二次确认但不能替代敏感验证。

## 22. S47 文件桥接与本机共享

**Profile**：displayName、目录授权、readOnly、enabled、autoStart、idle timeout、生命周期。

**Android**：SAF tree；持续在线需前台服务+通知停止 action。

**iOS**：DocumentPicker/security-scoped bookmark；离开 App 后桥接可能暂停，页面明确提示。

**状态**：授权有效/失效、在线、传输字节、打开 handle、最近错误、手动停止。

## 23. S48 服务器设置

**只显示**：当前账号有权限且 One 有用途的 appearance、notes、AI runtime 可用性、版本/能力/运行状态。

**不显示**：账号安全、SMTP、CAPTCHA/IP、防爆破、备案、自定义 CSS/JS、多用户。

**role 状态**：普通用户看到只读公共/effective 设置；admin/super-admin 按服务端授权显示可编辑 section。

## 24. S49 备份与恢复

**导出**：说明范围/加密算法/版本 → 生成 → 系统保存位置 → SHA-256/大小/时间结果。

**导入**：系统文件选择 → 文件 metadata → 当前登录密码 + backup password → 影响确认 → 上传/服务端验证 → 导入/重启 → 所有 One 重新绑定/bootstrap 提示。

**失败**：错误密码、包损坏、缺 DB、key 不匹配、迁移失败、服务重启失败；明确显示“原数据已回滚/未改动”。

## 25. S50 外观与 One 设置

**外观**：auto/light/dark、Frost/Lava/Asagi/Cyber、terminal background/font、RDP 手势默认。

**One**：语言、App Lock、锁定延迟、截图保护、蜂窝策略、下载目录、诊断日志导出、版本/许可证。

**不提供**：One 自建登录密码、账号找回、主端安全策略编辑。

## 26. 无障碍和设备矩阵

- [COMMON] Android 命中区至少 48dp；iOS 至少 44pt。
- [INFERRED] TalkBack/VoiceOver 顺序：页面标题 → 状态 → 主内容 → 主操作 → 浮岛；选中浮岛项报告 selected。
- [INFERRED] 图标按钮必须有 action label；状态不能只靠颜色；进度使用可读百分比/实体计数。
- [INFERRED] 动态字体最大档不截断 destructive action；浮岛极窄时隐藏可见文字但保留 accessibility label。
- [INFERRED] Reduce Motion 取消位移 spring，保留 120ms crossfade。
- [INFERRED] 覆盖中文/英文、RTL 准备、浅/深、四色、横/竖、手机/平板、刘海/手势安全区。

## 27. 页面完成门

[KNOWN] 每屏只有在以下全部满足后可标记 implemented：

1. 原生 UI 与所有状态。
2. ViewModel/Observable state 单向流。
3. Repository 接入真实 Zephyr service/mobile API。
4. 本地镜像与 SecretStore。
5. capability/role gate。
6. structured error。
7. Android unit + Compose UI。
8. iOS unit + XCUITest/SwiftUI inspection。
9. 至少一台目标平台真机。
10. `TRACEABILITY.md` 对应测试证据。
