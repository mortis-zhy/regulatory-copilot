#!/usr/bin/env python3
"""
v5 extraction: RAG-Anything-style structured output via PyMuPDF.

This produces the same shape as MinerU/RAG-Anything output:
  - markdown with table preservation
  - structured tables (row × col)
  - figures (image + caption)
  - formulas (LaTeX-ish)
  - citations (cross-references)
  - hierarchy (chapter tree)

Since MinerU models can't be downloaded (SSL/auth blocks), we use:
  - PyMuPDF find_tables() for layout tables
  - PyMuPDF text extraction with page markers
  - Custom heuristics for figure/heading/formula/citation detection
"""
import fitz, json, re, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main")
OUT = ROOT / "comparison_agent-main" / "dist" / "v5-data.json"

PDFS = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

def normalize_spaces(text: str) -> str:
    """Fix broken number formatting from PDF extraction."""
    text = re.sub(r'(\d)\s*\.\s*(\d)', r'\1.\2', text)
    text = re.sub(r'(\d)\s*[±±]\s*(\d)', r'\1±\2', text)
    return text

def extract_page_blocks(doc: fitz.Document) -> list:
    """Extract blocks with kind classification (text/table/heading/figure)."""
    blocks_out = []
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        # Get text dict for block classification
        d = page.get_text("dict")
        page_blocks = []
        for block in d.get("blocks", []):
            if block.get("type") == 1:  # image block
                page_blocks.append({
                    "page": page_idx + 1,
                    "kind": "figure",
                    "bbox": block.get("bbox", []),
                    "image_index": block.get("number", 0),
                })
                continue
            # Text block — extract lines with font info
            lines = []
            for line in block.get("lines", []):
                spans = line.get("spans", [])
                if not spans:
                    continue
                text = "".join(s.get("text", "") for s in spans).strip()
                if not text:
                    continue
                font_size = spans[0].get("size", 12)
                font_flags = spans[0].get("flags", 0)
                # Heading heuristic: large font or bold
                is_heading = font_size > 13 or (font_flags & 16)  # 16 = bold
                # Numbered clause pattern: "5.1.2 标题" or "5.1.2  标题"
                clause_match = re.match(r'^(\d+(?:\.\d+){0,3})\s+(.+)$', text)
                if clause_match and len(text) < 80:
                    lines.append({
                        "type": "clause_heading",
                        "number": clause_match.group(1),
                        "title": clause_match.group(2).strip(),
                        "font_size": round(font_size, 1),
                    })
                elif is_heading and len(text) < 80:
                    lines.append({
                        "type": "heading",
                        "text": text,
                        "font_size": round(font_size, 1),
                    })
                else:
                    lines.append({
                        "type": "text",
                        "text": text,
                    })
            if lines:
                page_blocks.append({
                    "page": page_idx + 1,
                    "kind": "text",
                    "lines": lines,
                })
        blocks_out.extend(page_blocks)
    return blocks_out

def extract_tables(doc: fitz.Document) -> list:
    """Extract layout tables with proper structure."""
    tables = []
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        try:
            tabs = page.find_tables()
        except Exception:
            continue
        for tidx, table in enumerate(tabs.tables):
            try:
                rows = table.extract()
            except Exception:
                continue
            if not rows or len(rows) < 2:
                continue
            cleaned = []
            for row in rows:
                cells = [(c or "").replace("\n", " ").strip() for c in row]
                if any(c for c in cells):
                    cleaned.append(cells)
            if len(cleaned) < 2:
                continue
            # Caption heuristic
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
            })
    return tables

def extract_figures(doc: fitz.Document) -> list:
    """Extract images + captions."""
    figures = []
    for page_idx in range(len(doc)):
        page = doc[page_idx]
        for img_idx, img in enumerate(page.get_images(full=True)):
            xref = img[0]
            try:
                # Get image bbox from page rendering
                rects = page.get_image_rects(xref)
                bbox = list(rects[0]) if rects else []
            except Exception:
                bbox = []
            # Caption heuristic: lines near the image bbox
            caption = ""
            for line_block in page.get_text("blocks"):
                if len(line_block) >= 5:
                    text = line_block[4].strip()
                    if text.startswith(("图", "Figure", "Fig.")) and len(text) < 100:
                        caption = text
                        break
            figures.append({
                "page": page_idx + 1,
                "index": img_idx,
                "bbox": bbox,
                "caption": caption,
                "xref": xref,
            })
    return figures

def extract_formulas(text: str) -> list:
    """Detect formula patterns in text."""
    formulas = []
    # Patterns: contains =, ±, ≤, ≥, or specific function names
    patterns = [
        r'[一-龥]?[a-zA-Z][一-龥a-zA-Z0-9_]*\s*=\s*[^。\n]{3,40}',
        r'[一-龥]?\s*[一-龥]?[a-zA-Z][一-龥a-zA-Z0-9_]*\s*[≤≥<>=]\s*[^。\n]{2,40}',
        r'[0-9]+\s*[±±]\s*[0-9]+(?:\.[0-9]+)?\s*(?:cd|mm|Hz|°|lx)',
    ]
    for pat in patterns:
        for m in re.finditer(pat, text):
            f = m.group(0).strip()
            if 3 < len(f) < 80:
                formulas.append(f)
    return list(set(formulas))[:30]

def extract_hierarchy(blocks: list) -> list:
    """Build chapter tree from heading blocks."""
    tree = []
    current_chapter = None
    for blk in blocks:
        if blk.get("kind") != "text":
            continue
        for line in blk.get("lines", []):
            if line.get("type") == "clause_heading":
                level = line["number"].count(".") + 1
                entry = {
                    "level": level,
                    "number": line["number"],
                    "title": line["title"],
                    "page": blk["page"],
                }
                tree.append(entry)
    return tree

def extract_citations(text: str) -> list:
    """Find cross-references like '见 5.1.2' or '按附录 C'."""
    citations = []
    patterns = [
        (r'见\s*(\d+(?:\.\d+){0,3})', '见'),
        (r'按\s*(\d+(?:\.\d+){0,3})', '按'),
        (r'参见\s*(\d+(?:\.\d+){0,3})', '参见'),
        (r'附录\s*([A-Z\d]+)', '附录'),
        (r'表\s*(\d+)', '表'),
        (r'图\s*(\d+)', '图'),
    ]
    for pat, kind in patterns:
        for m in re.finditer(pat, text):
            citations.append({"type": kind, "target": m.group(1)})
    return list({c["target"]: c for c in citations}.values())[:30]

def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    results = {}

    for label, pdf_path in PDFS.items():
        if not pdf_path.exists():
            print(f"[v5] {label}: not found")
            continue
        print(f"[v5] {label}: {pdf_path.name} ...")
        doc = fitz.open(pdf_path)
        full_text = "\n".join(p.get_text("text") for p in doc)
        full_text = normalize_spaces(full_text)

        # 4 parallel streams (like RAG-Anything)
        print(f"[v5] {label}: scanning {len(doc)} pages...")
        blocks = extract_page_blocks(doc)
        tables = extract_tables(doc)
        figures = extract_figures(doc)
        formulas = extract_formulas(full_text)
        hierarchy = extract_hierarchy(blocks)
        citations = extract_citations(full_text)

        print(f"[v5] {label}: {len(blocks)} blocks, {len(tables)} tables, "
              f"{len(figures)} figures, {len(formulas)} formulas, "
              f"{len(hierarchy)} headings, {len(citations)} citations")

        results[label] = {
            "fileName": pdf_path.name,
            "pageCount": len(doc),
            "fullText": full_text,
            "fullTextLength": len(full_text),
            "blocks": blocks,
            "tables": tables,
            "figures": figures,
            "formulas": formulas,
            "hierarchy": hierarchy,
            "citations": citations,
            "extractedAt": "v5-pymupdf-rag-style",
        }
        doc.close()

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"\n[v5] Saved {len(results)} docs to {OUT} ({size_mb:.1f} MB)")

if __name__ == "__main__":
    main()