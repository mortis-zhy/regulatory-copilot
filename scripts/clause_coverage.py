# -*- coding: utf-8 -*-
"""条款索引的**验收标准**：矩阵里引用到的条款，索引里找得到吗？

索引不全不要紧 —— 要紧的是「矩阵引用的条款」必须能查到，
否则「取值必须落在所引条款里」这条不变式就没法执行。

用法： python scripts/clause_coverage.py
"""
import importlib.util, io, json, os, re
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

docs = cs.pick_docs()
idx = {v: cs.split_clauses(p) for v, p in docs.items()}

rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
rows = rep["parameterMatrix"]

hit = Counter()
miss = []
for r in rows:
    for v in ("A", "B", "C"):
        c = r["cells"].get(v, {})
        if c.get("status") != "verified":
            continue
        cl = (c.get("clause") or "").strip()
        if not cl:
            hit["无条款号"] += 1
            continue
        if cl in idx.get(v, {}):
            hit["命中"] += 1
        else:
            # 退一步：同前缀的条款里找找（可能只是层级不同）
            pref = [k for k in idx.get(v, {}) if k.startswith(cl.rsplit(".", 1)[0])]
            if pref:
                hit["前缀命中"] += 1
                miss.append((r["id"], v, cl, "同前缀有：" + ",".join(pref[:3])))
            else:
                hit["未命中"] += 1
                miss.append((r["id"], v, cl, "整个前缀都没有"))

print("矩阵取值格在条款索引里的命中情况：", dict(hit))
if miss:
    print("\n没命中的（前 25 个）：")
    for m in miss[:25]:
        print("   %-42s %s 条款 %-12s %s" % m)
