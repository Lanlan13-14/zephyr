# Zephyr —— 新一代智能远程管理生态

Zephyr 是一套面向开发者、运维人员和企业用户打造的现代化远程管理生态系统。

它不只是一个 SSH/RDP 客户端，而是通过 Zephyr Server、Zephyr One、Zephyr Agent 与 Zephyr Storage，把设备管理、远程控制、数据同步与安全存储整合为一个统一整体，让用户能够在任何设备、任何地点安全地管理自己的数字资产。

---

## Zephyr Server —— 统一控制中心

Zephyr Server 是整个生态的核心，以容器化方式运行于你的服务器。

它为用户提供：

- Web 管理控制台
- 用户与权限管理
- 设备与远程会话管理
- 配置同步与数据中心服务
- 数据备份与恢复

通过 Zephyr Server，你可以集中管理所有服务器、设备和远程环境。数据、密钥和策略都保存在你自己的机器上。

---

## Zephyr One —— 为桌面与移动端打造的原生体验

Zephyr One 是 Zephyr 面向具体设备形态的原生客户端。Web 体验不大改，主要功能用原生方式接管，让 Web 变得更好用。

### 桌面端 · Windows / macOS / Linux

桌面 One 在本机运行完整 Zephyr：仪表盘、SSH、RDP、VNC、笔记、AI、Client Token 全部在本地，不走远程 Web。

它把浏览器够不到的东西交给系统：

- 本地拉起核心，不需要先部署服务器
- 可选系统解锁：Windows Hello、Touch ID、设备 PIN
- 原生窗口、托盘、启动项与系统生命周期
- 监听只对本机开放，没有应用自建密码墙

打开就是完整 Zephyr，只是更像一个真正的桌面应用。

### 移动端 · Android / iOS

移动 One 采用原生技术开发：

- Android：Kotlin + Jetpack Compose
- iOS：Swift + SwiftUI

针对触屏设备重新设计：

- SSH 终端体验
- RDP 远程桌面
- 触控操作与外接键盘鼠标
- 触控笔支持
- 移动端快捷操作

手机应急、平板并排，让你可以像使用本地电脑一样管理远程设备。

---

## Zephyr Agent —— 连接现实设备的桥梁

Zephyr Agent 部署在被管理设备上，用于扩展 Web 环境无法直接访问的系统能力。

它可以运行于：

- Linux 服务器
- Windows 主机
- NAS 设备
- 云服务器

提供：

- 系统状态监控
- 文件管理
- 命令执行
- 服务控制
- 本地能力调用

让 Zephyr 从「网页控制台」升级为真正的设备管理平台。

---

## Zephyr Sync —— 你的运维环境随身携带

Zephyr 提供类似云同步的用户级数据同步能力。

同步内容包括：

- 服务器连接配置
- SSH 密钥
- RDP 配置
- 快捷命令
- 个性化设置
- 设备列表

所有设备之间可以安全同步：

**Zephyr One ↕ Zephyr Server ↕ Zephyr Web**

无论更换设备还是切换平台，都可以快速恢复自己的工作环境。

---

## Zephyr Storage —— 安全的数据保险箱

Zephyr 支持将用户数据进行加密备份，并通过 WebDAV 等协议连接外部存储。

支持：

- 私有 NAS
- WebDAV 存储
- 云对象存储

采用现代密码技术保护数据：

- AES-256-GCM 数据加密
- 密钥隔离
- 面向未来的抗量子密码体系

用户的数据始终由用户掌控。

---

## Zephyr 的核心理念

**连接设备，而不是限制设备。**

Zephyr 将：

- 远程终端
- 服务器管理
- 设备代理
- 云同步
- 安全存储

整合为一个统一生态。

无论是在手机上快速处理服务器故障，还是在浏览器中管理大量设备，Zephyr 都希望提供一种更自由、更安全、更现代的远程管理体验。

---

**Zephyr**

Your infrastructure, everywhere.

你的基础设施，随时随地掌控。