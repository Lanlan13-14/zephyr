# Zephyr-SSH AI 全能力改造：实施进度

> 2026-07-25 · 基于 `5c9835e` 基线

## 目标

AI 必须覆盖项目所有非人类专属操作；人类专属操作显式标记 `humanOnly` 并写明原因。  
同时满足三条硬约束：接口完整、接口标准、AI 通过 Playbook + capability_search 真能用。

完整设计见 [`../zephyr-ai-complete-capability-plan.md`](../zephyr-ai-complete-capability-plan.md)。

---

## 能力覆盖一览

| 领域 | 状态 | 已实现 canonical Tool | 风险 |
|---|---|---|---|
| capability-search | ✅ | capability_search | R0 |
| connection | ✅ 全部 | connection_list/get/create/update/rename/delete/test/open_v1 | R0‑R3 |
| proxy | ✅ 全部 | proxy_list/get/create/update/delete_v1 | R0‑R3 |
| ssh-key meta | ✅ 部分 | ssh_key_list/get/validate/rename/update-metadata/delete_v1 | R0‑R1,R3 |
| ssh-key secret | ⛔ R4 | import/generate/reveal → humanOnly | R4 |
| jump-host | ⬜ | 待迁移 | R0‑R3 |
| snippet | ⬜ | 待迁移 | R0‑R3 |
| telnet-ops | ⬜ | 标准 read/send/wait 待落地 | R0‑R2 |
| rdp-vnc-ops | ⬜ | captureId + 闭环视觉验证待落地 | R0‑R3 |
| browser-ops | ⬜ | elementRef + DOM revision 待落地 | R0‑R3 |
| agent/device | ⬜ | 待迁移 | R0‑R3 |
| context-mgmt | ⬜ | 动态 token 管理待替换固定 keepMessages | — |
| secret-ref | ⬜ | 不透明凭据引用待落地 | R4 |

---

## 本批次新增基础设施

| 模块 | 作用 |
|---|---|
| `ai-capability-registry.js` | 统一能力声明、搜索、humanOnly 边界 |
| `ai-capabilities.js` | 项目能力清单 + coverage 校验 |
| `ai-tool-executor.js` | AJV 严格 schema + 统一确认 + 标准 meta |
| `ai-connection-tools.js` | 连接 CRUD 协议规则与公共视图 |
| `ai-proxy-tools.js` | 代理 CRUD 协议规则与公共视图 |
| `ai-ssh-key-tools.js` | SSH 密钥元数据视图、指纹与格式校验 |
| `ai-playbooks.js` | 领域操作规程（capability-discovery / asset-management / proxy-management / ssh-key-management） |

## 安全关键决策

- 标准 AI 接口 **不接收** password / privateKey / passphrase / token / apiKey。
- 任何秘密字段若传入会被 AJV `additionalProperties:false` 直接拒绝。
- 确认改为 `confirmedToolId` 精确绑定；普通请求伪造 `confirmed:true` 无效。
- 连接/代理/SSH 密钥均有持久化 `revision` 列；写入需 `expectedRevision`，冲突返回 409。
- 授权在确认之前执行，不能对无权资源生成可确认操作卡。

## 已验证

```text
48/48 passed
```

覆盖：capability registry、coverage fail-closed、执行器与 schema 共享、连接与代理生命周期、SSH 密钥元数据、跨用户 ACL、AI policy、Runtime catalog 与 Playbook 注入。

---

## 下一步

1. 跳板机与代码片段标准化
2. SSH/TELNET 实际会话操作
3. RDP/VNC 多模态闭环
4. 浏览器 elementRef 提升
5. secretRef、上下文 token 管理与全覆盖扫描
