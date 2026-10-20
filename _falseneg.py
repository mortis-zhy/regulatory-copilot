# -*- coding: utf-8 -*-
"""查「该版无此规定」里有没有**假断言**。

编译期硬闸只拦得住「spec 声称某版没有这条要求，但抽取规则其实匹配上了」；
**拦不住「压根没写规则，所以标成没有」** —— 那正是把「没抽到」写成了「标准没有」。

思路：某版被标成「无此规定」时，它另外两版通常有值。
拿那个值 + 单位去**那一版的原文**里找 —— 找得到，就要人工复核
（误报多：同一个数在别的条款里也常见，值级线索只是线索，不是结论）。

用法： python _falseneg.py
"""
import io, json, re

d = json.load(io.open("reports/last-report.json", encoding="utf-8"))
C = json.load(io.open("dist/mineru-v4-data.json", encoding="utf-8"))


def pages(v):
    ft = C[v]["fullText"]
    parts = re.split(r"\[第(\d+)页\]", ft)
    return [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts), 2)]


def norm(s):
    return str(s).replace(",", "").replace(" ", "")


flag = 0
for r in d["parameterMatrix"]:
    for v in ("A", "B", "C"):
        c = r["cells"][v]
        if c.get("miss") != "not-specified":
            continue
        others = []
        for o in ("A", "B", "C"):
            if o == v:
                continue
            oc = r["cells"][o]
            if oc.get("status") == "verified" and oc.get("nums"):
                others.append((o, oc["nums"], r["unit"]))
        if not others:
            continue
        for o, nums, unit in others:
            if unit not in ("mm", "cm", "cd", "km/h", "Hz", "°", "%", "m"):
                continue
            for n in nums:
                val = norm(n)
                try:
                    f = float(val)
                except ValueError:
                    continue
                if f < 20:
                    continue
                pat = re.compile(r"(?<![\w.])" + re.escape(val) + r"\s*" + re.escape(unit.split("/")[0]), re.I)
                hit = None
                for pg, t in pages(v):
                    m = pat.search(t)
                    if m:
                        hit = (pg, t[max(0, m.start() - 90):m.end() + 30].replace("\n", " | "))
                        break
                if hit:
                    flag += 1
                    print("  %-44s %s  另版 %s=%s%s  →  %s 版原文 p%d 有这个数：%s"
                          % (r["id"], v, o, val, unit, v, hit[0], hit[1][-110:]))
print("可疑的「已核」断言：%d 处（值级线索，**要人工回原文复核**）" % flag)
