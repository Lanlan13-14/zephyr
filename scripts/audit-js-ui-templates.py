#!/usr/bin/env python3
"""Find literal Chinese UI nodes/attributes inside JavaScript HTML templates."""
from __future__ import annotations

import re
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('usage: audit-js-ui-templates.py <javascript-file>')
path = Path(sys.argv[1])
patterns = [
    re.compile(r'>[^<>$`]*[\u4e00-\u9fff][^<>$`]*<'),
    re.compile(r'(?:title|aria-label|placeholder)="[^"]*[\u4e00-\u9fff][^"]*"'),
]
count = 0
for line_no, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
    for pattern in patterns:
        for match in pattern.finditer(line):
            value = match.group(0)
            if '${t(' in value or "t('" in value or 't("' in value or 'data-i18n' in value:
                continue
            print(f'{path}:{line_no}: {value[:300]}')
            count += 1
print(f'findings={count}')
raise SystemExit(1 if count else 0)
