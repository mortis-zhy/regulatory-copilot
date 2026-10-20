# -*- coding: utf-8 -*-
"""把覆盖审计报出的「真漏」逐条带上条款正文，供人工定性。

用法： python scripts/miss_dump.py [A|B|C]
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
ca = _load("ca", os.path.join(ROOT, "scripts", "coverage_audit.py"))
docs = cs.pick_docs()
idx = {v: cs.split_clauses(p) for v, p in docs.items()}
audit = json.load(io.open(os.path.join(ROOT, "data", "coverage-audit.json"), encoding="utf-8"))

want = sys.argv[1] if len(sys.argv) > 1 else None
for v, ent in audit["versions"].items():
    if want and v != want:
        continue
    print("#" * 100)
    print("【%s】%s —— 真漏 %d" % (v, ent["label"], ent["missing"]))
    for m in ent["missingItems"]:
        cl = m["clause"]
        if cl.startswith("第"):
            body = ca.bitmap_chapter_text(v, (ca.load_bitmap_chapters().get(v) or {}).get(cl[1], {}))
        else:
            body = idx.get(v, {}).get(cl, {}).get("body", "")
        flat = re.sub(r"\s+", " ", body)
        val = m["value"]
        ctx = ""
        for sent in re.split(r"(?<=[。；;.])", flat):
            s2 = sent.strip()
            if not s2:
                continue
            if re.search(r"(?<![\d.])%s(?![\d])" % re.escape(val), s2):
                ctx = s2[:230]
                break
        if not ctx:
            ctx = flat[:230]
        print("  %-16s %-9s %-6s p%-4s %s" % (cl, val, m["unit"], m["page"], ctx))
