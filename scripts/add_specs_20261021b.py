# -*- coding: utf-8 -*-
"""2026-10-21 补行（第二批）：**附录**里此前从没人扫过的要求。

覆盖审计此前只按条款扫，而 `clause_split.py` 只认「数字.数字」形态的条款号 ——
附录是另一套编号体系，于是**整份附录从没被清点过**。里面住着两条真要求：

1. **随装载变化的近光光束倾斜度安全界限 4 mrad（0.4%倾斜度）**
   （A 附录D.5.5a) / B 附录D.5.5a) / C 附录5.5.1）；
2. **自动切换近光的响应时间**（A 附录C 表C.1 / B 附录H 表H.1 / C 附录13）：
   开启 ≤2s；关闭 >5s 且 ≤300s。
   其中 **B 的自动切换条件只写在附录H 的表里**（正文一个字都没有），
   所以矩阵里 B 列原本是空的。

自检： python scripts/add_specs_20261021b.py --check
写入： python scripts/add_specs_20261021b.py --write
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
        "id": "dippedBeam.tiltChangeUnderLoadMax",
        "name": "近光光束倾斜度·随装载变化的安全界限",
        "family": "几何可见度 / 安装角度",
        "unit": "%",
        "patterns": {
            "A": P(r"安全界限为\s*4\s*mrad\s*[（(]\s*(0\.4)\s*%\s*倾斜度", "D.5.5"),
            "B": P(r"安全界限为\s*4\s*mrad\s*[（(]\s*(0\.4)\s*%\s*倾斜度", "D.5.5"),
            "C": P(r"safety margin of\s*4\s*mrad\s*\(\s*(0\.4)\s*per cent inclination", "Annex 5"),
        },
        "why": {
            "A": "A 附录D.5.5a)（p87）：「若对于所有的装载状况，倾斜度的变化位于一种安全界限为4mrad"
                 "（0.4%倾斜度）的计算限值内（如，位于标出的初始倾斜度与型式检验规定上、下限之间的偏差内），"
                 "则就满足要求。」—— **这条住在附录里**：正文的条款索引看不见附录，"
                 "覆盖审计此前整份附录没扫过。",
            "B": "B 附录D.5.5a)（p73）：「若对于所有的装载状况，倾斜度的变化位于一种安全界限为4mrad"
                 "(0.4%倾斜度)的计算限值内…」",
            "C": "R48 Annex 5 §5.5.1（p131）：「…with a safety margin of 4 mrad (0.4 per cent inclination).」"
                 "—— 矩阵里记的是**百分数**（0.4），原文的 4 mrad 是同一个值的另一种写法"
                 "（附录D.2.1.3：「由于角度小，所以，1%等于 10mrad」）。",
        },
    },
    {
        "id": "dippedBeam.autoSwitchOnTimeMax",
        "name": "近光灯自动开启·响应时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"小于\s*1000\s*lx[\s\S]{0,60}?不大于\s*(2)\s*s", "表C.1"),
            "B": P(r"小于\s*1000\s*lx[\s\S]{0,60}?不大于\s*(2)\s*s", "附录H"),
            "C": P(r"less than\s*1,?000\s*lux[\s\S]{0,90}?no more than\s*(2)\s*seconds", "Annex 13"),
        },
        "why": {
            "A": "A 附录C 表C.1（p84）：「外界环境光｜近光灯｜响应时间：小于1000 lx｜开启｜不大于2s；"
                 "1000 lx至7000 lx｜由制造商确定｜由制造商确定；大于7000 lx｜关闭｜大于5s，不大于300s。」"
                 "—— 这张表是**自动切换近光**的条件表，条款索引看不见附录。",
            "B": "B 附录H 表H.1（p80）：「小于1000lx｜开启｜不大于2s；…」"
                 "—— **B 的自动切换条件只写在附录H 的表里**，正文一个字都没有。",
            "C": "R48 Annex 13（p143）：「less than 1,000 lux | ON | no more than 2 seconds; "
                 "between 1,000 lux and 7,000 lux | at manufacturer's discretion; "
                 "more than 7,000 lux | OFF | more than 5 seconds, but no more than 300 seconds」",
        },
    },
    {
        "id": "dippedBeam.autoSwitchOffDelayMin",
        "name": "近光灯自动关闭·响应时间下限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"大于\s*7000\s*lx[\s\S]{0,60}?大于\s*(5)\s*s", "表C.1"),
            "B": P(r"大于\s*7000\s*lx[\s\S]{0,60}?大于\s*(5)\s*s", "附录H"),
            "C": P(r"more than\s*(5)\s*seconds", "Annex 13"),
        },
        "why": {
            "A": "A 附录C 表C.1（p84）：「大于7000 lx｜关闭｜大于5s，不大于300s。」"
                 "—— 关闭**不得早于** 5s（防止频繁开关）。",
            "B": "B 附录H 表H.1（p80）：「大于7000lx｜关闭｜大于5s,不大于300s。」",
            "C": "R48 Annex 13（p143）：「more than 7,000 lux | OFF | more than 5 seconds, but no more than 300 seconds」"
                 "—— **只锚这半句**：C 全文里「more than 5 seconds」只出现这一次（表里那句），"
                 "锚长了会把引文截断到「more than 7,000 lux」就断，读者在引文里看不到 5 这个数。",
        },
    },
    {
        "id": "dippedBeam.autoSwitchOffTimeMax",
        "name": "近光灯自动关闭·响应时间上限",
        "family": "闪烁频率 / 时间参数",
        "unit": "s",
        "patterns": {
            "A": P(r"不大于\s*(300)\s*s", "表C.1"),
            "B": P(r"不大于\s*(300)\s*s", "附录H"),
            "C": P(r"no more than\s*(300)\s*seconds", "Annex 13"),
        },
        "why": {
            "A": "A 附录C 表C.1（p84）：「大于7000 lx｜关闭｜大于5s，不大于300s。」",
            "B": "B 附录H 表H.1（p80）：「大于7000lx｜关闭｜大于5s,不大于300s。」",
            "C": "R48 Annex 13（p143）：「…but no more than 300 seconds」",
        },
    },
]

# ── 修补 ────────────────────────────────────────────────────────────
FIX = {
    # C 的「more than 5 seconds」：锚太长了会把引文截断到
    # 「more than 7,000 lux」就断，读者在引文里看不到 5 这个数。
    # 全文里「more than 5 seconds」只出现一次（Annex 13 的表里那句），短锚安全。
    "dippedBeam.autoSwitchOffDelayMin": {
        "setPatterns": {
            "C": P(r"more than\s*(5)\s*seconds", "Annex 13"),
        },
        "why": {
            "C": "R48 Annex 13（p143）：「more than 7,000 lux | OFF | more than 5 seconds, but no more than 300 seconds」"
                 "—— **只锚这半句**：C 全文里「more than 5 seconds」只出现这一次（表里那句），"
                 "锚长了会把引文截断到「more than 7,000 lux」就断，读者在引文里看不到 5 这个数。",
        },
    },
    "dippedBeam.autoSwitchEnvLight": {
        "addPatterns": {
            "B": P(r"小于\s*1000\s*lx[\s\S]{0,40}?开启", "附录H"),
        },
        "dropAbsent": ["B"],
        "why": {
            "B": "B 附录H 表H.1（p80）：「外界环境光｜近光灯｜响应时间：小于1000lx｜开启｜不大于2s；"
                 "1000lx~7000lx｜由制造商确定｜由制造商确定；大于7000lx｜关闭｜大于5s,不大于300s。」"
                 "—— **B 的自动切换条件只写在附录里**，正文一个字都没有，所以矩阵里 B 列原本是空的。",
        },
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
                      % (row["id"], ver, r["tag"], r["page"], repr(r["focus"])[:48], r["nums"]))
    doc = json.load(io.open(SPEC, encoding="utf-8"))
    by_id = {s["id"]: s for s in doc["specs"]}
    for sid, fx in FIX.items():
        s = by_id.get(sid)
        if s is None:
            print("  !! 找不到要修的行：%s" % sid)
            bad += 1
            continue
        for ver, pat in list((fx.get("addPatterns") or {}).items()) + list((fx.get("setPatterns") or {}).items()):
            r = tp.run(ver, pat["source"])
            if not r:
                print("  ✗ %-44s %s  没命中" % (sid, ver))
                bad += 1
            else:
                print("  ✓ %-44s %s  %s p%-4s %s → %s"
                      % (sid, ver, r["tag"], r["page"], repr(r["focus"])[:48], r["nums"]))
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
