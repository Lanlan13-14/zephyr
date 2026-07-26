#!/usr/bin/env python3
import json
from pathlib import Path
zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))
pairs = {"已断开":"Disconnected"}
for k, v in pairs.items():
    if k not in zh:
        zh[k] = k
        en[k] = v
zh_path.write_text(json.dumps(zh, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
en_path.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'total {len(zh)}')
