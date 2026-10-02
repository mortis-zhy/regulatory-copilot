#!/usr/bin/env python3
"""
Full OCR scan of all 3 PDFs to find the 9 GB4785 data indicators.
Uses easyocr (Chinese + English) with very loose patterns.
"""
import easyocr, fitz, json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main")
OUT = ROOT / "comparison_agent-main" / "dist" / "ocr-full.json"
IMG_DIR = ROOT / "comparison_agent-main" / ".ocr-pages"

PDFS = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

reader = easyocr.Reader(['ch_sim', 'en'], gpu=False, verbose=False)

def render_all(pdf_path, out_dir):
    """Render all pages at 150 DPI."""
    doc = fitz.open(pdf_path)
    paths = []
    for i in range(len(doc)):
        page = doc[i]
        pix = page.get_pixmap(dpi=150)
        p = out_dir / f"{doc[i].number}.png"
        pix.save(str(p))
        paths.append(p)
    doc.close()
    return paths

def ocr_all(img_paths):
    """OCR all pages."""
    results = {}
    for p in img_paths:
        text = '\n'.join(reader.readtext(str(p), detail=0, paragraph=False))
        # Page number is encoded in filename
        pn = int(p.stem)
        results[pn] = text
    return results

# Loose patterns (capture any numeric hint near key indicator words)
PATTERNS = {
    "drl_min_cd":          r'(?:DRL|昼间行驶灯|日行灯)[^。\n]{0,80}?(?:光强|光度|亮度)[^。\n]{0,30}?(\d{2,4})\s*(?:cd|坎德拉)',
    "ess_freq_hz":         r'(?:紧急制动|ESS|emergency stop)[^。\n]{0,80}?(?:闪烁|频(?:率|次))[^。\n]{0,30}?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz',
    "ess_cd":              r'(?:紧急制动|ESS)[^。\n]{0,80}?(?:光强|光度|发光强度)[^。\n]{0,30}?(\d{2,4})\s*cd',
    "drl_vis_deg":         r'(?:DRL|昼间行驶灯)[^。\n]{0,80}?可见度[^。\n]{0,30}?[±±]\s*(\d{1,2})\s*°',
    "side_marker_m":       r'侧标志灯[^。\n]{0,80}?间距[^。\n]{0,30}?[≤<]\s*(\d(?:\.\d+)?)\s*m',
    "led_life_h":          r'(?:LED|发光二极管)[^。\n]{0,60}?寿命[^。\n]{0,20}?(\d{3,4})\s*h',
    "lumen_pct":           r'(?:光通维持率|维持率|维持比)[^。\n]{0,40}?(\d{1,3})\s*%',
    "preheat_min":         r'预热[^。\n]{0,30}?(\d{1,3})\s*min',
    "afs_switch_s":        r'(?:AFS|自适应前照|自适应)[^。\n]{0,40}?切换[^。\n]{0,30}?[≤<]?\s*(\d\.?\d*)\s*s',
}

LABELS = {
    "drl_min_cd": "DRL 最小光度",
    "ess_freq_hz": "ESS 闪烁频率",
    "ess_cd": "ESS 光度",
    "drl_vis_deg": "DRL 可见度角度",
    "side_marker_m": "侧标志灯间距",
    "led_life_h": "LED 寿命",
    "lumen_pct": "光通维持率",
    "preheat_min": "预热点灯时间",
    "afs_switch_s": "AFS 切换时间",
}

# First check what's in OCR text directly
def main():
    results = {}
    for label, pdf_path in PDFS.items():
        if not pdf_path.exists():
            continue
        out_dir = IMG_DIR / label
        out_dir.mkdir(parents=True, exist_ok=True)
        print(f"[ocr] {label}: rendering {pdf_path.name}...")
        img_paths = render_all(pdf_path, out_dir)
        print(f"[ocr] {label}: rendered {len(img_paths)} pages")

        print(f"[ocr] {label}: running OCR on {len(img_paths)} pages...")
        ocr_text = ocr_all(img_paths)

        # Search for indicators
        print(f"[ocr] {label}: scanning for 9 indicators...")
        indicators = []
        for key, pat in PATTERNS.items():
            for pn, text in ocr_text.items():
                m = re.search(pat, text, re.IGNORECASE)
                if m:
                    idx = m.start()
                    before = text[max(0, idx-100):idx]
                    clause_m = re.search(r'(\d+\.\d+(?:\.\d+)*)\s*$', before)
                    clause = clause_m.group(1) if clause_m else ""
                    indicators.append({
                        "id": key, "label": LABELS[key],
                        "value": m.group(1), "page": pn, "clause": clause,
                    })
                    break
        print(f"[ocr] {label}: {len(indicators)} indicators found")
        for ind in indicators:
            print(f"  [{ind['id']}] {ind['label']}: {ind['value']} (p{ind['page']}, {ind['clause']})")
        results[label] = {
            "fileName": pdf_path.name,
            "pageCount": len(img_paths),
            "indicators": indicators,
        }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n[ocr] saved to {OUT}")
    # Summary
    total = sum(len(r["indicators"]) for r in results.values())
    print(f"[ocr] total indicators across 3 PDFs: {total}/9")

if __name__ == "__main__":
    main()