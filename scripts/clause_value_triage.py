# -*- coding: utf-8 -*-
"""把 clause_value_check 报出的每一处不符，带上条款正文摘出来，便于人工定性。

用法： python scripts/clause_value_triage.py > triage.txt
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cvc = load("cvc", os.path.join(ROOT, "scripts", "clause_value_check.py"))

docs = cs.pick_docs()
idx = {v: cs.split_clauses(p) for v, p in docs.items()}
rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))

for r in rep["parameterMatrix"]:
    row_unit = r.get("unit", "")
    for v in ("A", "B", "C"):
        c = r["cells"].get(v, {})
        if c.get("status") != "verified":
            continue
        cl = (c.get("clause") or "").strip()
        nums = c.get("nums") or []
        if not cl or not nums:
            continue
        body = idx.get(v, {}).get(cl, {}).get("body")
        if body is None or not body.strip():
            continue
        have = cvc.values_in(body)
        for k, c2 in idx.get(v, {}).items():
            if k.startswith(cl + "."):
                have += cvc.values_in(c2.get("body", ""))
        have_mm = [(cvc.to_mm(x, u), u) for x, u in have]
        for n in nums:
            try:
                fv = float(n)
            except ValueError:
                continue
            ok = any(abs(x - fv) < 1e-6 and (not u or not row_unit or u == row_unit)
                     for x, u in have_mm)
            if not ok:
                ok = any(abs(x - fv) < 1e-6 for x, u in have_mm if u in ("", row_unit))
            if ok:
                continue
            print("=" * 100)
            print("%s | %s | 条款 %s | 报 %s %s" % (r["id"], v, cl, n, row_unit))
            print("  条款正文：%s" % re.sub(r"\s+", " ", body)[:900])
            print("  该条款（含后代）里的值：%s" % sorted(set(have_mm)))
            print("  矩阵里的摘录：%s" % re.sub(r"\s+", " ", (c.get("value") or ""))[:300])
