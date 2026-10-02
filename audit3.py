#!/usr/bin/env python3
"""audit v3: cross-check the report against the 3 SOURCE PDFs for:
 (a) FALSE POSITIVES — report says [修改]/[新增] but the two docs are actually
     the same (pure clause renumbering, not substance change)
 (b) MISSES — real substantive changes in the source PDFs that our report omitted
 (c) C-document coverage — is UN R48 actually compared, or just listed?
"""
import json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main")
m = json.load(open(ROOT/"dist"/"mineru-v4-data.json", encoding="utf-8"))
v = json.load(open(ROOT/"dist"/"verified-comparison.json", encoding="utf-8"))
a_text = m["A"]["fullText"]; b_text = m["B"]["fullText"]; c_text = m["C"]["fullText"]

print("="*70)
print("(a) 14 数值变化 — 找误报（纯编号变化被标成 [修改]）")
print("="*70)
for i, ch in enumerate(v["numericChanges"], 1):
    nm = ch.get("name","")
    old = ch.get("oldValue",""); new = ch.get("newValue","")
    # clause-number-only change heuristic: values differ ONLY in a clause number
    # like "5.5规定的" vs "5.6规定的" — substance identical
    def strip_clause(s):
        return re.sub(r'(?:符合|由|按)?\d+(?:\.\d+)*规定的?','',s)
    o = re.sub(r'\s+','',strip_clause(old))
    n = re.sub(r'\s+','',strip_clause(new))
    # also strip pure number-only diffs that are just clause refs
    flag = ""
    if "规定的转向信号灯" in nm or "配备" in nm or "定义" in nm:
        # these topics are often clause-ref changes only
        no_nums_old = re.sub(r'[\d.]+','',o)
        no_nums_new = re.sub(r'[\d.]+','',n)
        if no_nums_old == no_nums_new and o != n:
            flag = " ⚠ 疑似仅编号变化(非实质)"
    print(f"  {i:2d} {ch['topic']}·{nm}"+flag)
    if flag:
        print(f"      B:'{old[:50]}'  A:'{new[:50]}'")

print()
print("="*70)
print("(b) 遗漏检查 — 源文档有但报告没提的重要数值差异")
print("="*70)
# Key numeric facts in the two docs that a careful human would flag:
# 1. 章节数：A 10章 vs B 7章 (report has this)
# 2. 附录数：A A~J=10个 vs B A~I=9个 (check)
# 3. 术语数：A ~42条 vs B ~31条 (check)
# 4. AFS/ADB 相关 (check)
checks = [
    ("章节数", r"第\s*(\d+)\s*章|(\d+)\s*章"),
    ("附录数", r"附录\s*[A-Z]"),
]
for label, pat in checks[:1]:
    # count chapter headings
    a_ch = sorted(set(re.findall(r'^(\d+)\s+[^。\n]{0,20}特殊规定|检验规则|实施日期|范围|规范性|术语|一般要求', a_text, re.M)))
    b_ch = sorted(set(re.findall(r'^(\d+)\s+[^，\n]{0,20}特殊规定|检验规则|实施日期|范围|规范性|术语|一般要求', b_text, re.M)))
    print(f"  A 章节标题: {a_ch}")
    print(f"  B 章节标题: {b_ch}")
# 附录 A~J vs A~I
a_app = sorted(set(re.findall(r'附录\s*([A-Z])\b', a_text)))
b_app = sorted(set(re.findall(r'附录\s*([A-Z])\b', b_text)))
print(f"  A 附录: {a_app}")
print(f"  B 附录: {b_app}")
# 术语数量
a_terms = set(re.findall(r'^(\d+\.\d+)\s+\S', a_text, re.M))
b_terms = set(re.findall(r'^(\d+\.\d+)\s+\S', b_text, re.M))
print(f"  A 术语/子条款编号数: {len(a_terms)}")
print(f"  B 术语/子条款编号数: {len(b_terms)}")

print()
print("="*70)
print("(c) C 文档（UN R48）在三列对照里的实际覆盖")
print("="*70)
# topicColumns: how many have a C entry, and is the C excerpt real English text?
cols = v.get("topicColumns", [])
c_present = 0; c_verified = 0; c_empty = 0
sample_c = []
for row in cols:
    c = row.get("C")
    if c:
        c_present += 1
        if c.get("status") == "verified":
            c_verified += 1
        if c.get("excerpt"):
            sample_c.append((row["topic"], c.get("excerpt","")[:60]))
        else:
            c_empty += 1
print(f"  24 主题中 C 有内容: {c_present}, 已核验: {c_verified}, 空摘录: {c_empty}")
print(f"  C 摘录样本:")
for t, ex in sample_c[:6]:
    print(f"    {t}: {ex}")

print()
print("="*70)
print("(d) 结构性问题：三列对照的 C 摘录来自哪套提取？")
print("="*70)
# topicColumns C excerpt — is it Chinese (wrong language) or English (UN R48)?
eng_samples = 0; chi_samples = 0
for row in cols:
    c = row.get("C")
    if c and c.get("excerpt"):
        if re.search(r'[A-Za-z]{4,}', c["excerpt"]):
            eng_samples += 1
        if re.search(r'[\u4e00-\u9fff]', c["excerpt"]):
            chi_samples += 1
print(f"  C 摘录含英文: {eng_samples}, 含中文: {chi_samples}")