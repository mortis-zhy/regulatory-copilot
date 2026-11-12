#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把中文字体**裁成只含本报告用到的字** —— 交付件里嵌的是字形，不是字库。

## 为什么

实测（2026-11-12）：渲染一份 279 页的报告，HTML 有 **99 MB**，
其中 **98 MB 是 4 个字体文件的 base64**（msyh.ttc 19 MB + msyhbd.ttc 16 MB
+ simsun.ttc 17 MB + simsunb.ttf 21 MB ⇒ base64 后 ≈ 98 MB）。

后果不是「慢」，是**会崩**：

| HTML 体积 | `page.setContent()` |
|---|---|
| 80 MB | ok（14.5 s） |
| 100 MB | **失败** —— 「Target page, context or browser has been closed」（1 s） |

也就是说交付件**离崩溃只差 1 MB** —— 报告再长一点点，PDF 就出不来 ✗。
（实测加进 109 张图后 HTML 到 110 MB ⇒ 直接渲染失败 ✗。）

裁字之后：字体从 98 MB 降到 **几 MB** ⇒ HTML 掉到十几 MB ⇒
① 图放得下 ✓ ② 渲染快一个数量级 ✓ ③ 报告再长也不会撞墙 ✓。

## 会不会缺字（豆腐块）

**会**，所以这一步是**受控**的：

- 字符集 = 报告正文 ∪ 全部 CJK 常用字（GB2312 一级 3755 个）∪
  源码里出现的所有汉字（渲染器的固定文案：页眉、页脚、图注…）∪ ASCII/标点；
- 脚本**点名**哪些字在字体里没有（`missing`）——
  闸门据此判红 ✓（「宁可空着，不可错着」）。

用法：
    python scripts/subset_fonts.py --job <job.json>
job.json：
    {"outDir": "dist/fonts", "charset": "…", "fonts": [{"path": "...", "family": "...", "weight": 400}]}
stdout：一行 JSON
    {"fonts": [{"path": "...", "family": "...", "weight": 400, "format": "truetype",
                "bytes": 12345, "missing": ["×"]}], "missing": ["×"]}
"""
import io
import json
import os
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")


def gb2312_level1() -> str:
    """GB2312 一级汉字（3755 个）—— 常用字的兜底集合"""
    out = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes([hi, lo]).decode("gb2312")
            except Exception:
                continue
            out.append(ch)
    return "".join(out)


def subset_one(path, out_path, charset):
    from fontTools import subset
    from fontTools.ttLib import TTFont

    kwargs = {}
    if path.lower().endswith(".ttc"):
        kwargs["fontNumber"] = 0
    font = TTFont(path, lazy=True, **kwargs)
    cmap = font.getBestCmap() or {}
    # cmap 的键是**码位**（int）—— 拿字符（str）去比，永远不在 ⇒ 缺字全是假警报 ✗
    missing = sorted({c for c in charset if ord(c) not in cmap and c.strip()})
    wanted = {c for c in charset if ord(c) in cmap}

    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.notdef_outline = True
    options.recommended_glyphs = True
    options.glyph_names = True
    options.hinting = True
    options.desubroutinize = True

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=charset)
    subsetter.subset(font)
    font.save(out_path)
    # **裁字有没有把原来有的字裁掉** —— 这才是真问题 ✓
    # （`missing` 里那些 emoji 是**原来就没有**的 ⚠ —— 裁字前也一样没有 ✓）
    after = font.getBestCmap() or {}
    dropped = sorted(c for c in wanted if ord(c) not in after)
    font.close()
    return missing, dropped


def main():
    import argparse

    ap = argparse.ArgumentParser(description="按字符集裁字体")
    ap.add_argument("--job", required=True, help="job.json 的路径")
    args = ap.parse_args()
    with io.open(args.job, encoding="utf-8") as f:
        job = json.load(f)

    out_dir = job["outDir"]
    os.makedirs(out_dir, exist_ok=True)
    charset = job.get("charset") or ""
    if job.get("includeGb2312", True):
        charset = charset + gb2312_level1()
    # 控制字符与代理区去掉 —— 裁字工具对它们没有意义
    charset = "".join(c for c in charset if ord(c) >= 0x20 and not (0xD800 <= ord(c) <= 0xDFFF))

    fonts = []
    per_font_missing = []
    dropped_all = set()
    for spec in job.get("fonts") or []:
        src = spec["path"]
        if not os.path.exists(src):
            continue
        name = spec.get("name") or ("%s-%s" % (spec.get("family", "font"), spec.get("weight", 400)))
        out_path = os.path.join(out_dir, name + ".ttf")
        missing, dropped = subset_one(src, out_path, charset)
        per_font_missing.append(set(missing))
        dropped_all.update(dropped)
        fonts.append(
            {
                "path": out_path,
                "family": spec.get("family"),
                "weight": spec.get("weight"),
                "format": "truetype",
                "bytes": os.path.getsize(out_path),
                "missing": missing,
                "dropped": dropped,
            }
        )
    # **每个字体都缺**的字才是真的没有 ✓
    # （一个字缺 A 字体、但 B 字体有 ⇒ 浏览器会回退 ✓ —— 不是缺字 ✗）
    if per_font_missing:
        common = set.intersection(*per_font_missing)
    else:
        common = set()
    print(
        json.dumps(
            {
                "fonts": fonts,
                "missing": sorted(common),
                "dropped": sorted(dropped_all),
                "charset": len(charset),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
