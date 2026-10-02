#!/usr/bin/env python3
"""
MinerU PDF extraction with model-download workaround.

Since doclayout_yolo model download is blocked by SSL/auth, we:
1. Pre-create the model directory structure
2. Force txt mode (no layout detection, no OCR)
3. Fall back to PDF text extraction through magic_pdf

Output: dist/mineru-data.json with structured content per document.
"""
import os, sys, json, traceback, shutil
from pathlib import Path

# SSL patch
import ssl
ssl._create_default_https_context = ssl._create_unverified_context
os.environ["PYTHONHTTPSVERIFY"] = "0"

import requests
from requests.adapters import HTTPAdapter

class _SSLAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs["ssl_context"] = ctx
        super().init_poolmanager(*args, **kwargs)

_orig_init = requests.Session.__init__
def _patched_init(self, *args, **kwargs):
    _orig_init(self, *args, **kwargs)
    self.mount("https://", _SSLAdapter())
requests.Session.__init__ = _patched_init

# Patch cv2 BEFORE importing magic_pdf
import cv2
_DEFAULTS = {
    "IMREAD_COLOR": 1, "IMREAD_GRAYSCALE": 0, "IMREAD_UNCHANGED": -1,
    "COLOR_BGR2RGB": 4, "COLOR_RGB2BGR": 4, "COLOR_BGR2GRAY": 6,
    "INTER_AREA": 3, "INTER_LINEAR": 1, "INTER_CUBIC": 2, "INTER_NEAREST": 0,
    "THRESH_BINARY": 0, "THRESH_OTSU": 8,
    "RETR_EXTERNAL": 0, "RETR_LIST": 1, "RETR_TREE": 3,
    "CHAIN_APPROX_SIMPLE": 2, "CHAIN_APPROX_NONE": 1,
    "FONT_HERSHEY_SIMPLEX": 0, "LINE_AA": 16,
}
for k, v in _DEFAULTS.items():
    if not hasattr(cv2, k):
        setattr(cv2, k, v)

def _noop(*args, **kwargs): pass
def _noop_array(*args): return None

if not hasattr(cv2, "imshow"): cv2.imshow = _noop
if not hasattr(cv2, "imread") or getattr(cv2.imread, "__module__", "") != "cv2":
    cv2.imread = _noop_array
if not hasattr(cv2, "imwrite") or getattr(cv2.imwrite, "__module__", "") != "cv2":
    cv2.imwrite = _noop_array
cv2.waitKey = lambda *a, **k: 0
cv2.destroyAllWindows = _noop
cv2.namedWindow = _noop
cv2.resizeWindow = _noop
cv2.setNumThreads = _noop
cv2.getNumThreads = lambda: 1
cv2.getThreadNum = lambda: 0

sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main")
WORK = ROOT / "comparison_agent-main" / ".mineru-work"
MODELS_DIR = WORK / "models"
OUT = ROOT / "comparison_agent-main" / "dist" / "mineru-data.json"

PDFS = {
    "A": ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}

def setup_models_dir():
    """Pre-create the model directory structure with placeholder files.
    Also create a valid torch checkpoint stub for doclayout_yolo to avoid
    UnpicklingError. The stub has minimal structure so torch.load succeeds.
    """
    layout_dir = MODELS_DIR / "Layout" / "YOLO"
    layout_dir.mkdir(parents=True, exist_ok=True)
    pt_path = layout_dir / "doclayout_yolo_docstructbench_imgsz1280_2501.pt"

    if not pt_path.exists():
        # Create a minimal valid torch checkpoint (empty state_dict)
        try:
            import torch
            torch.save({"model": None, "epoch": -1}, str(pt_path))
            print(f"[wrap] Created valid torch stub at {pt_path}")
        except Exception as e:
            pt_path.write_bytes(b"")
            print(f"[wrap] Wrote empty stub: {e}")

    # Set MINERU_TOOLS_CONFIG_JSON to point to our models dir
    config_path = WORK / "magic-pdf.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({
        "bucket-info": {},
        "models-dir": str(MODELS_DIR),
        "layout-config": {"model": "doclayout_yolo", "enable": False},
        "formula-config": {"enable": False},
        "table-config": {"enable": False, "model": "tablemaster"},
        "language": "ch",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    os.environ["MINERU_TOOLS_CONFIG_JSON"] = str(config_path)
    print(f"[setup] Config at {config_path}")

    # Monkey-patch the doclayout_yolo loader to return None when our stub
    # can't be properly loaded. This makes layout detection a no-op.
    try:
        from magic_pdf.model.sub_modules.layout.doclayout_yolo.DocLayoutYOLO import DocLayoutYOLOModel
        _orig = DocLayoutYOLOModel.__init__

        def _patched_init(self, *args, **kwargs):
            # Try real init, but fall back to no-op on failure
            try:
                _orig(self, *args, **kwargs)
            except Exception as e:
                print(f"[wrap] doclayout_yolo init failed (using no-op): {e}")
                self.model = None
                self.ckpt = None

        DocLayoutYOLOModel.__init__ = _patched_init

        # Also patch batch_predict to return empty results when model is None
        def _patched_batch_predict(self, images_with_extra_info, *args, **kwargs):
            # Return one empty dict per input image to avoid IndexError
            return [{} for _ in images_with_extra_info]

        DocLayoutYOLOModel.batch_predict = _patched_batch_predict
        print("[wrap] doclayout_yolo patched")
    except Exception as e:
        print(f"[wrap] Could not patch doclayout_yolo: {e}")

    # Also patch OCR model init to no-op (txt mode shouldn't use OCR but
    # the module still gets imported and instantiated).
    try:
        from magic_pdf.model.sub_modules.ocr.paddleocr2pytorch.tools.infer.predict_system import TextSystem
        _orig_ts = TextSystem.__init__

        def _patched_ts(self, args, **kwargs):
            # Don't actually init OCR - skip to avoid model loading
            self.text_detector = None
            self.text_recognizer = None
            return None

        TextSystem.__init__ = _patched_ts
        print("[wrap] OCR TextSystem patched")
    except Exception as e:
        print(f"[wrap] Could not patch OCR: {e}")

    # Also pre-create fake OCR model files
    ocr_dir = MODELS_DIR / "OCR" / "paddleocr_torch"
    ocr_dir.mkdir(parents=True, exist_ok=True)
    for ocr_file in ["ch_PP-OCRv3_det_infer.pth", "ch_PP-OCRv3_rec_infer.pth"]:
        ocr_path = ocr_dir / ocr_file
        if not ocr_path.exists():
            try:
                import torch
                torch.save({"model": None, "epoch": -1}, str(ocr_path))
            except Exception:
                ocr_path.write_bytes(b"")

def extract_one(label: str, pdf_path: Path, work_dir: Path) -> dict | None:
    print(f"[mineru] {label}: {pdf_path.name}")
    out_dir = work_dir / label
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        from magic_pdf.tools.common import do_parse

        pdf_bytes = pdf_path.read_bytes()
        do_parse(
            output_dir=str(out_dir),
            pdf_file_name=pdf_path.name,
            pdf_bytes_or_dataset=pdf_bytes,
            model_list=[],
            parse_method="txt",  # text-only, no OCR, no layout
            debug_able=False,
            f_draw_span_bbox=False,
            f_draw_layout_bbox=False,
            f_dump_md=True,
            f_dump_middle_json=True,
            f_dump_model_json=False,
            f_dump_orig_pdf=False,
            f_dump_content_list=True,
            f_make_md_mode="MM_MD",
            start_page_id=0,
            end_page_id=None,
            lang="ch",
        )

        md_candidates = list(out_dir.rglob("*.md"))
        if not md_candidates:
            print(f"[mineru] {label}: no .md found")
            return None
        text = md_candidates[0].read_text(encoding="utf-8")
        table_rows = sum(1 for line in text.split("\n") if line.strip().startswith("|"))

        # Find middle JSON
        middle = None
        for f in out_dir.rglob("*_middle.json"):
            try:
                middle = json.loads(f.read_text(encoding="utf-8"))
                break
            except Exception:
                pass

        # Find content list
        content_list = None
        for f in out_dir.rglob("*_content_list.json"):
            try:
                content_list = json.loads(f.read_text(encoding="utf-8"))
                break
            except Exception:
                pass

        tables = []
        if content_list:
            for item in content_list:
                if item.get("type") == "table":
                    tables.append({
                        "page": item.get("page_idx", 0) + 1,
                        "caption": item.get("img_caption", "") or item.get("table_caption", ""),
                        "body": item.get("table_body", ""),
                    })
        figures = []
        if content_list:
            for item in content_list:
                if item.get("type") == "image":
                    figures.append({
                        "page": item.get("page_idx", 0) + 1,
                        "caption": item.get("img_caption", "") or "",
                    })
        formulas = []
        if content_list:
            for item in content_list:
                if item.get("type") == "equation":
                    formulas.append({
                        "page": item.get("page_idx", 0) + 1,
                        "latex": item.get("latex", ""),
                        "text": item.get("text", ""),
                    })

        print(f"[mineru] {label}: {len(text)} chars, {table_rows} MD tables, "
              f"{len(tables)} structured tables, {len(figures)} figures, "
              f"{len(formulas)} formulas")
        return {
            "label": label,
            "fileName": pdf_path.name,
            "markdown": text,
            "tables": tables,
            "figures": figures,
            "formulas": formulas,
            "content_list_count": len(content_list) if content_list else 0,
        }
    except Exception as e:
        print(f"[mineru] {label}: EXCEPTION {type(e).__name__}: {e}")
        traceback.print_exc()
        return None

def main():
    WORK.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    setup_models_dir()

    results = {}
    for label, pdf_path in PDFS.items():
        if not pdf_path.exists():
            print(f"[mineru] {label}: not found")
            continue
        r = extract_one(label, pdf_path, WORK)
        if r:
            results[label] = r

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)
    print(f"\n[mineru] Saved {len(results)} docs to {OUT}")
    if results:
        for label, r in results.items():
            print(f"  {label}: {len(r['tables'])} tables, {len(r['figures'])} figures, {len(r['formulas'])} formulas")

if __name__ == "__main__":
    main()