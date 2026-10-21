# -*- coding: utf-8 -*-
"""工具：给定一段引文，找出它**真正住在哪一条条款**里。

矩阵里每格都带一个条款号，而条款号有三种来路：
  1) spec 里**写死**的（`clause` 字段）—— 可信；
  2) `nearestClause()` **就近推断**的 —— 会被交叉引用吃掉（「按 4.8 b) 测」）；
  3) 附录 / Annex 的 —— 另一套编号体系。

第 2 种是「值对、条款错」的来源。本脚本用**引文本身**当证据，
在条款索引里反查它住在哪一条，输出候选条款号 + 页码。

用法：
    python scripts/where_is.py --ver A --quote "可点亮。然而，昼间行驶灯开启时"
    python scripts/where_is.py --ver A --quote "..." --page 57
"""
import argparse, importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

TAGS = re.compile(r"<[^>]+>")
WS = re.compile(r"\s+")
# LaTeX 碎片：$2 0 ^ { \circ }$ → 20°
LATEX = re.compile(r"\$\s*\\\s*mathrm\s*\{([^}]*)\}\s*\$|\\\s*(?:circ|degree)\b|\$")


def norm(s: str) -> str:
    s = TAGS.sub(" ", s)
    s = s.replace("％", "%").replace("（", "(").replace("）", ")")
    s = LATEX.sub(lambda m: (m.group(1) or " ") if m.group(1) else "°", s)
    s = re.sub(r"[\^\{\}\\_]", "", s)
    s = WS.sub("", s)
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ver", required=True)
    ap.add_argument("--quote", required=True)
    ap.add_argument("--min", type=int, default=14)
    args = ap.parse_args()

    docs = cs.pick_docs()
    idx = cs.split_clauses(docs[args.ver])
    q = norm(args.quote)
    frag = q[:args.min] if len(q) >= args.min else q

    hits = []
    for k, v in idx.items():
        b = norm(v.get("body", ""))
        if frag and frag in b:
            hits.append((k, v.get("page"), v.get("head", "")[:40]))
    # 片段太短时退一步用更短的片段找
    if not hits and len(frag) >= 8:
        for k, v in idx.items():
            b = norm(v.get("body", ""))
            if frag[:8] in b:
                hits.append((k, v.get("page"), v.get("head", "")[:40]))
    out = ["ver=%s 片段=%s" % (args.ver, frag)]
    if hits:
        for h in hits:
            out.append("   条款 %-12s p%-4s %s" % h)
    else:
        out.append("   没在任何条款正文里找到（可能是位图章节 / 附录 / 片段选得不好）")
    io.open(os.path.join(ROOT, "reports", "_where_is.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out[:1]) + "  → %d 处" % len(hits))


if __name__ == "__main__":
    main()
