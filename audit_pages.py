# -*- coding: utf-8 -*-
"""audit_pages.py — regression gate for every hand-written page number.

Why: pages copied from a table of contents are PRINTED pages (physical - 4)
and drifted into the report 22 times before being caught (REPORT_ERRORS
ch.32). This script re-derives ground truth from the ORIGINAL PDFs with
PyMuPDF and fails (exit 1) if any citation in the source files disagrees.

Checks
  C1 heading-on-page   every page cited by chapterStructural.ts and by
                       verify_claims.py manualFindings actually carries the
                       section heading (physical PDF page, viewer numbering)
  C2 footer offset     cited pages are exactly printed_page + 4 (footer
                       number read from the page itself; WARN if no footer)
  C3 TOC completeness  the DEVICE_RENUMBERING table's (B clause -> A clause)
                       pairs == the full renumbering set derived by diffing
                       the two documents' tables of contents (no missed rows)

Run:  python audit_pages.py        (from the project root)
"""
import json
import re
import sys
import io
from pathlib import Path

import fitz

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = Path(__file__).resolve().parent
PDF_DIR = ROOT.parent
PDF_A = PDF_DIR / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf"
PDF_B = PDF_DIR / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf"

failures: list[str] = []
warnings: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)
    print(f"  [FAIL] {msg}")


def warn(msg: str) -> None:
    warnings.append(msg)
    print(f"  [WARN] {msg}")


# ---------------------------------------------------------------- fitz utils
def norm_page(doc, pno: int) -> str:
    t = doc[pno].get_text()
    t = re.sub(r"(?m)(?<=[\d.])\s*\n\s*(?=[\d.])", "", t)  # "5.\n3" -> "5.3"
    t = re.sub(r"(?<=[一-鿿])\n(?=[一-鿿])", "", t)        # CJK wrap join
    return t


def printed_page_of(doc, pno: int):
    """Printed (footer/header) page number embedded in the PDF page itself.

    A: header band 'GB 4785—XXXX\\n<printed>' at top.
    B: bottom band '<digit lines...>\\nGB4785—2019'; multi-digit numbers are
    extracted one digit per line in REVERSE order (p27 -> '3','2' = 23),
    verified against the TOC on five sample pages.
    """
    text = doc[pno].get_text()
    lines = [x.strip() for x in text.splitlines() if x.strip()]
    # A: number on its own line within the first 3 lines
    for x in lines[:3]:
        if re.fullmatch(r"\d{1,3}", x):
            return int(x)
    # B: digits immediately before the trailing GB id, reversed
    if lines and lines[-1].startswith("GB4785"):
        digits = [x for x in lines[-4:-1] if re.fullmatch(r"\d", x)]
        if digits:
            return int("".join(reversed(digits)))
    return None


# --------------------------------------------------------- parse source files
def parse_device_rows() -> list[dict]:
    src = (ROOT / "server" / "reports" / "chapterStructural.ts").read_text(encoding="utf-8")
    rows = []
    for m in re.finditer(
        r'\{\s*name:\s*"([^"]+)",\s*bNumber:\s*"([^"]+)",\s*aNumber:\s*"([^"]+)",'
        r'\s*bPage:\s*"第(\d+)页",\s*aPage:\s*"第(\d+)页"\s*\}',
        src,
    ):
        rows.append({"name": m.group(1), "bn": m.group(2), "an": m.group(3),
                     "bp": int(m.group(4)), "ap": int(m.group(5))})
    return rows


def parse_structural_rows() -> list[dict]:
    src = (ROOT / "server" / "reports" / "chapterStructural.ts").read_text(encoding="utf-8")
    block = src.split("const STRUCTURAL_CHAPTERS")[1].split("];", 1)[0]
    rows = []
    for m in re.finditer(r"\{[^{}]+\}", block):
        body = m.group(0)
        row = {"raw": body}
        for key in ("aNumber", "aTitle", "bNumber", "bTitle"):
            km = re.search(key + r':\s*"([^"]+)"', body)
            if km:
                row[key] = km.group(1)
        am = re.search(r'aPage:\s*"第(\d+)页"', body)
        bm = re.search(r'bPage:\s*"第(\d+)页"', body)
        if am:
            row["ap"] = int(am.group(1))
        if bm:
            row["bp"] = int(bm.group(1))
        rows.append(row)
    return rows


def parse_manual_pages() -> dict:
    # manualFindings moved out of verify_claims.py's source into
    # data/manual-findings.json so it could carry each source PDF's SHA-256.
    # Reading it back from the .py source would now split() to an empty block
    # and pass vacuously — worse than failing — so load the JSON and assert the
    # finding count so an emptied file fails loudly.
    mf = json.loads((ROOT / "data" / "manual-findings.json").read_text(encoding="utf-8"))
    findings = mf["findings"]
    assert findings, "data/manual-findings.json 的 findings 为空 —— 人工核验数据疑似损坏"
    # 条数不写死（写死过一次 9：新增两条就红），改为与**报告实际用的那份**对账。
    facts_path = ROOT / "dist" / "facts.json"
    if facts_path.exists():
        facts = json.loads(facts_path.read_text(encoding="utf-8"))
        n_facts = len(facts.get("manualFindings") or [])
        assert len(findings) == n_facts, (
            f"manual-findings.json 有 {len(findings)} 条，facts.json 里有 {n_facts} 条 —— "
            "两份不是同一份数据（改了其中一份）"
        )
    out = {}
    first = findings[0]
    bm = re.search(r"第(\d+)页", first.get("bPage") or "")
    am = re.search(r"第(\d+)页", first.get("aPage") or "")
    if bm:
        out["bp"] = int(bm.group(1))
    if am:
        out["ap"] = int(am.group(1))
    return out


# ------------------------------------------------- TOC truth (MinerU cleaned)
def toc_entries(text: str) -> dict:
    items = {}
    for mm in re.finditer(r"(?m)^-?\s*(\d+(?:\.\d+)*)\s+(\S[^\n…]*?)\s*[…\.]{2,}\s*(\d+)\s*$", text):
        num, title, pg = mm.group(1), mm.group(2).strip(), int(mm.group(3))
        if len(title) <= 40 and not re.match(r"^\d", title):
            items[num] = (title, pg)
    return items


def base_title(t: str) -> str:
    t = re.sub(r"[（(][^）)]*[）)]", "", t)
    return re.sub(r"\s+", "", t)


# --------------------------------------------------------------------- main
def main() -> int:
    print("=== audit_pages: ground truth from original PDFs (PyMuPDF) ===")
    docA, docB = fitz.open(PDF_A), fitz.open(PDF_B)
    m = json.load(open(ROOT / "dist" / "mineru-v4-data.json", encoding="utf-8"))
    tocA, tocB = toc_entries(m["A"]["fullText"]), toc_entries(m["B"]["fullText"])
    print(f"A: {len(docA)} pages / {len(tocA)} TOC entries | "
          f"B: {len(docB)} pages / {len(tocB)} TOC entries")

    device = parse_device_rows()
    struct = parse_structural_rows()
    manual = parse_manual_pages()
    print(f"parsed: {len(device)} device rows, {len(struct)} structural rows, "
          f"manual pages={manual}")

    # ---- C1: heading actually present on the cited physical page ----
    print("\n[C1] heading-on-page")
    for r in device:
        # B: "<clause> <name-prefix>" heading style
        bt = norm_page(docB, r["bp"] - 1)
        if not (r["bn"] in bt and base_title(r["name"])[:4] in bt):
            fail(f"B device {r['name']}: p{r['bp']} lacks '{r['bn']} {base_title(r['name'])[:4]}'")
        # A: use A-side TOC title for the target clause (names can differ,
        # e.g. AFS -> 带有自适应模式的前照灯), fall back to the table name.
        atitle = tocA.get(r["an"], (base_title(r["name"]), 0))[0]
        at = norm_page(docA, r["ap"] - 1)
        probes = {base_title(atitle)[:4], base_title(r["name"])[:4]}
        if not any(p and p in at for p in probes) and r["an"] not in at:
            fail(f"A device {r['name']}: p{r['ap']} lacks '{atitle}' / '{r['an']}'")

    for r in struct:
        if "ap" in r and "aTitle" in r:
            at = norm_page(docA, r["ap"] - 1)
            if base_title(r["aTitle"])[:6] not in at:
                fail(f"A chapter {r['aNumber']} {r['aTitle']}: p{r['ap']} lacks title")
        if "bp" in r and "bTitle" in r:
            bt = norm_page(docB, r["bp"] - 1)
            if base_title(r["bTitle"])[:4] not in bt:
                fail(f"B chapter {r['bNumber']} {r['bTitle']}: p{r['bp']} lacks title")

    if manual:
        bt = norm_page(docB, manual["bp"] - 1)
        if "5.22.2" not in bt or "数量" not in bt:
            fail(f"manual B p{manual['bp']} lacks '5.22.2 数量'")
        at = norm_page(docA, manual["ap"] - 1)
        if "5.3.2" not in at or "数量" not in at:
            fail(f"manual A p{manual['ap']} lacks '5.3.2 数量'")

    # ---- C2: printed number embedded in each cited page == physical - 4 ----
    print("[C2] printed number on cited page (physical - 4 = printed)")
    for r in device:
        for doc, p, tag in ((docB, r["bp"], f"B/{r['name']}"), (docA, r["ap"], f"A/{r['name']}")):
            f = printed_page_of(doc, p - 1)
            if f is None:
                warn(f"{tag} p{p}: no printed number found on page")
            elif f != p - 4:
                fail(f"{tag} p{p}: printed number {f}, expected {p - 4}")
    if manual:
        for doc, p, tag in ((docB, manual["bp"], "manual B"), (docA, manual["ap"], "manual A")):
            f = printed_page_of(doc, p - 1)
            if f is None:
                warn(f"{tag} p{p}: no printed number found on page")
            elif f != p - 4:
                fail(f"{tag} p{p}: printed number {f}, expected {p - 4}")
    # structural chapter pages: same offset contract
    for r in struct:
        if "ap" in r:
            f = printed_page_of(docA, r["ap"] - 1)
            if f is not None and f != r["ap"] - 4:
                fail(f"A chapter {r.get('aNumber')}: p{r['ap']} printed {f}, expected {r['ap'] - 4}")
        if "bp" in r:
            f = printed_page_of(docB, r["bp"] - 1)
            if f is not None and f != r["bp"] - 4:
                fail(f"B chapter {r.get('bNumber')}: p{r['bp']} printed {f}, expected {r['bp'] - 4}")

    # ---- C3: table completeness vs TOC diff ----
    print("[C3] TOC diff completeness")
    aliases = {"自适应前照明系统": "带有自适应模式的前照灯"}  # B title -> A title
    expected = set()
    missing_in_a = []
    for num, (title, _pg) in tocB.items():
        if not num.startswith("5."):
            continue
        want = aliases.get(base_title(title), base_title(title))
        a_num = None
        for an, (at, _p) in tocA.items():
            # A may re-home a B 5.x device under any chapter (7.x 扩展功能
            # for 危险警告/紧急制动/追尾警告), so search every A clause.
            if base_title(at) == want:
                a_num = an
                break
        if a_num is None:
            missing_in_a.append((num, title))
            continue
        if a_num != num:
            expected.add((num, a_num))
    table_pairs = {(r["bn"], r["an"]) for r in device}
    print(f"  TOC-derived renumberings: {len(expected)} | table: {len(table_pairs)}")
    for pair in sorted(expected - table_pairs):
        fail(f"missing renumbering row in DEVICE_RENUMBERING: {pair}")
    for pair in sorted(table_pairs - expected):
        fail(f"table row not supported by TOC diff: {pair}")
    for num, title in missing_in_a:
        fail(f"B device {num} {title} has no A counterpart (dropped?)")

    # page numbers must at least exist in TOC as printed pages
    for r in device:
        tb, ta = tocB.get(r["bn"]), tocA.get(r["an"])
        if tb and tb[1] + 4 != r["bp"]:
            fail(f"{r['name']} B: TOC printed {tb[1]} -> expected physical {tb[1] + 4}, table says {r['bp']}")
        if ta and ta[1] + 4 != r["ap"]:
            fail(f"{r['name']} A: TOC printed {ta[1]} -> expected physical {ta[1] + 4}, table says {r['ap']}")
    for r in struct:
        if "ap" in r and r.get("aNumber") in tocA:
            tp = tocA[r["aNumber"]][1]
            if tp + 4 != r["ap"]:
                fail(f"A chapter {r['aNumber']}: TOC printed {tp} -> expected {tp + 4}, table says {r['ap']}")
        if "bp" in r and r.get("bNumber") in tocB:
            tp = tocB[r["bNumber"]][1]
            if tp + 4 != r["bp"]:
                fail(f"B chapter {r['bNumber']}: TOC printed {tp} -> expected {tp + 4}, table says {r['bp']}")

    # ---- C4: facts.json value rows — cited pages must carry their values ----
    # Gates the clause-anchored page fixes (ch11.3 numeric + 11.3.1 manual)
    # against regression: every cited page must contain a distinctive token
    # from the row's own value string.
    print("[C4] facts numeric/manual cited pages contain their values")
    facts = json.load(open(ROOT / "dist" / "facts.json", encoding="utf-8"))

    def distinctive_needles(s: str) -> list[str]:
        s = s or ""
        nums = [n for n in re.findall(r"\d+(?:\.\d+)?", s) if len(n) >= 2 or "." in n]
        if nums:
            return nums
        # 没有有辨识度的数字（"两只"、"表5 醒目标志：…"）→ 取正文里的一段中文。
        # 先剥掉「A 5.8.2 数量：」这类前缀（版本号 + 条款号 + 小标题）——
        # 不剥的话针子带着前缀，源 PDF 上永远找不到，而那是**检查器自己**的错。
        body = re.sub(r"^\s*[ABC]\s*", "", s)
        body = re.sub(r"^(附录[^\s：:]*|表\s*\d+|\d+(?:\.\d+)*[a-z]?)\s*", "", body)
        body = re.sub(r"^[^：:]{0,14}[：:]\s*", "", body)
        cjk = re.findall(r"[一-鿿]{4,}", body)
        if cjk:
            return [cjk[0][:8]]
        return [body[:8]] if len(body) >= 4 else []

    def check_value_rows(rows: list, label: str) -> None:
        for i, c in enumerate(rows, 1):
            for side, doc, key, vkey in (
                ("B", docB, "bPage", "oldValue"),
                ("A", docA, "aPage", "newValue"),
            ):
                m = re.search(r"第(\d+)页", c.get(key) or "")
                if not m:
                    continue
                pno = int(m.group(1))
                needles = distinctive_needles(c.get(vkey, ""))
                if not needles:
                    continue
                txt = norm_page(doc, pno - 1)
                if not any(n in txt for n in needles):
                    fail(f"C4 {label} #{i} {c.get('name', '')} {side} p{pno}: none of {needles[:3]} present")

    check_value_rows(facts.get("numericChanges", []), "numeric")
    check_value_rows(facts.get("manualFindings", []), "manual")

    print(f"\n=== result: {len(failures)} failure(s), {len(warnings)} warning(s) ===")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
