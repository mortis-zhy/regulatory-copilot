# -*- coding: utf-8 -*-
"""对比重建前后的参数矩阵：只有该变的行变了。"""
import io, json

before = json.load(io.open("C:/Users/zsndz/AppData/Local/Temp/last-report-before.json", encoding="utf-8"))
after = json.load(io.open("reports/last-report.json", encoding="utf-8"))

B = {r["id"]: r for r in before["parameterMatrix"]}
A = {r["id"]: r for r in after["parameterMatrix"]}

print("行数 %d → %d" % (len(B), len(A)))
changed = 0
for rid, ra in A.items():
    rb = B.get(rid)
    if rb is None:
        print("  新增行", rid)
        continue
    diffs = []
    for v in ("A", "B", "C"):
        cb, ca = rb["cells"].get(v, {}), ra["cells"].get(v, {})
        sb = (cb.get("status"), tuple(cb.get("nums", [])), cb.get("clause", ""))
        sa = (ca.get("status"), tuple(ca.get("nums", [])), ca.get("clause", ""))
        if sb != sa:
            diffs.append("%s: %s → %s" % (v, sb, sa))
    if rb.get("verdict") != ra.get("verdict"):
        diffs.append("verdict: %s → %s" % (rb.get("verdict"), ra.get("verdict")))
    if diffs:
        changed += 1
        print("  %-44s %s" % (rid, " | ".join(diffs)))

print("变化行数：%d" % changed)
sb, sa = before["parameterMatrixStats"], after["parameterMatrixStats"]
print("stats:", json.dumps(sb, ensure_ascii=False))
print("stats:", json.dumps(sa, ensure_ascii=False))
