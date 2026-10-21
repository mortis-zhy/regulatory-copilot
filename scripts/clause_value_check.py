# -*- coding: utf-8 -*-
"""不变式：**矩阵报出的取值，必须就在它引用的那条条款里**。

这是「值对、条款错」那一类错的克星：
- 引用 4.25（供电电压）却报 5° → 4.25 里没有 5° → 报错；
- 引用 6.14.4.1 却报 1500mm → 该条款里没有这个数 → 报错。

**范围**：条款本身 + 它的**祖先条款** + **后代条款**。
  - 祖先要算，是因为原文常把限值写在总条款、把细则挂在子条款
    （C §5.12.1.3 只说「见 5.12.1.2」，0.25 cd 在 5.12.1.2 里）；
  - 后代要算，是因为父条款只是个标题（5.7.2「Single lamps」），
    数值在 5.7.2.1 里。

**命中分两档**：
- **强命中**：带单位的量值在条款里找到（单位按基准量纲换算后比较，
  矩阵写 `m`、原文写 `mm` 也算对）；
- **弱命中**：原文里只有裸数字（单位在表头、或用「参考值」定义）——
  算过，但要在报告里单独说明。

无单位行（色度坐标这类）走**弱命中 + 表格页**：
  色度值在「表1 装置发出的光色」里，条款正文只说「见表1 至表4」。

对照表：条款索引（scripts/clause_split.py，源 PDF 文本层）× 矩阵取值。

用法： python scripts/clause_value_check.py
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


# 附录形态的条款引用：附录里的条（D.5.5）、表（表C.1）、附录号（附录H）、R48 的 Annex
ANNEX_CLAUSE = re.compile(r"^(?:[A-Z]\.\d+(?:\.\d+)*|Annex\s+\d+(?:\.\d+)*|表[A-Z]\.\d+(?:\.\d+)?|附录[A-Z](?:\s*表[A-Z]\.\d+)?)$")


def load_bitmap_chapters():
    """条款号印在位图里、只能按页区间扫的章节。"""
    path = os.path.join(ROOT, "data", "bitmap-chapters.json")
    if not os.path.exists(path):
        return {}
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: (raw.get(v) or {}) for v in ("A", "B", "C")}


def bitmap_text(v, meta):
    """位图章节的正文（按页区间取）。"""
    docs = cs.pick_docs()
    pgs = meta.get("pages") or []
    if not pgs:
        return ""
    lo, hi = min(pgs), max(pgs)
    blob = []
    for p, lines in cs.doc_lines(docs[v]):
        if lo <= p <= hi:
            blob.append("\n".join(lines))
    text = "\n".join(blob)
    cut = meta.get("cutAt")
    if cut and cut in text:
        text = text[:text.index(cut)]
    return text


def load_annex_ranges():
    """附录 / Annex 的页区间 —— 附录里的条款号不在条款索引里。"""
    path = os.path.join(ROOT, "data", "annex-ranges.json")
    if not os.path.exists(path):
        return {}
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: raw.get(v) for v in ("A", "B", "C") if raw.get(v)}


def annex_text(v, meta):
    docs = cs.pick_docs()
    start = int(meta.get("start") or 0)
    if not start:
        return ""
    blob = []
    for p, lines in cs.doc_lines(docs[v]):
        if p >= start:
            blob.append("\n".join(lines))
    return "\n".join(blob)


def ancestors(clause):
    """5.6.4.2.1 → 5.6.4.2 → 5.6.4 → 5.6 → 5"""
    parts = clause.split(".")
    return [".".join(parts[:i]) for i in range(len(parts) - 1, 0, -1)]


def scope(idx, v, clause):
    """条款 + 祖先 + 后代 的正文。"""
    out = []
    for k in ancestors(clause):
        b = idx.get(v, {}).get(k, {}).get("body")
        if b:
            out.append(b)
    b = idx.get(v, {}).get(clause, {}).get("body")
    if b:
        out.append(b)
    for k, c2 in idx.get(v, {}).items():
        if k.startswith(clause + "."):
            out.append(c2.get("body", ""))
    return "\n".join(out)


def main():
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    pages = {v: cs.doc_lines(p) for v, p in docs.items()}
    ANNEXES = load_annex_ranges()
    BITMAP = load_bitmap_chapters()
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    strong = weak = skipped = 0
    bad = []
    for r in rows:
        row_unit = (r.get("unit") or "").strip()
        dimensionless = row_unit in ("", "—", "-")
        for v in ("A", "B", "C"):
            c = r["cells"].get(v, {})
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            nums = c.get("nums") or []
            if not cl or not nums:
                skipped += 1
                continue
            body = idx.get(v, {}).get(cl, {}).get("body")
            annex_ctx = False
            if body is None or not body.strip():
                # 条款索引里没有这一条。三种可能，各自取不同的上下文：
                #  1) **附录里的条款**（D.5.5 / 表C.1 / 附录H / Annex 5）
                #     → 拿附录原文当背景；
                #  2) **位图章节里的条款**（A 的 4.15 —— 条款号印在位图里，
                #     索引里根本没有「4」这一章）→ 拿该章的页区间当背景；
                #  3) 其它（索引不全）→ 拿**同章**的正文当背景
                #     （B 的 4.29 藏在 4.9 的正文里 —— 索引只切出 4.1–4.9，
                #     因为 B 的两位数条款号是「4. 29」这种带空格的写法）。
                # 背景越宽，命中只能算**弱命中**。
                blob = ""
                if ANNEX_CLAUSE.match(cl):
                    am = ANNEXES.get(v)
                    blob = annex_text(v, am) if am else ""
                elif re.match(r"^\d", cl):
                    ch = cl.split(".")[0]
                    parts = [b for k, o in idx.get(v, {}).items()
                             if k == ch or k.startswith(ch + ".") for b in [o.get("body", "")] if b]
                    blob = "\n".join(parts)
                    if not blob:
                        bm = (BITMAP.get(v) or {}).get(ch)
                        if bm:
                            blob = bitmap_text(v, bm)
                if not blob:
                    skipped += 1      # 条款索引里没有 / 正文为空（索引不全，不是矛盾）
                    continue
                body = blob
                annex_ctx = True
            # 附录条款没有「祖先/后代」可取，背景就是整份附录原文
            text = body if annex_ctx else scope(idx, v, cl)
            found = ls.scan_limits(text)
            decimals = ls.scan_decimals(text)
            # **表格回退**：值可能落在条款引入的表里 —— 条款正文只写
            # 「见表1 至表4」（色度坐标）、或值在 Vr/TTC 表、照度表里。
            # 这类命中算「弱」：条款没错，但值不在正文句子里。
            pg = (idx.get(v, {}).get(cl) or {}).get("page", 0) or 0
            page_found = []
            page_decimals = []
            if pg:
                extra = []
                for p, lines in pages.get(v, []):
                    if abs(p - pg) <= 1:
                        extra.append("\n".join(lines))
                if extra:
                    blob = "\n".join(extra)
                    page_found = ls.scan_limits(blob)
                    page_decimals = ls.scan_decimals(blob)
            for n in nums:
                try:
                    fv = float(n)
                except ValueError:
                    continue
                hit = None
                # 附录 / 位图章节的上下文：整份附录（或整章）当背景，
                # 验到值只能算**弱命中** —— 它证明「这个值在那片区域里」，
                # 不能证明「就在那一条里」。
                if not dimensionless:
                    for x, u in found:
                        if ls.same_limit(x, u, fv, row_unit):
                            hit = "弱" if annex_ctx else "强"
                            break
                if hit is None:
                    for x, u in page_found:
                        if ls.same_limit(x, u, fv, row_unit):
                            hit = "弱"
                            break
                if hit is None:
                    for d in decimals + page_decimals:
                        if abs(d - fv) <= 1e-9 * max(1.0, abs(d)):
                            hit = "弱"
                            break
                if hit is None:
                    bad.append((r["id"], v, cl, n, row_unit, sorted(set(found))[:8]))
                elif hit == "强":
                    strong += 1
                else:
                    weak += 1
    print("检查了 %d 个取值格（强命中 %d · 弱命中 %d），%d 个格因无条款号/条款不在索引里而跳过"
          % (strong + weak, strong, weak, skipped))
    if bad:
        print("不符 %d 处：" % len(bad))
        for b in bad:
            print("   %-42s %s 条款 %-14s 报 %s%s   该条款里的值: %s"
                  % (b[0], b[1], b[2], b[3], b[4], b[5]))
    else:
        print("全部通过 ✓")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
