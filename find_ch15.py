import pypdf
import re
import unicodedata

r = pypdf.PdfReader("ui-test/render-final.pdf")
full = "".join((p.extract_text() or "") for p in r.pages)
ws = re.sub(r"\s+", "", unicodedata.normalize("NFKC", full))

print("含 风险提示:", "风险提示" in full)
print("含 标准化建议:", "标准化建议" in full)
print("全文 结论 出现次数:", full.count("结论"))
print("ws版含 '15结论':", "15结论" in ws)
print("ws版含 '结论、风险提示与标准化建议':", "结论、风险提示与标准化建议" in ws)

i = ws.find("风险提示")
if i >= 0:
    print("风险提示 上下文:", ws[max(0, i - 50):i + 50])

print("\n最后 3 页:")
n = len(r.pages)
for k in range(n - 3, n):
    t = r.pages[k].extract_text() or ""
    flat = re.sub(r"\s+", " ", t)
    print(f"  p{k+1}: {len(t)} 字 | {flat[:100]}")
