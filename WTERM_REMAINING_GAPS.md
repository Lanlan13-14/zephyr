# WTerm 仍不如 xterm.js 的地方

日期：2026-07-20  
分支：`wterm-vendor`  
基线：已完成 vendoring v0.3.0 + 源码层 P0–P2 + 服务端分页历史 + 图形/Canvas/剩余 VT

本文只记录**仍然不如 xterm.js / 仍未做完**的部分，方便下次接着写。  
已完成项不在此重复。

## 明确边界（不是漏做，是刻意未做成 xterm 全量）

### 1. 完整 WebGL 渲染后端
- 现有：DOM renderer（默认）+ 可选 CanvasRenderer
- 没有：xterm.js 那种 WebGL addon 级字符图集、glyph atlas、GPU 批量绘制
- 影响：超高吞吐、超大滚动历史实时重绘时，DOM/Canvas 仍可能更吃 CPU
- 下次方向：独立 `webgl-renderer.ts`，复用现有 Cell/bridge，不替换 DOM 作为默认

### 2. 图形平面容量有界
- 现有：固定池 Sixel + Kitty Graphics
  - 最多约 2 张图
  - 单图约 400×300
  - WASM 图形相关体积约 2MB 级
- 没有：无限帧缓冲、动画/视频级连续帧、超大截图原尺寸
- 影响：`lsix`、小图、静态预览可用；大图/连环动画会截断或复用旧槽
- 下次方向：可配置池大小；超大图降采样；可选 OffscreenCanvas/Worker 解码

### 3. iTerm2 私有协议未做全集
- 现有：OSC 8/12/52、Kitty keyboard/graphics、XTGETTCAP 子集
- 没有：OSC 1337 文件传输/标记、完整 iTerm2 通知/背景图控制
- 影响：依赖 iTerm2 专有扩展的工具链不会完整工作
- 下次方向：按实际用户工具白名单逐个加，不要盲目全收

### 4. 窗口操作 / winops UI
- 现有：CSI `t` 基本忽略，不崩溃
- 没有：标题栈之外的完整窗口尺寸协商 UI、最大化/全屏请求落地
- 影响：少数 TUI 的“调整窗口”请求无效果
- 下次方向：把需要的 winops 映射到 Zephyr 标签/布局 API，而不是浏览器 window

### 5. 平滑滚动动画
- 现有：逻辑滚动正确，瞬时定位
- 没有：xterm 风格平滑 scroll animation / scroll overlay 动量
- 影响：观感，不直接影响正确性
- 下次方向：可放 Zephyr motion 层，不要塞进 VT 核心

## 协议/语义上仍可继续补的点

### 6. 鼠标 highlight tracking 仍是简化实现
- DECSET 1001 目前按普通 button-event 处理
- 没有完整 xterm highlight tracking 状态机
- 下次：若有实际应用依赖，再单独做

### 7. XTGETTCAP 能力表是实用子集
- 已有：TN/Co/RGB 及常见 cap
- 不是 ncurses 完整 terminfo 数据库
- 下次：按失败探针日志追加，不要一次灌全表

### 8. Kitty keyboard 已覆盖主路径，但不是每个冷门媒体键都验过
- 主功能键、方向键、修饰键、release/repeat、push/pop 已做
- 冷门 media/IME 组合仍可能要按真机补
- 下次：用实际编辑器（helix/nvim）做键位矩阵

### 9. Canvas 后端的选择/链接体验弱于 DOM
- Canvas 适合高吞吐
- 文本选择、自动 URL、远程历史页仍以 DOM 路径最完整
- 下次：Canvas 上补 hit-testing selection，或继续 DOM 默认 + Canvas 可选

### 10. 搜索 API 基于已渲染 DOM 文本
- `findMatches` / `selectMatch` 搜的是当前渲染文本
- 不是服务端全量历史全文检索
- 下次：可把 remote history pages + journal 做成统一 search index

## 架构层已做对、但还能增强

### 11. 服务端分页历史
- 已完成分层：WASM 1000 行实时窗口 + 服务端 journal + 逻辑行分页
- 仍可增强：
  - 跨设备续看 UI
  - 历史导出/分享
  - 更细的用户配额管理界面
  - journal 压缩归档到对象存储

### 12. 构建体积
- 引入图形平面后 WASM 明显变大（有界池后约 2MB 级）
- 下次：feature flag 裁剪 graphics；按需加载图像解码模块

## 建议的下次开工顺序

1. **真机验收清单**  
   vim/nvim、tmux、htop、fzf、lsix、kitty icat、中文输入、手机软键盘
2. **WebGL renderer 设计稿**  
   先 ABI/字形缓存，不先改默认后端
3. **图形池可配置**  
   设置项控制 max images / max pixels
4. **远程历史搜索**  
   基于 `.lines.ndjson` 的服务端 search API
5. **按需补 XTGETTCAP / iTerm2 私有项**

## 不要再走的弯路

- 不要再把长期历史塞回 WASM 静态大数组
- 不要再在 `terminal.js` 外层叠第三套 scroll 状态机
- 不要用 CSS `filter: invert()` 冒充 DECSET 5
- 不要为了“像 xterm”无界放大 Sixel 缓冲把移动端内存打爆
- 不要在超时后连续叠加 SSH/全量测试；单动作、单超时、先回收

## 当前验证基线

- `tests/wterm-*.test.mjs`：46/46
- 全量 Node：308/310  
  - 仅 2 个预存 RDP pipeline 契约失败，与 wterm 无关
- 分支：`wterm-vendor`
