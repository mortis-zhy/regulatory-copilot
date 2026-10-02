"""Inspect the final 48-page report PDF."""
import re
import unicodedata
import pypdf
import pypdfium2 as pdfium

path = "ui-test/多版本法规横向对比研究报告.pdf"
reader = pypdf.PdfReader(path)
pages = len(reader.pages)
full = "".join((p.extract_text() or "") for p in reader.pages)

print(f"页数: {pages}")
print(f"字符: {len(full)}")

# Normalize Kangxi radical / compatibility variants → standard CJK
def norm(s):
    return unicodedata.normalize("NFKC", s)

# Map common variant radicals produced by PDF font subsetting
variants = {
    "⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文",
    "⻋": "车", "⻋": "车", "⽹": "网", "⻣": "骨",
    "⻘": "青", "⻝": "食", "⾨": "门",
}
fn = norm(full)
for k, v in variants.items():
    fn = fn.replace(k, v)

for key in ["对比", "目录", "附录", "新增", "修改", "保留", "引言", "变化"]:
    print(f"  raw '{key}': {'OK' if key in full else 'no'} | normalized: {'OK' if key in fn else 'no'}")

# Find all section headings to show structure
print("\n=== 章节结构（从文本中提取）===")
headings = re.findall(r"\n(\d{1,2}) ([^\n]{2,30})\n", full)
seen = set()
for num, title in headings:
    k = f"{num} {title}"
    if k not in seen and len(title) < 30:
        seen.add(k)
        print(f"  第{num}章 {title}")

# Render pages: cover, toc, a chapter, an appendix
doc = pdfium.PdfDocument(path)
picks = [0, min(3, pages - 1), min(10, pages - 1), pages - 1]
for i in picks:
    doc[i].render(scale=1.6).to_pil().save(f"final-p{i+1}.png")
    print(f"saved final-p{i+1}.png")
