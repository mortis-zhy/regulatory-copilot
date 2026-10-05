"""PDF 数据准确性核实（OCR 空格容错版）。

上一版误报的教训：源 PDF 的 OCR 会把 "0.8m" 写成 "0. 8m"、
把 "5.13.4.1" 写成 "5. 13. 4. 1"。任何按字面串搜索的核对都会假报"找不到"。

正确做法：先去掉所有空格再比对。行内小节号、页码、结论三者分别核对。
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
# 预先压掉所有空白，OCR 的 "0. 8m" / "5. 13. 4" 都能对上
FLAT = {k: ["".join(p.get_text().split()) for p in d] for k, d in DOCS.items()}
NPAGE = {k: len(v) for k, v in FLAT.items()}


def page_contains(ver, page_no, needle):
    if page_no < 1 or page_no > NPAGE[ver]:
        return False
    return "".join(needle.split()) in FLAT[ver][page_no - 1]


rpt = json.loads((ROOT / "comparison_agent-main/reports/last-report.json").read_text(encoding="utf-8"))
md = "\n".join(c.get("markdown", "") for c in rpt["chapters"])

# ═══════════ A. 页码 + 条款号 + 数值 三重回原文 ═══════════
print("=" * 94)
print("A. §11.0 已核验条目 —— 页码 / 条款号 / 数值 三重回原文（OCR 容错）")
print("=" * 94)

rows = []
for line in md.split("\n"):
    if not line.strip().startswith("|"):
        continue
    cs = [c.strip().replace("**", "") for c in line.strip().strip("|").split("|")]
    if len(cs) < 6 or not cs[0].isdigit():
        continue
    if "已核验" not in cs[5]:
        continue
    rows.append((cs[0], cs[1], cs[2], cs[3], cs[4]))

print(f"\n已核验条目: {len(rows)} 条\n")

clause_chk = clause_ok = 0
num_chk = num_ok = 0
bad = []

for no, cat, item, b_side, a_side in rows:
    for ver, side in (("B", b_side), ("A", a_side)):
        pg = re.search(r"第(\d+)页", side)
        if not pg:
            continue
        p = int(pg.group(1))
        if p < 1 or p > NPAGE[ver]:
            bad.append((no, item, ver, "页码越界", p))
            continue

        # 条款号核对
        cl = re.search(r"\b(\d+\.\d+(?:\.\d+)*)", side)
        if cl:
            clause_chk += 1
            if page_contains(ver, p, cl.group(1)):
                clause_ok += 1
            else:
                # 页码不对，条款号可能在对页 —— 记录
                elsewhere = [i + 1 for i, t in enumerate(FLAT[ver])
                             if "".join(cl.group(1).split()) in t]
                bad.append((no, item, ver, f"条款 {cl.group(1)} 不在 p{p}",
                            (elsewhere[:3] if elsewhere else "全文无")))

        # 数值核对（去空格后比对）
        for m in re.finditer(r"(\d+(?:\.\d+)?)(mm|cm|m|cd|Hz|%)", side):
            tok = m.group(0)
            num_chk += 1
            if "".join(tok.split()) in FLAT[ver][p - 1]:
                num_ok += 1
            else:
                bad.append((no, item, ver, f"数值 {tok} 不在 p{p}", ""))

print(f"  条款号核对: {clause_ok}/{clause_chk}")
print(f"  数值核对  : {num_ok}/{num_chk}")
if bad:
    print("\n  ⚠️ 未对上：")
    for no, item, ver, what, extra in bad:
        print(f"    #{no} {item[:24]:26s} {ver}  {what}   {extra}")
else:
    print("\n  ✅ 全部对上")

# ═══════════ B. 抽查 3 条看原文实录 ═══════════
print("\n" + "=" * 94)
print("B. 三条抽样 —— 打印该页原文片段，人工确认")
print("=" * 94)
SAMPLES = [
    ("#06 近光灯倾斜度", "B", 25, "0.8"),
    ("#03 6V 电压", "B", 21, "6.75"),
    ("#01 转向灯熄灭", "B", 33, "1.5"),
]
for label, ver, p, needle in SAMPLES:
    t = FLAT[ver][p - 1]
    i = t.find(needle)
    print(f"\n  {label} → {ver} p{p}")
    if i >= 0:
        print("    …" + t[max(0, i - 130):i + 170] + "…")
    else:
        print("    ✗ 该页找不到", needle)

for d in DOCS.values():
    d.close()