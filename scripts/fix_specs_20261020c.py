# -*- coding: utf-8 -*-
"""修 2026-10-20 覆盖审计之后挖出来的**条款引用错**（不是值错）。

发现的错：A 列的**色度坐标**四行把条款号报成 `5.9.5`（前位灯几何可见度），
实际上色度坐标在 **4.15 光色**（表1 装置发出的光色）。
根因是「就近取条款号」在 A 第 16 页上撞上了同一页的**交叉引用**
「——符合5.9.5 规定的前位灯几何可见度要求」。

B 列同一批行的条款号是空的（值在第 17 页的表里，条款在第 16 页，
就近取不到），这次一并补上 `4.15`。

跑法： python scripts/fix_specs_20261020c.py            （改）
      python scripts/fix_specs_20261020c.py --check    （只验）
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPECS = os.path.join(ROOT, "data", "parameter-specs.json")
BITMAP = os.path.join(ROOT, "data", "clause-bitmap-fixes.json")

WHY = {
    "chromaticity.blueBoundary": {
        "A": "色度坐标在 **4.15 光色**（表1 装置发出的光色），不在前位灯条款里。"
             "原先报 5.9.5 是「就近取条款号」撞上了同一页的交叉引用"
             "「——符合5.9.5 规定的前位灯几何可见度要求」。"
             "A 第 4 章的条款号印在 PDF 左边距、是位图，文本层取不到，"
             "所以这里显式声明 4.15（登记在 data/clause-bitmap-fixes.json）。",
        "B": "B 的 4.15 在正文里有（4.15 光色采用GB/T3977…见表1~表4），"
             "但色度值本身在第 17 页的表1 里、条款在第 16 页，"
             "「就近取条款号」跨不到，显式声明 4.15。",
    },
    "chromaticity.whiteBoundary": {
        "A": "同 chromaticity.blueBoundary：色度坐标属 **4.15 光色**，"
             "不是 5.9.5 前位灯几何可见度；A 的 4.15 是位图，显式声明。",
        "B": "同 chromaticity.blueBoundary：显式声明 B 的 4.15。",
    },
    "chromaticity.yellowGreenBoundary": {
        "A": "同 chromaticity.blueBoundary：色度坐标属 **4.15 光色**，"
             "不是 5.9.5 前位灯几何可见度；A 的 4.15 是位图，显式声明。",
        "B": "同 chromaticity.blueBoundary：显式声明 B 的 4.15。",
    },
}
IDS = list(WHY)


def main():
    check = "--check" in sys.argv
    doc = json.load(io.open(SPECS, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    changed = []
    for sid in IDS:
        s = by_id.get(sid)
        if s is None:
            print("!! 找不到 spec：%s" % sid)
            return 1
        for ver in ("A", "B"):
            pat = (s.get("patterns") or {}).get(ver)
            if pat is None:
                continue
            if isinstance(pat, str):
                pat = {"source": pat}
                s["patterns"][ver] = pat
            if pat.get("clause") != "4.15":
                pat["clause"] = "4.15"
                changed.append("%s/%s" % (sid, ver))
        why = s.setdefault("why", {})
        for ver, txt in WHY[sid].items():
            if why.get(ver) != txt:
                why[ver] = txt
                changed.append("%s/%s why" % (sid, ver))
    if check:
        print("需要改动 %d 处：%s" % (len(changed), changed[:8]))
        return 0
    if changed:
        io.open(SPECS, "w", encoding="utf-8", newline="").write(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
        print("改了 %d 处" % len(changed))

    # A 的 4.15 是位图 —— 登记在案，交付闸门才认这个显式条款号
    bm = json.load(io.open(BITMAP, encoding="utf-8"))
    bm.setdefault("A", {})
    if "4.15" not in bm["A"]:
        bm["A"]["4.15"] = (
            "GB 4785 草案第 4 章的条款号印在 PDF 左边距，是**位图**，文本层取不到。"
            "本条对应第 4 章的「光色」条款：「光色采用GB/T 3977 中CIE1931 标准色度系统的"
            "色品坐标，见表1 至表4（若灯具在其零部件型式试验已证明符合以下色度坐标要求，"
            "本文件的型式试验可不进行该灯具色度坐标的检测）。灯具的光色要求见表5。」"
            "（源 PDF p16）。条款号由左边距裁剪渲染读出，并与同页 4.13/4.14 的"
            "前后条款顺序相互印证。"
        )
        io.open(BITMAP, "w", encoding="utf-8", newline="").write(
            json.dumps(bm, ensure_ascii=False, indent=2) + "\n")
        print("登记 A 的位图条款号 4.15")
    return 0


if __name__ == "__main__":
    sys.exit(main())
