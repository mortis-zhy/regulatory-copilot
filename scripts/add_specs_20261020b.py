# -*- coding: utf-8 -*-
"""2026-10-20 补行（第二批）：覆盖审计剩下的**标量**缺口。

表格型限值（下倾度表、传感器垂直角表）不进矩阵 —— 见附录 E。

自检： python scripts/add_specs_20261020b.py --check
写入： python scripts/add_specs_20261020b.py --write
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

_s = importlib.util.spec_from_file_location("tp", os.path.join(ROOT, "scripts", "try_pattern.py"))
tp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(tp)


def P(source, clause=None):
    d = {"source": source, "flags": "i"}
    if clause:
        d["clause"] = clause
    return d


NEW = [
    {
        "id": "mountingAxisAngleTolerance",
        "name": "灯具基准轴线安装角度允差（每方向）",
        "family": "位置 / 间距限值",
        "unit": "°",
        "patterns": {
            "A": P(r"各灯具每个方向上允差为\s*±\s*(3)\s*°", "4.3"),
            "B": P(r"每个方向上允差为\s*±\s*(3)\s*°"),
            "C": P(r"5\.3[\s\S]{0,700}?tolerance of\s*±\s*(3)\s*°"),
        },
        "why": {
            "A": "A 第 4 章「一般要求」（p14）：「各灯具每个方向上允差为±3°。如果制造商另有特殊安装说明，"
                 "也应遵循。」—— **A 第 4 章的条款号在 PDF 里是位图**（文本层取不到），"
                 "所以正则按措辞锚；A 正文里有 37 处「4.3」交叉引用，条款号 4.3 仍可写明并被交付闸门验到。",
            "B": "B §4.3（p14）：「每个方向上允差为±3°。」",
            "C": "R48 §5.3（p24）：「In each direction a tolerance of ± 3° shall be allowed.」",
        },
    },
    {
        "id": "slowMovingLamp.autoOnSpeedMax",
        "name": "慢行灯自动点亮的的车速上限",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": P(r"5\.22\.7\.1[\s\S]{0,300}?自动点亮直至车速达到\s*(15)\s*km/h"),
            "B": P(r"5\.25\.7[\s\S]{0,300}?自动开启直至车速达到\s*(10)\s*km/h"),
        },
        "why": {
            "A": "A §5.22.7.1（p59）：「符合以下任一条件时，慢行灯应在车辆慢速行驶时自动点亮直至车速达到15km/h。」"
                 "—— **A 是 15 km/h、B 是 10 km/h**，这是草案与 2019 版之间的实质差异之一。",
            "B": "B §5.25.7（p57）：「符合以下任一条件时,允许慢行灯在车辆慢速行驶时自动开启直至车速达到10km/h。」",
        },
        "absent": {
            "C": "R48 §6.26（操纵灯）的电气连接条款 §6.26.7 **没有**车速门槛"
                 "（只要求「不得在远光/近光未点亮时点亮」，以及 §6.26.9.1 的目视检测区）。"
                 "属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.vModeUrbanSpeedMax",
        "name": "AFS V 级近光模式·建成区/有照明道路的车速上限",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "B": P(r"5\.22\.7\.4\.2[\s\S]{0,400}?车速未超过\s*(60)\s*km/h"),
            "C": P(r"6\.22\.7\.4\.2[\s\S]{0,700}?speed not exceeding\s*(60)\s*km/h"),
        },
        "why": {
            "B": "B §5.22.7.4.2（p52）：「建筑物密集区域道路,且车速未超过60km/h;」"
                 "「有固定照明的道路,且车速未超过60km/h;」—— 两条都写 60 km/h。",
            "C": "R48 §6.22.7.4.2（p86）：「(a) Roads in built-up areas and the vehicle's speed not exceeding "
                 "60 km/h; (b) Roads equipped with a fixed road illumination, and the vehicle's speed not exceeding 60 km/h;」",
        },
        "absent": {
            "A": "GB 4785 草案的 AFS 章（§5.3）**没有**「V 级近光模式」这一分级激活条件表"
                 "（A 的 §5.3.9 里没有带车速门槛的模式激活条件）。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.vModeSpeedMax",
        "name": "AFS V 级近光模式·一般道路的车速上限",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "B": P(r"5\.22\.7\.4\.2[\s\S]{0,400}?车速未超过\s*(50)\s*km/h"),
            "C": P(r"6\.22\.7\.4\.2[\s\S]{0,900}?speed not exceeding\s*(50)\s*km/h"),
        },
        "why": {
            "B": "B §5.22.7.4.2（p52）：「———车速未超过50km/h。」",
            "C": "R48 §6.22.7.4.2（p86）：「(d) The vehicle's speed not exceeding 50 km/h.」",
        },
        "absent": {
            "A": "GB 4785 草案的 AFS 章没有 V 级模式的激活条件表（见上一行）。属版本差异。",
        },
    },
    {
        "id": "frontPositionLamp.inwardAngleLowMountExempt",
        "name": "前位灯低安装向内几何可见度角上限（<750mm）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.9\.5\.1[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "B": P(r"5\.9\.5\.1[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "C": P(r"6\.9\.5\.1[\s\S]{0,700}?(inward angle of\s*\d+\s*° may be reduced to\s*\d+\s*°)"),
        },
        "why": {
            "A": "A §5.9.5.1（p44）：「对于离地高度小于750mm（测量方法参照4.8 b)）的灯具，在H 平面下方的向内"
                 "几何可见度角可由45°减至20°。」—— 与转向灯、制动灯同一档放宽，矩阵里那两件有行、这件没有。",
            "B": "B §5.9.5.1（p37）：「在H 平面下方的向内几何可见度角可由45°减至20°。」",
            "C": "R48 §6.9.5.1（p60）：「the inward angle of 45° may be reduced to 20° under the H plane.」",
        },
    },
    {
        "id": "rearPositionLamp.inwardAngleLowMountExempt",
        "name": "后位灯低安装向内几何可见度角上限（<750mm）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.10\.5\.1[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "B": P(r"5\.10\.5\.1[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "C": P(r"6\.10\.5\.1[\s\S]{0,700}?(inward angle of\s*\d+\s*° may be reduced to\s*\d+\s*°)"),
        },
        "why": {
            "A": "A §5.10.5.1（p47）：「对于离地高度小于750mm（测量方法参照4.8 b)）的灯具，在H平面下方的向内"
                 "几何可见度角可由45°减至20°。」",
            "B": "B §5.10.5.1（p39）：「在H 平面下方的向内几何可见度角可由45°减至20°。」",
            "C": "R48 §6.10.5.1（p61）：「the inward angle of 45° may be reduced to 20° under the H plane.」",
        },
    },
    {
        "id": "parkingLamp.inwardAngleLowMountExempt",
        "name": "驻车灯低安装向内几何可见度角上限（<750mm）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.12\.5[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "B": P(r"5\.12\.5[\s\S]{0,300}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "C": P(r"6\.12\.5[\s\S]{0,700}?(inward angle of\s*\d+\s*° may be reduced to\s*\d+\s*°)"),
        },
        "why": {
            "A": "A §5.12.5（p50）：「对于安装于车前或车后的驻车灯，若离地高度小于750mm（测量方法参照4.8 b)），"
                 "则H平面下方的向内几何可见度角可由45°减至20°。」",
            "B": "B §5.12.5（p41）：「在H 平面下方的向内几何可见度角可由45°减至20°。」",
            "C": "R48 §6.12.5（p64）：「the inward angle of 45° may be reduced to 20° under the H plane.」",
        },
    },
    {
        "id": "externalStatusIndicator.areaMaxEachOfTwo",
        "name": "外部状态指示器·两个时单个的视表面面积上限",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "C": P(r"5\.32[\s\S]{0,900}?apparent surface does not exceed\s*(10)\s*cm2"),
        },
        "why": {
            "C": "R48 §5.32（p35）：「Up to two external status indicators for Vehicle Alarm System (VAS), "
                 "Alarm System (AS) and immobiliser are allowed on a vehicle provided that the apparent surface "
                 "does not exceed 10 cm2 per indicator.」—— **一个**指示器是 20 cm²，**两个**时每个 10 cm²，"
                 "两档分开记。",
        },
        "absent": {
            "A": "A 草案没有「外部状态指示器」这一条款。属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 无外部状态指示器条款。属版本差异。",
        },
    },
    {
        "id": "sensorDetection.bicycleDistance",
        "name": "远光自动控制传感器·迎面电动自行车探测距离",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.2[\s\S]{0,300}?至少\s*(75)\s*m\s*距离范围内的迎面而来的电动自行车"),
            "C": P(r"6\.1\.9\.3\.1\.2[\s\S]{0,700}?at least\s*(75)\s*m, its illumination"),
        },
        "why": {
            "A": "A §5.1.9.2.1.2（p25）：「—— 至少75 m 距离范围内的迎面而来的电动自行车。」",
            "C": "R48 §6.1.9.3.1.2（p39）：「(c) An oncoming bicycle at a distance extending to at least 75 m…」",
        },
        "absent": {
            "B": "B §5.1.9.3.1.2（p23）**只有两条**：「至少400m 的迎面而来的机动车」与"
                 "「至少100m 的前方行驶的机动车或带挂车的车辆」，**没有**电动自行车 75 m 这一条。"
                 "属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "sensorDetection.bicycleLampIntensity",
        "name": "电动自行车替代表征灯·发光强度",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.2[\s\S]{0,300}?发光强度为\s*(150)\s*cd"),
            "C": P(r"6\.1\.9\.3\.1\.2[\s\S]{0,700}?luminous intensity of\s*(150)\s*cd"),
        },
        "why": {
            "A": "A §5.1.9.2.1.2（p25）：「电动自行车可用一盏发光强度为150 cd，发光面面积为（10±3）cm2，"
                 "离地高度为0.8 m 的白色灯具代替。」",
            "C": "R48 §6.1.9.3.1.2（p39）：「its illumination represented by a white lamp with a luminous "
                 "intensity of 150 cd with a light emitting area of 10 cm² ± 3 cm² and a height above a ground of 0.8 m.」",
        },
        "absent": {
            "B": "B §5.1.9.3.1.2 没有电动自行车替代表征灯的规定。属版本差异。",
        },
    },
    {
        "id": "sensorDetection.bicycleLampArea",
        "name": "电动自行车替代表征灯·发光面面积",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.2[\s\S]{0,300}?发光面面积为\s*[（(]\s*(10\s*±\s*3)\s*[）)]\s*cm"),
            "C": P(r"6\.1\.9\.3\.1\.2[\s\S]{0,700}?light emitting area of\s*(10\s*cm²\s*±\s*3\s*cm²)"),
        },
        "why": {
            "A": "A §5.1.9.2.1.2（p25）：「发光面面积为（10±3）cm2」—— **一个组框住 10 与 3**"
                 "（locate() 只读第 1 个捕获组，写成两个组 3 就丢了）。",
            "C": "R48 §6.1.9.3.1.2（p39）：「a light emitting area of 10 cm² ± 3 cm²」",
        },
        "absent": {
            "B": "B §5.1.9.3.1.2 没有电动自行车替代表征灯的规定。属版本差异。",
        },
    },
    {
        "id": "endOutlineMarker.lateralRelaxMax",
        "name": "示廓灯横向距车辆外缘端面上限（满足高度要求时可放宽）",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"5\.13\.4\.1[\s\S]{0,300}?此距离可以放宽至\s*(500)\s*mm"),
        },
        "why": {
            "A": "A §5.13.4.1（p50）：「基准轴线方向上，离车辆纵向对称平面最远的视表面上的点到车辆外缘端面间的"
                 "距离应不大于400mm。若为满足5.13.4.2要求，此距离可以放宽至500mm。」"
                 "—— 400mm 那一行矩阵里已有（endOutlineMarker.lateralToVehicleEdgeMax），**500mm 的放宽值**没有。",
        },
        "absent": {
            "B": "GB 4785-2019 的示廓灯横向条款没有这条「为满足高度要求可放宽至 500mm」的规定。属版本差异。",
            "C": "R48 §6.13（示廓灯）没有对应的横向放宽条款。属版本差异。",
        },
    },
    {
        "id": "drl.rearPositionOffEnvLight",
        "name": "昼间行驶灯点亮时后位灯允许熄灭的环境照度阈值",
        "family": "光强 / 照度限值",
        "unit": "lx",
        "patterns": {
            "A": P(r"若环境光大于\s*(7000)\s*lx（按附录C\s*规定的条件测量），后位灯和"),
            "C": P(r"ambient light conditions outside vehicle are above\s*(7,?000)\s*lux", "6.19.7.5"),
        },
        "why": {
            "A": "A §5.19.7.5（p57）：「昼间行驶灯开启时，若环境光大于7000lx（按附录C 规定的条件测量），"
                 "后位灯和4.11 规定的其他灯具允许熄灭，但当此环境光条件消失后，应恢复点亮。」"
                 "—— 锚「后位灯和」是为了避开 A 第 4 章里同义的通用条款（p16）。",
            "C": "R48 §6.19.7.5（p74）：「may remain switched OFF as long as the ambient light conditions outside "
                 "vehicle are above 7,000 lux」",
        },
    },
]


def selfcheck():
    bad = 0
    for row in NEW:
        for ver, p in row["patterns"].items():
            r = tp.run(ver, p["source"])
            if not r:
                print("  ✗ %-44s %s  没命中" % (row["id"], ver))
                bad += 1
            else:
                print("  ✓ %-44s %s  %s p%-4s %s → %s"
                      % (row["id"], ver, r["tag"], r["page"], repr(r["focus"])[:52], r["nums"]))
    return bad


def write():
    raw = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(raw)
    by_id = {s["id"]: s for s in data["specs"]}
    n = 0
    for row in NEW:
        if row["id"] in by_id:
            print("!! 已存在，跳过：%s" % row["id"])
            continue
        data["specs"].append(row)
        n += 1
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("加了 %d 行，总行数 %d" % (n, len(data["specs"])))


if __name__ == "__main__":
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没命中，先别写。" % bad)
            sys.exit(1)
        write()
    else:
        sys.exit(1 if selfcheck() else 0)
