"""
Python sidecar for comparison_agent-main.

Exposes the same verification pipeline used to produce the v6.2 PDF report:
  POST /extract    : MinerU 4.0.6 multimodal extraction of a PDF (cached by SHA-256)
  POST /verify     : machine-verify 14 numeric changes + 24 three-column topics
  GET  /report-data: combined extract + verify (most common call site)
  GET  /health     : liveness check

Runs on port 8300. The Node side (`server/_core/agentRoutes.ts`) calls these via
the `PYTHON_SERVICE_URL` env var.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import os
import re
import sys
import time
from pathlib import Path

# --- make the v6 pipeline modules importable ---
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))  # so `extract_mineru_v4_sdk` + `audit` import works

# Quiet down the magic-pdf/transformers log noise in sidecar context.
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="comparison-agent Python sidecar", version="v6.2")

ALLOWED_DOCS = {
    "A": r"GB[\s_-]*4785.*草案.*V\d.*\.pdf$",        # A 草案
    "B": r"GB[\s_-]*4785[\s_-]*2019.*\.pdf$",                  # B 现行
    "C": r"UN.*R0?48.*\.pdf$",                              # C UN R48-09
}
ALLOWED_LABELS = set(ALLOWED_DOCS.keys())

def _validate_doc(label: str, file_name: str, file_path: str) -> None:
    """Reject anything that does not match the three expected GB / UN docs.
    Prevents feeding unrelated PDFs into a pipeline whose facts.json /
    extract-cache / diff-result.json were computed for the same three."""
    if label not in ALLOWED_LABELS:
        raise HTTPException(400, f"label must be one of {sorted(ALLOWED_LABELS)}, got {label!r}")
    pat = ALLOWED_DOCS[label]
    if not re.search(pat, file_name, re.I) and not re.search(pat, file_path, re.I):
        raise HTTPException(400, f"{label} file name/path must match {pat} (got {file_name!r})")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

CACHE_DIR = Path(os.environ.get("PYTHON_SERVICE_CACHE", ROOT / "dist" / "sidecar-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cache_path(label: str, file_hash: str, suffix: str) -> Path:
    return CACHE_DIR / f"{label}__{file_hash[:16]}{suffix}"


class ExtractResponse(BaseModel):
    label: str
    fileName: str
    fileHash: str
    pages: int
    markdownLen: int
    fullTextLen: int
    blockCounts: dict[str, int]
    tableCount: int
    figureCount: int
    equationCount: int
    headingCount: int
    extractionSeconds: float
    cached: bool
    content_list_summary: dict[str, int] | None = None  # type counts
    data: dict  # full MinerU per-doc dict (for downstream consumers)


class VerifyResponse(BaseModel):
    fileHash: str
    numericChanges: list[dict]
    topicColumns: list[dict]
    stats: dict
    cached: bool


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "time": time.time(),
        "minerUVersion": "4.0.6 (local)",
        "cachedFiles": len(list(CACHE_DIR.glob("*.json"))),
    }


@app.post("/extract")
def extract_endpoint(payload: dict) -> ExtractResponse:
    """payload: { "label": "A"|"B"|"C", "fileName": "name.pdf", "filePath": "C:\\...pdf" }"""
    label = payload.get("label")
    file_name = payload.get("fileName", "doc.pdf")
    file_path = payload.get("filePath")
    if not label or not file_path or not Path(file_path).exists():
        raise HTTPException(400, "label + filePath required, file must exist")
    _validate_doc(label, file_name, file_path)

    file_hash = sha256(Path(file_path))
    cache_file = cache_path(label, file_hash, ".extracted.json")

    if cache_file.exists():
        data = json.loads(cache_file.read_text(encoding="utf-8"))
        return ExtractResponse(
            label=label,
            fileName=file_name,
            fileHash=file_hash,
            pages=data.get("pages", data.get("pageCount", 0)),
            markdownLen=len(data.get("markdown", "")),
            fullTextLen=len(data.get("fullText", "")),
            blockCounts=data.get("blockTypes", {}),
            tableCount=len(data.get("tables", [])),
            figureCount=len(data.get("figures", [])),
            equationCount=len(data.get("equations", [])),
            headingCount=len(data.get("headings", [])),
            extractionSeconds=0.0,
            cached=True,
            content_list_summary=None,
            data=data,
        )

    # Lazy import + run the heavy work
    from extract_mineru_v4_sdk import extract_one  # our v4 helper

    t0 = time.time()
    out = extract_one(label, Path(file_path))
    elapsed = time.time() - t0

    cache_file.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")

    return ExtractResponse(
        label=label,
        fileName=file_name,
        fileHash=file_hash,
        pages=out.get("pageCount", 0),
        markdownLen=len(out.get("markdown", "")),
        fullTextLen=len(out.get("fullText", "")),
        blockCounts=out.get("blockTypes", {}),
        tableCount=len(out.get("tables", [])),
        figureCount=len(out.get("figures", [])),
        equationCount=len(out.get("equations", [])),
        headingCount=len(out.get("headings", [])),
        extractionSeconds=round(elapsed, 2),
        cached=False,
        content_list_summary=None,
        data=out,
    )


@app.post("/verify")
def verify_endpoint(payload: dict) -> dict:
    """Run verify_claims.run_verify() (cross-doc diff + machine verification).
    Requires dist/mineru-v4-data.json + dist/diff-result.json + dist/extract-cache
    to already exist (produced by the CLI pipeline). Returns the full
    verified-comparison.json shape."""
    sys.path.insert(0, str(ROOT))
    import verify_claims as vc
    out = vc.run_verify()
    # cache it locally so the Node side can reuse
    (ROOT / "dist" / "verified-comparison.json").write_text(
        json.dumps(out, ensure_ascii=False), encoding="utf-8"
    )
    return out


@app.post("/report-data")
def report_data_endpoint(payload: dict) -> dict:
    """Combined: { "documents": [{"label","fileName","filePath"}, ...] }
    Returns { extracted: {label: data}, verified: null }.
    The Node side calls this once for all 3 documents."""
    docs = payload.get("documents") or []
    if len(docs) < 1:
        raise HTTPException(400, "documents[] required")
    out = {"extracted": {}, "verified": None, "errors": []}
    for d in docs:
        try:
            r = extract_endpoint(d)
            out["extracted"][d.get("label", "?")] = r.data
        except Exception as e:
            out["errors"].append({"label": d.get("label"), "error": str(e)})
    return out


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PYTHON_SERVICE_PORT", "8300"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")