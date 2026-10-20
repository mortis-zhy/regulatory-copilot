# -*- coding: utf-8 -*-
"""设备归属审计（终版）：条款所属**章**是不是这条参数要的那盏灯。

GB 两版的章标题在**目录**里（A 的正文甚至没有章号，只有「前位灯」三个字），
C 的在正文。章号 → 灯名映射不准，就会把别的灯的数值当成这盏灯的。

例：`sideMarkerLamp.horizontalAngle` 锚在 5.14.5 —— 那是**非三角形后回复反射器**
的几何可见度（30°），而侧标志灯在 5.18.5（45°）。数值整条取错。
"""
import io, json, re

SPEC = "data/parameter-specs.json"
CORP = "dist/mineru-v4-data.json"

d = json.load(io.open(CORP, encoding="utf-8"))
S = json.load(io.open(SPEC, encoding="utf-8"))["specs"]


def toc_chapters(v):
    """GB 两版：目录行 `- 5.9 前位灯.... 40` → {5.9: 前位灯}"""
    out = {}
    for ln in d[v]["fullText"].split("\n"):
        m = re.match(r"^-\s*([56]\.\d+)\s+([^\n.…]{2,26})\s*(?:…|\.|$)", ln)
        if not m:
            continue
        num, title = m.group(1), re.sub(r"\s+", " ", m.group(2)).strip()
        if num not in out and title:
            out[num] = title
    return out


def body_chapters(v):
    """C：正文 `6.18. Side-marker lamps` → {6.18: Side-marker lamps}"""
    out = {}
    for m in re.finditer(r"(?m)^(\d+\.\d+)\.\s+([^\n]{3,40})$", d[v]["fullText"]):
        num, title = m.group(1), m.group(2).strip()
        title = title.split("(")[0].split("（")[0].strip()
        if num not in out and title and not re.match(r"^[\d.]+$", title):
            out[num] = title
    return out


def expected_clause(src):
    m = re.match(r"^(\d+(?:\\\.\d+){2,})", src)
    return m.group(1).replace("\\", "") if m else None


CH = {"A": toc_chapters("A"), "B": toc_chapters("B"), "C": body_chapters("C")}

# 中文设备名 → R48 英文关键词（中英对照表，防止「制动」对不上 "stop lamp"）
SYN = [
    ("前回复反射器", "front retro-reflector"),
    ("后回复反射器", "rear retro-reflector"),
    ("侧回复反射器", "side retro-reflector"),
    ("回复反射器", "retro-reflector"),
    ("反光标识", "conspicuity"),
    ("醒目标志", "conspicuity"),
    ("昼间行驶", "daytime running"),
    ("危险警告", "hazard-warning"),
    ("紧急制动信号", "emergency stop"),
    ("追尾警告", "rear collision"),
    ("侧标志", "side-marker"),
    ("后牌照板", "registration plate"),
    ("牌照灯", "registration plate"),
    ("牌照", "registration plate"),
    ("转向", "direction-indicator"),
    ("制动灯", "stop lamp"),
    ("制动", "stop"),
    ("前雾灯", "front fog lamp"),
    ("雾灯", "fog lamp"),
    ("远光", "main-beam headlamp"),
    ("近光", "dipped-beam headlamp"),
    ("前照灯", "headlamp"),
    ("倒车", "reversing"),
    ("后位", "rear position"),
    ("前位", "front position"),
    ("后雾", "rear fog"),
    ("示廓", "end-outline"),
    ("角灯", "cornering"),
    ("侧转向", "direction-indicator"),
    ("自适应", "adaptive"),
    ("AFS", "adaptive"),
    ("驻车", "parking"),
    ("轮廓标志", "end-outline"),
]


def chapter_device(v, title):
    t = title.lower()
    if v == "C":
        for zh, en in SYN:
            if zh in title:
                continue
        for zh, en in SYN:
            if en in t:
                return zh
        return None
    for zh, en in SYN:
        if zh in title:
            return zh
    return None


def spec_device(name):
    best = None
    for zh, en in SYN:
        if zh in name and (best is None or len(zh) > len(best)):
            best = zh
    return best


print("章号→灯名（A/B 取目录，C 取正文）")
for v in ("A", "B", "C"):
    ks = sorted(CH[v], key=lambda k: [int(x) for x in k.split(".")])
    print("  %s (%d): %s" % (v, len(ks), " | ".join("%s=%s" % (k, CH[v][k]) for k in ks)))
print()

print("=" * 100)
print("设备归属不一致（锚定条款落在别的灯的章里）")
flag = 0
for s in S:
    for v in ("A", "B", "C"):
        p = s.get("patterns", {}).get(v)
        if not p:
            continue
        cl = expected_clause(p["source"])
        if not cl:
            continue
        chap = ".".join(cl.split(".")[:2])
        title = CH[v].get(chap, "")
        if not title:
            continue
        dev = chapter_device(v, title)
        sdev = spec_device(s["name"])
        if not dev or not sdev:
            continue
        if sdev == dev or sdev in dev or dev in sdev:
            continue
        print("  %-42s %s  锚 %-9s → %s 章「%s」  但 spec 问「%s」"
              % (s["id"], v, cl, chap, title, sdev))
        flag += 1
print("  共 %d 条" % flag)
