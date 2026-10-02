#!/usr/bin/env python3
"""
Download remaining MinerU v4 model files and run extraction via SDK.
"""
import ssl, os, urllib.request, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ssl._create_default_https_context = ssl._create_unverified_context

REPO = "opendatalab/MinerU-4_models_torch"
BRANCH = "main"
OUT_DIR = r"C:\Users\zsndz\Desktop\comparison_agent-main\.mineru-models"

FILES = [
    # Layout (already downloaded)
    # "Layout/PP-DocLayoutV2/model.safetensors",  # 204MB - DONE
    # "Layout/PP-DocLayoutV2/config.json",
    # "Layout/PP-DocLayoutV2/inference.yml",
    # "Layout/PP-DocLayoutV2/preprocessor_config.json",
    # MFR (formulas)
    "MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M.pth",  # 588 MB
    "MFR/pp_formulanet_plus_m/PP-FormulaNet_plus-M_inference.yml",
    # OCR
    "OCR/paddleocr/ch_PP-OCRv6_small_rec_infer.safetensors",  # 20 MB
    "OCR/paddleocr/ch_PP-OCRv6_tiny_det_infer.safetensors",  # 1 MB
    "OCR/paddleocr/seal_PP-OCRv4_det_infer.pth",  # 13 MB
    # Table
    "Table/PP-LCNet_x1_0_table_cls.onnx",  # 6 MB
    "Table/slanet-plus.onnx",  # 7 MB
    "Table/unet.onnx",  # 7 MB
]

def download(rel_path: str):
    local = os.path.join(OUT_DIR, rel_path.replace("/", os.sep))
    if os.path.exists(local) and os.path.getsize(local) > 0:
        print(f"  SKIP {rel_path} ({os.path.getsize(local)//1024//1024} MB)")
        return
    os.makedirs(os.path.dirname(local), exist_ok=True)
    url = f"https://huggingface.co/{REPO}/resolve/{BRANCH}/{rel_path}?download=true"
    print(f"  GET  {rel_path} -> {os.path.dirname(local)}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, context=ssl._create_unverified_context(), timeout=300) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            print(f"    size: {total//(1024*1024)} MB")
            with open(local, "wb") as f:
                downloaded = 0
                last_print = 0
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if downloaded - last_print >= 50 * 1024 * 1024:
                        print(f"    {downloaded//(1024*1024)} MB / {total//(1024*1024)} MB")
                        last_print = downloaded
            print(f"    OK {os.path.getsize(local)//(1024*1024)} MB")
    except Exception as e:
        print(f"    FAIL: {type(e).__name__}: {str(e)[:200]}")

def main():
    print(f"Output dir: {OUT_DIR}")
    print(f"Downloading {len(FILES)} files...")
    total = 0
    for f in FILES:
        download(f)
    # Count total
    for root, dirs, files in os.walk(OUT_DIR):
        for f in files:
            fp = os.path.join(root, f)
            total += os.path.getsize(fp)
    print(f"\nTotal cached: {total//(1024//1024)} MB in {OUT_DIR}")

if __name__ == "__main__":
    main()