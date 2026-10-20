# -*- coding: utf-8 -*-
"""把 endOutlineMarker.minGapToPositionLamp 的 C 侧条款号从 6.13.9 改成章级 6.13。

原因：条款级清点（scripts/clause_split.py，源 PDF 文本层）显示 R48 的 6.13.9 是
「Other requirements: Provided that all other requirements are met, the mandatory or
optional lamps … may be combined into one device.」—— **与 200mm 无关**。
那 200mm 在示廓灯章 §6.13 的**表格行**里，而 MinerU 把这一行和 §6.14 的表格首行
揉在了一起（行首标签 `| 6.14.6.14.1. |`），源 PDF 里这句话又跨页，
**定位不到具体条款号**。按「宁可空着，不可错着」：印一个客户一翻就发现不对的
条款号，比只给章级更糟。

用法： python scripts/fix_endoutline_clause.py
"""
import io, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

NEW_WHY = (
    "R48 的这条在**示廊灯章 §6.13 的表格行**里（p67）："
    "「The position of an end-outline marker lamp in relation to corresponding position lamp "
    "shall be such that the distance between the projections … is not less than 200 mm.」"
    "—— 上一轮曾把这一格写成「R48 无此规定（已核）」，**那是假的**：MinerU 把这段排成表格行、"
    "行首标签还是乱的（`| 6.14.6.14.1. |`），按条款号检索搜不到。"
    "**把抽取失败写成法规结论，比留空更糟。** "
    "条款号**只给到章级 6.13**：这一行在源 PDF 里跨表又跨页"
    "（§6.13 的表格行末尾与 §6.14 的表格首行被 MinerU 揉在一起，源 PDF 里这句话也跨页），"
    "**定位不到具体条款号** —— 印一个客户翻不到、而且一翻就发现不对的条款号"
    "（上一轮写的 6.13.9 其实是「Other requirements: … 可组合成一个装置」，与 200mm 无关），"
    "比给章级更糟。GB 两版的同一条是 §5.13.9。"
).replace("示廊灯", "示廓灯")


def main():
    s = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(s)
    hit = 0
    for sp in data["specs"]:
        if sp["id"] != "endOutlineMarker.minGapToPositionLamp":
            continue
        c = sp["patterns"].get("C", {})
        if c.get("clause") == "6.13":
            print("已经是 6.13，跳过")
            return
        if c.get("clause") != "6.13.9":
            print("条款号不是 6.13.9，实际是 %r —— 不动" % c.get("clause"))
            return
        c["clause"] = "6.13"
        sp.setdefault("why", {})["C"] = NEW_WHY
        hit += 1
    if not hit:
        print("没找到这一行")
        return
    out = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    io.open(SPEC, "w", encoding="utf-8", newline="").write(out)
    print("已改成章级 6.13（why 已重写）")


if __name__ == "__main__":
    main()
