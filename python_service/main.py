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

# Order-independent signatures. The old patterns were anchored single regexes
# ("GB...草案...V\d", "UN...R48"), which rejected legitimately-named files such
# as "GB4785_V4.3.5_草案.pdf" purely because 草案 came after V\d — and the error
# told the user nothing about how to fix it.
#
# Each signature is a set of token regexes that must ALL appear somewhere in the
# filename, in any order. `exclude` tokens veto a match, so a draft revision does
# not get mistaken for the 2019 in-force edition.
DOC_SIGNATURES = {
    "A": {
        "tokens": [r"GB[\s_-]*4785", r"草案|draft|修订"],
        "exclude": [r"2019"],
    },
    "B": {
        "tokens": [r"GB[\s_-]*4785", r"2019"],
        "exclude": [r"草案|draft|修订"],
    },
    "C": {
        "tokens": [r"UN[\s_-]*R0?48"],
        "exclude": [],
    },
}
ALLOWED_LABELS = set(DOC_SIGNATURES.keys())

_ACCEPT_HELP = (
    "已支持的标准（文件名任意顺序均可）："
    "A = 含「GB 4785」且含「草案」的修订版；"
    "B = 含「GB 4785」且含「2019」的现行版；"
    "C = 含「UN R48」的 UN 法规。"
    "也可在上传时直接指定版本标签。"
)


def infer_label(file_name: str, file_path: str = "") -> str | None:
    """Guess A/B/C from a filename, ignoring token order. None if ambiguous."""
    hay = f"{file_name} {file_path}"
    hits = []
    for label, sig in DOC_SIGNATURES.items():
        if not all(re.search(t, hay, re.I) for t in sig["tokens"]):
            continue
        if any(re.search(x, hay, re.I) for x in sig["exclude"]):
            continue
        hits.append(label)
    return hits[0] if len(hits) == 1 else None


def _validate_doc(label: str, file_name: str, file_path: str) -> str:
    """Resolve the doc label, preferring the file's own signature over the
    caller's positional guess.

    The client assigns labels by upload order (LABELS[i]), so a correctly-named
    draft uploaded second gets validated against B's pattern and fails there.
    Returning the label actually used lets /extract report `labelInferred` so the
    UI can confirm before a document silently changes role.

    Returns the label that was actually used.
    """
    if label not in ALLOWED_LABELS:
        raise HTTPException(400, f"label must be one of {sorted(ALLOWED_LABELS)}, got {label!r}")

    guessed = infer_label(file_name, file_path)
    if guessed is None:
        raise HTTPException(400, f"{file_name!r} 未匹配任何已支持的标准。{_ACCEPT_HELP}")
    if guessed != label:
        # Filename says one thing, caller says another. Trust the filename — it is
        # what the human actually named the file — but surface the disagreement.
        print(f"[sidecar] label override: requested {label!r} but {file_name!r} looks like {guessed!r}")
    return guessed


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
    # True when the filename's own signature disagreed with the label the client
    # sent (the client labels by upload order). The UI should confirm before
    # treating a document as a different version than the user intended.
    label_inferred: bool = False
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
    requested_label = payload.get("label")
    file_name = payload.get("fileName", "doc.pdf")
    file_path = payload.get("filePath")
    if not file_path or not Path(file_path).exists():
        raise HTTPException(400, "label + filePath required, file must exist")
    # Infer from the filename when the caller gave no label; otherwise validate
    # and let the filename win if the two disagree.
    label = infer_label(file_name, file_path) if not requested_label \
        else _validate_doc(requested_label, file_name, file_path)
    if label is None:
        raise HTTPException(400, f"{file_name!r} 未匹配任何已支持的标准。{_ACCEPT_HELP}")
    label_inferred = requested_label != label

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
            label_inferred=label_inferred,
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
        label_inferred=label_inferred,
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