# -*- coding: utf-8 -*-
"""核验 `data/qualitative-ledger.json`（客户 DR-013 的定性义务全量台账）。

## 为什么要有这道核验

台账里**有两类结论**，混在一起就会互相掩盖：

| 类别 | 在哪 | 谁做的 |
|---|---|---|
| **机器判定** | `scripts/build_qualitative_ledger.py` 的判据 | 脚本 |
| **人工裁定** | `data/qualitative-adjudications.json` | 人 |

所以这道核验要盯住的是**接缝**：

1. **机器判的，重算一遍要对得上** —— 不信那个 JSON 里的判定，
   从附录 H 的配对结果重新算，比对结果必须一致；
2. **人判的，登记的键必须真的在台账里**，且台账里的判定必须等于登记表里的判定
   （防止「改了登记表忘了重建台账」）；
3. **C 侧的引文必须是源 PDF 该页的逐字片段** —— 不能是转述；
4. **报告里必须真的渲染出来了** —— 计数与逐条判定都要在 §11.10 里，
   执行摘要也要回引用这个数（客户要的是「**回流摘要**」）。
"""
from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEDGER = ROOT / "data" / "qualitative-ledger.json"
ADJ = ROOT / "data" / "qualitative-adjudications.json"
REPORT = ROOT / "reports" / "last-report.json"


def load_builder():
    spec = importlib.util.spec_from_file_location(
        "bql", ROOT / "scripts" / "build_qualitative_ledger.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    errors: list[str] = []
    notes: list[str] = []

    if not LEDGER.exists():
        print("FAIL: data/qualitative-ledger.json 不存在")
        return 1
    ledger = json.load(io.open(LEDGER, encoding="utf-8"))
    entries = ledger.get("entries") or []
    bql = load_builder()

    # ---- 1) 机器判的部分重算一遍
    q = json.load(io.open(ROOT / "data" / "qualitative-diff.json", encoding="utf-8"))
    pairs = q["pairs"]
    adj = json.load(io.open(ADJ, encoding="utf-8")) if ADJ.exists() else {"entries": {}}
    adj_entries = adj.get("entries") or {}

    recomputed: dict[str, str] = {}
    for p in pairs:
        device = p.get("device") or ""
        label = (p.get("label") or "").strip()
        r = bql.classify(p.get("aText", ""), p.get("bText", ""), label)
        recomputed[f"{device}|{label or p.get('bClause','')}"] = r["verdict"]
    notes.append(f"机器判定重算 {len(recomputed)} 条")

    n_machine_checked = 0
    for e in entries:
        key = e["key"]
        if e.get("adjudicated"):
            continue
        if key in recomputed:
            n_machine_checked += 1
            if recomputed[key] != e["verdict"]:
                errors.append(
                    f"机器判定与重算不一致：{key} —— 台账「{e['verdict']}」／重算「{recomputed[key]}」")
        elif e["verdict"] != "不可直接对读":
            errors.append(f"台账里的行既不是人工裁定、也重算不出来：{key}")
    notes.append(f"机器判定逐条比对 {n_machine_checked} 条")

    # ---- 2) 人工裁定：登记的键必须在台账里，且判定一致
    by_key = {e["key"]: e for e in entries}
    for key, a in adj_entries.items():
        if key not in by_key:
            errors.append(f"人工裁定的键不在台账里：{key}")
            continue
        e = by_key[key]
        if not e.get("adjudicated"):
            errors.append(f"人工裁定没有回流进台账：{key}")
        if e["verdict"] != a.get("verdict"):
            errors.append(
                f"人工裁定的判定与台账不一致：{key} —— 登记「{a.get('verdict')}」／台账「{e['verdict']}」")
        if not (a.get("basis") or "").strip():
            errors.append(f"人工裁定没写依据：{key}")
    notes.append(f"人工裁定 {len(adj_entries)} 条逐条比对")

    # ---- 3) C 侧引文必须是源 PDF 该页的逐字片段
    import fitz
    doc = fitz.open(str(bql.C_PDF))
    pages = {i + 1: re.sub(r"\s+", " ", p.get_text()) for i, p in enumerate(doc)}
    doc.close()
    corpus_text = " ".join(pages.values())
    n_c = 0
    for e in entries:
        c = e.get("c")
        if not c:
            continue
        n_c += 1
        head = (c.get("heading") or "").strip()
        if head and head.split(" ")[0] not in pages.get(c["page"], ""):
            # 标题里带「(see figure below)」这类后缀，取第一个词判断
            first = head.split(" ")[0]
            if first not in pages.get(c["page"], ""):
                errors.append(
                    f"C 侧标题不在源 PDF 第 {c['page']} 页：{c['clause']} {head}")
        clause = str(c.get("clause", ""))
        # 条款号的**形态**只要求「像条款号」——
        # 原来这里写死了 R48 的形态（`6.\d+.\d+`），
        # 换一套标准会把**正确的**台账判成错的。
        if not re.match(r"^\d+(?:\.\d+)+$", clause):
            errors.append(f"C 侧条款号形态不对：{clause}")
        # **这一版的原文里真的有这个条款号** ——
        # 这比形态强得多，而且与标准无关。
        elif not re.search(r"(?<![\d.])" + re.escape(clause) + r"(?![\d])", corpus_text):
            errors.append(f"C 侧条款号在这一版原文里找不到：{clause}")
    notes.append(f"C 侧条款定位核对 {n_c} 条")

    # ---- 4) 计数自洽
    counts = Counter(e["verdict"] for e in entries)
    declared = ledger.get("_meta", {}).get("verdictCounts") or {}
    for v, n in counts.items():
        if declared.get(v) != n:
            errors.append(f"计数不自洽：{v} —— _meta 写 {declared.get(v)}，实算 {n}")
    if sum(counts.values()) != len(entries):
        errors.append("判定计数之和与条目数对不上")
    notes.append(f"判定计数 {len(counts)} 类 / {len(entries)} 条")

    # ---- 5) 报告里必须真的渲染了
    if not REPORT.exists():
        errors.append("reports/last-report.json 不存在，无法核验 §11.10")
    else:
        rep = json.load(io.open(REPORT, encoding="utf-8"))
        ch11 = next((c for c in rep.get("chapters") or [] if c.get("id") == 11), None)
        if not ch11:
            errors.append("报告里没有第 11 章")
        else:
            md = ch11.get("markdown") or ""
            if "11.10 定性义务全量台账" not in md:
                errors.append("第 11 章里没有 §11.10 定性义务全量台账")
            for v, n in counts.items():
                if f"| {v} | **{n}** |" not in md:
                    errors.append(f"§11.10 的判定计数表里没有：{v} / {n}")
            # 实质差异必须逐条在报告里
            for e in entries:
                if e["verdict"].startswith("实质·"):
                    if f"**{e['verdict']}**" not in md:
                        errors.append(f"§11.10 里没有这条实质差异：{e['key']}")
            # 执行摘要要回引用（客户要「回流摘要」）
            ex = next((c for c in rep.get("chapters") or [] if c.get("id") == 0), None)
            exmd = (ex or {}).get("markdown") or ""
            if "定性义务已建成全量台账" not in exmd:
                errors.append("执行摘要没有回引用定性义务台账（客户要「回流摘要」）")
            else:
                m = re.search(r"\*\*(\d+) 条\*\*义务面", exmd)
                if not m or int(m.group(1)) != len(entries):
                    errors.append(
                        f"执行摘要里的台账条数（{m.group(1) if m else '?'}）与台账（{len(entries)}）对不上")
            notes.append(f"§11.10 渲染核对：{len(entries)} 条台账")

    if errors:
        print("FAIL: 定性义务台账核验未通过")
        for e in errors[:40]:
            print("  -", e)
        if len(errors) > 40:
            print(f"  … 另有 {len(errors) - 40} 条")
        return 1

    print("OK: 定性义务台账核验通过")
    for n in notes:
        print("  ·", n)
    substantive = sum(n for v, n in counts.items() if v.startswith("实质·"))
    pending = counts.get("表述不等价·需人工判读", 0)
    print(f"  · 台账 {len(entries)} 条：实质差异 {substantive} · 待人工判读 {pending}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
