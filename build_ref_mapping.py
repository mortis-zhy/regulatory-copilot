"""回原文核实：引用标准的「删除 → 承接」对应关系。

评审指出报告只列了新增8/删除18，没说明删除后由哪项承接。
先回三份源 PDF 确认 A 草案实际引用了哪些，再建立映射。
"""
import re
from pathlib import Path
import fitz

ROOT = Path(__file__).resolve().parent
SRC = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
}
DOCS = {k: fitz.open(v) for k, v in SRC.items()}

REMOVED = ["GB 11554", "GB 15235", "GB 15766.1", "GB 17509", "GB 18099",
           "GB 18408", "GB 18409", "GB 21259", "GB 21260", "GB 23254",
           "GB 23255", "GB 25990", "GB 25991", "GB 4660",
           "ECE R37", "ECE R48", "ECE R99", "ECE R128"]
ADDED = ["GB 45831", "R.E.5", "UN R107", "UN R125", "UN R128",
         "UN R37", "UN R97", "UN R99", "GB/T 30036", "GB/T 30511"]


def ref_page(ver):
    """找规范性引用文件页（通常在目录后 1-2 页）。"""
    for i, p in enumerate(DOCS[ver][:12]):
        t = p.get_text()
        if "规范性引用文件" in t or ("引用标准" in t and len(t) > 1500):
            return i + 1, t
    return None, ""


print("=" * 78)
print("A 草案规范性引用文件 — 全文实际引用清单")
print("=" * 78)
ap, at = ref_page("A")
print(f"（定位到 A p{ap}）\n")

found_a = {}
for std in ADDED + REMOVED:
    key = std.replace(" ", "").replace("ECE", "ECE").upper()
    # 允许 OCR 把 "GB 11554" 写成 "GB11554" / "GB 11554"
    pat = re.escape(std).replace(r"\ ", r"\s*")
    hits = re.findall(pat, at.replace(" ", " "), re.I)
    if hits:
        found_a[std] = len(hits)

print(f"{'标准':<16} {'A 草案引用页':>10}  状态")
for std in ADDED:
    n = found_a.get(std, 0)
    print(f"{std:<16} {n:>10}  {'✓ 在 A 中' if n else '✗ 未找到'}")
print()
for std in REMOVED:
    n = found_a.get(std, 0)
    print(f"{std:<16} {n:>10}  {'⚠ 仍被 A 引用' if n else '确认已移除'}")

# ECE → UN 承接关系核对
print("\n" + "=" * 78)
print("ECE → UN 承接关系核对（A 草案是否用 UN 系列替代 ECE 系列）")
print("=" * 78)
for ece, un in [("ECE R37", "UN R37"), ("ECE R48", "UN R48"),
                ("ECE R99", "UN R99"), ("ECE R128", "UN R128")]:
    e_in = found_a.get(ece, 0)
    u_in = found_a.get(un, 0)
    verdict = "✓ 承接" if (e_in == 0 and u_in > 0) else ("⚠ 两版都有" if e_in and u_in else "✗ 不确定")
    print(f"  {ece} (A引用{e_in}处) → {un} (A引用{u_in}处)   {verdict}")

for d in DOCS.values():
    d.close()