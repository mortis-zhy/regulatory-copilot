#!/usr/bin/env python3
"""audit v4: OMMISSION check — does the report MISS real substantive changes?
Also structural completeness: are all 18 core topic areas actually compared?
"""
import json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main")
m = json.load(open(ROOT/"dist"/"mineru-v4-data.json", encoding="utf-8"))
v = json.load(open(ROOT/"dist"/"verified-comparison.json", encoding="utf-8"))
a_text = m["A"]["fullText"]; b_text = m["B"]["fullText"]
a_md = m["A"]["markdown"]; b_md = m["B"]["markdown"]

print("="*70)
print("1. 术语数量对比（B 3.x vs A 3.x 术语定义）")
print("="*70)
def term_count(text, prefix):
    # count terms defined as "N.N 术语名" or "N.N.N 术语名" with a中文 name
    hits = re.findall(rf'^{prefix}\.\d+(?:\.\d+)?\s+([\u4e00-\u9fff][^\n]{{2,40}})', text, re.M)
    return hits
b_terms = term_count(b_text, "3")
a_terms = term_count(a_text, "3")
print(f"  B 术语(~3.x): {len(set(b_terms))} 条")
print(f"  A 术语(~3.x): {len(set(a_terms))} 条")
# sample some A-only terms
b_set = {re.sub(r'\s+','',t) for t in b_terms}
a_set = {re.sub(r'\s+','',t) for t in a_terms}
a_only = a_set - b_set
print(f"  A 独有术语: {len(a_only)} 条")
print(f"    样本: {list(a_only)[:15]}")

print()
print("="*70)
print("2. 规范性引用文件对比（A vs B 引用标准）")
print("="*70)
def refs(text):
    return set(re.findall(r'GB\s*[/\s]?\s*T?\s*\d{4,5}(?:\.\d+)?|GB\s*\d{4,5}(?:\.\d+)?', text))
b_ref = refs(b_text); a_ref = refs(a_text)
print(f"  B 引用标准: {len(b_ref)} 个 → {sorted(b_ref)[:20]}")
print(f"  A 引用标准: {len(a_ref)} 个 → {sorted(a_ref)[:20]}")
a_only_ref = a_ref - b_ref
b_only_ref = b_ref - a_ref
print(f"  A 独有引用: {sorted(a_only_ref)[:15]}")
print(f"  B 独有引用: {sorted(b_only_ref)[:15]}")

print()
print("="*70)
print("3. 报告 11.1 只列了 3 章节级新增 + 8 装置类；有无遗漏的章节结构？")
print("="*70)
# A chapter list vs B
def chapters(text):
    return set(re.findall(r'^(\d+)\s+([\u4e00-\u9fff][^\n]{2,20}(?:特殊规定|检验规则|实施日期|范围|引用|术语|一般要求|型式|判定))', text, re.M))
a_ch = chapters(a_text); b_ch = chapters(b_text)
print(f"  A 章节: {sorted(a_ch)}")
print(f"  B 章节: {sorted(b_ch)}")

print()
print("="*70)
print("4. 报告三列对照覆盖了哪些主题？(18 核心主题 vs 报告里的)")
print("="*70)
REPORT_TOPICS = {row["topic"] for row in v["topicColumns"]}
CORE_18 = ["远光灯","近光灯","前雾灯","转向信号灯","位置灯","制动灯","牌照灯",
           "危险警告信号","倒车灯","昼间行驶灯","慢行灯","回复反射器","示廓灯",
           "安装位置与几何可见度","光度与色度限值","闪烁频率与时间要求",
           "电气与试验条件","术语与定义"]
print(f"  18 核心主题在报告三列对照里: {sum(1 for t in CORE_18 if any(t in rt for rt in REPORT_TOPICS))}/18")
missing_topics = [t for t in CORE_18 if not any(t in rt for rt in REPORT_TOPICS)]
print(f"  缺失主题: {missing_topics}")

print()
print("="*70)
print("5. 光度/色度数据（cd 值）——A vs B 关键数值差异，报告是否捕捉？")
print("="*70)
# find "430 000 cd" or "430000" distant light max intensity
for label, t in [("B", b_text), ("A", a_text)]:
    # 远光最大光强 430000 cd
    for kw in ["430", "2000lm", "2000 lm", "1 000 lx", "1000 lx", "7000"]:
        i = t.find(kw)
        if i >= 0:
            print(f"  {label} '{kw}': {t[i-40:i+60].strip()[:80]}")
            break  # just one sample per doc per kw group
    print()