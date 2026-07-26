#!/usr/bin/env python3
"""Report literal Chinese UI text that is not paired with a data-i18n attribute.

Run one page at a time to keep audit output bounded:
  python3 scripts/i18n-page-audit.py public/app.html
"""
from __future__ import annotations

import re
import sys
from html.parser import HTMLParser
from pathlib import Path

HAN = re.compile(r"[\u4e00-\u9fff]")
ATTRIBUTE_I18N = {
    "title": "data-i18n-title",
    "placeholder": "data-i18n-placeholder",
    "aria-label": "data-i18n-aria-label",
    "value": "data-i18n-value",
}
IGNORED_TAGS = {"script", "style"}


class Audit(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[dict[str, object]] = []
        self.findings: list[tuple[int, str, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line, _ = self.getpos()
        attr = dict(attrs)
        if tag not in IGNORED_TAGS:
            for name, i18n_name in ATTRIBUTE_I18N.items():
                value = attr.get(name) or ""
                if HAN.search(value) and not attr.get(i18n_name):
                    self.findings.append((line, "attribute", name, value.strip()))
        self.stack.append({"tag": tag, "attrs": attr})

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if not text or not HAN.search(text):
            return
        if self.stack and self.stack[-1]["tag"] == "option":
            return
        if any(node["tag"] in IGNORED_TAGS for node in self.stack):
            return
        if self.stack and (((self.stack[-1]["attrs"] or {}).get("data-i18n")) or ((self.stack[-1]["attrs"] or {}).get("data-i18n-html"))):
            return
        line, _ = self.getpos()
        tag = str(self.stack[-1]["tag"]) if self.stack else "document"
        self.findings.append((line, "text", tag, text))


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: i18n-page-audit.py <html-file>")
    path = Path(sys.argv[1])
    parser = Audit()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    for line, kind, target, value in parser.findings:
        print(f"{path}:{line}:{kind}:{target}: {value[:240]}")
    print(f"findings={len(parser.findings)}")
    return 1 if parser.findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
