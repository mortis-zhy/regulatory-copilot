# -*- coding: utf-8 -*-
"""Python 侧的硬编码扫描 —— 输出与 `scripts/hardcode_scan.mjs` **同形**的 JSON。

## 为什么要有它

JS 那份只扫 `.ts/.tsx/.js/.mjs`。而**闸门里有一半是 Python 写的**
（`verify_indicators.py` / `check_clause_citations.py` / `verify_decision_brief.py` …）。

「闸门里不许出现标准名」那道关如果只扫 JS，
**Python 闸门就是一道没人看的后门** —— agent 往里写一个标准名，闸门照样全绿。

所以这一关要把两边的结果**合起来**看。

## 用法

    python scripts/scan_hardcodes.py scripts/verify_indicators.py [...]
    →  stdout: JSON 数组（字段与 JS 那份一致：file/line/col/cls/kind/sub/text/excerpt）

（口径与 `scripts/hardcode_ledger.py` 里的 `scan_py` 同一份实现 ——
不另写一份正则，免得两边口径不一致。）
"""
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from hardcode_ledger import scan_py  # noqa: E402


def main():
    files = [a for a in sys.argv[1:] if not a.startswith("-")]
    if not files:
        print("用法：python scripts/scan_hardcodes.py <文件…>", file=sys.stderr)
        raise SystemExit(2)
    out = []
    for rel in files:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            print("跳过（不存在）：%s" % rel, file=sys.stderr)
            continue
        out.extend(scan_py(rel))
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
