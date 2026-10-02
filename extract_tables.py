#!/usr/bin/env python3
"""
Deterministic table extraction from the 3 PDFs using PyMuPDF.
Output: JSON file with all parsed tables + the 9 critical GB4785 indicators.

This bypasses the LLM entirely for table data. The 9 indicators the customer
cares about live in specific tables — we extract them directly.
"""
import fitz, json, re, sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = r"C:\Users\zsndz\Desktop\comparison_agent-main"
PDFS = {
    "A": os.path.join(ROOT, "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"),
    "B": os.path.join(ROOT, "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"),
}

def extract_tables(path):
    doc = fitz.open(path)
    tables = []
    for i in range(len(doc)):
        page = doc[i]
        tabs = page.find_tables()
        if not tabs:
            continue
        for tidx, table in enumerate(tabs.tables):
            try:
                rows = table.extract()
            except Exception:
                continue
            if not rows or len(rows) < 2:
                continue
            # Clean cells
            cleaned = []
            for row in rows:
                cells = [(c or "").replace("\n", " ").strip() for c in row]
                if any(c for c in cells):
                    cleaned.append(cells)
            if len(cleaned) < 2:
                continue
            # Title heuristic: first non-empty cell of first row
            title = ""
            for c in cleaned[0]:
                if c and len(c) <= 40 and not re.match(r'^[\d.\-+]+$', c):
                    title = c
                    break
            tables.append({
                "page": i + 1,
                "title": title,
                "header": cleaned[0] if cleaned else [],
                "rows": cleaned[1:] if len(cleaned) > 1 else [],
            })
    doc.close()
    return tables

def extract_indicators(tables, label):
    """Extract the 9 canonical GB4785 indicators from parsed tables."""
    inds = {}
    all_text = " ".join(" ".join(row) for t in tables for row in t["rows"])
    all_text_lower = all_text.lower()

    def add(key, value, unit, page, source):
        if key not in inds:
            inds[key] = {"value": value, "unit": unit, "page": page, "source": source}

    # 1. DRL 最小光度 (cd) — look for 昼间行驶灯 + cd value
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        if "昼间行驶" in txt or "DRL" in txt.upper():
            m = re.search(r'(\d{2,4})\s*(?:cd|坎德拉)', txt, re.IGNORECASE)
            if m:
                add("drl_min_cd", m.group(1), "cd", t["page"], t["title"])

    # 2. ESS 闪烁频率 (Hz) — look for 4.0±1.0 Hz
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        m = re.search(r'(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz', txt)
        if m and ("紧急制动" in txt or "ESS" in txt.upper() or "制动" in txt):
            add("ess_freq_hz", f"{m.group(1)}±1.0", "Hz", t["page"], t["title"])

    # 3. ESS 光度 (cd) — 紧急制动信号 + cd
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        if "紧急制动" in txt:
            m = re.search(r'(\d{2,4})\s*cd', txt)
            if m:
                add("ess_cd", m.group(1), "cd", t["page"], t["title"])

    # 4. DRL 可见度角度 — ±20° or ±25° near 昼间行驶
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        if "昼间行驶" in txt or "DRL" in txt.upper():
            m = re.search(r'[±±]\s*(\d{1,2})\s*[°]', txt)
            if m:
                add("drl_visibility_deg", f"±{m.group(1)}", "°", t["page"], t["title"])

    # 5. 侧标志灯间距 (m) — ≤6m or ≤4m
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        if "侧标志" in txt:
            m = re.search(r'[≤<]\s*(\d(?:\.\d+)?)\s*m\b', txt)
            if m:
                add("side_marker_spacing_m", f"≤{m.group(1)}", "m", t["page"], t["title"])

    # 6. LED 寿命 (h) — 2000h or 3000h
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        m = re.search(r'寿命[^。]{0,30}?(\d{3,4})\s*h', txt)
        if m:
            add("led_life_h", m.group(1), "h", t["page"], t["title"])

    # 7. 光通维持率 (%) — 70% or 80%
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        m = re.search(r'光通维持率[^。]{0,20}?(\d{1,3})\s*%', txt)
        if m:
            add("lumen_maintenance", m.group(1), "%", t["page"], t["title"])

    # 8. 预热点灯时间 (min) — 30min or 60min
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        m = re.search(r'预热[^。]{0,30}?(\d{1,3})\s*min', txt)
        if m:
            add("preheat_min", m.group(1), "min", t["page"], t["title"])

    # 9. AFS 切换时间 (s) — ≤2s or ≤1.5s
    for t in tables:
        txt = " ".join(" ".join(row) for row in t["rows"])
        m = re.search(r'切换[^。]{0,20}?[≤<]\s*(\d\.?\d*)\s*s', txt)
        if m:
            add("afs_switch_s", f"≤{m.group(1)}", "s", t["page"], t["title"])

    # Also try broader search for the 9 indicators in ALL table text
    # (some may not be in a "table" but in text)
    return inds

def main():
    result = {"A": {}, "B": {}}
    for label, path in PDFS.items():
        tables = extract_tables(path)
        print(f"{label}: {len(tables)} tables")
        for t in tables[:20]:
            print(f"  p{t['page']} [{t['title'][:40]}] {len(t['rows'])}r x {len(t['header'])}c")
        inds = extract_indicators(tables, label)
        print(f"  indicators: {list(inds.keys())}")
        for k, v in inds.items():
            print(f"    {k}: {v['value']}{v['unit']} (p{v['page']})")
        result[label] = {"tables": tables, "indicators": inds}

    out_path = os.path.join(ROOT, "comparison_agent-main", "dist", "table-data.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\nSaved to {out_path}")

if __name__ == "__main__":
    main()