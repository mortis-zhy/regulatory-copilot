# -*- coding: utf-8 -*-
"""set_pdf_meta.py — patch Chromium-rendered PDF metadata.

Chromium's page.pdf() only honors `title`; subject/author/keywords are
ignored. This script (PyMuPDF) writes the rest after render so customer
support can identify the pipeline version that produced a report.
"""
import argparse
import datetime
import sys
from pathlib import Path

import fitz


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--title", required=True)
    ap.add_argument("--author", default="")
    ap.add_argument("--subject", default="")
    ap.add_argument("--keywords", default="")
    ap.add_argument("--pipeline-version", default="")
    args = ap.parse_args()
    if not args.pdf.exists():
        sys.stderr.write(f"[meta] not found: {args.pdf}\n")
        return 1
    doc = fitz.open(str(args.pdf))
    md = doc.metadata
    if args.title:        md["title"]    = args.title
    if args.author:       md["author"]   = args.author
    if args.subject:      md["subject"]  = args.subject
    if args.keywords:     md["keywords"] = args.keywords
    if args.pipeline_version:
        # PyMuPDF rejects custom keys in set_metadata and xref_set_key does
        # not persist reliably — embed the version in subject (visible in
        # every PDF reader's properties panel).
        suffix = f" | pipeline {args.pipeline_version}"
        if args.pipeline_version not in (md.get("subject") or ""):
            md["subject"] = ((md.get("subject") or "") + suffix).strip(" |")
        md["creationDate"] = datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z")
    doc.set_metadata(md)
    # saveIncr uses the path the document was opened from; no args.
    doc.saveIncr()
    doc.close()
    sys.stdout.write(f"[meta] patched {args.pdf.name}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
