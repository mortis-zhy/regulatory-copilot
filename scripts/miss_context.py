# -*- coding: utf-8 -*-
"""把「真漏」的每一条连同**原文上下文**打出来，供人工判定。

用法： python scripts/miss_context.py
"""
import importlib.util, io, json, os, re, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for name, fn in (("cs", "clause_split.py"), ("cis", "clause_index_src.py")):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "scripts", fn))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    globals()[name] = mod

sys.path.insert(0, os.path.join(ROOT, "scripts"))
import coverage_audit as ca


def main():
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    by_clause, by_chapter = {}, {}
    for v in ("A", "B", "C"):
        bc, bch = defaultdict(list), defaultdict(list)
        for r in rows:
            c = r["cells"].get(v, {})
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            if not cl:
                continue
            for n in c.get("nums", []):
                try:
                    f = ca.parse_num(str(n))
                except ValueError:
                    continue
                unit = (r.get("unit") or "").strip()
                bc[cl].append((round(f, 6), unit, r["id"], r["name"]))
                bch[ca.chapter_of(cl)].append((round(f, 6), unit, r["id"], r["name"]))
        by_clause[v], by_chapter[v] = bc, bch

    out = io.open(os.path.join(ROOT, "reports", "miss-context.txt"), "w", encoding="utf-8", newline="\n")
    for v in ("A", "B", "C"):
        cls = idx.get(v, {})
        for clause, obj in cls.items():
            body = obj.get("body", "")
            if not body.strip() or clause.startswith("3."):
                continue
            vals = ca.limits_in(body)
            if not vals:
                continue
            seen = set()
            for val, unit in vals:
                key = (round(val, 6), unit)
                if key in seen:
                    continue
                seen.add(key)
                if [x for x in by_clause[v].get(clause, []) if x[0] == key[0]]:
                    continue
                if [x for x in by_chapter[v].get(ca.chapter_of(clause), []) if x[0] == key[0]]:
                    continue
                # 真漏
                out.write("\n" + "=" * 96 + "\n")
                out.write("【%s】条款 %s  (p%s)  值=%s %s\n" % (v, clause, obj.get("page"), val, unit))
                out.write("设备: %s\n" % cis.device_of(v, ca.chapter_of(clause)))
                out.write("-" * 96 + "\n")
                out.write(body.strip()[:1600] + "\n")
    out.close()
    print("写入 reports/miss-context.txt")


if __name__ == "__main__":
    main()
