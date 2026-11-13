# -*- coding: utf-8 -*-
"""无预置参数表的要求候选扫描。定位通过不是语义通过，候选数不是要求总数。"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
from pathlib import Path
import re
from typing import TYPE_CHECKING, Iterator

if TYPE_CHECKING:
    import fitz

from clause_split import clause_starts
from limit_scan import scan_decimals, scan_limits

MODAL = re.compile(
    r"应|必须|不得|禁止|允许|须|不宜|宜|仅可|"
    r"\b(?:shall|must|should|may|(?:is|are)\s+(?:required|prohibited|permitted))\b",
    re.I,
)
TABLE = re.compile(r"\btable\s+[\w.-]+|表\s*[A-Za-z0-9一二三四五六七八九十]|^\s*\|.*\|", re.I | re.M)
FIGURE = re.compile(r"\b(?:figure|fig\.)\s*[\w.-]+|图\s*[A-Za-z0-9一二三四五六七八九十]", re.I)
LEGAL_EFFECT = re.compile(r"\b(?:is|are)\s+deemed\b|视为|视同", re.I)
REFERENCE = re.compile(r"\b(?:paragraph|section|annex)\s+\d|第\s*[一二三四五六七八九十0-9]+\s*[条章节]|附录\s*[A-Z0-9]", re.I)
FORMULA = re.compile(r"(?<![<>=])=(?!=)|[∑√]|\\(?:frac|sum)\b")
DISPOSITIONS = ("scanned_with_candidate", "scanned_without_candidate", "unsupported", "parse_failed")
GENERATOR_FILES = ("requirement_discovery.py", "discover_requirements.py", "clause_split.py", "versions.py", "limit_scan.py")


def parse_pages(spec: str | None, page_count: int) -> list[int]:
    if page_count < 1:
        raise ValueError("PDF has no pages")
    if spec is None:
        return list(range(1, page_count + 1))
    selected = set()
    for part in spec.split(","):
        match = re.fullmatch(r"\s*(\d+)(?:\s*-\s*(\d+))?\s*", part)
        if not match:
            raise ValueError("Invalid physical page range: " + repr(spec))
        start = int(match.group(1))
        end = int(match.group(2) or start)
        if not (1 <= start <= end <= page_count):
            raise ValueError("Physical page range is outside the PDF: " + repr(part))
        selected.update(range(start, end + 1))
    if not selected:
        raise ValueError("Physical page selection is empty")
    return sorted(selected)


def generator_fingerprints() -> dict[str, str]:
    here = Path(__file__).resolve().parent
    return {name: hashlib.sha256((here / name).read_bytes()).hexdigest() for name in GENERATOR_FILES}


def extract_page(page: fitz.Page, number: int) -> dict:
    """仅取文本和图形对象元数据；不读图像字节、不渲染、不调用 OCR。"""
    result = {"number": number, "selected": True, "blocks": [], "images": [],
              "vectorPaths": 0, "errors": []}
    try:
        for block in page.get_text("blocks", sort=False):
            if block[6] == 0:
                result["blocks"].append({"text": block[4], "bbox": list(block[:4])})
    except Exception as exc:
        result["errors"].append({"operation": "text", "error": str(exc)})
    try:
        result["images"] = [
            {"bbox": list(info["bbox"]), "width": info["width"], "height": info["height"]}
            for info in page.get_image_info()
        ]
    except Exception as exc:
        result["errors"].append({"operation": "images", "error": str(exc)})
    try:
        # 路径数不等于图数；保守登记整页的未解析矢量内容，不猜它是不是一幅图。
        result["vectorPaths"] = len(page.get_drawings())
    except Exception as exc:
        result["errors"].append({"operation": "vectors", "error": str(exc)})
    try:
        result["tables"] = [
            {"bbox": list(table.bbox), "rows": table.row_count, "columns": table.col_count}
            for table in page.find_tables().tables
        ]
    except Exception as exc:
        result["errors"].append({"operation": "tables", "error": str(exc)})
    return result


def discover_pdf(pdf_path: str | Path, version: str, pages_spec: str | None = None) -> dict:
    import fitz

    if not str(version).strip():
        raise ValueError("Version label must not be empty")
    path = Path(pdf_path)
    payload = path.read_bytes()
    with fitz.open(stream=payload, filetype="pdf") as doc:
        if doc.needs_pass:
            raise ValueError("Encrypted PDF requires a password; not processed")
        selected = parse_pages(pages_spec, doc.page_count)
        pages = []
        for number in range(1, doc.page_count + 1):
            if number not in selected:
                pages.append({"number": number, "selected": False})
                continue
            try:
                pages.append(extract_page(doc[number - 1], number))
            except Exception as exc:
                pages.append({"number": number, "selected": True, "blocks": [], "images": [],
                              "vectorPaths": 0, "errors": [{"operation": "page", "error": str(exc)}]})
        source = {
            "fileName": path.name, "sha256": hashlib.sha256(payload).hexdigest(),
            "version": str(version).strip(), "versionOrigin": "caller-supplied",
            "pageCount": doc.page_count, "selectedPages": selected,
            "extraction": {"engine": "PyMuPDF", "version": fitz.VersionBind,
                           "textMode": "blocks", "sort": False},
        }
    return discover(source, pages)


def _groups(text_fragments: list[dict]) -> Iterator[tuple[str | None, list[dict]]]:
    """条款号只是候选锚点。每个出现位置独立，不按编号合并，不跨未选中页拼接。"""
    runs = []
    run = []
    last_page = None
    for fragment in text_fragments:
        if last_page is not None and fragment["page"] > last_page + 1:
            runs.append(run)
            run = []
        run.append(fragment)
        last_page = fragment["page"]
    if run:
        runs.append(run)
    for run in runs:
        starts, _ = clause_starts([f["text"] for f in run])
        anchors = {i: clause for i, clause, _ in starts}
        # Standalone chapter headings are not decimal clause fragments. Require
        # a textual title and a following child anchor; bare page/table numbers
        # remain text. This local rule does not change the existing case index.
        for i, fragment in enumerate(run[:-1]):
            chapter = re.fullmatch(r"(\d+)\.", fragment["text"].strip())
            title = run[i + 1]["text"].strip()
            if chapter and title and not re.search(r"\d|[.;。；]", title) and len(title) <= 70:
                number = chapter.group(1)
                following = sorted(j for j in anchors if i < j <= i + 10)
                if following and anchors[following[0]].startswith(number + "."):
                    anchors[i] = number
        group = []
        clause = None
        for i, fragment in enumerate(run):
            boundary = i in anchors or (clause is None and group and (
                fragment["page"], fragment["block"]) != (group[-1]["page"], group[-1]["block"]))
            if boundary and group:
                yield clause, group
                group = []
            if i in anchors:
                clause = anchors[i]
            group.append(fragment)
        if group:
            yield clause, group


def _stable_id(source: dict, refs: list[str]) -> str:
    key = "\0".join([source["sha256"], source["version"], *refs])
    return "candidate-" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:20]


def _summary(result: dict) -> dict:
    dispositions = Counter(row["disposition"] for row in result["ledger"])
    page_states = Counter(page["state"] for page in result["pages"])
    return {
        "selectedPages": len(result["source"]["selectedPages"]),
        "outsidePages": page_states["not_processed"],
        "fragments": len(result["fragments"]),
        "textFragments": sum(f["kind"] == "text" for f in result["fragments"]),
        "candidates": len(result["candidates"]),
        "dispositions": {state: dispositions[state] for state in DISPOSITIONS},
        "pageStates": dict(sorted(page_states.items())),
        "limitations": dict(sorted(Counter(x["kind"] for x in result["limitations"]).items())),
    }


def _page_state(selected: bool, fragments: list[dict]) -> str:
    if not selected:
        return "not_processed"
    if any(f["kind"] == "extraction_error" for f in fragments):
        return "parse_failed"
    if not fragments or any(f["kind"] != "text" for f in fragments):
        return "unsupported"
    return "scanned"


def _run_status(result: dict) -> str:
    selected = [p for p in result["pages"] if p["selected"]]
    has_text = any(f["kind"] == "text" for f in result["fragments"])
    failed = any(p["state"] == "parse_failed" for p in selected)
    if failed and not has_text:
        return "failed"
    if failed or result["limitations"] or any(p["state"] == "unsupported" for p in selected):
        return "partial"
    return "complete"


def discover(source: dict, pages: list[dict]) -> dict:
    source = {**source, "selectedPages": list(source["selectedPages"])}
    if not source.get("version") or not re.fullmatch(r"[a-f0-9]{64}", source.get("sha256", "")):
        raise ValueError("A nonempty version label and source SHA-256 are required")
    if [p["number"] for p in pages] != list(range(1, source["pageCount"] + 1)):
        raise ValueError("Every physical page must have an inventory entry")
    selected = [p["number"] for p in pages if p["selected"]]
    if not selected or selected != source["selectedPages"]:
        raise ValueError("Page inventory does not match the explicit selection")

    result = {
        "schemaVersion": 1,
        "generator": {"name": "offline-requirement-candidates", "files": generator_fingerprints()},
        "source": source,
        "claims": {"requirementsComplete": False, "semanticallyVerified": False},
        "run": {}, "pages": [], "fragments": [], "candidates": [], "ledger": [], "limitations": [],
    }
    for page in pages:
        number = page["number"]
        row = {"number": number, "selected": page["selected"], "state": "not_processed", "fragmentIds": []}
        result["pages"].append(row)
        if not page["selected"]:
            continue

        page_fragments = []

        def add(kind: str, suffix: str, **fields) -> None:
            fragment = {"id": "p%d:%s" % (number, suffix), "page": number, "kind": kind, **fields}
            result["fragments"].append(fragment)
            page_fragments.append(fragment)
            row["fragmentIds"].append(fragment["id"])

        text_count = 0
        for block_number, block in enumerate(page.get("blocks", [])):
            for line_number, text in enumerate(block["text"].splitlines()):
                if text.strip():
                    add("text", "b%d:l%d" % (block_number, line_number), block=block_number,
                        line=line_number, text=text, bbox=block.get("bbox"))
                    text_count += 1
        for i, image in enumerate(page.get("images", [])):
            add("image", "image%d" % i, metadata=image,
                reason="Displayed image object; image meaning and embedded values are not parsed")
        for i, table in enumerate(page.get("tables", [])):
            add("table_layout", "table%d" % i, metadata=table,
                reason="Detected table layout candidate; row/column/value semantics are not resolved")
        if page.get("vectorPaths"):
            add("vector_graphics", "vectors", pathCount=page["vectorPaths"],
                reason="Vector paths detected; paths are not a count of figures and are not interpreted")
        errors = page.get("errors", [])
        for i, error in enumerate(errors):
            add("extraction_error", "error%d" % i, **error)
        if not text_count and not any(e["operation"] in ("text", "page") for e in errors):
            add("no_text", "no-text", reason="No nonempty text extracted; not evidence of no requirements")
        row["state"] = _page_state(True, page_fragments)

    text_fragments = [f for f in result["fragments"] if f["kind"] == "text"]
    parents = []
    previous_page = None
    for clause, group in _groups(text_fragments):
        if previous_page is not None and group[0]["page"] > previous_page + 1:
            parents = []
        previous_page = group[-1]["page"]
        if clause:
            parents = [p for p in parents if clause.startswith(p["clause"] + ".")]
        else:
            parents = []
        context = [{"clause": p["clause"], "evidence": p["evidence"],
                    "status": "unverified_context"} for p in parents]
        quote = "\n".join(f["text"] for f in group)
        # 不把条款起始编号本身当作待提取量值，交叉引用中的数字仍只作为弱候选。
        body = re.sub(r"^\s*" + re.escape(clause) + r"\.?\s*", "", quote, count=1) if clause else quote
        quantities = [{"value": value, "unit": unit} for value, unit in scan_limits(body)]
        numbers = scan_decimals(body)
        reasons = []
        if MODAL.search(body):
            reasons.append("modal_token")
        if context and any(MODAL.search("\n".join(e["quote"] for e in p["evidence"])) for p in context):
            reasons.append("parent_requirement_context")
        if LEGAL_EFFECT.search(body):
            reasons.append("legal_effect_token")
        if REFERENCE.search(body):
            reasons.append("cross_reference")
        if quantities:
            reasons.append("quantity_token")
        elif numbers:
            reasons.append("numeric_context")
        if TABLE.search(quote):
            reasons.append("table_reference_or_layout")
        if FIGURE.search(quote):
            reasons.append("figure_reference")
        if FORMULA.search(body):
            reasons.append("formula_context")
        refs = [f["id"] for f in group]
        if reasons:
            result["candidates"].append({
                "id": _stable_id(source, refs), "clause": clause,
                "clauseStatus": "candidate_anchor" if clause else "unresolved",
                "reasons": reasons, "quote": quote,
                "evidence": [{"fragmentId": f["id"], "page": f["page"], "quote": f["text"]} for f in group],
                "evidenceStatus": "located",
                "context": context,
                "subject": None, "conditions": None, "comparator": None,
                "quantities": quantities, "numericTokens": numbers,
                "semantics": {"status": "unverified", "reason":
                    "Lexical candidates only; subject, applicability, quantity pairing and comparison are not verified"},
            })
        if clause:
            parents.append({"clause": clause, "evidence": [
                {"fragmentId": f["id"], "page": f["page"], "quote": f["text"]} for f in group]})
        for kind, present, reason in (
            ("table_context", TABLE.search(quote), "Table cue only; row/column/value association is not resolved"),
            ("formula_context", FORMULA.search(body), "Formula cue only; expression is not interpreted"),
            ("figure_reference", FIGURE.search(quote), "Figure reference detected; referenced figure meaning is not resolved"),
        ):
            if present:
                result["limitations"].append({"kind": kind, "fragmentIds": refs, "reason": reason})

    candidate_by_fragment = {}
    for candidate in result["candidates"]:
        for evidence in candidate["evidence"]:
            candidate_by_fragment.setdefault(evidence["fragmentId"], []).append(candidate["id"])
    for fragment in result["fragments"]:
        candidate_ids = candidate_by_fragment.get(fragment["id"], [])
        kind = fragment["kind"]
        disposition = ("scanned_with_candidate" if candidate_ids else "scanned_without_candidate") if kind == "text" else (
            "parse_failed" if kind == "extraction_error" else "unsupported")
        result["ledger"].append({"fragmentId": fragment["id"], "disposition": disposition,
                                 "candidateIds": candidate_ids})
    result["run"] = {"status": _run_status(result), "meaning":
        "Execution status only; complete does not mean complete requirements or verified semantics"}
    result["summary"] = _summary(result)
    validate_discovery(result)
    return result


def validate_discovery(result: dict) -> None:
    """核对定位与处置分区，不给候选做语义背书。失败必须抛异常。"""
    def require(condition: object, message: str) -> None:
        if not condition:
            raise ValueError(message)

    source = result["source"]
    require(result["claims"] == {"requirementsComplete": False, "semanticallyVerified": False}, "Invalid verification claim")
    require(source["pageCount"] > 0 and bool(source["selectedPages"]), "Empty page inventory or selection")
    require(bool(str(source["version"]).strip()) and re.fullmatch(r"[a-f0-9]{64}", source["sha256"]),
            "Invalid source identity")
    require([p["number"] for p in result["pages"]] == list(range(1, source["pageCount"] + 1)), "Incomplete page inventory")
    require([p["number"] for p in result["pages"] if p["selected"]] == source["selectedPages"], "Selection changed")
    fragments = {f["id"]: f for f in result["fragments"]}
    require(len(fragments) == len(result["fragments"]), "Duplicate fragment IDs")
    require(len({c["id"] for c in result["candidates"]}) == len(result["candidates"]), "Duplicate candidate IDs")
    for page in result["pages"]:
        page_fragments = [f for f in result["fragments"] if f["page"] == page["number"]]
        expected = [f["id"] for f in page_fragments]
        require(page["state"] == _page_state(page["selected"], page_fragments), "Page state does not match fragments")
        require(page["fragmentIds"] == expected, "Page fragment inventory changed")
        require(page["selected"] or (not expected and page["state"] == "not_processed"), "Outside page was processed")
        require(not page["selected"] or bool(expected), "Selected page has no disposition")
    require(all(f["page"] in source["selectedPages"] for f in fragments.values()), "Fragment outside selection")
    expected_candidates = {key: [] for key in fragments}
    for candidate in result["candidates"]:
        require(candidate["evidence"] and candidate["evidenceStatus"] == "located", "Missing located evidence")
        require(candidate["semantics"]["status"] == "unverified", "Candidate semantics must remain unverified")
        refs = []
        quotes = []
        for evidence in candidate["evidence"]:
            fragment = fragments.get(evidence["fragmentId"])
            require(fragment is not None and fragment["kind"] == "text", "Evidence refers to unknown text")
            require(evidence["page"] == fragment["page"] and evidence["quote"] == fragment["text"], "Evidence page or quote mismatch")
            refs.append(fragment["id"])
            quotes.append(fragment["text"])
            expected_candidates[fragment["id"]].append(candidate["id"])
        require(candidate["id"] == _stable_id(source, refs), "Candidate ID is not source-bound")
        require(candidate["quote"] == "\n".join(quotes), "Candidate quote mismatch")
        for context in candidate.get("context", []):
            require(context["status"] == "unverified_context" and candidate["clause"] and
                    candidate["clause"].startswith(context["clause"] + "."), "Invalid parent context")
            require(bool(context["evidence"]), "Empty parent context")
            for evidence in context["evidence"]:
                fragment = fragments.get(evidence["fragmentId"])
                require(fragment is not None and fragment["kind"] == "text" and
                        fragment["page"] == evidence["page"] and fragment["text"] == evidence["quote"],
                        "Parent context evidence mismatch")
    require(len(result["ledger"]) == len(fragments), "Fragment disposition count does not close")
    require({r["fragmentId"] for r in result["ledger"]} == set(fragments), "Fragment disposition partition does not close")
    for row in result["ledger"]:
        fragment = fragments[row["fragmentId"]]
        candidate_ids = expected_candidates[fragment["id"]]
        expected = ("scanned_with_candidate" if candidate_ids else "scanned_without_candidate") if fragment["kind"] == "text" else (
            "parse_failed" if fragment["kind"] == "extraction_error" else "unsupported")
        require(row["disposition"] == expected and row["candidateIds"] == candidate_ids, "Fragment disposition mismatch")
    for limitation in result["limitations"]:
        require(limitation["fragmentIds"] and all(f in fragments for f in limitation["fragmentIds"]), "Unlocated limitation")
    require(result["summary"] == _summary(result), "Summary does not match actual records")
    require(result["run"]["status"] == _run_status(result), "Execution status does not match actual records")


def _fenced(text: str) -> str:
    fence = "`" * max(3, max((len(m.group()) + 1 for m in re.finditer(r"`+", text)), default=3))
    return fence + "text\n" + text + "\n" + fence


def render_review(result: dict) -> str:
    validate_discovery(result)
    source = result["source"]
    lines = ["# 要求候选与处理范围台账（未作语义核验）", "",
             "这是离线线索扫描，不是已核报告。候选数不代表法规要求总数，扫描完成不代表无遗漏。", "",
             "## 来源与执行", "", _fenced(json.dumps({
                 "source": source, "run": result["run"], "summary": result["summary"]}, ensure_ascii=False, indent=2)),
             "", "版本标签由调用者提供，未自动核实其法规身份。页码均为 PDF 物理页码。",
             "引文定位相对于本次 PDF 文本抽取快照；不等于对象、条件、符号或量值归属核验。", "",
             "## 逐页处置", ""]
    for page in result["pages"]:
        lines.append("- p%d: %s; fragments=%d" % (page["number"], page["state"], len(page["fragmentIds"])))
    lines.extend(["", "## 要求候选", ""])
    for candidate in result["candidates"]:
        lines.extend(["### " + candidate["id"], "",
                      "条款候选：%s；源页：%s；语义：未核。" % (
                          candidate["clause"] or "未定位", ", ".join(str(p) for p in sorted({e["page"] for e in candidate["evidence"]}))),
                      "", "触发线索：" + ", ".join(candidate["reasons"]), "", _fenced(candidate["quote"]), ""])
        for context in candidate.get("context", []):
            lines.extend(["父级上下文（未作语义继承）：" + context["clause"], "",
                          _fenced("\n".join(e["quote"] for e in context["evidence"])), ""])
    lines.extend(["## 所有片段与处置（含未产生候选的正文）", ""])
    ledger = {row["fragmentId"]: row for row in result["ledger"]}
    for fragment in result["fragments"]:
        row = ledger[fragment["id"]]
        lines.extend(["### %s — %s" % (fragment["id"], row["disposition"]), "",
                      _fenced(fragment.get("text", json.dumps(fragment, ensure_ascii=False))), ""])
    lines.extend(["## 未解析事项", "", _fenced(json.dumps(result["limitations"], ensure_ascii=False, indent=2)), "",
                  "## 人工复核记账", "",
                  "尚未记录人工工时或独立核对结论，不将候选数、待办项数或执行时间冒充人工成本。",
                  "请单列接入准备、核对、修正返工和独立评测；从源范围检查漏项，不能只检查机器提出来的候选。", ""])
    return "\n".join(lines)
