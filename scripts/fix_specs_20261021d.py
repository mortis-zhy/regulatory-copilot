# -*- coding: utf-8 -*-
"""2026-10-21 修一批「**条款号引错**」的取值格（值对、条款错）。

怎么发现的：新增 `scripts/clause_page_check.py` ——
**矩阵引用的条款，必须管得着取值所在的那一页**。710 个取值格逐个核，
报出 9 处对不上；逐条回原文读，结论分成三类：

1. **交叉引用吃掉了条款号（真错，必须改）**
   - `drl.rearPositionOffEnvLight` A：引用 **4.11** —— 可那句写的是
     「后位灯和 **4.11 规定的其他灯具**允许熄灭」，
     **4.11 是交叉引用**（电路连接那条），真出处是 **5.19.7.5**（p57）。
   - `directionIndicator.upwardAngleHighMountExempt` A：引用 **4.8** ——
     原句「（测量方法参照 **4.8 b)**）」，**4.8 是测量方法那条**，
     真出处是 **5.6.5.1**（p40，转向信号灯 垂直方向角）。

2. **引用了父条款（不算错，但可以更准）** —— 父条款是「总条款」，
   细则挂在子条款上，读者按父条款号翻过去要自己再找一层：
   C `dippedBeam.autoOffSpeed` 6.2.7.5 → **6.2.7.5.1(d)**；
   C `electricBike.substituteLamp` 6.1.9.3.1 → **6.1.9.3.1.2(c)**；
   C `endOutlineMarker.minGapToPositionLamp` 6.13 → **6.13.9**；
   C `singleLamp.adjacentPartGapMax` 5.7.2 → **5.7.2.2(b)**；
   C `directionIndicator.inwardAngleLowMountExempt` 6.5 → **6.5.5.1**。

3. **引文取自另一处同句（值一样，条款也对，但引文不在所引条款里）**
   B `directionIndicator.inwardAngleLowMountExempt` 的引文取自
   **5.5.3.1 图2a) 的说明**（p31），而条款号写的是 5.5.5.2（p32）。
   同一句话两处都有，值也一样；把锚点写到条款上，引文就从条款里取了。

另外补一个**空着的格子**：
`drl.rearPositionOffEnvLight` 的 B 列此前是空的、**且没有任何说明** ——
全矩阵 301 行里唯一一个「既没值、也没解释」的格。
GB 4785-2019 确实没有这个阈值：它 5.2.7.6b) 写的是
「昼间行驶灯与4.11 规定的灯具共同操作，作为最低要求，**至少后位灯应开启**」，
即 2019 版**要求后位灯点亮**，根本没有「允许熄灭」这一说 ——
2026 草案新增的宽松条款。这一条是三版对比里很值得给客户看的一处。

跑法： python scripts/fix_specs_20261021d.py [--check] [--write]
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


# ── 只改条款号的（pattern 不动） ───────────────────────────────────
SET_CLAUSE = {
    "drl.rearPositionOffEnvLight": {
        "A": "5.19.7.5",
        "why": {
            "A": "A §5.19.7.5（p57）：「当昼间行驶灯点亮时，后位灯也应点亮，4.11 规定的其他灯具可点亮。"
                 "然而，昼间行驶灯开启时，若环境光大于7000lx（按附录C 规定的条件测量），后位灯和4.11 "
                 "规定的其他灯具允许熄灭，但当此环境光条件消失后，应恢复点亮。」"
                 "—— **条款号必须写死**：句子里有两个「4.11」，都是**交叉引用**"
                 "（电路连接那条），就近取条款号会取到 4.11，而 4.11 里没有 7000lx。",
        },
    },
    "directionIndicator.upwardAngleHighMountExempt": {
        "A": "5.6.5.1",
        "why": {
            "A": "A §5.6.5.1（p40，转向信号灯 垂直方向角）：「若选装灯的离地高度不小于2100㎜"
                 "（测量方法参照4.8 b)），则水平面以上的垂直方向角可由15°减至5°。」"
                 "—— **条款号必须写死**：括号里的「4.8 b)」是**测量方法的交叉引用**，"
                 "就近取条款号会取到 4.8（几何可见度测量方法那条），而 4.8 里没有 15°/5°。",
        },
    },
    "dippedBeam.autoOffSpeed": {
        "C": "6.2.7.5.1",
        "why": {
            "C": "R48 §6.2.7.5.1(d)（p43–44）：「If the vehicle speed does not exceed 15 km/h, the control "
                 "shall be designed in such a way that manual deactivation shall not be possible with less "
                 "than two deliberate actions.」—— 此前写 6.2.7.5（父条款），"
                 "值确实在 6.2.7.5.1 的 (d) 项里，写到子条款读者一步就能看到。",
        },
    },
    "electricBike.substituteLamp": {
        "C": "6.1.9.3.1.2",
        "why": {
            "C": "R48 §6.1.9.3.1.2(c)（p39）：「An oncoming bicycle at a distance extending to at least "
                 "75 m, its illumination represented by a white lamp with a luminous intensity of 150 cd "
                 "with a light emitting area of 10 cm² ± 3 cm²…」—— 此前写 6.1.9.3.1（父条款）。",
        },
    },
    "endOutlineMarker.minGapToPositionLamp": {
        "C": "6.13.9",
        "why": {
            "C": "R48 §6.13.9 Other requirements（p66–67）：「The position of an end-outline marker lamp "
                 "in relation to corresponding position lamp shall be such that the distance between the "
                 "projections … is not less than 200 mm.」—— 此前写 6.13（父条款）。",
        },
    },
    "singleLamp.adjacentPartGapMax": {
        "C": "5.7.2.2",
        "why": {
            "C": "R48 §5.7.2.2(b)（p26）：「the minimum distance between the facing edges of the apparent "
                 "surfaces in the direction of the reference axis of two lamps or two independent retro "
                 "reflectors does not exceed 75 mm when measured perpendicularly to the reference axis.」"
                 "—— 此前写 5.7.2（父条款）。",
        },
    },
    "directionIndicator.inwardAngleLowMountExempt": {
        "C": "6.5.5.1",
        "why": {
            "C": "R48 §6.5.5.1 的图注 (*)（p52）：「For the direction indicator lamps of categories 1, 1a, "
                 "1b, 2a and 2b mounted below 750 mm …, the inward angle of 45° may be reduced to 20° "
                 "under the H plane.」—— 这句挂在 6.5.5.1 的图注上，"
                 "此前写 6.5（章级），读者按 6.5 找不到那句话。",
        },
    },
}

# ── 改 pattern 的（B 的引文要取自所引条款） ─────────────────────────
SET_PATTERNS = {
    "directionIndicator.inwardAngleLowMountExempt": {
        "B": P(r"5\.5\.5\.2[\s\S]{0,400}?1、1a、1b、2a和2b类转向灯[\s\S]{0,200}?"
               r"向内几何可见度角可由\s*45\s*°\s*减至\s*(\$?\s*2\s*0\s*\^\s*\{?\s*\\circ\s*\}?)",
               "5.5.5.2"),
        "A": P(r"5\.6\.5\.2[\s\S]{0,400}?1、1a、1b、2a\s*和\s*2b\s*类转向灯[\s\S]{0,200}?"
               r"向内几何可见度角可由\s*45\s*°\s*减至\s*(20\s*°)",
               "5.6.5.2"),
    },
}

# ── 补 absent（此前既没值、也没解释的空格） ─────────────────────────
SET_ABSENT = {
    "drl.rearPositionOffEnvLight": {
        "B": "GB 4785-2019 **全篇没有**这个阈值 —— 不是抽取失败，是该版确实没这条。"
             "B §5.2.7.6b)（p26）写的是「昼间行驶灯与4.11 规定的灯具共同操作，作为最低要求，"
             "**至少后位灯应开启**」：2019 版**要求**后位灯点亮，"
             "根本不存在「允许熄灭」这一说。「环境光 > 7000lx 时后位灯允许熄灭」是 "
             "**2026 草案新增的宽松条款**（A §4.11e 与 A §5.19.7.5）。"
             "**这一格是三版对比里很值得给客户看的一处：B 比 A 严。**",
    },
}


def selfcheck():
    bad = 0
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    for sid, vers in SET_CLAUSE.items():
        s = by_id.get(sid)
        if s is None:
            print("  !! 找不到行：%s" % sid)
            bad += 1
            continue
        for v, cl in vers.items():
            if v == "why":
                continue
            pat = (s.get("patterns") or {}).get(v)
            if not pat:
                print("  !! %s 没有 %s 的 pattern" % (sid, v))
                bad += 1
                continue
            r = tp.run(v, pat["source"])
            if not r:
                print("  ✗ %-42s %s 没命中" % (sid, v))
                bad += 1
            else:
                print("  ✓ %-42s %s 现pattern仍命中 p%s → %s" % (sid, v, r["page"], r["nums"]))
    for sid, vers in SET_PATTERNS.items():
        s = by_id.get(sid)
        for v, pat in vers.items():
            r = tp.run(v, pat["source"])
            if not r:
                print("  ✗ %-42s %s 新pattern没命中" % (sid, v))
                bad += 1
            else:
                print("  ✓ %-42s %s 新pattern命中 p%s → %s" % (sid, v, r["page"], r["nums"]))
    return bad


def write():
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    n = 0
    for sid, vers in SET_CLAUSE.items():
        s = by_id[sid]
        for v, cl in vers.items():
            if v == "why":
                continue
            s["patterns"][v]["clause"] = cl
            n += 1
        for v, txt in (vers.get("why") or {}).items():
            s.setdefault("why", {})[v] = txt
    for sid, vers in SET_PATTERNS.items():
        s = by_id[sid]
        for v, pat in vers.items():
            s["patterns"][v] = pat
            n += 1
    for sid, vers in SET_ABSENT.items():
        s = by_id[sid]
        for v, txt in vers.items():
            s.setdefault("absent", {})[v] = txt
            n += 1
    io.open(SPEC, "w", encoding="utf-8", newline="").write(
        json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("改了 %d 处，总行数 %d" % (n, len(doc["specs"])))


if __name__ == "__main__":
    if "--write" in sys.argv:
        bad = selfcheck()
        if bad:
            print("有 %d 条没命中，先别写。" % bad)
            sys.exit(1)
        write()
    else:
        sys.exit(1 if selfcheck() else 0)
