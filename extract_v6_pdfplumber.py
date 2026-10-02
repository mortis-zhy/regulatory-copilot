#!/usr/bin/env python3
"""
v6 extraction: pdfplumber for precise tables, PyMuPDF for figures/structure.

pdfplumber uses different heuristics than PyMuPDF's find_tables():
  - Better with edge-based tables
  - Better with text-aligned tables
  - Better with merged cells (uses lines AND text alignment)

Combined with PyMuPDF for images and structure = best local extraction.

Output: dist/v6-data.json with structured content + indicator scan results.
"""
import pdfplumber, fitz, json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main")
OUT = ROOT / "comparison_agent-main" / "dist" / "v6-data.json"

PDFS = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

def normalize_spaces(text: str) -> str:
    text = re.sub(r'(\d)\s*\.\s*(\d)', r'\1.\2', text)
    text = re.sub(r'(\d)\s*[±±]\s*(\d)', r'\1±\2', text)
    return text

def extract_with_pdfplumber(pdf_path: Path) -> dict:
    """Extract text + tables using pdfplumber (better table detection)."""
    text_parts = []
    tables = []

    with pdfplumber.open(pdf_path) as pdf:
        for page_idx, page in enumerate(pdf.pages):
            # Text with layout preservation
            text = page.extract_text() or ""
            text = normalize_spaces(text)
            if text:
                text_parts.append(f"[第{page_idx+1}页]\n{text}")

            # Tables (pdfplumber is better at edge-based and merged cells)
            try:
                page_tables = page.extract_tables()
            except Exception:
                page_tables = []

            for tidx, table in enumerate(page_tables):
                if not table or len(table) < 2:
                    continue
                # Clean cells
                cleaned = []
                for row in table:
                    cells = [(c or "").replace("\n", " ").strip() for c in row]
                    if any(c for c in cells):
                        cleaned.append(cells)
                if len(cleaned) < 2:
                    continue
                title = ""
                for c in cleaned[0]:
                    if c and len(c) <= 40 and not re.match(r'^[\d.\-+]+$', c):
                        title = c
                        break
                tables.append({
                    "page": page_idx + 1,
                    "index": tidx,
                    "title": title,
                    "header": cleaned[0],
                    "rows": cleaned[1:],
                    "rowCount": len(cleaned) - 1,
                    "colCount": len(cleaned[0]),
                })

    return {
        "fullText": "\n".join(text_parts),
        "tables": tables,
        "tableCount": len(tables),
    }

def extract_with_pymupdf(pdf_path: Path) -> dict:
    """Extract images + structure using PyMuPDF."""
    doc = fitz.open(pdf_path)
    figures = []
    hierarchy = []

    for page_idx in range(len(doc)):
        page = doc[page_idx]

        # Images
        for img_idx, img in enumerate(page.get_images(full=True)):
            try:
                rects = page.get_image_rects(img[0])
                bbox = list(rects[0]) if rects else []
            except Exception:
                bbox = []
            figures.append({
                "page": page_idx + 1,
                "index": img_idx,
                "bbox": bbox,
            })

        # Heading hierarchy via text dict
        d = page.get_text("dict")
        for block in d.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                font_size = spans[0].get("size", 12)
                m = re.match(r'^(\d+(?:\.\d+){0,3})\s+(.+)$', text)
                if m and len(text) < 80:
                    hierarchy.append({
                        "level": m.group(1).count(".") + 1,
                        "number": m.group(1),
                        "title": m.group(2).strip(),
                        "page": page_idx + 1,
                        "fontSize": round(font_size, 1),
                    })

    doc.close()
    return {"figures": figures, "hierarchy": hierarchy}

# 9 GB4785 data indicator patterns (work on normalized text)
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

def scan_indicators(text: str) -> list:
    hits = []
    for key, label, unit, pat in INDICATOR_PATTERNS:
        for m in re.finditer(pat, text, re.IGNORECASE):
            idx = m.start()
            page_match = list(re.finditer(r'\[第(\d+)页\]', text[:idx]))
            page = f"第{page_match[-1].group(1)}页" if page_match else ""
            before = text[max(0, idx - 200):idx]
            clause_m = re.search(r'(\d+\.\d+(?:\.\d+)*)\s*$', before)
            clause = clause_m.group(1) if clause_m else ""
            hits.append({
                "id": key, "label": label, "unit": unit,
                "value": m.group(1), "page": page, "clause": clause,
            })
            break
    return hits

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    results = {}

    for label, pdf_path in PDFS.items():
        if not pdf_path.exists():
            print(f"[v6] {label}: not found")
            continue
        print(f"[v6] {label}: {pdf_path.name}")

        # 1. pdfplumber for text + tables
        pp_result = extract_with_pdfplumber(pdf_path)
        print(f"[v6] {label}: pdfplumber → {pp_result['tableCount']} tables, {len(pp_result['fullText'])} chars")

        # 2. PyMuPDF for figures + hierarchy
        pmu_result = extract_with_pymupdf(pdf_path)
        print(f"[v6] {label}: PyMuPDF → {len(pmu_result['figures'])} figures, {len(pmu_result['hierarchy'])} headings")

        # 3. Indicator scan on pdfplumber text (better normalized)
        indicators = scan_indicators(pp_result["fullText"])
        print(f"[v6] {label}: indicators → {len(indicators)} found")
        for ind in indicators:
            print(f"  [{ind['id']}] {ind['label']}: {ind['value']}{ind['unit']} (p{ind['page']}, {ind['clause']})")

        results[label] = {
            "fileName": pdf_path.name,
            "pageCount": len(pp_result.get("fullText", "").split("[第")) - 1,
            "fullText": pp_result["fullText"],
            "fullTextLength": len(pp_result["fullText"]),
            "tables": pp_result["tables"],
            "figures": pmu_result["figures"],
            "hierarchy": pmu_result["hierarchy"],
            "indicators": indicators,
            "extractedAt": "v6-pdfplumber+pymupdf",
        }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\n[v6] Saved {len(results)} docs ({size_mb:.1f} MB) to {OUT}")

if __name__ == "__main__":
    main()