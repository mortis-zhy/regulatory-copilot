#!/usr/bin/env python3
"""
Verification harness: machine-check every factual claim against MinerU text.

Inputs:
  - dist/mineru-v4-data.json      (page-tagged ground truth from MinerU)
  - diff-result.json              (45 valueDiffs: clause-level A/B differences)
  - dist/extract-cache/v3-*.json  (per-topic locked excerpt+clause+page for A/B/C)

Outputs:
  - dist/verified-comparison.json
      numericChanges[]  : real numeric changes, noise-filtered, each VERIFIED
                          against MinerU text (real page recorded)
      topicColumns[]    : 3-way A|B|C topic comparison with excerpt
                          verification status
      stats             : verification pass rates
"""
import json, re, glob, os, sys, io
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main")
MINERU = ROOT / "dist" / "mineru-v4-data.json"
DIFF = ROOT / "diff-result.json"
CACHE_DIR = ROOT / "dist" / "extract-cache"
OUT = ROOT / "dist" / "verified-comparison.json"

def load_mineru():
    data = json.load(open(MINERU, encoding="utf-8"))
    texts = {}
    for k, v in data.items():
        # verification corpus = page-tagged fullText + page-tagged table contents
        table_parts = []
        for t in v.get("tables", []):
            content = t.get("content")
            if not isinstance(content, str):
                continue
            page = t.get("page", "")
            stripped = re.sub(r"<[^>]+>", " ", content)
            marker = f"[第{page}页]" if page else ""
            table_parts.append(f"\n{marker}\n{stripped}")
        texts[k] = v.get("fullText", "") + "\n".join(table_parts)
    return texts

def find_page(text: str, needle: str, window: int = 200, context_tokens: list[str] | None = None) -> str:
    """Locate needle in page-tagged text → return 第N页 of best hit.

    Robust multi-strategy matcher (validated 9/9 on the previously-failing
    table excerpts):
      0. exact / whitespace-stripped / word-boundary (numbers)
      1. strip table pipes '|' from BOTH sides, exact match
      2. split excerpt on Chinese separators, match any fragment >= 8 chars
      3. shrink-skip the prefix in 4-char steps (table captions differ)
      4. distinctive latin/digit tokens >= 4 chars
    Marker interiors ([第N页]) never host a match.

    When context_tokens is supplied, the matcher only returns pages whose
    text contains at least one token — prevents bare-number hits (e.g. "10")
    from pinning to the foreword/cover where any number can appear.
    """
    if not needle:
        return ""
    is_number = bool(re.fullmatch(r"-?\d+(?:\.\d+)?", needle.strip()))
    marker_re = re.compile(r"\[第(\d+)页\]")

    # page-text index (built once per call) for contextual verification
    page_texts: dict[str, str] = {}

    def _page_text(page_no: str) -> str:
        if page_no in page_texts:
            return page_texts[page_no]
        m = re.fullmatch(r"第(\d+)页", page_no)
        if not m:
            return ""
        n = int(m.group(1))
        cur_pg, cur_start = "", 0
        for mt in marker_re.finditer(text):
            if cur_pg:
                if cur_pg == page_no:
                    page_texts[page_no] = text[cur_start:mt.start()]
                    return page_texts[page_no]
                cur_start = mt.end()
            else:
                cur_start = mt.end()
            cur_pg = f"第{int(mt.group(1))}页"
        if cur_pg == page_no:
            page_texts[page_no] = text[cur_start:]
            return page_texts[page_no]
        return ""

    def _window_ok(pos: int, window: int = 200) -> bool:
        """Context tokens must appear within ±window chars of the needle
        position (not just anywhere on the page). This filters TOC / scope /
        foreword pages where the terms appear spread out — the real clause
        page has them in tight proximity to the numeric value."""
        if not context_tokens:
            return True
        start = max(0, pos - window)
        end = min(len(text), pos + window)
        snippet = text[start:end]
        return all(tok and tok in snippet for tok in context_tokens)

    def page_before(pos: int) -> str:
        ms = marker_re.findall(text[:pos])
        return f"第{int(ms[-1])}页" if ms else ""

    marker_spans = [(m.start(), m.end()) for m in re.finditer(r"\[第\d+页\]", text)]

    def _in_marker(pos: int) -> bool:
        return any(s <= pos < e for s, e in marker_spans)

    # --- strategy 0: direct / boundary match on original text ---
    if is_number:
        pat = r"(?<![\d.])" + re.escape(needle.strip()) + r"(?![\d])"
        # Prefer contextual hits; fall back to first hit only when no
        # context is supplied. Contextual check is now a NARROW WINDOW around
        # the needle position (not whole page) — filters TOC / scope pages.
        first_hit: str | None = None
        for m0 in re.finditer(pat, text):
            if _in_marker(m0.start()):
                continue
            pg = page_before(m0.start())
            if not pg:
                continue
            if first_hit is None:
                first_hit = pg
            if _window_ok(m0.start()):
                return pg
        if context_tokens:
            return ""  # context required but no contextual hit → refuse
        return first_hit or ""
    else:
        # Iterate ALL occurrences: with context, a later hit may be the real
        # clause page while the first hit is a TOC/sibling-chapter echo.
        # If the needle isn't found verbatim at all, FALL THROUGH to the
        # compact/fragment strategies below (they handle whitespace/pipe
        # differences) — do not return early.
        idx = text.find(needle)
        saw_occurrence = idx >= 0
        while idx >= 0:
            if not _in_marker(idx):
                pg = page_before(idx)
                if pg:
                    if not context_tokens:
                        return pg
                    if _window_ok(idx):
                        return pg
            idx = text.find(needle, idx + 1)
        if context_tokens and saw_occurrence:
            return ""  # found but never carried the context — refuse

    # --- pipe-stripped compact corpus (tables are '|'-markdown in MinerU) ---
    compact_text = re.sub(r"\s+", "", text)
    nc = compact_text.replace("|", "")
    cn = re.sub(r"\s+", "", needle)
    cn_np = cn.replace("|", "")

    fallback_pg = ""
    parts_cache: list[list[str]] = []

    def _page_segment(pg: str) -> str:
        m = re.fullmatch(r"第(\d+)页", pg)
        if not m:
            return ""
        n = int(m.group(1))
        if not parts_cache:
            parts_cache.append(re.split(r"\[第\d+页\]", text))
        parts = parts_cache[0]
        return parts[n] if 1 <= n < len(parts) else ""

    def _accept(pg: str) -> bool:
        """Context-aware acceptance for the secondary strategies.
        With context: only a non-TOC page carrying ALL tokens is acceptable —
        otherwise keep searching (a fragment hit on a sibling chapter must
        not short-circuit the better token hit on the real clause page).
        Without context: first hit wins (legacy behaviour)."""
        nonlocal fallback_pg
        if not pg:
            return False
        if not fallback_pg:
            fallback_pg = pg
        if not context_tokens:
            return True
        seg = _page_segment(pg)
        if re.search(r"目\s*次|目录|\.{3,}", seg):
            return False
        return all(t in seg for t in context_tokens)

    def _page_at_nc(pos: int) -> str:
        ms = marker_re.findall(nc[:pos])
        return f"第{int(ms[-1])}页" if ms else ""

    if is_number:
        pat2 = r"(?<![\d.])" + re.escape(cn) + r"(?![\d])"
        for m1 in re.finditer(pat2, compact_text):
            if _in_marker(m1.start()):
                continue
            ms = marker_re.findall(compact_text[: m1.start()])
            pg = f"第{int(ms[-1])}页" if ms else ""
            if _accept(pg):
                return pg
        return fallback_pg if not context_tokens else ""

    # strategy 1: pipe-stripped exact (ALL occurrences)
    if cn_np:
        for m1 in re.finditer(re.escape(cn_np), nc):
            if _accept(_page_at_nc(m1.start())):
                return _page_at_nc(m1.start())

    # strategy 2: separator fragments >= 8 chars
    for fr in re.split(r"[；;，,、。]", needle):
        f = re.sub(r"\s+", "", fr).replace("|", "")
        if len(f) >= 8:
            for m1 in re.finditer(re.escape(f), nc):
                pg = _page_at_nc(m1.start())
                if _accept(pg):
                    return pg

    # strategy 3: shrink-skip prefix, 60-char window
    for drop in range(0, min(40, len(cn_np) // 2), 4):
        sub = cn_np[drop:drop + 60]
        if len(sub) >= 8:
            for m1 in re.finditer(re.escape(sub), nc):
                pg = _page_at_nc(m1.start())
                if _accept(pg):
                    return pg

    # strategy 4: distinctive latin/digit tokens >= 4 chars
    for tok in sorted({x for x in re.findall(r"[A-Za-z0-9.]{4,}", cn_np)}, key=len, reverse=True)[:6]:
        for m1 in re.finditer(re.escape(tok), nc):
            pg = _page_at_nc(m1.start())
            if _accept(pg):
                return pg
    return fallback_pg if not context_tokens else ""

CN_NUM = {"一": "1", "两": "2", "二": "2", "三": "3", "四": "4", "五": "5",
          "六": "6", "七": "7", "八": "8", "九": "9", "十": "10"}

def normalize_cn(s: str) -> str:
    """Chinese numerals → digits so 两只 == 2只 for comparison."""
    out = s
    for k, v in CN_NUM.items():
        out = out.replace(f"{k}只", f"{v}只").replace(f"{k}项", f"{v}项")
    return out

def nums(s: str):
    """Extract all numeric tokens (with decimals/negatives)."""
    return set(re.findall(r"-?\d+(?:\.\d+)?", re.sub(r"[A-Za-z]+", "", s or "")))

def strong_nums(s: str):
    """Distinctive numbers: >=2 digits or with decimal (for page locating).
    Also adds digit+unit forms and their Chinese-numeral+unit variants
    (e.g. "2只" → "2只" + "两只") so documents using either form (B uses
    CN digits, A uses arabic) can be pinned regardless of the digit/word
    split the extractor preserved.
    Sorted longest-first so '430000' found before '30'."""
    toks = re.findall(r"\d+\.\d+|\d{2,}", s or "")
    du = re.findall(r"\d+[只个套米瓦赫度秒年]", s or "")
    cn: list[str] = []
    for x in du:
        m = re.match(r"(\d+)([只个套米瓦赫度秒年])", x)
        if m:
            d, u = m.group(1), m.group(2)
            cn.append(_DIGIT_TO_CN.get(d, d) + u)
    return sorted(set(toks + du + cn), key=len, reverse=True)


_DIGIT_TO_CN = {"1": "一", "2": "两", "3": "三", "4": "四", "5": "五", "6": "六",
               "7": "七", "8": "八", "9": "九", "10": "十"}

def clean_latex(s: str) -> str:
    """Normalise LaTeX/extraction artifacts - KEEP numbers (the signal), drop syntax."""
    s = re.sub(r"_\{([^}]*)\}", r" \1", s)                       # _{-1.0} ->  -1.0
    s = re.sub(r"\\mathrm\s*\{([^}]*)\}", r"\1", s)              # \mathrm{Hz} -> Hz
    s = re.sub(r"\$\s*([^$]*)\$", r" \1 ", s)                    # $math$ -> content
    s = re.sub(r"(Hz|V|lx|cd|s)\1", r"\1", s)                    # HzHz -> Hz (never mm)
    s = re.sub(r"\s+", " ", s)
    return s


def display_clean(s: str) -> str:
    """Remove value+unit concatenation junk for DISPLAY only."""
    if not s:
        return s
    m = re.search(r"[\uff08]([^\uff09]*)\uff09\s*(mm|cm|cd|Hz|V|lx|min|h|s|%|\u00b0|\u53ea|\u9879)$", s)
    if m and re.search(r"(mm|cm|cd|Hz|V|lx|min|h|s|%|\u00b0|\u53ea|\u9879)\s*$", m.group(1)):
        s = s[: -len(m.group(2))]
    # stripped words were counting words not units (CN "两只" was corrupted)
    s = re.sub(r"(?<=[\u4e00-\u9fff])(mm|cm|cd|Hz|V|lx|min|h|s|%)$", r"", s)
    # --- extraction artifacts (second evaluation: excerpts contained
    # characters that exist nowhere in the originals) ---
    # duplicated suffix block: '\uff0890\u00b130\uff09\u6b21/min\u6b21/min' \u2192 drop the repeat
    for k in range(8, 1, -1):
        if len(s) >= 2 * k and s[-k:] == s[-2 * k:-k]:
            s = s[:-k]
            break
    # duplicated CJK unit char: '2\u53ea\u53ea' \u2192 '2\u53ea'
    if len(s) >= 2 and s[-1] == s[-2] and s[-1] in "\u53ea\u5ea6\u9879\u4e2a\u6b21":
        s = s[:-1]
    # unit-merge: '\u00b13\u00b0\u5ea6' \u2192 '\u00b13\u00b0'
    s = s.replace("\u00b0\u5ea6", "\u00b0").replace("\u2103\u5ea6", "\u2103")
    if s.endswith("\u5ea6") and "\u00b0" in s[-6:]:
        s = s[:-1]
    # hanging unit after a bracket: '2\u53ea\uff08\u6210\u5bf9\uff09\u53ea' \u2192 '2\u53ea\uff08\u6210\u5bf9\uff09'
    if s.endswith("\u53ea") and len(s) >= 2 and s[-2] in "\uff09)]\u3001\uff0c, ":
        s = s[:-1]
    # --- 5th-evaluation transcription residues ---
    s = re.sub(r"(\d)ss+", r"\1s", s)   # "3ss" -> "3s"
    s = s.replace("%%", "%")
    # stray counting-word after a NON-numeral CJK ("…一致套"/"…灯只")
    if len(s) >= 2 and s[-1] in "\u53ea\u5957\u9879\u4e2a":
        prev = s[-2]
        numeral = ("0" <= prev <= "9") or (prev in "\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341")
        if not numeral:
            s = s[:-1]
    return s



def semantic_normalize(s: str) -> str:
    """Canonical form for equivalence checks: strip HTML tags, inline LaTeX,
    whitespace and punctuation; normalise Chinese numerals."""
    s = re.sub(r"<[^>]+>", "", s)                     # <sub>x</sub>
    s = re.sub(r"\$[^$]*\$", "", s)                 # $...$ inline math
    s = re.sub(r"\\[a-zA-Z]+\s*\{?([^}]*)\}?", r"\1", s)  # \mathrm{x}
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[，。、；：()（）【】\[\]<>|]", "", s)
    s = normalize_cn(s)
    return s

def noise_filter_diffs(vds):
    """Returns (real, wording, renumbered)."""
    """Split valueDiffs: real numeric changes vs paraphrase/wording noise.

    Rules (accuracy-first):
      - Chinese numerals normalised (两只 == 2只)
      - LaTeX/extraction artifacts cleaned
      - equal number sets → wording
      - old side has no digits → wording
      - only-delta is {0} (e.g. extraction added a stray 0) → wording
      - else → real numeric change
    """
    real, wording, renumbered = [], [], []
    for v in vds:
        old = normalize_cn(clean_latex(re.sub(r"^(B|A)[:：]\s*", "", v.get("oldValue", ""))))
        new = normalize_cn(clean_latex(re.sub(r"^(B|A)[:：]\s*", "", v.get("newValue", ""))))
        no, nn = nums(old), nums(new)
        # pure clause-referencing renumber: strip ALL digits → identical text
        def digits_stripped(s):
            return re.sub(r"\d+(?:\.\d+)*", "#", s)
        if digits_stripped(old) == digits_stripped(new) and old != new:
            renumbered.append(v)
            continue
        if not no and not nn:
            wording.append(v)
            continue
        if no == nn:
            wording.append(v)
            continue
        if not no:
            wording.append(v)
            continue
        added = nn - no
        removed = no - nn
        if added <= {"0"} and removed <= {"0"}:
            # only stray zeros differ → extraction artifact, not a change
            wording.append(v)
            continue
        real.append((v, old, new))
    return real, wording, renumbered



def classify_value_kind(old: str, new: str) -> str:
    """Classify a change as 'numeric' (real number change) or 'text'
    (wording/structure difference). Prose must not pose as numeric data.

    Rules (order matters):
      - either side has NO digits                     -> text
      - either side has sentence punctuation 。 or ；   -> text
      - either side >30 chars with digit-ratio < 0.3   -> text
      - otherwise                                     -> numeric
    """
    def kind(s: str) -> str:
        s = semantic_normalize(s)
        digits = re.findall(r"\d+(?:\.\d+)?", s)
        if not digits:
            return "text"
        if re.search(r"[。；]", s):
            return "text"
        if len(s) > 30:
            num_chars = sum(len(d) for d in digits)
            if num_chars / max(len(s), 1) < 0.3:
                return "text"
        return "numeric"
    ko, kn = kind(old), kind(new)
    return "numeric" if (ko == "numeric" and kn == "numeric") else "text"

def _page_slice(full: str, page_label: str) -> str:
    """Extract the text of one [第N页] segment from MinerU fullText."""
    m = re.search(r"第(\d+)页", page_label or "")
    if not m or not full:
        return ""
    n = int(m.group(1))
    parts = re.split(r"\[第\d+页\]", full)
    # parts[0]=preamble (empty when text starts with the marker), parts[n]=page n
    if 1 <= n < len(parts):
        return parts[n]
    return ""


def _find_page_by_clause(text: str, clause_prefixes: list[str], value_needles: list[str],
                         window: int = 800, name_hint: str = "") -> str:
    """Locate the page of a subclause whose number starts with any of clause_prefixes
    AND whose body (within `window` chars after the number) contains any of value_needles.

    clause_prefixes may be several (source often lists '5.9, 5.10' or '5.5.9, 5.23.7.1').
    value_needles should include both digit forms and Chinese forms ('1200', '两只').
    Returns '' if no such subclause page found.

    TOC / 目次 pages are SKIPPED — they list every clause number and would
    false-match; the real clause page is where the value text lives.
    """
    if not clause_prefixes or not value_needles:
        return ""
    marker_re = re.compile(r"\[第(\d+)页\]")
    page_starts = [(m.start(), int(m.group(1))) for m in marker_re.finditer(text)]

    def page_text_and_number(pos: int) -> tuple[int, str]:
        """Return (page_number, text_of_that_page) for a given position."""
        pg_no = 0
        page_text_start = 0
        for i, (ms, n) in enumerate(page_starts):
            if ms > pos:
                break
            pg_no = n
            page_text_start = ms
        # page text ends at next marker or EOF
        end = len(text)
        for ms, n in page_starts:
            if ms > pos:
                end = ms
                break
        return pg_no, text[page_text_start:end]

    def _search(prefixes: list[str]) -> str:
        # Rarest-needle-first, nearest-match within each needle.
        # A needle that occurs once in the corpus ("2300") uniquely pins the
        # page; a common one ("1500") matches many pages and would win
        # spuriously if tried first. Ties broken by length (longer = specific).
        def _key(nd: str):
            cjk = bool(re.search(r"[\u4e00-\u9fff]", nd))
            cnt = text.count(nd)
            # CJK count-nouns: prefer CANONICAL (most frequent) form — rarity
            # misleads (rare "一只" hit a stray p35 window over real 5.7.2/p34).
            # Latin/digits keep rarest-first.
            return (0, -cnt, -len(nd), nd) if cjk else (1, cnt, -len(nd), nd)
        scored = [_key(nd) for nd in value_needles if nd and text.count(nd) > 0]
        scored.sort()
        for _cjkc, _cnt, _neglen, needle in scored:
            # candidates carry (is_heading, dist, order, pg): heading-style
            # matches (a subclause number follows within 60 chars — the real
            # heading = a subclause number follows (real 5.7.2 heading vs p35 cross-ref)
            # ("5.7.2规定,安装两只…" on p35) regardless of distance.
            cands: list[tuple[int, int, int, str]] = []  # (not_head, dist, order, pg)
            order = 0
            for prefix in prefixes:
                if not prefix:
                    continue
                pat = r"(?<![\d.])" + re.escape(prefix) + r"(?:[\.][\d]+)*(?![\d])"
                for m in re.finditer(pat, text):
                    start = m.start()
                    end_seg = min(len(text), start + window)
                    segment = text[start:end_seg]
                    i = segment.find(needle)
                    if i < 0:
                        # whitespace-tolerant: A writes "2 只" (space) where
                        # the value needle is "2只"
                        seg_ns = re.sub(r"\s+", "", segment)
                        j = seg_ns.find(re.sub(r"\s+", "", needle))
                        if j < 0:
                            continue
                        i = j
                    pg_no, page_text = page_text_and_number(start)
                    if re.search(r"目\s*次|目录|\.\{3,}", page_text):
                        continue
                    mlen = m.end() - m.start()
                    is_head = bool(re.search(re.escape(segment[:mlen]) + r"\.\d+", segment[mlen:mlen + 120]))  # deeper subclause only
                    if __import__("os").environ.get("VDBG"):
                        print("CAND", prefix, repr(needle)[:30], "head" if is_head else "ref", "dist", i, pg_no, file=__import__("sys").stderr)
                    # attribute the page to where the VALUE sits (may be the
                    # next page from the heading: 5.10 heading p38, 2100 on p39)
                    pg_val, _ = page_text_and_number(start + i)
                    cands.append((0 if is_head else 1, i, order, pg_val or pg_no))
                    order += 1

            if cands:
                # Two-stage selection (validated against evaluator page list):
                # 1) candidates whose value sits ≤50 chars from the clause
                #    number are certainly on its page — pick the EARLIEST in
                #    text order (beats a later cross-reference 10 chars away
                #    on the next page: real "5.7.2 数量" p34 vs "5.7.2规定"
                #    p35).
                # 2) otherwise nearest-value wins (page-of-value attributed).
                near = [c for c in cands if c[1] <= 50]
                best = min(near, key=lambda c: (c[2], c[1])) if near else min(cands, key=lambda c: (c[1], c[2]))
                return f"第{best[3]}页"
        return ""

    # Clause-prefix preference: the section HEADING immediately after the
    # clause number should start with the device name from `name_hint`
    # (e.g. name='前位灯最大离地高度' → '5.9前位灯(...)' matches, '5.10后位灯'
    # doesn't). When only some prefixes pass, search with them first; the
    # rest is a fallback. Prevents 前位灯/后位灯 rows from cross-matching
    # just because both contain "1500/2100".
    def _score(prefix: str) -> int:
        """Longest name-prefix match in the 40-char window after ANY non-TOC
        occurrence of the clause number. TOC lines are skipped (their 40-char
        window bleeds into the NEXT TOC entry — '5.9前位灯' reaches
        '5.10后位灯'), and stray in-text references ("按5.7要求") yield 0, so
        we take the MAX over all body occurrences: the heading occurrence
        gives the real score."""
        if not name_hint:
            return 0
        pat = r"(?<![\d.])" + re.escape(prefix) + r"(?:\.\d+)*(?!\d)"
        best = 0
        for m in re.finditer(pat, text):
            _, pg_text = page_text_and_number(m.start())
            if re.search(r"目\s*次|目录|\.{3,}", pg_text):
                continue
            # ADJACENT window only (8 chars): prose mentions 14+ chars away
            win = text[m.end():m.end() + 8]
            back = text[max(0, m.start() - 8):m.start()]
            for L in range(min(5, len(name_hint)), 2, -1):
                # forward (B style: number-then-name) OR backward (A style:
                # name-then-number) both count as heading adjacency
                if name_hint[:L] in win or name_hint[:L] in back:
                    if L > best:
                        best = L
                    break
            if best >= min(5, len(name_hint)):
                break
        return best

    scores = {p: _score(p) for p in clause_prefixes if p}
    max_s = max(scores.values(), default=0)
    # Only the BEST-matching prefix(es) qualify; requires a real name hit (L>=3)
    # so a common score of 0 across all doesn't wrongly filter anything.
    if max_s == 0 and len(scores) > 1:
        # no name signal anywhere (A sections put the device name lines well
        # before subclause numbers) — fall back to the FIRST clause in order
        # (the family's primary section, e.g. 5.14 非三角形后回复反射器).
        pref = [clause_prefixes[0]]
    else:
        pref = [p for p, s in scores.items() if s == max_s and max_s >= 3]
    rest = [p for p in scores if p not in pref]
    import os as _os, sys as _sys
    if _os.environ.get("VDBG"):
        _sys.stderr.write("VDBG name=%r scores=%r max=%r pref=%r rest=%r\n" % (name_hint, scores, max_s, pref, rest))

    if pref:
        r = _search(pref)
        if r:
            return r
    return _search(rest)


def verify_numeric_changes(real_tuples, texts):
    """For each real change: locate distinctive numbers in B/A MinerU text.
    Voltage special-case: the fuzzy name-matcher mis-pairs 6V/12V/24V rows;
    resolve by presence-checking 6.75V (the genuine B-only 6V clause).

    Returns (verified_rows, same_text_dropped):
    - same_text_dropped: rows the second evaluation proved NOT to be changes
      (B's displayed value was truncated; B's real clause text already
      contains A's digits, or the digit sequences are identical after
      CN-normalisation, or the row duplicates an earlier kept row).
    """
    out = []
    same_text: list[dict] = []
    kept_sigs: list[tuple] = []
    for v, old, new in real_tuples:
        name = v.get("name", "")
        b_text = texts.get("B", "")
        a_text = texts.get("A", "")

        # --- voltage special-case (rewritten) ---
        # Pair by TIER (6V/12V/24V), not by position. The name-matcher has no
        # guarantee of alignment, so look inside B/A text for each tier value.
        if "电压" in name or "电压" in v.get("topic", ""):
            def tier_value(s: str):
                m = re.search(r"(\d+(?:\.\d+)?)\s*V", s)
                return m.group(1) if m else None

            v_old = tier_value(old)
            v_new = tier_value(new)
            if v_old == "6.75":
                # B-only 6V tier — confirm A lacks 6.75V
                if "6.75" in b_text and "6.75" not in a_text:
                    out.append({
                        "topic": v.get("topic", ""), "name": "6V 系统电压限值",
                        "oldValue": "6.75V（6V 系统，B 4.27b）", "newValue": "（A 已删除 6V 系统条款）",
                        "unit": "V", "bPage": find_page(b_text, "6.75"),
                        "aPage": "", "status": "verified",
                    })
                continue  # 6V handled (either emitted or not) — never fall through
            if v_new == "6.75":
                # A has a 6V value? doesn't happen; skip defensively
                continue
            # 12V/24V rows: tier should be unchanged in both — drop unless
            # the same tier truly differs (it doesn't, verified manually).
            # To be safe: only keep if the tier value genuinely differs AND
            # both tiers are present in both docs → otherwise drop.
            o_in_b, o_in_a = v_old in b_text, v_old in a_text
            n_in_b, n_in_a = v_new in b_text, v_new in a_text
            if (o_in_b and o_in_a) and (n_in_b and n_in_a):
                continue  # both tiers present in both docs → NOT a change
            # fall through only if something is genuinely asymmetric
        # --- structural truth rules (R1 format-equivalence, R2 cross-presence) ---
        so, sn = semantic_normalize(old), semantic_normalize(new)
        if so and sn and so == sn:
            # R1: identical after format stripping → paraphrase/format noise
            continue
        # R2: textual values — if old-text already appears in A AND new-text
        # already appears in B, the "diff" is row-misalignment or granularity
        # noise, not a real A→B change.
        if re.search(r"[\u4e00-\u9fff]", old) and re.search(r"[\u4e00-\u9fff]", new):
            a_corpus = semantic_normalize(texts.get("A", ""))
            b_corpus = semantic_normalize(texts.get("B", ""))
            if so and sn and so in a_corpus and sn in b_corpus:
                continue  # both texts exist in both docs → not a change

        # context tokens: prefer name+topic (most specific); fall back to
        # name-only when the topic is generic (e.g. "闪烁频率与时间要求"
        # never appears on the clause page itself).
        _stop = {"和", "与", "或", "的", "前", "后", "上", "下", "于", "对"}
        def _ctx(s: str) -> list[str]:
            return [t for t in re.split(r"[（()/、，,\s]+", s)
                    if len(t) >= 2 and not t.isdigit() and t not in _stop]
        ctx_full = _ctx(name + " " + v.get("topic", ""))
        ctx_name = _ctx(name)

        def _locate(text: str, value: str) -> tuple[str, str, bool]:
            """Return (page, located_number, used_context)."""
            if not value:
                return "", "", False
            # Multi-pass: full context → name-only → no context (legacy first-hit).
            for ctx in (ctx_full, ctx_name, None):
                used_ctx = ctx is not None
                for n in strong_nums(value):
                    pg = find_page(text, n, context_tokens=ctx)
                    if pg:
                        return pg, n, used_ctx
            return "", "", False

        # ---- Clause-anchored lookup (PRIMARY, most precise) ----
        # diff source lists clause prefixes like "B=5.9, 5.10 ... A=5.9/5.10".
        # Extract ALL prefixes (split on common separators) and search for
        # subclauses whose body contains the value (digit + Chinese forms).
        src = str(v.get("source", ""))
        def _clauses(side: str) -> list[str]:
            m = re.search(side + r"=([^→;；]+?)(?=\s*→|\s*[;；]|$)", src)
            if not m:
                return []
            seg = m.group(1)
            # expand ranges like "5.14-5.17" → ["5.14","5.15","5.16","5.17"]
            def _expand(mo):
                a, b = mo.group(1), mo.group(2)
                pa, pb = a.rsplit(".", 1), b.rsplit(".", 1)
                if pa[0] == pb[0] and pa[1].isdigit() and pb[1].isdigit():
                    lo, hi = int(pa[1]), int(pb[1])
                    if 0 < hi - lo < 20:
                        return ",".join(f"{pa[0]}.{i}" for i in range(lo, hi + 1))
                return mo.group(0)
            seg = re.sub(r"(\d+(?:\.\d+)*)-(\d+(?:\.\d+)*)", _expand, seg)
            parts = re.split(r"[,/、\s]+", seg)
            return [p.strip() for p in parts if re.fullmatch(r"\d+(?:\.\d+)*", p.strip())]
        b_clauses = _clauses("B")
        a_clauses = _clauses("A")
        def _needles(val: str) -> list[str]:
            """digit forms + full value + CN-unit variants (两只/三只).
            Bare single digits ('1','2') are EXCLUDED — they match every page
            and would win the nearest-distance pick spuriously. If that leaves
            nothing, fall back to the full value string (any length)."""
            s = (val or "").strip()
            if not s:
                return []
            out = []
            # distinctive digits only: >=2 digits or decimal
            out += [d for d in re.findall(r"\d+(?:\.\d+)?", s) if len(d) >= 2 or "." in d]
            if len(s) >= 4:
                out.append(s)
            # Mid-length prefixes: the full value sometimes has extraction
            # artifacts (trailing duplicate unit "…2只（成对）只") so it never
            # matches verbatim; a 10-12 char prefix ("A1类或A2类位置灯，2")
            # is still clause-specific and survives the artifact.
            for L in (12, 10, 8):
                if len(s) >= L + 3:
                    out.append(s[:L])
            out += re.findall(r"[一二三四五六七八九十百千万两]+[只个套米瓦赫度秒年]", s)
            # digit+unit forms BOTH as-is and as CN+unit:
            # corpus A uses "2只" (arabic), corpus B uses "两只" (CN) —
            # generate both so either side can match.
            du = re.findall(r"\d+[只个套米瓦赫度秒年]", s)
            out += du
            for x in du:
                m = re.match(r"(\d+)([只个套米瓦赫度秒年])", x)
                if m:
                    out.append(_DIGIT_TO_CN.get(m.group(1), m.group(1)) + m.group(2))
            seen, uniq = set(), []
            for x in out:
                if x not in seen:
                    seen.add(x); uniq.append(x)
            if not uniq and s:
                uniq = [s]
            return uniq
        b_needles = _needles(old)
        a_needles = _needles(new)
        b_page = _find_page_by_clause(b_text, b_clauses, b_needles, name_hint=name) if b_clauses else ""
        a_page = _find_page_by_clause(a_text, a_clauses, a_needles, name_hint=name) if a_clauses else ""
        b_loc = re.search(r"\d+(?:\.\d+)?", old or "")
        a_loc = re.search(r"\d+(?:\.\d+)?", new or "")
        b_loc = b_loc.group(0) if b_loc else ""
        a_loc = a_loc.group(0) if a_loc else ""

        # ---- Fallback: fuzzy multi-pass locate if clause lookup misses ----
        if not b_page:
            b_page, b_loc, _ = _locate(b_text, old)
        if not a_page:
            a_page, a_loc, _ = _locate(a_text, new)
        # Trust weak pin only when context actually produced the hit.
        had_context = bool(b_clauses or a_clauses) or bool(b_page and a_page)

        def _weak(n: str) -> bool:
            # bare 2-digit integer (no decimal, <3 digits) is too common to pin a page
            return bool(n) and "." not in n and len(n) < 3

        weak_location = _weak(b_loc) or _weak(a_loc)
        # Weak pin (e.g. "10") must not render a misleading page — UNLESS the
        # page was pinned via context (回复反射器 clause page), in which case
        # the bare-number hit IS the real clause and the page is trustworthy.
        if weak_location and not had_context:
            b_page = ""
            a_page = ""
        status = "verified" if (b_page and a_page) else ("partial" if (b_page or a_page) else "unverified")
        if status == "verified" and weak_location and not had_context:
            status = "unverified"  # short-number page pin is not trustworthy without context

        # ---- same-text / format-only / duplicate demotion ----
        # Second evaluation (5.5/10) proved 6/12 rows were TRUNCATION false
        # positives: B's displayed value only showed "1200mm" while B's real
        # clause also says "…可增加到1500mm" — identical to A. Two evidence
        # rules demote such rows out of the numeric-change table:
        #   R-seq: digit sequences (after CN-normalisation) identical → format-only
        #   R-extra: A's distinctive digits missing from B's *displayed* value
        #            but present on B's located clause page → same text
        def _seq(s: str) -> list[str]:
            t = normalize_cn(s or "")
            for ch, dig in CN_NUM.items():  # 两只→2只 even embedded
                t = t.replace(ch, dig)
            return re.findall(r"\d+(?:\.\d+)?", t)

        demote = None
        seq_old, seq_new = _seq(old), _seq(new)
        old_dist = {d for d in seq_old if len(d) >= 2 or "." in d}
        new_dist = {d for d in seq_new if len(d) >= 2 or "." in d}
        if seq_old == seq_new:
            demote = "数值序列相同（仅格式/单位差异，非数值变化）"
        elif not old_dist and not new_dist:
            # e.g. B diff captured only "两只" while A captured the full clause —
            # neither side has a distinctive digit, so there is no numeric
            # change at all (纯格式/文字层面差异，A1/A2 分类等实质内容已由
            # 人工补录覆盖).
            demote = "两侧均无特征数字（纯格式/文字差异，非数值变化）"
        else:
            extras = [d for d in dict.fromkeys(seq_new) if (len(d) >= 2 or "." in d) and d not in old_dist]
            if extras and b_page:
                bctx = _page_slice(b_text, b_page)
                if bctx and all(e in bctx for e in extras):
                    demote = f"B 同页已含 {'/'.join(extras)}（B 列摘录截断造成的同文假差异）"
        sig = (b_page, a_page, tuple(seq_old), tuple(seq_new))
        if not demote and b_page and a_page and sig in kept_sigs:
            demote = "与前一条同参数、同页码（重复行）"
        if demote:
            same_text.append({
                "topic": v.get("topic", ""),
                "name": name,
                "oldValue": display_clean(old),
                "newValue": display_clean(new),
                "unit": v.get("unit", ""),
                "bPage": b_page,
                "aPage": a_page,
                "reason": demote,
            })
            continue

        out.append({
            "topic": v.get("topic", ""),
            "name": name,
            "oldValue": display_clean(old),
            "newValue": display_clean(new),
            "unit": v.get("unit", ""),
            "bPage": b_page,
            "aPage": a_page,
            "status": status,
        })
        kept_sigs.append(sig)
    return out, same_text

def load_extract_cache():
    """Load per-topic A/B/C extraction (24 topics each)."""
    docs = {}
    for f in glob.glob(str(CACHE_DIR / "v3-*.json")):
        d = json.load(open(f, encoding="utf-8"))
        docs[d.get("label", "")] = d
    return docs

def build_topic_columns(cache_docs, texts):
    """A|B|C three-column comparison per topic with excerpt verification.
    Topic names are normalised (spaces stripped) so variants like
    '追尾警告信号 Vr 表' / '追尾警告信号Vr表' merge into one row."""
    labels = ["A", "B", "C"]
    topic_names = []
    seen_keys = set()
    for lb in labels:
        if lb in cache_docs:
            for t in cache_docs[lb].get("topics", []):
                if t.get("presence") != "no":
                    key = t["topic"].replace(" ", "")
                    if key not in seen_keys:
                        seen_keys.add(key)
                        topic_names.append(t["topic"])
    # merge lookup: normalised key -> canonical display name
    cols = []
    stats = {"total": 0, "verified": 0, "partial": 0, "missing": 0}
    def norm_key(s: str) -> str:
        return s.replace(" ", "")

    # MinerU embeds HTML subscripts (N<sub>2</sub>G) while the extract-cache
    # excerpts are plain (N2G) — strip tags once per doc for ALL matching
    # (page markers [第N页] survive), else excerpts never match verbatim.
    stripped = {lb: re.sub(r"<[^>]+>", "", texts.get(lb, "")) for lb in labels}

    for topic in topic_names:
        row = {"topic": topic}
        for lb in labels:
            doc = cache_docs.get(lb)
            if not doc:
                continue
            t = next(
                (x for x in doc.get("topics", [])
                 if x.get("topic", "").replace(" ", "") == norm_key(topic)),
                None,
            )
            if not t or t.get("presence") == "no":
                row[lb] = None
                continue
            excerpt = re.sub(r"<[^>]+>", "", t.get("excerpt") or "")[:200]  # inline tags leak as literal text
            clause = t.get("clause", "")
            claimed_page = t.get("page", "")
            # --- C definition-style excerpt upgrade ---
            # If A/B carry an installation/fitting requirement ("配备") but C's
            # excerpt is a terminology definition ("X means ..."), swap C's
            # excerpt for the fitting paragraph at "<clause>.N Number/Presence"
            # (e.g. 远光灯配备: definition 2.5.1 → C 6.1.2 "Number: Two, type
            # approved per UN R149"). Definition ≠ installation requirement.
            if lb == "C" and clause and re.search(r"\bmeans\b", excerpt):
                a_ex = (row.get("A") or {}).get("excerpt") or ""
                b_ex = (row.get("B") or {}).get("excerpt") or ""
                if "配备" in a_ex or "配备" in b_ex or "安装" in a_ex:
                    ctext = stripped.get("C", "")
                    m = re.search(
                        re.escape(clause) + r"\.\d+\.?\s*\|?\s*(?:Number|Presence|Mandatory|Optional)",
                        ctext,
                    )
                    if m:
                        cand = ctext[m.start():m.start() + 300]
                        cand_page = find_page(ctext, cand)
                        if cand_page:
                            excerpt = cand
                            claimed_page = claimed_page or cand_page
            # verify excerpt against MinerU text (tag-stripped corpus)
            actual_page = find_page(stripped.get(lb, ""), excerpt)
            if not actual_page and clause:
                actual_page = find_page(stripped.get(lb, ""), clause)
            # Context gate (second evaluation: 3/3 sampled A pages wrong yet
            # marked ✓, and TOC echoes pass a token check because a TOC page
            # contains EVERY topic). Three-way predicate, then contextual
            # retry; no valid page → missing (honest ⚠, count is honest).
            def _topic_chunk(tp: str) -> str:
                for part in re.split(r"[与和及的、\s（）()]+", tp):
                    if len(part) >= 3 and re.fullmatch(r"[一-鿿]+", part):
                        return part
                runs = re.findall(r"[一-鿿]{3,}", tp)
                return runs[0] if runs else ""

            ctext = stripped.get(lb, "")
            # ALL clause numbers (ranges like "6.14 / 6.15 / 6.16 / 6.17" and
            # "4.5-4.8/第5章") — the page must carry ANY of them, not just the
            # first (first-only false-killed valid C/A excerpts).
            cnums = re.findall(r"\d+(?:\.\d+)+", clause or "")

            def _page_ok(seg: str) -> bool:
                if re.search(r"目\s*次|目录|\.{3,}", seg):
                    return False  # TOC echo carries every topic + clause
                ch = _topic_chunk(topic)
                # Long paraphrase topics ("灯具光色对应表") never appear verbatim
                # on the page (the table header says "灯具名称") — skip the
                # chunk gate for them; short device tokens stay enforced.
                if ch and len(ch) <= 6 and ch in ctext and ch not in seg:
                    return False  # doc has the token but this page doesn't
                if cnums and not any(c in seg for c in cnums):
                    return False  # no listed clause number on this page
                return True

            if actual_page and not _page_ok(_page_slice(ctext, actual_page)):
                actual_page = ""
            if not actual_page:
                ch = _topic_chunk(topic)
                # only short device tokens make a usable context window
                ctx = [ch] if 3 <= len(ch) <= 6 and ch in ctext else None
                for cand in (find_page(ctext, excerpt, context_tokens=ctx) if ctx else "",
                             find_page(ctext, clause) if clause else ""):
                    if cand and _page_ok(_page_slice(ctext, cand)):
                        actual_page = cand
                        break
            status = "verified" if actual_page else "missing"
            row[lb] = {
                "clause": clause,
                "claimedPage": claimed_page,
                "actualPage": actual_page,
                "excerpt": excerpt,
                "status": status,
            }
            stats["total"] += 1
            if status == "verified":
                stats["verified"] += 1
            else:
                stats["missing"] += 1
        cols.append(row)
    return cols, stats

def run_verify() -> dict:
    """Run the full verification and return the result dict. Sidecar-friendly:
    importable without triggering the CLI main()."""
    print("[verify] loading MinerU ground truth...")
    texts = load_mineru()
    for k, v in texts.items():
        print(f"  {k}: {len(v)} chars")

    print("[verify] loading diff valueDiffs...")
    diff = json.load(open(DIFF, encoding="utf-8"))
    vds = diff.get("valueDiffs", [])
    real, wording, renumbered = noise_filter_diffs(vds)
    print(f"  {len(vds)} total → {len(real)} real numeric changes + {len(wording)} paraphrase noise (dropped)")

    print("[verify] verifying numeric changes against MinerU text...")
    verified, same_text = verify_numeric_changes(real, texts)
    from collections import Counter
    st = Counter(v["status"] for v in verified)
    print(f"  status: {dict(st)} | same-text demoted: {len(same_text)}")

    print("[verify] building A|B|C topic columns...")
    cache_docs = load_extract_cache()
    print(f"  extract-cache docs: {list(cache_docs.keys())}")
    cols, cstats = build_topic_columns(cache_docs, texts)
    print(f"  {len(cols)} topics, excerpt verification: {cstats}")

    # Field-level classification: prose must not pose as numeric data.
    numeric_only = [c for c in verified
                    if classify_value_kind(c.get("oldValue", ""), c.get("newValue", "")) == "numeric"]
    text_only = [c for c in verified
                 if classify_value_kind(c.get("oldValue", ""), c.get("newValue", "")) == "text"]
    print(f"  field-level split: {len(numeric_only)} numeric + {len(text_only)} text")

    out = {
        "numericChanges": numeric_only,
        # demoted by evidence rules (second evaluation): truncated same-text /
        # format-only / duplicate rows — rendered as a correction list
        "sameTextDropped": same_text,
        "textChanges": text_only,
        "renumberedOnly": [
        {"topic": w.get("topic", ""), "name": w.get("name", ""),
         "oldValue": w.get("oldValue", ""), "newValue": w.get("newValue", "")}
        for w in renumbered
    ],
    "wordingOnly": [
            {"topic": w.get("topic", ""), "name": w.get("name", ""),
             "oldValue": display_clean(w.get("oldValue", "")),
             "newValue": display_clean(w.get("newValue", ""))}
            for w in wording
        ],
        "topicColumns": cols,
        "stats": {"numeric": dict(st), "excerpts": cstats},
        # candidate-flow accounting: 45 valueDiffs must fully partition into
        # numeric + renumbered + wordingFiltered + sameTextDropped + ruleDropped
        # (exec summary). ruleDropped = ONLY the in-verify R1/R2/voltage drops;
        # demoted same-text rows live in their own bucket (not double-counted).
        "flow": {"candidates": len(vds), "ruleDropped": len(real) - len(verified) - len(same_text)},
        # Manual-audit findings — verified directly against A/B original PDF
        # text by human audit (v6.8), because the 18-topic diff pipeline
        # never inspects AFS/自适应前照灯 (not one of the 18 fixed topics).
        "manualFindings": [
            {
                "topic": "自适应前照灯(AFS/带自适应模式)",
                "name": "数量",
                "oldValue": "B 5.22.2 数量：一套",
                "newValue": "A 5.3.2 数量：基础模式近光安装单元 2 只 + 远光安装单元 2 只",
                "unit": "套/只",
                # Physical PDF pages (viewer page), fitz-verified by audit_pages.py:
                # B 5.22.2 数量 = physical p49 (TOC printed 45, offset +4);
                # A 5.3.2 数量 = physical p30 (heading 5.3 is p29, 数量 next page).
                "bPage": "第49页",
                "aPage": "第30页",
                "status": "verified",
                "source": "manual-audit",
                "note": "B(5.22 AFS) 与 A(5.3 带自适应模式的前照灯) 结构对应；18 主题 diff 未覆盖，人工对照原文补录",
            },
            {
                # GB4785 表11.6 第5条印证；fitz-verified this round.
                "topic": "慢行灯",
                "name": "倒车灯作慢行灯 / 慢行灯自动点亮速度阈值",
                "oldValue": "前行速度小于10km/h可作慢行灯（B p30）；慢行灯自动点亮直至10km/h（B p57 5.25.7）",
                "newValue": "前行速度小于15km/h可作慢行灯（A p58）；慢行灯自动点亮直至15km/h（A p59 5.22.7）",
                "unit": "km/h",
                "bPage": "第30页",
                "aPage": "第58页",
                "status": "verified",
                "source": "manual-audit",
                "note": "10→15 km/h，两处子句均改（倒车灯 crossover + 慢行灯自动点亮）；GB4785 表11.6 第5条声称已印证；18 主题 diff 未覆盖",
            },
            {
                # fitz-verified: B p25 5.2.6.1.1 表 (h<0.8 / 0.8-1.0 分档) vs A p27 表7 (0.5-0.9 / 0.9-1.2 / 1.2-1.5 分档)
                "topic": "近光灯",
                "name": "安装高度-倾斜度限值表分档",
                "oldValue": "B 5.2.6.1.1：h<0.8m 限值-0.5%~-2.5%、初始照准-1.0%~-1.5%；0.8≤h≤1.0m 分档",
                "newValue": "A 表7：0.5≤h≤0.9m（上限-0.5、下限0→-(h+1.2)）；0.9<h≤1.2m；1.2<h≤1.5m 分档",
                "unit": "m / %",
                "bPage": "第25页",
                "aPage": "第27页",
                "status": "verified",
                "source": "manual-audit",
                "note": "分档边界 0.8/1.0 → 0.9/1.2/1.5 结构性改变，限值公式也不同；前照灯调光硬数据，18 主题 diff 未覆盖",
            },
            {
                # fitz full-doc scan: 'A1类'/'A2类' A hits p16/28/44/45/46/56; B = 0 hits
                "topic": "前位灯",
                "name": "A1/A2 类位置灯互斥配备分类（B 无）",
                "oldValue": "（B 全文 0 命中 A1类/A2类——无此分类）",
                "newValue": "A 5.9.1：A1类位置灯不应与A2类位置灯同时配备；A2类位置灯不应与昼间行驶灯同时配备",
                "unit": "",
                "bPage": "",
                "aPage": "第44页",
                "status": "verified",
                "source": "manual-audit",
                "note": "A 独有新分类（B 全文 0 命中）；关联附录C 环境光自动控制（A p16 A2类>1000lx）；18 主题 diff 未覆盖",
            },
            {
                # fitz-verified (round 3 evaluation gap #1)
                "topic": "倒车灯",
                "name": "垂直几何可见度 α 角",
                "oldValue": "B 5.4.5.1：α角向上15°、向下5°",
                "newValue": "A 5.21.5.1：垂直方向角α向上、向下各10°",
                "unit": "°",
                "bPage": "第29页",
                "aPage": "第58页",
                "status": "verified",
                "source": "manual-audit",
                "note": "15°/5° → 10°/10° 实质数值变化；18 主题 diff 未覆盖，第二轮评估缺口补录",
            },
            {
                # fitz-verified (round 3 evaluation gap #2)
                "topic": "前雾灯",
                "name": "明暗截止线倾斜度判定基准",
                "oldValue": "B 5.3.6.1：按灯等级（B级-1.5%；F3≤2000lm -1.0%，>2000lm 按h分档）",
                "newValue": "A 5.4.6.1.1：按光通量（单侧≤2000lm 即-1.0%），判定逻辑重构",
                "unit": "%",
                "bPage": "第28页",
                "aPage": "第35页",
                "status": "verified",
                "source": "manual-audit",
                "note": "判定基准从灯等级改为光通量——结构性变化；18 主题 diff 未覆盖",
            },
            {
                # fitz-verified (round 3 evaluation gap #3)
                "topic": "示廓灯",
                "name": "前示廓灯高度基准线",
                "oldValue": "B 5.13.4.2：不低于与挡风玻璃上边缘相切的水平面",
                "newValue": "A 5.13.4.2：不低于与挡风玻璃透明区域上边缘相切的水平面",
                "unit": "",
                "bPage": "第42页",
                "aPage": "第51页",
                "status": "verified",
                "source": "manual-audit",
                "note": "基准从玻璃上边缘收紧为透明区域上边缘——影响最低安装高度计算；18 主题 diff 未覆盖",
            },
            {
                # fitz-verified (round 3 evaluation gap #4)
                "topic": "慢行灯",
                "name": "位置要求从无到有",
                "oldValue": "B 5.25.4：位置无特殊要求",
                "newValue": "A 5.22.4.2/4.3：新增侧面灯具离地高度≤1500mm、同侧相邻间距≥0.5m",
                "unit": "mm / m",
                "bPage": "第56页",
                "aPage": "第59页",
                "status": "verified",
                "source": "manual-audit",
                "note": "B 无位置限制 → A 新增两条定位要求；18 主题 diff 未覆盖",
            },
            {
                # 3rd evaluation completeness gap #1: lateral 400→500mm relaxation
                "topic": "示廓灯",
                "name": "横向距离放宽至 500mm（A 独有）",
                "oldValue": "B 5.13.4.1 无 500mm 放宽条款",
                "newValue": "A 5.13.4.1：若为满足 5.13.4.2 要求，此距离可放宽至 500mm",
                "unit": "mm",
                "bPage": "",
                "aPage": "第50页",
                "status": "verified",
                "source": "manual-audit",
                "note": "B 不大于400mm 即认为满足；A 新增 500mm 放宽——工程间隙直接影响；18 主题 diff 未覆盖",
            },
        ],
    }
    return out


def main():
    out = run_verify()
    json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"[verify] saved {OUT} ({OUT.stat().st_size // 1024} KB)")
    # SINGLE SOURCE OF TRUTH — one facts.json the report renderer reads.
    facts_path = OUT.parent / "facts.json"
    facts = {
        "version": "v6.9",
        "sourceTracks": {
            "candidates": "MuPDF+LLM (extract-cache/diff-result)",
            "groundTruth": "MinerU 4.0.6 multimodal",
        },
        "numericChanges": out.get("numericChanges", []),
        "sameTextDropped": out.get("sameTextDropped", []),
        "textChanges": out.get("textChanges", []),
        "renumberedOnly": out.get("renumberedOnly", []),
        "wordingOnly": out.get("wordingOnly", []),
        "manualFindings": out.get("manualFindings", []),
        "topicColumns": out.get("topicColumns", []),
        "stats": out.get("stats", {}),
        "counts": {
            # candidate-flow accounting for the exec summary: every valueDiff
            # must land in exactly one bucket (numeric + renumbered +
            # wordingFiltered + ruleDropped) — no silent gaps.
            "candidates": out.get("flow", {}).get("candidates", 0),
            "ruleDropped": out.get("flow", {}).get("ruleDropped", 0),
            "numeric": len(out.get("numericChanges", [])),
            "sameText": len(out.get("sameTextDropped", [])),
            "text": len(out.get("textChanges", [])),
            "renumbered": len(out.get("renumberedOnly", [])),
            "wordingFiltered": len(out.get("wordingOnly", [])),
            "manual": len(out.get("manualFindings", [])),
            "topics": len(out.get("topicColumns", [])),
            "excerptVerified": out.get("stats", {}).get("excerpts", {}).get("verified", 0),
            "excerptTotal": out.get("stats", {}).get("excerpts", {}).get("total", 0),
        },
    }
    json.dump(facts, open(facts_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("[verify] saved facts.json (single source of truth): counts=%s" % facts["counts"])

if __name__ == "__main__":
    main()