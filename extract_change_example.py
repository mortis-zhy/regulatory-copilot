"""Extract the reference report's 变化点总结 chapter as a few-shot format example."""
import re
import unicodedata
import pypdf

path = r"C:\Users\zsndz\Desktop\comparison_agent-main\GB4785_多版本横向对比研究报告.pdf"
VARIANTS = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
            "⽹": "网", "⻘": "青", "⼊": "入", "⽤": "用", "⾒": "见"}

r = pypdf.PdfReader(path)
pages = []
for p in r.pages:
    t = unicodedata.normalize("NFKC", p.extract_text() or "")
    for k, v in VARIANTS.items():
        t = t.replace(k, v)
    pages.append(t)
full = "\n".join(pages)

# Chapter 11 body: front-matter/TOC hits are < 50000; body hit is ~70521.
all_hits = [m.start() for m in re.finditer(r"变化点总结", full)]
print(f"'变化点总结' hits: {all_hits}")
body_hits = [p for p in all_hits if p > 50000 and "变化点总结图" not in full[p:p+12]]
start = body_hits[0] if body_hits else all_hits[-1]
m12 = re.search(r"12[\.\s]*合规影响", full[start + 100:])
end = start + 100 + (m12.start() if m12 else 8000)
body = full[start:end]
print(f"chapter body: {len(body)} chars (start={start})")
print("--- preview ---")
print(body[:4500])
with open(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\change_example.md", "w", encoding="utf-8") as f:
    f.write(body)
print("\nsaved change_example.md")
