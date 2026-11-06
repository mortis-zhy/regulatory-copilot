# -*- coding: utf-8 -*-
"""**标准声明**的读取入口（Python 侧）。

声明（`data/standard-pack.json`）是「这个标准，报告需要知道的一切」——
标准名、各版本的文档名与角色、源 PDF 文件名、声称指标的表号……

**只有一个读法** ✓ —— 散在各个脚本里各读一遍，
迟早有一处读成了旧版（而那处会**静静地**按旧标准判）。

用法：

```python
from declaration import decl, version_docs, family

docs = version_docs()        # {"A": "GB 4785 草案 V4.3.5", ...}
name = family()              # "GB 4785"
```
"""
from __future__ import annotations

import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECL_PATH = os.path.join(ROOT, "data", "standard-pack.json")


def decl(root: str | None = None) -> dict:
    """读声明。"""
    path = os.path.join(root, "data", "standard-pack.json") if root else DECL_PATH
    with io.open(path, encoding="utf-8") as f:
        return json.load(f)


def family(root: str | None = None) -> str:
    """标准族名（「GB 4785」）。"""
    name = decl(root).get("standardFamily")
    if not name:
        raise SystemExit("声明里没有 standardFamily —— 不知道这个标准叫什么（宁可停）")
    return str(name)


def version_docs(root: str | None = None) -> dict:
    """版本键 → 文档名（「GB 4785 草案 V4.3.5」「GB 4785-2019」「UN R48-09」）。"""
    out = {}
    for v in decl(root).get("versions", []):
        key = v.get("key")
        doc = v.get("doc")
        if key and doc:
            out[key] = str(doc)
    if not out:
        raise SystemExit("声明里没有 versions[].doc —— 认不出各版叫什么（宁可停）")
    return out


def version_doc(key: str, root: str | None = None) -> str:
    """某一版的文档名。"""
    docs = version_docs(root)
    if key not in docs:
        raise SystemExit(f"声明里没有 {key} 版的文档名（有的：{', '.join(sorted(docs))}）")
    return docs[key]
