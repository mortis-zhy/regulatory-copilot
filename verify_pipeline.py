#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_pipeline.py — 校核 last-report.json 里的数据 vs 源 PDF 原文。

设计原则:
  源 PDF = 真理
  last-report.json = 喂给 V8 渲染器的数据(PDF 上看到的值就是这里来的)
  如果 last-report.json 和源 PDF 对不上,PDF 就是错的(无论 V8 渲染多漂亮)

运行:
  cd "C:\\Users\\zsndz\\Desktop\\comparison_agent-main"
  python verify_pipeline.py
输出:
  verify_report.json — 结构化诊断
  verify_report.md   — 给人看的报告
"""

from __future__ import annotations
import fitz  # PyMuPDF
import json
import re
import sys
from pathlib import Path
from datetime import datetime
from typing import Any

ROOT = Path(__file__).resolve().parent
SOURCES = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}
REPORT_JSON = ROOT / "comparison_agent-main" / "reports" / "last-report.json"
REPORT_PDF = ROOT / "GB4785_多版本横向对比研究报告.pdf"
OUT_JSON = ROOT / "verify_report.json"
OUT_MD = ROOT / "verify_report.md"


# ---------------------------------------------------------------------------
# 源 PDF 抽取工具
# ---------------------------------------------------------------------------

def open_pdf(path: Path) -> fitz.Document:
    if not path.exists():
        raise FileNotFoundError(f"源 PDF 缺失: {path}")
    return fitz.open(path)


def find_pattern_pages(doc: fitz.Document, pattern: str, limit: int = 5) -> list[tuple[int, str]]:
    """返回 (页码, 上下文) 列表。"""
    out = []
    rx = re.compile(pattern)
    for i, p in enumerate(doc):
        txt = p.get_text()
        m = rx.search(txt)
        if m:
            ctx = txt[max(0, m.start() - 60):m.end() + 120].replace("\n", " ")
            out.append((i + 1, ctx))
            if len(out) >= limit:
                break
    return out


def grep_source(version: str, pattern: str) -> list[tuple[int, str]]:
    """在源 PDF 中搜 pattern,返回 (页码, 上下文)。"""
    return find_pattern_pages(open_pdf(SOURCES[version]), pattern)


# ---------------------------------------------------------------------------
# 报告 JSON 抽取工具
# ---------------------------------------------------------------------------

def report_text() -> str:
    """把整个 report 拍平成字符串便于正则。"""
    with open(REPORT_JSON, "r", encoding="utf8") as f:
        rpt = json.load(f)
    return json.dumps(rpt, ensure_ascii=False)


def report_find(pattern: str, limit: int = 10) -> list[str]:
    txt = report_text()
    out = []
    for m in re.finditer(pattern, txt):
        ctx = txt[max(0, m.start() - 50):m.end() + 100].replace("\n", " ")
        out.append(ctx)
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------------------
# 单项检查 (returns dict with status)
# ---------------------------------------------------------------------------

def check(label: str, status: str, detail: str, source_evidence: str = "", report_evidence: str = "") -> dict:
    return {
        "label": label,
        "status": status,  # "pass" | "fail" | "warn"
        "detail": detail,
        "source_evidence": source_evidence[:200] if source_evidence else "",
        "report_evidence": report_evidence[:200] if report_evidence else "",
    }


def check_page_counts() -> list[dict]:
    results = []
    expected = {"A": 103, "B": 81, "C": 147}
    for v, path in SOURCES.items():
        doc = open_pdf(path)
        n = len(doc)
        doc.close()
        ok = (n == expected[v])
        results.append(check(
            label=f"{v} 总页数",
            status="pass" if ok else "fail",
            detail=f"源 PDF={n}, 预期={expected[v]}",
            source_evidence=f"{path.name}: {n} pages",
        ))
        # Find in report
        ev = report_find(rf"{v}.*?{expected[v]}|{expected[v]}.*?{v}", limit=2)
        if results[-1]["status"] == "pass" and not ev:
            results[-1]["status"] = "warn"
            results[-1]["detail"] += " (报告里没找到对应的引用)"
        else:
            results[-1]["report_evidence"] = ev[0] if ev else ""
    return results


def check_value_in_source_and_report(
    label: str, version: str, source_pattern: str, expected_in_report: str
) -> dict:
    """通用项: 在源 PDF 找到 + 在报告里找到。"""
    src = grep_source(version, source_pattern)
    rep = report_find(re.escape(expected_in_report), limit=2)

    if not src:
        return check(label, "fail", f"源 {version} 没匹配到 {source_pattern!r}",
                     source_evidence="(none)", report_evidence=rep[0] if rep else "")
    if not rep:
        return check(label, "warn", f"报告里没引用 '{expected_in_report}'",
                     source_evidence=f"{version} p{src[0][0]}: {src[0][1]}",
                     report_evidence="(none)")
    return check(label, "pass", f"源={version} p{src[0][0]}, 报告已引用",
                 source_evidence=src[0][1], report_evidence=rep[0])


def check_unit_consistency(label: str, version: str, source_pattern: str, unit_mm: str) -> dict:
    """检查单位 mm / m 一致性。"""
    src = grep_source(version, source_pattern)
    if not src:
        return check(label, "fail", f"源 {version} 缺数据",
                     source_evidence="(none)")
    # Find unit nearby
    full = " ".join(s[1] for s in src)
    if unit_mm in full:
        return check(label, "pass", f"含单位 {unit_mm}",
                     source_evidence=full[:200])
    return check(label, "warn", f"上下文未出现单位 {unit_mm}",
                 source_evidence=full[:200])


# ---------------------------------------------------------------------------
# 高级校验 (双源 / 假差异 / 编号重排 / C 占位)
# ---------------------------------------------------------------------------

def _read_report_markdown() -> str:
    """读 last-report.json 的全部 markdown(真实换行版)。

    注意:不能用 json.dumps 拍平整个 JSON — 那会把 markdown 里的换行
    转义成字面 \\n 两字符,后续按行 split 全部失效。这里直接把每章
    markdown 用真实换行拼接。
    """
    with open(REPORT_JSON, "r", encoding="utf8") as f:
        rpt = json.load(f)
    parts = []
    for ch in rpt.get("chapters", []):
        parts.append(ch.get("markdown", "") or "")
    for ap in rpt.get("appendices", []):
        parts.append(ap.get("markdown", "") or "")
    return "\n".join(parts)


def check_dual_source_validation() -> list[dict]:
    """Check A — 双源核验。

    对每张「来源 | 页码 | 条款正文」三栏对比表:
      - 该表必须同时含 A 行 与 B 行(缺一方 → 无法做双源比对)
      - A/B 行的「页码」列必须含真实页码(第 N 页 / pN)
      - A/B 行的「条款」列必须含条款号(x.y 或 x.y.z)
    缺任意一项 → 自动降级为 ⚠ 待复核,报告给使用者。
    """
    md = _read_report_markdown()
    # 逐表扫描:连续 | 行组成的块
    row_pat_a = re.compile(r"\|\s*\*\*\s*A\s*(?:草案|版)?\s*\*\*\s*\|")
    row_pat_b = re.compile(r"\|\s*\*\*\s*B\s*(?:现行|版|2019)?\s*\*\*\s*\|")
    checked = 0
    pass_cnt = 0
    warn_cnt = 0
    samples: list[str] = []
    for table in re.finditer(r"((?:\|[^\n]*\n){3,})", md):
        body = table.group(1)
        lines = body.split("\n")
        a_line = next((l for l in lines if row_pat_a.search(l)), None)
        b_line = next((l for l in lines if row_pat_b.search(l)), None)
        if not (a_line and b_line):
            continue
        # 判定这是「版本 × 页码 × 条款」三栏表(而非「文档 | 页 | 标题」索引表)
        if not re.search(r"页码", lines[0]) and not re.search(r"页码", lines[1] if len(lines) > 1 else ""):
            continue
        checked += 1
        def cells(line: str) -> list[str]:
            return [c.strip() for c in line.split("|")]
        a_cells, b_cells = cells(a_line), cells(b_line)
        # 找页码列(含 "第N页" 或 pN 的那一格)
        def has_page(cs: list[str]) -> bool:
            return any(re.search(r"第\s*\d+\s*页|\bp\d+\b", c) for c in cs)
        def has_clause(cs: list[str]) -> bool:
            return any(re.search(r"\d+\.\d+", c) for c in cs)
        a_ok, b_ok = has_page(a_cells) and has_clause(a_cells), has_page(b_cells) and has_clause(b_cells)
        if a_ok and b_ok:
            pass_cnt += 1
        else:
            warn_cnt += 1
            if len(samples) < 5:
                miss = []
                if not a_ok: miss.append("A 行缺页码/条款号")
                if not b_ok: miss.append("B 行缺页码/条款号")
                topic = next((l for l in lines if l.startswith("| 来源") or l.startswith("| 版本")), lines[0])
                samples.append(f"{topic.strip('| ')[:40]} → {'; '.join(miss)}")
    if checked == 0:
        return [check("双源核验 · A+B 锚点", "warn", "未扫描到含 A/B 行的「页码 + 条款」三栏对比表")]
    detail = f"扫描 {checked} 张 A/B 对比表, 双源锚点完整 {pass_cnt}, 缺锚点 {warn_cnt}"
    return [check("双源核验 · A+B 锚点", "pass" if warn_cnt == 0 else "warn", detail,
                  source_evidence="; ".join(samples) or "(无样本)")]


def check_false_diff_truncation() -> list[dict]:
    """Check B — 假差异检测。

    同一个对比表里,A、B 两行摘录长度差距 > 3 倍且 B 行短,可能 B 摘录被截断
    (经典例子: B 原文 "≤250mm,可放宽至 750mm" 只摘了 "≤250mm")。
    """
    md = _read_report_markdown()
    pairs = []
    for table in re.finditer(r"((?:\|[^\n]*\n){3,})", md):
        body = table.group(1)
        lines = body.split("\n")
        if len(lines) < 4:
            continue
        a_row, b_row = None, None
        for line in lines:
            if re.search(r"\*\*\s*A\s*(草案|版)?\s*\*\*", line):
                a_row = line
            elif re.search(r"\*\*\s*B\s*(现行|版|2019)?\s*\*\*", line):
                b_row = line
        if not (a_row and b_row):
            continue
        a_cells = [c.strip() for c in a_row.split("|") if c.strip()]
        b_cells = [c.strip() for c in b_row.split("|") if c.strip()]
        if len(a_cells) < 4 or len(b_cells) < 4:
            continue
        a_text = " ".join(a_cells[3:])
        b_text = " ".join(b_cells[3:])
        if len(a_text) > 0 and len(b_text) > 0 and len(a_text) > len(b_text) * 3:
            pairs.append({
                "topic": a_cells[0][:30] if a_cells else "(?)",
                "a_len": len(a_text),
                "b_len": len(b_text),
                "ratio": round(len(a_text) / max(len(b_text), 1), 1),
            })
    if not pairs:
        return [check("假差异 · B 列截断", "pass", "未发现 B 列截断嫌疑(长度比 ≤ 3)")]
    detail = f"发现 {len(pairs)} 个对比表 A/B 长度差 >3 倍"
    samples = pairs[:5]
    return [check("假差异 · B 列截断", "warn", detail,
                  source_evidence="; ".join(f"{p['topic']} A={p['a_len']}B={p['b_len']}" for p in samples))]


def check_renumber_classification() -> list[dict]:
    """Check C — 编号重排检测。

    Ch10 第 11.6.1 节 「章节级重排」应列出所有章节号变更但技术内容不变的项。
    校验:有重排表,且表里至少有 1 个 B 编号 vs A 编号 配对。
    """
    md = _read_report_markdown()
    sec_match = re.search(r"11\.6\.1\s*章节级重排.{0,30}.*?(?=###)", md, re.DOTALL)
    if not sec_match:
        return [check("编号重排 · 11.6.1", "warn", "未找到 11.6.1 / 章节级重排 子节标题")]
    section = sec_match.group(0)
    table_rows = [l for l in section.split("\n") if l.strip().startswith("|") and not re.search(r"\|\s*-{3,}\s*\|", l)]
    renum_rows = [l for l in table_rows if re.search(r"\|\s*\d+(\.\d+)?\s*\|", l) and not l.startswith("| #")]
    renum_rows = [l for l in renum_rows if len(re.findall(r"\|\s*\d+(\.\d+)?\s*\|", l)) >= 2]
    if not renum_rows:
        return [check("编号重排 · 11.6.1", "warn", "11.6.1 子节无 B/A 编号配对行(可能有数据遗漏)")]
    return [check("编号重排 · 11.6.1", "pass",
                  f"找到 {len(renum_rows)} 行 B/A 编号映射, 已纳入 🔢 闭环统计",
                  source_evidence=section[:300])]


def check_c_placeholder_classification() -> list[dict]:
    """Check D — C 版占位检测。

    区分两种「C 缺失」:
      1) C 真无对应子条款 — 用「本版未规定」灰卡占位(设计意图,正常)
      2) C 未抽取 / 抽取失败 — 同样是「本版未规定」占位,可能是数据缺失
    检测:统计 C 灰卡总占比,>50% 则提示用户人工核验。
    """
    md = _read_report_markdown()
    real_missing = 0
    for m in re.finditer(r"\*\*\s*C\s*(UN|版|草案)?[^*]*\*\*\s*\|\s*([^|]*本版未规定[^\|]*)", md):
        real_missing += 1
    fallback = md.count("源数据未提供")
    real_missing = max(real_missing, fallback)
    total_c_slots = md.count("**C ") + md.count("**C UN") + md.count("**C 现行") + md.count("**C 版")
    if total_c_slots == 0:
        return [check("C 版占位检测", "pass", "未检测到 C 灰卡(C 版未参与本次对比或全有内容)")]
    pct = round(real_missing / max(total_c_slots, 1) * 100)
    if pct >= 50:
        return [check("C 版占位检测", "warn",
                      f"C 灰卡 {real_missing}/{total_c_slots} ({pct}%),可能存在抽取失败,非纯数据问题",
                      source_evidence=f"灰卡行样本计数 {real_missing}")]
    return [check("C 版占位检测", "pass",
                  f"C 灰卡 {real_missing}/{total_c_slots} ({pct}%),比例合理",
                  source_evidence=f"总 C 槽 {total_c_slots}")]


def check_clause_in_report(label: str, version: str, clause: str, expected_page: int | None = None) -> dict:
    """检查报告里某个条款引用是否对应到正确的页。

    条款字符串必须以 `数字.数字` 开头(如 "6.6", "5.28"),避免被 "3.2.6.6" 之类的
    子路径误匹配。正则用 lookbehind `(?:^|\n|[^0-9.])` 保证前面不是数字/点。
    """
    # 用更精确的 pattern: 匹配 "6.6" 前面是 空白/换行/标点 而不是数字或点
    head = re.escape(clause.split('.')[0])
    tail = re.escape(clause[len(clause.split('.')[0]):])
    strict_pattern = rf"(?:^|\n|[^0-9.])({head}{tail})(?=\s|\.|,|:|;|$)"

    rep = report_find(re.escape(clause), limit=3)
    if not rep:
        return check(label, "warn", f"报告未引用 {clause}",
                     source_evidence="(none)")
    if expected_page is not None:
        src = grep_source(version, strict_pattern)
        actual_page = src[0][0] if src else None
        if actual_page is None:
            return check(label, "warn", f"源 {version} 也找不到 {clause}",
                         source_evidence="(none)", report_evidence=rep[0])
        page_diff = abs(actual_page - expected_page)
        if page_diff > 0:
            return check(label, "warn",
                         f"{clause} 源 {version} 在 p{actual_page}, 报告写 p{expected_page} (差 {page_diff} 页)",
                         source_evidence=f"p{actual_page}: {src[0][1]}",
                         report_evidence=rep[0])
        return check(label, "pass",
                     f"{clause} 源 p{actual_page}, 报告 p{expected_page} 一致",
                     source_evidence=src[0][1], report_evidence=rep[0])
    return check(label, "pass", f"{clause} 已引用",
                 source_evidence="(未指定页)", report_evidence=rep[0])


# ---------------------------------------------------------------------------
# 主检查集
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 主检查集 (data-driven)
# ---------------------------------------------------------------------------

# 统一的检查规格:
#   ("page",     version, expected)
#   ("clause",   label, version, clause, expected_page)
#   ("value",    label, version, source_pattern, report_pattern)
#   ("unit",     label, version, source_pattern, unit_token)
#   ("frequency",label, version, source_pattern, report_pattern)

CHECK_SPEC: list[tuple] = [
    # ============== A. 页数 ==============
    ("page", "A", 103),
    ("page", "B", 81),
    ("page", "C", 147),

    # ============== B. 电压 (电气条件) ==============
    ("value", "A 草案 电压 13.5V (12V 系统)", "A", r"13\.\s*5\s*V", "13.5"),
    ("value", "A 草案 电压 28.0V (24V 系统)", "A", r"28\.\s*0\s*V", "28.0"),
    ("value", "B 现行 电压 6.75V (6V 系统)",  "B", r"6\.\s*75\s*V", "6.75"),
    ("value", "B 现行 电压 13.5V (12V 系统)", "B", r"13\.\s*5\s*V", "13.5"),
    ("value", "B 现行 电压 28.0V (24V 系统)", "B", r"28\.\s*0\s*V", "28.0"),
    ("value", "C UN R48 电压 6.75V", "C", r"6\.\s*75", "6.75"),
    ("value", "C UN R48 电压 13.5V", "C", r"13\.\s*5", "13.5"),

    # ============== C. 关键条款页码 ==============
    ("clause", "C UN R48 5.27 电压",        "C", "5.27", 34),
    ("clause", "C UN R48 5.28 几何可见度",  "C", "5.28", 34),
    ("clause", "C UN R48 6.1.1 概述",       "C", "6.1.1", None),
    ("clause", "C UN R48 6.1.4 位置",       "C", "6.1.4", 37),
    ("clause", "C UN R48 6.1.4.3 纵向",     "C", "6.1.4.3", 37),
    ("clause", "C UN R48 6.2.6.1.2 安装倾斜","C", "6.2.6.1.2", 41),
    ("clause", "C UN R48 6.6 危险警告",     "C", "6.6", 54),
    ("clause", "C UN R48 6.22 追尾警告",    "C", "6.22", None),
    ("clause", "C UN R48 6.27 答案来自信号", "C", "6.27", None),

    # ============== D. A 草案关键章节 ==============
    ("clause", "A 草案 5.1 远光灯",  "A", "5.1", None),
    ("clause", "A 草案 5.2 近光灯",  "A", "5.2", None),
    ("clause", "A 草案 5.4 前雾灯",  "A", "5.4", None),
    ("clause", "A 草案 5.5 转向信号灯","A", "5.5", None),
    ("clause", "A 草案 5.6 危险警告", "A", "5.6", None),
    ("clause", "A 草案 5.16 回复反射器","A", "5.16", None),

    # ============== E. B 现行关键章节 ==============
    ("clause", "B 现行 5.1 远光灯",  "B", "5.1", None),
    ("clause", "B 现行 5.2 近光灯",  "B", "5.2", None),
    ("clause", "B 现行 5.5 转向信号灯","B", "5.5", None),
    ("clause", "B 现行 5.6 危险警告", "B", "5.6", None),

    # ============== F. 安装尺寸 (离地高度) ==============
    ("unit", "A 草案 离地 ≥250mm",  "A", r"250\s*mm", "mm"),
    ("unit", "A 草案 离地 ≥1200mm", "A", r"1200\s*mm", "mm"),
    ("unit", "A 草案 离地 ≥1500mm", "A", r"1500\s*mm", "mm"),
    ("unit", "A 草案 离地 ≥2100mm", "A", r"2100\s*mm", "mm"),
    ("unit", "B 现行 离地 250mm",   "B", r"250\s*mm", "mm"),
    ("unit", "B 现行 离地 1500mm",  "B", r"1500\s*mm", "mm"),

    # ============== G. 角度限值 (° / 度) ==============
    ("value", "C UN R48 向上 15° 角度", "C", r"15\s*°|15\s*度", "15"),
    ("value", "C UN R48 水平 45° 角度", "C", r"45\s*°|45\s*度", "45"),

    # ============== H. 闪烁频率 ==============
    ("frequency", "A 草案 闪烁 4.0±1.0 Hz", "A",
        r"4\.0[^0-9]+0[^0-9]+1\.0\s*Hz", "4.0"),

    # ============== I. 色度边界公式 ==============
    ("value", "C UN R48 W12 green 公式", "C",
        r"0\.\s*150\s*\+\s*0\.\s*640", "0.150 + 0.640"),
    ("value", "C UN R48 yellow boundary", "C",
        r"0\.\s*335", "0.335"),
    ("value", "C UN R48 red boundary", "C",
        r"0\.\s*346|0\.\s*200\s*x\s*\+\s*0\.\s*268", "red boundary"),
]


def build_checks() -> list[dict]:
    out: list[dict] = []
    out.extend(check_page_counts())
    for spec in CHECK_SPEC:
        kind = spec[0]
        if kind == "clause":
            _, label, version, clause, expected_page = spec
            out.append(check_clause_in_report(label, version, clause, expected_page))
        elif kind == "value":
            _, label, version, src_pat, rep_pat = spec
            out.append(check_value_in_source_and_report(label, version, src_pat, rep_pat))
        elif kind == "unit":
            _, label, version, src_pat, unit = spec
            out.append(check_unit_consistency(label, version, src_pat, unit))
        elif kind == "frequency":
            _, label, version, src_pat, rep_pat = spec
            out.append(check_value_in_source_and_report(label, version, src_pat, rep_pat))
        elif kind == "page":
            # Pages are checked in check_page_counts() — skip here.
            continue
        else:
            out.append(check("未知 check kind", "warn", f"{spec}", "", ""))
    # 高级校验 (双源 / 假差异 / 编号重排 / C 占位)
    out.extend(check_dual_source_validation())
    out.extend(check_false_diff_truncation())
    out.extend(check_renumber_classification())
    out.extend(check_c_placeholder_classification())
    return out


# ---------------------------------------------------------------------------
# 报告输出
# ---------------------------------------------------------------------------

def summarize(checks: list[dict]) -> dict:
    s = {"pass": 0, "fail": 0, "warn": 0, "total": len(checks)}
    for c in checks:
        s[c["status"]] = s.get(c["status"], 0) + 1
    return s


def render_md(checks: list[dict], summary: dict) -> str:
    lines = [
        "# Verify Pipeline 校核报告",
        f"\n生成时间: {datetime.now().isoformat(timespec='seconds')}",
        f"\n源 PDF 校核 vs 报告 JSON: {REPORT_JSON.name}",
        "",
        "## 总结",
        "",
        f"- **通过**: {summary['pass']}",
        f"- **失败**: {summary['fail']}",
        f"- **告警**: {summary['warn']}",
        f"- **总计**: {summary['total']}",
        "",
        "## 详细结果",
        "",
    ]
    by_status = {"fail": [], "warn": [], "pass": []}
    for c in checks:
        by_status[c["status"]].append(c)

    for status in ("fail", "warn", "pass"):
        if not by_status[status]:
            continue
        lines.append(f"### {status.upper()} ({len(by_status[status])})")
        lines.append("")
        for c in by_status[status]:
            icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}[c["status"]]
            lines.append(f"- {icon} **{c['label']}** — {c['detail']}")
            if c["source_evidence"]:
                lines.append(f"  - 源: `{c['source_evidence']}`")
            if c["report_evidence"]:
                lines.append(f"  - 报告: `{c['report_evidence']}`")
        lines.append("")

    return "\n".join(lines)


def main():
    if not REPORT_JSON.exists():
        print(f"❌ 报告 JSON 不存在: {REPORT_JSON}")
        sys.exit(1)

    print("🔍 校核源 PDF vs last-report.json ...")
    checks = build_checks()
    summary = summarize(checks)

    OUT_JSON.write_text(
        json.dumps({"summary": summary, "checks": checks}, ensure_ascii=False, indent=2),
        encoding="utf8",
    )
    OUT_MD.write_text(render_md(checks, summary), encoding="utf8")

    # 控制台摘要
    icon = {"pass": "✅", "warn": "⚠️", "fail": "❌"}
    print(f"\n通过: {summary['pass']} | 失败: {summary['fail']} | 告警: {summary['warn']}")
    for c in checks:
        print(f"  {icon[c['status']]} {c['label']}: {c['detail']}")

    print(f"\n📄 详细报告: {OUT_MD}")
    print(f"📊 JSON 报告: {OUT_JSON}")

    if summary["fail"] > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
