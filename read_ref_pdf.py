"""
Read the reference PDF (owner-password protected) via pypdf.
Extract full text to analyze structure and content quality.
"""
import pypdf
import sys

path = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
reader = pypdf.PdfReader(path)
print(f"页数: {len(reader.pages)}")

all_text = []
for i, page in enumerate(reader.pages):
    t = page.extract_text() or ""
    all_text.append(t)
    print(f"\n{'='*60}")
    print(f"第 {i+1} 页 ({len(t)} 字符)")
    print(f"{'='*60}")
    print(t[:800] if len(t) > 800 else t)

full = "\n".join(all_text)
print(f"\n总字符: {len(full)}")
with open("ref_pdf_full.txt", "w", encoding="utf-8") as f:
    f.write(full)
print("已保存到 ref_pdf_full.txt")
