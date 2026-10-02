"""Deeper investigation: compare our GEN_final against the GB4785 reference structure,
examine PDF text extraction quality, find more concrete errors."""
import fitz
from pathlib import Path
import hashlib

# Files
GEN = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\final\回答PDF.pdf"
REF = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
LATEX = r"C:\Users\zsndz\Desktop\comparison_agent-main\latex_output\main.pdf"
A = r"C:\Users\zsndz\Desktop\comparison_agent-main\2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"
B = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"
C = r"C:\Users\zsndz\Desktop\comparison_agent-main\UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf"

# Check if REF and LATEX are identical
def md5(p):
    return hashlib.md5(Path(p).read_bytes()).hexdigest()

print("REF md5:", md5(REF))
print("LATEX md5:", md5(LATEX))
print("Same?", md5(REF) == md5(LATEX))

# ==================== 1. Compare REF vs GEN structures ====================
print("\n\n========== STRUCTURE COMPARISON ==========")
ref = fitz.open(REF)
gen = fitz.open(GEN)
print(f"REF: {len(ref)} pages")
print(f"GEN: {len(gen)} pages (答 PDF.pdf)")
print(f"Ratio: GEN covers {len(gen)/len(ref)*100:.1f}% of REF's depth")

# REF TOC chapter titles only (lvl 1)
ref_toc = ref.get_toc()
print(f"\nREF has {len(ref_toc)} TOC entries (very detailed)")

print("\n--- REF top-level chapters (lvl 1) ---")
for lvl, title, page in ref_toc:
    if lvl == 1:
        print(f"  [p{page}] {title}")

# GEN table of contents
gen_toc = gen.get_toc()
print(f"\nGEN has {len(gen_toc)} TOC entries")
if not gen_toc:
    print("  (no embedded TOC)")

# ==================== 2. PDF text extraction quality ====================
print("\n\n========== TEXT EXTRACTION QUALITY ==========")
for label, p in [("A 草案", A), ("B 2019", B), ("C UN R48", C)]:
    doc = fitz.open(p)
    # Sample first page
    txt = doc[0].get_text("text")
    # Detect: how many Chinese chars? How many broken clauses with spaces?
    chinese_chars = sum(1 for c in txt if '\u4e00' <= c <= '\u9fff')
    broken_clause_markers = txt.count("5. 3") + txt.count("5. 4") + txt.count("5. 1. 7")
    print(f"\n{label} p1 sample:")
    print(f"  Chinese chars: {chinese_chars}")
    print(f"  Broken clause markers (e.g., '5. 3' with space): {broken_clause_markers}")
    print(f"  First 200 chars: {txt[:200]!r}")
    doc.close()

# ==================== 3. Specific verification of GB4785 page 11 chapter content ====================
print("\n\n========== GB4785 chapter 11 vs our GEN_final chapter 11-equivalent ==========")
print("\n--- GB4785 p106-110 ---")
for p in [105, 106, 107, 108]:
    txt = ref[p].get_text("text")
    print(f"\n[REF p{p+1}] (first 800 chars):")
    print(txt[:800])

print("\n\n--- GEN_final p9-15 (last 7 pages) ---")
for p in range(8, 15):
    if p >= len(gen): continue
    txt = gen[p].get_text("text")
    print(f"\n[GEN p{p+1}] (first 600 chars):")
    print(txt[:600])

ref.close()
gen.close()