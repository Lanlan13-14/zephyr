#!/usr/bin/env python3
"""
Wrap standalone Chinese single-quoted string literals into t() calls.
Skips literals already inside t(...).
Handles toast(...), confirm(...), alert(...), return ... etc.
"""
import json, re, sys
from pathlib import Path

p = Path(sys.argv[1])
text = p.read_text(encoding='utf-8')
zh = json.loads(Path('public/i18n/locales/zh-CN.json').read_text(encoding='utf-8'))
keyset = set(zh.keys())

# functions that already call t() — we should wrap their literal args
# but functions that ARE t() — skip
CALL_PREFIXES = ('toast(', 'confirm(', 'alert(', 'showError(', 'throw new Error(')

keys = sorted([k for k in keyset if re.search(r'[\u4e00-\u9fff]', k) and '${' not in k and '\\' not in k and '\n' not in k and '<' not in k and '>' not in k], key=len, reverse=True)

count = 0
for key in keys:
    pattern = re.compile(r"(?<![A-Za-z0-9_])'(" + re.escape(key) + r")'(?![A-Za-z0-9_])")
    new = []
    last = 0
    for m in pattern.finditer(text):
        start = m.start()
        # check preceding 2-6 chars: is this already a t('...') argument?
        preceding_2 = text[max(0, start - 2):start]
        preceding_6 = text[max(0, start - 6):start]
        if preceding_2.endswith('t(') and not any(pre in preceding_6 for pre in CALL_PREFIXES):
            # already inside t(...)
            new.append(text[last:m.end()])
            last = m.end()
            continue
        new.append(text[last:m.start()])
        new.append("t('" + m.group(1) + "')")
        last = m.end()
        count += 1
    new.append(text[last:])
    text = ''.join(new)

p.write_text(text, encoding='utf-8')
print(f'wrapped {count} literals into t()')
