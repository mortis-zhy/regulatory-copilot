"""PDF 充实度核实 —— 不只查"对不对"，查"够不够"。

四个维度：
  A. 覆盖充实度  — 每章有多少可对比条目？C 版深度如何？
  B. 参数密度    — 全文抽出多少个数值？有多少带页码锚点？
  C. 空洞检测    — 哪些章节内容过薄 / 大量"本版未规定"？
  D. 引用完整性  — 已核验条目是否都带页码？是否有裸结论？
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
rpt = json.loads((ROOT / "comparison_agent-main/reports/last-report.json").read_text(encoding="utf-8"))
chapters = rpt["chapters"]
md = "\n".join(c.get("markdown", "") for c in chapters)

print("=" * 96)
print("A. 覆盖充实度 —— 每章的可对比条目密度")
print("=" * 96)
print(f"{'章':<26} {'字数':>7} {'表格行':>7} {'A/B/C卡':>8} {'数值':>6} {'页码锚点':>8}  评级")
print("-" * 96)
thin = []
for ci, ch in enumerate(chapters):
    m = ch.get("markdown", "")
    words = len(m.replace(" ", ""))
    trows = len([l for l in m.split("\n") if l.strip().startswith("|") and not re.match(r"^\|[\s:-]+\|", l.strip())])
    cards = len(re.findall(r"\*\*[ABC][^*]{0,12}\*\*", m))
    nums = len(re.findall(r"\d+(?:\.\d+)?\s*(?:mm|cm|cd|Hz|%|lx|km/h|mm)", m))
    anchors = len(re.findall(r"第\s*\d+\s*页", m))
    # 评级
    score = anchors * 2 + cards + nums + trows
    grade = "● 充实" if score >= 60 else ("◐ 一般" if score >= 25 else "○ 偏薄")
    if score < 25 and words > 200:
        thin.append((ci, ch["title"], words, score))
    print(f"ch{ci} {ch['title'][:24]:<24} {words:>7} {trows:>7} {cards:>8} {nums:>6} {anchors:>8}  {grade}")

print("\n" + "=" * 96)
print("B. 参数密度 —— 全文数值与溯源")
print("=" * 96)
all_nums = re.findall(r"\d+(?:\.\d+)?\s*(?:mm|cm|m|cd|Hz|%|lx|lm|km/h|N|W|V)", md)
all_pages = re.findall(r"第\s*\d+\s*页", md)
all_clause = re.findall(r"\b\d+\.\d+(?:\.\d+)*", md)
print(f"  带单位数值      : {len(all_nums)}")
print(f"  页码锚点        : {len(all_pages)}")
print(f"  条款号引用      : {len(all_clause)}")
print(f"  数值/锚点比     : {len(all_nums)/max(len(all_pages),1):.2f}  (>1 说明多数数值有出处)")

print("\n" + "=" * 96)
print("C. 空洞检测 —— 「本版未规定」/「源数据未提供」占比")
print("=" * 96)
for kw in ["本版未规定", "源数据未提供", "未找到", "未核验", "无对应条款", "未匹配"]:
    n = md.count(kw)
    print(f"  {kw:<14} {n:>4} 处")

# 找出最空的章节
print("\n  内容最薄的章节：")
scored = []
for ci, ch in enumerate(chapters):
    m = ch.get("markdown", "")
    real = len(re.sub(r"[#|\-\s>*`\[\]]", "", m))
    scored.append((real, ci, ch["title"]))
scored.sort()
for real, ci, title in scored[:5]:
    print(f"    ch{ci:<3} {title[:34]:<36} {real:>6} 有效字符")

print("\n" + "=" * 96)
print("D. 引用完整性 —— 已核验条目是否都带页码")
print("=" * 96)
verified_lines = [l for l in md.split("\n")
                  if l.strip().startswith("|") and ("已核验" in l or "✓已核验" in l)]
with_page = sum(1 for l in verified_lines if re.search(r"第\s*\d+\s*页", l))
print(f"  标记已核验的行   : {len(verified_lines)}")
print(f"  其中带页码       : {with_page}")
print(f"  裸结论(无页码)   : {len(verified_lines)-with_page}")
if len(verified_lines) - with_page:
    print("\n  ⚠ 裸结论样本：")
    for l in verified_lines:
        if not re.search(r"第\s*\d+\s*页", l):
            print("    ", l[:130])

print("\n" + "=" * 96)
print("E. C 版深度 —— 声称三版对照的章节，C 覆盖率")
print("=" * 96)
for ci, ch in enumerate(chapters):
    m = ch.get("markdown", "")
    t = ch.get("title", "")
    if not re.search(r"三版|A/B/C|A\|B\|C|三版本", t):
        continue
    blocks = re.findall(r"((?:\|[^\n]*\n){3,})", m)
    tot = filled = 0
    for blk in blocks:
        for line in blk.split("\n")[1:]:
            cs = line.strip().strip("|").split("|")
            if len(cs) >= 4:
                tot += 1
                # 最后一列若是 C，或倒数第 3 列含 UN/C 标记
                tail = cs[-1].strip()
                if tail and tail not in ("—", "-", ""):
                    filled += 1
    pct = round(filled / max(tot, 1) * 100)
    print(f"  ch{ci} {t[:36]:<38} {filled}/{tot} = {pct}%")