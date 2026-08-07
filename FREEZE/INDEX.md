# Zephyr 冻结状态

> 冻结日期：2026-07-11  
> 预计恢复：2027-07-10  
> 冻结原因：开发者个人事务，暂停开发  
> 当前稳定版：v1.1.447（RDP 可用，SSH/终端正常）

---

## 当前状态

- **稳定版**：v1.1.447（Latest Release）
- **main 分支**：包含 worker-gpu-v2 实验代码（commit `eae6a58`），不影响已发布版本
- **已撤回的 release**：v1.1.448 / v1.1.449 / v1.1.450（实验性，已删除 release 和 tag）
- **CI**：最后一次 run `29155904571` 通过

---

## 未完成模块及恢复优先级

### 1. RDP WASM GPU 管线（优先级：高）
- **状态**：main 分支有实验代码，完成度 ~80%，RDP 当前不可用
- **方向**：WASM 协议栈 + WebCodecs 硬解 + WebGL2 compositor（已验证正确）
- **方案文档**：[RDP_STATUS.md](./RDP_STATUS.md)
- **代码位置**：main 分支 commit `eae6a58` 起
- **恢复起点**：RDP_STATUS.md 第 5 节"恢复路线图"

### 2. 终端稳定性 + Deep Link + AI 笔记（优先级：中）
- **状态**：完整方案已写，未开始实施
- **方案文档**：[TERMINAL_DEEPLINK_NOTES_PLAN.md](./TERMINAL_DEEPLINK_NOTES_PLAN.md)（1219 行）
- **核心问题**：监控闪烁、WTerm 滚动竞争、登录会话不持久
- **恢复起点**：方案文档第 0 节"结论先行"

### 2b. AI Go Runtime（优先级：高 · Stage A 完成）
- **状态**：Stage A 完成；compaction 已接入 loop（2026-07-20）
- **方案文档**：[AI_GO_RUNTIME_PLAN.md](./AI_GO_RUNTIME_PLAN.md)
- **代码**：`zephyr-ai/` + `ai-runtime-bridge.js` + `/api/ai/runtime/*` + Docker entrypoint
- **约束**：SSE、服务端会话、权限规则、MCP、真 resume；禁止为省 token 改 system 拼装
- **续作**：archive 回查、Plan/Goal UI、权限规则编辑器

### 2c. AI 全能力标准化改造（优先级：高 · 🚧 进行中）
- **状态**：Capability Registry + 连接/代理/SSH 密钥资产域标准化已完成；SSH/TELNET/RDP/VNC 会话闭环待继续
- **进度文档**：[AI_PROGRESS_2026-07-25.md](./AI_PROGRESS_2026-07-25.md)
- **代码**：`ai-capability-registry.js`、`ai-capabilities.js`、`ai-tool-executor.js`、`ai-connection-tools.js`、`ai-proxy-tools.js`、`ai-ssh-key-tools.js`、`ai-playbooks.js`
- **约束**：接口完整 + 接口标准 + AI 通过 Playbook + capability_search 真会用；批量小、每批独立验证

### 3. Zephyr One Android / iOS 原生 App
- **状态**：用户产品要求修订版、完整架构/同步/文件桥接/浮岛/终端 IME/四色图标规范已写，未开始实施
- **资料目录**：[`zephyr one for mobile/`](./zephyr%20one%20for%20mobile/)
- **产品范围合同**：[`PRODUCT_REQUIREMENTS.md`](./zephyr%20one%20for%20mobile/PRODUCT_REQUIREMENTS.md)
- **技术方案文档**：[`DEVELOPMENT.md`](./zephyr%20one%20for%20mobile/DEVELOPMENT.md)
- **核心范围**：完整实现当前账号有直接移动用途的能力并保留服务器设置/备份恢复；不提供账号安全、SMTP、CAPTCHA/IP策略、备案、自定义CSS/JS管理、多用户或独立Agent页
- **命名**：One设置统一为“文件同步”，主端统一为“Zephyr Client”并保留旧Agent兼容
- **同步要求**：主端先建Token，One账号密码+TOTP（如启用）绑定；像iCloud一样完整双向镜像One有用途的数据/凭据/Client Token，支持自定义自动间隔、立即同步和密码/TOTP敏感删除/重置
- **原生与视觉**：Kotlin + Jetpack Compose、Swift + SwiftUI、四入口底部浮岛、终端快捷键矩阵与 IME 几何、四色应用图标
- **设计附件**：用户提交的三张 UI 参考图、四套 SVG、预览 HTML 与原始 ZIP 均保存在该目录

---

## 关键技术决策（冻结时的判断）

1. **RDP 方向是 WASM，不是 Guacamole。** Guacamole 是服务端渲染，CPU 开销大，H.264 需要服务器软解重编码。WASM 方案是浏览器端协议栈 + 硬解直通，天花板高一个量级。方向正确。
2. **终端继续用 WTerm，不迁移 xterm.js。** 需要建立 WTerm fork 修复滚动/resize，但不更换技术栈。
3. **Agent 用 flutter_inappwebview v6。** 支持证书拦截、JS Channel 双向通信。
4. **RDP 文件传输瓶颈**：同步 XHR 阻塞 + base64 膨胀 + 串行 IRP，方案是 Go WASM WebSocket + SAB 直连。

---
