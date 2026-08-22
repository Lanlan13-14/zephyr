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

### 3. Zephyr One Desktop / Android / iOS
- **状态**：三端均已有大量实现；真实完成度以编译、真机/桌面运行与 capability parity 证据判定，不再沿用“未开始实施”的陈旧结论。
- **唯一叙事合同**：[`zephyr one/ZEPHYR_ONE.md`](./zephyr%20one/ZEPHYR_ONE.md)
- **产品定位**：Zephyr 面向桌面与移动的第一方客户端；与同版本 Zephyr 当前账号能力对齐，同时可脱离主端独立运行。
- **技术栈**：Android = Kotlin + Jetpack Compose；iOS = Swift + SwiftUI；Desktop = Tauri 2 + Rust + 本地 Zephyr core。
- **启动硬门**：点击应用到真实可操作页面不超过 1 秒；禁止应用自建 Splash、BootGate、Loading 页面和空白等待。
- **同步与绑定**：Zephyr Link 是可选的 iCloud 类双向同步纽带；One 设备身份不依赖 Client Token，绑定兼容 Password/TOTP/Passkey/CAPTCHA/MFA；不使用 QUIC。
- **共享安全**：Shared-to-me 使用 strict broker，凭据不下发客户端，零持久化、实时鉴权和即时撤销。
- **冻结副本**：机器合同、品牌源、UI 参考图、预览 HTML 和原始上传均保存在 `zephyr one/` 子目录，并由 parity/hash 检查防止漂移。

---

## 关键技术决策（冻结时的判断）

1. **RDP 方向是 WASM，不是 Guacamole。** Guacamole 是服务端渲染，CPU 开销大，H.264 需要服务器软解重编码。WASM 方案是浏览器端协议栈 + 硬解直通，天花板高一个量级。方向正确。
2. **终端继续用 WTerm，不迁移 xterm.js。** 需要建立 WTerm fork 修复滚动/resize，但不更换技术栈。
3. **Agent 用 flutter_inappwebview v6。** 支持证书拦截、JS Channel 双向通信。
4. **RDP 文件传输瓶颈**：同步 XHR 阻塞 + base64 膨胀 + 串行 IRP，方案是 Go WASM WebSocket + SAB 直连。

---
