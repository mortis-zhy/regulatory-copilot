#!/usr/bin/env python3
"""
Comprehensive PDF extraction using PyMuPDF (already proven to work).
This is our substitute for RAG-Anything/MinerU since model downloads fail.

Output: dist/pymupdf-data.json with:
  - clean text (no broken numbers like "4. 0±1. 0")
  - all layout tables (19+12 tables found)
  - 9 GB4785 data indicators (regex scan)
  - new device classes (keyword scan)
"""
import fitz, json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main")
OUT = ROOT / "comparison_agent-main" / "dist" / "pymupdf-data.json"

PDFS = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

def normalize_number_spaces(text: str) -> str:
    """Fix broken number formatting: '4. 0±1. 0' → '4.0±1.0'.
    This is the #1 cause of regex failure in the previous pipeline."""
    # Remove spaces inside decimal numbers: "X. Y" → "X.Y" when X,Y are digits
    # Pattern: digit-space-dot-space-digit
    text = re.sub(r'(\d)\s*\.\s*(\d)', r'\1.\2', text)
    # Remove space inside "± X" / "X ±" patterns
    text = re.sub(r'(\d)\s*[±±]\s*(\d)', r'\1±\2', text)
    # Remove space inside "X ±1.0" / "X～Y"
    return text

def extract_text_and_tables(pdf_path: Path) -> dict:
    """Extract clean text + all tables from one PDF."""
    doc = fitz.open(pdf_path)
    pages_out = []
    all_tables = []

    for i in range(len(doc)):
        page = doc[i]
        raw_text = page.get_text("text")
        # Normalize number spacing
        clean_text = normalize_number_spaces(raw_text)

        # Extract tables
        tabs = page.find_tables()
        page_tables = []
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
            # Title heuristic: first non-empty short cell of first row
            title = ""
            for c in cleaned[0]:
                if c and len(c) <= 40 and not re.match(r'^[\d.\-+]+$', c):
                    title = c
                    break
            t_obj = {
                "page": i + 1,
                "title": title,
                "header": cleaned[0],
                "rows": cleaned[1:],
            }
            page_tables.append(t_obj)
            all_tables.append(t_obj)

        pages_out.append({
            "page": i + 1,
            "text": clean_text,
            "tables": page_tables,
        })

    doc.close()
    return {
        "pages": pages_out,
        "all_tables": all_tables,
        "table_count": len(all_tables),
    }

# 9 GB4785 data indicator regex patterns (work on normalized text)
INDICATOR_PATTERNS = [
    ("drl_min_cd", "DRL 最小光度", "cd",
     r'昼间行驶灯[^。]{0,80}?(?:最小光强|发光强度)[^。]{0,20}?(\d{2,4})\s*(?:cd|坎德拉)'),
    ("ess_freq_hz", "ESS 闪烁频率", "Hz",
     r'(?:紧急制动信号|ESS)[^。]{0,60}?闪烁频率[^。]{0,20}?(\d\.?\d*)\s*±\s*1\.?\d*\s*Hz'),
    ("ess_cd", "ESS 光度", "cd",
     r'(?:紧急制动信号|ESS)[^。]{0,80}?(?:发光强度|光强)[^。]{0,20}?(\d{2,4})\s*cd'),
    ("drl_vis_deg", "DRL 可见度角度", "°",
     r'昼间行驶灯[^。]{0,80}?可见度[^。]{0,30}?[±±]\s*(\d{1,2})\s*°'),
    ("side_marker_m", "侧标志灯间距", "m",
     r'侧标志灯[^。]{0,80}?间距[^。]{0,20}?[≤<]\s*(\d(?:\.\d+)?)\s*m'),
    ("led_life_h", "LED 寿命", "h",
     r'寿命[^。]{0,30}?(\d{3,4})\s*h'),
    ("lumen_pct", "光通维持率", "%",
     r'光通维持率[^。]{0,30}?(\d{1,3})\s*%'),
    ("preheat_min", "预热点灯时间", "min",
     r'预热[^。]{0,30}?(\d{1,3})\s*min'),
    ("afs_switch_s", "AFS 切换时间", "s",
     r'(?:AFS|自适应前照)[^。]{0,40}?切换[^。]{0,20}?[≤<]\s*(\d\.?\d*)\s*s'),
]

def scan_indicators(full_text: str) -> list:
    hits = []
    for key, label, unit, pat in INDICATOR_PATTERNS:
        m = re.search(pat, full_text, re.IGNORECASE)
        if m:
            idx = m.start()
            # Find page
            page_match = list(re.finditer(r'\[第(\d+)页\]', full_text[:idx]))
            page = f"第{page_match[-1].group(1)}页" if page_match else ""
            # Find clause (closest preceding X.Y or X.Y.Z)
            before = full_text[max(0, idx - 200):idx]
            clause_m = re.search(r'(\d+\.\d+(?:\.\d+)*)\s*$', before)
            clause = clause_m.group(1) if clause_m else ""
            hits.append({
                "id": key, "label": label, "unit": unit,
                "value": m.group(1), "page": page, "clause": clause,
            })
    return hits

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    results = {}

    for label, pdf_path in PDFS.items():
        if not pdf_path.exists():
            print(f"[pymupdf] {label}: not found")
            continue
        print(f"[pymupdf] {label}: extracting {pdf_path.name}...")
        try:
            data = extract_text_and_tables(pdf_path)
            full_text = "\n".join(p["text"] for p in data["pages"])
            data["full_text"] = full_text
            data["indicators"] = scan_indicators(full_text)
            results[label] = {
                "fileName": pdf_path.name,
                "pageCount": len(data["pages"]),
                "tableCount": data["table_count"],
                "fullTextLength": len(full_text),
                "indicators": data["indicators"],
                "tables": data["all_tables"],
                "fullText": full_text,  # needed for indicator regex scan in Node
            }
            print(f"[pymupdf] {label}: {data['table_count']} tables, {len(data['indicators'])} indicators found")
            for ind in data["indicators"]:
                print(f"  [{ind['id']}] {ind['label']}: {ind['value']}{ind['unit']} (p{ind['page']})")
        except Exception as e:
            print(f"[pymupdf] {label}: EXCEPTION {e}")
            import traceback; traceback.print_exc()

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)  # compact JSON
    size_kb = OUT.stat().st_size // 1024
    print(f"\n[pymupdf] Saved {len(results)} docs to {OUT} ({size_kb} KB)")

if __name__ == "__main__":
    main()