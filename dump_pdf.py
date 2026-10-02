import pypdf
r = pypdf.PdfReader("demo/法规对比报告.pdf")
print(f"PDF 页数: {len(r.pages)}")
for i, pg in enumerate(r.pages):
    text = pg.extract_text() or ""
    print(f"\n===== 第 {i+1} 页 ({len(text)} 字符) =====")
    print(text)
