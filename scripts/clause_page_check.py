# -*- coding: utf-8 -*-
"""不变式：**矩阵引用的条款号，必须和它引用的那一页对得上**。

`nearestClause()` 取「匹配点前面最近的一个点分数字」。可原文里
**交叉引用**也是点分数字，于是它会经常被交叉引用吃掉：

    A §5.19.7.5「……后位灯和 4.11 规定的其他灯具允许熄灭……」
                                 ^^^^^ 交叉引用，不是本条的条款号

于是矩阵里这一行报成「条款 4.11 · 第 57 页」——**页对、条款错**。
A 的第 4 章条款号印在位图里（索引里根本没有 4.11），所以按条款的
取值检查只会退回「整章当背景」的弱命中，抓不到这类错。

这一条用**页码**当独立证据：

- 条款号在条款索引里 → 比对它所在的页与矩阵报的页（差 > TOL 即可疑）；
- 条款号属于**位图章节**（data/bitmap-chapters.json）→ 取值必须落在
  该章节的页区间里；落在外面，说明引用的根本不是这一章的条款；
- 其它（附录 / Annex / 表 / 索引不全）→ 跳过，不猜。

用法： python scripts/clause_page_check.py [--tol 3]
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

PAGE_RE = re.compile(r"第\s*(\d+)\s*页")


def cell_page(cell):
    m = PAGE_RE.search(str(cell.get("page") or ""))
    return int(m.group(1)) if m else None


def load_bitmap():
    path = os.path.join(ROOT, "data", "bitmap-chapters.json")
    if not os.path.exists(path):
        return {}
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: (raw.get(v) or {}) for v in ("A", "B", "C")}


def clause_spans(index):
    """{条款号: (起始页, 结束页)} —— 结束页 = 下一条款的起始页（可与本条同页）。

    `split_clauses()` 用**全局行流**切条款：一条的正文一直延伸到**下一条款号**
    出现为止，所以「这条管到哪一页」= 下一条的首页。
    """
    items = list(index.items())          # 插入顺序 = 文档顺序
    spans = {}
    for i, (k, v) in enumerate(items):
        start = int(v.get("page") or 0)
        nxt = int(items[i + 1][1].get("page") or start) if i + 1 < len(items) else start + 10 ** 6
        spans[k] = (start, max(start, nxt))
    return spans


def main():
    tol = 3
    if "--tol" in sys.argv:
        tol = int(sys.argv[sys.argv.index("--tol") + 1])
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    spans = {v: clause_spans(i) for v, i in idx.items()}
    bitmap = load_bitmap()
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    bad = []
    checked = 0
    skipped = 0
    for r in rows:
        for v in ("A", "B", "C"):
            c = r["cells"].get(v) or {}
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            if not cl or not re.match(r"^\d", cl):
                skipped += 1          # 附录 / Annex / 表 —— 没有页码归属
                continue
            pg = cell_page(c)
            if pg is None:
                skipped += 1
                continue
            sp = spans.get(v, {}).get(cl)
            if sp:
                checked += 1
                lo, hi = sp
                if not (lo <= pg <= hi):
                    bad.append((r["id"], v, cl,
                                "该条款管第%s–%s页" % (lo, hi),
                                "取值在第%s页" % pg, pg - hi if pg > hi else lo - pg))
                continue
            # 索引里没有 → 可能是位图章节。位图章节有页区间，可用来判。
            chap = cl.split(".")[0]
            bm = (bitmap.get(v) or {}).get(chap)
            if not bm or not bm.get("pages"):
                skipped += 1          # 附录 / 索引不全 —— 不猜
                continue
            lo, hi = min(bm["pages"]), max(bm["pages"])
            checked += 1
            if not (lo - tol <= pg <= hi + tol):
                bad.append((r["id"], v, cl,
                            "第%s章是位图章节（p%d–p%d）" % (chap, lo, hi),
                            "取值却在第%s页" % pg, pg - hi if pg > hi else lo - pg))
                continue
    out = ["核了 %d 个取值格（页码可对），跳过 %d 个（附录/位图外/无页码）" % (checked, skipped)]
    if not bad:
        out.append("全部对得上 OK")
    else:
        out.append("条款号与页码对不上 %d 处：" % len(bad))
        for b in bad:
            out.append("   %-44s %s 引用条款 %-10s %-28s %-18s 相差 %d 页"
                       % (b[0], b[1], b[2], b[3], b[4], b[5]))
    io.open(os.path.join(ROOT, "reports", "_clause_page_check.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out[:1]))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
