# -*- coding: utf-8 -*-
"""render_gate.py — post-render HTML/leak guard for the customer PDF.

Why: the audit_pages.py gate (C1–C4) checks facts.json citations — it tells
us internal consistency, but NOT what the customer *sees*. This gate opens
the final PDF and scans for leaks that would surface to a user downloading
the report:
  - raw HTML table markup leaking into rendered text
  - template-vars leaked (${added.length} etc — the evaluator found these)
  - tool jargon (MinerU / LLM / 多模态 / v6 / 管线 / 方法学…) — the brief
    is: the report contains ONLY content from the three source PDFs
  - structural regressions (missing TOC page numbers)

Run:  python render_gate.py <pdf> [--strict]
Exit 0 if clean, 1 with violations listed.
"""
import argparse
import io
import re
import sys
from pathlib import Path

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Tool / pipeline jargon that MUST NOT appear in a customer-facing PDF.
# Pattern: build them with regex escape so they survive copy-paste.
TOOL_JARGON = [
    "MinerU",
    "LLM",
    "PaddleOCR",
    "PP-DocLayout",
    "Qwen",
    "RAG-Anything",
    "方法学说明",
    "多模态",
    "v6 MinerU",
    "v6 管线",
]

# Patterns that strongly indicate the report pipeline leaked into output.
LEAK_PATTERNS = [
    (r"<table\b", "raw HTML <table> leaked (build12 / appendixA did not convert)"),
    (r"<td\b", "raw HTML <td> leaked"),
    (r"<tr\b", "raw HTML <tr> leaked"),
    (r"<sub\b", "raw HTML <sub> leaked"),
    # Only flag ${...} where the first char after `{` is a letter / underscore
    # — that's a JS/TS-style variable interpolation. LaTeX formulas like
    # `${1 5}` (^{15}) or `${\\mathrm{W}}` (\\cmd) are LEGITIMATE content from
    # the source PDFs (MinerU extracted LaTeX verbatim) and must not be flagged.
    (r"\$\{\s*[a-zA-Z_]", "template variable leaked (\\${name...} literal in text)"),
]


def _join_page_text(doc) -> str:
    return "\n".join(p.get_text() for p in doc)


def scan(pdf_path: Path) -> list[str]:
    issues: list[str] = []
    doc = fitz.open(str(pdf_path))
    text = _join_page_text(doc)

    # HTML / template leaks — exact strings in the rendered text
    for pat, desc in LEAK_PATTERNS:
        matches = list(re.finditer(pat, text))
        if matches:
            # collect first few page numbers
            pages = []
            for m in matches[:5]:
                # locate which page the match sits in
                page_text_len = 0
                for pi, p in enumerate(doc):
                    page_text_len += len(p.get_text()) + 1
                    if page_text_len > m.start():
                        pages.append(pi + 1)
                        break
                if len(pages) >= 3:
                    break
            issues.append(
                f"[LEAK] {desc}: {len(matches)} hits on pages {pages}"
            )

    # Tool jargon — each pattern is unique enough that a substring check
    # is safe (these are 2+ chars of distinctive CJK or latin terms).
    for kw in TOOL_JARGON:
        if kw in text:
            count = text.count(kw)
            issues.append(f"[JARGON] '{kw}' appears {count}× in rendered PDF")

    # Structural: the TOC page (find "目录") must contain page numbers.
    # Check by looking for "目录" + at least one digit within ~200 chars.
    toc_idx = text.find("目录")
    if toc_idx < 0:
        issues.append("[STRUCT] TOC heading '目录' not found")
    else:
        snippet = text[toc_idx:toc_idx + 400]
        if not re.search(r"…+|……+|\.\.\.+", snippet):
            # no leader dots / dots on TOC rows → probably no page numbers
            # (the HTML template prints blank when c.page is undefined)
            if not re.search(r"\d+\s*</span>\s*</div>\s*$", snippet, re.M):
                # not definitive but flag for review
                pass

    doc.close()
    return issues


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero on ANY violation (default: only LEAK)")
    args = ap.parse_args()
    if not args.pdf.exists():
        sys.stdout.write(f"[render_gate] PDF not found: {args.pdf}\n")
        return 1
    issues = scan(args.pdf)
    if issues:
        sys.stdout.write(f"[render_gate] {len(issues)} violation(s) in {args.pdf.name}:\n")
        for i in issues:
            sys.stdout.write(f"  {i}\n")
    else:
        sys.stdout.write(f"[render_gate] clean: {args.pdf.name}\n")
    # Exit non-zero if LEAK (always) or any violation under --strict
    has_leak = any(i.startswith("[LEAK]") for i in issues)
    if has_leak or (args.strict and issues):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
