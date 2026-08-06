# Zephyr One

Tauri 原生客户端：**在本地运行完整 Zephyr 产品**（仪表盘 / SSH / RDP / VNC / 笔记 / AI / Client Token 等）。

## 与主端的关系

| 通道 | 用途 |
| --- | --- |
| **本地嵌入核心** | 日常全部功能（`zephyr-core` = staged `server.js` + `public/`） |
| **远程 Zephyr 主端** | **仅数据同步**（`/api/one/*` 绑定与 pull），不承载日常 UI |

## 本地安全（开箱）

- 设置项：**启动时要求系统解锁**（默认 **关**）
- 开启后只调**系统**认证，无应用自建密码：
  - Android / iOS：`tauri-plugin-biometric`（BiometricPrompt / LA）
  - macOS：LocalAuthentication
  - Windows：Windows Hello（UserConsentVerifier）
  - Linux：不可用（保持开关关闭）
- 产品面隐藏：多用户管理、服务端安全策略、备份导入导出

## 图标与签名

- 图标：与 Zephyr / Agent 相同的 `ic_launcher` 风标
- Android 发布签名：对齐 Agent  
  - keystore: `platform_assets/android/signing/zephyr-one-release.jks`  
  - 与 Agent 相同 key 材料（`zephyr-agent` alias），**包名仍为 `com.zephyr.one`**，不会覆盖 Agent  
  - `scripts/prepare-android.sh` 注入 `signingConfigs.release`

## Android Node（开箱即用）

构建期把 [node-android-build](https://github.com/Delusions6515/node-android-build) 产物打进：

`app/src/main/jniLibs/<abi>/libnode.so`

系统安装 APK 时解压到 `nativeLibraryDir`，运行时直接 `exec`，**没有**应用内下载/解压 Node 步骤。

## 开发

```bash
cd zephyr_one
npm install
npm run stage:core    # stage 完整 Zephyr → zephyr-core/
npm run test:ci
npm run tauri dev
```

### Android

```bash
npm run stage:core
npx tauri android init   # 首次
npm run android:prepare  # 图标 + JKS 签名 + jniLibs Node
npx tauri android build --apk --target aarch64
```

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
