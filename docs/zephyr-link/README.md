# Zephyr Link 工程规范

本目录是 Zephyr Link 全端互联的**目标架构、已批准决策、协议基线及强制发布门禁**。规范批准不代表功能已实现；完成状态只能由真实平台测试与发布产物证据证明。

## 文档

| 文档 | 用途 |
|---|---|
| [ZEPHYR-LINK-INTERCONNECTION-SPEC.md](./ZEPHYR-LINK-INTERCONNECTION-SPEC.md) | D1–D15 决策、身份/数据域、Link 帧、同步、WebDAV、Handoff、Agent、AI、Shared、HA 与 Go 安全 |
| [TESTING-AND-RELEASE-GATES.md](./TESTING-AND-RELEASE-GATES.md) | 必测层级、影响声明、故障注入、多端回归目录、CI 和发布验收报告 |
| [ENGINEERING-INDEX.md](./ENGINEERING-INDEX.md) | 工程师改代码、查调用链、选测试与交付证据的导航 |
| [conformance/](./conformance/) | 224 个规范向量、参考适配器、真实源码变异与生产适配器反绕过治理 |
| `contracts/decision-record-v1.json` | 机器可读的已批准决策与 Agent 本机最终授权原则 |
| `contracts/link-frame-envelope-v1.example.json` | 新互联业务的版本化帧信封参考合同 |
| `contracts/agent-policy-v1.example.json` | 每台 Agent 独立配置的本机策略参考合同 |
| `contracts/agent-authorization-v1.cases.json` | Agent 本机/主端/系统/策略代际的权限交集正反例 |
| `contracts/mobile-sync-envelope-v1.cases.json` | mobile v1 `op` 到新 `sync.*` 信封的映射及拒绝混用向量 |
| `contracts/change-impact-v1.example.json` | Link PR 必须填写的影响声明参考合同 |

## 不可变原则

1. **Agent 本机用户的策略是最终能力上限。** 主端 ACL 只能收窄，不能扩大；实际权限取 Agent 本机策略、主端 ACL、当前操作与系统授权的交集。
2. 本地存储保留平台事务能力；Go 统一协议密码学、WebDAV、编解码和校验，不以“统一”为名重写所有本地数据库。
3. ZSL/2 是 bound 实时互联数据面，但 `trusted-primary` 通道不得宣称主端不可见内容的零知识。
4. 多端功能的完成证据必须包含真实故障和真实发布产物，不能仅依赖静态源码检查、mock 或其他分支的历史绿灯。
5. 所有新增/修改互联合同必须附兼容分析、回滚方案、影响声明和对应测试。

## 验证

在仓库根目录执行：

```bash
node docs/zephyr-link/verify-docs.mjs
node docs/zephyr-link/conformance/run-conformance.mjs
node docs/zephyr-link/conformance/verify-conformance.mjs
node docs/zephyr-link/conformance/run-source-mutations.mjs
```

上述命令检查决策完整性、D15 本机授权原则、Node/Go KIND 对齐、JSON Schema、示例/负例、224 个规范向量及真实源码变异，并区分 128 个参考执行通过与 96 个生产待验项。它们只验证规范的一致性，**不替代任何真实同步、互联或原生平台测试**。生产必须按 [生产适配器合同](./conformance/PRODUCTION-ADAPTER-CONTRACT.md) 提供实际实现结果。

## 当前基线与现状

- 规范基线：`zephyr-newui@3796df32dbe8fe28376e45ff1e7ccf2080cc87c1`。
- 现有 `KIND=1..16` 是冻结的通道编号，不是功能完成清单。
- 当前同步、Handoff、AI RPC、VFS 等仍有大量实施工作，按架构规范 P0–P6 推进。
- 安全热修先于大型重构；真实二进制必须重编译和验证，不能只修改 CI 版本文本。

[RULES I BROKE]：无。
