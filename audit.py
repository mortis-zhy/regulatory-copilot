#!/usr/bin/env python3
"""Audit: re-verify every printed claim in the report against MinerU source."""
import json, re, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = "/Users/zsndz/Desktop/comparison_agent-main/comparison_agent-main" if False else r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main"

mineru = json.load(open(ROOT + r"/dist/mineru-v4-data.json", encoding="utf-8"))
v    = json.load(open(ROOT + r"/dist/verified-comparison.json", encoding="utf-8"))

def find_page(text, needle, exclude_marker=True):
    if not needle: return ""
    is_num = bool(re.fullmatch(r"-?\d+(?:\.\d+)?", needle.strip()))
    spans = [(m.start(), m.end()) for m in re.finditer(r"\[第\d+页\]", text)]
    def inm(p): return any(s <= p < e for s, e in spans)
    if is_num:
        pat = r"(?<![\d.])" + re.escape(needle.strip()) + r"(?![\d])"
        idx = -1
        for mm in re.finditer(pat, text):
            if not inm(mm.start()): idx = mm.start(); break
    else:
        idx = text.find(needle)
        while idx >= 0 and inm(idx): idx = text.find(needle, idx+1)
    if idx < 0:
        # fallback
        ct = re.sub(r"\s+", "", text)
        cn = re.sub(r"\s+", "", needle)
        if is_num:
            for mm in re.finditer(r"(?<![\d.])" + re.escape(cn) + r"(?![\d])", ct):
                if not inm(mm.start()): idx = mm.start(); break
        else:
            idx = ct.find(cn)
            while idx >= 0 and inm(idx): idx = ct.find(cn, idx+1)
        if idx < 0: return ""
        mm = re.findall(r"\[第(\d+)页\]", ct[:idx])
        return f"第{int(mm[-1])}页" if mm else ""
    mm = re.findall(r"\[第(\d+)页\]", text[:idx])
    return f"第{int(mm[-1])}页" if mm else ""

def strong_nums(s):
    toks = re.findall(r"\d+\.\d+|\d{2,}", s or "")
    return sorted(set(toks), key=len, reverse=True)

# ───── A: 14 numeric changes — re-verify each ─────
print("=" * 60)
print("A. 14 数值变化逐条核验")
print("=" * 60)
b_text, a_text = mineru["B"]["fullText"], mineru["A"]["fullText"]

issues_A = []
for i, v in enumerate(v["numericChanges"], 1):
    old, new = v["oldValue"], v["newValue"]
    # oldValue/newValue are like "1200mm" or "1s~1.5s"; pick a strong num from each
    on, nn = strong_nums(old)[0] if strong_nums(old) else "", strong_nums(new)[0] if strong_nums(new) else ""
    pb = find_page(b_text, on) if on else ""
    pa = find_page(a_text, nn) if nn else ""
    ok_b = bool(on) and pb != ""
    ok_a = bool(nn) and pa != ""
    mark = "✓" if (ok_b and ok_a) else ("⚠" if v["status"] != "verified" else "✗")
    issues_A.append((i, v["topic"] + "·" + v["name"], old, new, pb, pa, ok_b, ok_a, mark))
    print(f"  {mark} {i:2d} {v['topic']}·{v['name'][:18]}")
    print(f"      B='{old}' @ {pb}  A='{new}' @ {pa}  locate_ok=({ok_b},{ok_a})")

# ───── B: 8 new device classes — are they really absent in B? ─────
print()
print("=" * 60)
print("B. 8 新装置类是否真在 B 中不存在")
print("=" * 60)
# From extract cache v3 — deviceClassesAsChapterChanges filters to A-only
# Check each by re-searching the topic in B
new_devices_check = {
    "矩阵式 LED 前照灯（像素光源）": "像素",
    "ADS 标志灯（自动化驾驶标志灯）": "ADS",
    "驾驶员辅助投射功能": "驾驶员辅助投射",
    "光信号投射功能": "光信号投射",
    "图文交互功能": "图文交互",
    "发光徽标": "发光徽标",
    "外部状态指示器": "外部状态指示器",
    "外部氛围功能": "外部氛围",
}
issues_B = []
for name, marker in new_devices_check.items():
    in_b = bool(b_text.find(marker) >= 0)
    issues_B.append((name, marker, in_b))
    mark = "✓" if not in_b else "✗ B also has it"
    print(f"  {mark} {name}  (marker='{marker}')")

# ───── C: 9 indicators — 2 kept strictly verified ─────
print()
print("=" * 60)
print("C. 9 指标核验：严格确保 [保留] 的两条值 A/B 严格相同")
print("=" * 60)
PATTERNS = {
    "drl_min_cd": ("DRL 最小光度", r"昼间行驶灯[^。]{0,100}?(?:最小光强|发光强度|最小光度)[^。]{0,30}?(\d{2,4})\s*(?:cd|坎德拉)"),
    "ess_freq_hz": ("ESS 闪烁频率", r"(?:紧急制动信号|ESS)[^。]{0,80}?(?:闪烁频率|频率)[^。]{0,30}?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz"),
    "ess_cd": ("ESS 光度", r"(?:紧急制动信号|ESS)[^。]{0,100}?(?:发光强度|光强|光度)[^。]{0,30}?(\d{2,4})\s*cd"),
    "drl_vis_deg": ("DRL 可见度", r"昼间行驶灯[^。]{0,100}?可见度[^。]{0,30}?[±±]\s*(\d{1,2})\s*°"),
    "side_marker_m": ("侧标志灯间距", r"侧标志灯[^。]{0,100}?间距[^。]{0,30}?[≤<]\s*(\d(?:\.\d+)?)\s*m"),
    "led_life_h": ("LED 寿命", r"(?:LED|发光二极管)[^。]{0,60}?寿命[^。]{0,30}?(\d{3,4})\s*h"),
    "lumen_pct": ("光通维持率", r"光通维持率[^。]{0,30}?(\d{1,3})\s*%"),
    "preheat_min": ("预热点灯", r"预热[^。]{0,30}?(\d{1,3})\s*min"),
    "afs_switch_s": ("AFS 切换时间", r"(?:AFS|自适应前照)[^。]{0,40}?切换[^。]{0,20}?[≤<]?\s*(\d\.?\d*)\s*s"),
}
issues_C = []
for k, (label, pat) in PATTERNS.items():
    m_b = re.search(pat, b_text, re.IGNORECASE)
    m_a = re.search(pat, a_text, re.IGNORECASE)
    bv = m_b.group(1) if m_b else None
    av = m_a.group(1) if m_a else None
    pb = find_page(b_text, bv) if bv else ""
    pa = find_page(a_text, av) if av else ""
    in_b = bool(bv)
    in_a = bool(av)
    status = "kept" if (in_b and in_a and bv == av) else ("missing" if (not in_b and not in_a) else "modified" if bv != av else "partial")
    issues_C.append((label, bv, av, in_b, in_a, status))
    mark = "✓" if status == "kept" else ("⚠" if status == "missing" else "✗ values differ or partial")
    print(f"  {mark} {label}: B='{bv or '—'}'@{pb}  A='{av or '—'}'@{pa}  status={status}")

# ───── Summary ─────
print()
print("=" * 60)
print("审计总结")
print("=" * 60)
A_fail = [x for x in issues_A if x[8] in ("✗",)]
B_fail = [x for x in issues_B if x[2]]
C_fail = [x for x in issues_C if x[5] not in ("kept", "missing")]
print(f"14 数值变化 → {sum(1 for x in issues_A if x[8] == '✓')} verified, "
      f"{sum(1 for x in issues_A if x[8] == '⚠')} weak, "
      f"{sum(1 for x in issues_A if x[8] == '✗')} fail")
print(f"8 新装置类 → {sum(1 for x in issues_B if not x[2])} 真正只 A 有, "
      f"{sum(1 for x in issues_B if x[2])} B 也存在 → 错误标 [新增]")
print(f"9 指标 → {sum(1 for x in issues_C if x[5] == 'kept')} kept, "
      f"{sum(1 for x in issues_C if x[5] == 'missing')} missing, "
      f"{sum(1 for x in issues_C if x[5] not in ('kept','missing'))} 异常")