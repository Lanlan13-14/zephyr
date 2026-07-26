#!/usr/bin/env python3
"""Read-only i18n integrity audit for Zephyr frontend sources."""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
EXCLUDED = {"vendor", "editor"}
PAGE_AUDIT_PAGES = ("terminal.html", "telnet-terminal.html", "rdp.html", "index.html", "open.html")


def frontend_files():
    for path in PUBLIC.rglob("*"):
        if path.suffix not in {".html", ".js"} or any(part in EXCLUDED for part in path.parts):
            continue
        yield path


class I18nHtmlAudit(HTMLParser):
    def __init__(self, path: Path):
        super().__init__(convert_charrefs=False)
        self.path = path
        self.stack: list[dict] = []
        self.duplicates: list[tuple[int, str, list[str]]] = []
        self.nested: list[tuple[int, str, str]] = []
        self.keys: list[tuple[int, str, str]] = []

    def handle_starttag(self, tag, attrs):
        line, _ = self.getpos()
        if self.stack:
            for parent in self.stack:
                if parent["i18n"]:
                    parent["has_child"] = True
        names = [name for name, _ in attrs]
        duplicate = sorted(name for name, count in Counter(names).items() if count > 1 and name.startswith("data-i18n"))
        if duplicate:
            self.duplicates.append((line, tag, duplicate))
        i18n_key = next((value for name, value in attrs if name == "data-i18n"), None)
        for name, value in attrs:
            if name.startswith("data-i18n") and value:
                self.keys.append((line, name, value))
        node = {"tag": tag, "line": line, "i18n": i18n_key, "has_child": False}
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                node = self.stack.pop(index)
                if node["i18n"] and node["has_child"]:
                    self.nested.append((node["line"], tag, node["i18n"]))
                return



class PageStaticAudit(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.findings = []

    def handle_starttag(self, tag, attrs):
        line, _ = self.getpos()
        attr = dict(attrs)
        if tag not in {"script", "style"}:
            for name, i18n_name in {"title": "data-i18n-title", "placeholder": "data-i18n-placeholder", "aria-label": "data-i18n-aria-label", "value": "data-i18n-value"}.items():
                value = (attr.get(name) or "").strip()
                if re.search(r"[\u4e00-\u9fff]", value) and not attr.get(i18n_name):
                    self.findings.append((line, "attr", name, value))
        self.stack.append({"tag": tag, "attrs": attr})

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index]["tag"] == tag:
                del self.stack[index:]
                return

    def handle_data(self, data):
        value = " ".join(data.split())
        if not value or not re.search(r"[\u4e00-\u9fff]", value) or not self.stack:
            return
        current = self.stack[-1]
        if current["tag"] in {"script", "style", "option"} or current["attrs"].get("data-i18n") or current["attrs"].get("data-i18n-html"):
            return
        line, _ = self.getpos()
        self.findings.append((line, "text", current["tag"], value))


def page_static_findings(path, text):
    parser = PageStaticAudit()
    parser.feed(text)
    parser.close()
    return parser.findings


def main():
    zh = json.loads((PUBLIC / "i18n/locales/zh-CN.json").read_text())
    en = json.loads((PUBLIC / "i18n/locales/en.json").read_text())
    seen = set()
    duplicate_attrs = []
    nested_i18n = []
    static_page_findings = []

    for path in frontend_files():
        text = path.read_text(errors="replace")
        if path.suffix == ".html":
            parser = I18nHtmlAudit(path)
            parser.feed(text)
            parser.close()
            duplicate_attrs.extend((path, *item) for item in parser.duplicates)
            nested_i18n.extend((path, *item) for item in parser.nested)
            seen.update(key for _, _, key in parser.keys)
            if path.name in PAGE_AUDIT_PAGES:
                static_page_findings.extend((path, line, kind, target, value) for line, kind, target, value in page_static_findings(path, text))
        for match in re.finditer(r"\bt\(\s*(['\"])(.*?)\1", text, flags=re.DOTALL):
            key = match.group(2)
            if "\\" not in key:
                seen.add(key)

    actual_keys = {key for key in seen if key not in {"key", "k"}}
    missing_zh = sorted(actual_keys - set(zh))
    missing_en = sorted(actual_keys - set(en))
    identity_en = sorted(key for key in actual_keys & set(en) if en[key] == key and re.search(r"[\u4e00-\u9fff]", key))
    placeholders = lambda value: set(re.findall(r"(?<!\{)\{([A-Za-z0-9_]+)\}(?!\})", str(value)))
    placeholders_mismatch = sorted(
        key for key in set(zh) & set(en) if placeholders(zh[key]) != placeholders(en[key])
    )

    print(f"catalog zh={len(zh)} en={len(en)} referenced={len(actual_keys)}")
    print(f"missing zh={len(missing_zh)} en={len(missing_en)} identity en={len(identity_en)}")
    for heading, values in [
        ("MISSING_ZH", missing_zh),
        ("MISSING_EN", missing_en),
        ("IDENTITY_EN", identity_en),
        ("PLACEHOLDER_MISMATCH", placeholders_mismatch),
    ]:
        if values:
            print(f"{heading}:")
            for value in values:
                print(f"  {value}")
    print(f"duplicate_i18n_attrs={len(duplicate_attrs)} nested_data_i18n={len(nested_i18n)} static_page_findings={len(static_page_findings)}")
    for path, line, tag, names in duplicate_attrs:
        print(f"DUPLICATE {path.relative_to(ROOT)}:{line} <{tag}> {','.join(names)}")
    for path, line, tag, key in nested_i18n:
        print(f"NESTED {path.relative_to(ROOT)}:{line} <{tag}> {key}")
    for path, line, kind, target, value in static_page_findings:
        print(f"STATIC {path.relative_to(ROOT)}:{line} {kind}:{target} {value}")
    if missing_zh or missing_en or identity_en or placeholders_mismatch or duplicate_attrs or nested_i18n or static_page_findings:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
