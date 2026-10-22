# -*- coding: utf-8 -*-
"""**要求级清点** —— 把「没有缺少」的保证，从「可量化」那一半补到全部。

为什么要有这个
--------------
覆盖审计（`scripts/coverage_audit.py`）统计的单位是**一条限值**，
而限值是解析器 `limit_scan` **认出来**的。所以「真缺口 0」的准确含义是：

    在解析器看得见的那个集合里，没有缺口。

它是个**条件句**。定性要求（「应当自动切换」「不得使用暖白色光源」
这类**无数值**的要求）根本不参与统计 —— 它们不参与，
就既没被证明在，也没被证明缺。实测：

    A：要求条款 54+（其中无数值 38）· B：36（19）· C：331（233）

这一轮把它补上：每一条要求条款都要**有处置**。

处置口径
--------
| 处置 | 含义 |
|---|---|
| `已覆盖` | 报告里**明确引用了这一条**（矩阵格 / 主题列 / 覆盖清单 / 章内引文） |
| `同章别处` | 报告讲了这一章，但没讲这一条（**弱**，差在哪要能说清） |
| `不适用` | 不是产品要求（批准程序 / 标志 / 生产一致性 / 过渡），**登记理由** |
| `真缺口` | 是产品要求，报告里**一条都没说** |

「不适用」登记在 `data/requirement-scope.json`（按章登记理由，展开到条款），
「真缺口」登记在 `data/requirement-gaps.json`（逐条写明为什么本版不覆盖）。
**两处都必须写理由** —— 登记是让人能核对，不是消账。

用法： python scripts/requirement_ledger.py [--write]
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if not os.path.isdir(os.path.join(ROOT, "scripts")):
    ROOT = os.path.dirname(os.path.abspath(__file__))

SCOPE_PATH = os.path.join(ROOT, "data", "requirement-scope.json")
GAPS_PATH = os.path.join(ROOT, "data", "requirement-gaps.json")
OUT_PATH = os.path.join(ROOT, "data", "requirement-ledger.json")
BITMAP_PATH = os.path.join(ROOT, "data", "clause-bitmap-fixes.json")


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

# 要求语：产品/装置层面的「应当/必须/不得」
REQ = re.compile(
    r"应当|应该|必须|不得|不应|须符合|须安装|须采用|shall|must|should|is required|shall be"
)
# 范围 / 引用文件 / 术语 —— 不是要求，是定义
SKIP_CHAPTER = re.compile(r"^(1|2|3)(\.|$)")
LIMIT = re.compile(
    r"\d+(?:\.\d+)?\s*(?:mm|cm|m\b|cd|lx|lm|%|°|Hz|km\s*/\s*h|次|分钟|秒|s\b|㎟|㎡|N|J|W|V|A|kg)"
)


def clause_refs(text: str) -> set:
    """正文里出现的条款号（5.2.4.2 这种）。"""
    return set(re.findall(r"\b\d{1,2}(?:\.\d{1,4}){1,4}\b", text or ""))


_PUNCT_MAP = {"，": ",", "；": ";", "：": ":", "、": ",", "（": "(", "）": ")",
              "。": ".", "．": ".", "～": "~", "–": "-", "—": "-"}


def _norm_body(s: str) -> str:
    """归一化正文：去空白 + 统一标点 + 小写（比对用）。"""
    s = re.sub(r"\s+", "", s or "")
    for a, b in _PUNCT_MAP.items():
        s = s.replace(a, b)
    return s.lower()


def collect_report_text(rep) -> dict:
    """报告正文（按版本分）—— 用于「内容是否在报告里」的判定。

    报告里 A/B/C 三版的正文**混在一起**（章节级对照表三列并排），
    所以按版本分开是不准确的 —— 这里给一个**不分版本**的合集，
    判定时用「这一条的正文在任何一版里出现过」这一条即可：
    条款正文足够独特，撞到别的版本上的概率极低，
    而把版本分错的风险（判成「没覆盖」）远大于撞车。
    """
    parts = []
    for ch in rep.get("chapters") or []:
        parts.append(ch.get("markdown") or "")
    for ap in rep.get("appendices") or []:
        # **附录 E 必须排除** —— 它是这份台账自己的输出：
        # E.5.1 逐条列出的原文会被当成「报告里有这条」，
        # E.5.2 的弱覆盖清单同理。那是**循环论证**：
        # 台账说「这条已覆盖」，理由是台账自己刚把它写进了报告。
        if str(ap.get("id") or "").upper() == "E":
            continue
        parts.append(ap.get("markdown") or "")
    return {"_all": _norm_body("\n".join(parts))}


def content_in_report(excerpt: str, report_text: dict) -> int:
    """这一条的正文在报告里吗？返回最长连续命中长度（0 = 没出现）。

    条款号本身**不作为证据**（先剥掉）—— 否则「5.7.9.1」在报告里出现
    就等于说它的内容被覆盖了，那是拿编号冒充内容。
    """
    ex = _norm_body(excerpt or "")
    ex = re.sub(r"gb4785[—-]x{3,}\d*", "", ex)
    ex = re.sub(r"\d+(?:\.\d+)*", " ", ex)
    ex = re.sub(r"\s+", "", ex)
    if len(ex) < 12:
        return 0
    body = report_text.get("_all", "")
    best = 0
    for L in (40, 30, 24, 18):
        if len(ex) < L:
            continue
        step = max(1, L // 4)
        for s in range(0, max(1, len(ex) - L), step):
            frag = ex[s : s + L]
            if frag and frag in body:
                return L
    return best


def collect_report_refs(rep, facts, audit) -> dict:
    """报告里**引用过的条款号**，按版本分。

    来源有四处，缺一不可：
      1. 参数矩阵每一格的 clause（915 格）
      2. 主题对照列的 clause（24 主题 × 3 版）
      3. 覆盖清单里的条款（附录 E 的 938 条限值的归属）
      4. 各章的原文摘录里出现的条款号（章节级 A/B/C 对照）
    """
    refs = {"A": set(), "B": set(), "C": set()}

    for r in rep.get("parameterMatrix") or []:
        for v in ("A", "B", "C"):
            c = (r.get("cells") or {}).get(v) or {}
            cl = str(c.get("clause") or "").strip()
            if cl:
                refs[v].add(cl)

    for t in facts.get("topicColumns") or []:
        for v in ("A", "B", "C"):
            col = t.get(v) or {}
            cl = str(col.get("clause") or "").strip()
            if cl:
                refs[v].add(cl)

    for v, block in (audit.get("versions") or {}).items():
        for lst in ("sameHits", "otherHits", "elseHits"):
            for h in block.get(lst) or []:
                cl = str((h or {}).get("clause") or "").strip()
                if cl:
                    refs.setdefault(v, set()).add(cl)

    # 各章的原文摘录里的条款号 —— 版本分不开，就当三版都提到过
    any_refs = set()
    for ch in rep.get("chapters") or []:
        any_refs |= clause_refs(ch.get("markdown") or "")
    for v in refs:
        refs[v] |= any_refs
    return refs


def excerpt_of(body: str, limit: int = 320) -> str:
    """条款正文摘录 —— 去掉首行的条款号，拼成一段，供附录逐条列出。"""
    t = (body or "").strip()
    if not t:
        return ""
    lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
    if lines and re.fullmatch(r"\d+(\.\d+)*\.?", lines[0]):
        lines = lines[1:]
    out = " ".join(lines)
    # 有些条款的编号与正文在同一行（「19 当移动部件不处于…」）—— 同样剥掉
    out = re.sub(r"^\d+(?:\.\d+)*\.?\s+", "", out)
    out = re.sub(r"\s+", " ", out).strip()
    return out[:limit] + ("…" if len(out) > limit else "")


def ancestor_chain(clause: str) -> list:
    parts = clause.split(".")
    return [".".join(parts[:i]) for i in range(2, len(parts) + 1)]


def bitmap_clauses():
    """条款号印在位图里的章节 —— 从登记表取条款号与标题。

    这些条款**不在条款索引里**（文本层读不到条款号），
    但它们的要求是真实存在的 —— ⑲ 时整章对审计隐形，就是这个原因。
    登记表的 note 里带标题（「本条对应第 4 章的「标题」」），
    标题本身就是要求的摘要，够判「是不是一条要求」。
    """
    if not os.path.exists(BITMAP_PATH):
        return {}
    doc = json.load(io.open(BITMAP_PATH, encoding="utf-8"))
    out = {}
    for v, entries in doc.items():
        if not isinstance(entries, dict):
            continue
        for cl, note in entries.items():
            if not isinstance(note, str) or not re.fullmatch(r"\d+(\.\d+)*", cl):
                continue
            m = re.search(r"「([^」]+)」", note)
            title = m.group(1) if m else ""
            pm = re.search(r"源 PDF p(\d+)", note)
            page = int(pm.group(1)) if pm else 0
            out.setdefault(v, {})[cl] = (title, page)
    return out


def main():
    write = "--write" in sys.argv
    docs = cs.pick_docs()
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    facts_path = os.path.join(ROOT, "dist", "facts.json")
    facts = json.load(io.open(facts_path, encoding="utf-8")) if os.path.exists(facts_path) else {}
    audit_path = os.path.join(ROOT, "data", "coverage-audit.json")
    audit = json.load(io.open(audit_path, encoding="utf-8")) if os.path.exists(audit_path) else {}

    scope = json.load(io.open(SCOPE_PATH, encoding="utf-8")) if os.path.exists(SCOPE_PATH) else {}
    gaps_reg = json.load(io.open(GAPS_PATH, encoding="utf-8")) if os.path.exists(GAPS_PATH) else {}
    registered_gaps = set()
    gap_reasons = {}
    for g in (gaps_reg.get("gaps") or []):
        if isinstance(g, dict):
            key = "%s|%s" % (g.get("version"), g.get("clause"))
            registered_gaps.add(key)
            gap_reasons[key] = g.get("reason") or "（未写理由）"
        else:
            registered_gaps.add(str(g))

    refs = collect_report_refs(rep, facts, audit)
    report_text = collect_report_text(rep)
    bitmap = bitmap_clauses()

    rows = []
    totals = {"requirements": 0, "covered": 0, "appendixListed": 0, "weak": 0,
              "notApplicable": 0, "gaps": 0, "quoted": 0}
    for v in cs.ordered_versions(docs):
        idx = cs.split_clauses(docs[v])
        vrefs = refs.get(v, set())
        vscope = scope.get(v) or []
        # 位图章节的条款不进索引 —— 单独补进来
        clauses = {}
        for k, o in idx.items():
            clauses[k] = (o.get("body", "") or "", (o.get("head") or "")[:120],
                          int(o.get("page") or 0))
        for cl, (title, page) in (bitmap.get(v) or {}).items():
            if cl not in clauses:
                clauses[cl] = (title, title, page)
        for k in sorted(clauses, key=lambda x: [int(p) if p.isdigit() else 0 for p in x.split(".")]):
            body, head, page = clauses[k]
            if not REQ.search(body) or len(body) < 12:
                continue
            if SKIP_CHAPTER.match(k):
                continue
            totals["requirements"] += 1
            has_limit = bool(LIMIT.search(body))
            na = None
            for entry in vscope:
                if k in (entry.get("clauses") or []) or (
                    entry.get("chapters") and k.split(".")[0] in entry.get("chapters")
                ):
                    na = entry.get("reason") or "（未写理由）"
                    break
            gkey = f"{v}|{k}"
            # 用**发布出去的那段摘录**判定，不是条款全文 ——
            # 客户在报告里看到的是摘录，判据必须与之一致。
            excerpt = excerpt_of(body)
            hit = content_in_report(excerpt, report_text)
            if na:
                disp = "不适用"
                totals["notApplicable"] += 1
            elif k in vrefs:
                disp = "已覆盖"
                totals["covered"] += 1
            elif gkey in registered_gaps:
                # 登记过的：附录 E.5.1 会**逐条列出原文 + 页码 + 理由**，
                # 所以它在报告里是有内容的 —— 不是「没有」，是「没进矩阵」。
                # 这一档**优先于**「已引原文」：E.5.1 的列出比「顺带被引到」
                # 给客户的东西更多（多了理由与页码）。
                disp = "附录逐条"
                totals["appendixListed"] += 1
                na = gap_reasons.get(gkey, "")
            elif hit >= 24:
                # **原文已在报告里**，只是这一条的编号没单独出现
                # （报告引用父条款时长摘录把子条款正文一并带进去了）。
                # 这不是弱覆盖 —— 客户能在报告里找到这段话。
                # 但也**不是**「明确覆盖」：报告没有按它的编号索引。
                disp = "已引原文"
                totals["quoted"] += 1
            elif any(a in vrefs for a in ancestor_chain(k)):
                disp = "同章别处"
                totals["weak"] += 1
            else:
                disp = "真缺口"
                totals["gaps"] += 1
            rows.append({
                "version": v,
                "clause": k,
                "head": head[:120],
                "page": page,
                "excerpt": excerpt,
                "hasLimit": has_limit,
                "disposition": disp,
                "reason": na or "",
                # 「已引原文」时记下命中的长度 —— 用来向客户说明
                # 「报告里确实有这段原文，命中 N 字连续片段」
                "quotedMatch": hit if disp == "已引原文" else 0,
            })

    out = {"generatedAt": None, "totals": totals, "rows": rows}
    lines = []
    for v in cs.ordered_versions(docs):
        sub = [r for r in rows if r["version"] == v]
        c = {}
        for r in sub:
            c[r["disposition"]] = c.get(r["disposition"], 0) + 1
        lines.append("【%s 版】要求条款 %d 条：%s" % (
            v, len(sub), " · ".join("%s %d" % (k, n) for k, n in sorted(c.items()))))
    lines.append("")
    lines.append("合计：要求条款 %d · 已覆盖 %d · 附录逐条 %d · 已引原文 %d · 同章别处 %d · 不适用 %d · 真缺口 %d"
                 % (totals["requirements"], totals["covered"], totals["appendixListed"],
                    totals.get("quoted", 0), totals["weak"],
                    totals["notApplicable"], totals["gaps"]))
    gap_rows = [r for r in rows if r["disposition"].startswith("真缺口")]
    if gap_rows:
        lines.append("")
        lines.append("真缺口明细（产品要求，报告里没提）：")
        for r in gap_rows:
            lines.append("   · %s §%s  %s" % (r["version"], r["clause"], r["head"][:70]))

    print("\n".join(lines))
    if "--verify-quoted" in sys.argv:
        # 逐条复核「已引原文」这一档 —— 那一档说「原文在报告里」，
        # 客户按号回查要能查到。**只有这一份实现**：
        # 闸门调它，不再用 JS 重写一遍归一化（那样会与本文件不一致）。
        missing = []
        checked = 0
        for r in rows:
            if r["disposition"] != "已引原文":
                continue
            checked += 1
            if content_in_report(r.get("excerpt", ""), report_text) < 24:
                missing.append(f"{r['version']} §{r['clause']}")
        print(
            "「已引原文」复核：%d 条逐条回报告搜过 · %d 条搜不到"
            % (checked, len(missing))
        )
        for m in missing[:20]:
            print("   ✗ " + m)
        if missing:
            print(
                "✗ 这些被标成「已引原文」但报告里搜不到 —— "
                "那一档是对客户的承诺，说了就要做到"
            )
            return 1
        print("✓ 全部搜到")
        return 0
    if "--check" in sys.argv:
        # 台账**不许过期**：重算一遍，和文件里的比。
        # 矩阵加了行、条款索引变了、登记改了，这里就会不一致 ——
        # 报告附录 E.5 印着的「23 条未逐条讲」必须是现算的那个数。
        try:
            old = json.load(io.open(OUT_PATH, encoding="utf-8"))
        except Exception as e:
            print("读不到 %s：%s" % (OUT_PATH, e))
            return 1
        a = json.dumps(totals, ensure_ascii=False, sort_keys=True)
        b = json.dumps(old.get("totals"), ensure_ascii=False, sort_keys=True)
        if a != b:
            print("要求台账已过期：")
            print("  现算：%s" % a)
            print("  文件：%s" % b)
            print("跑一次 python scripts/requirement_ledger.py --write 更新。")
            return 1
        print("要求台账与现算一致：%s" % a)
        return 0
    if write:
        io.open(OUT_PATH, "w", encoding="utf-8", newline="").write(
            json.dumps(out, ensure_ascii=False, indent=1) + "\n")
        print("已写出 %s" % OUT_PATH)

    unregistered = [r for r in gap_rows if r["disposition"] == "真缺口"]
    if unregistered:
        print("\n!! %d 条真缺口没有登记理由（登记在 data/requirement-gaps.json）" % len(unregistered))
    return 1 if unregistered else 0


if __name__ == "__main__":
    sys.exit(main())
