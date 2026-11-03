# -*- coding: utf-8 -*-
"""两套「取值级复核」实现必须**逐格**给出同一个结论。

一套在 TypeScript 里（`server/reports/corroboration.ts`，跑在矩阵构建时，
用 `loadSourceCorpus` 的整页文本），一套在 Python 里
（`scripts/matrix_page_check.py`，用 `clause_split.doc_lines` 的逐行文本）。
两套走的是**不同的取文本路径**，所以它们是互相独立的复算。

为什么要逐格比，而不是只比总数：
2026-11-03 第一次跑，两边都判「全部 796 格定位成功」，但引文档数是
630 与 675 —— 差的 45 格是**归一化不对称**造成的：源页文本去掉了千分位逗号
（'7,000 lx' → '7000lx'），引文片段没去（仍是 '7,000lx.'），
于是引文明明在那一页上却判成「查不到」。
只比总数看不出这种问题；逐格比立刻就能定位到是哪几格、差在哪一档。

用法： python scripts/compare_corroboration_tiers.py
"""
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


mpc = _load("mpc", os.path.join(ROOT, "scripts", "matrix_page_check.py"))
cs = mpc.cs

VERSION_HEADER = re.compile(r"^(版本|来源|文档|文件|标准|version|document|file)$", re.I)


def main():
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    docs = cs.pick_docs()
    pages = {v: cs.doc_lines(p) for v, p in docs.items()}
    normed = {v: [(p, mpc.norm("\n".join(ls))) for p, ls in pages[v]] for v in pages}

    diffs = []
    checked = 0
    for r in rep["parameterMatrix"]:
        for v in ("A", "B", "C"):
            c = r["cells"].get(v) or {}
            if c.get("status") != "verified":
                continue
            ts = (c.get("corroborated") or {}).get("evidence")
            m = re.search(r"第\s*(\d+)\s*页", str(c.get("page") or ""))
            if not m:
                continue
            cited = int(m.group(1))
            checked += 1
            frag = mpc.fragment(str(c.get("value") or ""), str(c.get("match") or ""))
            frag_pages = [p for p, t in normed[v] if len(frag) >= 8 and frag in t]
            cands = mpc.value_candidates(str(c.get("match") or ""), c.get("nums") or [])
            val_pages = [p for p, t in normed[v] if any(mpc.has_literal(t, cd) for cd in cands)]
            clause = str(c.get("clause") or "").strip()
            cl_pages = [p for p, t in normed[v] if clause and mpc.has_literal(t, clause)]
            match_text = mpc.norm(str(c.get("match") or ""))
            match_pages = [p for p, t in normed[v] if len(match_text) >= 8 and match_text in t]
            if cited in frag_pages:
                py = "excerpt"
            elif cited in match_pages:
                py = "match"
            elif cited in val_pages and cited in cl_pages:
                py = "value+clause"
            elif cited in val_pages:
                py = "value"
            elif cited in cl_pages:
                py = "clause"
            else:
                py = "none"
            if py != ts:
                diffs.append((r["id"], v, cited, ts, py, frag[:60]))

    out = ["逐格比对 %d 个取值格，两套实现不一致 %d 处" % (checked, len(diffs))]
    for d in diffs[:20]:
        out.append("   %-44s %s 第%s页  TS=%s  PY=%s  frag=%s" % (d[0], d[1], d[2], d[3], d[4], d[5]))
    io.open(os.path.join(ROOT, "reports", "_corroboration_tiers.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print(out[0])
    for d in diffs[:20]:
        print("   %-44s %s 第%s页  TS=%s  PY=%s  frag=%s" % (d[0], d[1], d[2], d[3], d[4], d[5]))
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main())
