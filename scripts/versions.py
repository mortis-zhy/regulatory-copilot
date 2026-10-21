# -*- coding: utf-8 -*-
"""版本清单 —— **全项目唯一的声明处**。

为什么单独一个文件：`("A", "B", "C")` 这个元组散落在五个文件里，
于是「完整性这一层审哪几版」就由复制粘贴决定。⑲→⑳ 之后我们发现，
**「看不见」伪装成「没有缺口」**是这个项目最贵的错误 ——
覆盖审计只审 A/B/C 的话，换一套标准时它的条款一条都不进账，
而报告照样写「真缺口 0」。

现在：
  · `KNOWN_VERSIONS` —— 已知版本的**展示顺序**（不是「只审这几版」）；
  · `ordered_versions(docs)` —— **从语料推导**实际有的版本：
    已知的按声明顺序在前，未知的按字母排后。
    完整性这一层必须用它，不许用字面量。
"""
import importlib.util
import os

# 已知版本的展示顺序（与 TS 侧 `VERSION_META` 一致）。
# 换一套标准时**加一行**，而不是改散落各处的元组。
KNOWN_VERSIONS = ["A", "B", "C"]


def ordered_versions(docs) -> list:
    """语料里实际有的版本：已知的按声明顺序在前，未知的按字母排后。

    `docs` 可以是 {版本: 路径}，也可以是 {版本: 条款索引} —— 只看键。
    """
    keys = list(docs or {})
    known = [v for v in KNOWN_VERSIONS if v in keys]
    extra = sorted(k for k in keys if k not in KNOWN_VERSIONS)
    return known + extra


def load_local(name: str, path: str):
    """按路径加载同目录下的模块（这些脚本不是包）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


HERE = os.path.dirname(os.path.abspath(__file__))
