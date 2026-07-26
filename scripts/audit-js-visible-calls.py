#!/usr/bin/env python3
"""Find untranslated Chinese literals passed to common user-visible JS APIs."""
from __future__ import annotations

import re
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit('usage: audit-js-visible-calls.py <javascript-file>')
path = Path(sys.argv[1])
text = path.read_text(encoding='utf-8')
HAN = r'[\u3400-\u9fff]'
patterns = [
    re.compile(r"\b(?:toast|confirm|alert|prompt|showError|set[A-Za-z0-9]*Status|notify)\s*\(\s*(?!t\()(?P<q>['\"`])(?P<v>(?:\\.|(?!\1).)*" + HAN + r"(?:\\.|(?!\1).)*)\1", re.DOTALL),
    re.compile(r"\b(?:textContent|innerText|title|placeholder|ariaLabel)\s*=\s*(?!t\()(?P<q>['\"`])(?P<v>(?:\\.|(?!\1).)*" + HAN + r"(?:\\.|(?!\1).)*)\1", re.DOTALL),
    re.compile(r"\b(?:message|title|body|confirmLabel|cancelLabel)\s*:\s*(?!t\()(?P<q>['\"`])(?P<v>(?:\\.|(?!\1).)*" + HAN + r"(?:\\.|(?!\1).)*)\1", re.DOTALL),
    re.compile(r"(?:throw\s+new\s+Error|Promise\.reject)\s*\(\s*(?!t\()(?P<q>['\"`])(?P<v>(?:\\.|(?!\1).)*" + HAN + r"(?:\\.|(?!\1).)*)\1", re.DOTALL),
]
items = []
for pattern in patterns:
    for match in pattern.finditer(text):
        line = text.count('\n', 0, match.start()) + 1
        items.append((line, ' '.join(match.group('v').split())[:280]))
visible = sorted({(line, value) for line, value in items if "t('" not in value and 't("' not in value})
for line, value in visible:
    print(f'{path}:{line}: {value}')
print(f'findings={len(visible)}')
raise SystemExit(1 if visible else 0)
