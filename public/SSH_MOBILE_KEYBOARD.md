# SSH 移动端软键盘调用逻辑

## 问题（旧实现）

1. 终端区域 pointerdown **切换**开/关：点一下开、再点一下关，和选区/滚动竞态严重。
2. `enableMobileStableInputMode` 默认 `mobileKeyboardUserControlled = true`，等同「永远想开着」。
3. 有 `.cmd-keyboard-btn` 样式却被 `display:none !important` 干掉，且 HTML 无按钮。
4. 物理键盘高度（visualViewport）与用户意图混在同一套 flag 里，系统返回键收起后状态半开。
5. stable 路径父页不缩高 → 键盘盖住终端；关闭路径双轨 → ~1s 自收 / 画面悬半空。

## 设计（Termius 级意图模型 + 方案 A 整页抬升）

```
用户意图 intent: open | closed
物理状态 physical: visualViewport / virtualKeyboard inset
抬升模式 liftMode: workspace | none
```

| 入口 | 行为 | liftMode |
|------|------|----------|
| 终端正文单击 | **只 open / retain**，绝不 dismiss | `workspace`（整页抬到键盘上） |
| 命令行旁键盘按钮 | **toggle** open↔closed | `workspace` |
| 顶部 `#cmdInput` 聚焦 | open，**画面不抬** | `none` |
| 系统返回/手势收键盘 | viewport inset→0 且过 open-hold → intent closed | — |
| 父页 `reset-mobile-keyboard` | force close + 原子清零 | — |
| 辅助键 Ctrl/Esc/方向 | 仅 retain focus | 保持 |
| 滚动 / 长按选区 / 双击选词 | 禁止 open | — |

### 方案 A 抬升

- `liftMode=workspace` 且 physical open：父页把 `.terminal-workspace` 高度裁到 **键盘顶以上**（`usableHeight`），并加 `terminal-keyboard-lift`（非全屏时 shell `translateY(-inset)`）。
- `liftMode=none`（命令栏）：父页保持全高，不 shift。
- 关闭：iframe `assertKeyboardLayoutSettled` + 父页 `resetTerminalWorkspaceKeyboard`，禁止半空残留。
- open-hold（~1.4s）内 physical 抖动不得把 intent 打成 closed。

## 文件

- `public/ssh-mobile-keyboard.js` — 意图控制器 + liftMode
- `public/terminal.js` — IME proxy / viewport / 按钮 / 触摸接线 / assert settled
- `public/app.js` — 父页 workspace 裁高 / cmd 例外 / 原子 reset
- `public/style.css` — `terminal-keyboard-lift` + editor header 横滑
- `public/editor/zephyr-editor.css` — 移动端 header-actions / toolbar 横滑
- `public/terminal.html` — `#cmdKeyboardBtn` + cache-bust
- `tests/ssh-mobile-keyboard.test.mjs` — 控制器 + 接线契约
- `tests/fm-editor-toolbar-scroll-contract.test.mjs` — 编辑器顶栏横滑

## 关键 API

```js
sshSoftKeyboard.open(reason, { liftMode: 'workspace' | 'none' })
sshSoftKeyboard.close(reason, { force })
sshSoftKeyboard.toggle(reason)
sshSoftKeyboard.handleTerminalTap(reason) // body → workspace
sshSoftKeyboard.retainForChrome(reason)   // aux
sshSoftKeyboard.getLiftMode()
sshSoftKeyboard.syncFromViewport(reason)
```

parent `keyboard-metrics` 字段：`liftMode`, `inputSource` (`cmd` | `terminal-ime`)。

IME 仍走隐藏 `#mobileTerminalImeProxy` textarea。WTerm grid 在键盘开合时冻结，不 resize 行列。

cache-bust: `20260720-ssh-kb-lift1`
