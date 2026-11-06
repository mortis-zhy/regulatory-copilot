# -*- coding: utf-8 -*-
"""标准声明的读取入口（Python 侧）。

`data/standard-pack.json` 是**关于这个标准，报告需要知道的一切**：
TS 侧读它（`server/reports/versionMeta.ts`），Python 侧读它（这个文件）。

## 为什么要有这个文件

以前**源 PDF 的文件名散在五个脚本里各写一份**：

    verify_claims.py / extract_mineru_v4_sdk.py / extract_pymupdf.py /
    extract_v5.py / ocr_full.py / audit_pages.py

换一套标准要改六处 —— 而漏掉一处的症状是
**读不到文件**（或读到别的那一份），**而且不报错**：
脚本会带着一份空语料继续跑，只是报告里什么都没有。

这类「漏改」正是「宁可空着，不可错着」要防的：
空着要**说出来**，不能默默空着。

## 用法

    from scripts.standard_pack import source_pdfs
    SOURCE_PDFS = source_pdfs(ROOT)      # {版本键: Path}

Python 会把**脚本所在目录**放进 sys.path[0]，
所以仓库根目录下的脚本与 `scripts/` 里的脚本都能直接 import。
"""
import io
import json
import os
from pathlib import Path

ROOT = Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PACK_PATH = ROOT / "data" / "standard-pack.json"


def load_pack(root=None):
    """读标准声明。"""
    path = Path(root or ROOT) / "data" / "standard-pack.json"
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


PACK = load_pack()
VERSIONS = PACK.get("versions", [])
VERSION_BY_KEY = {v["key"]: v for v in VERSIONS}


def version_keys():
    """各版本的键，按声明顺序。"""
    return [v["key"] for v in VERSIONS]


def source_dir(root=None):
    """源 PDF 所在目录（相对仓库根）。"""
    return PACK.get("sourceDir", "delivery/PDF对比")


def source_files(root=None):
    """各版本的源 PDF **文件名**（不含目录）。"""
    return {k: (v.get("sourceFile") or "") for k, v in VERSION_BY_KEY.items()}


def source_pdfs(root=None):
    """各版本的源 PDF **完整路径**（仓库内 `delivery/PDF对比/`）。"""
    base = Path(root or ROOT)
    out = {}
    for k, name in source_files().items():
        if name:
            out[k] = base / source_dir() / name
    return out
