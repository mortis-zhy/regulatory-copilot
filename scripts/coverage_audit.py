# -*- coding: utf-8 -*-
"""**三版条款级覆盖审计** —— 回答客户真正会问的那句：「还有没有少数据？」

以前只有 R48 §6 有清单（附录 D），GB 两版**没有** ——
也就是说「GB 4785 的要求你们全覆盖了吗」这个问题没人答过。
这个脚本把三份标准都按**条款**清点一遍，逐条比对矩阵。

判定口径
--------
1. 先把每份标准切成**条款**（源 PDF 文本层，条款号可靠）→ `scripts/clause_split.py`；
2. 每个条款里的**每一个限值**（带限值单位、且不是标准号/类别/序号）都列出来；
3. 排除**配光/试验条件表**（成表的测试点不是标量参数，本来就不进矩阵）；
4. 拿矩阵里**每一版的每一个取值**去比：
   - **同条款**命中 → 完全覆盖；
   - **同章不同条款**命中 → 覆盖了，但引用在别处（一般是「通用条款」那一份）；
   - **该版整列**里存在这个值 → 覆盖了，但落在别的装置/条款上；
   - 该版整列都找不到 → **真漏**（要补行的那一档）。
5. 报告里把四类分开列 —— 只有最后一类是要补的。

用法： python scripts/coverage_audit.py
"""
import importlib.util, io, json, os, re, sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)
spec2 = importlib.util.spec_from_file_location("cis", os.path.join(ROOT, "scripts", "clause_index_src.py"))
cis = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(cis)

# 限值解析**只有一份**（scripts/limit_scan.py）。审计与条款核对必须同口径，
# 否则会出现「审计说漏了、核对说没错」这种没法判的场面。
spec3 = importlib.util.spec_from_file_location("ls", os.path.join(ROOT, "scripts", "limit_scan.py"))
ls = importlib.util.module_from_spec(spec3)
spec3.loader.exec_module(ls)

# 过渡条款（Chapter 12）与温度不是灯光限值。
SKIP_BODY = re.compile(r"Transitional provisions|shall no longer be recognized|"
                       r"in the event of the approval of a lamp", re.I)


def parse_num(raw):
    """矩阵里的取值（纯数字，可能带千分位）。"""
    s = re.sub(r"\s+", "", str(raw))
    if "," in s:
        a, _, b = s.partition(",")
        s = ("%s.%s" % (a, b)) if len(b) != 3 else a + b
    try:
        return float(s)
    except ValueError:
        return None


def row_unit_of(unit):
    """矩阵行的单位名 → 规范单位（「mm²（80mm圆面积）」这种带说明的取前缀）。"""
    u = (unit or "").strip()
    if u.startswith("mm²"):
        return "mm²"
    return u


def limits_in(body):
    """条款正文里的**限值** (值, 规范单位)。"""
    return ls.scan_limits(body)


def same(v1, u1, v2, u2):
    """两个量值是不是同一个（跨写法：m vs mm、° vs degree）。"""
    return ls.same_limit(v1, u1, v2, u2)


def load_bitmap_chapters():
    """条款号印在位图里、只能按页区间扫的章节。"""
    path = os.path.join(ROOT, "data", "bitmap-chapters.json")
    if not os.path.exists(path):
        return {}
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: (raw.get(v) or {}) for v in ("A", "B", "C")}


def load_annex_ranges():
    """附录 / Annex 的页区间 —— 条款索引看不见它们，必须单独扫。"""
    path = os.path.join(ROOT, "data", "annex-ranges.json")
    if not os.path.exists(path):
        return {}
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: raw.get(v) for v in ("A", "B", "C") if raw.get(v)}


def bitmap_chapter_text(v, meta):
    """该章节的正文（按页区间取，按标记切掉下一章的开头）。"""
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


def annex_text(v, meta):
    """该附录的正文（从附录起始页到文末）。"""
    docs = cs.pick_docs()
    start = int(meta.get("start") or 0)
    if not start:
        return ""
    blob = []
    for p, lines in cs.doc_lines(docs[v]):
        if p >= start:
            blob.append("\n".join(lines))
    return "\n".join(blob)


def is_table_clause(body, vals):
    """这条是不是**配光表 / 试验条件表**？

    判据：句子少、量值多。成表的测试点（配光表的 25°/10°/5° 格点、
    试验条件的 0.2lx/3.3% …）本来就不是标量参数，不进矩阵，
    不该被算成「漏」。
    """
    sents = [s for s in re.split(r"[.。;；]\s*", body) if s.strip()]
    if len(vals) >= 6 and len(sents) <= max(3, len(vals) // 2):
        return True
    if len(vals) >= 10:
        return True
    return False


def load_tables():
    """人工核定的「表格型 / 不在范围」条款清单。

    早先用「量值多、句子少」这种启发式去判表格，结果把**几何可见度条款**
    （前位灯 45°/20°/80°/750mm/12.5cm² 一串）也当成了表 ——
    那些条款的取值是**在矩阵里的**，被误判成「表格」就等于把已覆盖的量藏起来了。
    启发式只能当线索，判定必须人工过一遍。
    """
    path = os.path.join(ROOT, "data", "table-clauses.json")
    raw = json.load(io.open(path, encoding="utf-8"))
    return {v: (raw.get(v) or {}) for v in ("A", "B", "C")}


def dev_of(ver, clause):
    return cis.device_of(ver, clause)


def chapter_of(clause):
    p = clause.split(".")
    return ".".join(p[:2])


def _chap_key(k):
    """章节排序键；位图章节的标签不是条款号，排在最后。"""
    try:
        return [int(x) for x in k.split(".")]
    except ValueError:
        return [10 ** 6]


def main():
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    TABLES = load_tables()
    BITMAP_CHAPTERS = load_bitmap_chapters()
    ANNEXES = load_annex_ranges()
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    by_clause, by_chapter, anywhere = {}, {}, {}
    for v in ("A", "B", "C"):
        bc, bch, an = defaultdict(list), defaultdict(list), []
        for r in rows:
            c = r["cells"].get(v, {})
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            unit = row_unit_of(r.get("unit") or "")
            for n in c.get("nums", []):
                f = parse_num(str(n))
                if f is None:
                    continue
                item = (f, unit, r["id"], r["name"], cl)
                an.append(item)
                if not cl:
                    continue
                bc[cl].append(item)
                bch[chapter_of(cl)].append(item)
        by_clause[v], by_chapter[v], anywhere[v] = bc, bch, an

    # 矩阵行 → 该行引用的条款属于哪个装置（空 = 通用条款）
    row_device = {}
    for r in rows:
        cl = (r["cells"].get("A", {}).get("clause") or "").strip()
        row_device[r["id"]] = cis.device_of("A", cl) if cl else ""
    # 通用条款行：这些行代表「标准里对所有灯具都成立的通用规定」，
    #  它们的值可以覆盖任何装置的同值条款。
    GENERAL_ROW = ("lowMountedLamp.", "highMountedLamp.")

    def is_general(row_id, ver, clause):
        if row_id.startswith(GENERAL_ROW):
            return True
        return not cis.device_of(ver, clause)

    grand = {"same": 0, "other": 0, "elsewhere": 0, "otherdev": 0, "miss": 0}
    report = []
    out_json = {"generatedAt": None, "versions": {}}
    for v in ("A", "B", "C"):
        cls = idx.get(v, {})
        n_clause = n_value = 0
        same_hits, other_hits, else_hits, dev_hits, misses = [], [], [], [], []
        tables = []
        oos = []
        mixed = []
        for clause, obj in cls.items():
            body = obj.get("body", "")
            if not body.strip() or clause.startswith("3."):
                continue
            if SKIP_BODY.search(body):
                continue
            # 表型条款的判定**必须在算量值之前**：公式型表格（A 表7 的 -(h+1.2)、
            # B/C 的 upper/lower inclination limit）本来就没有带单位的标量量值，
            # 先算量值会把它们整条跳过。
            cur = TABLES.get(v, {}).get(clause)
            skip = set()
            if cur:
                if cur.get("kind") == "outOfScope":
                    oos.append({"clause": clause, "note": cur.get("note", "")})
                    continue
                if cur.get("kind") != "mixed":
                    tables.append({
                        # 条款号被 PDF 拆行吃掉时，索引的 key 是**父条款**，
                        # 真号在 trueClause 里（GB 2019 的「5. 1. 9. 3. 1. 1」、
                        # 「5. 2. 6. 1. 2」都拆成了两行）。报真号，别报错号。
                        "clause": cur.get("trueClause") or clause,
                        "indexClause": clause,
                        "device": dev_of(v, clause),
                        "page": obj.get("page", 0),
                        "note": cur.get("note", ""),
                        "appendixF": cur.get("appendixF", ""),
                        "values": sorted({("%g %s" % (x, u)) for x, u in limits_in(body)}),
                    })
                    continue
                # kind=mixed：这条里既有真限值、也有**适用门槛**（如「车长大于 6m
                # 但不大于 7m」里的 6m/7m 是车长分档，不是灯具的安装限值）。
                # 门槛逐个列在 skip 里，其余照常算覆盖。
                skip = {(round(float(a), 6), b) for a, b in (cur.get("skip") or [])}
                mixed.append({"clause": clause, "note": cur.get("note", ""),
                              "skip": ["%g %s" % (a, b) for a, b in (cur.get("skip") or [])]})
            vals = [x for x in limits_in(body)
                    if (round(x[0], 6), x[1]) not in skip]
            if not vals:
                continue
            n_clause += 1
            dev = cis.device_of(v, clause)
            seen = set()
            for val, unit in vals:
                key = (round(val, 6), unit)
                # 去重按**规范量值**：「0.5 m」和「500 mm」是同一个限值的两种写法
                cv = ls.canon_value(val, unit)
                ckey = (round(cv[1], 6), cv[0]) if cv else key
                if ckey in seen:
                    continue
                seen.add(ckey)
                n_value += 1
                # 单位按**基准量纲**比较：原文写 0.5 m、矩阵写 500 mm，是同一个限值。
                exact = [x for x in by_clause[v].get(clause, []) if same(val, unit, x[0], x[1])]
                if exact:
                    same_hits.append((clause, key, exact[0][3]))
                    continue
                near = [x for x in by_chapter[v].get(chapter_of(clause), [])
                        if same(val, unit, x[0], x[1])]
                if near:
                    other_hits.append((clause, key, near[0][3]))
                    continue
                cands = [x for x in anywhere[v] if same(val, unit, x[0], x[1])]
                if not cands:
                    misses.append((clause, key, obj.get("page", 0)))
                    continue
                # 这个值在别处出现过 —— 但要看它**是不是同一个装置/通用条款**。
                # 「前位灯的 750mm」被「前雾灯的 750mm」顶掉，是覆盖到位了；
                # 「AFS 的 1200mm」被「示廓灯的 1200mm」顶掉，是**没覆盖**。
                gen = [x for x in cands if is_general(x[2], v, x[4])]
                if gen:
                    else_hits.append((clause, key, gen[0][3]))
                else:
                    dev_hits.append((clause, key, cands[0][3], dev))
            # 这条是不是**分档表 / 配光表**？
            # 判据：**一个值都没被矩阵覆盖**。已覆盖的条款不是表 ——
            # 早先用「量值多、句子少」去判，把前位灯几何可见度（45°/20°/80°/
            # 750mm/12.5cm² 全在矩阵里）也当成了表，等于把已覆盖的量藏起来。
            if not (same_hits or other_hits or else_hits or dev_hits) and is_table_clause(body, vals):
                tables.append({
                    "clause": clause,
                    "device": dev_of(v, clause),
                    "page": obj.get("page", 0),
                    "note": "**结构上像表格，但未人工核定** —— 需要复核",
                    "values": sorted({("%g %s" % (x, u)) for x, u in vals}),
                })
                misses = [m for m in misses if m[0] != clause]
        # ── 条款号印在位图里的章节 ──────────────────────────────
        # GB 4785 草案第 4 章（一般要求）的条款号是位图，文本层一个「4.x」都
        # 读不到 —— 按条款扫描根本扫不到它，等于**整章隐形**。这里按页区间补扫。
        for ch, meta in (BITMAP_CHAPTERS.get(v) or {}).items():
            label = "第%s章（条款号在位图里）" % ch
            blob = bitmap_chapter_text(v, meta)
            if not blob.strip():
                continue
            vals = limits_in(blob)
            n_clause += 1
            seen = set()
            skip = {(round(float(a), 6), b) for a, b in (meta.get("skip") or [])}
            for val, unit in vals:
                key = (round(val, 6), unit)
                if key in skip:
                    continue
                cv = ls.canon_value(val, unit)
                ckey = (round(cv[1], 6), cv[0]) if cv else key
                if ckey in seen:
                    continue
                seen.add(ckey)
                n_value += 1
                hit = [x for x in anywhere[v] if same(val, unit, x[0], x[1])]
                if hit:
                    else_hits.append((label, key, hit[0][3]))
                else:
                    misses.append((label, key, meta.get("pages", [""])[0]))
        # ── 附录 / Annex ──────────────────────────────────────────
        # `clause_split.py` 只认「数字.数字」形态的条款号，附录是另一套编号
        # 体系 —— **附录从来没被扫过**。GB 两版的「随装载变化的倾斜度安全界限
        # 4 mrad（0.4%）」、三版的「自动切换近光响应时间 2s/5s/300s」都住在附录里。
        meta = ANNEXES.get(v)
        if meta:
            label = "%s（附录）" % meta.get("title", "附录")
            vals = limits_in(annex_text(v, meta))
            n_clause += 1
            skip = {(round(float(a), 6), b) for a, b in (meta.get("skip") or [])}
            seen = set()
            for val, unit in vals:
                key = (round(val, 6), unit)
                if key in skip:
                    continue
                cv = ls.canon_value(val, unit)
                ckey = (round(cv[1], 6), cv[0]) if cv else key
                if ckey in seen:
                    continue
                seen.add(ckey)
                n_value += 1
                hit = [x for x in anywhere[v] if same(val, unit, x[0], x[1])]
                if hit:
                    else_hits.append((label, key, hit[0][3]))
                else:
                    misses.append((label, key, meta.get("start", 0)))
        grand["same"] += len(same_hits)
        grand["other"] += len(other_hits)
        grand["elsewhere"] += len(else_hits)
        grand["otherdev"] += len(dev_hits)
        grand["miss"] += len(misses)
        print("=" * 92)
        print("【%s 版】含量值条款 %d · 限值 %d 个" % (v, n_clause, n_value))
        print("   同条款覆盖 %d · 同章别处 %d · 通用条款已覆盖 %d · **别装置顶替 %d** · **真漏 %d**"
              % (len(same_hits), len(other_hits), len(else_hits), len(dev_hits), len(misses)))
        for label, bucket in (("别装置顶替", dev_hits), ("真漏", misses)):
            if not bucket:
                continue
            bych = defaultdict(list)
            for m in bucket:
                bych[chapter_of(m[0])].append(m)
            print("  ── %s ──" % label)
            for chap in sorted(bych, key=_chap_key):
                ms = bych[chap]
                print("  §%s %s —— %d 个" % (chap, cis.device_of(v, chap), len(ms)))
                for clause, (val, unit), *rest in ms:
                    pg = rest[0] if rest else ""
                    print("      %-14s %-10s %-6s %s" % (clause, val, unit, pg))
        report.append((v, dev_hits, misses))
        out_json["versions"][v] = {
            "label": {"A": "GB 4785 草案 V4.3.5", "B": "GB 4785-2019",
                      "C": "UN R48-09"}[v],
            "clauses": n_clause,
            "limits": n_value,
            "same": len(same_hits),
            "otherChapter": len(other_hits),
            "general": len(else_hits),
            "otherDevice": len(dev_hits),
            "missing": len(misses),
            "missingItems": [
                {"clause": c, "value": ("%g" % k[0]), "unit": k[1], "page": p,
                 "device": dev_of(v, c)}
                for c, k, p in misses
            ],
            "tableShaped": tables,
            "outOfScope": oos,
            "mixedScope": mixed,
        }
    print("=" * 92)
    print("三版合计：同条款 %d · 同章别处 %d · 通用条款已覆盖 %d · **别装置顶替 %d** · **真漏 %d**"
          % (grand["same"], grand["other"], grand["elsewhere"], grand["otherdev"], grand["miss"]))
    out_json["totals"] = {
        "same": grand["same"], "otherChapter": grand["other"],
        "general": grand["elsewhere"], "otherDevice": grand["otherdev"],
        "missing": grand["miss"],
        "limits": sum(out_json["versions"][v]["limits"] for v in out_json["versions"]),
    }
    path = os.path.join(ROOT, "data", "coverage-audit.json")
    if "--check" in sys.argv:
        # 清单**不许过期**：重算一遍，和文件里的比。
        # 参数矩阵加了行、条款索引变了，这里就会不一致 —— 报告里的覆盖清单
        # 必须跟着一起变，否则客户拿到的数字是旧的。
        try:
            old = json.load(io.open(path, encoding="utf-8"))
        except Exception as e:
            print("读不到 %s：%s" % (path, e))
            return 1
        a = json.dumps(out_json.get("totals"), ensure_ascii=False, sort_keys=True)
        b = json.dumps(old.get("totals"), ensure_ascii=False, sort_keys=True)
        if a != b:
            print("覆盖清单已过期：")
            print("  现算：%s" % a)
            print("  文件：%s" % b)
            print("跑一次 python scripts/coverage_audit.py 更新。")
            return 1
        print("覆盖清单与现算一致：%s" % a)
        return 0
    io.open(path, "w", encoding="utf-8", newline="").write(
        json.dumps(out_json, ensure_ascii=False, indent=2) + chr(10))
    print("写入 %s" % os.path.relpath(path, ROOT))
    return report


if __name__ == "__main__":
    main()
