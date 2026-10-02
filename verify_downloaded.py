"""Verify the downloaded 回答PDF.pdf directly (no browser needed)."""
import glob
import unicodedata
import pypdf

VARIANTS = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
            "⽹": "网", "⻘": "青", "⼊": "入", "⽤": "用", "⾒": "见"}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    for k, v in VARIANTS.items():
        s = s.replace(k, v)
    return s


paths = sorted(glob.glob("final/*.pdf"))
if not paths:
    print("no pdf found")
    raise SystemExit(1)
path = paths[-1]
r = pypdf.PdfReader(path)
full = norm("".join((p.extract_text() or "") for p in r.pages))

print(f"PDF: {path}")
print(f"页数: {len(r.pages)}")
print(f"字符: {len(full)}")
print()
checks = [
    "一、", "二、", "对比范围", "分析正文",
    "GB 4785", "UN R48", "草案",
    "变化点", "专业参数",
    "新增", "修改", "保留",
    "附录", "小结", "章节",
]
pass_n = 0
for k in checks:
    ok = k in full
    pass_n += ok
    print(f"  {'OK ' if ok else 'MISSING'} {k} (x{full.count(k)})")
print(f"\n通过 {pass_n}/{len(checks)}")

# page length distribution (blank-page check)
counts = [len((p.extract_text() or '').strip()) for p in r.pages]
blanks = [i + 1 for i, n in enumerate(counts) if n < 120]
print(f"\n每页字数: min={min(counts)}, max={max(counts)}, avg={sum(counts)//len(counts)}")
print(f"近空白页: {blanks if blanks else '无 ✅'}")
