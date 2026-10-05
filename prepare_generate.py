"""从三份源 PDF 抽取纯文本，构造 /api/agent/report/generate 的请求体。"""
import json
import fitz
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCES = [
    ("A", ROOT / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"),
    ("B", ROOT / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"),
    ("C", ROOT / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf"),
]

docs = []
for label, p in SOURCES:
    d = fitz.open(p)
    text = "\n\n".join(pg.get_text() for pg in d)
    docs.append({
        "label": label,
        "fileName": p.name,
        "text": text,
        "pageCount": len(d),
    })
    print(f"{label}: {p.name[:52]} | {len(d)} pages | {len(text):,} chars")
    d.close()

out = ROOT / "generate_payload.json"
json.dump({"documents": docs}, open(out, "w", encoding="utf-8"), ensure_ascii=False)
print(f"\ntotal: {sum(len(d['text']) for d in docs):,} chars -> {out.name} ({out.stat().st_size/1024/1024:.2f} MB)")