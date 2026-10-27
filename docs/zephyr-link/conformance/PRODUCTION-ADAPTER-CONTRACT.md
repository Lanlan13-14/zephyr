# Zephyr Link 生产一致性适配器合同与反绕过治理

> 目的：防止通过更换实现、修改预期、跳过校验、替换 mock 或修改测试本身来制造假通过。`run-conformance.mjs` 仅验证参考模型；**生产证据必须由实际生产模块及其适配器产生。**

## 1. 三种结果必须严格区分

| 结果 | 含义 | 可否作为产品发布证据 |
|---|---|---|
| `documentation-reference` | JSON Schema、参考适配器、规范向量与反例通过 | **否**，只能证明规范样例自洽 |
| `production-conformance` | 实际 Node/Go/Kotlin/Swift 生产适配器执行同向量通过 | 可作为对应实现的合同证据，仍需真实故障/设备验收 |
| `production-e2e` | 真实主端、真实 App、数据库、密钥库、网络与多设备闭环 | 可作为用户功能验收证据 |

**不得将 reference runner 的 `ok:true` 写成“产品 220 项全部通过”。** 当前 `productionRequired` 项必须真实执行并由对应适配器回报，缺报告就是未通过。

## 2. 生产适配器必须实现

每个实现须提交下列接口，并附实现文件路径、语言、commit、构建命令与原始报告：

```text
metadata()
  -> { language, modulePath, commit, buildId, production: true }

mapSyncOperation(legacyBody, sessionContext)
  -> { kind, operation, body, responseShape, idempotency } | { error }

evaluateAgentPolicy(requestContext)
  -> allow | stable denial code

classifyWebdavWriter(capabilities)
  -> B0 | B1 | B2

executeProductionCase(case, fixtures)
  -> { status: pass | fail | unsupported, actual, artifacts }
```

要求：

1. 调用真实生产函数，不允许复制参考算法后改名为 production。**适配器审查必须能沿调用栈进入生产业务路径**：列出被调用的生产文件/符号/模块依赖与构建入口；仅有 `production:true` 字段、同名函数、字符串比较或包装参考适配器不算生产证据。独立 reviewer 必须确认这条调用链。
2. 适配器只做 DTO 转换，不重写授权、CAS、格式识别或冲突规则。适配器代码量、依赖与业务逻辑必须可审查；发现复制参考算法或第二套策略时，一律拒绝该证据。
3. `unsupported` 表示生产缺能力或缺 fixture，必须计入未通过，不能算 skip/pass。
4. 对同步 entity/secret/cursor/auth/schema 等 reference runner 标记的生产待验项，必须由真实主端或对应生产实现执行。
5. WebDAV fault/state 向量必须由真实 WebDAV 或可控生产故障注入服务执行，不能用 `webdavWriteMode()` 代替。
6. 同一 JSON 向量由 Node/Go/Kotlin/Swift 共同消费，不得各自翻译成不同预期。

## 3. 生产适配器验收流程

1. 对每组向量，先跑**未修复的生产版本**，需要失败的反例必须真实失败；附旧版本失败日志。
2. 再跑当前实现，返回实际业务结果、错误码、持久化状态和副作用。
3. 比较的不只是错误码：还包括实体、revision、cursor、outbox、secret presence、lease、listener、文件字节、审计与幂等回执。
4. 对已有正常路径，必须证明修复没有破坏旧客户端和其他 lane。
5. 运行源码 mutation：分别引入身份跳过、deny 绕过、配额绕过、弱 CAS、错误降级等，必须全部被生产测试杀死。
6. 生成机器可读报告，列明执行数量、实际断言数、失败、unsupported、跳过、设备与原始 artifact；报告状态由数据计算，不能手写 `ok:true`。

## 4. 协议与测试变更治理

以下文件属于**高敏合同**，修改必须附独立兼容性说明和复核，不能只由功能实现者自行改绿：

- `docs/zephyr-link/conformance/cases/*.json`
- `docs/zephyr-link/conformance/reference-adapter-v1.mjs`
- `docs/zephyr-link/conformance/run-conformance.mjs`
- `docs/zephyr-link/contracts/*`
- 生产对应的 schema、registry、interop vectors、错误码与同步规则

要求：

1. 业务实现与“放宽预期的测试修改”不得藏在同一无说明变更中。
2. 协议确需改变时先 ADR：说明旧行为、为何必须改、迁移、回滚、旧客户端影响和新向量。
3. 新向量必须先看到旧实现失败，不得只验证新实现兼容自己的新预期。
4. 同一 PR 修改生产与测试时，必须保留修改前后的双跑证据，不能将失败案例删除、降级或改成 permissive。
5. CI 必须检测向量/适配器/manifest 漂移；独立 reviewer 复核高敏合同及生产适配器是否真正调用生产代码。
6. 任何人不得把 `skip/todo/not_run/unsupported` 计为通过；不得通过调整测试超时掩盖 hang 或真错误。

## 5. 必须持续保留的反绕过模式

| 绕过方式 | 必须被杀死的坏行为 |
|---|---|
| 省略认证/设备一致性校验 | 接受跨设备/跨账号写入 |
| 根据字段是否存在猜协议 | 未协商也进入 v2，旧客户端被强塞新报文 |
| 同时接受所有 envelope 变体 | 双重 envelope、混淆身份、错误 op/kind 被执行 |
| allow 覆盖 deny | 本机明确拒绝的资源被主端或通用 allow 打开 |
| 空资源列表解释为通配 | 未授权目录、网络、Offload 全开放 |
| 多条 allow 取最大配额 | 用另一条宽松规则绕过更小上限 |
| 删除/公网监听不需审批 | 未确认的高危副作用发生 |
| 先返回幂等回执再查权限 | 撤销后仍重放成功 |
| 用快照/锁文件替代 CAS | 多写者无互斥，后写覆盖先写 |
| 以“只读备份”名义允许多写 | B1 悄悄变成无保障的多主同步 |
| 修改参考实现/测试期望 | 坏实现通过但生产仍错误 |
| 只跑 reference 就宣称生产通过 | 真实实现从未执行，未验证被隐藏 |

## 6. 报告格式

```json
{
  "evidenceType": "production-conformance | documentation-reference | production-e2e",
  "commit": "full SHA",
  "adapter": "path/to/production/adapter",
  "vectors": { "total": 0, "executed": 0, "passed": 0, "failed": 0, "unsupported": 0, "requiredCaseIds": [], "executedCaseIds": [] },
  "mutations": { "total": 0, "killed": 0, "survived": 0 },
  "artifacts": ["raw-log", "db-diff", "network-trace", "binary-report"],
  "coverageGaps": ["honest missing platform/provider/case"]
}
```

`ok` 必须同时满足以下全部条件，**空报告、部分报告、只跑参考实现都不是通过**：

- `total > 0` 且 required case ID 集合与 manifest 声明的目标范围完全一致；
- `executed === total && passed === executed`；
- `failed === 0 && unsupported === 0 && skipped/todo/not_run === 0`；
- 所需真实源码/生产 mutation 全部 killed，`survived === 0`；
- 每个声明的平台均有真实生产调用链、构建入口与副作用断言；
- `evidenceType` 与证据层级相符，且附原始日志、环境、commit、产物与未覆盖项。

**参考执行与生产执行是两个不可抵扣的全量集合**：即使 Agent 的 88 个参考向量已验证，生产 Agent/系统权限仍必须执行对应向量，不能因为没有 `productionRequired` 数组就免除。参考 runner 的 productionRequired 仅表示其无法验证的部分，不是生产范围定义；生产适配器必须从 manifest/目标范围独立计算 required case 集。

若只跑了参考实现，`evidenceType` 必须保持 `documentation-reference`，即使所有参考样例通过。

[RULES I BROKE]：无。
