#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
extract_aligned_tables.py — 从 last-report.json 抽取所有 markdown 表格,
转成结构化的 aligned-tables.json,作为 htmlRenderV8 typed-input 的数据源。

设计目标:
  - 每个 table 一个对象,带 id / topic / columns / rows
  - 每行每列绑定 source_version + source_page(从 chapter 标题或表头旁注推断)
  - 给 markdown 行宽不一致的自动归一化 (从 htmlRenderV8 normalizeRow 复刻)
  - 检测 triptych 风格的 "A|B|C 版本行" 表,分别归到 a_rows/b_rows/c_rows

输出:
  comparison_agent-main/dist/aligned-tables.json

运行:
  cd "C:\\Users\\zsndz\\Desktop\\comparison_agent-main"
  PYTHONIOENCODING=utf-8 python extract_aligned_tables.py
"""

from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from datetime import datetime
from typing import Any

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "comparison_agent-main" / "reports" / "last-report.json"
OUT = ROOT / "comparison_agent-main" / "dist" / "aligned-tables.json"


# ---------------------------------------------------------------------------
# Markdown table parser (Python 端,跟 V8 renderPlainTable 配套)
# ---------------------------------------------------------------------------

def parse_md_tables(md: str) -> list[dict]:
    """返回 [{header, rows, line_start, line_end}] 列表。

    收集策略: 从 `|` 开头行开始,继续收所有**非空**行(包含 `|` 与不包含 `|`),
    直到遇到下一个空行或下一个 `|` 开头但前面有空白行的位置。
    实际更简单:把整个 markdown 切成 "以空行分隔的段落",每个段落里只要含 `|`,
    就尝试解析为表格。
    """
    tables = []
    lines = md.replace("\r\n", "\n").split("\n")
    # Split by blank lines (paragraph boundary)
    blocks: list[tuple[int, list[str]]] = []  # (start_line, lines_in_block)
    cur_block: list[str] = []
    cur_start = 0
    for i, l in enumerate(lines):
        if l.strip() == "":
            if cur_block:
                blocks.append((cur_start, cur_block))
                cur_block = []
        else:
            if not cur_block:
                cur_start = i
            cur_block.append(l)
    if cur_block:
        blocks.append((cur_start, cur_block))

    for start, block in blocks:
        # Only treat block as table if it has at least 2 `|`-leading lines
        pipe_lines = [l for l in block if l.lstrip().startswith("|")]
        if len(pipe_lines) < 2:
            continue
        parsed = _parse_one_table(block, start)
        if parsed:
            parsed["line_end"] = start + len(block) - 1
            tables.append(parsed)
    return tables


def _parse_one_table(tbl_lines: list[str], line_start: int) -> dict | None:
    # 行 0 = header, 行 1 = separator (|---|---|), 2+ = body
    def split_row(line: str) -> list[str]:
        # 去掉首尾 |,再用 | 切
        s = line.strip()
        if s.startswith("|"):
            s = s[1:]
        if s.endswith("|"):
            s = s[:-1]
        return [c.strip() for c in s.split("|")]

    header = split_row(tbl_lines[0])
    sep = tbl_lines[1]
    # 校验 separator 行
    if not re.match(r"^[\s:|-]+$", sep.strip()):
        return None

    # Multi-line row collector, mirror of htmlRenderV8.ts `collectTableRows`.
    # Each `|`-leading line starts a NEW row. Within a row, non-`|` lines
    # accumulate until the next `|` line. After the loop, flush any open row.
    rows: list[str] = []
    cur: list[str] = []
    open_row = False
    for raw in tbl_lines[2:]:
        t = raw.strip()
        if t == "":
            break
        if t.startswith("|"):
            # Always start a new row on `|`.
            if open_row:
                rows.append("\n".join(cur))
            cur = [raw]
            open_row = not t.endswith("|")
        else:
            if open_row:
                cur.append(raw)
            else:
                # orphan non-pipe line: end table
                break
    # Flush trailing open row (last row may not end with `|`)
    if open_row and cur:
        rows.append("\n".join(cur))

    # split cells for each accumulated row
    split_rows = [split_row(r) for r in rows]
    return {
        "header": header,
        "rows": split_rows,
        "line_start": line_start,
    }


def normalize_row(row: list[str], width: int) -> list[str]:
    """跟 htmlRenderV8.ts 的 normalizeRow 镜像。"""
    if len(row) == width:
        return row
    if len(row) < width:
        return row + ["—"] * (width - len(row))
    head = row[: width - 1]
    tail = [c for c in row[width - 1:] if c and c.strip()]
    merged = "<br>".join(tail) if tail else "—"
    return head + [merged]


# ---------------------------------------------------------------------------
# 表格分类: triptych (A|B|C 版本行) vs plain
# ---------------------------------------------------------------------------

VERSION_RE = re.compile(
    r"^\*?\*?(?:\*\*)?"
    r"(A\s*草案|B\s*现行|C\s*UN\s*R48|B\s*2019|A\s*版|B\s*版|C\s*版|草案\s*V|GB\s*4785)"
    r"\*?\*?$",
    re.IGNORECASE,
)


def norm_version_label(label: str) -> str | None:
    t = (label or "").replace("*", "").strip().upper()
    if re.match(r"^A(\s|版|草案)", t):
        return "A"
    if re.match(r"^B(\s|版|现行)", t):
        return "B"
    if re.match(r"^C(\s|版|UN|R48)", t):
        return "C"
    return None


def classify_table(tbl: dict) -> dict:
    """返回 {kind: 'triptych' | 'plain', ...}"""
    header = tbl["header"]
    # 找表头里是否有 版本/来源 列
    norm_h = [h.replace(" ", "").replace("\u3000", "").replace("*", "") for h in header]
    version_col = -1
    for i, h in enumerate(norm_h):
        if h in ("版本", "来源", "version"):
            version_col = i
            break

    body = tbl["rows"]
    # 检查行: 首列是否是版本标记
    if version_col >= 0:
        version_rows = [r for r in body if norm_version_label(r[version_col] if version_col < len(r) else "")]
        if len(version_rows) >= 1:
            return {"kind": "triptych", "version_col": version_col}

    # 退化判断: 行首列出现 A/B/C
    ab_c_rows = [r for r in body if norm_version_label(r[0] if r else "")]
    if len(ab_c_rows) >= 2:
        return {"kind": "triptych", "version_col": 0}

    return {"kind": "plain", "version_col": -1}


def split_triptych(tbl: dict, version_col: int) -> dict:
    """把 triptych 表拆成 a_rows/b_rows/c_rows。"""
    header = tbl["header"]
    # 取 version 列之外的列作为内容列
    content_cols = [i for i in range(len(header)) if i != version_col]

    a_row = b_row = c_row = None
    other_rows = []
    for r in tbl["rows"]:
        v = norm_version_label(r[version_col] if version_col < len(r) else "")
        if v == "A" and a_row is None:
            a_row = [r[i] if i < len(r) else "" for i in content_cols]
        elif v == "B" and b_row is None:
            b_row = [r[i] if i < len(r) else "" for i in content_cols]
        elif v == "C" and c_row is None:
            c_row = [r[i] if i < len(r) else "" for i in content_cols]
        else:
            # 其他行(可能是 "实质差异" 等说明行)保留
            other_rows.append(r)

    return {
        "a_row": a_row or [],
        "b_row": b_row or [],
        "c_row": c_row or [],
        "other_rows": other_rows,
        "content_header": [header[i] for i in content_cols],
    }


# ---------------------------------------------------------------------------
# 章节上下文 → source_page 推断 (粗糙,后续可接 chapterScan)
# ---------------------------------------------------------------------------

CHAPTER_PAGE_HINT = {
    "执行摘要": (None, None, None),
    "三份法规基本信息": ("p5", "p1", "p1"),
    "章节体系总览": ("p5", "p1", "p1"),
    "术语与定义": ("p5", "p6", "p5"),
    "一般要求": ("p13", "p14", "p34"),
    "前照灯规定": ("p25", "p30", None),
    "信号灯与反射器": ("p35", "p40", None),
    "光度与色度要求": ("p65", "p70", None),
    "测试与检验方法": ("p85", "p55", None),
    "附录与实施": ("p100", "p80", None),
    "关键变化点总结": (None, None, None),
    "A/B/C 量化参数表横向对比": (None, None, None),
    "灯具光色分配逐行 A vs B 对比": (None, None, None),
    "条款正文逐句 A vs B 对比": (None, None, None),
}


def page_hints(chapter_title: str) -> tuple[str | None, str | None, str | None]:
    # 去掉 "## 01 " 之类前缀
    clean = re.sub(r"^#+\s*\d+\s*", "", chapter_title).strip()
    for k, v in CHAPTER_PAGE_HINT.items():
        if k in clean or clean in k:
            return v
    return (None, None, None)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    if not SRC.exists():
        print(f"❌ 报告 JSON 缺失: {SRC}")
        sys.exit(1)

    print("🔍 抽取 last-report.json 表格 → aligned-tables.json ...")
    with open(SRC, "r", encoding="utf8") as f:
        rpt = json.load(f)

    out_tables = []
    stats = {
        "total_chapters": 0,
        "total_tables": 0,
        "triptych_tables": 0,
        "plain_tables": 0,
        "rows_normalized": 0,
    }

    for ci, ch in enumerate(rpt.get("chapters", [])):
        stats["total_chapters"] += 1
        md = ch.get("markdown", "") or ""
        tables = parse_md_tables(md)
        a_page, b_page, c_page = page_hints(ch.get("title", ""))

        for ti, tbl in enumerate(tables):
            stats["total_tables"] += 1
            kind_info = classify_table(tbl)
            kind = kind_info["kind"]
            if kind == "triptych":
                stats["triptych_tables"] += 1
            else:
                stats["plain_tables"] += 1

            # 行宽归一化
            norm_rows = []
            for r in tbl["rows"]:
                if len(r) != len(tbl["header"]):
                    stats["rows_normalized"] += 1
                norm_rows.append(normalize_row(r, len(tbl["header"])))

            entry: dict[str, Any] = {
                "id": f"ch{ci}.t{ti}",
                "chapter": ch.get("title", ""),
                "kind": kind,
                "header": tbl["header"],
                "rows": norm_rows,
                "source_page_hint": {"A": a_page, "B": b_page, "C": c_page},
                "verified": False,
            }

            if kind == "triptych":
                entry.update(split_triptych(tbl, kind_info["version_col"]))

            out_tables.append(entry)

    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source_report": str(SRC.relative_to(ROOT)),
        "stats": stats,
        "tables": out_tables,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf8")

    print(f"\n📊 统计:")
    print(f"  章节数: {stats['total_chapters']}")
    print(f"  表格数: {stats['total_tables']}")
    print(f"    triptych (A|B|C 行): {stats['triptych_tables']}")
    print(f"    plain: {stats['plain_tables']}")
    print(f"  行宽归一化次数: {stats['rows_normalized']}")
    print(f"\n📄 输出: {OUT}")
    print(f"   大小: {OUT.stat().st_size/1024:.1f} KB")


if __name__ == "__main__":
    main()
