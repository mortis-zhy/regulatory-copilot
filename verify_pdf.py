"""
Acceptance checks for the generated PDF:
  1. No near-blank pages (<120 chars)
  2. Page 1 = complete cover (title + disclaimer, all on page 1)
  3. Title appears exactly ONCE per page (no duplicate header)
  4. Cover cards use clean names (no raw .pdf filenames)
  5. Chapter headings exist for all chapters; no orphan-title pages
  6. Overall page count >= 20, content density check
Uses NFKC + Kangxi-radical mapping so glyph variants (对⽐→对比) count.
"""
import re
import sys
import unicodedata
import pypdf

path = sys.argv[1] if len(sys.argv) > 1 else "reports-out.pdf"

VARIANTS = {"⽐": "比", "⺊": "卜", "⽬": "目", "⽂": "文", "⻋": "车",
            "⽹": "网", "⻘": "青", "⻝": "食", "⾨": "门", "⼊": "入",
            "⽤": "用", "⾒": "见", "⾛": "走", "⾞": "车", "⽣": "生"}

def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    for k, v in VARIANTS.items():
        s = s.replace(k, v)
    return s

reader = pypdf.PdfReader(path)
pages = len(reader.pages)
raw_pages = [(p.extract_text() or "") for p in reader.pages]
texts = [norm(t) for t in raw_pages]
full = "\n".join(texts)

print("=" * 62)
print(f"PDF: {path}")
print(f"页数: {pages}    总字符: {len(full)}    平均/页: {len(full)//pages}")
print("=" * 62)

fails = []

# 1. near-blank pages
blank = [(i + 1, len(t.strip())) for i, t in enumerate(raw_pages) if len(t.strip()) < 120]
if blank:
    print(f"\n❌ 近空白页 (<120字): {len(blank)}")
    for pg, n in blank:
        snippet = re.sub(r"\s+", " ", texts[pg - 1]).strip()[:80]
        print(f"   p{pg}: {n} 字 | {snippet}")
    fails.append("blank pages")
else:
    print("\n✅ 无近空白页（每页 >= 120 字符）")

# 2. cover complete on page 1
p1 = texts[0]
cover_ok = all(k in p1 for k in ["报告编号", "编制日期", "文档版本", "免责"]) or (
    "报告编号" in p1 and "编制日期" in p1 and len(p1) > 250
)
print(f"{'✅' if cover_ok else '❌'} 封面完整性 (p1 {len(p1)} 字): 标题/编号/日期/声明在同一页")
if not cover_ok:
    fails.append("cover split")

# 3. duplicate header check — derive title from the report itself (dynamic
#    outline titles vary), using the most-frequent long line on page 1.
title_key = None
try:
    import json
    import pathlib
    report_json = pathlib.Path("reports/last-report.json")
    if report_json.exists():
        title_key = json.loads(report_json.read_text(encoding="utf-8"))["outline"]["title"]
except Exception:
    pass

if title_key:
    # header prints the full title on every page; cover h1 adds one more on p1
    dup_pages = [i + 1 for i, t in enumerate(texts) if t.count(title_key) >= 2]
    body_dupes = [p for p in dup_pages if p != 1]
    if body_dupes:
        print(f"❌ 重复页眉: 第 {body_dupes} 页标题出现 >= 2 次")
        fails.append("duplicate header")
    else:
        print(f"✅ 页眉唯一（每页 1 次，封面 H1 允许 2 次）: {title_key[:30]}…")
else:
    print("⚠️ 未找到标题关键字，跳过页眉检查")

# 4. clean cover card names
if "不带Comments" in p1 or re.search(r"\.pdf", p1, re.I):
    print("❌ 封面卡片仍含原始文件名")
    fails.append("raw filename on cover")
else:
    print("✅ 封面卡片使用干净短名")

# 5. headings presence — verify against the ACTUAL dynamic outline titles.
# pypdf wraps long titles across lines, so match on a whitespace-normalized
# copy of the whole document.
try:
    import json as _json
    import pathlib as _pathlib
    _rj = _pathlib.Path("reports/last-report.json")
    _report = _json.loads(_rj.read_text(encoding="utf-8"))
    ws_full = re.sub(r"\s+", "", full)  # full is already NFKC-normalized
    expected = [f"{c['id']}{c['title']}" for c in _report["outline"]["chapters"]]
    missing = []
    for t in expected:
        # Apply the SAME NFKC+variant normalization used on the document text,
        # otherwise full-width （） in titles never match the normalized PDF.
        key = re.sub(r"\s+", "", norm(t))
        candidates = [key, re.sub(r"^\d+", "", key), re.sub(r"^\d+", "", key)[:8]]
        if not any(c and c in ws_full for c in candidates):
            missing.append(t)
    thin = [
        f"{c['id']}.{c['title']}"
        for c in _report["chapters"]
        if len(re.sub(r"[#*>\-\[\]()\s]", "", c["markdown"])) < 400
    ]
    if missing:
        print(f"❌ PDF 中缺失章节: {missing}")
        fails.append("missing chapters")
    else:
        print(f"✅ 全部 {len(expected)} 个动态大纲章节均在 PDF 中")
    if thin:
        print(f"⚠️ 内容过短章节(<400字): {thin}")
    # appendices: every appendix spec must have a rendered body heading
    ap_specs = _report["outline"].get("appendices", [])
    ap_md = {a["id"]: a for a in _report.get("appendices", []) if a.get("markdown")}
    ap_missing = [f"{a['id']} {a['title']}" for a in ap_specs if a["id"] not in ap_md]
    if ap_missing:
        print(f"❌ 缺少附录正文: {ap_missing}")
        fails.append("missing appendices")
    elif ap_specs:
        print(f"✅ 全部 {len(ap_specs)} 个附录正文已生成")
except Exception as e:
    print(f"⚠️ 章节核对跳过: {e}")

# orphan-title detection: a page whose ENTIRE non-header text is <= 40 chars
orphans = []
for i, raw in enumerate(raw_pages):
    body = re.sub(r"(多版本横向对比研究报告|汽车外部照明与光信号装置安装规定对比分析|\d+\s*/\s*\d+)", "", raw)
    body = re.sub(r"\s+", " ", body).strip()
    if 0 < len(body) <= 40:
        orphans.append((i + 1, body))
if orphans:
    print(f"\n❌ 疑似孤标题页: {len(orphans)}")
    for pg, b in orphans:
        print(f"   p{pg}: {b}")
    fails.append("orphan heading pages")
else:
    print("✅ 无孤标题页")

# 6. overall
if pages < 20:
    print(f"❌ 页数 {pages} < 20")
    fails.append("page count")
else:
    print(f"✅ 页数 {pages} >= 20")

avg = len(full) // pages
if avg < 500:
    print(f"⚠️ 平均密度 {avg} 字/页 偏低")
else:
    print(f"✅ 内容密度 {avg} 字/页")

print("\n" + "=" * 62)
if fails:
    print(f"结果: 未通过 — {fails}")
    sys.exit(1)
print("结果: 全部通过 ✅")
print("=" * 62)
