# Zephyr Agent Platform 超级详细修复与改造文档

> 仓库：https://github.com/Lanlan13-14/zephyr-ssh  
> 参考：  
> - https://github.com/OpenMinis/OpenMinis（附件、工作区、每模型模态能力、ImageBudget、read_image）  
> - https://github.com/esengine/DeepSeek-Reasonix（前缀缓存、snip/prune/compact、task/parallel_tasks/fleet、subagent profile）  
> 日期：2026-07-28  
> 状态：**S0-hotfix…S8 已实现（2026-07-28）**；L2 exec 仅 RFC、未上线。  
> 产品定调：**多租户远程运维 Agent 平台**（完整 agent harness，不是「聊天框 + 几个 Tool」）。

---

## 0. 文档怎么用

| 读者 | 用法 |
|------|------|
| 实施者 | 按 Sprint / 批次改代码；每批必须有验收清单与回归 |
| 审查者 | 对照「根因」「禁止事项」「验收标准」 |
| 产品 | 看第 1–2 章目标与能力柱；沙箱在 L1/L2 分层 |

**硬规则（来自项目既有约束 + 本次定调）**

1. 不允许偷懒：用户要求的能力必须按意图做完；做不到直接说做不到。  
2. 小批次：每批少量代码 + 完整测试；禁止一次丢几千行无测试。  
3. 依赖编译 / 镜像 / 集成测试在测试机执行，不在 Android 本机编原生。  
4. 远程桌面视觉与用户附件 **禁止** 再走「把 dataUrl 拼进纯文本 content」。  
5. 完整虚拟沙箱 **不是** S0–S7 阻塞项；L1 workspace 是。

---

## 1. 问题总览（用户可感知）

| # | 现象 | 用户体感 |
|---|------|----------|
| P1 | RDP/VNC AI 常说「看不到图片 / 无法查看截图」 | 远程桌面代操作废了 |
| P2 | 用户向 AI 发文件垃圾 | 图当 base64 文本；大文件 24KB 硬截；非图几乎无用 |
| P3 | 模型参数粗糙 | 仅供应商级开关；**没有** Minis 式每模型「图片/PDF/音频/视频输入、窗口、思考」 |
| P4 | 无本地工作区 | 无连接时不能加工文件；凡事逼远端 |
| P5 | 无子代理 | 多机勘察/分析只能串行，效率上不去 |
| P6 | 前缀缓存未优化 | system/context 每轮重拼 → DeepSeek 等 prefix cache 常 miss → 又贵又慢 |
| P7 | 非 vision 模型无 OCR 回退 | 便宜文本模型完全不能碰 RDP/附件图 |

---

## 2. 根因分析（代码级，必须先认同）

### 2.1 RDP/VNC「看不到图」——多因叠加

代码基线（main 已有 RDP vision 热修，**仍不够**）：

| 层 | 文件/位置 | 行为 | 缺陷 |
|----|-----------|------|------|
| 前端 Runtime 路径 | `public/app.js` `consumeAiRuntimeSse` + `capture-image` | Blob 上传 Go CaptureStore | 正确方向 |
| 前端 Legacy 路径 | `handleAiClientCapture` ~6759 | `followup` **把 dataUrl 拼进 content 字符串** | 模型当文本，不是 vision |
| Go 注入 | `loop.go` observation `Parts: text + image_url` | 当轮可看图 | 见下「顺序 bug」 |
| Go 维护 | `withoutVisualParts` | 新观察来时 **丢掉所有** 带 Parts 的消息 | 只留最新图（可接受）但实现过粗 |
| Go 请求组装 | `loop.go` ~356–382 | 所有 `len(Parts)>0` 的消息 **抽到数组末尾** 再 `append` | **多步后图与 tool_call 脱节** → 模型「看不见/对不上」 |
| Provider | openai/anthropic/gemini | Parts → image_url / base64 / inlineData | wire 已有；**兼容网关**可能吞图 |
| 配置 | `options.vision` **仅供应商级** | 关则 400 `vision_required` | 无 **每模型** 图片输入旗标；选错模型仍当有 vision |
| 持久化 | observation **不落** SQLite（有意） | 刷新/compact 后无图 | 历史轮无法再看旧帧（可接受）但当轮必须对 |
| 提示词 | `ai-defaults.js` | 要求「真正观察图片」 | 若 wire 无图，模型只能撒谎或说看不到 |

#### 2.1.1 致命顺序 bug（必须修）

```text
内存 messages 真实顺序：
  system
  user
  assistant(tool_calls: capture)
  tool(result metadata)
  user+Parts[image]          ← 视觉观察
  assistant(tool_calls: action)
  tool(result)

当前组装 modelMessages：
  1) 抽出所有 Parts 消息 → visualObservations
  2) compact(剩余文本)
  3) modelMessages = 文本 + visualObservations（贴在最后）

结果发给模型：
  system, user, asst, tool, asst, tool,  **[image 在最后]**
```

模型在「决定点击」的上下文里 **还没看到图**，图却在整段对话末尾。  
部分模型会说「没有收到图片 / 看不到画面」——**这不是模型蠢，是我们把图挂错位置。**

**修复原则：**  
- 带图 observation **必须保持与 tool_result 的相对顺序**（紧跟对应 capture 的 tool 消息之后）。  
- compact 只允许改写 **纯文本 tool result / 旧 assistant**，不得把 vision 消息挪到全局末尾。  
- 实现建议：`compact.Apply` 的输入输出都是「可折叠段」；vision 消息作为 **pin**，index 对齐插回。

#### 2.1.2 Legacy 路径仍在毒化

`public/app.js`：

```js
const imagePart = shot?.dataUrl ? `\n\n最新远程桌面截图：\n${shot.dataUrl}` : '';
// → /api/ai/chat messages[].content 纯字符串
```

即使 Runtime 修好，若用户/开关走 Legacy，或 confirmation followup 仍走 Legacy，**同一 bug 复发**。

**修复原则：**  
- `activeSurface.kind === 'remote-desktop'` **强制 Runtime**（已有部分逻辑，需无旁路）。  
- 所有 capture followup **禁止** content 内嵌 dataUrl；统一 capture-image → Parts。  
- Legacy `/api/ai/chat` 对 remote-desktop **直接 400** 或内部转 Runtime。

#### 2.1.3 「有 vision 开关仍看不到」的其它原因

1. 供应商 vision=true，但实际模型是纯文本（Zephyr **无法**在模型级关闭图片输入）。  
2. 截图 mime 非 png/jpeg/webp → `DecodeDataURL` 失败 → Anthropic/Gemini 静默无图。  
3. 图过大被网关丢弃/413，前端无明确错误，模型侧像「没图」。  
4. 上传 capture-image 失败后只把 metadata 当成功。  
5. 提示词与 tool 结果说「请看图」，但 Parts 为空。

**修复原则：**  
- 每模型 `inputModalities.image`（见 Minis 截图）。  
- 请求发出前 **assert**：若本步存在 capture observation，则 wire body 必须含 image part；否则 fail-closed 并提示用户。  
- 压缩阶梯 + 明确错误码 `vision_payload_invalid` / `vision_upload_failed`。

---

### 2.2 用户附件垃圾路径

`appendAiFiles` + `sendAiMessage`：

- 图片 → `content: "附件图片：name\n" + dataUrl`  
- 文本 → 截 24KB 塞 markdown  
- 其它 → 一行废文案  
- Runtime body 只有 `message: text`  
- `localStorage` 存整段 base64  

Go 已有 `startRunReq.Messages []provider.Message` 与 `ContentPart`，**用户附件完全没用**。

---

### 2.3 模型配置 vs OpenMinis（用户截图）

OpenMinis 已具备（截图证据）：

- 模型列表：每模型图标表示 **图片 / 文档** 等能力  
- 模型详情：  
  - 上下文窗口 / 最大输出 Token（可「服务商默认」）  
  - 思考开关  
  - 可见性（隐藏）  
  - **输入模态**：图片 / PDF / 音频 / 视频  
  - **输出模态**：图片 / 音频  
  - 快速测试  

Zephyr 现状：

- `models` ≈ 字符串列表 + 默认模型  
- 供应商级：temperature、top_p、max_tokens、contextWindow、reasoningEffort、**vision 总开关**、extra JSON  
- **没有** per-model 模态矩阵，没有列表上的能力图标，没有「快速测试」

---

### 2.4 前缀缓存 vs Reasonix

Reasonix 硬约束：

- system + tools schema = **cache-stable prefix**（跨 turn 字节稳定）  
- 可变上下文骑 **turn tail**  
- `PrefixShape` 诊断 miss  
- snip → prune → compact；compact 是低频 cache reset  
- 子代理 profile **不写进** 主 tool schema  

Zephyr：

- `compose.SystemPrompt` 每轮拼 time + context + skills + memories  
- 意图 routing / surface 易进 system  
- 已有 compact，但 **无 prefix 稳定策略与 cache 诊断**  
- 注释「禁止为省 token 改 system」应改为「禁止砍能力；可变块移出 stable prefix」

---

### 2.5 子代理 vs Reasonix

Reasonix：`task` / `parallel_tasks`（只读并行）/ `fleet`（写路径预检）+ Profile Skill。  

Zephyr：单 loop，无隔离子上下文，无资源锁并行写。

---

## 3. 目标架构（完整 Agent 平台）

```
                         ┌─────────────────────────────────────┐
                         │ Model Catalog（每模型参数+模态+窗口） │
                         │ Cache-stable Compose + Diagnostics  │
                         └──────────────────┬──────────────────┘
                                            │
          ┌─────────────────────────────────┼─────────────────────────────────┐
          ▼                                 ▼                                 ▼
   ┌──────────────┐                 ┌──────────────┐                 ┌──────────────┐
   │ 输入面        │                 │ 工作面        │                 │ 编排面        │
   │ 附件 Parts   │                 │ Session WS   │                 │ 主 Agent     │
   │ RDP/VNC 视觉 │                 │ L1 读写工具  │                 │ 子代理 task  │
   │ OCR 回退     │                 │ (L2 exec 后) │                 │ parallel/fleet│
   └──────┬───────┘                 └──────┬───────┘                 └──────┬───────┘
          │                                │                                │
          └────────────────────────────────┼────────────────────────────────┘
                                           ▼
                         ┌─────────────────────────────────────┐
                         │ 治理：ACL / 确认 / 配额 / 审计 / 多租户 │
                         └─────────────────────────────────────┘
                         一等执行面仍是：SSH/Telnet/RDP/VNC/Browser/资产
```

### 3.1 会话目录布局（L1，非完整沙箱）

```text
data/ai-sessions/{userId}/{sessionId}/
  uploads/       # 用户附件原件
  workspace/     # AI/用户草稿
  outputs/       # 导出报告
  ocr/           # OCR 文本旁路
  spillover/     # 超预算图片落盘占位（对齐 Minis ImageBudget spillover 思想）
```

Linux 风格路径 **仅服务端内部**；对模型暴露：

- `attachmentId` / `workspace://{sessionId}/path` 或安全相对路径  
- **禁止**假装存在 OpenMinis 的 `/var/minis/...` 除非真有沙箱挂载

---

## 4. 分轨与 Sprint（实施顺序）

> 编号 **S0…S8**。RDP 视觉紧急修复标为 **S0-hotfix**，可与 S0 并行但优先合并。

| Sprint | 名称 | 优先级 | 依赖 |
|--------|------|--------|------|
| **S0-hotfix** | RDP/VNC 视觉「真看得见」 | P0 紧急 | 无 |
| **S0** | 每模型能力表 + UI（Minis 级） | P0 | 无 |
| **S1** | Cache-stable Compose + 诊断（Reasonix） | P0 | S0 窗口字段更佳 |
| **S2** | 用户附件上传 + multimodal Parts | P0 | S0 vision 旗标 |
| **S3** | Session Workspace L1 + Tools | P1 | S2 存储 |
| **S4** | OCR 回退 + ImageBudget | P1 | S2/S3、S0-hotfix |
| **S5** | compact 按模型窗口 + cache 回归 | P1 | S1 |
| **S6** | 子代理 task + parallel 只读 | P1 | S1、S3 |
| **S7** | fleet + 资源锁 + SSE 嵌套 UI | P2 | S6 |
| **S8** | 运行模式三档 + L2 exec RFC | P2–P3 | S5/S7 |

**对外可宣称「Agent 平台 MVP」：S0-hotfix + S0 + S1 + S2 + S3 + S6。**

---

# 5. S0-hotfix：RDP/VNC 视觉闭环「真看得见」

## 5.1 目标

模型在 **任意一步** 需要看远程桌面时：

1. 请求 wire 中存在 **正确格式** 的 image part；  
2. image part **紧邻** 对应 capture 的 tool 结果之后；  
3. 失败时 **明确错误**，禁止模型空口「看不到」却当成功；  
4. Legacy 路径不再投毒。

## 5.2 代码修改清单

### A. `zephyr-ai/internal/agent/loop.go`（核心）

**A1. 删除「把所有 Parts 丢到末尾」的逻辑**

当前：

```go
for _, msg := range messages {
    if len(msg.Parts) > 0 { visualObservations = append(...); continue }
    textMessages = append(...)
}
modelMessages = compact(textMessages)
modelMessages = append(modelMessages, visualObservations...)
```

改为：

```go
// 伪代码
type segment struct { msg provider.Message; pin bool } // pin = has visual parts

// 1. 标记 pin 消息（Parts 含 image_url）
// 2. compact 仅作用于 !pin 的连续文本区，或：
//    - 抽出 pin 的索引与消息
//    - compact 非 pin 列表
//    - 按「原相对顺序」把 pin 插回：插在「原前驱消息」在 compact 后对应位置之后
// 3. 禁止对 pin 消息做 snip/prune 文本破坏 image part
```

最小正确算法（推荐实现）：

1. `pins := []{index, msg}` 所有 `hasImagePart(msg)`  
2. `textOnly :=` 将 pin 位置换成 **占位 tool/user 文本消息**（短：`[visual-pin:id]`），**无** base64  
3. `compact.Apply(textOnly)`  
4. 扫描 compact 结果，把占位符替换回 **完整 pin 消息**（含 Parts）  
5. 若占位被 compact 删掉 → **强制把 pin 附加在最近保留的前驱之后**；仍失败则 fail-closed

**A2. `withoutVisualParts` 收窄语义**

当前：删除所有 `len(Parts)>0` 的消息。  

改为：

- 仅移除 **角色为视觉观察** 且 **同 surface** 的旧 RDP/VNC observation（例如 `Name=="remote_desktop_observation"` 或 Parts 带 meta flag）  
- **禁止**误删用户附件 multimodal user 消息  

建议 observation 结构：

```go
provider.Message{
  Role: RoleUser, // 或 RoleTool 扩展——若改 Role 需全 provider 回归
  Name: "zephyr.visual_observation",
  Content: metaText,
  Parts: []ContentPart{ text, image_url },
}
```

**A3. 发出请求前断言**

```go
if stepRequiresVision && !requestHasImagePart(modelMessages) {
  return error vision_missing_in_request
}
if providerOptions.vision == false { ... 已有 }
// 新增 per-model image input 检查
```

**A4. Capture 失败路径**

- CaptureStore Take 失败 → tool 结果 `ok:false` + 中文/ i18n code，**不要**再让模型「请看图」。  
- SSE 已有 client capture：前端上传失败必须 `permission`/error 事件，不能静默 resume。

### B. Provider 层

| 文件 | 改动 |
|------|------|
| `provider/types.go` | 可选：`ContentPart` 增加 `Detail`；记录 `Source`（capture/attachment） |
| `openai/*.go` | 兼容网关：可配置 `image_url` vs 纯 base64；测 Responses `input_image` |
| `anthropic/*.go` | Decode 失败打 metrics，不要静默 skip |
| `gemini/*.go` | 同上 |
| `vision_wire_test.go` | 增加「observation 夹在 tool 与 assistant 之间」整包序列化金样 |

### C. 前端 `public/app.js`

| 项 | 改动 |
|----|------|
| Runtime capture | 保持 Blob 上传；**校验** 响应 `captureId`；失败 toast + system 消息 |
| Legacy `handleAiClientCapture` | **删除** dataUrl 拼 content；改为强制 Runtime 或 Node 中转成 Parts |
| `sendAiMessage` | remote-desktop 且 !runtime → 已有 throw；确认 **所有 followup** 不绕过 |
| 用户可见 | 若模型仍说看不到，trace 显示「本步 wire 含图：是/否」调试信息（仅 admin/debug） |

### D. Node

| 文件 | 改动 |
|------|------|
| `server.js` runtime runs | vision 校验用 **模型级** 旗标（S0 后）；未上 S0 前继续 provider.options.vision |
| capture-image 代理 | 超时/413 映射稳定 code |
| Legacy chat | remote-desktop → 400 `runtime_required_for_remote_desktop` |

### E. 提示词 `ai-defaults.js` / unified skill

补充硬规则：

```text
若 tool 结果与随后视觉观察已提供图片，禁止声称「无法查看图片/看不到截图」。
若系统返回 vision_missing / vision_required / capture 失败，则如实说明错误码，不要编造画面内容。
```

## 5.3 测试（S0-hotfix 验收）

| # | 用例 | 期望 |
|---|------|------|
| H1 | 单次 capture → 模型请求 | image part 存在且位于 capture tool 消息之后 |
| H2 | capture → action → capture | **两帧**在时间序正确位置；第二帧替换策略明确（可只保留最近 1–2 帧 pin） |
| H3 | 多步后 compact 触发 | pin 图仍紧跟对应 tool，不在全局末尾 |
| H4 | vision=false | 400，中文错误，无模型胡话 |
| H5 | 损坏 mime | 明确错误，不静默 |
| H6 | Legacy 路径 remote-desktop | 拒绝或自动 Runtime，**content 无 data:image** |
| H7 | 现有 7/7 RDP 视觉传输 + AI 全套回归 | 全绿 |
| H8 | 真机：打开记事本，问「屏幕上有什么」 | 模型描述可见 UI，不说看不到 |

## 5.4 明确非目标（本 hotfix）

- 不解决用户附件  
- 不做子代理  
- 不改完整 compose 缓存（S1）  
- 可临时只 pin「最近 N 张」观察以控上下文（N=1 或 2）

---

# 6. S0：每模型能力表 + UI（对齐 OpenMinis）

## 6.1 数据模型

将 `ai_providers.models_json` 从 `string[]` 升级为：

```ts
type ModelEntry = {
  id: string;                    // 请求用模型 ID
  label?: string;                // 显示名称（可覆盖）
  hidden?: boolean;              // 不出现在选择器

  // 窗口（tokens）；null/省略 = 服务商/全局默认
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;

  // 采样与推理
  temperature?: number | null;   // null = 不覆盖供应商
  topP?: number | null;
  reasoning?: boolean;           // 「思考」总开关
  reasoningEffort?: 'none'|'low'|'medium'|'high'|'max'|null;

  // 输入模态（Minis 截图）
  input: {
    image: boolean;              // RDP/附件图
    pdf: boolean;
    audio: boolean;
    video: boolean;
  };
  // 输出模态
  output: {
    image: boolean;
    audio: boolean;
  };

  // 缓存与工具
  tools?: boolean;               // 默认 true
  parallelToolCalls?: boolean;
  promptCache?: 'auto'|'explicit'|'none';

  // 预算
  maxImagesPerRequest?: number;
  maxImageBytes?: number;

  // 其它
  apiMode?: 'auto'|'chat'|'responses'|null;
  userAgent?: string | null;     // 可迁移自 modelUserAgents 行
  extra?: Record<string, unknown>;
};
```

**迁移：**

- 旧 `models: ["gpt-x"]` → `{ id, label:id, input:{image: provider.vision!==false, pdf:false,...}, ...}`  
- 读路径兼容 string | ModelEntry  
- 写路径统一对象数组  

## 6.2 API

| 接口 | 行为 |
|------|------|
| CRUD provider | 接受/返回 ModelEntry[] |
| `GET .../models` 刷新 | 拉取远端列表，**合并** 已有 entry 的模态配置（按 id），新建 entry 给默认能力 |
| `POST .../models/:id/quick-test` | 最小 chat + 可选假图探测（若 image=true） |

## 6.3 UI（对照用户截图）

### 6.3.1 供应商 → 模型列表

- 行：显示名、id  
- 右侧图标：🖼️ 图片输入 / 📄 PDF（有则显示，无则空）——对齐截图 1000067615  
- 「Refresh model list」  
- 点击进入模型详情  

### 6.3.2 模型详情页/抽屉（截图 1000067616）

分区：

1. **标识**：模型 ID、显示名称、所属供应商  
2. **能力**：上下文窗口、最大输出 Token（占位「服务商默认」）  
3. **思考**：开关  
4. **可见性**：隐藏  
5. **输入模态**：图片 / PDF / 音频 / 视频 开关 + 说明文案  
6. **输出模态**：图片 / 音频  
7. **保存 / 快速测试**  

供应商级 vision 开关：**降级为「新建模型默认值」**，运行时以 **模型 entry.input.image** 为准。

### 6.3.3 选择模型（截图 1000067618）

- 按供应商分组  
- 搜索  
- 可选：绿点表示可用；图标可在选择器简化（详情里完整）  

## 6.4 运行时门闸

```text
if (request has image parts) {
  if (!model.input.image) {
    if (ocrFallbackEnabled) → OCR 管线 (S4)
    else → 400 vision_required (model-level)
  }
}
if (attachment is pdf && !model.input.pdf) → 工具读或拒
```

RDP capture 与用户附图 **共用** `input.image`。

## 6.5 测试

- 迁移旧 providers  
- 模型 A image=false、B true：同供应商仅 B 能 RDP 视觉  
- 隐藏模型不出现在 picker  
- 快速测试 mock  

---

# 7. S1：Cache-stable Compose（Reasonix）

## 7.1 拆分

```text
StablePrefix (会话冻结，直到显式 rebuild)：
  - 身份 + 语言策略
  - default guidance + custom system
  - skills 正文（启用集快照）
  - standing memories 快照
  - tool schemas（name 排序 + JSON canonicalize）

VolatileTail（每轮，不进 cache 前缀）：
  - <zephyr-context> 连接/终端/RDP surface/时间
  - <routing-hint>
  - <goal-contract>
  - 用户消息 + parts
```

## 7.2 实现要点

| 组件 | 改动 |
|------|------|
| `compose` | `BuildStable(in) (text, hash)` / `BuildVolatile(ctx)` |
| Node `buildSystemCompose` | 分离字段；run 时 stable 入 system，volatile 入 **额外 user 元消息** 或 provider 支持的 cache_control 边界 |
| session | 存 `stablePrefixHash`、`toolsHash`；skills/工具面变更 → rebuild + 事件 |
| agent loop | `prependSystem(stable)`；每轮 append volatile 为 **独立 message**（RoleUser，Name=`zephyr.context`），在真实 user 之前 |
| metrics | `CacheDiagnostics`：prefixChanged、reasons[system\|tools]、hit/miss tokens（若 usage 提供） |
| 测试 | 3 轮仅 user 变 → system+tools hash 不变；改 skill → 变一次 |

## 7.3 DeepSeek / 兼容端

- `promptCache: auto`：依赖前缀稳定即可  
- 若 API 支持 `cache_control` / 显式缓存点：在 stable 末尾打标（S1.1）  

## 7.4 与「禁止砍 system」的关系

- **保留** 全部 skills/guidance 能力  
- **移动** 每秒都变的 context/time 出 stable  
- time：放入 volatile，不要写进 stable  

---

# 8. S2：用户附件（OpenMinis 路径）

## 8.1 上传 API

```
POST /api/ai/attachments
  multipart: file, sessionId
  → { id, name, mime, size, kind: image|text|document }

GET  /api/ai/attachments/:id
DELETE /api/ai/attachments/:id
```

存储：`data/ai-sessions/{user}/{session}/uploads/{id}_{safeName}`  
限制：单文件大小、会话总数、mime 白名单、路径穿越防护。

## 8.2 前端

- `aiPendingInputAttachments`：ref + 上传状态 + blob preview；**禁止 content 塞 dataUrl**  
- 发送：`{ message: text, attachments: [{id}] }`  
- `localStorage` 只存 ref；迁移 strip 旧 base64  
- loading 未完成禁用发送  

## 8.3 组装 user message（Node → Go）

```text
parts:
  - text(caption)?
  - for each image:
      text([attached image: id | name])
      image_url(compressed data URL)  // 仅当 model.input.image
  - text(JSON inventory of all attachments)
```

非图：默认 **不 inline**；inventory + 后续 S3 read tool。  
小文本可选 inline（≤32–64KB）。

## 8.4 测试

- wire 含 image part 非 base64 长文本  
- localStorage 样本无 `base64,`  
- 越权 403  

---

# 9. S3：Workspace L1 + Tools

## 9.1 Tools

| Tool | 说明 |
|------|------|
| `workspace_list_v1` | 列 uploads/workspace/outputs |
| `workspace_read_v1` | offset/limit |
| `workspace_write_v1` | 仅 workspace/outputs；确认策略按风险 |
| `user_attachment_read_v1` | 按 attachmentId |
| `user_attachment_view_v1` | 图 → vision Parts 或 OCR |

## 9.2 规则

- 不自动 sync 远端  
- 配额 + ACL  
- skill 写明：无连接时用 workspace；改生产走 remote + 确认  

---

# 10. S4：OCR + ImageBudget

## 10.1 ImageBudget（对齐 Minis 数值，可配置）

| 项 | 建议默认 |
|----|----------|
| 单图 max | 5MB（阶梯压缩 2000→640 边） |
| 单轮图片合计 | 20–25MB |
| 整请求图片 | 25MB；超则旧图 elide → 占位 + attachmentId/spillover 路径 |
| RDP pin 帧 | 最近 1–2 张全分辨率推理图 |

## 10.2 OCR 回退

```text
if needImage && !model.input.image:
  run OCR → text part + 可选保留「无图」说明
  存储 ocr/{id}.txt
```

实现选项（选一，文档实现时写死）：

1. 侧车 Tesseract/容器 worker  
2. 可配置外部 OCR API  
3. 无 OCR 后端时：明确错误「模型不支持图片且未配置 OCR」

RDP 与附件共用。

---

# 11. S5：上下文维护增强

在现有 `compact` 上：

| 项 | 行为 |
|----|------|
| MaxChars/Tokens | 来自 **ModelEntry.contextWindowTokens** |
| snip/prune/compact 比例 | 可对齐 Reasonix 0.6 / 0.8 / 0.9 |
| 与 pin 图共存 | S0-hotfix 算法 |
| 归档 | 已有 archive 包则接入折叠原文 |
| cache | compact 后 stable prefix **不变**；仅 messages 变 → 预期 miss 一次在尾部 |

---

# 12. S6–S7：子代理（Reasonix 移植）

## 12.1 Tools

| Tool | 语义 |
|------|------|
| `subagent_task_v1` | 单任务；profile；返回 final only |
| `subagent_parallel_v1` | ≥2 只读并行 |
| `subagent_fleet_v1` (S7) | 多任务 + resource_claims 预检 |
| `subagent_list_profiles_v1` | 列 profile（**不**把列表塞进主 schema 静态描述） |

## 12.2 Profile（内置先）

| id | 工具面 | 场景 |
|----|--------|------|
| `readonly-scout` | list/get、terminal_read、只读 remote、workspace/attachment read | 多机勘察 |
| `log-analyst` | workspace/attachment | 日志 |
| `vision-operator` | capture/action/verify（写操作确认回主） | RDP 子循环 |
| `doc-writer` | workspace write | 报告 |

Profile 存储：先内置 JSON/Go catalog；后支持用户 Skill 式扩展。

## 12.3 硬规则

1. 子 run **隔离上下文**；父只收摘要 tool_result  
2. 权限：继承 user；可强制 read-only；Deny 全局优先  
3. 子代理 **不得** YOLO 代批高风险写 / 记忆写入（若有）  
4. 资源锁：`connectionId` / `tabId` / workspace path；写重叠 preflight 失败  
5. 并发：`max_subagent_concurrency` 默认 3；writers 默认 1–2  
6. 配额计入父用户  
7. SSE：嵌套 trace 卡片  

## 12.4 与 Plan/Goal

- Plan：默认只派 readonly  
- Goal：合约进 volatile tail；可周期 scout  
- 主 skill：不确定先 list profiles / capability_search  

---

# 13. S8：运行模式 + L2 exec（可选）

## 13.1 运行模式（Reasonix Economy/Balanced/Delivery）

| 模式 | 工具面 | 用途 |
|------|--------|------|
| Economy | 最小工具 + connect 扩展 | 省 token |
| Balanced | 当前完整 | 默认 |
| Delivery | 完整 + 验收门禁 | 高可靠交付 |

切换 = **有意** cache 断点（rebuild stable）。

## 13.2 L2 受限 exec

- 短命、默认无网、CPU/内存墙、命令白名单  
- 半吊子「能 shell 无隔离」**禁止上线**  
- 单独威胁模型 RFC  

---

# 14. 文件级影响地图

| 区域 | 路径 |
|------|------|
| 前端 AI | `public/app.js`, `app.html`, `style.css`, i18n |
| 附件/工作区 | 新 `ai-attachment-service.js` 或 `ai-session-fs.js`；`server.js` 路由 |
| Provider 配置 | `ai-provider-service.js`；DB models_json |
| Runtime 桥 | `ai-runtime-bridge.js` |
| 能力注册 | `ai-capabilities.js`, registry, playbooks, defaults, intent-routing |
| Go agent | `loop.go`, `capture_store.go`, compact, compose, session store |
| Go provider | openai/anthropic/gemini + vision tests |
| 测试 | `tests/ai-*.test.mjs`, Go `*_test.go`, 真机 RDP 清单 |
| 文档 | 本文件；可选拆 `docs/agent/*` |

---

# 15. 禁止事项（写进 Code Review 清单）

1. ❌ 把 `data:image...base64` 拼进 `message`/`content` 当「发图」  
2. ❌ 把所有 `Parts` 消息挪到请求末尾  
3. ❌ `withoutVisualParts` 误删用户附件图  
4. ❌ localStorage / SQLite content 持久化整图 base64  
5. ❌ 仅供应商 vision、忽略模型 `input.image`  
6. ❌ 每轮重算 system 导致无意义 cache miss（S1 后）  
7. ❌ 子代理无资源锁并行写同一 SSH/RDP  
8. ❌ 子代理自动确认高风险写  
9. ❌ 假 `/var/minis` 路径无后端  
10. ❌ 无测试的「大重构一次丢」  

---

# 16. 验收总表（平台级 Definition of Done）

| ID | 标准 |
|----|------|
| D1 | RDP 问「屏幕上有什么」→ 描述真实 UI，**不说看不到图**（真机+H1–H8） |
| D2 | 多步 click 闭环：每步 wire 含序正确 image part |
| D3 | 用户传 png：上游为 image part；历史 JSON 无大 base64 |
| D4 | 每模型可关图片输入；关则 RDP/附件门闸或 OCR |
| D5 | 模型列表有能力图标；详情可编模态/窗口/思考 |
| D6 | 同会话 10 轮：stable system+tools hash 不变（仅 user/volatile 变） |
| D7 | cache metrics 可见 hit/miss/prefixChanged |
| D8 | workspace 无远端可分析上传 log |
| D9 | parallel 两连接只读勘察；父上下文不被子轨迹撑爆 |
| D10 | 现有 AI/RDP/终端回归全绿；权限/确认不回退 |

---

# 17. 建议立即执行顺序（给你排期用）

```text
Week 1:  S0-hotfix（RDP 顺序+Legacy 毒路径+断言）  ← 用户当前最痛
Week 1–2: S0 模型能力表+UI（可与 hotfix 后半并行）
Week 2:  S1 cache-stable compose
Week 2–3: S2 附件 Parts
Week 3:  S3 workspace tools
Week 3–4: S4 OCR + budget
Week 4:  S5 compact 校准
Week 4–5: S6 子代理只读并行
Week 5–6: S7 fleet + UI
之后:    S8 模式档 / L2 RFC
```

---

# 18. 附录 A：RDP 视觉时序（修复后）

```text
User: 屏幕上有什么？
  → Assistant: tool_call remote_desktop_capture_v1
  → Pause capture → 前端截图 → POST capture-image
  → Resume:
       tool_result { ok, captureId, meta 无 base64 }
       user/observation Parts[ text meta, image_url ]   ← 紧跟 tool_result
  → Provider Stream( messages 保持该顺序 )
  → Assistant: 描述画面…
  → （可选）tool_call action + captureId
  → tool_result
  → （可选）再次 capture → 新 observation；旧 observation 按策略淘汰
```

---

# 19. 附录 B：OpenMinis / Reasonix 对照速查

| 能力 | OpenMinis | Reasonix | Zephyr 目标 Sprint |
|------|-----------|----------|-------------------|
| 每模型图片/PDF/… | ✅ 截图 | 模型 override | S0 |
| 附件落盘+预算 | ✅ | 附件控制层 | S2/S4 |
| read_image | ✅ | 文件工具 | S3 view |
| prefix cache | 部分 | ✅ 核心 | S1 |
| snip/prune/compact | 有 | ✅ | 已有+S5 |
| task/parallel/fleet | 弱/无 | ✅ | S6/S7 |
| 远程 RDP 视觉 | 无 | 无 | S0-hotfix（自有） |
| 多租户 ACL | 弱 | 单机 | 全程硬约束 |

---

# 20. 附录 C：S0-hotfix 伪代码（loop 组装）

```go
func buildModelMessages(messages []provider.Message, compCfg compact.Config, skip bool) []provider.Message {
    type item struct {
        msg provider.Message
        pin bool // has image part
    }
    seq := make([]item, 0, len(messages))
    for _, m := range messages {
        seq = append(seq, item{msg: m, pin: hasImagePart(m)})
    }

    // Placeholders for compact
    textIn := make([]provider.Message, len(seq))
    for i, it := range seq {
        if it.pin {
            textIn[i] = provider.Message{
                Role: it.msg.Role,
                Name: it.msg.Name,
                Content: fmt.Sprintf("[visual-pin:%d]", i),
            }
            continue
        }
        textIn[i] = it.msg
    }

    out := textIn
    if !skip {
        out = compact.Apply(textIn, compCfg).Messages
    }

    // Rehydrate pins by placeholder token
    rehydrated := make([]provider.Message, 0, len(out)+2)
    used := map[int]bool{}
    for _, m := range out {
        if id, ok := parseVisualPin(m.Content); ok && id >= 0 && id < len(seq) && seq[id].pin {
            rehydrated = append(rehydrated, seq[id].msg)
            used[id] = true
            continue
        }
        rehydrated = append(rehydrated, m)
    }
    // Any pin lost by compact: append after last message (last resort) + metric
    for i, it := range seq {
        if it.pin && !used[i] {
            rehydrated = append(rehydrated, it.msg)
            // emit metric pin_recovered_at_end — should be rare
        }
    }
    return rehydrated
}
```

---

# 21. 变更日志（本文档）

| 日期 | 说明 |
|------|------|
| 2026-07-28 | 初版：合并 RDP 根因、附件、Minis 模型 UI、Reasonix 缓存与子代理、L1 workspace；给出 S0-hotfix…S8 与验收 |
| 2026-07-28 | 实现：S0-hotfix pin 序；S0 ModelEntry UI/门闸；S1 stable/volatile；S2 附件落盘；S3 workspace tools；S4 OCR+budget；S5 compact 0.6/0.8/0.9；S6/S7 子代理；S8 economy/delivery + L2 RFC。未 commit。AI 定向 195/195（串行） |

---

**结束语**

当前最伤体验的不是「缺一个大沙箱」，而是：

1. **图在错误位置 / 错误通道** → 模型诚实或幻觉地说看不到；  
2. **能力与配置粒度不够** → 无法按模型门闸与路由；  
3. **缺工作区与子代理** → 完整 agent 平台做不起来。  

按本文 **先 S0-hotfix，再 S0/S1/S2**，其余柱按表推进。  
实现时以本文件为契约；若实现与文档冲突，**先改文档再改代码**。
