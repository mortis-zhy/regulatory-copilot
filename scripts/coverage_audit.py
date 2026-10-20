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

UNIT_ALIAS = {
    "mm": "mm", "㎜": "mm", "cm": "cm", "cd": "cd", "hz": "Hz",
    "km/h": "km/h", "°": "°", "º": "°", "%": "%", "v": "V", "lx": "lx", "nm": "Nm",
    "cm²": "cm²", "cm2": "cm²", "mm²": "mm²", "mm2": "mm²", "㎝": "cm²",
    # 英文单位（R48 写 degree / lux / lumen / second）
    "degree": "°", "degrees": "°", "lux": "lx", "lumen": "lm", "lumens": "lm",
    "second": "s", "seconds": "s", "min": "min", "minute": "min", "minutes": "min",
    "cd/m²": "cd/m²", "cd/m2": "cd/m²", "min": "min", "s": "s",
}
LIMIT_UNITS = {"mm", "cm", "cd", "Hz", "km/h", "°", "%", "V", "lx", "Nm",
               "cm²", "mm²", "cd/m²", "min", "s", "lm"}
VAL = re.compile(
    # 前瞻①：数字不能紧跟在字母/破折号后面 —— 否则页脚「GB4785—2019」里的
    #   2019 会被并进下一个数（"2019 12.5cm" → 201912.5）。
    #   ASCII 连字符不在排除表里，因为那是负号（-0.5%）。
    r"(?<![\d.])(?<![A-Za-z—–])(\d+(?:[ ,]\d+)*(?:\.\d+)?)\s*"
    # 单位：cd/m² 必须排在 cd 前面；°C 不能当成 °（前瞻②）。
    # 单位后面**不能紧跟 ASCII 字母或数字**（否则 12.5cm2 会被读成 cm）。
    # 但**中文要放行** —— Python 的 \w 含汉字，早先用 (?![\w°]) 的话
    # 「7000lx时」「30º至60º」全都检不出来，量值就这么被漏掉了。
    r"(cd\s*/\s*m\s*(?:2|²)|mm\s*(?:2|²)|cm\s*(?:2|²)|mm|㎜|㎝|cm|cd|Hz|km\s*/\s*h|kmh|°|º|%|V|W|lx|Nm|min|s|degrees?|lux|lumens?|seconds?)(?![A-Za-z0-9°º])"
    r"(?:\s*per\s*cent)?",
    re.I,
)
NOT_A_LIMIT = re.compile(
    r"(?:GB/T|GB|ISO|IEC|UN|ECE|第|类|条|款|章|附录|图|表|共|计|其余|其中|符合)\s*$"
)
# GB 2019 的 PDF 把每个数字都拆开：「12.\n5cm」「0.\n1%」「-1.\n0%」。
# 不先把它拼回去，审计器会把 12.5cm 读成 5cm —— 假漏 + 假命中一起来。
BROKEN_NUM = re.compile(r"(?<=\d)\s*\.\s*(?=\d)")
# 过渡条款（Chapter 12）与温度不是灯光限值。
SKIP_BODY = re.compile(r"Transitional provisions|shall no longer be recognized|"
                       r"in the event of the approval of a lamp", re.I)


def parse_num(raw):
    s = raw.replace(" ", "")
    if "," in s:
        a, _, b = s.partition(",")
        s = ("%s.%s" % (a, b)) if len(b) != 3 else a + b
    return float(s)


def unit_of(u, tail=""):
    if not u:
        return ""
    k = re.sub(r"\s+", "", u).lower().replace("kmh", "km/h")
    k = k.replace("cd/m2", "cd/m²").replace("cm2", "cm²").replace("mm2", "mm²")
    # 只有完整的「per cent」才算百分号 —— 「per lamp」不是。
    if re.match(r"\s*per\s*cent\b", tail or "", re.I):
        return "%"
    return UNIT_ALIAS.get(k, k)


def limits_in(body):
    """条款正文里的**限值** (值, 单位)。"""
    clean = BROKEN_NUM.sub(".", re.sub(r"\s+", " ", body))
    out = []
    for m in VAL.finditer(clean):
        raw = m.group(1)
        unit = unit_of(m.group(2), clean[m.end(2):m.end(2) + 12])
        if unit not in LIMIT_UNITS:
            continue
        try:
            v = parse_num(raw)
        except ValueError:
            continue
        before = clean[max(0, m.start() - 12):m.start()]
        if NOT_A_LIMIT.search(before):
            continue
        # 「2 V 级近光模式」里的 V 是**等级字母**，不是伏特；
        # 「13.5V」/「24 V」才是电压。判据：单位后面紧跟汉字就不是量值单位。
        if unit in ("V", "W") and re.match(r"\s*[一-鿿]", clean[m.end():m.end() + 3]):
            continue
        out.append((v, unit))
    return out


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


def main():
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    TABLES = load_tables()
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    by_clause, by_chapter, anywhere = {}, {}, {}
    for v in ("A", "B", "C"):
        bc, bch, an = defaultdict(list), defaultdict(list), defaultdict(list)
        for r in rows:
            c = r["cells"].get(v, {})
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            unit = (r.get("unit") or "").strip()
            for n in c.get("nums", []):
                try:
                    f = parse_num(str(n))
                except ValueError:
                    continue
                item = (round(f, 6), unit, r["id"], r["name"], cl)
                an[(round(f, 6), unit)].append(item)
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
            if cur:
                if cur.get("kind") == "outOfScope":
                    oos.append({"clause": clause, "note": cur.get("note", "")})
                else:
                    tables.append({
                        "clause": clause,
                        "device": dev_of(v, clause),
                        "page": obj.get("page", 0),
                        "note": cur.get("note", ""),
                        "values": sorted({("%g %s" % (x, u)) for x, u in limits_in(body)}),
                    })
                continue
            vals = limits_in(body)
            if not vals:
                continue
            n_clause += 1
            dev = cis.device_of(v, clause)
            seen = set()
            for val, unit in vals:
                key = (round(val, 6), unit)
                if key in seen:
                    continue
                seen.add(key)
                n_value += 1
                exact = [x for x in by_clause[v].get(clause, [])
                         if x[0] == key[0] and (not unit or not x[1] or x[1] == unit)]
                loose = [x for x in by_clause[v].get(clause, []) if x[0] == key[0]]
                if exact or loose:
                    same_hits.append((clause, key, (exact or loose)[0][3]))
                    continue
                near = [x for x in by_chapter[v].get(chapter_of(clause), [])
                        if x[0] == key[0] and (not unit or not x[1] or x[1] == unit)]
                if near:
                    other_hits.append((clause, key, near[0][3]))
                    continue
                cands = anywhere[v].get(key) or \
                    [x for x in anywhere[v].get((key[0], ""), []) if not unit or not x[1] or x[1] == unit]
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
            for chap in sorted(bych, key=lambda k: [int(x) for x in k.split(".")]):
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
