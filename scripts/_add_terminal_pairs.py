#!/usr/bin/env python3
"""Add zh→en pairs for terminal.js remaining template literals."""
import json
from pathlib import Path

zh_path = Path('public/i18n/locales/zh-CN.json')
en_path = Path('public/i18n/locales/en.json')
zh = json.loads(zh_path.read_text(encoding='utf-8'))
en = json.loads(en_path.read_text(encoding='utf-8'))

pairs = {
"关闭":"Close",
"覆盖":"Overwrite",
"删除目标同名文件/文件夹后粘贴":"Delete same-name target files/folders then paste",
"保留目标已有项目，只粘贴未冲突项目":"Keep existing target items; only paste non-conflicting ones",
"兼容":"Compatible",
"自动追加\"-复制\"\"-复制2\"…，可重复粘贴":"Auto-append \"-copy\" \"-copy2\"…, can paste repeatedly",
"记住选择（仅本次网页连接有效）":"Remember choice (valid for this web session only)",
"保存并关闭":"Save and close",
"先保存当前内容，然后关闭编辑窗口":"Save current content then close the editor window",
"放弃修改":"Discard changes",
"不保存本次修改，直接关闭窗口":"Discard this edit and close the window",
"取消关闭":"Cancel close",
"返回编辑器继续编辑":"Return to the editor",
"覆盖远端":"Overwrite remote",
"用当前编辑器内容强制写入":"Force-write current editor content",
"重新加载远端":"Reload remote",
"丢弃本地未保存修改":"Discard local unsaved changes",
"已扫描 {count} 个文件":"Scanned {count} files",
"确定":"OK",
"本机":"Local",
"远程":"Remote",
"本机 → 远程":"Local → Remote",
"远程 → 本机":"Remote → Local",
"剪切":"Cut",
"粘贴":"Paste",
"重命名":"Rename",
"下载":"Download",
"属性":"Properties",
"压缩":"Compress",
"解压":"Extract",
"打开":"Open",
"编辑":"Edit",
"选择":"Select",
"全选":"Select all",
"取消":"Cancel",
"删除":"Delete",
"移动":"Move",
"上传":"Upload",
"目录":"Directory",
"文件":"File",
"文件夹":"Folder",
"名称":"Name",
"大小":"Size",
"修改时间":"Modified",
"权限":"Permissions",
"所有者":"Owner",
"分组":"Group",
"路径":"Path",
"当前路径":"Current path",
"总大小":"Total size",
"已选择 {count} 项":"Selected {count} items",
"新建文件夹":"New folder",
"新建文件":"New file",
"上传文件":"Upload file",
"打包下载":"Download as archive",
"搜索":"Search",
"刷新":"Refresh",
"返回上级":"Go up",
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
