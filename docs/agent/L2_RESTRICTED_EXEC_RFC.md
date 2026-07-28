# L2 受限 Exec 威胁模型 RFC（S8.2）

状态：**已实现**（`ai-session-exec.js` + `session_exec_v1` / `session_sandbox_status_v1`）  
日期：2026-07-28  
范围：Zephyr Agent Platform 会话级「短命本地 exec」，**不是**完整虚拟机沙箱。

## 1. 目标

在 L1 workspace 之上提供：

- 对用户附件/草稿做 **本地脚本化加工**（jq、grep、轻量转换）
- 默认 **无公网意图**、有 CPU/内存/时间墙、命令白名单
- **按 userId + sessionId** 目录隔离

## 2. 非目标

- 不提供 root、不挂载宿主机任意路径  
- 不实现完整容器编排 / K8s job  
- 不在 Android 构建机上跑原生编译  
- **禁止**「能 shell 无隔离」的半吊子实现上线  

## 3. 威胁模型与实现对照

| 威胁 | 缓解 | 实现 |
|------|------|------|
| 逃逸读宿主机密钥 | bwrap / 路径监禁 | bwrap 优先：仅 bind 会话目录 + ro /usr /bin；否则 realpath 路径必须落在 session root |
| 挖矿/死循环 | CPU/内存/墙钟 | `prlimit` cpu+as；`timeout --kill-after`；外层 kill 进程组 |
| SSRF/扫内网 | 默认无网 | bwrap `--unshare-net` 或 `unshare -n`；白名单无 curl/wget/ssh；`network:true` 需策略 |
| 写越权 | 仅 workspace/outputs 可写 | bwrap：uploads/ocr RO，workspace/outputs RW；sed -i 目标校验 |
| 供应链 | 白名单绝对路径 | 短名→realpath 白名单；禁止路径型 command；禁止 `-c` |
| 多租户串数据 | 每会话目录 | `data/ai-sessions/{user}/{session}/` |
| 子代理滥用 | 禁止子代理 L2 | profile deny + executeAiTool 硬拒绝 + 主代理确认策略 |
| 输出炸弹 | 截断 | stdout 512KB / stderr 256KB |
| 并发滥用 | 配额 | 全局 4 / 用户 2 / 会话 60 次/小时 |

## 4. 接口（已实现）

```
session_exec_v1
  command: string          # 白名单短名
  args: string[]
  cwd?: string             # 默认 workspace；支持 workspace://
  timeoutMs?: number       # 1000–60000，默认 15000
  network?: boolean        # 默认 false；true 需 ai.sandbox.allowNetwork 且确认
  sessionId?: string

session_sandbox_status_v1
  → isolation caps, whitelist, limits, active concurrency
```

返回：stdout/stderr/exitCode/durationMs/timedOut/isolation/auditPath。

## 5. 白名单与环境矩阵

### 5.1 文本

`jq grep sed awk head tail wc sort uniq file sha256sum md5sum cut tr cat basename dirname`

### 5.2 语言 / 媒体（对齐产品环境表）

| 环境 | 状态 | 规则 |
|------|------|------|
| **Python** | 完全支持 | `python3 workspace/*.py` 或 `-m module`；**禁止 `-c`/`-i`**；推荐 **`uv`**（run/sync/pip/venv/add/lock） |
| **Node.js** | 部分支持 | 仅会话内 `.js/.mjs/.cjs`；**禁止 `-e/-p`**；`npm` 限 install/ci/test/run/ls |
| **Go / Rust** | 支持 | `go build\|run\|test\|mod`；`cargo build\|run\|test`；`rustc` 源在会话内 |
| **FFmpeg** | 内置 | `ffmpeg`/`ffprobe`；路径限会话；**禁止 http/rtmp 等远程 URL**；硬件加速取决于镜像 ffmpeg 编译 |

禁止：`bash sh curl wget ssh docker nsenter busybox env xargs find rm pip npx …`（见 `FORBIDDEN_NAMES`）

### 5.3 超时

- 文本命令：默认 15s / 最大 60s  
- 语言/FFmpeg：默认 120s / 最大 300s

## 6. 隔离模式降级

| 模式 | 条件 |
|------|------|
| `bwrap-netns` | bubblewrap + unshare-net 可用 |
| `bwrap` | bwrap 可用但无 net ns |
| `unshare-net+confine` | unshare -n + 白名单路径监禁 |
| `whitelist-confine` | 无 bwrap/unshare：仍 **无 shell + 白名单 + 路径监禁 + 超时/配额**；审计标明建议装 bwrap |

**永不**降级到 `sh -c` / 任意二进制。

BusyBox 多路调用：若 `/bin/grep` realpath 为 busybox，则以 `busybox grep …` 调用，不把 busybox 本身当白名单入口。GNU `timeout`/`unshare`/`prlimit` 不可用时改用进程内 kill/配额（不使用 busybox 不兼容 flag）。

## 7. 审计

`{session}/outputs/.exec-audit.ndjson` 每行：userId、sessionId、command、args、cwd、mode、exitCode、durationMs、timedOut。

## 8. 上线门槛清单

1. ✅ 威胁模型写入本 RFC 并与代码对照  
2. ✅ 集成测试：白名单、路径穿越、cwd..、shell -c、超时结构、jq、network 策略、审计、子代理拒绝  
3. ✅ 审计落盘  
4. ✅ 文档明确「非完整 VM / 非 root 容器」  

## 9. 运维建议

生产镜像安装：`bubblewrap`（bwrap），以获得文件系统 + 网络命名空间隔离。  
可选：`util-linux`（prlimit/unshare）、coreutils timeout。

## 10. 与 Sprint 关系

- S3 L1 workspace：✅  
- S8.2 L2 exec：✅ `session_exec_v1`（本 RFC）
