# -*- coding: utf-8 -*-
"""补最后一条 R48 量化项：醒目标志的结构受限替代安装高度上限（2,500mm）。"""
import io, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

SPEC_ROW = {
    "id": "conspicuityMarking.alternativeMaxHeight",
    "name": "醒目标志最大安装高度（结构受限时的替代上限）",
    "family": "安装高度 / 离地距离",
    "unit": "mm",
    "patterns": {
        "A": {"source": "醒目标志的最大安装高度", "flags": "i"},
        "B": {"source": "醒目标志的最大安装高度", "flags": "i"},
        "C": {"source": r"maximum mounting height of\s*(2[ ,]500\s*mm)", "flags": "i", "clause": "6.21.4.3.1"},
    },
    "why": {
        "A": "GB 4785 草案的醒目标志章只有一句「汽车及挂车车身反光标识和车辆尾部标志板的安装按 GB 11564 要求」—— 没有自己的量值。R48 §6.21.4.3.1 给了 250mm~1500mm 的区间与 2,500mm 的结构受限替代上限。",
        "B": "GB 4785-2019 的醒目标志章（§5.21）同样只有两句「按 GB23254 / GB25990 相关要求」。",
        "C": "R48 §6.21.4.3.1：「However, a maximum mounting height of 2,500 mm may be accepted where the shape, structure, design or operational conditions of the vehicle prevent compliance with the maximum value of 1,500 mm …」。**条款号显式写 6.21.4.3.1**：条款号在第 79 页、正文在第 80 页（跨页），正则按措辞锚、条款号写明。",
    },
    "absent": {
        "A": "GB 4785 草案的醒目标志章没有自己的量值（整章一句「按 GB 11564 要求」）—— 安装高度由 GB 11564 规定。R48 §6.21.4.3.1 自己给了 250~1500mm 与 2,500mm 替代上限。属版本差异，不是抽取失败。",
        "B": "GB 4785-2019 的醒目标志章没有自己的量值（整章两句「按 GB23254 / GB25990 相关要求」）—— 安装高度由那两份标准规定。R48 §6.21.4.3.1 自己给了 250~1500mm 与 2,500mm 替代上限。属版本差异，不是抽取失败。",
    },
}


def main():
    s = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(s)
    if any(x["id"] == SPEC_ROW["id"] for x in data["specs"]):
        print("已存在，跳过")
        return
    body = json.dumps(SPEC_ROW, ensure_ascii=False, indent=2)
    body = "\n".join(("    " + ln) if ln else ln for ln in body.split("\n"))
    idx = s.rstrip().rfind("]")
    head = s[:idx].rstrip()
    s2 = head + ",\n" + body + "\n  ]\n}\n"
    json.loads(s2)
    io.open(SPEC, "w", encoding="utf-8", newline="").write(s2)
    print("已加 1 行，总行数 %d" % len(json.loads(s2)["specs"]))


if __name__ == "__main__":
    main()
