#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""OXR vs MinerU：**全部表格页**的 A/B 实测（线 A 的样本扩大版）。

单页实验（`oxr_ab_chroma.py`）的结论：
  - OXR 在「交点一列两个数」的版式上完胜（B p17：27/27 vs MinerU 13/27）；
  - OXR 在「交点拆成 x/y 两列」的版式上**丢整列**（A p16：0/10，y 整列不见了）；
  - 两者都犯「静默失败」—— 一个丢一半、一个串行错位。

所以不能凭两个页面就换抽取层。**要判得准，得看比例。** 这一版跑全部 46 个表格页。

三个通用指标（不针对色度表，任何表格都能算）：

  M1 数字精确率  —— 抽到的数里有多少真在源页里出现过（查「编出来的数」）
  M2 数字召回率  —— 源页里的数有多少被抽到（查「漏掉的数」）
  M3 串行率      —— 一个格子里塞了 ≥3 个数的比例（串行错误的直接特征；
                    源 PDF 的表格每格通常只有 1–2 个数）
  M4 序一致性    —— 数字序列的最长公共子序列比（抓「顺序被搅乱」，
                    错位赋值躲不过它）
"""
import io
import json
import os
import re
import sys
from collections import Counter, defaultdict

import fitz

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# OXR 的输出目录：全样本跑在 allpages/out，单页实验跑在 oxr_out —— 两个都读。
_T = os.environ.get("TEMP", "/tmp")
OUT = os.path.join(_T, "oxr_in", "allpages", "out")
OUT_ALT = os.path.join(_T, "oxr_in", "oxr_out")
NUM = re.compile(r"\d+(?:\.\d+)?")


def nums(text):
    out = []
    for m in NUM.finditer(text or ""):
        v = m.group(0)
        try:
            f = float(v)
        except ValueError:
            continue
        if 0 < f < 100000:
            out.append(round(f, 4))
    return out


def seq_precision_recall(ext, src):
    ec, sc = Counter(ext), Counter(src)
    hit = sum((ec & sc).values())
    p = hit / len(ext) if ext else 0.0
    r = hit / len(src) if src else 0.0
    return p, r


def lcs_ratio(a, b):
    """数字序列的最长公共子序列比 —— 抓顺序被搅乱。"""
    if not a or not b:
        return 0.0
    prev = [0] * (len(b) + 1)
    for x in a:
        cur = [0] * (len(b) + 1)
        for j, y in enumerate(b, 1):
            cur[j] = prev[j - 1] + 1 if x == y else max(prev[j], cur[j - 1])
        prev = cur
    return prev[-1] / max(len(a), len(b))


def mineru_cells(doc):
    """按页取 MinerU 的表格单元格。"""
    out = defaultdict(list)
    for t in doc.get("tables", []):
        pg = t.get("page")
        if pg is None:
            continue
        for line in str(t.get("content", "")).split("\n"):
            line = line.strip()
            if line.startswith("|"):
                out[pg].extend(c.strip() for c in line.strip("|").split("|"))
    return out


def oxr_cells(path):
    """按页取 OXR 的表格单元格（HTML <td>）。

    注意：批量跑时每个输入都是**单页 PDF**，所以 json 里的 `page_num` 恒为 0 ——
    页号必须从**文件名**取（A_p17.json → 第 17 页）。用 json 里的页号会把
    所有页都算成第 1 页，OXR 的指标就全是 0。
    """
    out = defaultdict(list)
    if not os.path.exists(path):
        alt = os.path.join(OUT_ALT, os.path.basename(path))
        if not os.path.exists(alt):
            return out
        path = alt
    m = re.search(r"_p(\d+)\.json$", path)
    file_page = int(m.group(1)) if m else None
    try:
        j = json.load(open(path, encoding="utf-8"))
    except Exception:
        return out
    for pg in j.get("pages", []):
        pno = file_page if file_page else (pg.get("page_num", 0) + 1)
        for b in pg.get("blocks", []):
            if str(b.get("type", "")).lower() != "table":
                continue
            html = b.get("content", "")
            for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S):
                for td in re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S):
                    out[pno].append(re.sub(r"<[^>]+>", "", td))
    return out


def stats(cells, src_nums):
    ext_nums = []
    over = 0
    for c in cells:
        ns = nums(c)
        ext_nums.extend(ns)
        if len(ns) >= 3:
            over += 1
    p, r = seq_precision_recall(ext_nums, src_nums)
    return {
        "cells": len(cells),
        "nums": len(ext_nums),
        "precision": round(p, 3),
        "recall": round(r, 3),
        "serpentine_cells": over,
        "serpentine_rate": round(over / len(cells), 3) if cells else 0.0,
        "order_lcs": round(lcs_ratio(ext_nums, src_nums), 3),
    }


def main():
    mineru = json.load(open(os.path.join(ROOT, "dist", "mineru-v4-data.json"), encoding="utf-8"))
    SRC = {
        "A": "源文件_A_GB4785草案V4.3.5_103页.pdf",
        "B": "源文件_B_GB4785-2019_81页.pdf",
        "C": "源文件_C_UN-R48-09_147页.pdf",
    }
    agg = defaultdict(lambda: defaultdict(list))
    print("M1 数字精确率 / M2 数字召回率 / M3 串行率（一格 ≥3 个数）/ M4 序一致性(LCS)\n")
    for tag, fname in SRC.items():
        path = os.path.join(ROOT, "delivery", "PDF对比", fname)
        doc = fitz.open(path)
        mu = mineru_cells(mineru[tag])
        pages = sorted(set(mu.keys()))
        oxr = {}
        for pg in pages:
            oxr.update(oxr_cells(os.path.join(OUT, f"{tag}_p{pg}.json")))
        for pg in pages:
            if pg - 1 >= doc.page_count:
                continue
            src_nums = nums(doc[pg - 1].get_text())
            m = stats(mu.get(pg, []), src_nums)
            o = stats(oxr.get(pg, []), src_nums)
            agg[tag]["mineru"].append(m)
            agg[tag]["oxr"].append(o)
        doc.close()
        print(f"--- {tag}：{len(pages)} 个表格页")

    def avg(rows, k):
        vals = [r[k] for r in rows if r[k] is not None]
        return round(sum(vals) / len(vals), 3) if vals else 0.0

    out = {}
    print("\n===== 汇总（46 个表格页）=====")
    print(f"{'版':4s} {'抽取器':8s} {'页数':>4s} {'精确率':>7s} {'召回率':>7s} {'串行率':>7s} {'序一致':>7s}")
    for tag in ["A", "B", "C"]:
        for eng in ["mineru", "oxr"]:
            rows = agg[tag][eng]
            if not rows:
                continue
            out.setdefault(tag, {})[eng] = {
                "pages": len(rows),
                "precision": avg(rows, "precision"),
                "recall": avg(rows, "recall"),
                "serpentine_rate": avg(rows, "serpentine_rate"),
                "order_lcs": avg(rows, "order_lcs"),
            }
            o = out[tag][eng]
            print(f"{tag:4s} {eng:8s} {o['pages']:4d} {o['precision']:7.3f} {o['recall']:7.3f} "
                  f"{o['serpentine_rate']:7.3f} {o['order_lcs']:7.3f}")

    p = os.path.join(ROOT, "reports", "oxr-ab-tables.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, ensure_ascii=False, indent=2))
    print("\n写出 " + p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
