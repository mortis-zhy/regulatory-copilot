"""Quick inspection of the 5 PDFs we care about."""
import fitz, json, os
from pathlib import Path

PDFS = {
    "A_draft":     r"C:\Users\zsndz\Desktop\comparison_agent-main\2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B_current":   r"C:\Users\zsndz\Desktop\comparison_agent-main\GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C_un":        r"C:\Users\zsndz\Desktop\comparison_agent-main\UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
    "REF_approved":r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf",
    "GEN_demo":    r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\demo\detailed-1790130953.pdf",
    "GEN_final":   r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\final\回答PDF.pdf",
}

def page_text(p, n):
    d = p[n]
    return d.get_text("text")

def scan(label, path):
    if not Path(path).exists():
        print(f"--- {label}: NOT FOUND")
        return
    doc = fitz.open(path)
    print(f"--- {label} | {len(doc)} pages | {Path(path).name}")
    # Show TOC
    toc = doc.get_toc()
    if toc:
        print(f"  TOC entries: {len(toc)}")
        for lvl, title, page in toc[:25]:
            indent = "  " * (lvl - 1)
            print(f"  {indent}p{page}: {title[:70]}")
        if len(toc) > 25:
            print(f"  ... +{len(toc)-25} more")
    else:
        print("  (no embedded TOC; extracting first page)")
        print("  P1:", page_text(doc, 0)[:300].replace("\n", " | "))
    doc.close()

for k, v in PDFS.items():
    scan(k, v)