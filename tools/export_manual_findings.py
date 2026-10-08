"""One-shot export: pull the hardcoded manualFindings list out of verify_claims.py
into data/manual-findings.json, together with the SHA-256 of the three source PDFs.

Run once, then delete. Afterwards run_verify() reads the JSON and marks entries
待重核 whenever a source PDF's hash no longer matches.
"""
import ast
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTER = ROOT.parent

src = (ROOT / "verify_claims.py").read_text(encoding="utf-8")
# "manualFindings" appears three times (the literal, the facts.json projection,
# and the counts block). The literal is the one followed by `[` on the same line.
m = re.search(r'"manualFindings":\s*\[', src)
if not m:
    raise SystemExit('could not locate the manualFindings list literal')
list_src = src[m.end() - 1 :]
# It is the final key of the dict, so terminate on the matching "],\n    }".
end = list_src.index("\n        ],")
list_src = list_src[: end + len("\n        ]")]

findings = ast.literal_eval(list_src)
print(f"parsed {len(findings)} findings")

def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()

PDFS = {
    "A": OUTER / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": OUTER / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": OUTER / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}
sources = {}
for label, p in PDFS.items():
    if not p.exists():
        raise SystemExit(f"missing source PDF: {p}")
    sources[label] = {"fileName": p.name, "sha256": sha256(p)}
    print(f"  {label}: {sources[label]['sha256'][:16]}  {p.name}")

payload = {
    "_comment": (
        "manualFindings 是人工核验结论（AFS 数量、慢行灯 10→15 km/h 等），"
        "18 主题 diff 管线不覆盖这些条款，故需人工补录。每条都带原文页码。"
        "run_verify() 会比对下方 sources 的 SHA-256；任一源 PDF 变更后，"
        "所有条目自动降级为「待重核」并附 staleReason，避免旧页码被当成已验证事实。"
    ),
    "version": 1,
    "sources": sources,
    "findings": findings,
}

out = ROOT / "data" / "manual-findings.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes, {len(findings)} findings)")