# SSH 移动端软键盘调用逻辑

## 问题（旧实现）

1. 终端区域 pointerdown **切换**开/关：点一下开、再点一下关，和选区/滚动竞态严重。
2. `enableMobileStableInputMode` 默认 `mobileKeyboardUserControlled = true`，等同「永远想开着」。
3. 有 `.cmd-keyboard-btn` 样式却被 `display:none !important` 干掉，且 HTML 无按钮。
4. 物理键盘高度（visualViewport）与用户意图混在同一套 flag 里，系统返回键收起后状态半开。

## 设计（Termius 级意图模型）

```
用户意图 intent: open | closed
物理状态 physical: visualViewport / virtualKeyboard inset
```

| 入口 | 行为 |
|------|------|
| 终端正文单击 | **只 open / retain**，绝不 dismiss |
| 命令行旁键盘按钮 | **toggle** open↔closed |
| 系统返回/手势收键盘 | viewport inset→0 ⇒ intent 跟随 closed |
| 父页 `reset-mobile-keyboard` | force close |
| 辅助键 Ctrl/Esc/方向 | 仅 retain focus，不抢焦点、不开新键盘 |
| 滚动 / 长按选区 / 双击选词 | 禁止 open |

## 文件

- `public/ssh-mobile-keyboard.js` — 纯意图控制器
- `public/terminal.js` — IME proxy / viewport / 按钮 / 触摸接线
- `public/terminal.html` — `#cmdKeyboardBtn`
- `public/style.css` — 移动端显示按钮
- `tests/ssh-mobile-keyboard.test.mjs` — 10 项契约

## 关键 API

```js
sshSoftKeyboard.open(reason)
sshSoftKeyboard.close(reason, { force })
sshSoftKeyboard.toggle(reason)
sshSoftKeyboard.handleTerminalTap(reason) // body
sshSoftKeyboard.retainForChrome(reason)   // aux
sshSoftKeyboard.syncFromViewport(reason)
```

IME 仍走隐藏 `#mobileTerminalImeProxy` textarea（composition / beforeinput / 控制键），键盘高度仍只做 bottom clipping（mobile stable），不 resize WTerm grid。
