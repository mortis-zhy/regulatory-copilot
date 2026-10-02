# -*- coding: utf-8 -*-
"""extract_toc_pages.py — pass-1 PDF -> {title: start-page} JSON on stdout.

Used by reportV6's TWO-PASS render: the first render has no TOC page numbers
(a 200-page customer report needs them), so we render once, locate each
chapter/appendix title here (whitespace-stripped forward search, skipping the
cover + TOC page), then re-render with the map injected.

Run: python extract_toc_pages.py <pdf>   -> JSON {"title": page, ...}
Shares its title list with add_pdf_outline.py so bookmark order == TOC order.
"""
import json
import re
import sys
from pathlib import Path

import fitz

# NOTE: do NOT wrap stdout here — importing add_pdf_outline performs the
# utf-8 wrap at module level; a second wrapper closes the first buffer
# ("I/O operation on closed file") when run as a subprocess.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from add_pdf_outline import TITLES  # noqa: E402  (also wraps stdout utf-8)


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: extract_toc_pages.py <pdf>", file=sys.stderr)
        return 1
    doc = fitz.open(sys.argv[1])
    pages = [re.sub(r"\s+", "", p.get_text()) for p in doc]
    out: dict[str, int] = {}
    cursor = 2  # skip cover + in-document TOC page
    for title in TITLES:
        key = re.sub(r"\s+", "", title)
        for pi in range(cursor, len(pages)):
            if key in pages[pi]:
                out[title] = pi + 1  # 1-based
                cursor = pi
                break
    json.dump(out, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
