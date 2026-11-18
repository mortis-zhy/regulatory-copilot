#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""读**图里的字**（OCR）—— B.5「图内数值」那一列靠它。

## 为什么需要

B.5 的图对比只到 **pHash「像不像」** ✓ —— 而图上的数字（`80°/45°` 这种
可见角、限值）改了 pHash **几乎不动** ✗。报告里也写明了这条界线 ✗：
「图上的数字/标注有没有变**看不出来**」✗。

源 PDF 的文本层**救不了** ✗：实测 A 版 38 张图、B 版 33 张图，
图矩形内的文本层**一个字都没有** ✓（字是**画进位图**里的 ✓）；
只有 C 版（UN R48）有 12/38 张带文本层 ✓。

所以只能 OCR ✓ —— EasyOCR 的模型权重在本机**已有** ✓（离线 ✓）。

## 输出**不是**原文

OCR 会**读错** ✗（实测：`布局A` → `布局4`、`7a` → `73`）。
所以本文件只存**原始识别结果 + 置信度** ✓，下游只拿它当
「**有没有可能变了**的提示」✓ —— **不当作原文引用** ✗。

## 缓存

按**图片内容 sha256** 缓存 ✓ —— 图重抽了（换了源 PDF、换了 dpi）才重跑 ✓。
换引擎/语言/最低置信度也会整体作废 ✓（`_engine` / `_langs` / `_minConf` 不一致）。

用法：
    python scripts/ocr_figures.py [--in reports/figure-hashes.json]
                                  [--out reports/figure-ocr.json]
                                  [--min-conf 0.0] [--limit N] [--force]
stdout：一行 JSON 摘要
"""
import argparse
import hashlib
import io
import json
import os
import sys
import time

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINE = "easyocr 1.7.2"
LANGS = ["ch_sim", "en"]


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(p, default):
    if not os.path.exists(p):
        return default
    try:
        with io.open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def main():
    ap = argparse.ArgumentParser(description="图内文字 OCR（带内容指纹缓存）")
    ap.add_argument("--in", dest="inp", default=os.path.join(ROOT, "reports", "figure-hashes.json"))
    ap.add_argument("--out", default=os.path.join(ROOT, "reports", "figure-ocr.json"))
    # **只存不滤** ✓ —— 置信度门槛放在比对的 TS 层（可测、可调）✓
    ap.add_argument("--min-conf", type=float, default=0.0)
    ap.add_argument("--limit", type=int, default=0, help="只跑前 N 张（调试用；0 = 全部）")
    ap.add_argument("--force", action="store_true", help="忽略缓存全部重跑")
    args = ap.parse_args()

    hashes = load_json(args.inp, {})
    if not hashes:
        print(json.dumps({"error": "没有图片清单：%s" % args.inp}, ensure_ascii=False))
        return 2

    prev = load_json(args.out, {})
    compatible = (
        prev.get("_engine") == ENGINE
        and prev.get("_langs") == LANGS
        and float(prev.get("_minConf", -1)) == args.min_conf
    )
    images = prev.get("images", {}) if compatible else {}
    if not compatible and prev:
        print("[ocr] 缓存不兼容（引擎/语言/门槛变了）⇒ 全部重跑", file=sys.stderr)

    rels = sorted(hashes.keys())
    if args.limit:
        rels = rels[: args.limit]

    todo = []
    for rel in rels:
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            print("[ocr] 缺图：%s" % rel, file=sys.stderr)
            continue
        sha = sha256_file(p)
        cached = images.get(rel)
        if not args.force and cached and cached.get("sha256") == sha:
            continue
        todo.append((rel, p, sha))

    reader = None
    if todo:
        import easyocr  # 只在真要跑时加载（模型初始化几秒）

        reader = easyocr.Reader(LANGS, gpu=False, verbose=False)

    t0 = time.time()
    for i, (rel, p, sha) in enumerate(todo, 1):
        res = reader.readtext(p, detail=1, paragraph=False)
        items = []
        for _box, text, conf in res:
            text = (text or "").strip()
            if not text:
                continue
            cf = float(conf)
            if cf < args.min_conf:
                continue
            items.append({"text": text, "conf": round(cf, 3)})
        images[rel] = {"sha256": sha, "items": items}
        print("[ocr] %d/%d %s → %d 处" % (i, len(todo), rel, len(items)), file=sys.stderr)

    out = {
        "_engine": ENGINE,
        "_langs": LANGS,
        "_minConf": args.min_conf,
        "_builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "_note": "OCR 结果**不是原文** —— 会读错；下游只当「可能变了」的提示用，须对照原图。",
        "images": images,
    }
    with io.open(args.out, "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=1) + "\n")

    n_items = sum(len(v.get("items", [])) for v in images.values())
    print(json.dumps({
        "images": len(images),
        "ocrdNow": len(todo),
        "items": n_items,
        "seconds": round(time.time() - t0, 1),
        "out": os.path.relpath(args.out, ROOT).replace("\\", "/"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
