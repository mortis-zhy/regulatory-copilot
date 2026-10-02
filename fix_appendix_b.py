#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
fix_appendix_b.py — 修复附录 B 图片清单中 `(规范性)` 标题污染。

根因: 报告生成阶段从源 PDF 抓"图 N / Figure N / 表 N"标题失败,模型退化成
回填源文里的"(规范性)"标记,导致整个附录 B 图片索引变成无意义列表。

修复策略:
  1. 读 last-report.json,定位附录 B markdown
  2. 解析所有 `| 文档 | 页 | 标题 |` 表格
  3. 对每个 标题 == "(规范性)" 的行,根据 (文档, 页) 回源 PDF 取页内
     第一个匹配的图/表标题
  4. 写回 last-report.json,渲染器无需改动

运行:
  cd "C:\\Users\\zsndz\\Desktop\\comparison_agent-main"
  PYTHONIOENCODING=utf-8 python fix_appendix_b.py
"""

from __future__ import annotations
import fitz
import json
import re
import sys
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent
SOURCES = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}
REPORT_JSON = ROOT / "comparison_agent-main" / "reports" / "last-report.json"


# ---------------------------------------------------------------------------
# 标题查找: 给定 (源 PDF, 页号 1-indexed), 返回该页最可能的图/表标题
# ---------------------------------------------------------------------------

# 中英文 figure/table patterns
FIGURE_PATTERNS = [
    # "图 2 中的 E：..." / "图3 转向信号灯布局"
    re.compile(r"图\s*(\d+(?:[\.\-]\d+)*)\s*[：:、，,。\s]+([^\n。；;]{2,60})"),
    # "Figure 1" / "Figure I.1"
    re.compile(r"Figure\s+(\d+(?:[\.\-]\d+)*)\s*[.:、，,]?\s*([A-Z][^\n]{2,80})", re.IGNORECASE),
    # "图 I.1" 等
    re.compile(r"图\s*([IVX]+(?:\.\d+)?)\s*[：:、，,。\s]+([^\n。；;]{2,60})"),
    # "表 3"
    re.compile(r"表\s*(\d+(?:[\.\-]\d+)*)\s*[：:、，,。\s]+([^\n。；;]{2,60})"),
    # "Table 1"
    re.compile(r"Table\s+(\d+(?:[\.\-]\d+)*)\s*[.:、，,]?\s*([A-Z][^\n]{2,80})", re.IGNORECASE),
]

POLLUTED_TOKENS = {
    "(规范性)", "（规范性）", "(规范性 )", "( normative )", "",
    "（无题注）", "(无题注)", "无题注", "（无）", "(无)",
    "（图标题缺失）", "图标题缺失",
}


def is_polluted_title(s: str) -> bool:
    t = s.strip()
    if t in POLLUTED_TOKENS:
        return True
    if t.startswith("(规范") or t.startswith("（规范"):
        return True
    if t.startswith("(无") or t.startswith("（无"):
        return True
    if t.startswith("(图标题") or t.startswith("（图标题"):
        return True
    return False


def find_titles_on_page(pdf_path: Path, page_num_1based: int, max_n: int = 2) -> list[str]:
    """从源 PDF 指定页抽 figure/table 标题候选。

    同时扫描当前页和前后 2 页 (图题注可能跨页或在前一页末尾)。
    """
    if not pdf_path.exists():
        return []
    doc = fitz.open(pdf_path)
    if page_num_1based < 1 or page_num_1based > len(doc):
        doc.close()
        return []
    # 扫描 ±2 页
    start = max(0, page_num_1based - 3)
    end = min(len(doc), page_num_1based + 2)
    out: list[str] = []
    seen = set()
    for pi in range(start, end):
        txt = doc[pi].get_text()
        for pat in FIGURE_PATTERNS:
            for m in pat.finditer(txt):
                label = m.group(1)
                title = m.group(2).strip()
                if not title or len(title) < 2:
                    continue
                if is_polluted_title(title):
                    continue
                key = f"{label}::{title[:30]}"
                if key in seen:
                    continue
                seen.add(key)
                # 截断到第一个句末
                for stop in ("。", "；", ";", "\n"):
                    if stop in title:
                        title = title.split(stop)[0]
                if pat.pattern.startswith("图\\s"):
                    full = f"图{label} {title}"
                elif pat.pattern.startswith("Figure"):
                    full = f"Figure {label} {title}"
                elif pat.pattern.startswith("表\\s"):
                    full = f"表{label} {title}"
                elif pat.pattern.startswith("Table"):
                    full = f"Table {label} {title}"
                else:
                    full = title
                out.append(full.strip())
                if len(out) >= max_n:
                    doc.close()
                    return out
    doc.close()
    return out


# ---------------------------------------------------------------------------
# Markdown table row 解析
# ---------------------------------------------------------------------------

def parse_row(line: str) -> list[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def is_polluted_title(s: str) -> bool:
    t = s.strip()
    return t in POLLUTED_TOKENS or t.startswith("(规范") or t.startswith("（规范")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    if not REPORT_JSON.exists():
        print(f"❌ 报告 JSON 缺失: {REPORT_JSON}")
        sys.exit(1)

    with open(REPORT_JSON, "r", encoding="utf8") as f:
        rpt = json.load(f)

    fixed_rows: list[dict] = []
    unchanged_rows = 0
    not_found_rows = 0

    # 处理每个 appendix
    for ap in rpt.get("appendices", []):
        md = ap.get("markdown") or ""
        if "图片" not in md and "B.1" not in md and "B.2" not in md:
            continue
        # 解析每一行
        lines = md.split("\n")
        for i, line in enumerate(lines):
            if not line.strip().startswith("|"):
                continue
            # 跳过 separator
            if re.match(r"^\|[\s:|-]+\|?$", line):
                continue
            cells = parse_row(line)
            if len(cells) < 3:
                continue
            # 找 `| 文档 | 页 | 标题 |` 模式: 文档列是 A/B/C
            doc_label = cells[0].strip()
            if doc_label not in ("A", "B", "C"):
                continue
            page_cell = cells[1].strip()
            title_cell = cells[2].strip() if len(cells) > 2 else ""
            if not is_polluted_title(title_cell):
                unchanged_rows += 1
                continue

            # 解析页号 (e.g. "p30" / "第30页" / "30")
            m = re.search(r"\d+", page_cell)
            if not m:
                not_found_rows += 1
                continue
            page_num = int(m.group())

            # 回源 PDF 找标题
            titles = find_titles_on_page(SOURCES[doc_label], page_num)
            if not titles:
                not_found_rows += 1
                new_title = "（图标题未抽取，需查源 PDF 原文）"
                new_cell = new_title
            else:
                new_title = titles[0]
                new_cell = new_title

            # 替换 cells[2]
            new_cells = cells.copy()
            new_cells[2] = new_cell
            # 重渲染这一行 (保持 | 对齐)
            new_line = "| " + " | ".join(new_cells) + " |"
            lines[i] = new_line

            fixed_rows.append({
                "appendix": ap.get("id"),
                "doc": doc_label,
                "page": page_num,
                "old_title": title_cell,
                "new_title": new_title,
            })

        # 写回
        ap["markdown"] = "\n".join(lines)

    # 保存
    if fixed_rows:
        with open(REPORT_JSON, "w", encoding="utf8") as f:
            json.dump(rpt, f, ensure_ascii=False, indent=2)

    # 控制台输出
    print(f"🔧 附录 B 标题修复:")
    print(f"  修复行数: {len(fixed_rows)}")
    print(f"  未变更行数: {unchanged_rows}")
    print(f"  未找到替换: {not_found_rows}")
    print()
    if fixed_rows:
        print("前 10 个修复样本:")
        for r in fixed_rows[:10]:
            old = r['old_title'][:30] + ('...' if len(r['old_title'])>30 else '')
            new = r['new_title'][:60] + ('...' if len(r['new_title'])>60 else '')
            print(f"  附{r['appendix']} {r['doc']} p{r['page']}: '{old}' → '{new}'")
    if not_found_rows:
        print(f"\n⚠️  {not_found_rows} 行没找到替代标题,已填占位符")

    # 输出诊断报告
    diag_path = ROOT / "fix_appendix_b_report.json"
    diag_path.write_text(json.dumps({
        "generated_at": datetime.now().isoformat(timespec='seconds'),
        "fixed_count": len(fixed_rows),
        "unchanged_count": unchanged_rows,
        "not_found_count": not_found_rows,
        "fixes": fixed_rows,
    }, ensure_ascii=False, indent=2), encoding="utf8")
    print(f"\n📄 诊断报告: {diag_path}")


if __name__ == "__main__":
    main()
