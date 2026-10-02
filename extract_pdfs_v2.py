#!/usr/bin/env python3
"""Extract text from PDFs using PyMuPDF (fitz)."""
import os
import fitz  # PyMuPDF

PDF_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main"
PDFS = {
    "draft": "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "current": "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "unece": "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

OUT_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\extracted"
os.makedirs(OUT_DIR, exist_ok=True)

def extract(path):
    doc = fitz.open(path)
    pages_text = []
    for page_num in range(len(doc)):
        page = doc[page_num]
        text = page.get_text()
        pages_text.append(f"\n========== Page {page_num+1} ==========\n{text}")
    doc.close()
    return pages_text, len(pages_text)

def main():
    for key, name in PDFS.items():
        path = os.path.join(PDF_DIR, name)
        if not os.path.exists(path):
            print(f"NOT FOUND: {name}")
            continue
        print(f"Processing: {name}")
        try:
            pages, n = extract(path)
            out_path = os.path.join(OUT_DIR, f"{key}_full.txt")
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(f"# {name}\n")
                f.write(f"# Total pages: {n}\n")
                f.write("=" * 80 + "\n")
                f.write("\n".join(pages))
            total_chars = sum(len(p) for p in pages)
            print(f"  -> {n} pages, {total_chars} chars, saved to {out_path}")
        except Exception as e:
            print(f"  ERROR: {e}")

if __name__ == '__main__':
    main()