#!/usr/bin/env python3
"""Add zh→en pairs for notes.js remaining literals."""
import json
from pathlib import Path

zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))

pairs = {
"请先选择一条笔记":"Select a note first",
"只有笔记所有者可以修改共享设置":"Only the note owner can change sharing",
"已共享给所有用户":"Shared with all users",
"已共享给管理员":"Shared with admins",
"已设为私有":"Set to private",
"无匹配连接":"No matching connection",
"关联连接已保存":"Linked connections saved",
"笔记标题":"Note title",
"已重命名":"Renamed",
"移动分组":"Move to group",
"留空则移到未分组":"Leave empty for Ungrouped",
"已移动":"Moved",
"已载入服务器版本":"Loaded server version",
"已保留我的版本":"Kept my version",
"请在应用主界面打开此链接":"Open this link in the main app",
"例如 runbook":"e.g. runbook",
"使用 / 表示层级，例如 ops/runbooks。留空表示未分组。":"Use / for hierarchy, e.g. ops/runbooks. Empty means Ungrouped.",
"使用 / 表示层级，例如 ops/runbooks":"Use / for hierarchy, e.g. ops/runbooks",
"已导入":"Imported",
"请先选择笔记":"Select a note first",
"新建分组":"New group",
"创建并写笔记":"Create and write note",
"输入分组名，支持 /":"Enter a group name; / supported",
"分组名不能为空":"Group name is required",
"创建分组失败":"Failed to create group",
"移动到…":"Move to…",
"新建子分组":"New subgroup",
"标签名":"Tag name",
"输入标签名":"Enter a tag name",
"标签不能为空":"Tag cannot be empty",
"标签已存在":"Tag already exists",
"添加失败":"Add failed",
"删除标签":"Delete tag",
"确认删除标签？":"Delete this tag?",
"标签已删除":"Tag deleted",
"清除筛选":"Clear filter",
"全部笔记":"All notes",
"按修改时间排序":"Sort by modified time",
"按创建时间排序":"Sort by created time",
"切换排序":"Toggle sort",
"展开全部":"Expand all",
"收起全部":"Collapse all",
"字数 {count}":"{count} words",
"字符 {count}":"{count} chars",
"最后修改 {time}":"Last modified {time}",
"创建于 {time}":"Created {time}",
"由 {user} 共享":"Shared by {user}",
"我":"Me",
"导出 Markdown":"Export Markdown",
"导入成功":"Imported successfully",
"导入失败":"Import failed",
"导出失败":"Export failed",
"不能删除默认分组":"Cannot delete the default group",
}

added = 0
for k, v in pairs.items():
    if k not in zh:
        zh[k] = k
        en[k] = v
        added += 1

zh_path.write_text(json.dumps(zh, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
en_path.write_text(json.dumps(en, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(f'added {added}, total {len(zh)}')
