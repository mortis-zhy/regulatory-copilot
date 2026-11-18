#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""核**图内限值人工标注**（`data/figure-limits.json`）。

## 机器能核什么、不能核什么

能核 ✓：
1. 图**真的存在**，且在 `reports/figure-hashes.json` 里（图版里真的有这张）；
2. **页码**与图文件名一致（`p<page>_<i>.png`）—— 标错页 = 读者翻过去找不到；
3. **题注**真的是这一页原文里的一串字（归一化空白后精确匹配）✓；
4. 若 `valueBasis` 非空 —— 这句原文真的在 `page` 上 ✓，且**每个数值**都出现在这句话里 ✓；
5. 若 `valueBasis` 为空 ⇒ **必须** `adjudicated: false` ✗ —— 没有原文佐证就不许说「已核」✗。

**不能核** ✗：图里的数值到底是不是这几个 —— 那是**人看图**的事 ✓。
所以本脚本只保证「标注没写错位置」，不保证「标注读对了图」✗。

用法：
    python scripts/check_figure_limits.py [--check]
退出码：0 = 全过；1 = 有问题
"""
import argparse
import io
import json
import os
import re
import sys

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "data", "figure-limits.json")
HASHES = os.path.join(ROOT, "reports", "figure-hashes.json")
MINERU = os.path.join(ROOT, "dist", "mineru-v4-data.json")

RE_VALUE = re.compile(r"^\d{1,6}(?:[.,]\d{1,3})?\s*(°|%|mm|cm|m|km/h|cd|lx|lm)?$")
RE_PAGE = re.compile(r"/p(\d+)_\d+\.png$")


def norm(s):
    return re.sub(r"\s+", "", s or "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="（默认就是检查）")
    ap.add_argument("--ledger", default=LEDGER)
    args = ap.parse_args()

    errors = []
    warns = []
    ledger = json.load(io.open(args.ledger, encoding="utf-8"))
    rows = ledger.get("rows") or []
    hashes = json.load(io.open(HASHES, encoding="utf-8")) if os.path.exists(HASHES) else {}
    meta = json.load(io.open(MINERU, encoding="utf-8"))
    docs = {}

    def page_text(version, page):
        if version not in docs:
            sha = (meta.get(version, {}).get("sourceSha256") or "").lower()
            pdf = os.path.join(ROOT, "uploaded-docs", sha[:16] + ".pdf")
            if not sha or not os.path.exists(pdf):
                docs[version] = None
            else:
                docs[version] = fitz.open(pdf)
        d = docs[version]
        if d is None or page < 1 or page > d.page_count:
            return None
        return d[page - 1].get_text()

    seen = set()
    for i, r in enumerate(rows):
        tag = "第 %d 行（%s p%s）" % (i + 1, r.get("version"), r.get("page"))
        fig = r.get("figure") or ""
        if fig in seen:
            errors.append("%s：图 %s 重复标注" % (tag, fig))
        seen.add(fig)
        if not os.path.exists(os.path.join(ROOT, fig)):
            errors.append("%s：图文件不存在：%s" % (tag, fig))
        elif fig not in hashes:
            errors.append("%s：图不在 reports/figure-hashes.json 里（不是图版里的图）" % tag)
        m = RE_PAGE.search(fig.replace("\\", "/"))
        if not m:
            errors.append("%s：图文件名里读不出页码：%s" % (tag, fig))
        elif int(m.group(1)) != int(r.get("page") or -1):
            errors.append("%s：页码与图文件名不一致（文件名 p%s）" % (tag, m.group(1)))
        cap = r.get("caption") or ""
        if not cap.strip():
            errors.append("%s：没有题注 —— 题注是唯一的机器锚点" % tag)
        for v in r.get("values") or []:
            if not RE_VALUE.match(str(v).strip()):
                errors.append("%s：数值写法不认识：%r" % (tag, v))
        basis = (r.get("valueBasis") or "").strip()
        if not basis and r.get("adjudicated"):
            errors.append("%s：没有原文佐证（valueBasis 为空）却标了 adjudicated:true" % tag)
        if not isinstance(r.get("adjudicated"), bool):
            errors.append("%s：adjudicated 必须是 true/false" % tag)
        if not (r.get("annotator") or "").strip():
            warns.append("%s：没写 annotator" % tag)
        text = page_text(r.get("version"), int(r.get("page") or 0))
        if text is None:
            errors.append("%s：读不到 %s 版 PDF 的这一页" % (tag, r.get("version")))
        else:
            nt = norm(text)
            if cap.strip() and norm(cap) not in nt:
                errors.append("%s：题注在原文这一页上找不到：%s" % (tag, cap))
            if basis:
                if norm(basis) not in nt:
                    errors.append("%s：valueBasis 在这一页原文里找不到" % tag)
                else:
                    for v in r.get("values") or []:
                        num = re.sub(r"[^\d.,]", "", str(v))
                        if num and num not in basis:
                            errors.append("%s：数值 %s 没出现在 valueBasis 里" % (tag, v))

    for d in docs.values():
        if d is not None:
            d.close()

    for w in warns:
        print("  ! " + w)
    if errors:
        print("图内限值标注有 %d 处问题：" % len(errors))
        for e in errors:
            print("  · " + e)
        return 1
    print("图内限值标注 %d 条 ✓（图存在 · 页码一致 · 题注回源 · 有原文才许标已核）" % len(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
