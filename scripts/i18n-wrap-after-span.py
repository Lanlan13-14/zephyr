#!/usr/bin/env python3
"""Wrap trailing text after a self-closing/inline element in a <span data-i18n>.
For: <button ...><span ...></span>中文</button>
  →  <button ...><span ...></span><span data-i18n="中文">中文</span></button>
"""
import json, re, sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
zh = json.loads(Path('public/i18n/locales/zh-CN.json').read_text(encoding='utf-8'))
keyset = set(zh.keys())
count = 0

# match: </span> followed by Chinese text, then </button> or </label>
def repl(m):
    global count
    pre = m.group(1)
    raw = m.group(2)
    key = raw.strip()
    if key in keyset:
        count += 1
        return f'{pre}<span data-i18n="{key}">{raw}</span>'
    return m.group(0)

text = re.sub(
    r'(</span>)([^<>]*[\u4e00-\u9fff][^<>]*?)(?=</)',
    repl,
    text,
)
p.write_text(text, encoding='utf-8')
print(f'wrapped {count} trailing texts after spans')
