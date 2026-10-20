# -*- coding: utf-8 -*-
"""试跑候选正则：在 MinerU 语料与源 PDF 语料上各跑一遍，报告命中、取值、页码。

写 spec 之前先跑这个 —— 「正则在脑子里对」和「正则真的命中正确的值」是两回事。

用法：改下面的 CANDIDATES 再 python scripts/try_pattern.py
"""
import io, json, os, re, glob, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
C = json.load(io.open(os.path.join(ROOT, "dist", "mineru-v4-data.json"), encoding="utf-8"))

# 源 PDF 语料（与 parameterMatrix.ts 的 loadSourceCorpus 一致：去掉换行）
SRC = {}
try:
    import fitz
    for p in sorted(glob.glob(os.path.join(ROOT, "uploaded-docs", "*.pdf"))):
        d = fitz.open(p)
        head = "".join(d[i].get_text() for i in range(min(3, d.page_count)))
        flat = re.sub(r"\s+", "", head)
        nodash = re.sub(r"[—–‐‑‒−-]", "", flat)
        if "UnitedNationsRegulations" in nodash or "AgreementConcerning" in nodash:
            v = "C"
        elif "4785XXXX" in nodash:
            v = "A"
        elif "47852019" in nodash:
            v = "B"
        else:
            d.close()
            continue
        SRC[v] = [(i + 1, d[i].get_text().replace("\n", "")) for i in range(d.page_count)]
        d.close()
except Exception as e:
    print("源 PDF 读不到：", e)


def mineru_pages(v):
    ft = C[v]["fullText"]
    parts = re.split(r"\[第(\d+)页\]", ft)
    return [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts), 2)]


def run(v, pat):
    rx = re.compile(pat, re.I)
    for tag, pages in (("MinerU", mineru_pages(v)), ("源PDF", SRC.get(v, []))):
        for pg, t in pages:
            m = rx.search(t)
            if m:
                focus = m.group(1) if m.lastindex and m.group(1) is not None else m.group(0)
                nums = re.findall(r"\d+(?:\.\d+)?", focus.replace(",", ""))
                return {"tag": tag, "page": pg, "focus": focus[:120], "nums": nums}
    return None


CANDIDATES = json.load(io.open(os.path.join(ROOT, "scripts", "_candidates.json"), encoding="utf-8")) \
    if os.path.exists(os.path.join(ROOT, "scripts", "_candidates.json")) else {}

if __name__ == "__main__":
    for cid, vers in CANDIDATES.items():
        print("=" * 88)
        print("##", cid)
        for v, pat in vers.items():
            r = run(v, pat)
            if not r:
                print("   %s  ✗ 没命中" % v)
            else:
                print("   %s  ✓ %s p%d  nums=%s" % (v, r["tag"], r["page"], r["nums"]))
                print("        %s" % r["focus"][:150])
