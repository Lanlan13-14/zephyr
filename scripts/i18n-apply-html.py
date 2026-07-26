#!/usr/bin/env python3
"""
Apply data-i18n attributes to Chinese UI strings inside a given HTML section.
Usage: python3 scripts/i18n-apply-html.py <file> <start_marker> <end_marker>
Reads existing catalog keys and only adds data-i18n when the key exists.
"""
import json, re, sys
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else 'public/app.html'
start = sys.argv[2] if len(sys.argv) > 2 else None
end = sys.argv[3] if len(sys.argv) > 3 else None

text = Path(root).read_text(encoding='utf-8')
# Load keys from zh-CN.json as the authoritative key set
zh = json.loads(Path('public/i18n/locales/zh-CN.json').read_text(encoding='utf-8'))
keyset = set(zh.keys())

if start and end:
    si = text.find(start)
    ei = text.find(end, si + 1) if si >= 0 else -1
    if si < 0 or ei < 0:
        print('markers not found', si, ei); sys.exit(1)
    head, body, tail = text[:si], text[si:ei], text[ei:]
else:
    head, body, tail = '', text, ''

def esc(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')

# 1. text nodes: >中文<
def repl_text(m):
    s = m.group(1)
    stripped = s.strip()
    if stripped in keyset:
        return f'>{stripped}<data-i18n-applied>'
    return m.group(0)

# We'll do it differently: walk and replace only the first occurrence per line
# to avoid clobbering. Actually simpler: for each key, find >key< in body (not already tagged)
# and wrap the element's preceding tag with data-i18n.
# But that's fragile. Better: regex for tag boundaries.

# Approach: find <tag ...>key</tag> where key is in keyset, inject data-i18n="key" into tag.
def inject_text_attr(match):
    full = match.group(0)
    tag = match.group(1)
    attrs = match.group(2) or ''
    content = match.group(3)
    key = content.strip()
    if key not in keyset:
        return full
    if 'data-i18n=' in attrs:
        return full
    return f'<{tag}{attrs} data-i18n="{esc(key)}">{content}</{tag}>'

# Match <tag attrs>content</tag> where content is a known Chinese key (no nested tags)
body = re.sub(
    r'<([a-zA-Z][\w-]*)(\s[^>]*?)?>([^<>]*[\u4e00-\u9fff][^<>]*?)</\1>',
    inject_text_attr,
    body,
)

# 2. placeholder="中文"
def inject_attr(attr_name):
    def repl(m):
        val = m.group(1)
        key = val.strip()
        if key in keyset:
            return f'{attr_name}="{esc(val)}" data-i18n-{attr_name}="{esc(key)}"'
        return m.group(0)
    return repl

# avoid double-tagging
def inject_attr_safe(attr_name, body):
    pattern = rf'(?<!data-i18n-){attr_name}="([^"]*[\u4e00-\u9fff][^"]*)"'
    def repl(m):
        full = m.group(0)
        if 'data-i18n-' in full:
            return full
        val = m.group(1)
        key = val.strip()
        if key in keyset:
            return f'{attr_name}="{esc(val)}" data-i18n-{attr_name}="{esc(key)}"'
        return full
    # need to check preceding text for "data-i18n-"
    out = []
    last = 0
    for m in re.finditer(rf'{attr_name}="([^"]*[\u4e00-\u9fff][^"]*)"', body):
        out.append(body[last:m.start()])
        preceding = body[max(0, m.start()-12):m.start()]
        val = m.group(1)
        key = val.strip()
        if 'data-i18n-' not in preceding and key in keyset:
            out.append(f'{attr_name}="{esc(val)}" data-i18n-{attr_name}="{esc(key)}"')
        else:
            out.append(m.group(0))
        last = m.end()
    out.append(body[last:])
    return ''.join(out)

for a in ['placeholder', 'title', 'aria-label']:
    body = inject_attr_safe(a, body)

Path(root).write_text(head + body + tail, encoding='utf-8')
print('done')
