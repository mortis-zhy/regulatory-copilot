# -*- coding: utf-8 -*-
"""e2e_smoke.py — invariant smoke test for the GB 4785 report pipeline.

Asserts that the committed artifacts match known-good invariants the
third-party evaluation corroborated. On CI: regenerate first (see
.github/workflows/e2e-smoke.yml), then run this script.

Run:  python e2e_smoke.py           (project root)
       python e2e_smoke.py --regen   (force re-run verify_claims + render)
Exit 0 on all pass, 1 on any fail.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent
FACTS = ROOT / "dist" / "facts.json"
PDF = ROOT.parent / "GB4785_多版本横向对比研究报告.pdf"

# These are the EVALUATOR-CORROBORATED invariants. Any regression here means
# the bug the evaluator just caught came back. If you intentionally change a
# page, update the whitelist AND explain in the PR description.
EXPECTED_DEMOTED_PAGES = [
    ("最大离地高度",          "B24 A26"),
    ("最大离地高度",          "B32 A39"),
    ("前位灯数量",            "B37 A44"),
    ("前位灯最大离地高度",      "B37 A44"),
    ("后位灯最大离地高度",      "B39 A47"),
    ("S1或S2类制动灯数量",     "B34 A41"),
    ("非三角形后回复反射器最大离地高度", "B43 A52"),
    ("非三角形后回复反射器垂直可见度", "B43 A52"),
    ("转向信号灯首次熄灭时间",  "B33 A41"),
]

EXPECTED_SURVIVOR_NAMES = {
    "首次熄灭时间",
    "最大离地高度",      # row08 倒车灯1400
    "6V 系统电压限值",
}

def _run(label: str) -> None:
    print(f"::group::{label}")
    try:
        subprocess.run(["python", "verify_claims.py"], cwd=ROOT, check=True)
        subprocess.run(["npx", "esbuild", "server/reports/reportV6.ts",
                        "--platform=node", "--packages=external",
                        "--bundle", "--format=esm",
                        "--outfile=dist/report-v6.mjs"],
                       cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["node", "dist/report-v6.mjs"], cwd=ROOT, check=True)
        subprocess.run(["python", "add_pdf_outline.py"], cwd=ROOT, check=True)
        print("::endgroup::")
    except subprocess.CalledProcessError as e:
        print(f"::error::regen failed: {e}")
        sys.exit(2)

def _assert_facts() -> list[str]:
    fails = []
    if not FACTS.exists():
        return [f"facts.json missing — run verify_claims.py first"]
    f = json.load(open(FACTS, encoding="utf-8"))
    c = f.get("counts", {})
    expected = {"candidates": 45, "numeric": 3, "sameText": 9,
                "ruleDropped": 2, "renumbered": 1, "wordingFiltered": 30,
                "manual": 9, "topics": 24, "excerptVerified": 65, "excerptTotal": 72}
    for k, v in expected.items():
        if c.get(k) != v:
            fails.append(f"facts.counts.{k} = {c.get(k)} (expected {v})")
    # Survivors & demoted
    survivors = [s["name"] for s in f.get("numericChanges", [])]
    if len(survivors) != 3:
        fails.append(f"survivors count = {len(survivors)} (expected 3)")
    for n in EXPECTED_SURVIVOR_NAMES:
        if n not in survivors:
            fails.append(f"survivor missing: {n}")
    demoted = f.get("sameTextDropped", [])
    if len(demoted) != 9:
        fails.append(f"demoted count = {len(demoted)} (expected 9)")
    for i, (name, exp) in enumerate(EXPECTED_DEMOTED_PAGES):
        if i >= len(demoted):
            fails.append(f"demoted #{i+1} {name}: missing")
            continue
        d = demoted[i]
        bpage = re.search(r"第(\d+)页", d.get("bPage", ""))
        apage = re.search(r"第(\d+)页", d.get("aPage", ""))
        # demoted rows have empty bPage when B has no equivalent clause
        b_actual = f"B{bpage.group(1)}" if bpage else "B∅"
        a_actual = f"A{apage.group(1)}" if apage else "A∅"
        # Format expected: "B24 A26" / "B∅ A44"
        exp_norm = exp.replace(" ", "").replace("B∅", "B-").replace("A∅", "A-")
        actual = (b_actual + a_actual).replace(" ", "")
        if exp_norm != actual:
            fails.append(f"demoted #{i+1} {name}: expected {exp}, got {b_actual} {a_actual}")
    return fails

def _assert_gates() -> list[str]:
    if not PDF.exists():
        return [f"PDF missing at {PDF}"]
    fails = []
    for script in ("audit_pages.py", "render_gate.py"):
        r = subprocess.run(["python", script, str(PDF)], cwd=ROOT,
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if r.returncode != 0:
            fails.append(f"{script} exit={r.returncode}: {r.stdout[-200:]} {r.stderr[-200:]}")
    return fails

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--regen", action="store_true",
                    help="regenerate facts + PDF first")
    args = ap.parse_args()
    if args.regen:
        _run("regenerate artifacts")
    fails = []
    fails.extend(_assert_facts())
    fails.extend(_assert_gates())
    if fails:
        print(f"::error::e2e_smoke FAILED: {len(fails)} assertion(s)")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("::notice::e2e_smoke OK — all invariants hold")
    return 0

if __name__ == "__main__":
    sys.exit(main())
