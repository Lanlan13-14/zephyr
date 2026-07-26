#!/usr/bin/env python3
"""Add zh→en pairs for app.js remaining template literals."""
import json
from pathlib import Path

zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))

pairs = {
"隐藏预览":"Hide preview",
"显示预览":"Show preview",
"AI 代操作页面":"AI browser automation",
"AI 代操作页面 · {tool} · {session} · {time}":"AI browser automation · {tool} · {session} · {time}",
"发送中...":"Sending...",
"初始化失败：{message}":"Init failed: {message}",
"请求失败：{message}":"Request failed: {message}",
"前端错误：{message}":"Frontend error: {message}",
"前端异步错误：{message}":"Frontend async error: {message}",
"连接已删除":"Connection deleted",
"代理已删除":"Proxy deleted",
"SSH 密钥已删除":"SSH key deleted",
"代码片段已从服务端删除":"Snippet deleted from server",
"密码已更新":"Password updated",
"资料已保存":"Profile saved",
"TOTP 已开启":"TOTP enabled",
"TOTP 已关闭":"TOTP disabled",
"已解除封禁":"Unbanned",
"活动日志已清理":"Activity logs cleared",
"登录事件已清理":"Login events cleared",
"暂无封禁 IP":"No banned IPs",
"暂无登录事件":"No login events",
"失败 {count}":"Failed {count}",
"解封 {time}":"Unban at {time}",
"成功":"Success",
"失败":"Failed",
"执行中...":"Running...",
"已复制":"Copied",
"已保存":"Saved",
"保存失败":"Save failed",
"发送":"Send",
"停止":"Stop",
"压缩摘要":"Compress summary",
"清空对话":"Clear chat",
"导出":"Export",
"设置":"Settings",
"确定要清空当前对话？":"Clear the current conversation?",
"确定要压缩当前对话的历史？":"Compress this conversation's history?",
"对话已清空":"Conversation cleared",
"历史已压缩":"History compressed",
"AI 回复已中断。":"AI reply interrupted.",
"AI 运行失败":"AI run failed",
"正在思考...":"Thinking...",
"正在执行...":"Executing...",
"正在生成...":"Generating...",
"等待确认...":"Waiting for confirmation...",
"已停止":"Stopped",
"已完成":"Completed",
"计划已更新":"Plan updated",
"计划已暂停":"Plan paused",
"计划已继续":"Plan resumed",
"计划已完成":"Plan completed",
"计划已失败":"Plan failed",
"任务计划":"Task plan",
"暂无任务计划。AI 可通过 plan_task 工具为复杂任务创建计划，并持续更新步骤状态。":"No task plans. AI can create plans via plan_task and keep step status updated.",
"执行中":"Running",
"完成":"Done",
"暂停":"Pause",
"继续":"Continue",
}

added = 0
for k, v in pairs.items():
    if k not in zh:
        zh[k] = k
        en[k] = v
        added += 1

zh_path.write_text(json.dumps(zh, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
en_path.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'added {added}, total {len(zh)}')
