# -*- coding: utf-8 -*-
"""把源 PDF 左边距（条款号所在处）裁出来，**肉眼看**条款号。

GB 4785 草案第 4 章的条款号印在左边距、是位图，文本层取不到。
要写进矩阵的条款号只能这样读出来 —— 读错就是「值对、条款错」。

用法： python scripts/read_margin_clause.py <版本> <页码> "<要找的片段>"
       不给片段就把该页左边距整条裁出来
"""
import os, re, sys

import fitz

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = {
    "A": os.path.join(ROOT, "uploaded-docs", "2173836fae9f1314.pdf"),
    "B": os.path.join(ROOT, "uploaded-docs", "f86e6c7367f24de2.pdf"),
    "C": os.path.join(ROOT, "uploaded-docs", "92b2563197df022a.pdf"),
}


def main():
    ver = sys.argv[1]
    page = int(sys.argv[2])
    needle = sys.argv[3] if len(sys.argv) > 3 else None
    doc = fitz.open(DOCS[ver])
    p = doc[page - 1]
    if needle:
        hit = None
        for b in p.get_text("blocks"):
            if needle in b[4]:
                hit = b
                break
        if hit is None:
            print("这一页没有 %r" % needle)
            return 1
        y0 = max(0, hit[1] - 26)
        y1 = min(p.rect.height, hit[3] + 10)
    else:
        y0, y1 = 0, p.rect.height
    out = os.path.join(ROOT, "_tmp_margin_%s_p%d.png" % (ver, page))
    p.get_pixmap(clip=fitz.Rect(40, y0, 260, y1), dpi=300).save(out)
    print(out)
    print("y 范围 %.0f–%.0f" % (y0, y1))
    if needle:
        print("片段：%s" % re.sub(r"\s+", " ", hit[4])[:120])
    return 0


if __name__ == "__main__":
    sys.exit(main())
