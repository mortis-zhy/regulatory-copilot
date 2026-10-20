# -*- coding: utf-8 -*-
"""第二批新行（按条款写的）—— R48 量化项里还没进矩阵的那 17 条里的 10 条。

用法： python scripts/add_specs2.py
"""
import io, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

NEW = [
    {
        "id": "rearReflexReflector.narrowWidthThreshold",
        "name": "非三角形后回复反射器内缘间距可减小的车宽门槛",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.14\.4\.1[\s\S]{0,300}?车\s*宽\s*小\s*于\s*(1300)\s*(?:mm|㎜)", "flags": "i"},
            "B": {"source": r"5\.14\.4\.1[\s\S]{0,300}?车\s*宽\s*小\s*于\s*(1300)\s*mm", "flags": "i"},
            "C": {"source": r"6\.14\.4\.1[\s\S]{0,700}?less than\s*(1[ ,]300)\s*mm", "flags": "i"},
        },
        "why": {
            "A": "非三角形后回复反射器（草案 §5.14）的内缘间距：600mm，车宽小于 1300mm 时可减至 400mm。**这三个数在同一条款里**（600 / 1300 / 400），补上之前矩阵里只有 600 和 1300，400 没人认领 —— 这就是「逐参数写正则」的必然漏法。",
            "B": "同 A。B 的正文逐字加空格，汉字之间要 `\\s*`。",
            "C": "R48 §6.14.4.1 同一条款三个数：600 / 400 / 1,300（千分位写法）。",
        },
    },
    {
        "id": "rearReflexReflector.innerEdgeGapNarrow",
        "name": "非三角形后回复反射器视表面内边缘间距下限（车宽<1300mm 时可减至）",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.14\.4\.1[\s\S]{0,300}?可\s*为\s*不\s*小\s*于\s*(400\s*(?:mm|㎜))", "flags": "i"},
            "B": {"source": r"5\.14\.4\.1[\s\S]{0,300}?可\s*为\s*不\s*小\s*于\s*(400\s*mm)", "flags": "i"},
            "C": {"source": r"6\.14\.4\.1[\s\S]{0,700}?may be reduced to\s*(400\s*mm)", "flags": "i"},
        },
        "why": {
            "A": "A 的措辞是「该间距**可为**不小于 400mm」，B 同样是「可为不小于」—— **不是**「可减至」：正则按原文写，别照抄别的灯的措辞（制动灯那一族写的是「可减至为不小于」）。",
            "B": "同 A。B 的原文也是「可为不小于400mm」。",
            "C": "R48 §6.14.4.1：「This distance may be reduced to 400 mm where the overall width of the vehicle is less than 1,300 mm.」",
        },
    },
    {
        "id": "rearReflexReflector.lowMountHeightThreshold",
        "name": "非三角形后回复反射器低安装高度门槛（可见度角可减小的条件）",
        "family": "几何可见度 / 安装角度",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.14\.5[\s\S]{0,300}?离\s*地\s*高\s*度\s*小\s*于\s*(750)\s*(?:mm|㎜)", "flags": "i"},
            "B": {"source": r"5\.14\.5[\s\S]{0,300}?离\s*地\s*高\s*度\s*小\s*于\s*(750)\s*mm", "flags": "i"},
            "C": {"source": r"Vertical angle:\s*10° above and below horizontal[\s\S]{0,200}?mounted below\s*(750)\s*mm",
                  "flags": "i", "clause": "6.14.5"},
        },
        "why": {
            "A": "草案 §5.14.5 几何可见度：垂直方向角上下各 10°，离地高度小于 750mm 时下方可由 10° 减至 5°。",
            "B": "同 A。B 的这一句是逐字加空格的（「对 于 离 地 高 度 小 于 750 mm」），汉字之间要 `\\s*`。",
            "C": "**条款号显式写 6.14.5**：MinerU 把 R48 §6.14 的表格行标签揉坏了 —— 真实标签 `6.14.5.` 被并成了 `6.14.4.3.6.14.5.`（下一行的标签并进上一行），正则锚不到条款号。源 PDF 的文本层里是干净的（scripts/clause_split.py 可查），所以条款号按源 PDF 写明，理由记在这里。",
        },
    },
    {
        "id": "conspicuityMarking.minDistanceToStopLamp",
        "name": "醒目标志与强制安装制动灯的最小间距",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": "与强制安装的制动灯", "flags": "i"},
            "B": {"source": "与强制安装的制动灯", "flags": "i"},
            "C": {"source": r"6\.21\.7\.3[\s\S]{0,200}?greater than\s*(200\s*mm)", "flags": "i"},
        },
        "why": {
            "A": "**GB 4785 草案的醒目标志章没有自己的量值**：正文只有一句「汽车及挂车车身反光标识和车辆尾部标志板的安装按 GB 11564 要求」—— 全部委托给 GB 11564。R48 §6.21.7.3 自己写了 200mm。属版本差异，不是抽取失败。",
            "B": "**GB 4785-2019 的醒目标志章同样没有量值**，而且连引用的标准都换了：「汽车及挂车车身反光标识的安装按 GB23254 相关要求。车辆尾部标志板的安装按 GB25990 相关要求。」—— 草案引 GB 11564，2019 版引 GB 23254/GB 25990。R48 则自己规定间距。",
            "C": "R48 §6.21.7.3：「The distance between the conspicuity marking fitted to the rear of a vehicle and each mandatory stop lamp should be greater than 200 mm.」",
        },
        "absent": {
            "A": "GB 4785 草案的醒目标志章（目录 5.20，正文标题「醒目标志」）**只有一句**：「汽车及挂车车身反光标识和车辆尾部标志板的安装按 GB 11564 要求」—— 自身没有任何可比的量值，间距与宽度全部委托给 GB 11564。R48 §6.21.7.3/6.21.7.5 自己写了 200mm / 60mm。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 的醒目标志章（§5.21）**只有两句**：「汽车及挂车车身反光标识的安装按 GB23254 相关要求。车辆尾部标志板的安装按 GB25990 相关要求。」—— 自身没有任何可比的量值。R48 §6.21.7.3/6.21.7.5 自己写了 200mm / 60mm。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "conspicuityMarking.minMarkingWidth",
        "name": "醒目标志安装位置的最小标记宽度",
        "family": "几何可见度 / 安装角度",
        "unit": "mm",
        "patterns": {
            "A": {"source": "标记的宽度", "flags": "i"},
            "B": {"source": "标记的宽度", "flags": "i"},
            "C": {"source": r"6\.21\.7\.5[\s\S]{0,200}?at least\s*(60\s*mm)\s*in width", "flags": "i"},
        },
        "why": {
            "A": "同 minDistanceToStopLamp：草案的醒目标志章把量值全部委托给 GB 11564。",
            "B": "同 A：2019 版委托给 GB 23254 / GB 25990。",
            "C": "R48 §6.21.7.5：「The locations on the vehicle designated for conspicuity markings shall allow for the installation of markings of at least 60 mm in width.」",
        },
        "absent": {
            "A": "GB 4785 草案的醒目标志章没有自己的量值（整章一句「按 GB 11564 要求」）—— 标记宽度由 GB 11564 规定。R48 §6.21.7.5 自己写了 60mm。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 的醒目标志章没有自己的量值（整章两句「按 GB23254 / GB25990 相关要求」）—— 标记宽度由那两份标准规定。R48 §6.21.7.5 自己写了 60mm。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.narrowWidthThreshold",
        "name": "AFS 各模式照明单元内缘间距可减小的车宽门槛",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.3\.4\.[\s\S]{0,400}?车\s*宽\s*小\s*于\s*(1300)", "flags": "i"},
            "B": {"source": r"5\.22\.4\.[\s\S]{0,400}?车\s*宽\s*小\s*于\s*(1300)", "flags": "i"},
            "C": {"source": r"6\.22\.4\.1\.4[\s\S]{0,700}?less than\s*(1[ ,]300)\s*mm", "flags": "i"},
        },
        "why": {
            "A": "草案 §5.3（带有自适应模式的前照灯）的位置条款只写了 140mm / 200mm / 250mm / 400mm / 50mm 一组**发光单元之间的距离**，没有「车宽门槛」这一条。R48 §6.22.4.1.4 有。",
            "B": "2019 版 §5.22.4 同 A：没有车宽门槛。",
            "C": "R48 §6.22.4.1.4：「…for all other categories of motor vehicles this distance may be reduced to 400 mm where the overall width of the vehicle is less than 1,300 mm.」",
        },
        "absent": {
            "A": "GB 4785 草案的 AFS 章（§5.3）**没有**「车宽小于 1300mm 时内缘间距可减至 400mm」这一条（该章只规定了发光单元之间的 50/140/200/250/400mm）。R48 §6.22.4.1.4 有。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 的 AFS 章（§5.22.4）**没有**「车宽小于 1300mm 时内缘间距可减至 400mm」这一条。R48 §6.22.4.1.4 有。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.emodeMotorwaySpeed",
        "name": "AFS E 级近光模式的高速公路/E 信号车速门槛",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": {"source": r"数据集\s*E1", "flags": "i"},
            "B": {"source": r"5\.22\.7\.4\.3[\s\S]{0,300}?车速超过\s*(110\s*km\s*/\s*h)", "flags": "i"},
            "C": {"source": r"road characteristics correspond to motorway[\s\S]{0,150}?exceeds\s*(110\s*km\s*/\s*h)",
                  "flags": "i", "clause": "6.22.7.4.3"},
        },
        "why": {
            "A": "**草案全文没有「E 信号」「数据集 E1」**（整册检索 0 次）—— 草案的自适应前照灯体系（§5.3）没有引入 E 级近光模式，这是**体系差异**，不是抽取失败。",
            "B": "GB 4785-2019 §5.22.7.4.3 E 级近光模式的激活条件：「车辆处于高速道路（…），或车速超过 110km/h（适用 E 信号）」。",
            "C": "R48 §6.22.7.4.3 class E mode：「(a) The road characteristics correspond to motorway conditions or the vehicle's speed exceeds 110 km/h (E-signal applies)」。**条款号显式写 6.22.7.4.3**：条款号在源 PDF 的第 86 页、正文在第 87 页（跨页），MinerU 那一页又没有条款号，所以正则按正文措辞锚、条款号写明。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「E 信号」「数据集 E1」字样（整册检索 0 次）—— 草案的自适应前照灯体系（§5.3）**没有 E 级近光模式**，GB 4785-2019（§5.22.7.4.3）与 R48（§6.22.7.4.3）才有。属版本间的体系差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.emodeE1Speed",
        "name": "AFS E 级近光模式 E1 数据集的车速门槛",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": {"source": r"数据集\s*E1", "flags": "i"},
            "B": {"source": r"5\.22\.7\.4\.3[\s\S]{0,400}?数据集\s*E1[:：]\s*车速超过\s*(100\s*km\s*/\s*h)", "flags": "i"},
            "C": {"source": r"Data set E1[:：]\s*the vehicle's speed exceeds\s*(100\s*km\s*/\s*h)",
                  "flags": "i", "clause": "6.22.7.4.3"},
        },
        "why": {
            "A": "同 afs.emodeMotorwaySpeed：草案无 E 级模式，也就没有 E1 数据集。",
            "B": "GB 4785-2019 §5.22.7.4.3：「● 数据集 E1：车速超过 100km/h（适用 E1 信号）」。",
            "C": "R48 §6.22.7.4.3：「Data set E1: the vehicle's speed exceeds 100 km/h (E1-signal applies).」—— **捕获组只框值**：「E1」里的 1 是数据集编号不是限值，框进去会被当成数值。条款号显式写 6.22.7.4.3（跨页，见 emodeMotorwaySpeed 的说明）。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「数据集 E1」字样（整册检索 0 次）—— 草案无 E 级近光模式。属版本间的体系差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.emodeE2Speed",
        "name": "AFS E 级近光模式 E2 数据集的车速门槛",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": {"source": r"数据集\s*E2", "flags": "i"},
            "B": {"source": r"5\.22\.7\.4\.3[\s\S]{0,500}?数据集\s*E2[:：]\s*车速超过\s*(90\s*km\s*/\s*h)", "flags": "i"},
            "C": {"source": r"Data set E2[:：]\s*the vehicle's speed exceeds\s*(90\s*km\s*/\s*h)",
                  "flags": "i", "clause": "6.22.7.4.3"},
        },
        "why": {
            "A": "同 E1：草案无 E 级模式。",
            "B": "GB 4785-2019 §5.22.7.4.3：「数据集 E2：车速超过 90km/h（适用 E2 信号）」。",
            "C": "R48 §6.22.7.4.3：「Data set E2: the vehicle's speed exceeds 90 km/h (E2-signal applies).」条款号显式写 6.22.7.4.3（跨页）。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「数据集 E2」字样（整册检索 0 次）—— 草案无 E 级近光模式。属版本间的体系差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.emodeE3Speed",
        "name": "AFS E 级近光模式 E3 数据集的车速门槛",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": {"source": r"数据集\s*E3", "flags": "i"},
            "B": {"source": r"5\.22\.7\.4\.3[\s\S]{0,600}?数据集\s*E3[:：]\s*车速超过\s*(80\s*km\s*/\s*h)", "flags": "i"},
            "C": {"source": r"Data set E3[:：]\s*the vehicle's speed exceeds\s*(80\s*km\s*/\s*h)",
                  "flags": "i", "clause": "6.22.7.4.3"},
        },
        "why": {
            "A": "同 E1：草案无 E 级模式。",
            "B": "GB 4785-2019 §5.22.7.4.3：「数据集 E3：车速超过 80km/h（适用 E3 信号）」。",
            "C": "R48 §6.22.7.4.3：「Data set E3: the vehicle's speed exceeds 80 km/h (E3-signal applies).」条款号显式写 6.22.7.4.3（跨页）。",
        },
        "absent": {
            "A": "GB 4785 草案全文无「数据集 E3」字样（整册检索 0 次）—— 草案无 E 级近光模式。属版本间的体系差异，不是抽取失败。",
        },
    },
]


def main():
    p = SPEC
    s = io.open(p, encoding="utf-8").read()
    data = json.loads(s)
    have = {x["id"] for x in data["specs"]}
    add = [x for x in NEW if x["id"] not in have]
    if not add:
        print("没有新行要加（都已存在）")
        return
    blocks = []
    for spec in add:
        body = json.dumps(spec, ensure_ascii=False, indent=2)
        body = "\n".join(("    " + ln) if ln else ln for ln in body.split("\n"))
        blocks.append(body)
    text = ",\n".join(blocks)
    idx = s.rstrip().rfind("]")
    head = s[:idx].rstrip()
    s2 = head + ",\n" + text + "\n  ]\n}\n"
    json.loads(s2)
    io.open(p, "w", encoding="utf-8", newline="").write(s2)
    print("已加 %d 行：%s" % (len(add), "、".join(x["id"] for x in add)))
    print("总行数：%d" % len(json.loads(s2)["specs"]))


if __name__ == "__main__":
    main()
