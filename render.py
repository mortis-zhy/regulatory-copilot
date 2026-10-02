"""
Convert the demo PDF to images so we can render it inline.
"""
import pypdf
from pathlib import Path
import sys

pdf_path = Path("demo/法规对比报告.pdf")
out_dir = Path("demo")
out_dir.mkdir(exist_ok=True)

reader = pypdf.PdfReader(str(pdf_path))
print(f"PDF 页数: {len(reader.pages)}")

for i, page in enumerate(reader.pages):
    text = page.extract_text() or ""
    print(f"\n===== 第 {i+1} 页 ({len(text)} 字符) =====")
    print(text)
    print()

# Also render as PNG using pypdfium2 or PyMuPDF
try:
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(str(pdf_path))
    for i in range(len(pdf)):
        page_obj = pdf[i]
        pil_image = page_obj.render(scale=2).to_pil()
        out_path = out_dir / f"page-{i+1}.png"
        pil_image.save(str(out_path))
        print(f"Saved {out_path} ({out_path.stat().st_size/1024:.0f} KB)")
except ImportError:
    try:
        import fitz
        doc = fitz.open(str(pdf_path))
        for i in range(len(doc)):
            page = doc[i]
            pix = page.get_pixmap(dpi=144)
            out_path = out_dir / f"page-{i+1}.png"
            pix.save(str(out_path))
            print(f"Saved {out_path} ({out_path.stat().st_size/1024:.0f} KB)")
    except ImportError:
        print("Neither pypdfium2 nor PyMuPDF available — text dump only")
