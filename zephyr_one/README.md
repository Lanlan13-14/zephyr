# Zephyr One

Tauri 原生客户端：**在本地运行完整 Zephyr 产品**（仪表盘 / SSH / RDP / VNC / 笔记 / AI / Client Token 等）。

## 与主端的关系

| 通道 | 用途 |
| --- | --- |
| **本地嵌入核心** | 日常全部功能（`zephyr-core` = staged `server.js` + `public/`） |
| **远程 Zephyr 主端** | **仅数据同步**（`/api/one/*` 绑定与 pull），不承载日常 UI |

## 本地安全

- 设置项：**启动时要求系统解锁**（默认 **关**）
- 开启后只调系统认证（BiometricPrompt / LocalAuthentication / Windows Hello），**无应用自建密码**
- 产品面隐藏：多用户管理、服务端安全策略、备份导入导出（本地核心仍是完整 Zephyr 代码路径，UI 侧收敛）

## 图标与签名

- 图标：与 Zephyr / Agent 相同的 `ic_launcher` 风标
- Android 发布签名：对齐 Agent  
  - keystore: `platform_assets/android/signing/zephyr-one-release.jks`  
  - 与 Agent 相同 key 材料（`zephyr-agent` alias），保证可更新链与运维习惯一致  
  - `scripts/prepare-android.sh` 在 `tauri android init` 后注入 `signingConfigs.release`

## 开发

```bash
cd zephyr_one
npm install
npm run stage:core    # 从仓库根 stage 完整 Zephyr 到 zephyr-core/
npm run test:ci
npm run tauri dev     # 自动 stage + 本地 Node 核心 + WebView
```

### Android

```bash
npm run stage:core
npx tauri android init   # 首次
npm run android:prepare  # 图标 + release JKS 签名
npx tauri android build --apk --target aarch64
```

Node for Android（若需捆绑 node 二进制）：  
https://github.com/Delusions6515/node-android-build  
`scripts/fetch-node-android.sh`

## 目录

```
zephyr_one/
  src/                 # One 壳（解锁 / 启动本地核心）
  src-tauri/           # Tauri + 本地 runtime 拉起 Node
  zephyr-core/         # build 时 stage，不进 git
  platform_assets/     # 图标 + release jks
  scripts/
    stage-zephyr-core.sh
    prepare-android.sh
    stamp-android-icons.py
    fetch-node-android.sh
```
