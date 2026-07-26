#!/usr/bin/env python3
"""Add zh→en pairs for rdp-wasm-client.js remaining literals."""
import json
from pathlib import Path

zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))

pairs = {
"RDP 已连接":"RDP connected",
"连接中断":"Connection interrupted",
"已收到远程剪贴板":"Received remote clipboard",
"(未知)":"(unknown)",
"不是来自受信任的认证机构":"is not from a trusted authority",
"正在获取 RDP 凭据...":"Fetching RDP credentials...",
"正在验证远程证书...":"Verifying remote certificate...",
"已取消连接":"Connection cancelled",
"正在连接 RDP...":"Connecting to RDP...",
"已断开 RDP 连接":"RDP connection closed",
"自动重连失败，请手动点击\"重连\"":"Auto-reconnect failed. Click \"Reconnect\" manually.",
"重连失败":"Reconnect failed",
"正在应用画质设置...":"Applying quality settings...",
"正在应用帧率设置...":"Applying frame-rate settings...",
"正在应用分辨率设置...":"Applying resolution settings...",
"原始":"Original",
"填充":"Fill",
"RDP Worker 未就绪":"RDP Worker not ready",
"WASM 未就绪":"WASM not ready",
"失败:":"Failed:",
"个文件":"files",
"个文件...":"files...",
"移除":"Remove",
"下载":"Download",
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
