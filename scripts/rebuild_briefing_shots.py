# -*- coding: utf-8 -*-
"""重出讲稿用的交付 PDF 页面截图 —— **页码是内容决定的**，不能手写。

## 为什么

讲稿里的截图原来写死了页码（9 / 20 / 238）——
那是**279 页**那版交付件的页码 ✓。交付件加了图版变成 **325 页** ✓，
那些页码就指到别的地方去了 ✗（截图内容与讲稿说的对不上 ✗）。

手写的页码**一定会过期** —— 本项目已经踩过一次（讲稿里写死过「249 页」，
交付件早就是 278 页了 ✓）。

## 做法

按**内容**找页 ✓ —— 找「核心参数 A/B/C 同框总表」「量化参数表横向对比」
「附录 H A/B 定性条款并排对照」「B.2.1 图版」各自真正在哪一页 ✓，
再截图 ✓。页数怎么变都不会指错 ✓。

用法：
    python scripts/rebuild_briefing_shots.py
"""
import io
import os
import sys

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, "delivery", "PDF对比", "⑪_C列补全_最新版.pdf")
ASSETS = os.path.join(ROOT, "delivery", "宣讲件", "assets")

# 目录与摘要占前 55 页；正文从这儿之后找 ✓（否则会命中目录里的条目 ✗）
TOC_END = 55


def main():
    if not os.path.exists(PDF):
        raise SystemExit("找不到交付件 %s —— 先跑 node render_to_pdfdir.mjs" % PDF)
    os.makedirs(ASSETS, exist_ok=True)
    d = fitz.open(PDF)
    pages = [p.get_text() for p in d]

    def find(needle, after=TOC_END):
        for i in range(after, len(pages)):
            if needle in pages[i]:
                return i + 1
        return None

    targets = {
        "p01_cover": 1,
        "p03_dashboard": 3,
        "p09_paramindex": find("核心参数 A/B/C 同框总表", 0),
        "p20_matrix": find("量化参数表横向对比"),
        "p238_appendixH": find("附录 H A/B 定性条款并排对照"),
        "p_gallery": find("B.2.1 图版"),
    }
    for name, pno in targets.items():
        if not pno:
            print("  跳过 %s（没找到）" % name)
            continue
        d[pno - 1].get_pixmap(matrix=fitz.Matrix(2.2, 2.2)).save(os.path.join(ASSETS, name + ".png"))
        print("  %-16s ← 第 %d 页 ✓" % (name, pno))


if __name__ == "__main__":
    main()
