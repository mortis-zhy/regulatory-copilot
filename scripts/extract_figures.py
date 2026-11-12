#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从源 PDF 里抽出**实质图** —— 报告的图版靠它。

## 为什么需要这个

交付件（279 页）里**一张图都没有**（实测：`page.get_images()` → 0），
而源 PDF 里光 GB 4785-2019 就有 39 张位图、B 版 p30 就是那张
「1/1a/1b 类 80°/45° 可见角布局图」—— **图里的角度就是限值本身**。

MinerU 抽出来的 136 处插图**本体是 base64，就在 markdown 里**
（`![](data:image/jpeg;base64,…）`），但报告只取了 `{page, caption}`，
**图本体被丢掉了**。

## 为什么从**源 PDF** 抽，而不是用 MinerU 的 base64

- base64 在 markdown 里是**文档顺序**，没有页锚点；
  而 `figures[]` 只记了 `page`（45/43/48 条）——
  **两边对不上**（A 46 张 base64 vs 45 条 figure，差的正好是 chart 块）。
  按顺序硬配 = 给错页 = 图和它的题注对不上 ⇒ **宁可空着，不可错着**。
- 源 PDF 的图对象**自带页码与尺寸**，抽取是确定性的、可复算的。

代价：矢量图（chart）抽不出 → 那几页在图版里**明确写「本页为矢量图，未抽成位图」**，
不假装有图。

## 判定「实质图」

宽或高 < `--min-px`（默认 200）的**不收** —— 源 PDF 里大量 40×21 的小图
是装饰/网点/页眉符号（实测 A 版 149 个图对象里 111 个是这种）。

用法：
    python scripts/extract_figures.py --pdf <pdf> --out <dir> [--min-px 200] [--pages 30,38]
stdout：一行 JSON
    {"pages": {"30": [{"file": "p30_0.png", "w": 1278, "h": 849}]}, "total": 1, "skipped": 12}
"""
import argparse
import io
import json
import os
import sys

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def extract(pdf_path, out_dir, min_px=200, pages=None, dpi=200):
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    want = set(pages) if pages else None
    out = {}
    total = 0
    skipped = 0
    seen = set()
    for pno in range(doc.page_count):
        page_no = pno + 1
        if want is not None and page_no not in want:
            continue
        page = doc[pno]
        files = []
        raw = page.get_images(full=True)
        # **软掩码（SMask）不是图** ✓ ——
        # `get_images(full=True)` 会把「图的软掩码」也当成一个图对象列出来 ✗，
        # 而软掩码长这样：黑底白线的**负片**（实测 B 版 p68 的第二张图就是这样 ✗）。
        # 判据：某 xref 在别的图的 smask 字段里出现 ⇒ 它是掩码 ✓。
        mask_xrefs = {t[1] for t in raw if len(t) > 1 and t[1]}
        for entry in raw:
            xref = entry[0]
            if xref in mask_xrefs:
                skipped += 1
                continue
            # **图**在页面上**画在哪** ✓ ——
            # `extract_image()` 给的是**原始字节** ✗：它不套用 PDF 里的
            # `/Decode` 反相数组、不套用掩码、不含页面上叠在图上的白底 ⇒
            # 抽出来是**黑底白线的负片** ✗（实测 B 版 p68 的第二张就是这样 ✗）。
            #
            # 正确的做法：**把页面上那块区域渲染出来** ✓ ——
            # 读者看到什么，图版里就是什么 ✓。
            rects = page.get_image_rects(xref)
            if not rects:
                skipped += 1  # 图对象存在但**没画出来**（被裁掉/零尺寸）⇒ 不收 ✓
                continue
            for rect in rects:
                key = (xref, round(rect.x0, 1), round(rect.y0, 1))
                if key in seen:
                    continue
                seen.add(key)
                w_px = rect.width * dpi / 72.0
                h_px = rect.height * dpi / 72.0
                if w_px < min_px or h_px < min_px:
                    skipped += 1
                    continue
                zoom = dpi / 72.0
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect, alpha=False)
                name = "p%d_%d.png" % (page_no, len(files))
                pix.save(os.path.join(out_dir, name))
                files.append({"file": name, "w": pix.width, "h": pix.height})
                total += 1
        if files:
            out[str(page_no)] = files
    doc.close()
    return {"pages": out, "total": total, "skipped": skipped}


def main():
    ap = argparse.ArgumentParser(description="抽源 PDF 里的实质图")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-px", type=int, default=200)
    ap.add_argument("--dpi", type=int, default=200)
    ap.add_argument("--pages", default="", help="逗号分隔的页码；空 = 全部")
    args = ap.parse_args()

    pages = None
    if args.pages.strip():
        pages = sorted({int(x) for x in args.pages.split(",") if x.strip()})
    res = extract(args.pdf, args.out, args.min_px, pages, args.dpi)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == "__main__":
    main()
