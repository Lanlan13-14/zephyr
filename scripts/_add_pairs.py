#!/usr/bin/env python3
"""Add a batch of zh→en pairs to catalogs, skipping keys that already exist."""
import json, sys
from pathlib import Path

zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))

pairs = {
"填入输入框":"Fill the input box",
"，请强制刷新页面后重试":", please hard-refresh the page and retry",
"，当前页面缺少 media-preview.js":", media-preview.js is missing on this page",
"--- 日志流已连接 ---\n":"--- Log stream connected ---\n",
"\n--- 日志流已结束 ---\n":"\n--- Log stream ended ---\n",
"右键粘贴需要浏览器剪贴板权限或非空文本剪贴板":"Right-click paste requires clipboard permission or non-empty clipboard text",
"已连接":"Connected",
"已断开":"Disconnected",
"错误":"Error",
"连接出错":"Connection error",
"重建连接":"Rebuild connection",
"用户主动断开":"User disconnected",
"连接已被新的会话替换":"Connection replaced by a new session",
"[SSH] 自动重连失败:":"[SSH] Auto-reconnect failed:",
"自动重连失败，请手动点击\"重连\"":"Auto-reconnect failed. Click \"Reconnect\" manually.",
"终端初始化已取消":"Terminal initialization cancelled",
"连接超时":"Connection timed out",
"进程操作已发送":"Process action sent",
"进程操作失败":"Process action failed",
"已恢复会话":"Session resumed",
"对端关闭了连接":"Peer closed the connection",
"连接异常断开":"Connection dropped abnormally",
"会话因空闲超时已关闭":"Session closed due to idle timeout",
"会话已关闭":"Session closed",
"页面卸载":"Page unload",
"容器日志 · ":"Container logs · ",
"文件传输":"File transfer",
"暂无上传或下载任务":"No upload/download tasks",
"暂无容器":"No containers",
"暂无镜像":"No images",
"暂无进程数据":"No process data",
"正在加载服务器实时监控数据...":"Loading real-time server monitor data...",
"搜索中…":"Searching…",
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
