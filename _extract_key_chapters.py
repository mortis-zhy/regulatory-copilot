"""Extract the change-points chapter from REF and GEN PDFs."""
import fitz
from pathlib import Path

REF = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
GEN_DEMO = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\demo\detailed-1790130953.pdf"
GEN_FINAL = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\final\回答PDF.pdf"

def dump_toc_with_pages(label, path):
    doc = fitz.open(path)
    print(f"\n========== {label} | {len(doc)} pages ==========")
    toc = doc.get_toc()
    for lvl, title, page in toc:
        indent = "  " * (lvl - 1)
        print(f"  {indent}[p{page}] {title}")
    doc.close()

# Show REF TOC (only chapters 10-12, the change-points area)
doc = fitz.open(REF)
toc = doc.get_toc()
print("=== REFERENCE REPORT: 变化点相关章节 ===")
for lvl, title, page in toc:
    if any(k in title for k in ["变化", "新增", "删除", "修改", "保留", "差异", "对比", "横向"]):
        if lvl <= 3:
            print(f"  [lvl{lvl}, p{page}] {title}")
doc.close()

# Show GEN_final TOC
print("\n=== GENERATED 回答PDF.pdf: TOC ===")
doc = fitz.open(GEN_FINAL)
toc = doc.get_toc()
if toc:
    for lvl, title, page in toc:
        indent = "  " * (lvl - 1)
        print(f"  {indent}[p{page}] {title}")
else:
    # Dump first page to see structure
    print("  (no TOC) P1 head:")
    print("  ", doc[0].get_text("text")[:600].replace("\n", " | "))
doc.close()