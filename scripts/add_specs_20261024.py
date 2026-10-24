# -*- coding: utf-8 -*-
"""2026-10-24：补上 A 草案里**一直没有任何矩阵行**的三个装置/口径。

起因
----
条款切分器的「节推进必须 +1」规则，把 A 的 **5.20 醒目标志（无编号小节）**
之后的条款全判成了"不是章推进" —— A 的 **倒车灯(5.21.x)、慢行灯(5.22.x)、
牵引杆挂车标志灯(5.23.x)、ADS 标志灯(5.24.x)** 共 71 条条款在条款索引里
整段消失（见 `scripts/clause_split.py` 的 same_chapter 注释）。

条款索引是**要求台账与覆盖审计的唯一输入**，所以：
  · 覆盖审计此前**看不见** A 的 ADS 标志灯 ——
    草案里一个全新装置的 5 条真实限值（高度 250mm、前/后垂直角 15°、
    水平角 80°/45°、与前照灯间距 20mm…）在矩阵里**一行都没有**；
  · 一旦索引修好，审计立刻报出 20 个「别装置顶替」+ 2 个「真漏」。

这一版补的就是那 20 + 2：
  · **真实限值** → 进矩阵（新增 14 行 spec）；
  · **不是限值的数**（车长分档 6m/9m、目视检测观察区域 10m/1m/3m）
    → 登记进 `data/table-clauses.json`，写明理由（不是限值就不该进矩阵）。

用法： python scripts/add_specs_20261024.py [--write]
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPECS = os.path.join(ROOT, "data", "parameter-specs.json")

ABSENT_B_ADS = "同 §6：ADS 标志灯（自动驾驶标志灯）是**草案新增装置**，GB 4785-2019 全文无此装置、无此限值。"
ABSENT_C_ADS = "UN R48-09 全文检索无 ADS / automated driving 标志灯的任何条款（无 §6.x 对应章），R48-09 不规定该装置。"
ABSENT_B_SLOW = "B §5.25.4「位置」为「无特殊要求」，B 版慢行灯**全文无离地高度与相邻间距限值**（慢行灯的安装位置要求是 A 草案新增的）。"
ABSENT_C_SLOW = "UN R48-09 **无慢行灯（slow-moving lamp）装置**（§2.5.19 / §6.26 的 slow 是操纵灯 Manoeuvring lamp，不是慢行灯），R48-09 不规定该装置。"

NEW = [
    # ---------------------------------------------------------------- 倒车灯
    {
        "id": "reversing.optLampLongitudinalAngle",
        "name": "选装倒车灯纵向安装角上限",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"5\.21\.5\.2[\s\S]{0,240}?成角度应不大于\s*(15)\s*°", "flags": "i"},
            "B": {"source": r"于\s*(?:\$?\s*\{\s*)?(1\s*5)\s*\}?\s*(?:\^\s*\{\s*\\circ\s*\}\s*\$|°)\s*[,，]\s*即可认为满足几何可见度要求", "flags": "i", "clause": "5.4.5.2"},
            "C": {"source": r"6\.4\.5\.2[\s\S]{0,320}?not exceeding\s*(15)\s*°", "flags": "i"},
        },
        "why": {
            "A": "A §5.21.5.2（p58）：「对于根据 5.21.2.2 在车侧面安装的选装倒车灯，其基准轴线与车辆纵向对称平面所成角度应不大于 15°」。**这是纵向偏转角，不是几何可见度的水平/垂直角** —— 装反光灯的复核表里没有它，所以此前没人报。",
            "B": "B §5.4.5.2 的这一句**被 PDF 的页边界劈开了**：p29 的文本层到「…成角度不大52GB4785—2019」为止，**「于15°」落在 p30 的开头**。locate() 是逐页扫描的，条款锚点 5.4.5.2 与值因此**不在同一页**，锚不上。所以这里改成**按值侧的独特短语**定位（「于15°，即可认为满足几何可见度要求」全篇只有这一处），并**显式声明条款号 5.4.5.2**。MinerU 的文本层把 15° 写成 LaTeX `${ 1 5 } ^ { \\circ }$`（两个单数字），源 PDF 是干净的「于15°」—— 正则要同时吃下这两种写法。",
            "C": "R48 §6.4.5.2（p48）：「…is directed outwards with an angle β not exceeding 15° relative to the median longitudinal plane」。三版都是 15°。",
        },
    },
    # ---------------------------------------------------------------- 慢行灯
    {
        "id": "slowMovingLamp.maxHeight",
        "name": "慢行灯最大离地高度",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.22\.4\.2[\s\S]{0,140}?离地高度应不大于\s*(1500)\s*mm", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_SLOW, "C": ABSENT_C_SLOW},
        "why": {
            "A": "A §5.22.4.2（p59）：「对于安装在侧面的灯具，离地高度应不大于 1500mm；对于安装在后面的灯具，不应高于车辆。」**只约束侧面安装的那种** —— 后面安装的写法是「不应高于车辆」，没有标量，所以只取 1500mm。",
        },
    },
    {
        "id": "slowMovingLamp.sideSpacingMin",
        "name": "同侧相邻慢行灯最小间距",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": {"source": r"5\.22\.4\.3[\s\S]{0,200}?间距[，,]\s*应不小于\s*(0\.5)\s*m", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_SLOW, "C": ABSENT_C_SLOW},
        "why": {
            "A": "A §5.22.4.3（p59）：「同侧相邻的慢行灯间距，应不小于 0.5m」。**单位是 m 不是 mm** —— 写成 0.5 会被读成 0.5mm，差一千倍；矩阵里这一格的单位列写的是 m。",
        },
    },
    # ------------------------------------------------------------ ADS 标志灯
    {
        "id": "adsMarker.minHeight",
        "name": "ADS 标志灯最小离地高度",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.24\.4\.2[\s\S]{0,80}?离地高度应不小于\s*(250)\s*mm", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.4.2（p62）：「高度：离地高度应不小于 250mm。」**这是草案新增装置的第一条真实限值** —— 此前矩阵里 ADS 标志灯一行都没有，客户看不到这个装置的任何数。",
        },
    },
    {
        "id": "adsMarker.longitudinalMaxDistance",
        "name": "侧 ADS 标志灯距车辆前后端最大距离",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": {"source": r"5\.24\.4\.3[\s\S]{0,240}?距离车辆前端不大于\s*(3)\s*m", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.4.3（p62）：「…且距离车辆前端不大于 3m；后部的三分之一的范围内每侧各安装 1 只 AV3b 类侧 ADS 标志灯，且距离车辆尾端不大于 3m」。**同一句里还有「相邻侧 ADS 标志灯的间距应不大于 3m」** —— 值相同，锚点取前半句更稳。",
        },
    },
    {
        "id": "adsMarker.verticalAngle",
        "name": "ADS 标志灯（前后）垂直方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"5\.24\.5\.1[\s\S]{0,140}?(水平面向上\s*15\s*°\s*[、，,]\s*向下\s*15\s*°)", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.1（p62）：「对于前、后 ADS 标志灯，水平面向上 15°、向下 15°。」**一个捕获组把两个角一起框住** —— locate() 只读第 1 个捕获组，分成两组的话「向下 15°」会静默消失。",
        },
    },
    {
        "id": "adsMarker.sideVerticalAngle",
        "name": "侧 ADS 标志灯垂直方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"5\.24\.5\.1[\s\S]{0,320}?对于侧ADS标志灯[，,]?\s*(水平面向上\s*10\s*°\s*[、，,]\s*向下\s*10\s*°)", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.1（p62）下半段：「对于侧 ADS 标志灯，水平面向上 10°、向下 10°。」**侧向是 10°/10°，前后是 15°/15°** —— 两者只差一个字，锚点必须带上「侧 ADS 标志灯」，否则会取到前一段的 15°。",
        },
    },
    {
        "id": "adsMarker.highMountVerticalAngle",
        "name": "ADS 标志灯高安装高度时的垂直方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"5\.24\.5\.1[\s\S]{0,320}?(水平面向上\s*5\s*°\s*[、，,]\s*向下\s*30\s*°)", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.1（p62）：「若离地高度大于 3000 mm，水平面向上 5°、向下 30°。」**这是「装得高就得往下照」的例外档** —— 3000mm 门槛本身另有一行（adsMarker.highMountHeightThreshold），这里只取角度，所以捕获组只框「5°、向下30°」。",
        },
    },
    {
        "id": "adsMarker.highMountHeightThreshold",
        "name": "ADS 标志灯垂直方向角例外的高度门槛",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.24\.5\.1[\s\S]{0,200}?若离地高度大于\s*(3000)\s*mm", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.1（p62）：「若离地高度大于 3000 mm（测量方法参照 4.8 b)），水平面向上 5°、向下 30°。」**这是门槛不是限值**（跟别的灯的「低安装高度门槛 750mm」同一类），但它决定角度，读者需要这个数。",
        },
    },
    {
        "id": "adsMarker.lowMountHeightThreshold",
        "name": "ADS 标志灯垂直方向角可减小的离地高度门槛",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.24\.5\.1[\s\S]{0,160}?若离地高度小于\s*(750)\s*mm", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.1（p62）：「若离地高度小于 750 mm（测量方法参照 4.8 b)），水平面以下的垂直方向角可由 15° 减至 5°。」**与前/后/侧三组角度都有关**，所以放在条款级而不是某一组角度里。",
        },
    },
    {
        "id": "adsMarker.horizontalAngle",
        "name": "ADS 标志灯（前后）水平方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"5\.24\.5\.2[\s\S]{0,140}?对于前、后ADS标志灯[，,]?\s*(向外\s*80\s*°\s*[，,]\s*向内\s*45\s*°)", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.2（p62）：「对于前、后 ADS 标志灯，向外 80°，向内 45°。」**向外/向内两个角必须同框**，否则只报一个角。",
        },
    },
    {
        "id": "adsMarker.av3aHorizontalAngle",
        "name": "AV3a 类侧 ADS 标志灯水平方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"AV3a类侧ADS标志灯[，,]?\s*基准轴线方向[，,]?\s*(向外\s*5\s*°\s*至\s*60\s*°)", "flags": "i", "clause": "5.24.5.2"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.2（p63）：「AV3a 类侧 ADS 标志灯，基准轴线方向，向外 5° 至 60°。」**区间写法**（5 至 60）—— 两个数必须同一个捕获组，否则「至」后面那个角会丢。**条款号 5.24.5.2 在 p62，这一小段在 p63**（中间隔着页眉「GB 4785—XXXX 59」），逐页扫描锚不上，所以条款号**显式声明**。",
        },
    },
    {
        "id": "adsMarker.av3bHorizontalAngle",
        "name": "AV3b 类侧 ADS 标志灯水平方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": {"source": r"最后部的AV3b类ADS标志灯[，,]?\s*(向前\s*30\s*°\s*[，,]\s*向后\s*45\s*°)", "flags": "i", "clause": "5.24.5.2"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.5.2（p63）：「最后部的 AV3b 类 ADS 标志灯，向前 30°，向后 45°；其余 ADS 标志灯，向前 30°，向后 30°。」**AV3b 有三种布置（最前/最后/其余），角度各不相同** —— 这一行取「最后部」那一种（30/45），因为覆盖审计要的是这一条里出现的每一个角度值。条款号在 p62、这一小段在 p63，**显式声明** 5.24.5.2。",
        },
    },
    {
        "id": "adsMarker.gapToHeadlampMin",
        "name": "ADS 标志灯与前照灯/前雾灯最小间距",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": {"source": r"5\.24\.8\.2[\s\S]{0,160}?间距应不小于\s*(20)\s*mm", "flags": "i"},
        },
        "absent": {"B": ABSENT_B_ADS, "C": ABSENT_C_ADS},
        "why": {
            "A": "A §5.24.8.2（p63）：「ADS 标志灯与车辆前照灯、前雾灯的间距应不小于 20mm，或间距大于 20mm 的 ADS 标志灯部分，能单独满足其配光要求。」**20mm 出现两次**（一个是最小间距，一个是豁免条件），取第一个即可。",
        },
    },
]

# 覆盖审计的「不是限值」登记（写进 data/table-clauses.json）
TABLE_CLAUSES = {
    "A": {
        "5.22.2": {
            "kind": "mixed",
            "skip": [[6, "m"], [9, "m"]],
            "note": "慢行灯的**配备数量按车长分档**（车长不大于 6m：1 只或 2 只；大于 6m 不大于 9m：不超过 4 只；大于 9m：不超过 6 只）。6m / 9m 是**车辆长度的适用范围门槛**，不是灯具的安装限值；数量本身是「只」，不是标量限值。",
        },
        "5.22.9.1": {
            "kind": "outOfScope",
            "note": "慢行灯目视检测的**观察区域**（距车前/车后/两侧各 10m、高度 1m~3m）—— 规定的是检验员站在哪，属试验条件。与 B §5.25.9.1 同一条。",
        },
        "5.24.2": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "ADS 标志灯的数量按车长分档（车长不小于 6m 的车辆每侧再装 1 只 AV3b）。6m 是**车辆长度门槛**，不是安装限值。",
        },
        "5.24.3": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "ADS 标志灯布局按车长分档（车长小于 6m 允许简化布置）。6m 是**车辆长度门槛**，不是安装限值。",
        },
        "5.24.4.3": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "侧 ADS 标志灯的纵向安装位置：距车辆前端/尾端不大于 3m、相邻间距不大于 3m 是**真实安装限值**（照常算覆盖）；6m 是**车长分档门槛**（车长小于 6m 允许前部二分之一范围），列在 skip 里。",
        },
    }
}


def main():
    with io.open(SPECS, encoding="utf-8") as f:
        doc = json.load(f)
    specs = doc["specs"]
    have = {s["id"] for s in specs}
    added = []
    by_id = {x["id"]: x for x in specs}
    for s in NEW:
        if s["id"] in by_id:
            # 同 id 就**覆盖**（改正则）—— 保留脚本可重跑
            by_id[s["id"]].clear()
            by_id[s["id"]].update(s)
            added.append(s["id"] + "(覆盖)")
            continue
        specs.append(s)
        added.append(s["id"])
    print("新增 spec：%d 条 %s" % (len(added), added))

    tc_path = os.path.join(ROOT, "data", "table-clauses.json")
    with io.open(tc_path, encoding="utf-8") as f:
        tc = json.load(f)
    n = 0
    for v, entries in TABLE_CLAUSES.items():
        tc.setdefault(v, {})
        for clause, meta in entries.items():
            if clause in tc[v]:
                print("  已存在，不覆盖：%s %s" % (v, clause))
                continue
            tc[v][clause] = meta
            n += 1
    print("覆盖审计登记：%d 条" % n)

    if "--write" in sys.argv:
        with io.open(SPECS, "w", encoding="utf-8") as f:
            f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "
")
        with io.open(tc_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(tc, ensure_ascii=False, indent=2) + "
")
        print("已写出 %s 与 %s" % (SPECS, tc_path))
    else:
        print("（dry-run；加 --write 落盘）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
