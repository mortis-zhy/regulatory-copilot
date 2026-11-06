# -*- coding: utf-8 -*-
"""**源 PDF 是哪几份** —— 从**声明**取。

## 为什么要有这个

源 PDF 的文件名里带着**版本号与页数**（`源文件_A_GB4785草案V4.3.5_103页.pdf`），
换一套标准时**必然全换**。

而这个文件名在好几个脚本里**各写了一份** —— 换标准时**改漏一处**，
那个脚本就会**静静地读错文件**（或者报「找不到文件」）。

声明（`data/standard-pack.json`）里本来就有：
`sourceDir` + 每个版本的 `sourceFile` ✓ —— 这里只做**一次**解析。

## 用法

```python
from source_pdfs import source_pdfs, source_pdf

for key, path in source_pdfs().items():
    ...                       # 三份源 PDF 的绝对路径

path = source_pdf("C")       # 某一版
```
"""
from __future__ import annotations

import io
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DECL = os.path.join(ROOT, "data", "standard-pack.json")


def _decl() -> dict:
    with io.open(DECL, encoding="utf-8") as f:
        return json.load(f)


def source_dir(root: str | None = None) -> str:
    """源 PDF 所在目录（相对仓库根）—— 从声明取。"""
    d = _decl().get("sourceDir")
    if not d:
        raise SystemExit(
            "data/standard-pack.json 里没有 sourceDir —— "
            "认不出源 PDF 在哪儿（宁可停，不要去猜目录）"
        )
    return d


def source_pdfs(root: str | None = None) -> dict:
    """版本键 → 源 PDF 的**绝对路径**（从声明取）。"""
    base = root or ROOT
    out = {}
    for v in _decl().get("versions", []):
        name = v.get("sourceFile")
        key = v.get("key")
        if not key or not name:
            continue
        out[key] = os.path.join(base, source_dir(base), name)
    if not out:
        raise SystemExit(
            "data/standard-pack.json 里没有 versions[].sourceFile —— "
            "认不出哪份 PDF 是哪一版（宁可停，不要猜）"
        )
    return out


def source_pdf(key: str, root: str | None = None) -> str:
    """某一版源 PDF 的绝对路径。"""
    pdfs = source_pdfs(root)
    if key not in pdfs:
        raise SystemExit(
            f"声明里没有 {key} 版的源 PDF（有的：{', '.join(sorted(pdfs))}）"
        )
    return pdfs[key]


if __name__ == "__main__":
    for k, p in sorted(source_pdfs().items()):
        mark = "✓" if os.path.exists(p) else "✗ 缺"
        print(f"{mark} {k}  {os.path.relpath(p, ROOT)}")
