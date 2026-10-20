# -*- coding: utf-8 -*-
"""2026-10-20 条款级覆盖审计查出的一批**真错**，逐条修 spec。

来源：`scripts/coverage_audit.py`（三版条款级覆盖审计）+
`scripts/clause_value_check.py`（取值必须就在它引用的条款里）。

两类错：
- **值错**：条款号看着对，值取自**别的条款**（跨段串扰）；
- **条款错**：值对，但引用的条款号差一级（锚在前一条、值在下一条）。

写法上有一条铁律：**锚在条款号上的正则，取值窗口不得跨过下一个条款**，
所以凡是「锚一条、值在下一条」的旧写法，一律改成锚在值真正所在的那一条。

用法： python scripts/fix_specs_20261020.py
"""
import io, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC = os.path.join(ROOT, "data", "parameter-specs.json")

# ── 修既有行 ────────────────────────────────────────────────────────────
PATCH = {
    # ① 位置灯高度条款差一级：R48 §6.9.4.1 是「横向」、§6.9.4.2 才是「高度」。
    "frontPositionLamp.minHeight": {
        "C": {
            "source": r"6\.9\.4\.2[\s\S]{0,120}?not less than (\d+\s*mm)",
            "why": "**原来锚 6.9.4.1 —— 那是「横向」条款**（400mm / 600mm / 1300mm）。"
                   "R48 §6.9.4 的结构是 6.9.4.1 横向、6.9.4.2 高度（源 PDF p59："
                   "「6.9.4.2. In height: above the ground, not less than 250 mm nor more than 1,500 mm …」）。"
                   "旧正则写的是 `6.9.4.1[\\s\\S]{0,1000}?In height:` —— **锚在前一条、值在下一条**，"
                   "值对、条款错。现在直接锚在 6.9.4.2 上。",
        },
    },
    "frontPositionLamp.maxHeight": {
        "C": {
            "source": r"6\.9\.4\.2[\s\S]{0,120}?nor more than ([\d,]+\s*mm)",
            "why": "同 frontPositionLamp.minHeight：R48 §6.9.4.1 是横向、§6.9.4.2 才是高度，"
                   "旧正则锚在 6.9.4.1 上再往后找「nor more than」，**值对、条款错**。",
        },
    },
    "frontPositionLamp.structureExemptMax": {
        "C": {
            "source": r"6\.9\.4\.2[\s\S]{0,200}?\((\s*2[ ,]100\s*mm)",
            "why": "同前：R48 §6.9.4.2（高度）的括注是「(2,100 mm for O1 and O2 categories of vehicles, "
                   "or if for any other categories of vehicles the shape of the bodywork makes it impossible "
                   "to keep within 1,500 mm)」—— 括注后面没有右括号，正则不能写成 `\\)`。",
        },
    },
    # ② 前回复反射器高度条款同样差一级。
    "frontReflexReflector.minHeight": {
        "C": {
            "source": r"6\.16\.4\.2[\s\S]{0,120}?not less than (250\s*mm)",
            "why": "同前：R48 §6.16.4.1 横向、§6.16.4.2 高度（p69：「6.16.4.2. In height: Above the ground, "
                   "not less than 250 mm nor more than 900 mm …」）。旧正则锚 6.16.4.1，**值对、条款错**。",
        },
    },
    "frontReflexReflector.maxHeight": {
        "C": {
            "source": r"6\.16\.4\.2[\s\S]{0,120}?nor more than (900\s*mm)",
            "why": "同 frontReflexReflector.minHeight：锚从 6.16.4.1 改到 6.16.4.2（高度条款）。",
        },
    },
    "frontReflexReflector.structureExemptMax": {
        "C": {
            "source": r"6\.16\.4\.2[\s\S]{0,200}?(1[ ,]500\s*mm)",
            "why": "同前：结构受限上限 1,500 mm 写在 §6.16.4.2 高度条款的括注里"
                   "（「1,500 mm if the shape of the bodywork makes it impossible to keep within 900 mm or 1200 mm」），"
                   "旧正则锚在 6.16.4.1，**值对、条款错**。",
        },
    },
    # ③ **值错**：前位灯垂直角取成了侧标志灯的 10°。
    "frontPositionLamp.verticalAngle": {
        "C": {
            "source": r"6\.9\.5\.1[\s\S]{0,400}?Vertical angle:\s*(\d+)\s*° above and below",
            "why": "**旧正则取到了侧标志灯的垂直角 —— 值错**。旧写法 `6.9.5.2[\\s\\S]{0,300}?Vertical angle:(\\d+)°`："
                   "R48 §6.18.5（侧标志灯）的正文里有交叉引用「paragraphs 6.9.5.2. and 6.10.5.2. above」，"
                   "正则从那个**引用**出发，300 字符窗口一路走到侧标志灯的「Vertical angle: 10°」，"
                   "把别的灯的角度记到了前位灯头上（报告里 C 列写 10°，而 §6.9.5.1/§6.9.5.2 原文都是 15°）。"
                   "现在锚在 §6.9.5.1（本条款）并要求后面紧跟「above and below」，"
                   "同页的 §6.9.5.2 也是 15°，取到的仍是 15°。",
        },
    },
    # ④ 角灯水平方向角是**区间**（向外 30°~60°），原来只报了 30°。
    "corneringLamp.horizontalAngle": {
        "A": {
            "source": r"5\.5\.5[\s\S]{0,200}?水平方向角β角\s*[:：][^。\n]{0,40}?(\d+\s*[°º]\s*至\s*\d+\s*[°º])",
            "why": "角灯水平方向角是**一个区间**：「水平方向角β角：向外30º至60º」（p37）。"
                   "原来只框了第一个数字 30º，**60º 静默丢失** —— 报告里写「30°」，原文写的是「30°至60°」。"
                   "现在用**一个捕获组把两个值一起框住**（locate() 只读第 1 个组，写两个组 60° 照样丢）。",
        },
        "B": {
            "source": r"5\.20\.5[\s\S]{0,160}?\$\s*\\beta\s*\$\s*角\s*[:：]\s*向外\s*(\d+\s*°\s*至\s*\d+\s*°)",
            "why": "同 A：GB 2019 写「$\\beta$ 角:向外30°至60°」（p49）。"
                   "旧写法是**两个捕获组**（`(\\d+)…(\\d+)`），locate() 只读第 1 个组，60° 丢了。现在合成一组。",
        },
        "C": {
            "source": r"6\.20\.5[\s\S]{0,240}?β\s*=\s*(\d+\s*°\s*to\s*\d+\s*°)\s*outwards",
            "why": "同 A：R48 §6.20.5 写「β = 30° to 60° outwards」。旧写法两个组，60° 丢了。现在合成一组。",
        },
    },
    # ⑤ 自适应远光的环境照度阈值：原来 A/B 的正则不带条款锚，条款号是猜的。
    "adaptiveHighBeam.envLightOff": {
        "A": {
            "source": r"5\.3\.9\.2\.4[\s\S]{0,200}?环境照明大于\s*(7000\s*lx)",
            "why": "旧正则**不带条款锚**（`环境照明大于7000lx…远光灯应关闭`），"
                   "抽取器只能按「就近的条款号」去猜 —— 猜到 5.1.9.2.1（传感器探测范围），"
                   "而真正写着这句话的是 §5.3.9.2.4（AFS 远光自适应，p34：「c) 当环境照明大于7000lx 时，远光灯应关闭。」）。"
                   "**值对、条款错**。现在锚在条款号上。",
        },
        "B": {
            "source": r"5\.22\.9\.3[\s\S]{0,300}?环境照明大于\s*(7000\s*lx)",
            "why": "同 A：真正写着「c) 当环境照明大于7000lx时,自适应远光灯应关闭」的是 §5.22.9.3（p54），"
                   "旧正则没有条款锚，条款号靠猜（猜到了 5.22.9.3 但值来自同一条，条款号这次是对的、纯属侥幸）。"
                   "现在锚在条款号上，不再依赖推断。",
        },
    },
}

# ── 新增行 ──────────────────────────────────────────────────────────────
NEW = [
    {
        "id": "mainBeam.envLightOff",
        "name": "远光灯自动熄灭环境照度阈值",
        "family": "光强 / 照度限值",
        "unit": "lx",
        "patterns": {
            "A": {"source": r"5\.1\.9\.2\.4[\s\S]{0,200}?环境照度超过\s*(7000\s*lx)", "flags": "i"},
            "B": {"source": r"5\.1\.9\.3\.5[\s\S]{0,200}?环境照度超过\s*(7000\s*lx)", "flags": "i"},
            "C": {
                "source": r"ambient lighting conditions exceeds\s*(7,?000\s*lx)",
                "flags": "i",
                "clause": "6.1.9.3.5",
            },
        },
        "why": {
            "A": "A §5.1.9.2.4（p25）：「当环境照度超过7000lx时，远光灯应自动熄灭。」"
                 "—— 远光灯**自动控制**（非自适应）路径的熄灭阈值。与 AFS 的 §5.3.9.2.4 是两条独立条款，"
                 "值相同、条款不同，所以分行记。",
            "B": "B §5.1.9.3.5（p24）：「当环境照度超过7000lx时,远光灯应自动关闭。」",
            "C": "**C 的这条正文跨页**：§6.1.9.3.5 的句子在 p39，而「exceeds 7000 lx」在 **p40**"
                 "（MinerU 与源 PDF 都一样）。locate() 一次只看一页，锚着条款号的正则永远跨不过页码标记 —— "
                 "所以这里按**措辞**锚，条款号写明。C 原文是「7000 lx」（无千分位），"
                 "§6.22.9.4.1.3 才是「7,000 lx」；两处措辞相同，但页序在前的是 §6.1.9.3.5（p40 < p89），"
                 "取到的正是主光那一条。",
        },
    },
]


def main():
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
        for ver, newpat in vers.items():
            s.setdefault("patterns", {})[ver] = newpat
            s.setdefault("why", {})[ver] = newpat["why"]
            n_pat += 1
            print("  改 %s/%s" % (sid, ver))

    for row in NEW:
        if row["id"] in by_id:
            print("!! 已存在，跳过：%s" % row["id"])
            continue
        specs.append(row)
        print("  加 %s" % row["id"])

    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print("改了 %d 个 pattern，加了 %d 行，总行数 %d"
          % (n_pat, len([r for r in NEW if r["id"] not in by_id]), len(specs)))


if __name__ == "__main__":
    main()
