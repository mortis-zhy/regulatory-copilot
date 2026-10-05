"""核实评审提改的两个技术前提，决定计划怎么排。

问题 1：发光面 / 视表面 / 透光面 是不是真的等价？
        —— 若不等价，就不能"统一术语"，只能加术语表说明对应关系。
问题 2：9 条 GB4785 网传指标，逐条回原文核实能否定位？
        —— 这是 26 条待复核里唯一可批量关闭的一组。
"""
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


def find(ver, pattern, limit=2, ctx=130):
    rx = re.compile(pattern)
    out = []
    for i, p in enumerate(DOCS[ver]):
        t = p.get_text()
        for m in rx.finditer(t):
            out.append((i + 1, t[max(0, m.start() - ctx):m.end() + ctx].replace("\n", " ")))
            if len(out) >= limit:
                return out
    return out


print("=" * 80)
print("问题 1：发光面 / 视表面 / 透光面 是否等价？")
print("=" * 80)
for term in ["发光面", "视表面", "透光面"]:
    print(f"\n【{term}】")
    for ver in ("A", "B"):
        hits = find(ver, rf"{term}\s*(?:refers|是指|：|:)\s*\S", limit=1, ctx=90)
        if not hits:
            hits = find(ver, term, limit=1, ctx=110)
        if hits:
            pg, t = hits[0]
            print(f"  [{ver} p{pg}] {t[:190]}")
        else:
            print(f"  [{ver}] 未找到")

print("\n" + "=" * 80)
print("问题 2：9 条 GB4785 网传指标 — 逐条回三份原文定位")
print("=" * 80)

METRICS = [
    ("DRL 转向冲突减光后最大光强", r"140\s*cd"),
    ("ESS 紧急制动信号闪烁频率", r"闪烁频率|flashing\s+frequen"),
    ("ESS 光度", r"紧急制动信号[^。]{0,60}(?:cd|cd\s)"),
    ("DRL 可见度角度", r"昼间行驶灯[^。]{0,80}(?:可见度|角度)"),
    ("侧标志灯间距", r"侧标志灯[^。]{0,60}(?:间距|距离|3\s*m)"),
    ("LED 寿命", r"寿命|service\s+life"),
    ("光通维持率", r"光通(?:量)?维持|Luminous\s+flux\s+maintenance"),
    ("预热点灯时间", r"预热"),
    ("AFS 切换时间", r"切换时间|(?:switch|changeover)\s+time"),
]

for name, pat in METRICS:
    found = {}
    for ver in ("A", "B", "C"):
        hits = find(ver, pat, limit=1, ctx=70)
        found[ver] = hits[0] if hits else None
    tags = "".join(f"[{v}:p{found[v][0]}]" if found[v] else f"[{v}:✗]" for v in ("A", "B", "C"))
    status = "✅ 三版可定位" if all(found.values()) else (
        "⚠ 部分可定位" if any(found.values()) else "❌ 三版均未定位")
    print(f"\n{name}")
    print(f"  {tags}  {status}")
    for v in ("A", "B"):
        if found[v]:
            print(f"    [{v}] {found[v][1][:160]}")

for d in DOCS.values():
    d.close()