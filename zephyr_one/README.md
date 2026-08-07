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

系统安装 APK 时把它部署到 `nativeLibraryDir`，运行时直接 `exec`，**没有**应用内下载/解压 Node 步骤。

## Android 核心资源（打开即用）

- 构建期：esbuild 把服务端和依赖打成 `assets/zephyr-core.cjs`
- 运行时：Rust 从 APK 直接把这一入口流式送入 Node 标准输入，不写出核心文件
- `public/` 保留为 APK 内的 `assets/zephyr-public/`，Node 按请求直接读取 APK ZIP 条目
- 首次打开和版本更新都不再把核心展开到 `filesDir`

## 版本号

发布 tag `one-v0.1.7` 必须映射到应用版本 `0.1.7`（Settings → 应用信息 / `get_app_version`）：

```bash
python3 scripts/set-version.py one-v0.1.7
# 写入 package.json / src-tauri/Cargo.toml / src-tauri/tauri.conf.json
# CI 各平台 build job 在编译前自动执行；Android 同步写 versionName/versionCode
```

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
npm run android:prepare  # 图标 + JKS 签名 + jniLibs Node + 免解压内置核心
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
    set-version.py
    stamp-android-icons.py
    fetch-node-android.sh
```
