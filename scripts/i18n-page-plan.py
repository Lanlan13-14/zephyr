#!/usr/bin/env python3
"""List static Chinese UI candidates for one HTML page and catalog coverage.

Usage: python3 scripts/i18n-page-plan.py public/app.html
This is a planning/audit tool; it never writes source files.
"""
from __future__ import annotations

import json
import re
import sys
from collections import OrderedDict
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
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
        self.items: list[tuple[int, str, str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line, _ = self.getpos()
        attr = dict(attrs)
        if tag not in IGNORED_TAGS:
            for name, i18n_name in ATTRIBUTE_I18N.items():
                value = (attr.get(name) or "").strip()
                if HAN.search(value) and not attr.get(i18n_name):
                    self.items.append((line, "attr:" + name, tag, value))
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
        value = " ".join(data.split())
        if not value or not HAN.search(value) or any(node["tag"] in IGNORED_TAGS for node in self.stack):
            return
        if self.stack and (((self.stack[-1]["attrs"] or {}).get("data-i18n")) or ((self.stack[-1]["attrs"] or {}).get("data-i18n-html"))):
            return
        line, _ = self.getpos()
        tag = str(self.stack[-1]["tag"]) if self.stack else "document"
        self.items.append((line, "text", tag, value))


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: i18n-page-plan.py <html-file>")
    path = Path(sys.argv[1])
    zh = json.loads((ROOT / "public/i18n/locales/zh-CN.json").read_text())
    en = json.loads((ROOT / "public/i18n/locales/en.json").read_text())
    parser = Audit()
    parser.feed(path.read_text(encoding="utf-8"))
    parser.close()
    grouped: OrderedDict[str, list[tuple[int, str, str]]] = OrderedDict()
    for line, kind, tag, value in parser.items:
        grouped.setdefault(value, []).append((line, kind, tag))
    covered = 0
    for value, locations in grouped.items():
        line, kind, tag = locations[0]
        status = "COVERED" if value in zh and value in en else "MISSING"
        covered += status == "COVERED"
        more = f" (+{len(locations) - 1})" if len(locations) > 1 else ""
        print(f"{status}\t{line}\t{kind}\t<{tag}>\t{value}{more}")
    print(f"summary unique={len(grouped)} covered={covered} missing={len(grouped) - covered}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
