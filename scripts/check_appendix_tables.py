# -*- coding: utf-8 -*-
"""逐条核对附录 F 里引用的**原文片段**是否真的在源 PDF 里。

附录 F 是客户唯一能直接读到「表格型限值」的地方 —— 它引的每一句都必须
逐字来自源 PDF，不能是转述、更不能是我们记错的数字。

做法：把源 PDF 的文本层与引文都**去掉空白**后比对（PDF 里换行断开的数字、
全角半角差异都不该影响判断），逐条给出结论。验不到就非零退出。

用法： python scripts/check_appendix_tables.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TABLES = os.path.join(ROOT, "data", "appendix-tables.json")

_s = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(_s)
_s.loader.exec_module(cs)


def norm(s):
    """去掉所有空白 + 统一全角/半角标点里最常见的两种。"""
    s = re.sub(r"\s+", "", str(s))
    s = s.replace("（", "(").replace("）", ")").replace("，", ",")
    s = s.replace("：", ":").replace("；", ";").replace("、", ",")
    s = s.replace("＜", "<").replace("＞", ">").replace("－", "-")
    return s


def main():
    spec = json.load(io.open(TABLES, encoding="utf-8"))
    docs = cs.pick_docs()
    corpus = {}
    for v, path in docs.items():
        pages = cs.doc_lines(path)
        corpus[v] = norm("\n".join("\n".join(l for l in lines) for _, lines in pages))

    total = ok = 0
    bad = []
    for gi, g in enumerate(spec.get("groups", []), 1):
        for ver, ent in (g.get("versions") or {}).items():
            quote = (ent.get("quote") or "").strip()
            if not quote:
                continue
            total += 1
            nq = norm(quote)
            if nq in corpus.get(ver, ""):
                ok += 1
                print("  ✓ [%s] 组%d %s" % (ver, gi, g.get("title", "")[:28]))
            else:
                bad.append((gi, g.get("title", ""), ver, ent.get("clause", ""), quote))
                print("  ✗ [%s] 组%d %s —— 原文里找不到" % (ver, gi, g.get("title", "")[:28]))
    print("附录 F 原文片段：%d 条，命中 %d 条" % (total, ok))
    if bad:
        print("对不上的 %d 条：" % len(bad))
        for gi, title, ver, clause, quote in bad:
            print("  组%d「%s」%s %s\n    引文：%s" % (gi, title[:30], ver, clause, quote[:120]))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
