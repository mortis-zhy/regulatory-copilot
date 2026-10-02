#!/usr/bin/env python3
"""Structural audit v2: find systemic issues in the v6.2 report.

Checks:
1. 14 numeric changes — is each verifiably backed by A/B text?
2. 8 new device classes — truly absent in B?
3. 9 GB4785 indicators — are 7 "missing" truly missing? (broad search)
4. Chapter 11 "unchanged" — are there ESS values SAME in A/B that we missed?
5. Sidecar: /report-data full 3-doc mode — currently returns per-doc only; the
   cross-doc diff (14 numeric changes + 24 topics) actually comes from diff-result.json
   which was built from extract-cache (MuPDF text), NOT MinerU text.
"""
import json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main")
m = json.load(open(ROOT / "dist" / "mineru-v4-data.json", encoding="utf-8"))
v = json.load(open(ROOT / "dist" / "verified-comparison.json", encoding="utf-8"))
b_text = m["B"]["fullText"]
a_text = m["A"]["fullText"]

print("=" * 60)
print("A. 14 numeric changes — MinerU-verified?")
print("=" * 60)
# Build the same found-page function (corrected with marker skip + word-boundary)
def find_page(text, needle):
    if not needle: return ""
    is_num = bool(re.fullmatch(r"-?\d+(?:\.\d+)?", needle.strip()))
    spans = [(mm.start(), mm.end()) for mm in re.finditer(r"\[第\d+页\]", text)]
    def inm(p): return any(s <= p < e for s, e in spans)
    if is_num:
        pat = r"(?<![\d.])" + re.escape(needle.strip()) + r"(?![\d])"
        for mm in re.finditer(pat, text):
            if not inm(mm.start()): return f"第{(re.findall(r'\[第(\d+)页\]', text[:mm.start()]) or [0])[-1]}页" if re.findall(r'\[第(\d+)页\]', text[:mm.start()]) else ""
        # fall through to compact
    ct = re.sub(r"\s+", "", text); cn = re.sub(r"\s+", "", needle)
    if is_num:
        for mm in re.finditer(r"(?<![\d.])" + re.escape(cn) + r"(?![\d])", ct):
            if not inm(mm.start()):
                mlist = re.findall(r"\[第(\d+)页\]", ct[:mm.start()])
                return f"第{int(mlist[-1])}页" if mlist else ""
        return ""
    else:
        idx = ct.find(cn)
        while idx >= 0 and inm(idx): idx = ct.find(cn, idx+1)
        if idx < 0: return ""
        mlist = re.findall(r"\[第(\d+)页\]", ct[:idx])
        return f"第{int(mlist[-1])}页" if mlist else ""
    mlist = re.findall(r"\[第(\d+)页\]", text[:idx])
    return f"第{int(mlist[-1])}页" if mlist else ""

def strong_nums(s):
    return sorted(set(re.findall(r"\d+\.\d+|\d{2,}", s or "")), key=len, reverse=True)

issues_A = []
for i, c in enumerate(v["numericChanges"], 1):
    old, new = c.get("oldValue", ""), c.get("newValue", "")
    on, nn = (strong_nums(old)[:1] or [""])[0] if strong_nums(old) else "", (strong_nums(new)[:1] or [""])[0] if strong_nums(new) else ""
    pb = find_page(b_text, on) if on else ""
    pa = find_page(a_text, nn) if nn else ""
    ok_b = bool(on) and pb != ""
    ok_a = bool(nn) and pa != ""
    if not (ok_b and ok_a):
        issues_A.append((i, c["topic"]+"·"+c["name"], old, new, pb, pa, ok_b, ok_a))
        print(f"  ⚠ #{i} {c['topic']}·{c['name']}")
        print(f"      B='{old}' → A='{new}' | bPage={pb} aPage={pa}")

print(f"\n  ✓ verified: {14 - len(issues_A)}/14")

print()
print("=" * 60)
print("B. 8 new device classes — are they truly absent in B?")
print("=" * 60)
for label, marker in [
    ("矩阵式 LED 前照灯", "像素"),
    ("ADS 标志灯", "ADS"),
    ("驾驶员辅助投射功能", "驾驶员辅助投射"),
    ("光信号投射功能", "光信号投射"),
    ("图文交互功能", "图文交互"),
    ("发光徽标", "发光徽标"),
    ("外部状态指示器", "外部状态指示器"),
    ("外部氛围功能", "外部氛围"),
]:
    in_b = b_text.find(marker) >= 0
    in_a = a_text.find(marker) >= 0
    mark = "✓" if (in_a and not in_b) else "✗"
    print(f"  {mark} {label} (marker='{marker}'): A={in_a} B={in_b}")

print()
print("=" * 60)
print("C. 9 GB4785 indicators — broad search (not just our patterns)")
print("=" * 60)
# Also check 2 "kept" rows: ESS 4.0±1.0 Hz, side-marker 3m
# and look at 7 "missing" to confirm truly missing (not our regex too strict)
BROAD = {
    "DRL 光度 (cd)": r"\d{2,4}\s*cd",
    "ESS 闪烁频率 (Hz)": r"\d\.?\d*\s*[±±]\s*1\.?\d*\s*Hz",
    "ESS 光度2 (cd)": r"紧急制动[^。]{0,100}?\d{2,4}\s*cd",
    "DRL 可见度 (°)": r"[±±]\s*\d{1,2}\s*°",
    "侧标志灯间距 (m)": r"侧标志灯[^。]{0,100}?(\d(?:\.\d+)?)\s*m",
    "LED 寿命 (h)": r"寿命[^。]{0,30}?(\d{3,4})\s*h",
    "光通维持率 (%)": r"光通维持率[^。]{0,30}?(\d{1,3})\s*%",
    "预热点灯 (min)": r"预热[^。]{0,30}?(\d{1,3})\s*min",
    "AFS 切换 (s)": r"切换[^。]{0,30}?[≤<]?\s*(\d\.?\d*)\s*s",
}
for name, pat in BROAD.items():
    mb = re.search(pat, b_text, re.IGNORECASE)
    ma = re.search(pat, a_text, re.IGNORECASE)
    bv = mb.group(1) if mb and mb.groups() else (mb.group(0) if mb else None)
    av = ma.group(1) if ma and ma.groups() else (ma.group(0) if ma else None)
    in_b, in_a = bool(bv), bool(av)
    status = "KEPT" if (in_b and in_a and bv == av) else ("MISSING" if (not in_b and not in_a) else "PARTIAL")
    print(f"  [{status:7s}] {name}: B={bv or '—'}  A={av or '—'}")

# Specifically re-check "单边" cases: DRL 140, 侧标志 3
print()
print("  -- Re-check [单边] cases with rich patterns:")
# DRL: A has "最大光强不大于140cd"; does B have any 140 at all?
print(f"    '140' in B: {b_text.count('140')} | in A: {a_text.count('140')}")
print(f"    '3m'   in B: {b_text.count('3m')}  | in A: {a_text.count('3m')}")
# Should A 4.0±1.0 = B 4.0±1.0 (unchanged). Confirm:
ab_4 = re.findall(r"[（(]?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*[）)]?]", a_text)
bb_4 = re.findall(r"[（(]?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*[）)]?]", b_text)
print(f"    A 4.0±1.0 occurrences: {len(ab_4)}  |  B: {len(bb_4)}")

print()
print("=" * 60)
print("D. Structural: where does verified-comparison.json (24 topics) come from?")
print("=" * 60)
# Check source: diff-result.json and verify_claims use extract-cache (MuPDF, not MinerU)
diff = json.load(open(ROOT / "diff-result.json", encoding="utf-8")) if (ROOT / "diff-result.json").exists() else None
if diff:
    n_in_diff = len(diff.get("valueDiffs", []))
    print(f"  diff-result.json valueDiffs: {n_in_diff}  (origin: MuPDF text)")
    print(f"  vs verified-comparison numericChanges: {len(v['numericChanges'])}")
# Check extract-cache vs mineru: is it the SAME text source?
cache_files = list((ROOT / "dist" / "extract-cache").glob("*.json"))
mineru_A_len = len(m["A"]["fullText"])
cache_a = json.load(open(cache_files[0], encoding="utf-8")) if cache_files else {}
cache_a_len = len(cache_a.get("fullText", ""))
print(f"  MinerU A fullText: {mineru_A_len} chars  vs  extract-cache A: {cache_a_len} chars")

print()
print("=" * 60)
print("E. Audit on actual GB4785 chapter 11.4 table 11.6: are 9 'missing' wrong?")
print("=" * 60)
# Re-check that 9 indicators: how many ACTUALLY exist in original?  I'll
# search MinerU text for each indicator's keyword
for key, (label, _u) in zip(BROAD.keys(), [(k,0) for k in BROAD]):
    pass
# Instead use the 9 known indicator labels
labels = [
    ("DRL 最小光度", ["昼间行驶灯", "DRL"]),
    ("ESS 闪烁频率", ["紧急制动信号", "ESS"]),
    ("ESS 光度", ["紧急制动信号"]),
    ("DRL 可见度", ["可见度"]),
    ("侧标志灯间距", ["侧标志灯", "间距"]),
    ("LED 寿命", ["寿命"]),
    ("光通维持率", ["维持率"]),
    ("预热点灯时间", ["预热"]),
    ("AFS 切换时间", ["切换"]),
]
for label, kws in labels:
    found_in_b = all(b_text.find(k) >= 0 for k in kws)
    found_in_a = all(a_text.find(k) >= 0 for k in kws)
    print(f"  {label}: keywords-in-B={found_in_b}, in-A={found_in_a}")