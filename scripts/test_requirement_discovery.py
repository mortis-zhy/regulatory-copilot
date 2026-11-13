# -*- coding: utf-8 -*-
"""冷启动要求候选的已知答案；不读案例数据，不调用模型。"""
from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import fitz

from requirement_discovery import discover, discover_pdf, extract_page, parse_pages, validate_discovery

HERE = Path(__file__).resolve().parent


def snapshot(number, text="", **extra):
    return {
        "number": number, "selected": True,
        "blocks": [{"text": text, "bbox": [0, 0, 500, 700]}] if text else [],
        "images": [], "vectorPaths": 0, "errors": [], **extra,
    }


def run_discovery(pages, version="revision-X"):
    return discover({
        "fileName": "unseen.pdf", "sha256": "a" * 64,
        "version": version, "versionOrigin": "caller-supplied",
        "pageCount": len(pages),
        "selectedPages": [p["number"] for p in pages if p["selected"]],
    }, pages)


class DiscoveryTests(unittest.TestCase):
    def test_chapter_preamble_and_parent_conditions_are_source_bound(self):
        result = run_discovery([snapshot(1,
            "3.9 Prior clause\nThe old device shall close.\n"
            "4.\nGENERAL REQUIREMENTS\nAll lamps shall meet these requirements.\n"
            "4.1 Measurements shall be made:\n"
            "4.1.1 For sealed lamps, with the sources present.\n"
            "5.\nOTHER REQUIREMENTS\nAll relays shall be tested.\n"
            "5.1 The relay shall open.\n")])
        child = next(c for c in result["candidates"] if c["clause"] == "4.1.1")
        self.assertEqual([p["clause"] for p in child["context"]], ["4", "4.1"])
        self.assertIn("parent_requirement_context", child["reasons"])
        prior = next(c for c in result["candidates"] if c["clause"] == "3.9")
        self.assertNotIn("GENERAL REQUIREMENTS", prior["quote"])
        following = next(c for c in result["candidates"] if c["clause"] == "5.1")
        self.assertEqual([p["clause"] for p in following["context"]], ["5"])
        self.assertIsNone(child["conditions"])
        changed = copy.deepcopy(result)
        next(c for c in changed["candidates"] if c["clause"] == "4.1.1")["context"][0]["evidence"][0]["page"] = 99
        with self.assertRaises(ValueError):
            validate_discovery(changed)

    def test_parent_context_does_not_cross_unselected_page_gap(self):
        result = run_discovery([snapshot(1, "4.1 Measurements shall be made:\n"),
                                {"number": 2, "selected": False},
                                snapshot(3, "4.1.1 The lamp must open.\n")])
        self.assertEqual(result["candidates"][-1]["context"], [])

    def test_legal_effect_and_reference_only_requirements_remain_unverified(self):
        result = run_discovery([snapshot(1,
            "4.1 Approval\nThe devices are deemed approved for the alternative function.\n"
            "4.2 Scope\nOutside the range specified in paragraph 5.; and\n"
            "4.3 Method\nParticulars are given in Annex 3.\n"
            "4.4 认可\n此类装置视同获得批准。\n")])
        self.assertEqual(len(result["candidates"]), 4)
        self.assertIn("legal_effect_token", result["candidates"][0]["reasons"])
        self.assertIn("cross_reference", result["candidates"][1]["reasons"])
        self.assertIn("cross_reference", result["candidates"][2]["reasons"])
        self.assertIn("legal_effect_token", result["candidates"][3]["reasons"])
        self.assertTrue(all(c["conditions"] is None and c["subject"] is None
                            and c["semantics"]["status"] == "unverified"
                            for c in result["candidates"]))

    def test_unknown_parameter_and_first_chapters_are_not_filtered(self):
        result = run_discovery([snapshot(1,
            "1.1 New requirement\nThe connector shall latch automatically.\n"
            "2.1 Special requirement\nIf wet, the relay must not energize.\n")])
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(result["source"]["version"], "revision-X")
        self.assertTrue(all(c["semantics"]["status"] == "unverified"
                            for c in result["candidates"]))
        self.assertTrue(all(c["subject"] is None for c in result["candidates"]))
        self.assertTrue(all(c["evidenceStatus"] == "located" for c in result["candidates"]))

    def test_chinese_conditions_and_comparators_are_not_guessed(self):
        result = run_discovery([snapshot(1,
            "4.1 特殊要求\n当开关断开时，装置不得启动；例外情况应记录。\n"
            "4.2 尺寸\n除另有规定外，高度应不大于 250 mm。\n")])
        self.assertEqual(len(result["candidates"]), 2)
        candidate = result["candidates"][1]
        self.assertIn({"value": 250.0, "unit": "mm"}, candidate["quantities"])
        self.assertIsNone(candidate["conditions"])
        self.assertIsNone(candidate["comparator"])
        self.assertIn("除另有规定外", candidate["quote"])

    def test_cross_page_clause_has_evidence_on_both_pages(self):
        result = run_discovery([
            snapshot(1, "4.1 Operating condition\nUnless otherwise specified,\n"),
            snapshot(2, "the signal shall remain active for two seconds.\n4.2 Other\nDescription.\n"),
        ])
        candidate = result["candidates"][0]
        self.assertEqual({e["page"] for e in candidate["evidence"]}, {1, 2})
        self.assertIn({"value": 2.0, "unit": "s"}, candidate["quantities"])
        validate_discovery(result)

    def test_no_trigger_does_not_erase_text_or_claim_absence(self):
        result = run_discovery([snapshot(1, "Overview of equipment.\nA general description.\n")])
        self.assertEqual(result["candidates"], [])
        self.assertEqual(result["summary"]["textFragments"], 2)
        self.assertTrue(all(r["disposition"] == "scanned_without_candidate"
                            for r in result["ledger"]))
        self.assertEqual(result["run"]["status"], "complete")
        self.assertFalse(result["claims"]["requirementsComplete"])
        self.assertFalse(result["claims"]["semanticallyVerified"])

    def test_duplicate_numbers_are_distinct_occurrences(self):
        result = run_discovery([
            snapshot(1, "4.1 First\nThe device shall open.\n"),
            snapshot(2, "4.1 Second\nThe device shall close.\n"),
        ])
        self.assertEqual(len(result["candidates"]), 2)
        self.assertNotEqual(result["candidates"][0]["id"], result["candidates"][1]["id"])
        self.assertEqual(len({e["fragmentId"] for c in result["candidates"]
                              for e in c["evidence"]}), 4)

    def test_unnumbered_text_and_table_numbers_are_retained(self):
        result = run_discovery([snapshot(1,
            "Table 1 - test classes\nClass X 10 20\nClass Y 30 40\n"
            "The housing must remain closed.\n")])
        self.assertGreater(len(result["candidates"]), 0)
        self.assertEqual(result["summary"]["textFragments"], 4)
        self.assertTrue(any(x["kind"] == "table_context" for x in result["limitations"]))
        self.assertEqual(result["run"]["status"], "partial")
        self.assertTrue(all(c["subject"] is None for c in result["candidates"]))

    def test_graphics_and_no_text_are_explicit_not_zero_requirements(self):
        result = run_discovery([snapshot(1, images=[{"bbox": [1, 2, 30, 40],
                                                   "width": 100, "height": 100}],
                                           vectorPaths=7)])
        kinds = {f["kind"] for f in result["fragments"]}
        self.assertTrue({"image", "vector_graphics", "no_text"}.issubset(kinds))
        self.assertEqual(result["run"]["status"], "partial")
        self.assertTrue(all(r["disposition"] == "unsupported" for r in result["ledger"]))

    def test_formulas_are_registered_not_silently_solved(self):
        result = run_discovery([snapshot(1, "4.1 Formula\nThe value shall satisfy x = a / b.\n")])
        self.assertTrue(any(x["kind"] == "formula_context" for x in result["limitations"]))
        self.assertEqual(result["run"]["status"], "partial")

    def test_outside_pages_and_selection_gaps_are_explicit(self):
        result = run_discovery([
            snapshot(1, "4.1 First\nThe switch shall open.\n"),
            snapshot(2, selected=False),
            snapshot(3, "The housing must close.\n"),
        ])
        self.assertEqual(result["pages"][1]["state"], "not_processed")
        self.assertEqual(result["summary"]["outsidePages"], 1)
        self.assertTrue(all(len({e["page"] for e in c["evidence"]}) == 1
                            for c in result["candidates"]))
        self.assertIsNone(result["candidates"][-1]["clause"])

    def test_parse_failure_is_not_successful_empty_result(self):
        failed = snapshot(1, errors=[{"operation": "text", "error": "test failure"}])
        result = run_discovery([failed])
        self.assertEqual(result["run"]["status"], "failed")
        self.assertEqual(result["ledger"][0]["disposition"], "parse_failed")
        partial = run_discovery([failed, snapshot(2, "The relay shall open.\n")])
        self.assertEqual(partial["run"]["status"], "partial")
        self.assertEqual(len(partial["candidates"]), 1)

    def test_evidence_and_ledger_tampering_are_rejected(self):
        original = run_discovery([snapshot(1, "The relay shall open.\n")])
        for mutate in (
            lambda r: r["candidates"][0]["evidence"][0].update(quote="fabricated"),
            lambda r: r["candidates"][0]["evidence"][0].update(page=2),
            lambda r: r["candidates"][0].update(quote="fabricated"),
            lambda r: r["ledger"].pop(),
            lambda r: r["summary"].update(candidates=99),
            lambda r: r["pages"][0]["fragmentIds"].clear(),
        ):
            with self.subTest(mutate=mutate):
                changed = copy.deepcopy(original)
                mutate(changed)
                with self.assertRaises(ValueError):
                    validate_discovery(changed)

    def test_core_results_are_deterministic_and_source_bound(self):
        pages = [snapshot(1, "The relay shall open.\n")]
        first = run_discovery(pages)
        self.assertEqual(first, run_discovery(copy.deepcopy(pages)))
        self.assertNotEqual(first["candidates"][0]["id"],
                            run_discovery(pages, version="revision-Y")["candidates"][0]["id"])

    def test_page_status_tampering_cannot_hide_unsupported_content(self):
        result = run_discovery([snapshot(1, "The relay shall open.", vectorPaths=2)])
        changed = copy.deepcopy(result)
        changed["pages"][0]["state"] = "scanned"
        changed["summary"]["pageStates"] = {"scanned": 1}
        changed["run"]["status"] = "complete"
        with self.assertRaises(ValueError):
            validate_discovery(changed)

    def test_each_metadata_extraction_failure_is_recorded(self):
        for operation, method in (("text", "get_text"), ("images", "get_image_info"),
                                  ("vectors", "get_drawings"), ("tables", "find_tables")):
            with self.subTest(operation=operation):
                page = Mock()
                page.get_text.return_value = [(0, 0, 20, 20, "The relay shall open.", 0, 0)]
                page.get_image_info.return_value = []
                page.get_drawings.return_value = []
                page.find_tables.return_value.tables = []
                getattr(page, method).side_effect = RuntimeError("test " + operation)
                result = run_discovery([extract_page(page, 1)])
                self.assertIn(result["run"]["status"], ("partial", "failed"))
                self.assertTrue(any(f["kind"] == "extraction_error" and f["operation"] == operation
                                    for f in result["fragments"]))

    def test_symbols_and_exceptions_remain_in_source_not_inferred_fields(self):
        result = run_discovery([snapshot(1,
            "4.1 Dimension\nExcept for class X, the gap shall be >= 3 mm and < 5 mm.\n")])
        candidate = result["candidates"][0]
        self.assertIn(">= 3 mm and < 5 mm", candidate["quote"])
        self.assertIn("Except for class X", candidate["quote"])
        self.assertEqual(candidate["quantities"], [{"value": 3.0, "unit": "mm"}, {"value": 5.0, "unit": "mm"}])
        self.assertIsNone(candidate["comparator"])
        self.assertIsNone(candidate["conditions"])

    def test_page_ranges_validate_instead_of_clipping(self):
        self.assertEqual(parse_pages(None, 5), [1, 2, 3, 4, 5])
        self.assertEqual(parse_pages("1,3-4", 5), [1, 3, 4])
        for spec in ("", "0", "6", "3-1", "1,,2", "x", "1-2-3", "-1"):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                parse_pages(spec, 5)


class PdfCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="requirement-discovery-test-")
        self.root = Path(self.tmp.name)
        self.pdf = self.root / "new-standard.pdf"
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 72), "4.1 New rule\nThe relay shall open after 2 s.")
            page = doc.new_page()
            page.insert_text((72, 72), "4.2 Other rule\nThe housing must remain closed.")
            doc.save(self.pdf)

    def tearDown(self):
        self.tmp.cleanup()

    def cli(self, out="output", extra=(), script=None):
        return subprocess.run([
            sys.executable, "-B", str(script or HERE / "discover_requirements.py"),
            "--pdf", str(self.pdf), "--version", "unknown-revision",
            "--out", str(self.root / out), *extra,
        ], cwd=self.root, capture_output=True, text=True, encoding="utf-8")

    def test_real_pdf_cli_writes_both_outputs_with_correct_fingerprint(self):
        process = self.cli()
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        result = json.loads((self.root / "output/discovery.json").read_text(encoding="utf-8"))
        self.assertEqual(result["source"]["sha256"], hashlib.sha256(self.pdf.read_bytes()).hexdigest())
        self.assertEqual(result["summary"]["candidates"], 2)
        self.assertTrue((self.root / "output/review.md").is_file())
        validate_discovery(result)

    def test_cli_runs_with_no_case_files_present(self):
        scripts = self.root / "isolated/scripts"
        scripts.mkdir(parents=True)
        for name in ("requirement_discovery.py", "discover_requirements.py",
                     "clause_split.py", "versions.py", "limit_scan.py"):
            shutil.copyfile(HERE / name, scripts / name)
        process = self.cli(script=scripts / "discover_requirements.py")
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertFalse((scripts.parent / "data").exists())
        self.assertFalse((scripts.parent / "dist").exists())
        self.assertFalse((scripts.parent / "reports").exists())

    def test_output_conflict_cannot_overwrite_previous_results(self):
        first = self.cli()
        self.assertEqual(first.returncode, 0, first.stderr)
        before = (self.root / "output/discovery.json").read_bytes()
        second = self.cli()
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual((self.root / "output/discovery.json").read_bytes(), before)

    def test_invalid_pdf_range_and_missing_source_fail(self):
        process = self.cli(extra=("--pages", "999"))
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / "output").exists())
        self.pdf.write_bytes(b"not a PDF")
        process = self.cli()
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / "output").exists())
        self.pdf.unlink()
        self.assertNotEqual(self.cli().returncode, 0)

    def test_protected_output_is_rejected(self):
        process = self.cli(out=str(HERE.parent / "data" / "discovery-test-must-not-exist"))
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((HERE.parent / "data/discovery-test-must-not-exist").exists())

    def test_independent_documents_do_not_reuse_results(self):
        self.assertEqual(self.cli().returncode, 0)
        original = (self.root / "output/discovery.json").read_bytes()
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 72), "The valve must close at 3 mm.")
            doc.save(self.root / "other.pdf")
        self.pdf = self.root / "other.pdf"
        self.assertEqual(self.cli(out="other-output").returncode, 0)
        result = json.loads((self.root / "other-output/discovery.json").read_text(encoding="utf-8"))
        self.assertIn("valve", result["candidates"][0]["quote"])
        self.assertNotIn("relay", result["candidates"][0]["quote"])
        self.assertEqual((self.root / "output/discovery.json").read_bytes(), original)

    def test_real_chinese_pdf_preserves_qualitative_requirement(self):
        self.pdf = self.root / "chinese.pdf"
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_text((72, 72), "4.1 开关要求\n当开关断开时，装置不得启动。", fontname="china-s")
            doc.save(self.pdf)
        result = discover_pdf(self.pdf, "中文新版本")
        self.assertEqual(len(result["candidates"]), 1)
        self.assertIn("装置不得启动", result["candidates"][0]["quote"])
        self.assertIsNone(result["candidates"][0]["conditions"])

    def test_real_table_without_caption_retains_layout_and_bare_numbers(self):
        self.pdf = self.root / "table.pdf"
        with fitz.open() as doc:
            page = doc.new_page()
            for x in (72, 172, 272):
                page.draw_line((x, 100), (x, 200))
            for y in (100, 150, 200):
                page.draw_line((72, y), (272, y))
            for x, y, text in ((80, 125, "Class"), (180, 125, "Rating"),
                               (80, 175, "X"), (180, 175, "25")):
                page.insert_text((x, y), text)
            doc.save(self.pdf)
        result = discover_pdf(self.pdf, "unknown")
        tables = [f for f in result["fragments"] if f["kind"] == "table_layout"]
        self.assertEqual(len(tables), 1)
        self.assertEqual(tables[0]["metadata"]["rows"], 2)
        self.assertEqual(tables[0]["metadata"]["columns"], 2)
        self.assertTrue(any(f.get("text") == "25" for f in result["fragments"]))
        self.assertEqual(result["run"]["status"], "partial")
        self.assertTrue(all(c["subject"] is None for c in result["candidates"]))

    def test_real_image_pdf_is_not_successful_empty_scan(self):
        self.pdf = self.root / "scanned.pdf"
        pixmap = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 20, 20), False)
        pixmap.clear_with(255)
        with fitz.open() as doc:
            page = doc.new_page()
            page.insert_image(fitz.Rect(72, 72, 172, 172), pixmap=pixmap)
            doc.save(self.pdf)
        process = self.cli()
        self.assertEqual(process.returncode, 3, process.stdout + process.stderr)
        result = json.loads((self.root / "output/discovery.json").read_text(encoding="utf-8"))
        self.assertTrue(any(f["kind"] == "image" for f in result["fragments"]))
        self.assertTrue(any(f["kind"] == "no_text" for f in result["fragments"]))
        self.assertFalse(result["claims"]["requirementsComplete"])

    def test_cli_selected_page_evidence_matches_source_page(self):
        process = self.cli(extra=("--pages", "2"))
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        result = json.loads((self.root / "output/discovery.json").read_text(encoding="utf-8"))
        self.assertEqual(result["source"]["selectedPages"], [2])
        self.assertEqual(result["pages"][0]["state"], "not_processed")
        with fitz.open(self.pdf) as doc:
            for candidate in result["candidates"]:
                for evidence in candidate["evidence"]:
                    self.assertEqual(evidence["page"], 2)
                    self.assertIn(evidence["quote"], doc[1].get_text())

    def test_empty_version_and_encrypted_pdf_fail_without_outputs(self):
        process = self.cli(extra=("--version", " "))
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / "output").exists())
        with fitz.open(self.pdf) as doc:
            doc.save(self.root / "encrypted.pdf", encryption=fitz.PDF_ENCRYPT_AES_256,
                     owner_pw="test-owner", user_pw="test-reader")
        self.pdf = self.root / "encrypted.pdf"
        process = self.cli()
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse((self.root / "output").exists())

    def test_real_page_failure_is_retained(self):
        with patch("requirement_discovery.extract_page", side_effect=RuntimeError("test extraction failure")):
            result = discover_pdf(self.pdf, "unknown")
        self.assertEqual(result["run"]["status"], "failed")
        self.assertTrue(all(p["state"] == "parse_failed" for p in result["pages"]))

    def test_no_text_pdf_cli_has_distinct_partial_exit(self):
        with fitz.open() as doc:
            doc.new_page()
            doc.save(self.root / "empty.pdf")
        self.pdf = self.root / "empty.pdf"
        process = self.cli()
        self.assertEqual(process.returncode, 3, process.stdout + process.stderr)
        result = json.loads((self.root / "output/discovery.json").read_text(encoding="utf-8"))
        self.assertEqual(result["run"]["status"], "partial")


if __name__ == "__main__":
    unittest.main(verbosity=2)
