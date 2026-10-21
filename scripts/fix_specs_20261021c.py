# -*- coding: utf-8 -*-
"""2026-10-21 修两处**重复行**与**条款引用错**（货车灯具透光面那条）。

发现过程：把附录接进覆盖审计后，「A 4.27 的 80mm/40mm」被当成了新缺口 ——
回头一看，矩阵里**早就有两行**记着同一个要求（80mm 的圆、40mm 的圆），
但它们的 **A 列条款号引成了 4.8**。

A 的 §4.8 是「几何可见度测量方法」那条 —— 4.27 的正文里有一句
「（测量方法参照4.8 b)）」，**就近取条款号**取到了这个**交叉引用**，
于是真出处（4.27）被换成了一个不相干的条款号。
和上一轮「色度坐标引成 5.9.5」是同一类错：**交叉引用吃掉了条款号**。

处理：
1. 删掉这一轮新加的两行重复行（truckLamp.minApparentCircleDiameter /
   truckLamp.minContainedCircleDiameter）—— 已有行记的是同一件事；
2. 给已有两行**写死条款号**：A = 4.27（位图，登记在 data/clause-bitmap-fixes.json）、
   B = 4.29（文本层里有）；
3. heavyVehicle.apertureMinArea 的单位从「mm²（80mm圆面积）」改成 **mm** ——
   原文的数是**直径** 80mm（面积是该圆的面积），写成 mm² 与数字对不上，
   读者会当成 80 平方毫米。

跑法： python scripts/fix_specs_20261021c.py [--check]
"""
import io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

DROP = ["truckLamp.minApparentCircleDiameter", "truckLamp.minContainedCircleDiameter"]

FIX = {
    "aperture.minCircleDiameter": {
        "name": "非圆形透光面最小容纳圆直径",
        "unit": "mm",
        "patterns": {
            "A": {
                "source": "若透光面不是圆形[\\s\\S]{0,40}?容纳一个\\s*(40\\s*(?:mm|㎜))",
                "flags": "i",
                "clause": "4.27",
            },
            "B": {
                "source": "若透光面不是圆形[\\s\\S]{0,40}?容纳一个\\s*(40\\s*(?:mm|㎜))",
                "flags": "i",
                "clause": "4.29",
            },
        },
        "why": {
            "A": "A §4.27（p21，条款号印在 PDF 左边距的位图里，登记在 data/clause-bitmap-fixes.json）："
                 "「总质量不小于4500kg 的货车、专项作业车和挂车的所有后位灯、后转向信号灯和制动灯，"
                 "其透 光面面积应不小于一个80mm 直径圆的面积；若透光面不是圆形，其形状还应能容纳一个"
                 "40mm 直径的 圆。」—— **条款号必须写死**：同一页里有「（测量方法参照4.8 b)）」这个"
                 "交叉引用，就近取条款号会取到 4.8（几何可见度测量方法那条），"
                 "而 4.8 里根本没有 40mm。",
            "B": "B §4.29（p21）：「总质量不小于4500kg的货车、专项作业车和挂车的所有后位灯、后转向信号灯"
                 "和制动灯,其透光面面积应不小于一个80mm 直径圆的面积;若透光面不是圆形,其形状应能容纳一个"
                 "40mm 直径的圆。」—— 同样写死条款号，别让就近推断漂移。",
        },
    },
    "heavyVehicle.apertureMinArea": {
        "name": "总质量≥4500kg车辆灯具透光面·最小等效圆直径（面积不小于该圆面积）",
        "unit": "mm",
        "patterns": {
            "A": {
                "source": "总质量不小于\\s*4500\\s*kg[\\s\\S]{0,140}?不小于一个\\s*(80\\s*(?:mm|㎜))\\s*直径圆的面积",
                "flags": "i",
                "clause": "4.27",
            },
            "B": {
                "source": "总质量不小于\\s*4500\\s*kg[\\s\\S]{0,140}?不小于一个\\s*(80\\s*(?:mm|㎜))\\s*直径圆的面积",
                "flags": "i",
                "clause": "4.29",
            },
        },
        "why": {
            "A": "A §4.27（p21，条款号在位图里）：「…其透 光面面积应不小于一个80mm 直径圆的面积；」"
                 "—— **单位是 mm 不是 mm²**：原文的数是**直径** 80mm（面积是该圆的面积），"
                 "写成 mm² 会让读者以为限值是 80 平方毫米。"
                 "**条款号写死**：同页的「（测量方法参照4.8 b)）」会把就近推断带偏到 4.8。",
            "B": "B §4.29（p21）：「…其透光面面积应不小于一个80mm 直径圆的面积;」—— 单位同理。",
        },
    },
}


def main():
    check = "--check" in sys.argv
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    before = len(doc["specs"])
    doc["specs"] = [s for s in doc["specs"] if s["id"] not in DROP]
    dropped = before - len(doc["specs"])
    changed = []
    for sid, fx in FIX.items():
        s = next((x for x in doc["specs"] if x["id"] == sid), None)
        if s is None:
            print("!! 找不到：%s" % sid)
            return 1
        for k in ("name", "unit"):
            if k in fx and s.get(k) != fx[k]:
                s[k] = fx[k]
                changed.append("%s.%s" % (sid, k))
        for ver, pat in fx.get("patterns", {}).items():
            if s.setdefault("patterns", {}).get(ver) != pat:
                s["patterns"][ver] = pat
                changed.append("%s/%s" % (sid, ver))
        for ver, txt in fx.get("why", {}).items():
            if s.setdefault("why", {}).get(ver) != txt:
                s["why"][ver] = txt
                changed.append("%s/%s why" % (sid, ver))
    print("删掉重复行 %d 条；改动 %d 处：%s" % (dropped, len(changed), changed))
    if check:
        return 0
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("已写入，总行数 %d" % len(doc["specs"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
