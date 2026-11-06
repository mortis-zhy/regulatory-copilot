#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""表格抽取质量：把 OXR/MinerU A/B 实测的判据固化成可复算的测量。

## 为什么这道测量是新的、且必须单列

`server/reports/corroboration.ts` 的取值级复核能抓「**编出来的数**」——
值在源 PDF 全篇都找不到的，一格都不放过。

但它**抓不到串行错位（配对错）**：串行错误的形态是
「标签和它的坐标之间被别的东西插进来了」，
**每个数都是真的**（都在源 PDF 的那一页上），只是**配错了对象**。

OXR/MinerU 的 A/B 实测（`scripts/oxr_ab_tables.py`）里，M1（数字精确率）
对 MinerU 是 0.857 / 0.210 / 0.906 —— 也就是说
**20%–79% 的「抽到的数」根本不是真的**（B 版最糟），
而 M3（串行率）直接量出这种错误的形态。

已知坏点：GB 4785-2019 的色度表（W1 拿到了表 2 的 0.373/0.402）。
交付件里的解法是「源 PDF 文本层兜底」——
但那是个**人工修的例外**，不是机制。

所以这一份测量要回答的是：
**现在还有哪些矩阵取值，是从「串行率高」的 MinerU 表格里取的？**

## 指标

- **M1 数字精确率** —— 抽到的数里有多少真在源页里出现过（查「编出来的数」）
- **M3 串行率** —— 一个格子里塞了 ≥3 个数的比例（串行错误的直接特征；
  源 PDF 每格通常 1–2 个数）
- **风险格清单** —— 矩阵里那些**取值来自 MinerU、且所在源页串行率偏高**的格子。
  它们不是错（每个数都在页上），但**配对可能错**，人工应当看一眼。

用法： python scripts/table_quality.py
"""
import io
import json
import os
import re
import sys
from collections import defaultdict

import fitz

# 源 PDF 是哪几份 —— **从声明取**（scripts/source_pdfs.py 是唯一实现）。
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
from source_pdfs import source_pdfs, source_pdf

sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NUM = re.compile(r"\d+(?:\.\d+)?")


WS = re.compile(r"\s+")
TAGS = re.compile(r"<[^>]+>")


def norm(s: str) -> str:
    """与 matrix_page_check.py 同口径的归一化。"""
    s = TAGS.sub(" ", s or "")
    s = re.sub(r"\$\s*\\mathrm\s*\{([^}]*)\}\s*\$", r"\1", s)
    s = re.sub(r"\\[a-zA-Z]+", " ", s)
    s = s.replace("^", "").replace("{", "").replace("}", "").replace("_", "")
    s = s.replace("|", "").replace("㎜", "mm")
    return WS.sub("", s)


def _isnum(x):
    try:
        float(str(x))
        return True
    except (TypeError, ValueError):
        return False


def nums(text):
    out = []
    for m in NUM.finditer(text or ""):
        try:
            f = float(m.group(0))
        except ValueError:
            continue
        if 0 < f < 100000:
            out.append(round(f, 4))
    return out


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


def main():
    mineru = json.load(io.open(os.path.join(ROOT, "dist", "mineru-v4-data.json"), encoding="utf-8"))
    # 源 PDF 是哪几份 —— **从声明取**（文件名里带版本号与页数，换标准时全换）。
    SRC = {k: os.path.basename(p) for k, p in source_pdfs().items()}
    report = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = report["parameterMatrix"]

    per_version = {}
    risky = []
    for tag, fname in SRC.items():
        path = source_pdf(tag)
        doc = fitz.open(path)
        mu = mineru_cells(mineru[tag])
        pages = sorted(set(mu.keys()))
        page_stats = {}
        for pg in pages:
            if pg - 1 >= doc.page_count:
                continue
            src_nums = set(nums(doc[pg - 1].get_text()))
            cells = mu.get(pg, [])
            cell_nums = []
            over = 0
            for c in cells:
                ns = nums(c)
                cell_nums.extend(ns)
                if len(ns) >= 3:
                    over += 1
            hit = sum(1 for n in cell_nums if n in src_nums)
            page_stats[pg] = {
                "cells": len(cells),
                "nums": len(cell_nums),
                "precision": round(hit / len(cell_nums), 3) if cell_nums else 1.0,
                "serpentine_rate": round(over / len(cells), 3) if cells else 0.0,
            }
        doc.close()

        ser = [p for p, s in page_stats.items() if s["serpentine_rate"] > 0]
        avg_p = round(sum(s["precision"] for s in page_stats.values()) / max(1, len(page_stats)), 3)
        avg_s = round(sum(s["serpentine_rate"] for s in page_stats.values()) / max(1, len(page_stats)), 3)
        per_version[tag] = {
            "table_pages": len(page_stats),
            "precision": avg_p,
            "serpentine_rate": avg_s,
            "pages_with_serpentine": sorted(ser),
        }
        print(f"--- {tag}：{len(page_stats)} 个表格页 · M1 精确率 {avg_p} · M3 串行率 {avg_s}")
        print(f"    串行率 > 0 的页：{sorted(ser)[:20]}")

        # 风险格：**具体那一格**是不是串行出来的。
        #
        # 整页的串行率 > 0 只说明「这一页上有格被串坏了」，
        # 并不说明矩阵取的那一格就坏了 —— 所以要回到**单元格**：
        # 在那一页的 MinerU 表格里，找到含这个取值的那些格，
        # 看它们各自塞了几个数。塞了 ≥3 个的，就是**这个取值**本身
        # 从一个串行格里出来的，配对可能错。
        for r in rows:
            c = r["cells"].get(tag) or {}
            if c.get("status") != "verified":
                continue
            if c.get("source") != "MinerU":
                continue
            m = re.search(r"第\s*(\d+)\s*页", str(c.get("page") or ""))
            if not m:
                continue
            pg = int(m.group(1))
            st = page_stats.get(pg)
            if not st or st["serpentine_rate"] <= 0:
                continue
            want = {round(float(x), 4) for x in (c.get("nums") or []) if _isnum(x)}
            if not want:
                continue
            # 该页的 MinerU 表格格：含全部取值的那些
            hits = []
            for celltext in mu.get(pg, []):
                cn = set(nums(celltext))
                if want and want <= cn:
                    hits.append((len(cn), celltext))
            if not hits:
                continue
            worst = max(h[0] for h in hits)
            if worst < 3:
                continue                      # 这一格本身是干净的
            risky.append({
                "id": r["id"], "version": tag, "page": pg,
                "value": "/".join(c.get("nums") or []) or str(c.get("value"))[:40],
                "cell_numbers": worst,
                "page_serpentine_rate": st["serpentine_rate"],
                "page_precision": st["precision"],
                "cell_text": hits[0][1][:120],
            })

    # 交叉复核：**这个取值是从一个串行格里出来的，配对到底有没有错？**
    #
    # 复核的「引文」档与「标签+取值」档都成立 ⟹ 标签与数值**一起**在源 PDF 那一页上
    # ⟹ **配对已验**（不管那个串行格里还有多少别的数）。
    # 只有「取值」这一档 ⟹ 那个数确实在页上，但**它配的是哪个标签没验过**。
    pairing_ok = []
    pairing_unverified = []
    pairing_na = []
    for x in risky:
        r = next(rr for rr in rows if rr["id"] == x["id"])
        cell = r["cells"].get(x["version"], {}) or {}
        ev = cell.get("corroborated") or {}
        x["evidence"] = ev.get("evidence")
        if ev.get("evidence") in ("excerpt", "match"):
            pairing_ok.append(x)
        elif len(norm(str(cell.get("match") or ""))) < 8:
            # match 就是值本身（'0.5 cd' / '2.0 Hz'）—— **没有标签可配错**，
            # 「配对」这回事对它不成立。条款与取值都在页上就够了。
            x["pairing"] = "无可配对（match 就是值本身）"
            pairing_na.append(x)
        else:
            x["pairing"] = "未验"
            pairing_unverified.append(x)

    print(f"\n===== 风险格：取值来自 MinerU、且所在页有串行错误形态 =====")
    print(f"{len(risky)} 格 —— **配对已验** {len(pairing_ok)} · 无可配对 {len(pairing_na)} · **配对未验** {len(pairing_unverified)}")
    for x in pairing_unverified:
        print(f"  [!] 配对未验  {x['id']} / {x['version']} 第{x['page']}页  取值={x['value']}  证据={x['evidence']}")
        print(f"      取自：{x['cell_text'][:90]}")
    for x in pairing_na:
        print(f"  [-] 无可配对  {x['id']} / {x['version']}  取值={x['value']}  （match 就是值本身，没有标签可配错）")
    by_page = defaultdict(list)
    for x in risky:
        by_page[(x["version"], x["page"])].append(x)
    for (v, pg), xs in sorted(by_page.items()):
        print(f"  {v} 第{pg}页（该格含 {xs[0]['cell_numbers']} 个数 · 整页串行率 {xs[0]['page_serpentine_rate']}）：{len(xs)} 格")
        for x in xs[:6]:
            print(f"      {x['id']:44s} {x['value']}   ← 取自：{x['cell_text'][:60]}")

    out = {
        "perVersion": per_version,
        "riskyCells": risky,
        "pairingVerified": [x["id"] + "/" + x["version"] for x in pairing_ok],
        "pairingNotApplicable": [x["id"] + "/" + x["version"] for x in pairing_na],
        "pairingUnverified": [x["id"] + "/" + x["version"] for x in pairing_unverified],
        "summary": {
            "risky": len(risky),
            "pairingVerified": len(pairing_ok),
            "pairingNotApplicable": len(pairing_na),
            "pairingUnverified": len(pairing_unverified),
            "cells": sum(len(c.get("nums") or []) for c in
                         [r["cells"].get(v) or {} for r in rows for v in ("A", "B", "C")]),
        },
    }
    p = os.path.join(ROOT, "reports", "table-quality.json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(out, ensure_ascii=False, indent=2))
    print("\n写出 " + p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
