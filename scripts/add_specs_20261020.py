# -*- coding: utf-8 -*-
"""2026-10-20 补行：把「三版条款级覆盖审计」查出的真缺口补进参数矩阵。

来源：`scripts/coverage_audit.py` 的「别装置顶替」+「真漏」两档。
每一行都回到源 PDF 逐字核过（取证见 HANDOVER §9.20），并在这里自检：
正则必须在 MinerU 或源 PDF 语料上命中，且取到的数与预期一致。

自检： python scripts/add_specs_20261020.py --check
写入： python scripts/add_specs_20261020.py --write
"""
import importlib.util, io, json, os, re, sys

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


# ══════════════════════════════════════════════════════════════════════
# 补既有行的缺版
# ══════════════════════════════════════════════════════════════════════
PATCH = {
    # ── 前位灯的 12.5cm² 视表面：A/B 之前没取到 ────────────────────
    "frontPositionLamp.minApparentSurface": {
        "A": {
            "source": r"灯具在上述几何可见度角范围内的无障碍观察的视表面应不小于\s*(12\s*\.\s*5\s*(?:cm|㎝))",
            "clause": "5.9.5.2",
            "why": "A §5.9.5.2（p45）：「—— 灯具在上述几何可见度角范围内的无障碍观察的视表面应不小于12.5 ㎝2"
                   "（不包括任何不透光的回复反射器的发光面）。」注意 A 这里用的是**单字符 ㎝（U+339D）**，"
                   "不是 cm²，也不是「cm」+上标 2 —— 正则里两种都要认。",
        },
        "B": {
            "source": r"为保证可见,灯的无障碍观察的视表面应不小于\s*(12\s*\.\s*5\s*cm)",
            "clause": "5.9.5.2",
            "why": "B §5.9.5.2（p38）：「为保证可见,灯的无障碍观察的视表面应不小于12.5cm2…」"
                   "—— B 的 PDF 把数字拆行成「12.」「5cm」「2」，所以中间用 `\\s*` 允许断开。",
        },
    },
    # ── AFS 内缘间距可减小的车宽门槛（1300mm）：A/B 之前没取到 ────────
    "afs.narrowWidthThreshold": {
        "A": {
            "source": r"5\.3\.4\.1[\s\S]{0,700}?小\s*于\s*(1300)\s*mm",
            "why": "A §5.3.4.1 d)（p30）：「对于宽度小于1300mm 的其他类型车辆，该距离可以降至400mm。」"
                   "—— 之前只给 C 取了值（A not-found），等于把「A 也有这条」漏掉了。",
        },
        "B": {
            "source": r"5\.22\.4\.1[\s\S]{0,1000}?小\s*于\s*(1300)\s*mm",
            "why": "B §5.22.4.1 d)（p49）：「对于宽度小\n于1300mm 的其他类型车辆,该距离可以降至400mm。」"
                   "—— GB 2019 把「小于」拆到两行，所以 `小\\s*于` 要允许中间有空白。",
        },
    },
    # ── 前雾灯水平方向角：漏了「向内 10°」 ──────────────────────────
    "frontFogLamp.horizontalAngle": {
        "A": {
            "source": r"5\.4\.5[\s\S]{0,160}?水平方向角\s*β\s*[:：][^。\n]{0,40}?(向外\s*\d+\s*°\s*[，,]\s*向内\s*\d+\s*°)",
            "why": "A §5.4.5（p35）：「水平方向角β：向外45°，向内10°。」原来只取了 45°，"
                   "**向内 10° 静默丢失**。一个捕获组框住两个值（locate() 只读第 1 组，"
                   "所以不能写成两个组）。",
        },
        "B": {
            "source": r"5\.3\.5[\s\S]{0,160}?β\s*角\s*[:：][^。\n]{0,40}?(向外\s*\d+\s*°\s*[，,、]\s*向内\s*\d+\s*°)",
            "why": "B §5.3.5（p28）：「β 角:向外45°、向内10°。」原来只取了 45°，向内 10° 丢了。",
        },
        "C": {
            "source": r"6\.3\.5[\s\S]{0,200}?ß\s*=\s*(\d+\s*°\s*outwards and\s*\d+\s*°\s*inwards)",
            "why": "R48 §6.3.5（p46）：「ß = 45° outwards and 10° inwards.」原来只取了 45°。",
        },
    },
    # ── 倒车灯水平方向角：两只灯时向内 30° ──────────────────────────
    "reversingLamp.horizontalAngle": {
        "A": {
            "source": r"5\.21\.5\.1[\s\S]{0,300}?(向外\s*\d+\s*°\s*[，,]\s*向内\s*\d+\s*°)",
            "why": "A §5.21.5（倒车灯几何可见度，p50）写「β 角:向左、向右均为45°(一只倒车灯),"
                   "向外45°,向内30°(两只倒车灯)。」—— 两只灯时向内角是 **30°**，原来只报了 45°。",
        },
        "B": {
            "source": r"5\.4\.5\.1[\s\S]{0,300}?(向外\s*\d+\s*°\s*[，,]\s*向内\s*\d+\s*°)",
            "why": "B §5.4.5.1（p29）：「β 角:向左、向右均为45°(一只倒车灯),向外45°,向内30°(两只倒车灯)。」"
                   "—— 两只灯时向内 30°，原来漏了。",
        },
        "C": {
            "source": r"6\.4\.5\.1[\s\S]{0,300}?(\d+\s*°\s*outwards and\s*\d+\s*°\s*inwards)",
            "why": "R48 §6.4.5.1（p48）：「β = 45° to right and to left if there is only one device, "
                   "45° outwards and 30° inwards if there are two.」—— 两只时向内 30°，原来漏了。",
        },
    },
    # ── 侧标志灯水平方向角：选装时 45° 可减至 30° ────────────────────
    "sideMarkerLamp.horizontalAngle": {
        "A": {
            "source": r"5\.18\.5[\s\S]{0,400}?(向前和向后各为\s*\d+\s*°[\s\S]{0,60}?减至\s*\d+\s*°)",
            "why": "A §5.18.5（p55）：「水平方向角β：向前和向后各为45°。对于选装侧标志灯的车辆，该角度可减至30°。」"
                   "—— 30° 是**选装侧标志灯时的放宽值**，原来没记。",
        },
        "B": {
            "source": r"5\.18\.5[\s\S]{0,400}?(向前和向后各为\s*\d+\s*°[\s\S]{0,60}?减至\s*\d+\s*°)",
            "why": "B §5.18.5（p46）：「水平方向角:向前和向后各为45°。对于选装侧标志灯的车辆,该角度可减至30°。」",
        },
        "C": {
            "source": r"6\.18\.5[\s\S]{0,600}?(45°\s*to the front and to the rear;[\s\S]{0,200}?reduced to\s*\d+\s*°)",
            "why": "R48 §6.18.5（p72）：「Horizontal angle: 45° to the front and to the rear; however for vehicles "
                   "on which the installation of the side-marker lamps is optional this value can be reduced to 30°.",
        },
    },
}


# ══════════════════════════════════════════════════════════════════════
# 新增行
# ══════════════════════════════════════════════════════════════════════
NEW = [
    # ── 近光灯的几何可见度角：矩阵里**整行缺失** ────────────────────
    {
        "id": "dippedBeam.verticalAngle",
        "name": "近光灯垂直方向角（上/下）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.2\.5[\s\S]{0,140}?垂直方向角\s*α\s*[:：][^。\n]{0,40}?(向上\s*\d+\s*°\s*[，,]\s*向下\s*\d+\s*°)"),
            "B": P(r"5\.2\.5[\s\S]{0,140}?α\s*[:：][^。\n]{0,40}?(向上\s*\d+\s*°\s*[，,]\s*向下\s*\d+\s*°)"),
            "C": P(r"6\.2\.5[\s\S]{0,240}?(α\s*=\s*\d+\s*°\s*upwards and\s*\d+\s*°\s*downwards)"),
        },
        "why": {
            "A": "A §5.2.5（p26）：「垂直方向角α：向上15°，向下10°；」—— **矩阵里原先没有近光灯的几何可见度行**，"
                 "这一整条漏了。",
            "B": "B §5.2.5（p24）：「α:向上15°,向下10°;」",
            "C": "R48 §6.2.5（p40）：「α = 15° upwards and 10° downwards,」",
        },
    },
    {
        "id": "dippedBeam.horizontalAngle",
        "name": "近光灯水平方向角（外/内）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.2\.5[\s\S]{0,200}?水平方向角\s*β\s*[:：][^。\n]{0,40}?(向外\s*\d+\s*°\s*[，,]\s*向内\s*\d+\s*°)"),
            "B": P(r"5\.2\.5[\s\S]{0,200}?β\s*[:：][^。\n]{0,40}?(向外\s*\d+\s*°\s*[，,]\s*向内\s*\d+\s*°)"),
            "C": P(r"6\.2\.5[\s\S]{0,260}?(ß\s*=\s*\d+\s*°\s*outwards and\s*\d+\s*°\s*inwards)"),
        },
        "why": {
            "A": "A §5.2.5（p26）：「水平方向角β：向外45°，向内10°。」",
            "B": "B §5.2.5（p24）：「β:向外45°,向内10°。」",
            "C": "R48 §6.2.5（p40）：「ß = 45° outwards and 10° inwards.」",
        },
    },
    # ── 转向信号灯水平方向角 ─────────────────────────────────────────
    {
        "id": "directionIndicator.horizontalAngle",
        "name": "转向信号灯水平方向角（内/低位减至）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.6\.5\.2[\s\S]{0,400}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "B": P(r"5\.5\.5\.2[\s\S]{0,400}?(向内几何可见度角可由\s*\d+\s*°减至\s*\d+\s*°)"),
            "C": P(r"(inward angle of\s*\d+\s*° may be reduced to\s*\d+\s*°)", "6.5.5.1"),
        },
        "why": {
            "A": "A §5.6.5.2（p40）：「在H 平面下方的向内几何可见度角可由45°减至20°。」—— "
                 "转向灯的**水平角**在 A/B 里写在替代布局条款里（§5.6.5.2 / §5.5.5.2），"
                 "矩阵原先只有垂直角行。",
            "B": "B §5.5.5.2（p32）：「在H 平面下方的向内几何可见度角可由45°减至20°。」",
            "C": "R48 §6.5.5.1（p52）：「the inward angle of 45° may be reduced to 20° under the H plane.」"
                 "（C 的水平角主值在图里，正文里能引到的就是这组 45°/20°）",
        },
    },
    # ── 制动灯 S3/S4 类的角（与 S1/S2 分开） ──────────────────────────
    {
        "id": "stopLamp.horizontalAngleS3S4",
        "name": "S3/S4 类制动灯水平方向角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"对于\s*S3\s*或\s*S4\s*类制动灯\s*[：:]\s*向左、向右各\s*(\d+)\s*°", "5.7.5.2"),
            "B": P(r"5\.7\.5\.1[\s\S]{0,300}?对于S3或S4类制动灯\s*[：:]\s*车辆纵向轴线左、右各\s*(\d+)\s*°"),
            "C": P(r"6\.7\.5[\s\S]{0,900}?For S3 or S4 categories devices:\s*(\d+)\s*° to the left"),
        },
        "why": {
            "A": "A §5.7.5.2（p42）：「对于S3或S4类制动灯：向左、向右各10°。」"
                 "—— S1/S2 的 45° 那一行是另一类灯，两类的角不一样，必须分行记。",
            "B": "B §5.7.5.1（p35）：「对于S3或S4类制动灯:车辆纵向轴线左、右各10°。」",
            "C": "R48 §6.7.5（p57）：「For S3 or S4 categories devices: 10° to the left and to the right…」",
        },
    },
    {
        "id": "stopLamp.verticalAngleS3S4",
        "name": "S3/S4 类制动灯垂直方向角（上/下）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.7\.5\.1[\s\S]{0,300}?对于S3\s*或\s*S4\s*类制动灯\s*[：:]\s*(水平面上\s*\d+\s*°\s*，?\s*下\s*\d+\s*°)"),
            "B": P(r"对于\s*S3\s*或\s*S4\s*类制动灯\s*[：:]\s*(水平面上\s*\d+\s*°\s*[，,]\s*水平面下\s*\d+\s*°)", "5.7.5.2"),
            "C": P(r"6\.7\.5[\s\S]{0,1200}?For S3 or S4 categories devices[\s\S]{0,200}?(\d+\s*°\s*above and\s*\d+\s*°\s*below)"),
        },
        "why": {
            "A": "A §5.7.5.1（p42）：「对于S3 或S4 类制动灯：水平面上10°，下5°。」"
                 "—— S3/S4 的垂直角是**上 10°、下 5°**（不对称），与 S1/S2 的上下各 15° 不同。",
            "B": "B §5.7.5.2（p35）：「对于S3或S4类制动灯:水平面上10°,水平面下5°。」",
            "C": "R48 §6.7.5（p57）：S3/S4 的垂直角原文为「10° above and 5° below the horizontal」。",
        },
    },
    # ── 12.5 cm² 视表面面积（为了保证可见） ──────────────────────────
    {
        "id": "directionIndicator.minApparentSurface",
        "name": "转向信号灯可见性判定的最小视表面",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "A": P(r"5\.6\.5\.2[\s\S]{0,400}?无障碍观察的视表面应不小于\s*(12\s*\.\s*5\s*(?:cm|㎝))"),
            "B": P(r"(12\s*\.\s*5\s*cm)\s*(?:<sup>2</sup>|2)?\s*\(不包括", "5.5.5.2"),
            "C": P(r"at least\s*(12\s*\.\s*5)\s*square centimetres,\s*except for", "6.5.5.2"),
        },
        "why": {
            "A": "A §5.6.5.2 c)（p40）：「除了第5 和第6 类侧转向信号灯外，其他转向灯的在上述几何可见度角范围内"
                 "无障碍观察的视表面应不小于12.5cm2」—— A 的 PDF 把 cm² 的上标 2 拆到下一行，"
                 "所以只抓「12.5cm」就够了。",
            "B": "B §5.5.5.2（p32–33）：「其他灯的无障碍观察的视表面应不小于12.5cm2」"
                 "（B 的数字被拆成「12.」「5cm」「2」三段）。",
            "C": "R48 §6.5.5.2（p53）：「the lamp shall provide an unobstructed view of the apparent surface of "
                 "at least 12.5 square centimetres, except for side direction-indicators of categories 5 and 6.」"
                 "—— C 这里写的是**全称 square centimetres**，不是 cm2。",
        },
    },
    {
        "id": "rearPositionLamp.minApparentSurface",
        "name": "后位灯可见性判定的最小视表面",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "A": P(r"5\.10\.5\.2[\s\S]{0,400}?无障碍观察的视表面应不小于\s*(12\s*\.\s*5\s*(?:cm|㎝))"),
            "B": P(r"5\.10\.5\.2[\s\S]{0,400}?无障碍观察的视表面应不小于\s*(12\s*\.\s*5\s*cm)"),
            "C": P(r"at least\s*(12\s*\.\s*5)\s*square centimetres\.\s*The illuminating", "6.10.5.2"),
        },
        "why": {
            "A": "A §5.10.5.2（p47）：「—— 灯具在上述几何可见度角范围内的无障碍观察的视表面应不小于12.5 ㎝2」。",
            "B": "B §5.10.5.2（p39）：「为保证可见,灯的无障碍观察的视表面应不小于12.5cm2」"
                 "—— B 多一句除外：「对于符合4.29规定的灯具不适用。」",
            "C": "R48 §6.10.5.2（p62）：「at least 12.5 square centimetres.」",
        },
    },
    # ── AFS ─────────────────────────────────────────────────────────
    {
        "id": "afs.symmetricUnitHorizontalGapMax",
        "name": "AFS 对称配置附加发光单元水平距离上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"5\.3\.4\.1[\s\S]{0,600}?水平距离可放宽至\s*(200)\s*mm"),
            "B": P(r"该距离不应超过\s*(200)\s*mm", "5.22.4.1"),
            "C": P(r"horizontal distance may be\s*(200)\s*mm", "6.22.4.1.4"),
        },
        "why": {
            "A": "A §5.3.4.1 b)（p30）：「对于两对均为对称安装的发光单元，同侧相邻发光单元间的水平距离可放宽至200mm」"
                 "—— 前面那句是 140mm（一般值），200mm 是**放宽值**，两个都要在矩阵里。",
            "B": "B §5.22.4.1 b)（p49）：「若附加照明单元为“对称安装的照明单元”,该距离不应超过200mm」",
            "C": "R48 §6.22.4.1.4 脚注 13（p82）：「In case of additional \"two symmetrically placed lighting "
                 "units\" the horizontal distance may be 200 mm」—— 脚注 13 与 6.22.4.1.4 同页，"
                 "所以锚 6.22.4.1.4 不会跨页。",
        },
    },
    {
        "id": "afs.totalIntensityMax",
        "name": "AFS 远光模式同时点亮单元最大发光强度之和",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "A": P(r"5\.3\.9\.2\.6[\s\S]{0,200}?最大发光强度值之和不应超过\s*(430\s*000\s*cd)"),
            "B": P(r"5\.22\.9\.4[\s\S]{0,200}?最大发光强度值之和不应超过\s*(430000\s*cd)"),
        },
        "why": {
            "A": "A §5.3.9.2.6（p35）：「各自适应系统中，远光功能中所有同时点亮的发光单元，最大发光强度值之和"
                 "不应超过430 000cd。」—— 与**远光灯**那一行（§5.1.9.1）是两条独立条款，各记一行。",
            "B": "B §5.22.9.4（p54）：「远光照明或远光模式(若有)中,所有同时开启的照明单元,最大发光强度值之和"
                 "不应超过430000cd。」",
        },
        "absent": {
            "C": "R48 §6.22（AFS）**没有**对应的最大光强总和条款：R48 对远光总光强用的是 §6.1.9.1 的"
                 "「以参考标记为单位的 aggregate maximum intensity 不得超过 100」口径，与 A/B 的 430000 cd "
                 "绝对值口径不同，不可直接比较。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.unitMaxHeight",
        "name": "AFS 各模式发光单元最大安装高度",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": P(r"5\.3\.4\.1[\s\S]{0,700}?不高于\s*(1200)\s*mm"),
        },
        "why": {
            "A": "A §5.3.4.1 c)（p30）：「各自适应模式的发光单元，安装高度均应不低于250mm，不高于1200mm"
                 "（见图2 中的G），对于N3G 类（越野）车辆，可增加到1500mm。」",
        },
        "absent": {
            "B": "B §5.22.4.1 c)（p49）**不自己写数**：「c) 5.22.4.1b)提及的附加照明单元,安装高度不应低于250mm,"
                 "符合5.2.4.2的最大离地高度要求」—— 也就是把上限**指向近光灯的高度条款 §5.2.4.2**。"
                 "本行只记自写数值的版本；B 的实际取值请看「近光灯最大离地高度」那一行。",
            "C": "R48 §6.22.4.1.3（p82）同样不自己写数：「shall be positioned lower than 250 mm nor higher than "
                 "indicated in paragraph 6.2.4.2 of this Regulation」—— 指向近光灯高度条款 §6.2.4.2。"
                 "本行只记自写数值的版本。",
        },
    },
    # ── 光强 / 照度 ────────────────────────────────────────────────
    {
        "id": "dippedBeam.autoSwitchEnvLight",
        "name": "近光灯自动开关的环境照度阈值",
        "family": "光强 / 照度限值",
        "unit": "lx",
        "patterns": {
            "A": P(r"5\.2\.7\.5\.3[\s\S]{0,200}?环境照度大于\s*(1000)\s*lx"),
            "C": P(r"6\.2\.7\.8[\s\S]{0,400}?ambient illuminance is\s*(1\s*,?\s*000)\s*lx"),
        },
        "why": {
            "A": "A §5.2.7.5.3（p29）：「尽管按5.2.7.5 要求，环境照度大于1000lx，但近光灯自动控制系统仍然可以"
                 "根据诸如时间或环境状况…来决定近光灯的点亮和熄灭。」",
            "C": "R48 §6.2.7.8（p44）：「in cases where the ambient illuminance is 1,000 lx or more the "
                 "dipped-beam headlamps may switch ON and OFF automatically…」",
        },
        "absent": {
            "B": "GB 4785-2019 的近光章（§5.2.7）没有这一条 —— 没有「环境照度 ≥ 1000 lx 时允许自动开关」的"
                 "豁免条款，属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "drl.indicatorIntensityRatio",
        "name": "昼间行驶灯相对前转向灯光强的豁免门槛",
        "family": "光强 / 照度限值",
        "unit": "%",
        "patterns": {
            "A": P(r"5\.19\.7\.6[\s\S]{0,500}?大于昼间行驶灯HV\s*点光强的\s*(50)\s*%"),
            "C": P(r"at least\s*(50)\s*%\s*higher than", "6.19.7.6"),
        },
        "why": {
            "A": "A §5.19.7.6（p57）：「若前转向灯在基准轴线方向上（HV 点）的光强，大于昼间行驶灯HV 点光强的"
                 "50%以上，则可不采用以上二种操作。」",
            "C": "R48 §6.19.7.6（p74）：「If the luminous intensity of the front direction-indicator lamp in HV is "
                 "at least 50% higher than the luminous intensity of the daytime running lamp in HV…」"
                 "—— 注意 C 写的是「高出 50%」，A 写的是「大于 50% 以上」，**数值相同、表述不同**。",
        },
        "absent": {
            "B": "B §5.19.7.5（p48）只给了「间距不大于40mm」与「关闭 / 降低发光强度」二选一，"
                 "**没有**这个 50% 的豁免门槛。属版本差异，不是抽取失败。",
        },
    },
    {
        "id": "afs.faultTelltaleIntensityThreshold",
        "name": "AFS 故障指示器开启条件·发光强度下限占比",
        "family": "光强 / 照度限值",
        "unit": "%",
        "patterns": {
            "A": P(r"5\.3\.8\.3[\s\S]{0,700}?配光下限要求的\s*(80)\s*%"),
        },
        "why": {
            "A": "A §5.3.8.3 b)（p33）：「光源的一个或多个发光体不再发光。且导致对应功能的发光强度，"
                 "小于型式试验任何配光下限要求的80%。」",
        },
        "absent": {
            "B": "B §5.22.8.2（p53）只规定「强制安装AFS失效指示器…当探测到AFS控制信号故障或接收到不符合AFS"
                 "规定的信号时,应开启失效指示器」，**没有**任何量化的开启判据。属版本差异，不是抽取失败。",
            "C": "R48 §6.22.8.2（p88）同样只规定失效指示器的触发信号，无量化判据。属版本差异。",
        },
    },
    {
        "id": "afs.faultTelltaleFluxDeviation",
        "name": "AFS 故障指示器开启条件·总光通量偏差",
        "family": "光强 / 照度限值",
        "unit": "%",
        "patterns": {
            "A": P(r"5\.3\.8\.3[\s\S]{0,700}?总光通量偏差大于正常工作状态的\s*(5)\s*%"),
        },
        "why": {
            "A": "A §5.3.8.3 c)（p33）：「光源的一个或多个发光体不再发光。且导致对应功能的总光通量偏差大于"
                 "正常工作状态的5%以上。」—— 与上面的 80% 是**并列的两条可选判据**（制造商任选其一或多项），"
                 "不是 AND 关系，所以分成两行记。",
        },
        "absent": {
            "B": "B §5.22.8.2 无量化判据（见上一行）。属版本差异，不是抽取失败。",
            "C": "R48 §6.22.8.2 无量化判据。属版本差异。",
        },
    },
    # ── 车速 ───────────────────────────────────────────────────────
    {
        "id": "frontPositionLamp.sequentialOnSpeedMax",
        "name": "前位灯顺序点亮点亮完成的车速上限",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": P(r"5\.9\.9\.3[\s\S]{0,200}?车速达到\s*(5)\s*km/h"),
        },
        "why": {
            "A": "A §5.9.9.3（p46）：「车辆上电后，开动前，前位灯首次点亮时，可使用顺序点亮…在车速达到5km/h 前"
                 "或前位灯开启后5 秒内，应完全点亮且保持正常工作状态，直至熄灭。」"
                 "—— 这条只对**前位灯**放开顺序点亮，B/C 两版没有。",
        },
        "absent": {
            "B": "B §5.9.9「其他要求」只有 5.9.9.1、5.9.9.2 两条，**没有**顺序点亮条款。属版本差异。",
            "C": "R48 §6.9.9「Other requirements」只有 6.9.9.1、6.9.9.2 两条，**没有**顺序点亮条款。属版本差异。",
        },
    },
    # ── 驾驶员辅助投射 ─────────────────────────────────────────────
    {
        "id": "das.maxWidth",
        "name": "驾驶员辅助投射宽度上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.1\.10[\s\S]{0,300}?宽度均不应超过\s*(2600)\s*mm"),
            "C": P(r"5\.35\.12\.1[\s\S]{0,400}?shall not be more than\s*(2\s*,?\s*600)\s*mm"),
        },
        "why": {
            "A": "A §6.1.10（p64）：「用于行车预测轨迹的驾驶员辅助投射，可不满足6.1.9 要求，可根据车辆重心的"
                 "预测轨迹进行调整。其宽度不应超过车辆的宽度…任何情况下，宽度均不应超过2600mm。」"
                 "—— 与 §6.1.9 的 1250mm（外缘到对称平面）是两条独立要求。",
            "C": "R48 §5.35.12.1（p36）：「It shall not be wider than the width of the vehicle including any fitted "
                 "accessories and trailer if applicable and, in any case, shall not be more than 2,600 mm.」",
        },
        "absent": {
            "B": "GB 4785-2019 **整本没有**「驾驶员辅助投射」这一功能类别（无投射/投影章节）。"
                 "属版本差异，不是抽取失败。",
        },
    },
    # ── 光信号投射（GB 4785 草案 §6.2 新增） ─────────────────────────
    {
        "id": "lightSignalProjection.indicatorSymbolDistanceMax",
        "name": "转向信号灯投射符号位置距车辆最近距离上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.2\.1\.2[\s\S]{0,300}?最近距离应不大于\s*(700)\s*mm"),
        },
        "why": {
            "A": "A §6.2.1.2（p65）：「转向信号灯投射符号位置应符合图7 的要求。在车辆行驶方向上，投射符号位置"
                 "与车辆的水平方向或垂直方向最近距离应不大于700 mm。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异，不是抽取失败。",
            "C": "R48 §5.35（Driver Assistance Projection）里**没有**转向信号灯投射符号位置要求（§5.35.2 只列"
                 "符号清单并指向 Annex 16）。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.reverseSymbolDistanceMax",
        "name": "倒车灯投射符号位置距车辆最近距离上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"与车辆的最近距离应不大于\s*(1000)\s*mm", "6.2.1.3"),
        },
        "why": {
            "A": "A §6.2.1.3（p65–66）：「倒车灯的投射符号位置应符合图8 的要求。在车辆行驶方向上，投射符号位置"
                 "与车辆的最近距离应不大于1000 mm。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有倒车灯投射符号位置要求。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.reverseFlashFrequency",
        "name": "倒车灯投射功能闪烁频率",
        "family": "闪烁频率 / 时间参数",
        "unit": "次/min",
        "patterns": {
            "A": P(r"6\.2\.2\.2[\s\S]{0,300}?倒车灯的闪烁频率应为\s*[（(]\s*(90\s*±\s*30)\s*[）)]\s*次/min"),
        },
        "why": {
            "A": "A §6.2.2.2（p66）：「转向投射功能和倒车投射功能允许闪烁，转向投射功能的闪烁频率和相位应与"
                 "转向信号灯一致，倒车灯的闪烁频率应为（90±30）次/min。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有光信号投射的闪烁频率条款。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.onSpeedMax",
        "name": "光信号投射功能开启车速上限",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": P(r"6\.2\.2\.3[\s\S]{0,300}?车速高于\s*(30)\s*km/h\s*时，光信号投射功能不应开启"),
        },
        "why": {
            "A": "A §6.2.2.3（p66）：「车速高于30km/h 时，光信号投射功能不应开启。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35.10 的 65/40 km/h 是 **Driver Assistance Projection 自身的车速门槛**"
                 "（对应 A §6.1.8），与光信号投射的 30/35 km/h 不是一回事。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.offSpeedMin",
        "name": "光信号投射符号自动熄灭车速阈值",
        "family": "试验条件 / 路段速度",
        "unit": "km/h",
        "patterns": {
            "A": P(r"6\.2\.2\.3[\s\S]{0,300}?当车速高于\s*(35)\s*km/h\s*时应自动熄灭"),
        },
        "why": {
            "A": "A §6.2.2.3（p66）：「对于已点亮的光信号投射符号，当车速高于35km/h 时应自动熄灭。」"
                 "—— 与同条款的 30km/h（开启上限）是两个不同的阈值，分两行记。",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有这一条。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.unitHeightThreshold",
        "name": "光信号投射照明单元安装高度门槛",
        "family": "安装高度 / 离地距离",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.2\.2\.4[\s\S]{0,300}?安装高度大于\s*(350)\s*mm"),
        },
        "why": {
            "A": "A §6.2.2.4（p66）：「若光信号投射功能照明单元安装高度大于 350mm，则车辆应采取措施防止在"
                 "前后 5000mm，左右侧 3000mm 范围内…出现的其他道路使用者遮挡该投射符号。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有这一条。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.blockingRangeLongitudinal",
        "name": "光信号投射遮挡防护范围（前后）",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.2\.2\.4[\s\S]{0,300}?前后\s*(5000)\s*mm"),
        },
        "why": {
            "A": "A §6.2.2.4（p66）：「…防止在前后 5000mm，左右侧 3000mm 范围内（见图 9），出现的其他道路"
                 "使用者遮挡该投射符号…」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有这一条。属版本差异。",
        },
    },
    {
        "id": "lightSignalProjection.blockingRangeLateral",
        "name": "光信号投射遮挡防护范围（左右）",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.2\.2\.4[\s\S]{0,300}?左右侧\s*(3000)\s*mm"),
        },
        "why": {
            "A": "A §6.2.2.4（p66）：「…前后 5000mm，左右侧 3000mm 范围内…」",
        },
        "absent": {
            "B": "GB 4785-2019 无「光信号投射」这一功能类别。属版本差异。",
            "C": "R48 §5.35 里没有这一条。属版本差异。",
        },
    },
    # ── 图文交互 ───────────────────────────────────────────────────
    {
        "id": "graphicInteraction.elementDistanceMax",
        "name": "图文交互显示元素与主功能发光面距离上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"6\.3\.1\.2[\s\S]{0,300}?距离，不应大于\s*(200)\s*mm"),
        },
        "why": {
            "A": "A §6.3.1.2（p67）：「对于图文交互功能所显示的所有元素或元素组合的发光面，与主功能发光面在"
                 "基准轴线方向上的距离，不应大于200mm。」",
        },
        "absent": {
            "B": "GB 4785-2019 无「图文交互」这一功能类别。属版本差异，不是抽取失败。",
            "C": "R48-09 全文没有图文交互条款（只在定义里有 \"Manufacturer logo\"）。属版本差异。",
        },
    },
    # ── 发光徽标 ───────────────────────────────────────────────────
    {
        "id": "illuminatedEmblem.signalAreaMax",
        "name": "光信号装置发光徽标外接最小凸多边形面积上限",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "A": P(r"6\.4\.1\.3[\s\S]{0,300}?面积不大于\s*(10\s*cm)"),
        },
        "why": {
            "A": "A §6.4.1.3（p67）：「朝前、朝后安装的发光徽标均不应超过2 只。对于基准轴线方向上透光面视表面"
                 "外轮廓外接最小凸多边形面积不大于10cm2 的发光徽标，可不计入上述数量要求。」"
                 "—— §6.4.1.4（侧向徽标）写的是**同一个 10cm2 上限**（「…应不大于10cm2，数量无要求」），"
                 "两处数值一致，所以只记一行，并在 why 里说明侧向那条同值。"
                 "另：§6.4.2.4 的 400cm2 是**照明装置**的发光徽标，已是矩阵里的另一行。",
        },
        "absent": {
            "B": "GB 4785-2019 无「发光徽标」这一功能类别。属版本差异，不是抽取失败。",
            "C": "R48-09 没有发光徽标条款。属版本差异。",
        },
    },
    # ── 传感器探测范围 ─────────────────────────────────────────────
    {
        "id": "sensorDetection.horizontalAngle",
        "name": "远光自动控制传感器水平探测角（左/右）",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "A": P(r"5\.1\.9\.2\.1\.1[\s\S]{0,300}?水平角度\s*[:：]\s*向左\s*(\d+\s*°\s*[，,]\s*向右\s*\d+\s*°)"),
            "B": P(r"5\.1\.9\.3\.1\.1[\s\S]{0,300}?水平角度\s*[:：]\s*向左\s*(\d+\s*°\s*[，,]\s*向右\s*\d+\s*°)"),
            "C": P(r"6\.1\.9\.3\.1\.1\.1[\s\S]{0,300}?Horizontal angles:\s*(\d+\s*°\s*to the left and\s*\d+\s*°\s*to the right)"),
        },
        "why": {
            "A": "A §5.1.9.2.1.1（p25）：「水平角度：向左15°，向右15°。垂直角度：见表6。」"
                 "—— 垂直方向是**分档表**（向上 5°；向下按传感器安装高度 2°/2°~5°/5°），"
                 "不是标量量值，已放进附录 E；这里只记水平角。",
            "B": "B §5.1.9.3.1.1（p23）：「———水平角度:向左15°,向右15°;———垂直角度:见表6。」",
            "C": "R48 §6.1.9.3.1.1.1（p38）：「Horizontal angles: 15° to the left and 15° to the right.」"
                 "—— 三版的水平角与垂直分档表**数值完全一致**。",
        },
    },
    # ── 单灯（多段发光面 / 两只 D 型灯）的通用判据 ──────────────────
    {
        "id": "singleLamp.projectionAreaRatioMin",
        "name": "单灯各段视表面投影面积占外接最小四边形面积下限",
        "family": "灯具本体 / 构造要求",
        "unit": "%",
        "patterns": {
            "A": P(r"外围最小凸多边形面积之和\s*，?\s*不应小于[^。]{0,60}?的\s*(60)\s*%"),
            "B": P(r"投影面积之和不应小于[\s\S]{0,60}?的\s*(60)\s*%", "4.7"),
            "C": P(r"5\.7\.2\.[12][\s\S]{0,900}?not less than\s*(60)\s*per cent"),
        },
        "why": {
            "A": "A §4.7 b)（p14）：「各部分发光面在基准轴线方向上的投影，其外围最小凸多边形面积之和，"
                 "不应小于该功能整体边界在基准轴线方向上投影的外围最小凸多边形面积的60%」"
                 "—— **A 第 4 章的条款号在 PDF 里是位图**（文本层取不到），所以正则按**措辞**锚；"
                 "但 A 正文里有 13 处「4.7」交叉引用（如「符合 4.7 b) 1)要求」），"
                 "所以条款号 4.7 仍可写明并被交付闸门验到。",
            "B": "B §4.7 b)（p14）：「各部分在基准轴线方向上的投影面积之和不应小于该功能边界…的60%」",
            "C": "R48 §5.7.2.1 / §5.7.2.2（p25–26）：「shall occupy not less than 60 per cent of the smallest "
                 "quadrilateral circumscribing the projection…」",
        },
    },
    {
        "id": "singleLamp.adjacentPartGapMax",
        "name": "单灯相邻（相切）部分间距上限",
        "family": "位置 / 间距限值",
        "unit": "mm",
        "patterns": {
            "A": P(r"各灯间距不大于\s*(75)\s*mm|两灯间距不大于\s*(75)\s*mm"),
            "B": P(r"间距不超过\s*(75)\s*mm", "4.7"),
            "C": P(r"5\.7\.2\.[12][\s\S]{0,900}?does not exceed\s*(75)\s*mm|shall not exceed\s*(75)\s*mm"),
        },
        "why": {
            "A": "A §4.7 b) 1)（p14）：「或在基准轴线方向上，各灯间距不大于75 mm。」"
                 "—— 与 60% 是**二选一**判据（满足其一即可）。",
            "B": "B §4.7 b)（p14）：「或在基准轴线方向上，两个相邻/相切的部分间距不超过75mm」",
            "C": "R48 §5.7.2.1 / §5.7.2.2（p25–26）：「the minimum distance between the facing edges … "
                 "shall not exceed 75 mm」",
        },
    },
    # ── C 特有 ─────────────────────────────────────────────────────
    {
        "id": "conspicuityMarking.observationPlaneAngle",
        "name": "醒目标志可见度观察平面向外张开角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "C": P(r"6\.21\.5\.1\.2[\s\S]{0,400}?form an angle of\s*(\d+)\s*° outwards"),
        },
        "why": {
            "C": "R48 §6.21.5.1.2（p80）：「In width, by two vertical planes which form an angle of 4° outwards "
                 "from the vehicle's median longitudinal plane…」—— 约束的是**可见度观察平面**的宽度边界"
                 "（用于判定至少 70% 发光面可见），不是灯本身的可见度角。§6.21.5.2.2（侧向）是同一个 4°。",
        },
        "absent": {
            "A": "A §5.20（醒目标志，条款号为位图，p57）只有一句：「汽车及挂车车身反光标识和车辆尾部标志板的"
                 "安装按GB 11564要求。」—— **没有**自带的观察平面角度要求。属版本差异，不是抽取失败。",
            "B": "B §5.21（p49）同样只转引 GB 23254 / GB 25990，无角度要求。属版本差异。",
        },
    },
    {
        "id": "conspicuityMarking.cornerLineAngle",
        "name": "部分轮廓型醒目标志转角两直线的夹角",
        "family": "几何可见度 / 安装角度",
        "unit": "°",
        "patterns": {
            "C": P(r"6\.21\.7\.2[\s\S]{0,400}?two lines at\s*(\d+)\s*°,\s*to each other"),
        },
        "why": {
            "C": "R48 §6.21.7.2（p81）：「In the case of a partial contour marking, each upper corner shall be "
                 "described by two lines at 90°, to each other and each at least 250 mm in length」"
                 "—— 90° 是转角形状要求，250 mm 是线段长度（另见附录 E）。",
        },
        "absent": {
            "A": "A §5.20 醒目标志章只有一句转引 GB 11564，无此要求。属版本差异。",
            "B": "B §5.21 醒目标志章只有转引 GB 23254 / GB 25990，无此要求。属版本差异。",
        },
    },
    {
        "id": "externalStatusIndicator.areaMax",
        "name": "外部状态指示器视表面面积上限",
        "family": "灯具本体 / 构造要求",
        "unit": "cm²",
        "patterns": {
            "C": P(r"5\.32[\s\S]{0,600}?area of the apparent surface is not larger than\s*(20)\s*cm2"),
        },
        "why": {
            "C": "R48 §5.32（p35）：「One external status indicator for Vehicle Alarm System (VAS), Alarm System (AS) "
                 "and immobilizer is allowed if: (a) The light intensity in any direction does not exceed 0.5 cd; "
                 "(b) The colour of the light emitted is white, red or amber; (c) The area of the apparent surface is "
                 "not larger than 20 cm2.」—— 20 cm² 是**一个**指示器的面积上限；"
                 "同一条还规定「Up to two … provided that the apparent surface does [not exceed 10 cm2]」（每个 10 cm²）。",
        },
        "absent": {
            "A": "A 草案没有「外部状态指示器」这一条款（A §6.3 是「图文交互」，是从属功能类别，不是状态指示器）。"
                 "属版本差异，不是抽取失败。",
            "B": "GB 4785-2019 无外部状态指示器条款。属版本差异。",
        },
    },
    {
        "id": "farBeam.aggregateIntensityMax",
        "name": "远光灯总光强限值（以参考标记为基准的口径）",
        "family": "光强 / 照度限值",
        "unit": "cd",
        "patterns": {
            "C": P(r"6\.1\.9\.1[\s\S]{0,300}?aggregate maximum intensity[^.]{0,80}?shall not exceed\s*(100)"),
        },
        "why": {
            "C": "R48 §6.1.9.1（p37）：「The reference value corresponding to an aggregate maximum intensity of the "
                 "main-beam headlamps which can be switched ON simultaneously shall not exceed 100.」"
                 "—— **口径与 A/B 不同**：R48 给的是「以参考标记为单位」的 100，A/B 给的是绝对值 430000 cd。"
                 "两个数不能直接比，所以单列一行（矩阵里另有一行是 A/B 的 430000 cd 绝对值口径）。",
        },
        "absent": {
            "A": "A §5.1.9.1（p24）用的是**绝对值口径**：「所有可同时点亮的远光灯，其最大发光强度之和应不超过"
                 "430 000 cd」—— 已在「同时点亮远光灯最大发光强度之和」那一行记，本行是 C 专用的另一种口径。",
            "B": "B §5.1.9.1（p23）同样是绝对值口径：「所有可同时开启的远光灯,其最大发光强度之和应不超过430000cd」。",
        },
    },
]


# ══════════════════════════════════════════════════════════════════════
def selfcheck():
    """逐条跑正则：必须在 MinerU 或源 PDF 语料上命中。"""
    bad = 0
    items = []
    for sid, vers in PATCH.items():
        for ver, p in vers.items():
            items.append((sid, ver, p["source"]))
    for row in NEW:
        for ver, p in row["patterns"].items():
            items.append((row["id"], ver, p["source"]))
    for sid, ver, src in items:
        r = tp.run(ver, src)
        if not r:
            print("  ✗ %-42s %s  没命中" % (sid, ver))
            bad += 1
        else:
            print("  ✓ %-42s %s  %s p%-4s %s → %s"
                  % (sid, ver, r["tag"], r["page"], repr(r["focus"])[:56], r["nums"]))
    return bad


# 单位修正：12.5cm² 是**面积**，原来那一行写的是 cm（长度单位）。
UNIT_FIX = {
    "frontPositionLamp.minApparentSurface": "cm²",
}


def write():
    raw = io.open(SPEC, encoding="utf-8").read()
    data = json.loads(raw)
    specs = data["specs"]
    by_id = {s["id"]: s for s in specs}
    n_pat = 0
    for sid, vers in PATCH.items():
        s = by_id.get(sid)
        if not s:
            print("!! 找不到 spec：%s" % sid)
            continue
        for ver, p in vers.items():
            s.setdefault("patterns", {})[ver] = p
            s.setdefault("why", {})[ver] = p["why"]
            n_pat += 1
    for sid, unit in UNIT_FIX.items():
        if sid in by_id:
            by_id[sid]["unit"] = unit
            print("  改单位 %s → %s" % (sid, unit))
    n_new = 0
    for row in NEW:
        if row["id"] in by_id:
            print("!! 已存在，跳过：%s" % row["id"])
            continue
        specs.append(row)
        n_new += 1
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("改了 %d 个 pattern，加了 %d 行，总行数 %d" % (n_pat, n_new, len(specs)))


if __name__ == "__main__":
    if "--check" in sys.argv:
        bad = selfcheck()
        print("—— 未命中 %d 条 ——" % bad)
        sys.exit(1 if bad else 0)
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没命中，先别写。" % bad)
            sys.exit(1)
        write()
    else:
        selfcheck()
