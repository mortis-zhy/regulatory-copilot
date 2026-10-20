# -*- coding: utf-8 -*-
"""2026-10-21 补行：覆盖审计换成共享解析（scripts/limit_scan.py）之后，
**新暴露出来的真缺口** —— 加上 A 第 4 章（条款号在位图里）此前整章不可见的那些。

自检： python scripts/add_specs_20261021.py --check
写入： python scripts/add_specs_20261021.py --write
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")
BITMAP = os.path.join(ROOT, "data", "clause-bitmap-fixes.json")

_s = importlib.util.spec_from_file_location("tp", os.path.join(ROOT, "scripts", "try_pattern.py"))
tp = importlib.util.module_from_spec(_s)
_s.loader.exec_module(tp)


def P(source, clause=None):
    d = {"source": source, "flags": "i"}
    if clause:
        d["clause"] = clause
    return d


NEW = [
    # ── 传感器探测距离（A/B/C 三版都有，草案与 2019 版一致）────────────
    {
        "id": "sensorDetection.oncomingVehicleDistance",
        "name": "远光自动控制传感器·迎面机动车探测距离下限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.2[\s\S]{0,220}?至少\s*(400)\s*m\s*的距离范围内的迎面而来的机动车"),
            "B": P(r"5\.1\.9\.3\.1\.2[\s\S]{0,220}?至少\s*(400)\s*m\s*的距离范围内的迎面而来的机动车"),
            "C": P(r"6\.1\.9\.3\.1\.2[\s\S]{0,320}?oncoming power driven vehicle at a distance extending to at least\s*(400)\s*m"),
        },
        "why": {
            "A": "A §5.1.9.2.1.2（p25）：「—— 至少400m 的距离范围内的迎面而来的机动车；」"
                 "—— 与矩阵里已有的「电动自行车 75m」是同一条款里的三档之一。",
            "B": "B §5.1.9.3.1.2（p23）：「———至少400m 的距离范围内的迎面而来的机动车;」",
            "C": "R48 §6.1.9.3.1.2（p39）：「(a) An oncoming power driven vehicle at a distance extending to at least 400 m;」",
        },
    },
    {
        "id": "sensorDetection.precedingVehicleDistance",
        "name": "远光自动控制传感器·前方行驶机动车探测距离下限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.2[\s\S]{0,280}?至少\s*(100)\s*m\s*的距离范围内的前方行驶的机动车"),
            "B": P(r"5\.1\.9\.3\.1\.2[\s\S]{0,280}?至少\s*(100)\s*m\s*的距离范围内的前方行驶的机动车"),
            "C": P(r"6\.1\.9\.3\.1\.2[\s\S]{0,340}?preceding power driven vehicle[^.]{0,90}?at least\s*(100)\s*m"),
        },
        "why": {
            "A": "A §5.1.9.2.1.2（p25）：「—— 至少100m 的距离范围内的前方行驶的机动车或带挂车的车辆;」",
            "B": "B §5.1.9.3.1.2（p23）：「———至少100m 的距离范围内的前方行驶的机动车或带挂车的车辆。」",
            "C": "R48 §6.1.9.3.1.2（p39）：「(b) A preceding power driven vehicle or a vehicle-trailers "
                 "combination at a distance extending to at least 100 m;」",
        },
    },
    # ── 弯道照明的曲率半径门槛 ─────────────────────────────────────
    {
        "id": "dippedBeam.bendCurvatureRadiusMax",
        "name": "近光灯弯道照明·车辆重心轨迹水平曲率半径上限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.2\.7\.4[\s\S]{0,200}?曲率半径不大于\s*(500)\s*m"),
            "B": P(r"5\.2\.7\.4[\s\S]{0,200}?曲率半径应不大于\s*(500)\s*m"),
            "C": P(r"6\.2\.7\.4[\s\S]{0,520}?bend lighting, provided that[^.]{0,220}?is\s*(500)\s*m or less"),
        },
        "why": {
            "A": "A §5.2.7.4（p28）：「但此时，应满足车辆重心轨迹水平曲率半径不大于500m 的要求。」",
            "B": "B §5.2.7.4（p26）：「但是车辆重心轨迹水平曲率半径应不大于500m。」",
            "C": "R48 §6.2.7.4（p43）：「may be activated to produce bend lighting, provided that the "
                 "horizontal radius of curvature of the trajectory of the centre of gravity of the vehicle "
                 "is 500 m or less.」—— 锚 'bend lighting, provided that' 是为了和 §6.22.7.4.5 的"
                 "AFS 弯道模式（同为 500 m）区分开，两条各记一行。",
        },
    },
    {
        "id": "afs.bendCurvatureRadiusMax",
        "name": "AFS 弯道照明功能·车辆重心轨迹水平曲率半径上限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.3\.7\.4\.3[\s\S]{0,420}?曲率水平半径不大于\s*(500)\s*m"),
            "B": P(r"5\.22\.7\.4\.5[\s\S]{0,600}?曲率水平半径不大于\s*(500)\s*m"),
            "C": P(r"additionally energized only when[^.]{0,220}?is\s*(500)\s*m or less", "6.22.7.4.5"),
        },
        "why": {
            "A": "A §5.3.7.4.3（p33）：「—— 只有当行驶车辆重心轨迹曲率水平半径不大于500m 时，"
                 "才允许使用附加光源的弯道照明功能。」",
            "B": "B §5.22.7.4.5（p52）：「——只有当行驶车辆重心轨迹曲率水平半径不大于500 m 时，"
                 "才允许使用附加光源的弯道照明功能。」",
            "C": "R48 §6.22.7.4.5（p87）：「One or more lighting units may be additionally energized only "
                 "when the horizontal radius of curvature of the trajectory of the centre of gravity of the "
                 "vehicle is 500 m or less.」—— **按措辞锚、不按条款号锚**：这一句与 §6.2.7.4 的"
                 "「is 500 m or less」几乎同形，条款号只写在 `clause` 里用来定出处。",
        },
    },
    # ── 顺序点亮的时限 ───────────────────────────────────────────
    {
        "id": "frontPositionLamp.sequentialOnTimeMax",
        "name": "前位灯顺序点亮点亮完成的时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"5\.9\.9\.3[\s\S]{0,200}?开启后\s*(5)\s*秒内"),
        },
        "why": {
            "A": "A §5.9.9.3（p46）：「在车速达到5km/h 前或前位灯开启后5 秒内，应完全点亮且保持"
                 "正常工作状态，直至熄灭。」—— 矩阵里已有同条款的「车速上限 5km/h」，**时间那一半没有行**。",
        },
        "absent": {
            "B": "GB 4785-2019 的前位灯条款（§5.9）没有顺序点亮的时间要求。属版本差异，不是抽取失败。",
            "C": "R48 §6.9（前位灯）没有顺序点亮/顺序熄灭的规定。属版本差异。",
        },
    },
    {
        "id": "rearPositionLamp.sequentialOnTimeMax",
        "name": "后位灯顺序点亮点亮完成的时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"5\.10\.9[\s\S]{0,200}?开启后\s*(5)\s*秒内"),
        },
        "why": {
            "A": "A §5.10.9（p48）：「在车速达到5km/h前或后位灯开启后5秒内，应完全点亮且保持正常工作状态。」",
        },
        "absent": {
            "B": "GB 4785-2019 的后位灯条款（§5.10）没有顺序点亮的时间要求。属版本差异。",
            "C": "R48 §6.10（后位灯）没有顺序点亮/顺序熄灭的规定。属版本差异。",
        },
    },
    # ── 侧标志灯 / 侧回复反射器的纵向间距 ─────────────────────────
    {
        "id": "sideMarkerLamp.frontDistanceMax",
        "name": "侧标志灯·最前面一只距车辆前端的上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.18\.4\.3[\s\S]{0,170}?最前面的侧标志灯离车辆前端不大于\s*(3)\s*m"),
            "B": P(r"5\.18\.4\.3[\s\S]{0,170}?最前面的侧标志灯离车辆\s*前端不大于\s*(3)\s*m"),
            "C": P(r"6\.18\.4\.3[\s\S]{0,220}?foremost side-marker lamp being not further than\s*(3)\s*m"),
        },
        "why": {
            "A": "A §5.18.4.3（p55）：「最前面的侧标志灯离车辆前端不大于3m；」",
            "B": "B §5.18.4.3（p46）：「最前面的侧标志灯离车辆 前端不大于3m;」—— PDF 把「车辆 前端」断行了。",
            "C": "R48 §6.18.4.3（p72）：「the foremost side-marker lamp being not further than 3 m "
                 "(4 m for semi-trailers) from the front.」—— **半挂车那一档 4m 记在下面那行**。",
        },
    },
    {
        "id": "sideMarkerLamp.adjacentGapMax",
        "name": "侧标志灯·相邻两只之间的间距上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.18\.4\.3[\s\S]{0,220}?两相邻侧标志灯的间距应不大于\s*(3)\s*m"),
            "B": P(r"5\.18\.4\.3[\s\S]{0,220}?两相邻侧标志灯的间距应不大于\s*(3)\s*m"),
            "C": P(r"6\.18\.4\.3[\s\S]{0,260}?distance between two adjacent side-marker lamps shall not exceed\s*(3)\s*m"),
        },
        "why": {
            "A": "A §5.18.4.3（p55）：「两相邻侧标志灯的间距应不大于3m，若车型结构、设计或车辆操作使其不能保证在3m 内，则可增至4m。」",
            "B": "B §5.18.4.3（p46）：「两相邻侧标志灯的间距应不大于3m,若车型结构、设计或车辆操作使其不能保证在 3m内,则可增至4m。」",
            "C": "R48 §6.18.4.3（p72）：「The distance between two adjacent side-marker lamps shall not exceed 3 m.」",
        },
    },
    {
        "id": "sideMarkerLamp.adjacentGapMaxExempt",
        "name": "侧标志灯·相邻间距上限（车型结构受限时可增至）",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.18\.4\.3[\s\S]{0,280}?则可增至\s*(4)\s*m"),
            "B": P(r"5\.18\.4\.3[\s\S]{0,280}?则可增至\s*(4)\s*m"),
            "C": P(r"6\.18\.4\.3[\s\S]{0,620}?this distance may be increased to\s*(4)\s*m"),
        },
        "why": {
            "A": "A §5.18.4.3（p55）：「…不能保证在3m 内，则可增至4m。」",
            "B": "B §5.18.4.3（p46）：「…不能保证在 3m内,则可增至4m。」",
            "C": "R48 §6.18.4.3（p72）：「If the structure, design or the operational use of the vehicle make it "
                 "impossible to comply with such a requirement, this distance may be increased to 4 m.」",
        },
    },
    {
        "id": "sideReflexReflector.frontDistanceMax",
        "name": "侧回复反射器·最前面一只距车辆前端的上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.17\.4\.3[\s\S]{0,220}?最前面的\s*侧回复反射器离车辆前端不大于\s*(3)\s*m"),
            "B": P(r"5\.17\.4\.3[\s\S]{0,220}?最前面的侧回复反射器离\s*车辆前端不大于\s*(3)\s*m"),
            "C": P(r"6\.17\.4\.3[\s\S]{0,240}?foremost side retro-reflector being not further than\s*(3)\s*m"),
        },
        "why": {
            "A": "A §5.17.4.3（p54）：「最前面的 侧回复反射器离车辆前端不大于3m；对于半挂车，该距离要求可增至4m。」"
                 "—— PDF 在「最前面的」与「侧回复反射器」之间断了行，正则用 \\s* 吃掉。",
            "B": "B §5.17.4.3（p45）：「最前面的侧回复反射器离 车辆前端不大于3m。」",
            "C": "R48 §6.17.4.3（p70）：「the foremost side retro-reflector being not further than 3 m from the front;」",
        },
    },
    {
        "id": "sideReflexReflector.adjacentGapMax",
        "name": "侧回复反射器·相邻两只之间的间距上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.17\.4\.3[\s\S]{0,340}?同侧相邻回复反射器间的距离应不大于\s*(3)\s*m"),
            "B": P(r"5\.17\.4\.3[\s\S]{0,340}?相邻两侧回复反射器间的距离应不大于\s*(3)\s*m"),
            "C": P(r"6\.17\.4\.3[\s\S]{0,260}?distance between two adjacent side retro-reflectors shall not exceed\s*(3)\s*m"),
        },
        "why": {
            "A": "A §5.17.4.3（p54）：「除M1和N1类车辆外，其余车辆同侧相邻回复反射器间的距离应不大于3m」",
            "B": "B §5.17.4.3（p45）：「相邻两侧回复反射器间的距离应不大于3m。本规定不适用M1和N1类车辆。」",
            "C": "R48 §6.17.4.3（p70）：「The distance between two adjacent side retro-reflectors shall not exceed 3 m.」",
        },
    },
    {
        "id": "sideReflexReflector.adjacentGapMaxExempt",
        "name": "侧回复反射器·相邻间距上限（车型结构受限时可增至）",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.17\.4\.3[\s\S]{0,420}?则该间距要求可增至\s*(4)\s*m"),
            "B": P(r"5\.17\.4\.3[\s\S]{0,420}?则该间距可增至\s*(4)\s*m"),
            "C": P(r"6\.17\.4\.3[\s\S]{0,720}?this distance may be increased to\s*(4)\s*m"),
        },
        "why": {
            "A": "A §5.17.4.3（p54）：「若车型结构、设计或车辆操作造成不能满足上述要求，则该间距要求可增至4m。」",
            "B": "B §5.17.4.3（p45）：「若车型结构、设计或车辆操作造成不能满足上述要求,则该间距可增至4m。」",
            "C": "R48 §6.17.4.3（p70）：「If the structure, design or the operational use of the vehicle makes it "
                 "impossible to comply with such a requirement, this distance may be increased to 4 m.」",
        },
    },
    # ── 昼间行驶灯自动开启的行驶距离（B 独有）───────────────────────
    {
        "id": "drl.autoOnDistance",
        "name": "昼间行驶灯自动重新开启的行驶距离下限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "B": P(r"5\.19\.7\.2[\s\S]{0,220}?车辆已\s*行驶超过\s*(100)\s*m"),
        },
        "why": {
            "B": "B §5.19.7.2（p48）：「当车速低于10km/h,昼间行驶灯允许手动关闭,在此情况下若车速高于10km/h"
                 "或车辆已 行驶超过100m 且保持行驶状态时,昼间行驶灯应自动开启直至再次关闭。」"
                 "—— **B 把行驶距离 100m 和车速 10km/h 并列**；矩阵里只有车速那一行。",
        },
        "absent": {
            "A": "A §5.19.7.2（p57）只给车速条件（「车速不大于15km/h」），没有行驶距离条件。属版本差异。",
            "C": "R48 §6.19.7.2（p74）只给四个可以不点亮/保持熄灭的条件，没有行驶距离。属版本差异。",
        },
    },
    # ── 移动部件回位后的下倾角偏差（A/C 独有）──────────────────────
    {
        "id": "movableLamp.angularDeviationMax",
        "name": "移动部件回位后近光/前雾灯下倾角偏差上限",
        "family": "几何可见度 / 安装角度",
        "unit": "%",
        "patterns": {
            "A": P(r"移动部件从正常使用位置上移开并返回\s*10\s*次[^。]{0,140}?偏差应不大于\s*(0\.15)\s*%", "4.19"),
            "C": P(r"5\.20[\s\S]{0,700}?differs by more than\s*(0\.15)\s*per cent"),
        },
        "why": {
            "A": "A §4.19（p20，条款号在位图里、文本层取不到）：「对于近光灯和前雾灯，移动部件从正常使用位置上"
                 "移开并返回10 次，每次所测量的相对于其支撑件的倾斜角与10 次平均值之间的偏差应不大于0.15%。」"
                 "—— 条款号 4.19 由左边距裁剪渲染读出，登记在 data/clause-bitmap-fixes.json。",
            "C": "R48 §5.20（p32）：「…no value of the angular inclination of these lamps, relative to its "
                 "support, measured after each operation of the movable component, differs by more than "
                 "0.15 per cent from the average of the 10 measured values.」",
        },
        "absent": {
            "B": "GB 4785-2019 没有可移动部件回位后的下倾角偏差这一条。属版本差异，不是抽取失败。",
        },
    },
    # ── 可变光强：后车距离（A/C 独有）─────────────────────────────
    {
        "id": "variableIntensity.reduceFollowDistanceMax",
        "name": "可变光强光信号装置·允许减光的后车距离上限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"车速不大于\s*20\s*km/h\s*或后车距离不大于\s*(20)\s*m", "4.18"),
            "C": P(r"distance to the following vehicle is equal or less than\s*(20)\s*m", "5.26.2"),
        },
        "why": {
            "A": "A §4.18（p20，条款号在位图里）：「或，车速不大于20km/h 或后车距离不大于20m，"
                 "可在GB 5920 要求的配光范围内降低光强。」—— 矩阵里已有同一条款的「车速上限 20km/h」，"
                 "**后车距离那一半没有行**。",
            "C": "R48 §5.26.2（p33）：「…or the distance to the following vehicle is equal or less than 20 m.」",
        },
        "absent": {
            "B": "GB 4785-2019 没有把车距写成可变光强的触发条件（见 variableIntensity.reduceSpeedMax 的说明）。"
                 "属版本差异，不是抽取失败。",
        },
    },
    # ── 终端稳态电压的允许超出比例（A/B 5%、C 3%）─────────────────
    {
        "id": "systemVoltage.overTolerance",
        "name": "终端稳态电压允许超出上限的比例",
        "family": "电气条件 / 试验电压",
        "unit": "%",
        "patterns": {
            "A": P(r"终端稳定电压不得超过[^。]{0,170}?的\s*(5)\s*%\s*以上", "4.25"),
            "B": P(r"终端稳定电压不得超过[^。]{0,200}?的\s*(5)\s*%\s*以上", "4.27"),
            "C": P(r"5\.27\.2[\s\S]{0,320}?by more than\s*(3)\s*per cent"),
        },
        "why": {
            "A": "A §4.25（p24，条款号在位图里）：「终端稳定电压不得超过 13.5V（12V 系统）或28.0V（24V 系统）"
                 "的5%以上」—— **容差是百分比，不是伏特**。原来它和电压挤在同一行（单位写 V），"
                 "读起来像「5V」；这里拆成独立的一行。",
            "B": "B §4.27（p24）：「不得超过 6.75V(6V 系统), 13.5V(12V 系统)或28.0V(24V 系统)的5%以上」",
            "C": "R48 §5.27.2（p34）：「…shall not exceed 6.75 V (6 Volt-Systems), 13.5 V (12 Volt-Systems) "
                 "or 28 V (24 Volt-Systems) by more than 3 per cent.」—— **A/B 是 5%、C 是 3%**，"
                 "这是两套标准在电气条件上的实质差异之一。",
        },
    },
    # ── 醒目标志的覆盖率（C 独有）────────────────────────────────
    {
        "id": "conspicuityMarking.horizontalCoverageRatioMin",
        "name": "醒目标志·水平方向累计长度占车宽的下限",
        "family": "光色 / 标记",
        "unit": "%",
        "patterns": {
            "C": P(r"6\.21\.4\.1\.2[\s\S]{0,320}?shall equate to at least\s*(70)\s*per cent of the overall width"),
        },
        "why": {
            "C": "R48 §6.21.4.1.2（p78）：「The cumulative horizontal length of the conspicuity marking elements, "
                 "as mounted on the vehicle, shall equate to at least 70 per cent of the overall width of the "
                 "vehicle, excluding any horizontal overlap of individual elements.」",
        },
        "absent": {
            "A": "GB 4785 草案没有「醒目标志（conspicuity marking）」这一装置类别。属版本差异。",
            "B": "GB 4785-2019 没有「醒目标志」这一装置类别。属版本差异。",
        },
    },
    {
        "id": "conspicuityMarking.verticalCoverageRatioMin",
        "name": "醒目标志·垂直方向累计长度占车高的下限",
        "family": "光色 / 标记",
        "unit": "%",
        "patterns": {
            "C": P(r"6\.21\.4\.2\.2[\s\S]{0,320}?shall equate to at least\s*(70)\s*per cent of:"),
        },
        "why": {
            "C": "R48 §6.21.4.2.2（p79）：「The cumulative horizontal length of the conspicuity marking elements, "
                 "as mounted on the vehicle, excluding any horizontal overlap of individual elements, shall "
                 "equate to at least 70 per cent of:」—— 后面接的是垂直方向的两组。",
        },
        "absent": {
            "A": "GB 4785 草案没有「醒目标志」这一装置类别。属版本差异。",
            "B": "GB 4785-2019 没有「醒目标志」这一装置类别。属版本差异。",
        },
    },
    {
        "id": "conspicuityMarking.visibleAreaRatioMin",
        "name": "醒目标志·可见的照明表面比例下限",
        "family": "光色 / 标记",
        "unit": "%",
        "patterns": {
            "C": P(r"6\.21\.5[\s\S]{0,320}?if at least\s*(70)\s*per cent of the illuminating surface"),
        },
        "why": {
            "C": "R48 §6.21.5（p80）：「The conspicuity marking shall be considered visible, if at least 70 per cent "
                 "of the illuminating surface of the installed marking is visible when viewed by an observer "
                 "positioned at any point within the observation planes defined below:」",
        },
        "absent": {
            "A": "GB 4785 草案没有「醒目标志」这一装置类别。属版本差异。",
            "B": "GB 4785-2019 没有「醒目标志」这一装置类别。属版本差异。",
        },
    },
    # ── A 第 4 章（一般要求）此前整章不可见的那几条 ────────────────
    {
        "id": "retractableLamp.deployTimeMax",
        "name": "可藏灯·开启控制开关后达到使用位置的时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"可藏灯在-30℃～\+50℃环境下[^。]{0,90}?应在\s*(3)\s*s\s*内达到使用位置", "4.14"),
            "B": P(r"可藏装置在-30 ℃~\+50 ℃的范围内[^。]{0,90}?应在\s*(3)\s*s内达到使用位置", "4.14"),
        },
        "why": {
            "A": "A §4.14（p16，条款号在位图里）：「e) 可藏灯在-30℃～+50℃环境下，开启控制开关，"
                 "近光灯和远光灯应在3s 内达到使用位置。」",
            "B": "B §4.14（p16）：「e) 可藏装置在-30 ℃~+50 ℃的范围内,一旦开启控制开关,前照灯应在3s内达到使用位置。」",
        },
        "absent": {
            "C": "R48 没有「可藏灯（retractable lamp）」这一装置类别。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "illuminatingSurface.partGapThreshold",
        "name": "发光面·分开的透光面之间的间隙门槛",
        "family": "灯具本体 / 构造要求",
        "unit": "mm",
        "patterns": {
            "A": P(r"若透光面分开，且距离小于\s*(10)\s*mm", "4.17"),
        },
        "why": {
            "A": "A §4.17（p19–20，条款号在位图里）：「3) 若透光面分开，且距离小于10mm。诸透光面整体可按"
                 "上述1）或2）的方法确认边界。4) 若透光面分开，且距离大于10mm，小于75mm。则分开的透光面"
                 "分别确认发光面边界。」—— **10mm 是「算一块还是算两块」的门槛**，与 75mm 的间距上限是两件事。",
        },
        "absent": {
            "B": "GB 4785-2019 没有 10mm 这个「分开发光面算一块」的门槛（只有 75mm 的间距上限）。属版本差异。",
            "C": "R48 用 §5.4 的发光面定义，没有 10mm 门槛。属版本差异。",
        },
    },
    {
        "id": "truckLamp.minApparentCircleDiameter",
        "name": "货车后位灯/后转向灯/制动灯·透光面最小等效圆直径",
        "family": "灯具本体 / 构造要求",
        "unit": "mm",
        "patterns": {
            "A": P(r"总质量不小于4500kg[^。]{0,140}?透\s*光面面积应不小于一个\s*(80)\s*mm\s*直径圆的面积", "4.27"),
            "B": P(r"总质量不小于4500kg[^。]{0,140}?透\s*光面面积应不小于一个\s*(80)\s*mm\s*直径圆的面积", "4.29"),
        },
        "why": {
            "A": "A §4.27（p21，条款号在位图里）：「总质量不小于4500kg 的货车、专项作业车和挂车的所有后位灯、"
                 "后转向信号灯和制动灯，其透 光面面积应不小于一个80mm 直径圆的面积；」"
                 "—— **A 是 4.27、B 是 4.29**：草案删掉了两条，所以条款号对不上，"
                 "两个号都由左边距裁剪渲染读出并登记。",
            "B": "B §4.29（p21）：「总质量不小于4500kg的货车、专项作业车和挂车的所有后位灯、后转向信号灯和制动灯,"
                 "其透 光面面积应不小于一个80mm 直径圆的面积;」",
        },
        "absent": {
            "C": "R48 没有针对 4500kg 以上货车/挂车的这项透光面面积要求。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "truckLamp.minContainedCircleDiameter",
        "name": "货车后位灯/后转向灯/制动灯·透光面须容纳的最小圆直径",
        "family": "灯具本体 / 构造要求",
        "unit": "mm",
        "patterns": {
            "A": P(r"若透光面不是圆形[,，]其形状还应能容纳一个\s*(40)\s*mm\s*直径的\s*圆", "4.27"),
            "B": P(r"若透光面不是圆形[,，]其形状应能容纳一个\s*(40)\s*mm\s*直径的\s*圆", "4.29"),
        },
        "why": {
            "A": "A §4.27（p21）：「若透光面不是圆形，其形状还应能容纳一个40mm 直径的 圆。」",
            "B": "B §4.29（p21）：「若透光面不是圆形,其形状应能容纳一个40 mm 直径的 圆。」",
        },
        "absent": {
            "C": "R48 没有针对 4500kg 以上货车/挂车的这项透光面形状要求。属版本差异。",
        },
    },
    {
        "id": "externalStatusIndicator.intensityMax",
        "name": "外部状态指示器·各方向光强上限",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "A": P(r"各方向光强不能超过\s*(0\.5)\s*cd", "4.30"),
            "C": P(r"5\.32[\s\S]{0,600}?light intensity in any direction does not exceed\s*(0\.5)\s*cd"),
        },
        "why": {
            "A": "A §4.30（p22，条款号在位图里）：「允许安装1 只（或2 只）外部状态指示器（发光装置）用于VAS、AS "
                 "和防盗功能（警报系统），并应符合以下要求： —— 各方向光强不能超过0.5cd；」"
                 "—— 面积的两档（20cm² / 10cm²）矩阵里已有 C 的行，这里补 A 与光强。",
            "C": "R48 §5.32（p35）：「(a) The light intensity in any direction does not exceed 0.5 cd;」",
        },
        "absent": {
            "B": "GB 4785-2019 无外部状态指示器条款。属版本差异。",
        },
    },
    {
        "id": "ambientLighting.autoOffDistance",
        "name": "外部氛围功能·自动熄灭的行驶距离下限",
        "family": "试验条件 / 路段速度",
        "unit": "m",
        "patterns": {
            "A": P(r"行驶距离达到\s*(50)\s*m\s*前，应自动熄灭", "4.32"),
        },
        "why": {
            "A": "A §4.32（p22，条款号在位图里）：「发光装置点亮后，当车辆开动，车速达到5km/h 前或"
                 "行驶距离达到50m 前，应自动熄灭，直至再次符合点亮条件；」"
                 "—— 与车速那一档并列。",
        },
        "absent": {
            "B": "GB 4785-2019 没有「外部氛围功能」这一条款。属版本差异。",
            "C": "R48 没有「外部氛围功能」这一条款。属版本差异。",
        },
    },
    {
        "id": "ambientLighting.sequentialDurationMax",
        "name": "外部氛围功能·顺序控制的持续时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"顺序控制持续时间不应超过\s*(5)\s*s", "4.32"),
        },
        "why": {
            "A": "A §4.32（p22）：「—— 外部氛围功能若使用顺序控制，顺序控制持续时间不应超过5s。」",
        },
        "absent": {
            "B": "GB 4785-2019 没有「外部氛围功能」这一条款。属版本差异。",
            "C": "R48 没有「外部氛围功能」这一条款。属版本差异。",
        },
    },
    {
        "id": "sideMarkerLamp.rearDistanceMax",
        "name": "侧标志灯·最后面一只距车辆后端的上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.18\.4\.3[\s\S]{0,300}?最后面的侧标志灯离车辆后端应不大于\s*(1)\s*m"),
            "B": P(r"5\.18\.4\.3[\s\S]{0,300}?最后面的侧标志灯离车辆后端应不大于\s*(1)\s*m"),
            "C": P(r"6\.18\.4\.3[\s\S]{0,640}?rearmost side-marker lamp and the rear of the vehicle shall not exceed\s*(1)\s*m"),
        },
        "why": {
            "A": "A §5.18.4.3（p55）：「最后面的侧标志灯离车辆后端应不大于1m。」",
            "B": "B §5.18.4.3（p46）：「最后面的侧标志灯离车辆后端应不大于1m。」",
            "C": "R48 §6.18.4.3（p72）：「The distance between the rearmost side-marker lamp and the rear of "
                 "the vehicle shall not exceed 1 m.」",
        },
    },
    {
        "id": "sideReflexReflector.rearDistanceMax",
        "name": "侧回复反射器·最后面一只距车辆后端的上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "A": P(r"5\.17\.4\.3[\s\S]{0,420}?最后的回复反射器离车辆尾部应不大于\s*(1)\s*m"),
            "B": P(r"5\.17\.4\.3[\s\S]{0,420}?最后面的侧回复反射器离车辆后端应不大于\s*(1)\s*m"),
            "C": P(r"6\.17\.4\.3[\s\S]{0,760}?rearmost side retro-reflector and the rear of the vehicle shall not exceed\s*(1)\s*m"),
        },
        "why": {
            "A": "A §5.17.4.3（p54）：「安装于最后的回复反射器离车辆尾部应不大于1m。」—— 原文是「最后的」。",
            "B": "B §5.17.4.3（p45）：「最后面的侧回复反射器离车辆后端应不大于1m。」—— 原文带「侧」字。",
            "C": "R48 §6.17.4.3（p70）：「The distance between the rearmost side retro-reflector and the rear of "
                 "the vehicle shall not exceed 1 m.」",
        },
    },
]

# ── 对已有行的修补 ──────────────────────────────────────────────
FIX = {
    # A 的肘部偏差允差在 §5.3.6.3；原来的 absent 说明是**错的**（A 有这一条）。
    "afs.elbowDeviationTolerance": {
        "addPatterns": {
            "A": P(r"允许向右侧\s*(0\.5)\s*度内的偏差", "5.3.6.3"),
        },
        "dropAbsent": ["A"],
        "why": {
            "A": "A §5.3.6.3（p31）：「投射在测量屏幕上的明暗截止线肘部，应位于发光单元基准轴线所在的垂直平面与"
                 "测量屏幕的交线上，允许向右侧0.5度内的偏差（不应向左侧偏移）。」"
                 "—— **A 有这一条**，原来的 absent 说明是错的（写 spec 时只看了 B/C）。"
                 "**按措辞锚、不按条款号锚**：A 的 §5.3.6.3 标题在第 27 页页尾、正文在第 32 页，"
                 "「条款号+值」跨了页标记，正则永远匹配不上。",
        },
    },
    # 外部状态指示器的面积：A 与 C 同值（20 / 10 cm²），A 的条款号 4.30 在位图里。
    "externalStatusIndicator.areaMax": {
        "addPatterns": {
            "A": P(r"视表面不大于\s*(20)\s*cm\s*2", "4.30"),
        },
        "dropAbsent": ["A"],
        "why": {
            "A": "A §4.30（p22，条款号在位图里）：「—— 视表面不大于20cm 2。若安装2 只，则每只视表面不得大于10cm 2；」"
                 "—— 与 R48 §5.32 的 20 cm² **同值**。",
        },
    },
    "externalStatusIndicator.areaMaxEachOfTwo": {
        "addPatterns": {
            "A": P(r"若安装2\s*只，则每只视表面不得大于\s*(10)\s*cm\s*2", "4.30"),
        },
        "dropAbsent": ["A"],
        "why": {
            "A": "A §4.30（p22，条款号在位图里）：「若安装2 只，则每只视表面不得大于10cm 2；」"
                 "—— 与 R48 §5.32 的 10 cm² **同值**。",
        },
    },
    # 电压行原来把「5%」「3%」的容差和电压挤在一起，单位却写着 V —— 读起来像「5V」。
    "systemVoltage.maxSteady": {
        "setPatterns": {
            "A": P(r"终端稳定电压不得超过\s*13\.5\s*V[（(]\s*12\s*V\s*系统\s*[)）][^。]{0,90}?28(?:\.0)?\s*V"),
            "B": P(r"终端稳定电压不得超过\s*6\.75\s*V[（(]\s*6\s*V\s*系统\s*[)）][^。]{0,160}?13\.5\s*V[^。]{0,120}?28(?:\.0)?\s*V"),
            "C": P(r"5\.27\.2\.[\s\S]{0,300}?(shall not exceed\s*6\.75\s*V[^.]{0,200}?13\.5\s*V[^.]{0,120}?or 28\s*V)"),
        },
        "why": {
            "A": "**这一行原来把容差也一起框进来了**：捕获组一路吃到「的5%以上」，于是矩阵把 5 和电压"
                 "并排显示，单位却是 V —— 读者会看成「5V」。现在捕获组只框电压三档，容差单独一行"
                 "（systemVoltage.overTolerance，单位 %）。",
        },
        "note": "本行只放**电压上限**；允许超出上限的**百分比容差**另立一行 systemVoltage.overTolerance"
                "（A/B 5%、C 3%）。原来两者挤在一行、单位写 V，是本项目里最容易被读错的一处。",
    },
    # C 的 0.25 cd 判定在 §5.10.4.3，原先被就近取条款号取到了 5.12.1.3。
    "positionLamp.zoneIntensity": {
        "setPatterns": {
            "C": P(r"5\.10\.4\.3[\s\S]{0,320}?not more than\s*(0\.25)\s*cd per lamp"),
        },
        "why": {
            "C": "R48 §5.10.4.3（p27）：「In case of doubt, the requirement above shall be deemed fulfilled if "
                 "the luminous intensity of the red light emitted to the front and/or the white light emitted "
                 "to the rear, as verified during type approval of the lamps, is not more than 0.25 cd per "
                 "lamp…」—— **条款号要写死**：就近取条款号会取到 §5.12.1.3（那里只是引用），"
                 "而这段话本身在 §5.10.4.3。",
        },
    },
}

# A 第 4 章的位图条款号（新补的行要用）
BITMAP_ADD = {
    "A": {
        "4.14": "A 第 4 章「可藏灯」：「对于可藏灯应满足下列要求：… e) 可藏灯在-30℃～+50℃环境下，开启控制开关，"
                "近光灯和远光灯应在3s 内达到使用位置。」（源 PDF p16）。条款号由左边距裁剪渲染读出。",
        "4.17": "A 第 4 章「发光面的测量」：「为测量灯具主功能高度，应确定发光面的上、下边缘… 3) 若透光面分开，"
                "且距离小于10mm。诸透光面整体可按上述1）或2）的方法确认边界。」（源 PDF p19–20）。"
                "条款号由左边距裁剪渲染读出。",
        "4.19": "A 第 4 章「移动部件」：「当灯具主功能以及从属功能安装在移动部件上，且移动部件处于"
                "『可移动部件的正常使用位置』… 对于近光灯和前雾灯，移动部件从正常使用位置上移开并返回10 次，"
                "每次所测量的相对于其支撑件的倾斜角与10 次平均值之间的偏差应不大于0.15%。」（源 PDF p20）。"
                "条款号由左边距裁剪渲染读出。",
        "4.25": "A 第 4 章「电气条件」：「终端稳定电压不得超过 13.5V（12V 系统）或28.0V（24V 系统）的5%以上」"
                "（源 PDF p24）。条款号由左边距裁剪渲染读出。",
        "4.27": "A 第 4 章「货车灯具的透光面」：「总质量不小于4500kg 的货车、专项作业车和挂车的所有后位灯、"
                "后转向信号灯和制动灯，其透 光面面积应不小于一个80mm 直径圆的面积；若透光面不是圆形，"
                "其形状还应能容纳一个40mm 直径的 圆。」（源 PDF p21）。条款号由左边距裁剪渲染读出。",
        "4.30": "A 第 4 章「外部状态指示器」：「允许安装1 只（或2 只）外部状态指示器（发光装置）用于VAS、AS "
                "和防盗功能（警报系统），并应符合以下要求： —— 各方向光强不能超过0.5cd； —— 颜色为白色、红色或琥珀色；"
                "—— 视表面不大于20cm 2。若安装2 只，则每只视表面不得大于10cm 2；」（源 PDF p22）。"
                "条款号由左边距裁剪渲染读出。",
        "4.32": "A 第 4 章「外部氛围功能」：「发光装置点亮后，当车辆开动，车速达到5km/h 前或行驶距离达到50m 前，"
                "应自动熄灭… —— 外部氛围功能若使用顺序控制，顺序控制持续时间不应超过5s。」（源 PDF p22）。"
                "条款号由左边距裁剪渲染读出。",
    },
}


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
                      % (row["id"], ver, r["tag"], r["page"], repr(r["focus"])[:50], r["nums"]))
    return bad


def write():
    data = json.loads(io.open(SPEC, encoding="utf-8").read())
    by_id = {s["id"]: s for s in data["specs"]}
    n = 0
    for row in NEW:
        if row["id"] in by_id:
            print("!! 已存在，跳过：%s" % row["id"])
            continue
        data["specs"].append(row)
        n += 1
    for sid, fx in FIX.items():
        s = by_id.get(sid)
        if s is None:
            print("!! 找不到要修的行：%s" % sid)
            continue
        for ver, pat in (fx.get("addPatterns") or {}).items():
            s.setdefault("patterns", {})[ver] = pat
        for ver, pat in (fx.get("setPatterns") or {}).items():
            s.setdefault("patterns", {})[ver] = pat
        for ver in (fx.get("dropAbsent") or []):
            (s.get("absent") or {}).pop(ver, None)
            if s.get("absent") is not None and not s["absent"]:
                s.pop("absent")
        for ver, txt in (fx.get("why") or {}).items():
            s.setdefault("why", {})[ver] = txt
        if fx.get("note"):
            s["note"] = fx["note"]
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("加了 %d 行，总行数 %d" % (n, len(data["specs"])))

    bm = json.loads(io.open(BITMAP, encoding="utf-8").read())
    for ver, clauses in BITMAP_ADD.items():
        bm.setdefault(ver, {})
        for cl, why in clauses.items():
            bm[ver].setdefault(cl, why)
    io.open(BITMAP, "w", encoding="utf-8", newline="").write(
        json.dumps(bm, ensure_ascii=False, indent=2) + "\n")
    print("位图条款号登记：A %s" % ", ".join(sorted(BITMAP_ADD["A"])))


if __name__ == "__main__":
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没命中，先别写。")
            sys.exit(1)
        write()
    else:
        sys.exit(1 if selfcheck() else 0)
