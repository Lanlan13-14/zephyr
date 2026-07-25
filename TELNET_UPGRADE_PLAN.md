# Telnet 对齐 SSH 水平升级计划

目标：telnet 会话获得与 SSH 相同的会话管理、历史、监控、自动登录体验。
原则：**优先复用仓库内已有基础设施**（ssh session infra / terminal-history / stats），
外部依赖只补两个空白点（IAC 状态机、编码）。前端 WS 协议两边一致，基本零改动。

差距基线（2026-07-25 审计，commit 265e490）：
- server.js:6927-6965 裸 socket，无 session 对象
- server.js:6829 telnet 强制 password:''，保存的凭据被丢弃
- telnet-transport.js filterIac 无状态，不答 TTYPE，跨分包丢数据
- 无 terminalHistory / startStatsPush / keepalive / 编码转换

---

## 落地状态（2026-07-25，本地 worktree，未 commit）

测试：`node --test` **59/59 绿**  
（telnet-api / ui-contract / transport / iac-engine / session-phase0 / ws / autologin / encoding / ssh-session-resume）  
Go：`gofmt -e` 通过；沙箱 go1.26 toolchain 不可用，`go test` 留给正式环境

### Phase 0 — 会话基础设施对齐 ✅

把 telnet 包进与 SSH 同构的 session 对象，**复用** `sshTerminalSessions` map（未改名，避免全库改动）：

- [x] telnet connect 构建 session（protocol/telnetSocket/attachedWs/outputBuffer/...）
- [x] data → `appendSshSessionBuffer` + `broadcastSshSession`
- [x] error/close → `destroySshTerminalSession`（销毁 telnetSocket + IAC/autoLogin）
- [x] WS close → detach only（TCP 存活，可 reattach + history replay）
- [x] attach 还原 telnetSocket，ready 带 protocol/warning
- [x] detached TTL GC 覆盖 telnet
- [x] terminalHistory open/append/replay/close
- [x] stats：仅 sshClient 存在时 push（telnet 无远程 exec，跳过）

### Phase 1 — IAC 协议状态机 ✅

`telnet-transport.js` 新增 `TelnetIacEngine` / `attachIacEngine`：

- [x] 跨分包缓冲 incomplete IAC/SB
- [x] DO/DONT/WILL/WONT 回复（wantUs=NAWS/TTYPE，wantHim=SGA/ECHO，防协商环）
- [x] TTYPE SEND → IS xterm-256color
- [x] IAC NOP keepalive（默认 60s）
- [x] 兼容旧 `filterIac`（respond:false 纯剥离）
- [x] CR NUL → CR（非 BINARY 模式，RFC 854 NVT）
- [x] Go worker `telnetIacEngine` 对齐（TTYPE/状态机/keepalive/CR NUL）

### Phase 2 — 自动登录 ✅

- [x] 保存连接允许 TELNET password/username（加密存储，API 仍 mask）
- [x] `createTelnetAutoLogin`：login:/password: 正则（跨 chunk），15s 超时
- [x] init 命令 defer 到 auto-login onDone（有凭据时不打进 prompt）
- [x] UI：密码字段对 TELNET 可见；提示文案更新

### Phase 3 — 编码支持 ✅

- [x] 依赖 `iconv-lite`
- [x] `createTelnetDecoder`：utf-8/gbk/big5/latin1，多字节跨 chunk hangover
- [x] connections.encoding 列（migration + insert/update/rowToConnection）
- [x] UI：`#connEncoding` 选择器（仅 TELNET 显示）
- [x] 收/发/自动登录/init 全走 decoder

### Phase 4 — 体验收尾 ✅

- [x] ready 带 protocol + encoding；connInfo 显示 `TELNET · host:port · GBK`
- [x] ready warning toast（明文提醒）
- [x] `classifyTerminalClose`：remote_close / remote_error / detached_ttl / client_disconnect
- [x] terminal.js 按 code 决定是否自动重连与父页通知
- [x] cache bust `20260725-telnet-p01234`
- [x] Go worker close 帧带 code（telnet_remote_close / telnet_error）

## 不做（维持）

- SFTP/文件管理 / zmodem
- AI agent / snippet 注入（有自动登录后 init 已可用）

## 关键文件

| 文件 | 改动 |
|---|---|
| `server.js` | session 化 / IAC / auto-login / encoding / 凭据 / close 分类 |
| `telnet-transport.js` | TelnetIacEngine + autoLogin + decoder + classify + CR NUL |
| `storage.js` | connections.encoding 列 |
| `zephyr-worker/telnet.go` | 状态机对齐 Node |
| `zephyr-worker/telnet_test.go` | Go 单测 |
| `public/app.{html,js}` | 编码字段、密码可见、payload |
| `public/terminal.js` | encoding 透传、角标、close 分类 |
| `tests/telnet-*.test.mjs` | 全套 |
| `package.json` | +iconv-lite |
