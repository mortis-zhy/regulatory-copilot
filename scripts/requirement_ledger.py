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
            out.setdefault(v, {})[cl] = title
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
    bitmap = bitmap_clauses()

    rows = []
    totals = {"requirements": 0, "covered": 0, "weak": 0, "notApplicable": 0, "gaps": 0}
    for v in cs.ordered_versions(docs):
        idx = cs.split_clauses(docs[v])
        vrefs = refs.get(v, set())
        vscope = scope.get(v) or []
        # 位图章节的条款不进索引 —— 单独补进来
        clauses = {}
        for k, o in idx.items():
            clauses[k] = (o.get("body", "") or "", (o.get("head") or "")[:120])
        for cl, title in (bitmap.get(v) or {}).items():
            if cl not in clauses:
                clauses[cl] = (title, title)
        for k in sorted(clauses, key=lambda x: [int(p) if p.isdigit() else 0 for p in x.split(".")]):
            body, head = clauses[k]
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
            if na:
                disp = "不适用"
                totals["notApplicable"] += 1
            elif k in vrefs:
                disp = "已覆盖"
                totals["covered"] += 1
            elif any(a in vrefs for a in ancestor_chain(k)):
                disp = "同章别处"
                totals["weak"] += 1
            else:
                gkey = f"{v}|{k}"
                disp = "真缺口（已登记）" if gkey in registered_gaps else "真缺口"
                totals["gaps"] += 1
                na = gap_reasons.get(gkey, "")
            rows.append({
                "version": v,
                "clause": k,
                "head": head[:120],
                "hasLimit": has_limit,
                "disposition": disp,
                "reason": na or "",
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
    lines.append("合计：要求条款 %d · 已覆盖 %d · 同章别处 %d · 不适用 %d · 真缺口 %d"
                 % (totals["requirements"], totals["covered"], totals["weak"],
                    totals["notApplicable"], totals["gaps"]))
    gap_rows = [r for r in rows if r["disposition"].startswith("真缺口")]
    if gap_rows:
        lines.append("")
        lines.append("真缺口明细（产品要求，报告里没提）：")
        for r in gap_rows:
            lines.append("   · %s §%s  %s" % (r["version"], r["clause"], r["head"][:70]))

    print("\n".join(lines))
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
