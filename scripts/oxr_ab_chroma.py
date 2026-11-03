#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OXR vs MinerU：GB 4785 色度表的 A/B 实测（线 A）。

**判据写死在这里，跑完不改。**

背景：我们知道 MinerU 抽 GB4785-2019 的色度表是**坏的**（skill 里记着：
`tables[]` 与 `markdown` 有完全相同的串行错误），只能靠源 PDF 文本层兜底。
OXR 自报表格能力最强 —— 但**榜单是开发方自报的，第三方复测一个都没有**。
所以拿**我们自己的坏点**当场判。

指标（分母 = 源 PDF 文本层按 y 坐标重建出来的真值）：

  M1 交点三元组 (标签, x, y) 还原数
  M2 边界公式 (如 y=0.150+0.640x) 还原数

**「还原」的判定**：在一行内从左到右扫 token，标签与两个坐标之间
**不允许出现别的标签**；坐标本身必须是完整合法的一个数。
串行错误就是「标签和它的坐标之间被别的东西插进来了」，所以这条判定
正好度量「这一格有没有被抽坏」。

基准侧要先**重排**：源 PDF 的文本层把数字也拆开了
（`0.` + `310` → `0.310`），不重排就没法当基准。
"""
import io
import json
import os
import re
import sys
from collections import defaultdict

import fitz

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.environ.get("TEMP", "/tmp"), "oxr_in", "oxr_out")

TARGETS = [
    ("A", "源文件_A_GB4785草案V4.3.5_103页.pdf", 16),
    ("B", "源文件_B_GB4785-2019_81页.pdf", 17),
]

POINT_LABEL = re.compile(r"^(?:W|SY|A|R|Y)\d$")
BOUND_LABEL = re.compile(r"^(?:W|SY|A|R|Y)\d{2}$")
NUM_TOKEN = re.compile(r"^[^\d]*?(0\.\d{3})[^\d]*$")
BOUND_FORMULA = re.compile(
    r"(?:[xy]=?[-+]?\d+\.\d{3}(?:[-+]\d+\.\d{3})?x?"
    r"|[-+]?\d+\.\d{3}[-+]\d+\.\d{3}x)"
)


def norm(s):
    return re.sub(r"\s+", "", s or "")


def reflow(tokens):
    """把被 PDF 拆开的片段接回去：`0.` + `310` → `0.310`。"""
    out = []
    for t in tokens:
        if out and out[-1].endswith(".") and re.match(r"^\d", t):
            out[-1] = out[-1] + t
        else:
            out.append(t)
    return out


def scan_points(tokens):
    """一行内还原 (标签, x, y)。标签与两个坐标之间不得有别的标签。"""
    got = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if POINT_LABEL.fullmatch(t):
            nums, j = [], i + 1
            while j < len(tokens) and len(nums) < 2:
                tj = tokens[j]
                if POINT_LABEL.fullmatch(tj) or BOUND_LABEL.fullmatch(tj):
                    break
                m = NUM_TOKEN.fullmatch(tj)
                if m:
                    nums.append(m.group(1))
                j += 1
            if len(nums) == 2:
                got.append((t, nums[0], nums[1]))
            i = j
            continue
        i += 1
    return got


def scan_formulas(tokens):
    got = []
    for t in tokens:
        for m in BOUND_FORMULA.finditer(t):
            got.append(norm(m.group(0)))
    return got


# ── 基准：源 PDF 文本层按 y 重建行，再重排碎片 ────────────────────────
def truth_rows(path, page_no):
    doc = fitz.open(path)
    words = doc[page_no - 1].get_text("words")
    doc.close()
    buckets = defaultdict(list)
    for x0, y0, x1, y1, w, *_ in words:
        buckets[round((y0 + y1) / 2 / 4.0)].append((x0, w))
    rows = []
    for k in sorted(buckets):
        toks = [w for _, w in sorted(buckets[k])]
        rows.append(reflow(toks))
    return rows


# ── OXR：HTML 表格 ──────────────────────────────────────────────────
def oxr_rows(md):
    rows = []
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", md, re.S):
        # **不要在这里 norm()** —— norm 会删掉空格，"0.310 0.348" 会变成
        # 一个 token "0.3100.348"，后面就再也认不出是两个坐标了。
        cells = [re.sub(r"<[^>]+>", "", td) for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)]
        if cells:
            rows.append(cells)
    return rows


# ── MinerU：markdown 表格 ───────────────────────────────────────────
def mineru_rows(md):
    rows = []
    for line in md.split("\n"):
        line = line.strip()
        if line.startswith("|"):
            rows.append(line.strip("|").split("|"))
    return rows


def from_rows(rows):
    """按行扫描；一行内的单元格按顺序拼成 token 流（跨格允许，但标签屏障仍在）。"""
    pts, fml = [], []
    for cells in rows:
        tokens = []
        for c in cells:
            tokens.extend(reflow([norm(w) for w in (c or "").split()]))
        pts.extend(scan_points(tokens))
        fml.extend(scan_formulas(tokens))
    return pts, fml


def main():
    mineru = json.load(open(os.path.join(ROOT, "dist", "mineru-v4-data.json"), encoding="utf-8"))
    report = {}
    print("判据：标签与两个坐标之间**不得有别的标签**；坐标必须是完整合法的一个数")
    print("分母：源 PDF 文本层按 y 坐标重建的行（先重排碎片）\n")

    for tag, fname, page in TARGETS:
        src = os.path.join(ROOT, "delivery", "PDF对比", fname)
        trows = truth_rows(src, page)
        tpts, tfml = from_rows(trows)
        tmap = {}
        for lab, x, y in tpts:
            tmap.setdefault(lab, (x, y))
        tset = set(tfml)

        mu_rows = mineru_rows(mineru[tag]["markdown"])
        mpts, mfml = from_rows(mu_rows)

        oxr_md = ""
        p = os.path.join(OUT, f"{tag}_p{page}.md")
        if os.path.exists(p):
            oxr_md = io.open(p, encoding="utf-8").read()
        opts, ofml = from_rows(oxr_rows(oxr_md))

        # **集合求交**，不按标签建映射 ——
        # 同一标签在不同表里取值不同（W1 在表1 是 0.310/0.348，在表2 是 0.373/0.402），
        # 按标签取「首次出现」当基准会把对的判成错的。
        tset_pts = set(tpts)

        def sc(pts):
            hit = [p for p in pts if p in tset_pts]
            wrong = [p for p in pts if p not in tset_pts]
            return hit, wrong

        o_hit, o_wrong = sc(opts)
        m_hit, m_wrong = sc(mpts)
        o_ok, m_ok = len(o_hit), len(m_hit)
        # 召回：真值里有几个被覆盖到
        o_recall = len(tset_pts & set(opts))
        m_recall = len(tset_pts & set(mpts))
        o_f = len([f for f in ofml if f in tset])
        m_f = len([f for f in mfml if f in tset])
        o_f_recall = len(tset & set(ofml))
        m_f_recall = len(tset & set(mfml))

        row = {
            "page": page,
            "truth": {"points": len(tset_pts), "formulas": len(tset)},
            "oxr": {"points_found": len(opts), "points_ok": o_ok, "points_wrong": len(o_wrong),
                    "points_recall": o_recall, "formulas_found": len(ofml),
                    "formulas_ok": o_f, "formulas_recall": o_f_recall},
            "mineru": {"points_found": len(mpts), "points_ok": m_ok, "points_wrong": len(m_wrong),
                       "points_recall": m_recall, "formulas_found": len(mfml),
                       "formulas_ok": m_f, "formulas_recall": m_f_recall},
        }
        report[tag] = row

        print(f"=== {tag} p{page}")
        print(f"    真值：交点 {len(tset_pts)} 个 · 边界公式 {len(tset)} 条")
        for name, found, ok, wrong, rec, f_found, f_ok, f_rec in [
            ("OXR   ", len(opts), o_ok, len(o_wrong), o_recall, len(ofml), o_f, o_f_recall),
            ("MinerU", len(mpts), m_ok, len(m_wrong), m_recall, len(mfml), m_f, m_f_recall),
        ]:
            print(f"    {name}：交点 抽出{found:3d} 对{ok:3d} 错{wrong:3d} 覆盖真值{rec:3d}/{len(tset_pts)}"
                  f" | 公式 抽出{f_found:3d} 对{f_ok:3d} 覆盖{f_rec:3d}/{len(tset)}")
        if m_wrong:
            print(f"      MinerU 错例：{m_wrong[:2]}")
        if o_wrong:
            print(f"      OXR 错例：{o_wrong[:2]}")
        print()

    out_path = os.path.join(ROOT, "reports", "oxr-ab-chroma.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with io.open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(report, ensure_ascii=False, indent=2))
    print("写出 " + out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
