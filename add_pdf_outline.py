# -*- coding: utf-8 -*-
"""add_pdf_outline.py — inject clickable PDF bookmarks (outline) into the
generated report.

Why: the second evaluation (5.5/10) flagged "PDF 书签数 = 0, 目录无页码" —
a 200+ page document without outline bookmarks cannot be navigated
efficiently. The report renderer (Chromium printToPDF) does not emit an
outline, so this post-process step adds one by locating each chapter title
in the page text (whitespace-stripped match, scanning forward from page 3
so the in-document TOC page itself never shadows the real heading).

Run:  python add_pdf_outline.py        (after node dist/report-v6.mjs)
Exit 0 with a summary line; exit 1 if fewer than half the titles were found.
"""
import os
import re
import sys
import io
from pathlib import Path

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = Path(__file__).resolve().parent
PDF = ROOT.parent / "GB4785_多版本横向对比研究报告.pdf"

# Chapter titles in document order (must match reportV6 outline).
TITLES = [
    "执行摘要",
    "三份法规基本信息",
    "章节体系总览",
    "术语与定义",
    "一般要求",
    "前照灯规定",
    "信号灯与反射器",
    "光度与色度要求",
    "测试与检验方法",
    "附录与实施",
    "关键变化点总结",
    "A/B/C 量化参数表横向对比",
    "灯具光色分配逐行 A vs B 对比",
    "条款正文逐句 A vs B 对比",
    "A/B/C 原始表格汇编",
    "图片、公式与标题索引",
    "A|B|C 三版本主题对照",]


def main() -> int:
    if not PDF.exists():
        print(f"[outline] PDF not found: {PDF}")
        return 1
    doc = fitz.open(PDF)
    # Page texts, whitespace-stripped once for cheap substring tests.
    pages = [re.sub(r"\s+", "", p.get_text()) for p in doc]
    toc: list[list] = []
    cursor = 2  # skip cover + in-document TOC page (which lists all titles)
    found = 0
    for title in TITLES:
        key = re.sub(r"\s+", "", title)
        hit = -1
        for pi in range(cursor, len(pages)):
            if key in pages[pi]:
                hit = pi
                break
        if hit >= 0:
            toc.append([1, title, hit + 1])  # 1-based page for PyMuPDF
            cursor = hit  # titles appear in document order
            found += 1
        else:
            print(f"[outline] MISS: {title}")
    if toc:
        doc.set_toc(toc)
        tmp = PDF.with_suffix(".outlined.pdf")
        doc.save(tmp, garbage=3, deflate=True)
        doc.close()
        os.replace(tmp, PDF)
        print(f"[outline] wrote {len(toc)}/{len(TITLES)} bookmarks -> {PDF.name}")
    else:
        doc.close()
        print("[outline] no titles found — nothing written")
    return 0 if found >= len(TITLES) // 2 else 1


if __name__ == "__main__":
    sys.exit(main())
