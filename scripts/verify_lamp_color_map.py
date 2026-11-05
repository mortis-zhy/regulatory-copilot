# -*- coding: utf-8 -*-
"""核验 `data/lamp-color-map.json`（客户 DR-011 的灯具光色三版映射）。

## 为什么要有这道核验

`data/lamp-color-map.json` 是**人工判定的对照表** —— 人工结论最容易出的问题是
「改了 JSON 里的对应关系，没人发现」。

所以这道核验**不信那个 JSON 里的对应关系**，而是**从源 PDF 重新算一遍**：

| 核验项 | 怎么判 |
|---|---|
| C 的每段引文 | 必须是源 PDF 该页的**逐字**片段（空白归一化后） |
| C 的行是否全 | 源 PDF §5.15 的每一行都要有归属（配对 / C 独有 / 印刷异常） |
| GB 的行是否全 | A/B 表5 的每一行都要有归属（配对 / GB 独有） |
| GB ↔ C 的对应 | **与 GB 自己的术语表交叉核对**：逐字命中的必须真的命中；词形不同必须写了理由 |
| 报告里有没有 | 第 13 章必须真的把这张表渲染出来 —— 一行都不能少 |

最后一项最要紧：**数据文件对、报告没渲染**，跟没做是一回事。
"""
from __future__ import annotations

import importlib.util
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAP = ROOT / "data" / "lamp-color-map.json"
REPORT = ROOT / "reports" / "last-report.json"


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "blcm", ROOT / "scripts" / "build_lamp_color_map.py"
    )
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    errors: list[str] = []
    notes: list[str] = []

    if not MAP.exists():
        print("FAIL: data/lamp-color-map.json 不存在")
        return 1
    data = json.load(io.open(MAP, encoding="utf-8"))
    blcm = load_generator()

    rows = data.get("rows") or []
    gb_only = data.get("gbOnly") or []
    c_only = data.get("cOnly") or []
    anomalies = data.get("anomalies") or []

    # ---- 1) 重新抽一遍 C 版 §5.15，逐行核对
    c_rows = blcm.extract_c_rows()
    by_name: dict[str, dict] = {}
    for r in c_rows:
        if r["cName"] not in by_name or not r.get("_noColon"):
            by_name[r["cName"]] = r
    dupes = [r for r in c_rows if r.get("_noColon")]

    def quote_of(r: dict) -> str:
        return blcm.collapse(" ".join(r["_parts"]))

    covered_c: dict[str, str] = {}
    for r in rows:
        covered_c[r["cName"]] = "rows"
    for c in c_only:
        covered_c[c["cName"]] = "cOnly"
    for a in anomalies:
        covered_c[a["cName"]] = "anomalies"

    for r in c_rows:
        if r["cName"] not in covered_c:
            errors.append(f"源 PDF §5.15 的行没归属：{r['cName']}（p{r['cPage']}）")
    # 反向：JSON 里不能有源 PDF 里没有的行
    src_names = {r["cName"] for r in c_rows}
    for name in covered_c:
        if name not in src_names:
            errors.append(f"JSON 里的行在源 PDF §5.15 中不存在：{name}")

    # ---- 2) 每段引文必须是源 PDF 该页的逐字片段
    import fitz
    doc = fitz.open(str(blcm.C_PDF))
    page_text = {p: blcm.collapse(doc[p - 1].get_text()) for p in blcm.C_PAGES}
    doc.close()
    n_quote = 0
    for r in rows + c_only:
        q = r["cQuote"]
        n_quote += 1
        if q not in page_text[r["cPage"]]:
            errors.append(
                f"引文不是源 PDF 第 {r['cPage']} 页的逐字片段：{r['cName']} —— 「{q[:50]}…」"
            )
        if blcm.tidy_name(r["cName"]) not in blcm.tidy_name(q):
            errors.append(f"引文里没有灯名：{r['cName']}")
        if r["cColourClean"] and blcm.tidy_name(r["cColourClean"]).rstrip(".") not in blcm.tidy_name(q):
            errors.append(f"引文里没有光色原文：{r['cName']} / {r['cColourClean'][:40]}")
    for a in anomalies:
        n_quote += 1
        if a["cQuote"] not in page_text[a["cPage"]]:
            errors.append(f"印刷异常的照录不是逐字片段：{a['cName']}")
    notes.append(f"引文逐字核对 {n_quote} 条")

    # ---- 3) GB 侧每一行都要有归属
    gb = blcm.read_gb_rows()
    gb_names = {blcm.norm_gb(n) for v in ("A", "B") for n in gb[v]}
    mapped_gb = {blcm.norm_gb(r["gb"]) for r in rows} | \
                {blcm.norm_gb(g["gb"]) for g in gb_only}
    for n in sorted(gb_names - mapped_gb):
        errors.append(f"GB 表5 里的行没归属：{n}")
    for n in sorted(mapped_gb - gb_names):
        errors.append(f"映射表里的 GB 行在表5 中不存在：{n}")
    notes.append(f"GB 表5 行 {len(gb_names)} 行全部有归属")

    # ---- 4) 与 GB 自己的术语表交叉核对
    terms_a = blcm.extract_gb_terms(blcm.A_PDF)
    terms_b = blcm.extract_gb_terms(blcm.B_PDF)
    n_literal = 0
    for r in rows:
        t = r.get("gbTerm") or {}
        mode = t.get("mode")
        clause = t.get("clause") or ""
        en = t.get("en") or ""
        if mode == "none":
            if en or clause:
                errors.append(f"模式是「无术语」却带了术语内容：{r['gb']}")
            continue
        # 条款号与英文术语必须真的在 GB 源 PDF 的术语表里
        aliases = {"牌照灯": "后牌照板照明装置", "ADS标志灯": "自动化驾驶系统标志灯"}
        src = None
        for cand in (r["gb"], aliases.get(r["gb"], r["gb"]), r["gb"].replace("（AFS）", "")):
            src = terms_b.get(cand) or terms_a.get(cand)
            if src:
                break
        if not src:
            errors.append(f"GB 术语表里找不到这一行：{r['gb']}（{clause} {en}）")
            continue
        if blcm.norm_key(src["en"]) != blcm.norm_key(en):
            errors.append(
                f"GB 英文术语与源 PDF 不符：{r['gb']} —— JSON 写「{en}」，源 PDF 是「{src['en']}」"
            )
        if src["clause"] != clause:
            errors.append(
                f"GB 条款号与源 PDF 不符：{r['gb']} —— JSON 写 {clause}，源 PDF 是 {src['clause']}"
            )
        if mode == "literal":
            n_literal += 1
            c_base = re.sub(r"\s*\([^)]*\)\s*$", "", r["cName"])
            cands = {blcm.norm_key(r["cName"]), blcm.norm_key(c_base)}
            cands |= {re.sub(r"s$", "", x) for x in list(cands)}
            gb_norm = blcm.norm_key(src["en"])
            if not any(c and c in gb_norm for c in cands):
                errors.append(
                    f"标成「逐字命中」但对不上：{r['gb']} ← C「{r['cName']}」 vs GB「{src['en']}」"
                )
        elif mode == "manual":
            if not (r.get("note") or "").strip():
                errors.append(f"词形不同却没有写明理由：{r['gb']}")
    notes.append(f"GB 术语交叉核对：逐字命中 {n_literal} 条 / 共 {len(rows)} 条")

    # ---- 5) 未对应项必须有理由
    for g in gb_only:
        if not (g.get("reason") or "").strip():
            errors.append(f"GB 独有项没写原因：{g['gb']}")
    for c in c_only:
        if not (c.get("reason") or "").strip():
            errors.append(f"C 独有项没写原因：{c['cName']}")

    # ---- 6) 报告里必须真的渲染了这张表
    if not REPORT.exists():
        errors.append("reports/last-report.json 不存在，无法核验第 13 章")
    else:
        rep = json.load(io.open(REPORT, encoding="utf-8"))
        ch13 = next((c for c in rep.get("chapters") or [] if c.get("id") == 13), None)
        if not ch13:
            errors.append("报告里没有第 13 章")
        else:
            md = ch13.get("markdown") or ""
            if "本章范围：仅 A 与 B 两版" in md:
                errors.append("第 13 章还在声明「不含 C」")
            for r in rows:
                cell = f"{r['cName']}（§5.15, p{r['cPage']}）"
                if cell not in md:
                    errors.append(f"第 13 章没渲染这一行映射：{r['gb']} → {cell}")
                if r["cColourClean"] not in md:
                    errors.append(f"第 13 章没渲染 C 光色原文：{r['gb']} / {r['cColourClean'][:40]}")
            for c in c_only:
                if c["cName"] not in md:
                    errors.append(f"第 13 章没列 C 独有项：{c['cName']}")
            for g in gb_only:
                if g["gb"] not in md:
                    errors.append(f"第 13 章没列 GB 独有项：{g['gb']}")
            for a in anomalies:
                if a["cQuote"] not in md:
                    errors.append(f"第 13 章没写源文件的印刷异常：{a['cName']}")
            # 计数行必须与数据对得上（防止改了 JSON 没同步报告）
            counts = (data.get("_meta") or {}).get("rowCounts") or {}
            want = f"人工配对 {counts.get('pairs')} 条 · GB 有 C 无 {counts.get('gbOnly')} 条 · " \
                   f"C 有 GB 无 {counts.get('cOnly')} 条 · 源文件印刷异常 {counts.get('anomalies')} 条"
            if want not in md:
                errors.append(f"第 13 章的计数行与映射表对不上（应为：{want}）")
            notes.append(f"第 13 章渲染核对：{len(rows)} 条映射 + "
                         f"{len(c_only)} 条 C 独有 + {len(gb_only)} 条 GB 独有")

    if errors:
        print("FAIL: 灯具光色映射核验未通过")
        for e in errors:
            print("  -", e)
        return 1

    print("OK: 灯具光色映射核验通过")
    for n in notes:
        print("  ·", n)
    return 0


if __name__ == "__main__":
    sys.exit(main())
