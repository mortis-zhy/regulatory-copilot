#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""抽**公式符号表** —— 「式中：h1——…」「where: h1 is …」这类定义。

## 为什么

B.5 的公式对比只到**字符串**：归一化后完全相同才算对 ✓。
「同一个式子、符号换了/定义变了」这类比不出来 ✗ —— 那要**符号表** ✓。

符号表本身不判语义 ✓，但它把三件事变成机器可比的 ✓：
1. 每个符号**这一版有没有定义** ✓（没有 ≠ 写法不同，须人核 ✗）；
2. 定义里的**单位** ✓（mm / % / °）；
3. 定义出现在**哪一页** ✓（可回源 ✓）。

## 只认**明确的定义块**

- 中文：`式中：` 后面连续若干 `符号——定义` ✓；
- 英文：`where:` 后面连续若干 `symbol is 定义` ✓
  （不认 `In the case where …` 这种条件句 ✗ —— 实测满篇都是 ✗）。

用法：
    python scripts/extract_formula_symbols.py [--out data/formula-symbols.json]
stdout：一行 JSON 摘要
"""
import argparse
import io
import json
import os
import re
import sys

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MINERU = os.path.join(ROOT, "dist", "mineru-v4-data.json")

RE_CN_START = re.compile(r"式中\s*[:：]")
RE_EN_START = re.compile(r"\bwhere\s*:")
# 中文定义：`h1 ——…` / `h1———…`（B 版是三个破折号）
RE_CN_SYM = re.compile(r"([A-Za-zμΜ][A-Za-z0-9₀-₉]{0,2})\s*[—–-]{1,3}\s*")
# 英文定义：`h1  is the …`
RE_EN_SYM = re.compile(r"\b([A-Za-z][A-Za-z0-9]{0,2})\s+is\s+")

UNIT_MAP = {
    "mm": "mm", "millimetre": "mm", "millimetres": "mm", "毫米": "mm",
    "m": "m", "metre": "m", "metres": "m", "米": "m",
    "%": "%", "per cent": "%", "percent": "%", "％": "%",
    "°": "°", "degree": "°", "degrees": "°",
    "mrad": "mrad",
}
RE_UNIT_CN = re.compile(r"单位\s*[：:]\s*([A-Za-zμ㎡㎜%°％]+)|毫米\s*\(\s*(mm)\s*\)|毫米\s*（\s*(mm)\s*）")
RE_UNIT_EN = re.compile(
    r"\bin\s+(millimetres?|metres?|per\s*cent|percent|degrees?|mrad)\b", re.I
)


def norm_ws(s):
    return re.sub(r"\s+", " ", s or "").strip()


def unit_of(definition):
    m = RE_UNIT_CN.search(definition)
    if m:
        u = next(x for x in m.groups() if x)
        u = u.replace("㎜", "mm").replace("％", "%")
        return UNIT_MAP.get(u.lower() if u.isascii() else u, u)
    m = RE_UNIT_EN.search(definition)
    if m:
        u = re.sub(r"\s+", " ", m.group(1).lower())
        return UNIT_MAP.get(u, u)
    return ""


def split_defs(block, sym_re, stop_re):
    """把定义块切成 [(symbol, definition)]。"""
    spots = list(sym_re.finditer(block))
    out = []
    for i, m in enumerate(spots):
        start = m.end()
        end = spots[i + 1].start() if i + 1 < len(spots) else len(block)
        seg = block[start:end]
        cut = stop_re.search(seg)
        if cut:
            seg = seg[: cut.start()]
        seg = norm_ws(seg).strip(" ,，;；")
        if seg:
            out.append((m.group(1), seg))
    return out


def blocks_of(text):
    """一页里的定义块：[(kind, block)]。"""
    found = []
    for m in RE_CN_START.finditer(text):
        found.append(("cn", text[m.end() : m.end() + 900]))
    for m in RE_EN_START.finditer(text):
        found.append(("en", text[m.end() : m.end() + 1400]))
    return found


def main():
    ap = argparse.ArgumentParser(description="抽公式符号定义")
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "formula-symbols.json"))
    args = ap.parse_args()

    meta = json.load(io.open(MINERU, encoding="utf-8"))
    versions = {}
    blocks = []
    for v in sorted(meta.keys()):
        sha = (meta[v].get("sourceSha256") or "").lower()
        pdf = os.path.join(ROOT, "uploaded-docs", sha[:16] + ".pdf")
        if not sha or not os.path.exists(pdf):
            print("[symbols] 缺源 PDF：%s（%s）" % (v, pdf), file=sys.stderr)
            continue
        versions[v] = sha
        doc = fitz.open(pdf)
        for pno in range(doc.page_count):
            text = doc[pno].get_text()
            for kind, block in blocks_of(text):
                if kind == "cn":
                    syms = split_defs(block, RE_CN_SYM, re.compile(r"如图|注\s*[:：]|\(?\s*[A-Z]\s*\.\s*\d"))
                else:
                    syms = split_defs(
                        block, RE_EN_SYM, re.compile(r"Negative values|Positive values|Figure\s+\d|Note\s*:")
                    )
                syms = [(s, d) for s, d in syms if len(d) >= 4]
                if not syms:
                    continue
                blocks.append(
                    {
                        "version": v,
                        "page": pno + 1,
                        "symbols": [
                            {"symbol": s, "definition": d, "unit": unit_of(d)}
                            for s, d in syms
                        ],
                    }
                )
        doc.close()

    out = {
        "_generator": "scripts/extract_formula_symbols.py",
        "_sourceSha256": versions,
        "_note": "符号表只判**有没有定义 / 单位 / 页码**，不判语义（定义文字语言不同，须人判）。",
        "blocks": blocks,
    }
    with io.open(args.out, "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    n = sum(len(b["symbols"]) for b in blocks)
    print(json.dumps({
        "blocks": len(blocks),
        "symbols": n,
        "byVersion": {v: sum(len(b["symbols"]) for b in blocks if b["version"] == v) for v in versions},
        "out": os.path.relpath(args.out, ROOT).replace("\\", "/"),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
