#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""给抽出来的图算**感知哈希（pHash）** —— 跨版本认「同一张图」靠它。

## 为什么不能用文件名/页码

图版是按**页码**抽的 ✓，而三版的页码体系不同 ✗（A 103 页、B 81 页、C 147 页 ✓）。
同一张图在 A 的 p38、B 的 p30 ✓ —— 名字与页码都对不上 ✓。

pHash 给的是**图像内容**的 64 位指纹 ✓：
两版里同一张图（哪怕被重新渲染、缩放）距离很小 ✓；
两张不同的图距离很大 ✓。

## 它**不是**什么

- **不是**「像素逐位相同」✗ —— 它是 8×8 低频 DCT 与中位数比 ✓，抗轻微缩放/压缩 ✓；
- **不是**「内容语义相同」✗ —— 图上改了一个尺寸数字 ✓，pHash 几乎不动 ✗
  ⇒ 报告里只能说「**图像近似**（距离 N）」✓，**不许**说「两版一致」✗。

用法：
    python scripts/hash_figures.py --dir dist/figures --out reports/figure-hashes.json
"""
import argparse
import io
import json
import os
import sys

import numpy as np
from PIL import Image

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def phash(path, size=32, hash_size=8):
    """经典 pHash：灰度 → 缩到 32×32 → DCT → 取左上 8×8 → 与中位数比 → 64 位。"""
    img = Image.open(path).convert("L").resize((size, size), Image.LANCZOS)
    px = np.asarray(img, dtype=np.float32)
    # 二维 DCT-II（用 numpy 的 FFT 更省事：先对行做 dct，再对列）
    d = _dct(px)           # 行
    d = _dct(d.T).T        # 列
    low = d[:hash_size, :hash_size]
    med = np.median(low[1:])  # 去掉直流分量再取中位数
    bits = (low > med).flatten()
    # 打包成 16 位十六进制
    h = 0
    for b in bits:
        h = (h << 1) | int(bool(b))
    return "%016x" % h


def _dct(x):
    n = x.shape[1]
    k = np.arange(n).reshape(-1, 1)
    i = np.arange(n).reshape(1, -1)
    basis = np.cos(np.pi * (2 * i + 1) * k / (2 * n)) * np.sqrt(2.0 / n)
    basis[0, :] = np.sqrt(1.0 / n)
    return x @ basis.T


def main():
    ap = argparse.ArgumentParser(description="图的感知哈希")
    ap.add_argument("--dir", default="dist/figures")
    ap.add_argument("--out", default="reports/figure-hashes.json")
    args = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    base = os.path.join(root, args.dir)
    if not os.path.isdir(base):
        print(json.dumps({"error": "目录不存在：%s" % base}, ensure_ascii=False))
        raise SystemExit(2)

    out = {}
    n = 0
    for dirpath, _dirnames, files in os.walk(base):
        for f in sorted(files):
            if not f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
                continue
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, root).replace("\\", "/")
            try:
                w, h = Image.open(p).size
                out[rel] = {"phash": phash(p), "w": w, "h": h, "bytes": os.path.getsize(p)}
                n += 1
            except Exception as e:  # 单张坏了不影响整批 ✓
                out[rel] = {"error": str(e)[:80]}
    dest = os.path.join(root, args.out)
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    io.open(dest, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(json.dumps({"images": n, "out": args.out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
