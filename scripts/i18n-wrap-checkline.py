#!/usr/bin/env python3
"""Wrap unwrapped check-line label text in <span data-i18n>.
For: <label class="check-line"><input ...> 文本</label>
  →  <label class="check-line"><input ...> <span data-i18n="文本">文本</span></label>
"""
import json, re, sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
zh = json.loads(Path('public/i18n/locales/zh-CN.json').read_text(encoding='utf-8'))
keyset = set(zh.keys())

count = 0
def repl(m):
    global count
    pre = m.group(1)  # <label ...><input...>
    raw = m.group(2)
    key = raw.strip()
    if key in keyset:
        count += 1
        return f'{pre} <span data-i18n="{key}">{raw}</span></label>'
    return m.group(0)

# label with check-line class containing input then bare text
text = re.sub(
    r'(<label class="check-line"><input[^>]*>)\s*([^<]*[\u4e00-\u9fff][^<]*?)</label>',
    repl,
    text,
)
p.write_text(text, encoding='utf-8')
print(f'wrapped {count} check-line labels')
