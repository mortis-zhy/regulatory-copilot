import glob
import unicodedata
import pypdf

V = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
     "⽹": "网", "⻘": "青", "⼊": "入", "⽤": "用", "⾒": "见",
     "⾞": "车", "⽣": "生"}

pdf_path = glob.glob("ui-test/*.pdf")[0]
print("PDF:", pdf_path)
r = pypdf.PdfReader(pdf_path)
full = unicodedata.normalize("NFKC", "".join((p.extract_text() or "") for p in r.pages))
for k, v in V.items():
    full = full.replace(k, v)

print("=== 关键内容检查（NFKC 归一） ===")
for key in ["对比", "目录", "引言", "报告导论", "新增", "修改", "保留",
            "附录", "本章小结", "待人工确认", "原文事实", "数据溯源"]:
    mark = "OK" if key in full else "MISSING"
    print(f"  {key}: {mark} (x{full.count(key)})")

print()
print("=== 第1页（封面）===")
print((r.pages[0].extract_text() or "")[:350])

print()
print("=== 第2页（目录）前 300 字 ===")
print((r.pages[1].extract_text() or "")[:300])
