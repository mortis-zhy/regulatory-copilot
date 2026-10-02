#!/usr/bin/env python3
"""Extract text from password-protected PDFs (they have owner password but no user password)."""
import os
import sys
import pikepdf

PDF_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main"
PDFS = {
    "draft": "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "current": "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "unece": "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

OUT_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\extracted"
os.makedirs(OUT_DIR, exist_ok=True)

def extract_text(pdf_path):
    """Extract text from all pages of a PDF."""
    pdf = pikepdf.open(pdf_path)
    all_text = []
    for i, page in enumerate(pdf.pages):
        try:
            # Try to get text content
            text = page.get("/Contents", None)
            if text:
                # Compressed contents
                try:
                    contents = pdf.make_stream(text).read_bytes()
                    all_text.append(f"\n=== Page {i+1} ===\n")
                    all_text.append(contents.decode('utf-8', errors='ignore'))
                except Exception:
                    pass
        except Exception as e:
            all_text.append(f"\n=== Page {i+1} (error: {e}) ===\n")
    return "\n".join(all_text), len(pdf.pages)

def main():
    for key, name in PDFS.items():
        path = os.path.join(PDF_DIR, name)
        if not os.path.exists(path):
            print(f"NOT FOUND: {name}")
            continue
        print(f"Processing: {name}")
        try:
            text, num_pages = extract_text(path)
            out_path = os.path.join(OUT_DIR, f"{key}_raw.txt")
            with open(out_path, 'w', encoding='utf-8') as f:
                f.write(f"# Extracted from {name}\n")
                f.write(f"# Pages: {num_pages}\n")
                f.write("=" * 80 + "\n")
                f.write(text)
            print(f"  -> {num_pages} pages, saved to {out_path}")
        except Exception as e:
            print(f"  ERROR: {e}")

if __name__ == '__main__':
    main()