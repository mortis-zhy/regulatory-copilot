# -*- coding: utf-8 -*-
"""Diagnose: which PDF the user opened, and what defects remain in each."""
import fitz, re, os, unicodedata

OLD = r"C:/Users/zsndz/Desktop/comparison_agent-main/GB4785_多版本横向对比研究报告.pdf"
NEW = r"C:/Users/zsndz/Desktop/comparison_agent-main/GB4785_V8_final.pdf"

RADICAL_RE = re.compile(r"[⺀-⻿]")   # CJK Radicals Supplement .. Kangxi Radicals tail
RAW_LATEX_RE = re.compile(r"\$\\mathrm|\$\\frac|\$\\leq|\$\\text|\$\\begin")

out = []
for name, p in [("OLD (你打开的)", OLD), ("V8_final (我交付的)", NEW)]:
    if not os.path.exists(p):
        out.append(f"{name}: MISSING"); continue
    doc = fitz.open(p)
    full = "".join(pg.get_text() for pg in doc)
    radicals = RADICAL_RE.findall(full)
    uniq = sorted(set(radicals))
    out.append(f"=== {name} ===")
    out.append(f"  pages={len(doc)}  size={os.path.getsize(p)//1024} KB")
    out.append(f'  raw $-LaTeX blocks (\\$\\mathrm etc.): {len(RAW_LATEX_RE.findall(full))}')
    out.append(f'  bare "mathrm" tokens: {full.count("mathrm")}')
    out.append(f'  snippet "${{\\mathrm}}W_{{12}}$": {"W}}_{12}" in full}')
    out.append(f"  Kangxi/CJK radical chars: {len(radicals)} unique={uniq[:40]}")
    # locate first radical context
    m = RADICAL_RE.search(full)
    if m:
        out.append(f"  first radical ctx: {full[max(0,m.start()-25):m.start()+25]!r}")
    out.append("")

# Also scan the SOURCE markdown for radicals (do they come from data?)
import json
src = r"C:/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main/reports/last-report.json"
d = json.load(open(src, encoding="utf-8"))
blob = json.dumps(d, ensure_ascii=False)
rad = RADICAL_RE.findall(blob)
out.append(f"=== SOURCE last-report.json ===")
out.append(f"  Kangxi radical chars in source: {len(rad)} unique={sorted(set(rad))[:40]}")
m = RADICAL_RE.search(blob)
if m:
    out.append(f"  first ctx: {blob[max(0,m.start()-40):m.start()+40]!r}")
# where do they appear (which chapter)
for ch in d["chapters"]:
    r = RADICAL_RE.findall(ch["markdown"])
    if r:
        out.append(f"  ch{ch['id']} {ch['title']}: {len(r)} radicals, unique={sorted(set(r))[:10]}")
for a in d.get("appendices", []):
    r = RADICAL_RE.findall(a.get("markdown") or "")
    if r:
        out.append(f"  appendix {a['id']}: {len(r)} radicals, unique={sorted(set(r))[:10]}")

# NFKC test: does normalization fix them?
for c in ["⻚", "⾊", "⻋", "⺠"]:
    out.append(f"NFKC({c!r} U+{ord(c):04X}) -> {unicodedata.normalize('NFKC', c)!r}  name={unicodedata.name(c, '?')}")

txt = "\n".join(out)
open(r"C:/Users/zsndz/Desktop/comparison_agent-main/_diag_user.txt", "w", encoding="utf-8").write(txt)
print(txt.encode("ascii", "replace").decode())
