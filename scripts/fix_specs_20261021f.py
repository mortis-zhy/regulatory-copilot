# -*- coding: utf-8 -*-
"""2026-10-21 第四批：修条款切分器之后露出来的真缺口（B 第 4 章整章没人扫过）。

起因：`scripts/clause_split.py` 的**碎片链**有个洞 —— 一行正文
「1执行紧急制动信号时不得使用该闪烁方式。」既不是纯数字、也不是
「数字+空格+标题」，却**没有打断碎片链**，于是上一行的交叉引用碎片
「23.」（出自「按5.23.1执行」）和下一行的真条款碎片「4.」被拼成
「23.4.10」这个**不存在的条款号**，整条真条款被丢掉。

后果：**B（GB 4785-2019）第 4 章的 4.10–4.31 整段没进条款索引** ——
而 4.9 又被登记为「不在范围」，于是**一般要求整章对覆盖审计隐形**：
电压（4.25/4.27）、货车透光面（4.29）、移动部件 0.15%（4.20）、
移动部件遮挡 50%（4.21）、可藏灯（4.14）、光色（4.15）…一条都没被清点过。

修好索引后，B 的限值数从 283 → 324，**真缺口 18**。这一批处理这 18 条：

**新行（4 条）**
1. `movableLamp.occlusionMaxRatio` 移动部件遮挡视表面比例上限 50%
   （A §4.21 / B §4.21 / C §5.21）—— 此前三版**都没有**这一行，
   而 C §5.21.1/§5.21.2 的 50% 被「昼间行驶灯相对前转向灯光强」那行
   **顶掉了**（数值撞车）。
2. `bandStripLamp.minLength` 带(条)状双灯/偶数灯的最小长度 0.8 m
   （B §4.7c / C §5.7.2.4；**A 无此规定** —— 草案把 4.7 改写了）
3. `bandStripLamp.endToEdgeMax` 带(条)状灯两端至车辆外缘端面距离 0.4 m
   （B §4.7c / C §5.7.2.4；**A 无此规定**）
   ⚠ **B 与 C 的限定词方向看着相反**：B「不大于 0.4m」、C「to within
   **at least** 0.4 m」—— 数值相同、条件方向相反，已写进 why。
4. `conspicuityMarking.continuityGapMaxRatio` 醒目标志相邻元件间距与最短
   元件长度之比上限 50%（C §6.21.7.1；**A/B 都没有** ——
   A 转引 GB 11564、B 转引 GB 23254 / GB 25990）

**补一个空格（1 条）**
5. `movableLamp.angularDeviationMax` 的 **B 列是空的**，而 B §4.20 有
   0.15% —— 而且 **A 的条款号引错了**：A 的 0.15% 在 **§4.20**，不是 §4.19
   （左边距位图读出：「4.19 对于主功能安装在可移动部件上的后位灯…」
   「4.20 当灯具主功能以及从属功能安装在移动部件…偏差应不大于 0.15%」）。

跑法： python scripts/fix_specs_20261021f.py [--check] [--write]
"""
import importlib.util, io, json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")
FIXES = os.path.join(ROOT, "data", "clause-bitmap-fixes.json")
TABLES = os.path.join(ROOT, "data", "table-clauses.json")

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
        "id": "movableLamp.occlusionMaxRatio",
        "name": "移动部件遮蔽前/后位灯等视表面的比例上限",
        "family": "几何可见度 / 安装角度",
        "unit": "%",
        "patterns": {
            "A": P(r"遮蔽前、后位灯，前、后转向信号灯的主功能和前、后回复反射器不应超过其视表面的\s*(50)\s*%", "4.21"),
            "B": P(r"遮蔽前、后位灯,前、后转向信号灯和前、后回复反射器不应超过其视表面的\s*(50)\s*%", "4.21"),
            "C": P(r"shall not be hidden more than\s*(50)\s*per cent", "5.21"),
        },
        "why": {
            "A": "A §4.21（p21，条款号印在左边距的**位图**里，由 `scripts/read_margin_clause.py` 裁图读出）："
                 "「b) 遮蔽前、后位灯，前、后转向信号灯的主功能和前、后回复反射器不应超过其视表面的50%。」"
                 "—— 条款号**写死**：A 第 4 章条款号全是位图，就近推断根本取不到。",
            "B": "B §4.21（p20）：「当从基准轴线方向观察时,任何可移动部件(不管是否装有光信号装置),"
                 "在所有固定位置上遮蔽前、后位灯,前、后转向信号灯和前、后回复反射器不应超过其视表面的50%。」"
                 "—— **B 第 4 章此前整章没进条款索引**（碎片链被交叉引用污染），"
                 "所以这一条既没被审计、也没进矩阵。",
            "C": "R48 §5.21（p32）：「The apparent surface … of front and rear position lamps, front and rear "
                 "direction-indicator lamps and retro-reflectors shall not be hidden more than 50 per cent by "
                 "any movable component…」—— §5.21.1 / §5.21.2 的 50% 是同一条的展开。",
        },
    },
    {
        "id": "bandStripLamp.minLength",
        "name": "带(条)状双灯/偶数灯的最小长度",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "B": P(r"带\(条\)状双灯或偶数灯外形应对称于车辆纵向对称平面,长度不小于\s*(0\.\s*8)\s*m", "4.7"),
            "C": P(r"and are not less than\s*(0\.\s*8)\s*m long", "5.7.2.4"),
        },
        "absent": {
            "A": "**GB 4785 草案把这一条删了** —— 不是抽取失败。A §4.7（p14–15，条款号在位图里）"
                 "改成了「c) 成对安装的灯具（包括回复反射器），左灯和右灯可在同一带（条）状灯体内，"
                 "且可分别作为左侧和右侧的『D』型灯或互存灯…」，"
                 "**没有** B/C 那种「带(条)状双灯或偶数灯…长度不小于 0.8m」的要求。"
                 "**这是版本间的实质差异**（草案不再规定灯带长度），不是漏抽。",
        },
        "why": {
            "B": "B §4.7c)（p14）：「带(条)状双灯或偶数灯外形应对称于车辆纵向对称平面,长度不小于0.8m,"
                 "其两端至车辆外缘端面的距离不大于0.4m;光源不少于两个,且尽量靠近两端…」",
            "C": "R48 §5.7.2.4（p26）：「Two lamps or an even number of lamps in the shape of a band or strip "
                 "shall be placed symmetrically … and are not less than 0.8 m long…」",
        },
    },
    {
        "id": "bandStripLamp.endToEdgeMax",
        "name": "带(条)状灯两端至车辆外缘端面的距离上限",
        "family": "位置 / 间距限值",
        "unit": "m",
        "patterns": {
            "B": P(r"其两端至车辆外缘端面的距离不大于\s*(0\.\s*4)\s*m", "4.7"),
            "C": P(r"extending on both sides to within at least\s*(0\.\s*4)\s*m of the extreme outer edge", "5.7.2.4"),
        },
        "absent": {
            "A": "同 `bandStripLamp.minLength`：**GB 4785 草案的 §4.7 改写后没有灯带长度/端距要求**。",
        },
        "why": {
            "B": "B §4.7c)（p14）：「…其两端至车辆外缘端面的距离**不大于** 0.4m…」",
            "C": "R48 §5.7.2.4（p26）：「…extending on both sides to **within at least** 0.4 m of the extreme "
                 "outer edge of the vehicle…」"
                 "—— ⚠ **数值相同、限定词看着相反**：B 说「距离**不大于** 0.4m」（灯带要贴近车缘），"
                 "C 的英文是「to within **at least** 0.4 m」（读起来是离车缘**至少** 0.4m）。"
                 "**这一格不能只看数值** —— 出口欧盟按哪个方向执行，要回 R48 原文/官方译本确认。",
        },
    },
    {
        "id": "conspicuityMarking.continuityGapMaxRatio",
        "name": "醒目标志相邻元件间距与最短元件长度之比上限（连续性判定）",
        "family": "光色 / 标记",
        "unit": "%",
        "patterns": {
            "C": P(r"do not exceed\s*(50)\s*per cent of the shortest adjacent element length", "6.21.7.1"),
        },
        "absent": {
            "A": "**A 不自己规定这条，转引了另一份标准** —— A §5.20（p57，条款号在位图里）："
                 "「汽车及挂车车身反光标识和车辆尾部标志板的安装按 **GB 11564** 要求。」"
                 "（GB 11564 是《机动车回复反射器》，与反光标识不是同一件事 —— "
                 "**草案这里引的标准与 2019 版不同，值得客户回原文确认是不是笔误**。）"
                 "**不是抽取失败，是这一版没写这条数值要求。**",
            "B": "**B 同样转引** —— B §5.21（p49）：「汽车及挂车车身反光标识的安装按 **GB23254** 相关要求。"
                 "车辆尾部标志板的安装按 **GB25990** 相关要求。」"
                 "连续性判定（相邻元件间距比）在 GB 23254 里，GB 4785-2019 自己不写。",
        },
        "why": {
            "C": "R48 §6.21.7.1（p81）：「Conspicuity markings shall be considered continuous if the distance "
                 "between adjacent elements are as small as possible and do not exceed 50 per cent of the "
                 "shortest adjacent element length.」—— 此前这个 50% 被「昼间行驶灯相对前转向灯光强的"
                 "豁免门槛」那行**顶掉了**（数值撞车，两者是不同的要求）。",
        },
    },
]

# ── 补一个空格 + 修一处引错的条款号 ────────────────────────────────
FIX = {
    "movableLamp.angularDeviationMax": {
        "setPatterns": {
            "A": P(r"移动部件从正常使用位置上移开并返回\s*10\s*次[\s\S]{0,120}?偏差应不大于\s*(0\.\s*15)\s*%", "4.20"),
            "B": P(r"移动部件从正常使用位置上移开并返回\s*10\s*次[\s\S]{0,120}?偏差不大于\s*(0\.\s*15)\s*%", "4.20"),
        },
        # 旧的 absent 说明写着「GB 4785-2019 没有这一条」—— **那是错的**：
        # B §4.20 有 0.15%（只是整章没进条款索引，一直没被扫到）。
        # 「错的 absent 说明比没有更坏」：读者会以为 2019 版真没这条。
        "dropAbsent": ["B"],
        "why": {
            "A": "A §4.20（p20，条款号印在左边距的**位图**里，裁图读出：「4.20 当灯具主功能以及从属功能"
                 "安装在移动部件上…对于近光灯和前雾灯，移动部件从正常使用位置上移开并返回 10 次，每次所测量"
                 "的相对于其支撑件的倾斜角与 10 次平均值之间的偏差应不大于 0.15%。」）"
                 "—— **原引 §4.19 是错的**：左边距上 4.19 是「对于主功能安装在可移动部件上的后位灯…」，"
                 "0.15% 在**下一条 4.20**。值对、条款错，且因为 A 第 4 章是位图，"
                 "「取值在所引条款里」那一关退回弱命中，一直没被抓住。",
            "B": "B §4.20（p20）：「当灯具安装在移动部件上,且移动部件处于『可移动部件的正常使用位置』…"
                 "对于近光灯和前雾灯,若移动部件从正常使用位置上移开并返回10次,每次所测量的相对于其支撑件的"
                 "倾斜角与10次平均值之间的偏差不大于0.15%…」"
                 "—— **B 此前整格是空的**，而 B 原文有这条：B 第 4 章整章没进条款索引（碎片链被交叉引用污染），"
                 "覆盖审计根本没扫到它。",
        },
    },
}

# ── 覆盖审计的登记：门槛 / 试验条件 / 观察区域 ──────────────────────
# 这些量值**不是安装限值**（规定的是「哪辆车要装」「检验员站在哪」
# 「怎么测」），按第 9.21 轮定下的口径登记为 outOfScope / mixed，
# 并写明理由 —— 登记之后，它们从覆盖分母里出去，但**在附录 E.3 里逐条列明**。
REGISTER = {
    "B": {
        "4.10": {
            "kind": "outOfScope",
            "note": "前视红光/后视白光的**目视检验观察区域**：离车前/车后 25m、区域1/区域2 的"
                    "高度 1m 与 2.2m、外张 15°。规定的是检验员站在哪、看哪个区域，"
                    "**不是安装限值**。",
        },
        "7.4": {
            "kind": "outOfScope",
            "note": "实施日期/过渡条款（标准实施后 36 个月内按 5.2.7.6 执行）**加上其后附录A 的"
                    "装载状况与试验条件**（乘员 75kg、轴荷 25%、路面 10m/600m、路段占比 10/20/70%、"
                    "车速 20km/h、环境照度 0.2lx、测量精度 0.02%/0.05%、照度 10lx 等）。"
                    "**附录A 是「近光光束随装载变化的倾斜度」**，其限值见附录 F；"
                    "这里列的都是试验条件。",
        },
        "5.5.3.2": {
            "kind": "outOfScope",
            "note": "「长度大于9m 的O2 类车辆每侧最多可选装3只5类侧标志灯」—— 9m 是**车长分档门槛**，"
                    "规定的是「哪种车适用哪一档」，不是安装限值。",
        },
        "5.13.1": {
            "kind": "outOfScope",
            "note": "示廓灯配备条件「宽度大于2.10m 的车辆应配备；宽度介于1.80m~2.10m 的车辆选装」"
                    "—— 1.8m/2.1m 是**车宽适用门槛**，不是安装限值。",
        },
        "5.5.3.1": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**（「长度不大于6m 的N1、M2 和M3 类车辆」适用哪一档侧转向灯），"
                    "不是安装限值。",
        },
        "5.5.7": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**（「长度小于6m 的M1类和N1车辆」侧标志灯的闪烁条件），不是安装限值。",
        },
        "5.6.7.3": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**（「对于长度小于6m 的M1和N1类车辆,其布局符合…」），不是安装限值。",
        },
        "5.17.1": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**强制配备的车辆长度门槛**（「长度大于6m 的汽车和所有挂车应配备；"
                    "长度不大于6m 的汽车可以选装」）—— 规定的是「哪类车必须装」，不是安装限值。"
                    "条款正文在第 14 章逐句对照里。",
        },
        "5.18.1": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**强制配备的车辆长度门槛**（「除了带驾驶室底盘外,长度大于6m 的车辆应配备」）"
                    "—— 规定的是「哪类车必须装」，不是安装限值。",
        },
        "5.18.7": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**（「在长度小于6m 的M1和N1类车辆上,琥珀色侧标志灯可以与…」），"
                    "不是安装限值。",
        },
    },
    "C": {
        "6.5.7": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**（「On M1 and N1 vehicles less than 6 m in length …」），不是安装限值。",
        },
        "6.6.7.3": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**，不是安装限值。",
        },
        "6.17.1": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**强制配备的车辆长度门槛**（「Mandatory: On all motor vehicles the length of which "
                    "exceeds 6 m.」）—— 规定的是「哪类车必须装」，不是安装限值。",
        },
        "6.18.1": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**强制配备的车辆长度门槛**，不是安装限值。",
        },
        "6.18.7": {
            "kind": "mixed",
            "skip": [[6, "m"]],
            "note": "6m 是**车辆长度门槛**，不是安装限值。",
        },
        "6.1.9.3.1.2": {
            "kind": "mixed",
            "skip": [[0.8, "m"]],
            "note": "0.8m 是**被探测的电动自行车替代表征灯的灯高**（「a height above a ground of 0.8 m」）"
                    "—— 试验条件。同一句里的 150cd / 10cm² 是矩阵里有的行（电动自行车替代表征灯）。",
        },
    },
    "A": {
        "5.1.9.2.1.2": {
            "kind": "table",
            "appendixF": "5.1.9.2.1.1",
            "note": "远光自动控制传感器的**垂直最小探测范围表**（表6）—— 安装高度 0.8m/1.5m/2m 分档，"
                    "与 5.1.9.2.1.1 是**同一张表**（表头在上一条、表体在本条），"
                    "已逐字收录在附录 F「远光自动控制传感器的垂直最小探测范围」。",
        },
    },
}

# ── A 第 4 章的位图条款号：补 4.20 / 4.21 / 5.20，并把 4.19 的说明改对 ──
BITMAP = {
    "4.20": "GB 4785 草案第 4 章的条款号印在 PDF 左边距，是**位图**，文本层取不到。"
            "本条对应第 4 章的「移动部件回位后的倾斜度偏差」：原文「当灯具主功能以及从属功能安装在移动部件上，"
            "且移动部件处于『可移动部件的正常使用位置』…对于近光灯和前雾灯，移动部件从正常使用位置上移开并返回 10 次，"
            "每次所测量的相对于其支撑件的倾斜角与 10 次平均值之间的偏差应不大于 0.15%。」（源 PDF p20）。"
            "条款号由左边距裁剪渲染读出（左边距上依次是 4.18 可变光强 / 4.19 移动部件 / **4.20 0.15%** / **4.21 遮挡 50%**）。",
    "4.21": "GB 4785 草案第 4 章的条款号印在 PDF 左边距，是**位图**，文本层取不到。"
            "本条对应第 4 章的「移动部件的遮蔽」：原文「当从基准轴线方向观察时，任何可移动部件…"
            "遮蔽前、后位灯，前、后转向信号灯的主功能和前、后回复反射器不应超过其视表面的 50%。」（源 PDF p21）。"
            "条款号由左边距裁剪渲染读出（4.21 的标题在 p20 末、其 b) 项在 p21）。",
    "5.20": "GB 4785 草案第 5 章「醒目标志」：原文「汽车及挂车车身反光标识和车辆尾部标志板的安装按 GB 11564 要求。」"
            "（源 PDF p57）。条款号由左边距裁剪渲染读出。"
            "**注意**：草案引的是 GB 11564（机动车回复反射器），而 2019 版引的是 GB 23254 / GB 25990 —— "
            "**两版引用的标准不同，值得回原文确认**。",
}


def selfcheck():
    bad = 0
    for row in NEW:
        for ver, p in row["patterns"].items():
            r = tp.run(ver, p["source"])
            if not r:
                print("  ✗ %-44s %s 没命中" % (row["id"], ver))
                bad += 1
            else:
                print("  ✓ %-44s %s  %s p%-4s → %s" % (row["id"], ver, r["tag"], r["page"], r["nums"]))
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    for sid, fx in FIX.items():
        for ver, pat in fx.get("setPatterns", {}).items():
            r = tp.run(ver, pat["source"])
            if not r:
                print("  ✗ %-44s %s 新pattern没命中" % (sid, ver))
                bad += 1
            else:
                print("  ✓ %-44s %s  %s p%-4s → %s" % (sid, ver, r["tag"], r["page"], r["nums"]))
    return bad


def write():
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    n = 0
    for row in NEW:
        if row["id"] in by_id:
            print("!! 已存在，跳过：%s" % row["id"])
            continue
        doc["specs"].append(row)
        n += 1
    for sid, fx in FIX.items():
        s = by_id[sid]
        for ver, pat in fx.get("setPatterns", {}).items():
            s.setdefault("patterns", {})[ver] = pat
        for ver, txt in (fx.get("why") or {}).items():
            s.setdefault("why", {})[ver] = txt
        for ver in (fx.get("dropAbsent") or []):
            (s.get("absent") or {}).pop(ver, None)
            if s.get("absent") is not None and not s["absent"]:
                s.pop("absent")
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("加了 %d 行，总行数 %d" % (n, len(doc["specs"])))

    # 覆盖审计的登记
    tb = json.load(io.open(TABLES, encoding="utf-8"))
    for ver, m in REGISTER.items():
        tb.setdefault(ver, {}).update(m)
    io.open(TABLES, "w", encoding="utf-8", newline="").write(
        json.dumps(tb, ensure_ascii=False, indent=2) + "\n")
    print("登记表加了 %d 条" % sum(len(m) for m in REGISTER.values()))

    # 位图条款号
    bf = json.load(io.open(FIXES, encoding="utf-8"))
    for k, txt in BITMAP.items():
        bf["A"][k] = txt
    # 4.19 的说明原本把 0.15% 的句子算在 4.19 头上 —— 那是 4.20 的内容
    bf["A"]["4.19"] = (
        "GB 4785 草案第 4 章的条款号印在 PDF 左边距，是**位图**，文本层取不到。"
        "本条对应第 4 章的「移动部件」：原文「对于主功能安装在可移动部件上的后位灯、后转向灯、"
        "三角形/非三角形后回复反射器应满足以下要求：灯具在移动部件所有的固定位置上均符合各自的安装位置、"
        "几何可见度、色度和配光性能要求。…」（源 PDF p20）。"
        "条款号由左边距裁剪渲染读出。**注意：0.15% 的倾斜度偏差在下一条 4.20，不在 4.19** —— "
        "左边距上 4.19 之后紧接着就是 4.20。"
    )
    io.open(FIXES, "w", encoding="utf-8", newline="").write(
        json.dumps(bf, ensure_ascii=False, indent=2) + "\n")
    print("位图条款号登记 %d 条" % len(BITMAP))


if __name__ == "__main__":
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没命中，先别写。" % bad)
            sys.exit(1)
        write()
    else:
        sys.exit(1 if selfcheck() else 0)
