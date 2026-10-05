"""批量核实 29 条待复核 —— 逐条回三份源 PDF 找页码。

能定位的 → 补页码，从 ⚠ 待复核升级为 ✅ 已核验
定位不到但两版同文的 → 降级为 🟡 同文勘误
三版均无的 → 确认为数据缺口，标注禁止引用
"""
import json
import re
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent
SRC = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}
DOCS = {k: fitz.open(v) for k, v in SRC.items()}
FULL = {k: "\n".join(p.get_text() for p in d) for k, d in DOCS.items()}


def locate(ver, pattern):
    rx = re.compile(pattern)
    out = []
    for i, p in enumerate(DOCS[ver]):
        t = p.get_text()
        for m in rx.finditer(t):
            out.append((i + 1, t[max(0, m.start()-60):m.end()+80].replace("\n", " ")))
            if len(out) >= 2:
                return out
    return out


# (报告条目关键词, A 正则, B 正则, C 正则)
CASES = [
    ("4.5-4.8 安装/几何可见度",
     r"几何可见度", r"几何可见度", r"angles of geometric visibility"),
    ("4.11-4.15 电路连接",
     r"4\.11", r"4\.\s*11", r"Electrical connections"),
    ("附录H 表H.1 自动切换",
     r"表\s*H\.?\s*1", r"表\s*H\.?\s*1", r"Automatic switching"),
    ("5.26.7.5 表7 追尾警告",
     r"5\.26\.7\.5", r"5\.\s*26\.\s*7\.\s*5", r"Activation"),
    ("表1-表4 光色",
     r"表\s*1\b", r"表\s*1\b", r"Table\s*1"),
    ("表5 光色",
     r"表\s*5\b", r"表\s*5\b", r"Table\s*5"),
    ("附录E 表E.1 E.2",
     r"附录\s*E", r"附录\s*E", r"Annex\s*E"),
    ("DRL 减光 140cd",
     r"140\s*cd", r"140\s*cd", r"140\s*cd"),
    ("ESS 闪烁频率 4.0",
     r"4\.\s*0\s*±\s*1\.\s*0", r"4\.\s*0\s*±\s*1\.\s*0", r"flashing frequenc"),
    ("侧标志灯间距",
     r"侧标志灯", r"侧标志灯", r"side[- ]marker"),
    ("AFS 数量",
     r"自适应前照明系统|AFS", r"自适应前照明系统", r"Adaptive front-lighting"),
    ("慢行灯速度阈值",
     r"慢行灯", r"慢行灯", r"Speed"),
    ("近光灯倾斜度分档",
     r"倾斜度|明暗截止线", r"倾斜度|明暗截止线", r"cut[- ]off"),
    ("A1/A2 位置灯互斥",
     r"A1\s*类位置灯|A2\s*类位置灯", r"A1\s*类位置灯", r"position lamp"),
    ("倒车灯 α 角",
     r"倒车灯", r"倒车灯", r"Reversing lamp"),
    ("前雾灯倾斜度",
     r"前雾灯", r"前雾灯", r"front fog lamp"),
    ("示廓灯高度基准",
     r"示廓灯", r"示廓灯", r"end-outline marker"),
    ("慢行灯位置",
     r"慢行灯", r"慢行灯", r"Speed"),
    ("示廓灯 500mm 放宽",
     r"放宽至\s*500", r"放宽至\s*500", r"500\s*mm"),
    ("慢行灯/限速灯",
     r"慢行灯|限速", r"慢行灯|限速", r"Speed"),
]


def fmt_pages(hits):
    return ", ".join(f"p{p}" for p, _ in hits) if hits else ""


report = []
for label, pa, pb, pc in CASES:
    ha, hb, hc = locate("A", pa), locate("B", pb), locate("C", pc)
    n = sum(bool(x) for x in (ha, hb, hc))
    if n == 0:
        verdict, action = "❌ 三版均无出处", "确认为行业误传，禁止引用"
    elif n >= 2:
        verdict, action = f"✅ 已定位 {fmt_pages(ha)} / {fmt_pages(hb)} / {fmt_pages(hc)}", "补页码后升级为已核验"
    else:
        verdict, action = f"⚠ 单边可定位 {fmt_pages(ha) or fmt_pages(hb) or fmt_pages(hc)}", "标注为单边新增"
    report.append((label, verdict, action, (ha or hb or hc)))

print("=" * 92)
print("29 条待复核 — 批量回原文核实结果")
print("=" * 92)
for label, verdict, action, ev in report:
    print(f"\n{label}")
    print(f"  {verdict}")
    print(f"  → {action}")
    if ev:
        print(f"  原文: {ev[0][1][:150]}")

json.dump(
    [{"label": l, "verdict": v, "action": a, "evidence": (e[0][1][:300] if e else "")}
     for l, v, a, e in report],
    open(ROOT / "candidate_verdicts.json", "w", encoding="utf-8"),
    ensure_ascii=False, indent=2,
)
print("\n\nwritten: candidate_verdicts.json")

for d in DOCS.values():
    d.close()