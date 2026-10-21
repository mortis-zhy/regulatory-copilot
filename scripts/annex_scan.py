# -*- coding: utf-8 -*-
"""把三份标准的**附录**扫一遍，看看里面有没有参数矩阵漏掉的限值。

附录（GB 的「附录A–J」、R48 的「Annex 1–14」）不在条款索引里 ——
`clause_split.py` 只认「数字.数字」形态的条款号，附录是另一个体系。
所以覆盖审计**从来没扫过附录**。这一层可能有真漏。

用法： python scripts/annex_scan.py [A|B|C]
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
ls = _load("ls", os.path.join(ROOT, "scripts", "limit_scan.py"))
ca = _load("ca", os.path.join(ROOT, "scripts", "coverage_audit.py"))

# 附录起始页（PDF 页码）—— 由脚本 detect 得出
ANNEX_START = {"A": 73, "B": 60, "C": 104}

docs = cs.pick_docs()
rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
rows = rep["parameterMatrix"]

want = sys.argv[1] if len(sys.argv) > 1 else None
for v in ("A", "B", "C"):
    if want and v != want:
        continue
    start = ANNEX_START[v]
    blob = []
    for p, lines in cs.doc_lines(docs[v]):
        if p >= start:
            blob.append("\n".join(lines))
    text = "\n".join(blob)
    # 矩阵里这一版的全部取值
    have = []
    for r in rows:
        c = r["cells"].get(v, {})
        if c.get("status") != "verified":
            continue
        unit = ca.row_unit_of(r.get("unit") or "")
        for n in c.get("nums", []):
            f = ca.parse_num(str(n))
            if f is not None:
                have.append((f, unit, r["id"], r["name"]))
    print("=" * 90)
    print("【%s】附录从第 %d 页起，共 %d 页" % (v, start, len(list(cs.doc_lines(docs[v])))))
    seen = {}
    for val, unit in ls.scan_limits(text):
        key = (round(val, 6), unit)
        seen.setdefault(key, 0)
        seen[key] += 1
    miss = []
    for (val, unit), n in sorted(seen.items()):
        hit = [x for x in have if ca.same(val, unit, x[0], x[1])]
        if not hit:
            miss.append((val, unit, n))
    print("  附录里的量值 %d 种，其中**矩阵里找不到**的 %d 种：" % (len(seen), len(miss)))
    flat = re.sub(r"\s+", " ", text)
    for val, unit, n in miss:
        ctx = ""
        for sent in re.split(r"(?<=[。；;.])", flat):
            s2 = sent.strip()
            if not s2:
                continue
            if re.search(r"(?<![\d.])%g\s*%s" % (val, re.escape(unit)), s2):
                ctx = s2[:200]
                break
        print("    %-10s %-6s ×%-3d %s" % (val, unit, n, ctx))
