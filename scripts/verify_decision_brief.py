# -*- coding: utf-8 -*-
"""核验**决策正文**（客户 DR-016，P3）。

## 客户要的

> 「大量原文、矩阵和附录重复呈现」「决策信息被原文淹没」「客户难以快速定位优先动作」
> 修改建议：**拆成 20–30 页决策正文 + 证据附件，统一证据入口**

所以这一道闸门盯三件事：

1. **正文是 20–30 页** —— 短了是摘要不是正文，长了说明没拆开；
2. **正文里的每个数都跟附件一致** —— 正文是**从附件生成的**，
   附件改了而正文没重出，数字就会对不上（这是最可能的失效）；
3. **统一证据入口在** —— 正文最后那张「结论 → 附件位置」的表，
   而且**每一块结论都要在表里有一行**。

另外顺带查**近空白页**（正文里出现一页只有一两行，
读者拿到的是纸不是内容 —— 客户 DR-015 提过同样的毛病）。
"""
from __future__ import annotations

import io
import json
import re
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parent.parent
BRIEF_PDF = ROOT / "delivery" / "PDF对比" / "决策正文_最新.pdf"
MAIN_REPORT = ROOT / "reports" / "last-report.json"
DECISION_REPORT = ROOT / "reports" / "decision-report.json"

# 决策正文的**页眉**（每页都印着）—— 从声明取。
#
# 原来写死「GB 4785 多版本」：换标准后页眉换了，这条滤不掉 →
# 页眉被当正文 → 「近空白页」检查**悄悄变松**（正文行数变多 → 少报空页）。
_PACK = json.load(io.open(ROOT / "data" / "standard-pack.json", encoding="utf-8"))
BRIEF_HEADER = f"{_PACK['standardFamily']} 多版本"

MIN_PAGES = 20
MAX_PAGES = 30


def num(label: str, re_: str, text: str) -> int:
    m = re.search(re_, text)
    if not m:
        raise SystemExit(f"FAIL: 附件里取不到「{label}」—— 附件结构变了，先改取数逻辑")
    return int(m.group(1))


def main() -> int:
    errors: list[str] = []
    notes: list[str] = []

    if not BRIEF_PDF.exists():
        print(f"FAIL: 决策正文不存在（{BRIEF_PDF}）")
        return 1
    if not MAIN_REPORT.exists():
        print("FAIL: reports/last-report.json 不存在")
        return 1

    main_report = json.load(io.open(MAIN_REPORT, encoding="utf-8"))
    ch = {c["id"]: c for c in main_report.get("chapters") or []}
    md11 = ch.get(11, {}).get("markdown", "")
    md12 = ch.get(12, {}).get("markdown", "")
    md13 = ch.get(13, {}).get("markdown", "")
    md_exec = ch.get(0, {}).get("markdown", "")
    ledger = json.load(io.open(ROOT / "data" / "qualitative-ledger.json", encoding="utf-8"))

    n_changes = num("§11.0 条数", r"## 11\.0[\s\S]{0,400}?\*\*共 (\d+) 条。", md11)
    n_qo = num("§11.9 条数", r"本节列出 \*\*(\d+) 条\*\*已逐条回原文核验", md11)
    n_ac = num("§12.6 差异数", r"A 与 C 有实质差异的有 (\d+) 条", md12)
    n_colour = num("§13.6 光色相同", r"A/B/C 光色要素相同 \| \*\*(\d+)\*\* \|", md13)
    n_pending_colour = num("§13.6 光色待判读", r"表述不等价（未判定） \| \*\*(\d+)\*\* \|", md13)
    n_req = num("要求条数", r"三版合计 (\d+) 条要求条款里", md_exec)
    n_gap = num("真缺口", r"\*\*真缺口 (\d+) 条\*\*", md_exec)
    n_matrix = num("参数数", r"本章 (\d+) 个参数里", md12)
    n_ledger = len(ledger["entries"])
    n_sub = sum(1 for e in ledger["entries"] if e["verdict"].startswith("实质·"))
    n_pend = sum(1 for e in ledger["entries"] if e["verdict"] == "表述不等价·需人工判读")

    # ---- 1) 页数：20–30
    doc = fitz.open(str(BRIEF_PDF))
    pages = doc.page_count
    text = "\n".join(p.get_text() for p in doc)
    doc.close()
    if not (MIN_PAGES <= pages <= MAX_PAGES):
        errors.append(f"决策正文 {pages} 页 —— 客户要的是 {MIN_PAGES}–{MAX_PAGES} 页")
    notes.append(f"决策正文 {pages} 页（要求 {MIN_PAGES}–{MAX_PAGES}）")

    # ---- 2) 近空白页
    doc = fitz.open(str(BRIEF_PDF))
    blank = []
    for i, p in enumerate(doc):
        lines = [l for l in p.get_text().split("\n") if l.strip()]
        body = [
            l for l in lines
            if BRIEF_HEADER not in l
            and "汽车外部照明" not in l
            and not re.match(r"^\s*\d+\s*/\s*\d+\s*$", l)
        ]
        if len(body) <= 2:
            blank.append(i + 1)
    doc.close()
    if blank:
        errors.append(f"决策正文里有 {len(blank)} 页近空白页（正文 ≤ 2 行）：{blank[:8]}")
    notes.append(f"近空白页 {len(blank)}")

    # ---- 3) 正文里的数必须与附件一致（**防的是「附件改了、正文没重出」**）
    # PDF 里的粗体**不是星号**（渲染器把它变成字重），所以比对前把星号去掉。
    flat = re.sub(r"\s+", "", text).replace("*", "")
    must = [
        (f"{n_changes}条实质变化", "A→B 变化条数"),
        (f"台账**{n_ledger}条**义务面", "台账条数"),
        (f"**{n_sub}条实质差异**", "台账实质差异数"),
        (f"{n_pend}条机器判不出来", "待人工判读数"),
        (f"**{n_ac}条**主差异", "A–C 主差异数"),
        (f"{n_colour}个灯具三版光色要素相同", "光色相同数"),
        (f"{n_pending_colour}个**带例外条件", "光色待判读数"),
        (f"**{n_qo}条**（配备", "定性义务条数"),
        (f"**{n_matrix}个参数**", "参数数"),
        (f"台账**{n_req}条**要求条款", "要求台账条数"),
        (f"**真缺口{n_gap}条**", "真缺口数"),
    ]
    for needle, what in must:
        if re.sub(r"\s+", "", needle).replace("*", "") not in flat:
            errors.append(f"决策正文里没有「{what}」的当前值（{needle}）—— 正文可能没跟着附件重出")
    notes.append(f"正文数字核对 {len(must)} 项（与附件一致）")

    # ---- 4) 统一证据入口：每一块结论都要在表里有一行
    entry_markers = [
        ("A→B 的", "A→B 变化"),
        ("定性义务变化", "定性义务变化"),
        ("定性义务台账", "定性义务台账"),
        ("A–C 主差异", "A–C 主差异"),
        ("光色三版对照", "光色"),
        ("逐参数三版取值", "逐参数取值"),
        ("要求台账", "要求台账"),
    ]
    for needle, what in entry_markers:
        if re.sub(r"\s+", "", needle).replace("*", "") not in flat:
            errors.append(f"统一证据入口表里没有「{what}」这一行")
    if "证据入口" not in text:
        errors.append("决策正文里没有「证据入口」这一章")
    notes.append(f"统一证据入口 {len(entry_markers)} 项")

    # ---- 5) 决策正文必须是**从附件生成的**（不是手写的另一份）
    if DECISION_REPORT.exists():
        dr = json.load(io.open(DECISION_REPORT, encoding="utf-8"))
        md_all = "\n".join(c.get("markdown", "") for c in dr.get("chapters") or [])
        if f"**{n_changes} 条实质变化**" not in md_all:
            errors.append("reports/decision-report.json 里的数与附件对不上 —— 正文不是从附件生成的")
        if f"**{n_ac} 条**主差异" not in md_all:
            errors.append("reports/decision-report.json 里的 A–C 条数与附件对不上")
        notes.append("决策正文 JSON 与附件数字一致")
    else:
        errors.append("reports/decision-report.json 不存在 —— 决策正文不可复现")

    if errors:
        print("FAIL: 决策正文核验未通过")
        for e in errors:
            print("  -", e)
        return 1

    print("OK: 决策正文核验通过")
    for n in notes:
        print("  ·", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
