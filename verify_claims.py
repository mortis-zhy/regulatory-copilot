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
import json, re, glob, os, sys, io, hashlib
from pathlib import Path
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# Repo root: derive from __file__ so a checkout can live anywhere.
# COMPARE_AGENT_ROOT overrides for callers that place the corpus elsewhere.
ROOT = Path(os.environ.get("COMPARE_AGENT_ROOT", Path(__file__).resolve().parent))
MINERU = ROOT / "dist" / "mineru-v4-data.json"
DIFF = ROOT / "diff-result.json"
CACHE_DIR = ROOT / "dist" / "extract-cache"
OUT = ROOT / "dist" / "verified-comparison.json"

# scripts/diff_corrections.py — 差值表的机械清洗 + 人工更正。
# 它住在 scripts/ 下（不是包），按路径加载。
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location("diff_corrections", str(ROOT / "scripts" / "diff_corrections.py"))
dc = _ilu.module_from_spec(_spec)
_spec.loader.exec_module(dc)

# scripts/versions.py —— 全项目唯一的版本清单声明处
_vspec = _ilu.spec_from_file_location("versions", str(ROOT / "scripts" / "versions.py"))
versions = _ilu.module_from_spec(_vspec)
_vspec.loader.exec_module(versions)

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


# ---------------------------------------------------------------------------
# 差值表的「这一行到底算不算变化」
# ---------------------------------------------------------------------------
# 限值口径词：数字相同但口径相反（「不大于 65」vs「不小于 65」）是**真变化**，
# 所以比数字的时候必须连口径一起比。
_POLARITY = ("不大于", "不小于", "不超过", "不低于", "不得大于", "不得小于",
             "不多于", "不小于", "至少", "最多", "大于", "小于", "以上", "以下",
             "上限", "下限", "范围", "±", "+-")


def _limit_signature(s: str) -> tuple:
    """取值里的「数字 + 口径」签名。两侧签名相同 = 限值口径相同。"""
    t = semantic_normalize(s or "")
    numbers = tuple(re.findall(r"-?\d+(?:\.\d+)?", t))
    polarity = tuple(w for w in _POLARITY if w in t)
    return numbers, polarity


def build_diff_verdicts(vds_fixed: list, fixed_by_key: dict, buckets: dict) -> dict:
    """给每条差值判定「算不算变化」。

    优先级：
    1. `data/diff-corrections.json` 的人工裁定（回原文核过，最高优先）
    2. 证据规则的分桶（已核验变化 / 同文勘误 / 引用重排 / 规则非变化）
    3. 表述差异桶里，再比一次「数字 + 口径」：
       相同 → 数值与口径相同（非数值变化）；不同 → 表述差异（未做数值核验）
    4. 都不匹配 → 待核实（**不写「有变化」**）

    为什么要有这一层：第 11.3.3 那张 45 行矩阵过去用「两个取值当字符串一比」
    判变化，于是「（4.0±1.0）HzHz」vs「(4.0±1.0)Hz」、「不大于500mm」vs「500m」
    都被判成**有变化** —— 45 行里 42 行是假的，矩阵小结还写着「45 项有实质变化」。
    """
    def _k(row):
        return f"{row.get('topic','')}|{row.get('name','')}"

    def _index(rows):
        idx = {}
        for r in rows or []:
            idx.setdefault(_k(r), []).append(r)
        return idx

    idx_num = _index(buckets.get("numeric"))
    idx_same = _index(buckets.get("sameText"))
    idx_word = _index(buckets.get("wording"))
    idx_renum = _index(buckets.get("renumbered"))
    idx_rule = _index(buckets.get("ruleDropped"))

    out = {}
    for row in vds_fixed or []:
        k = _k(row)
        verdict, reason = None, ""
        manual = row.get("verdict")
        if manual == "change":
            verdict = "有变化"
            reason = row.get("verdictReason", "")
        elif manual == "no-change":
            verdict = "两版同文（已回原文核验）"
            reason = row.get("verdictReason", "")
        elif manual == "duplicate":
            verdict = "重复行（已合并）"
            reason = row.get("verdictReason", "")
        elif manual == "unverified":
            verdict = "待核实"
            reason = row.get("verdictReason", "")
        elif k in idx_num:
            r = idx_num[k][0]
            verdict = "有变化" if r.get("status") == "verified" else "有变化（待核实）"
            reason = "已定位到原文页码" if r.get("status") == "verified" else "未能定位到原文页码"
        elif k in idx_same:
            verdict = "两版同文（勘误）"
            reason = (idx_same[k][0].get("reason") or "")
        elif k in idx_renum:
            verdict = "引用编号变化（非实质）"
            reason = "章节重组导致的条款号重排"
        elif k in idx_rule:
            verdict = "非变化（规则判定）"
            reason = (idx_rule[k][0].get("reason") or "")
        elif k in idx_word:
            so = _limit_signature(row.get("oldValue", ""))
            sn = _limit_signature(row.get("newValue", ""))
            if so[0] and so == sn:
                verdict = "数值与口径相同（非数值变化）"
                reason = "两版数字与限值口径一致，仅措辞/格式不同"
            else:
                verdict = "表述差异（未做数值核验）"
                reason = "数字或口径不同，需人工逐条比对原文（见 11.8）"
        else:
            verdict = "待核实"
            reason = "未匹配到任何证据分桶"
        out[k] = {
            "verdict": verdict,
            "reason": reason,
            "oldValue": row.get("oldValue", ""),
            "newValue": row.get("newValue", ""),
            "topic": row.get("topic", ""),
            "name": row.get("name", ""),
            "source": row.get("source", ""),
            "aClause": row.get("aClause", ""),
            "bClause": row.get("bClause", ""),
        }
    return out

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

    Returns (verified_rows, same_text_dropped, rule_dropped):
    - same_text_dropped: rows the second evaluation proved NOT to be changes
      (B's displayed value was truncated; B's real clause text already
      contains A's digits, or the digit sequences are identical after
      CN-normalisation, or the row duplicates an earlier kept row).
    - rule_dropped: rows rejected by the structural rules R1 / R2 / the voltage
      tier checks, each tagged with which rule fired and why.
    """
    out = []
    same_text: list[dict] = []
    # Every candidate a structural rule rejects lands here with a machine-readable
    # `rule` + human-readable `reason`. These five branches used to be bare
    # `continue`s, so a reviewer saw only the aggregate `ruleDropped` count and
    # never learned WHICH row vanished or WHY. The demotion rules further down
    # already recorded reasons into same_text; these did not.
    rule_dropped: list[dict] = []
    kept_sigs: list[tuple] = []
    for v, old, new in real_tuples:
        name = v.get("name", "")
        b_text = texts.get("B", "")
        a_text = texts.get("A", "")

        def drop(rule: str, reason: str):
            rule_dropped.append({
                "topic": v.get("topic", ""), "name": name,
                "oldValue": old, "newValue": new,
                "rule": rule, "reason": reason,
            })

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
                else:
                    drop("V-6V-not-asymmetric",
                         "6.75V 未构成 A/B 不对称（B 含 6.75V 或 A 亦含），不作为变化")
                continue  # 6V handled (either emitted or not) — never fall through
            if v_new == "6.75":
                # A has a 6V value? doesn't happen; skip defensively
                drop("V-6V-new-side", "A 侧出现 6.75V（防御性丢弃，实际不应发生）")
                continue
            # 12V/24V rows: tier should be unchanged in both — drop unless
            # the same tier truly differs (it doesn't, verified manually).
            # To be safe: only keep if the tier value genuinely differs AND
            # both tiers are present in both docs → otherwise drop.
            o_in_b, o_in_a = v_old in b_text, v_old in a_text
            n_in_b, n_in_a = v_new in b_text, v_new in a_text
            if (o_in_b and o_in_a) and (n_in_b and n_in_a):
                drop("V-both-present", "该电压档位在 A/B 两版中均出现，非 A→B 变化")
                continue  # both tiers present in both docs → NOT a change
            # fall through only if something is genuinely asymmetric
        # --- structural truth rules (R1 format-equivalence, R2 cross-presence) ---
        so, sn = semantic_normalize(old), semantic_normalize(new)
        if so and sn and so == sn:
            # R1: identical after format stripping → paraphrase/format noise
            drop("R1", "去标点/空白/内联公式后两侧完全相同，属格式或改写噪声")
            continue
        # R2: textual values — if old-text already appears in A AND new-text
        # already appears in B, the "diff" is row-misalignment or granularity
        # noise, not a real A→B change.
        if re.search(r"[\u4e00-\u9fff]", old) and re.search(r"[\u4e00-\u9fff]", new):
            a_corpus = semantic_normalize(texts.get("A", ""))
            b_corpus = semantic_normalize(texts.get("B", ""))
            if so and sn and so in a_corpus and sn in b_corpus:
                drop("R2", "旧值文本在 A 中已存在且新值文本在 B 中已存在，属行错位/粒度噪声")
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
    return out, same_text, rule_dropped


MANUAL_FINDINGS_PATH = ROOT / "data" / "manual-findings.json"
SOURCE_PDFS = {
    "A": ROOT.parent / "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "B": ROOT.parent / "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "C": ROOT.parent / "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
}


def _sha256_file(p: Path) -> str | None:
    if not p.exists():
        return None
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _load_manual_findings() -> list[dict]:
    """Load the human-audited findings and re-check them against the sources.

    The page numbers in these entries were confirmed by hand against one
    revision of one PDF. If a source PDF is later replaced, those page numbers
    are no longer evidence — so every entry is demoted to 待重核 with a
    `staleReason` instead of being reported as still-verified.
    """
    if not MANUAL_FINDINGS_PATH.exists():
        # Loud, because silently emitting zero findings would make the report
        # claim "0 条人工补录" and hide that the audit data went missing.
        raise FileNotFoundError(
            f"人工核验数据缺失：{MANUAL_FINDINGS_PATH}。该文件记录 manualFindings "
            "及其对应源 PDF 的 SHA-256；缺失会导致 11.3.1 章节内容消失。"
        )
    data = json.loads(MANUAL_FINDINGS_PATH.read_text(encoding="utf-8"))
    findings = data["findings"]
    # Guard against a truncated/emptied file: audit_pages.py used to parse these
    # out of the Python source and would pass vacuously on an empty match.
    if not findings:
        raise ValueError(f"{MANUAL_FINDINGS_PATH} 的 findings 为空 —— 人工核验数据疑似损坏")

    stale = []
    for label, meta in (data.get("sources") or {}).items():
        actual = _sha256_file(SOURCE_PDFS.get(label, Path("/nonexistent")))
        if actual is None:
            stale.append(f"{label}: 源 PDF 缺失")
        elif actual != meta.get("sha256"):
            stale.append(f"{label}: {meta.get('sha256', '?')[:8]}→{actual[:8]}")

    if stale:
        reason = "源 PDF 已变更或缺失（" + "；".join(stale) + "），页码需重新人工核验"
        for f in findings:
            f["status"] = "待重核"
            f["staleReason"] = reason
        print(f"[verify] manualFindings 已降级为待重核：{reason}")
    else:
        print(f"[verify] manualFindings {len(findings)} 条，源 PDF 哈希一致")

    findings = [dict(f) for f in findings]
    findings_stale = bool(stale)
    _load_manual_findings.stale = findings_stale  # type: ignore[attr-defined]
    return findings


def _pdf_page_disagrees(label: str, page_label: str, excerpt: str) -> str:
    """Return a reason string when the SOURCE PDF does not carry this excerpt on this page.

    `find_page` works on MinerU's own page-tagged text. MinerU's page boundaries
    and the source PDF's are not the same thing, so a page resolved against
    MinerU can name a page in the PDF that never contains the quote — and the
    report prints a ✓ next to it. The reader's only way to check is to open
    that page, so a page that fails the check must not be presented as verified.

    Multi-probe: a single prefix is too strict (MinerU drops and reorders
    fragments, and excerpts are normalised), but the quote cannot be nowhere on
    the page either.
    """
    m = re.search(r"(\d+)", page_label or "")
    if not m:
        return "页码无法解析"
    n = int(m.group(1))
    pages = _source_pdf_pages(label)
    if pages is None:
        return ""  # no source PDF available — do not punish what we cannot check
    if not (1 <= n <= len(pages)):
        return f"页码 {n} 越界（源 PDF 共 {len(pages)} 页）"
    e = _flat_cn_alnum(excerpt or "")
    if not e:
        return ""
    for L in (20, 14, 10, 8):
        for s in (0, len(e) // 2, max(0, len(e) - L)):
            if len(e) >= L and e[s : s + L] in pages[n - 1]:
                return ""
    return f"第{n}页在源 PDF 中找不到该摘录"


def _pdf_find_page(label: str, excerpt: str) -> tuple:
    """在源 PDF 全文里找这段摘录。

    返回 (页码, 说明)：
      · 唯一命中 → (页号, "")：页码指错了，但原文在这儿 —— 改页码，不降级
      · 多页命中 → (None, "在第 … 页都出现，无法判定"): 不敢指
      · 找不到   → (None, "源 PDF 全文找不到该摘录"): 这才是真缺口
    """
    pages = _source_pdf_pages(label)
    if pages is None:
        return None, ""
    e = _flat_cn_alnum(excerpt or "")
    if len(e) < 14:
        return None, "摘录太短，无法在全文里唯一定位"
    # **从最严的探针开始**：14 字的探针会在好几页上撞上（页眉、条款号），
    # 一撞上就判「无法判定」会把明明唯一的 24 字命中也误杀。
    for L in (24, 18, 14):
        if len(e) < L:
            continue
        hits = set()
        for i, ptxt in enumerate(pages, 1):
            for s in (0, len(e) // 2, max(0, len(e) - L)):
                if e[s : s + L] in ptxt:
                    hits.add(i)
                    break
        if len(hits) == 1:
            return next(iter(hits)), ""
        if hits:
            return None, "摘录在源 PDF 的第 %s 页都出现，无法判定在哪一页" % "/".join(
                str(x) for x in sorted(hits)[:4]
            )
    return None, "源 PDF 全文找不到该摘录"


_PDF_PAGE_CACHE: dict = {}


def _source_pdf_pages(label: str) -> list[str] | None:
    """Flattened per-page text of the uploaded PDF for `label`, or None."""
    if label in _PDF_PAGE_CACHE:
        return _PDF_PAGE_CACHE[label]
    out = None
    try:
        import fitz  # PyMuPDF

        def _fp(s: str, take: int = 2000) -> set:
            c = _flat_cn_alnum(s)[:take]
            return {c[i : i + 2] for i in range(len(c) - 1)}

        # Identify by content, not by page count — see parameterMatrix.ts, where
        # counting pages is what made two documents resolve to the same file.
        # Sampling only page 1 scores A and B 0.234 vs 0.233 — indistinguishable,
        # because GB 4785's draft and its 2019 predecessor share a cover. Taking
        # five pages across the document separates them (0.445 vs 0.346).
        want = _fp(_mineru_text(label))
        best, best_score, samples = None, 0.0, []
        for f in sorted((ROOT / "uploaded-docs").glob("*.pdf")):
            try:
                d = fitz.open(f)
                n = d.page_count
                pick = sorted({0, 2, n // 3, n - 2, n - 1})
                samples.append((_fp("".join(d[i].get_text() for i in pick)), d))
            except Exception:
                continue
        for grams, d in samples:
            score = (2 * len(want & grams) / (len(want) + len(grams))) if want and grams else 0.0
            if score > best_score:
                if best is not None:
                    best.close()
                best, best_score = d, score
            else:
                d.close()
        if best is not None and best_score >= 0.2:
            out = [_flat_cn_alnum(best[i].get_text()) for i in range(best.page_count)]
            best.close()
    except Exception:
        out = None
    _PDF_PAGE_CACHE[label] = out
    return out


def _mineru_text(label: str) -> str:
    try:
        return json.load(open(MINERU, encoding="utf-8")).get(label, {}).get("fullText", "")
    except Exception:
        return ""


def _flat_cn_alnum(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z一-鿿]", "", s or "")


def load_extract_cache():
    """Load per-topic A/B/C extraction (24 topics each).

    Two cache files can carry the same label — they are separate LLM extraction
    runs over the same PDF, and they disagree: for B's 慢行灯/限速灯 one says
    第56页 with a 配备/数量 excerpt, the other 第52页 with a 电路连接 excerpt.
    `docs[label] = d` used to be last-wins, so WHICH one landed in the report
    depended on the order the filesystem enumerated the directory. The symptom
    was a topic whose page and status flipped between two runs of this script
    with nothing on disk changing: "第4页 / verified" one time, "/ missing" the
    next, for a clause that is on neither page.

    Selection is therefore explicit — newest file wins — and every shadowed
    file is named on stdout. A silently-arbitrary pick is the same defect as a
    silently-arbitrary page number, one layer further up.
    """
    docs = {}
    by_label: dict[str, list[tuple[float, str]]] = {}
    for f in glob.glob(str(CACHE_DIR / "v3-*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            print(f"  extract-cache: 跳过 {Path(f).name}（解析失败: {e}）")
            continue
        by_label.setdefault(d.get("label", ""), []).append((os.path.getmtime(f), f))

    for label, entries in sorted(by_label.items()):
        entries.sort()
        chosen = entries[-1][1]
        docs[label] = json.load(open(chosen, encoding="utf-8"))
        if len(entries) > 1:
            shadowed = [Path(f).name for _, f in entries[:-1]]
            print(
                f"  ⚠ extract-cache: label={label} 有 {len(entries)} 份缓存，"
                f"采用最新的 {Path(chosen).name}；被覆盖（内容不一致，需人工确认哪份对）: "
                + ", ".join(shadowed)
            )
    return docs

def _collapse_doubled_clause(num: str) -> str:
    """`6.14.4.6.14.4.1` → `6.14.4.1`.

    MinerU merged some section headings into the first clause, so the text
    carries the clause, then the section heading, then the real clause again.
    Longest-match extraction yields a number that does not exist in R48; the
    reader would look it up and find nothing.
    """
    parts = (num or "").split(".")
    for cut in range(1, len(parts)):
        head, tail = parts[:cut], parts[cut:]
        if len(head) >= 2 and head[:2] == tail[:2]:
            return ".".join(tail)
    return num


def _c_boilerplate(clause: str, excerpt: str) -> bool:
    """True when C's excerpt is the Presence/Number/Arrangement样板.

    Both halves matter. The clause number alone (`6.5.1`) is decisive when the
    excerpt is empty, but the extractor sometimes reports the *section* (`6.5`)
    while quoting `6.5.1. Presence: …` — so the excerpt text is checked too.
    """
    c = clause or ""
    if re.match(r"^6\.\d+\.[123]\b", c):
        return True
    return bool(re.match(r"^\s*6\.\d+\.\d*\.?\s*(Presence|Number|Arrangement)\b", excerpt or "", re.I))


# R48 value units. Deliberately explicit: `.5` in a clause number is not a
# measurement, and `m` alone would match "5 m" inside prose that is not a limit.
_C_VALUE = re.compile(
    r"\d+(?:[.,]\d+)?\s*(?:mm|cd|cd/mm2|cd/m2|°|lx|Hz|km/h|km/s|mrad|nm)\b", re.I)


def _c_quantitative_clause(ctext: str, clause: str):
    """First quantitative clause in the SAME §6.x section as `clause`.

    Returns (excerpt, clause, page) or None. Preference order is the order an
    engineer reads them: .4 Position (where it goes), then .7 other
    requirements (how it behaves), then anything else above .3. Falls back
    to None rather than guessing — 宁可空着，不可错着.
    """
    m = re.match(r"^6\.(\d+)\b", clause or "")
    if not m:
        return None
    sec = "6." + m.group(1)
    if not ctext:
        return None
    # Bound the search to this section so 6.5's answer can't come from 6.6.
    # `[| \t]*`, NOT `[|\s]*`: `\s` includes the newline, so `^[|\s]*` can
    # slide down several lines and land on a different section's heading.
    # That made 6.13 resolve to a clause in 6.14 and made 6.6/6.7/6.8 return
    # None — the boundaries were matching, just in the wrong places.
    head_re = r"(?m)^[| \t]*%s(?!\d)(?:\.\s|\.(?=%s)|\s|$)"
    start = re.search(head_re % (re.escape(sec), re.escape(sec)), ctext)
    if not start:
        return None
    rest = ctext[start.start():]
    later = "|".join(str(int(m.group(1)) + k) for k in range(1, 12))
    nxt = re.search(head_re % (r"6\.(?:%s)" % later, r"6\.(?:%s)" % later), rest)
    body = rest[: nxt.start()] if nxt else rest

    best = None
    for cm in re.finditer(r"(?m)^[| \t]*(6\.\d+\.\d+(?:\.\d+)*)\.?\s*([^\n]{0,200})", body):
        num = cm.group(1)
        if re.match(r"^%s\.[123]\b" % re.escape(sec), num):
            continue  # Presence / Number / Arrangement — the boilerplate
        # MinerU renders R48 as a table: the clause number sits in one column
        # and its text — including the value — on the FOLLOWING lines. Testing
        # only the same line found 0 candidates in 6.6/6.7/6.8/6.13.
        window = body[cm.start(): cm.start() + 320]
        if not _C_VALUE.search(window):
            continue
        num = _collapse_doubled_clause(num)
        depth = num.count(".")
        rank = 0 if num.startswith(sec + ".4") else 1 if num.startswith(sec + ".7") else 2
        cand = (rank, -depth, num, cm.start())
        if best is None or cand < best[0]:
            best = (cand, num, window)
    if not best:
        return None
    _key, num, excerpt = best
    pg = find_page(ctext, excerpt)
    if not pg:
        return None
    return re.sub(r"\s+", " ", excerpt).strip()[:220], num, pg


def build_topic_columns(cache_docs, texts):
    """A|B|C three-column comparison per topic with excerpt verification.
    Topic names are normalised (spaces stripped) so variants like
    '追尾警告信号 Vr 表' / '追尾警告信号Vr表' merge into one row."""
    # 版本清单从**语料**推导 —— 写死 A/B/C 的话，换一套标准时
    # 它的条款一条都不会进核验，而报告照样写「已核验」。
    labels = [v for v in versions.KNOWN_VERSIONS if v in cache_docs] or list(cache_docs.keys())
    page_rejected: list[str] = []
    page_corrected: list[str] = []
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
    # No "partial" bucket: the per-row status below is only ever
    # "verified" or "missing", so the key could never leave 0 and would read as
    # "we found some rows we only half-verified". The source extract schema does
    # have a presence:"partial", but that means something different (topic
    # mentioned without a full clause) — reusing the name would be a lie.
    stats = {"total": 0, "verified": 0, "missing": 0}
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
            upgraded = False
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
            # --- C boilerplate upgrade (SKILL 坑 1 at the topic layer) ---
            # R48 orders every lamp section as §6.x.1 Presence / §6.x.2 Number /
            # §6.x.3 Arrangement, so a topic-name match lands on that boilerplate
            # by construction. Measured on the delivered PDF: 12 of 25 C excerpts
            # (48%) were §6.x.1 Presence, and chapter 7 had 9 of 11. The client
            # was reading "转向信号灯 · R48 要求：必须配备" — true, and useless.
            #
            # Fix: skip .1/.2/.3 and take the first QUANTITATIVE clause in the
            # same section (§6.x.4 Position / §6.x.7 other requirements), i.e.
            # one that carries a value with a unit. Deterministic, and the
            # excerpt still has to survive the source-PDF check below, so a
            # wrong pick degrades to 未核验 rather than shipping.
            if lb == "C" and _c_boilerplate(clause, excerpt):
                up = _c_quantitative_clause(stripped.get("C", ""), clause)
                if up:
                    excerpt, clause, claimed_page = up
                    upgraded = True
                else:
                    # No quantitative clause in that section — say so. §6.6
                    # (hazard) and §6.8 (plate lamp) genuinely carry only
                    # Presence/Number, and §6.1 is R48's "no individual
                    # specifications" chapter. Printing "Presence: Mandatory"
                    # reads as though that were the whole requirement; an
                    # explicit statement is the honest and more useful cell.
                    sec = re.match(r"^(6\.\d+)", clause or "")
                    sec = sec.group(1) if sec else "该章"
                    excerpt = ("R48 %s 对本主题只有配备/数量的规定，没有量化限值条款。"
                               "原文摘录为：%s" % (sec, re.sub(r"\s+", " ", excerpt).strip()[:150]))
                    upgraded = True
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
                # The table of contents is not the only page that enumerates
                # every clause number. GB 4785-2019's 起草说明 on PDF page 4
                # lists "…增加了慢行灯…(见3.9.29、5.25,3.9.24、5.20…)" — which
                # satisfied every gate below and made B's 慢行灯 resolve to
                # page 4, a foreword mention that is not the clause at all.
                # Front matter has to be rejected the same way the TOC is.
                if re.search(r"目\s*次|目录|\.{3,}|起草说明|前\s*言|引\s*言|修\s*订|foreword|introduction", seg):
                    return False
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
            if status == "verified":
                why = _pdf_page_disagrees(lb, actual_page, excerpt)
                if why:
                    claimed = actual_page
                    # The page number was located in MINERU's text, but the
                    # reader opens the source PDF. When the two disagree the
                    # ✓ is a citation to a page that does not contain the
                    # quote — four such cells existed (A 安装位置与几何可见度
                    # 第102页, B 光色与色度坐标表 / 灯具光色对应表 第16页,
                    # C 自动切换前照灯条件表 第65页). A wrong page number is
                    # worse than an admitted gap: it looks checkable and is not.
                    # 页码指错了，但摘录本身在源 PDF 里 —— **改页码**，
                    # 不要把一条有原文的引用说成「原文里找不到」。
                    # 实测 11 条未核验里 9 条属于这种（例：B 灯具光色对应表
                    # 抽取给 p16，摘录实际在 p19）。
                    fixed_page, amb = _pdf_find_page(lb, excerpt)
                    if fixed_page:
                        # 与其它格的页码格式保持一致（「第N页」）
                        actual_page = f"第{fixed_page}页"
                        status = "verified"
                        page_corrected.append(
                            f"{lb}/{topic} {claimed} → 第{fixed_page}页"
                        )
                    else:
                        status = "missing"
                        actual_page = ""
                        page_rejected.append(f"{lb}/{topic} ({why}{'；' + amb if amb else ''})")
            row[lb] = {
                "clause": clause,
                "claimedPage": claimed_page,
                "actualPage": actual_page,
                "excerpt": excerpt,
                "status": status,
                # True when the LLM excerpt was Presence/Number boilerplate and
                # was swapped for a quantitative clause. The report labels it,
                # so the reader knows C's quote is the installing/behaviour
                # requirement rather than the lamp merely existing.
                "upgradedFromBoilerplate": upgraded,
            }
            if status == "verified":
                stats["verified"] += 1
            else:
                stats["missing"] += 1
        cols.append(row)
    if page_corrected:
        print(f"  ✓ 页码已更正：{len(page_corrected)} 条摘录在源 PDF 里找到（抽取给的页码指错）")
        for r in page_corrected:
            print(f"     - {r}")
    if page_rejected:
        print(f"  ⚠ {len(page_rejected)} 个 ✓ 被证伪并降级为未核验（页码指向的源 PDF 页面找不到该摘录）")
        for r in page_rejected:
            print(f"     - {r}")

    # ---- 逐格回源复核（改过页码的也要再验一遍）----
    # 「改页码」这个动作必须自己经得起复核：每一格 ✓ 都要在源 PDF 的那一页上
    # 真的找得到那段摘录。对不上就报出来 —— 宁可让闸门红。
    recheck_fail = []
    recheck_ok = 0
    for row in cols:
        for lb in labels:
            c = row.get(lb) or {}
            if c.get("status") != "verified":
                continue
            why = _pdf_page_disagrees(lb, str(c.get("actualPage") or ""), c.get("excerpt") or "")
            if why:
                recheck_fail.append(f"{lb}/{row.get('topic')} 第{c.get('actualPage')}页 —— {why}")
            else:
                recheck_ok += 1
    print(
        f"  源 PDF 页码复核：{recheck_ok} 格 ✓ 逐格回源验过 · "
        f"{len(page_corrected)} 条页码已更正 · {len(recheck_fail)} 格证伪 · "
        f"{len(page_rejected)} 格降级为未核验"
    )
    for r in recheck_fail:
        print(f"     ✗ {r}")
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
    # 取值清洗 + 人工更正（scripts/diff_corrections.py + data/diff-corrections.json）。
    # 分类仍在**原始**取值上做（证据规则的判定不因人工更正而改变，账目闭合不变），
    # 但**展示用的取值**一律用更正后的版本 —— 报告里不该再出现「500mm」这种
    # 抄错单位的值，也不该再出现被重复写了两遍的单位。
    vds_fixed, _applied, _unmatched, _residual = dc.apply_corrections(vds)
    if _unmatched:
        raise AssertionError(
            f"差值更正表里有 {len(_unmatched)} 条没能在 valueDiffs 里找到对应行："
            + "；".join(f"{c.get('topic')}|{c.get('name')}" for c in _unmatched)
        )
    if _residual:
        raise AssertionError(
            f"差值表有 {len(_residual)} 处机械噪声（重复单位等）没有人工兜底："
            + "；".join(f"{d[0]}/{d[1]}:{d[2]}" for d in _residual)
        )
    # 键用**原始**的 topic|name（更正表里可能给某行改了名字，改完就认不出了）
    fixed_by_key = {
        f"{raw.get('topic','')}|{raw.get('name','')}": fixed
        for raw, fixed in zip(vds, vds_fixed)
    }

    def _fixed_row(row: dict) -> dict:
        """抽取行 → 更正后的行（按「主题|参数名」对齐；改过名的行也能对上）。"""
        key = "%s|%s" % (row.get("topic", ""), row.get("name", ""))
        return fixed_by_key.get(key) or row
    real, wording, renumbered = noise_filter_diffs(vds)
    print(f"  {len(vds)} total → {len(real)} real numeric changes + {len(wording)} paraphrase noise (dropped)")
    print(f"  取值更正：机械清洗 + {len(_applied)} 条人工更正（data/diff-corrections.json）")

    print("[verify] verifying numeric changes against MinerU text...")
    verified, same_text, rule_dropped = verify_numeric_changes(real, texts)
    from collections import Counter
    st = Counter(v["status"] for v in verified)
    rule_counts = Counter(r["rule"] for r in rule_dropped)
    print(f"  status: {dict(st)} | same-text demoted: {len(same_text)}")
    print(f"  rule-dropped: {len(rule_dropped)} {dict(rule_counts)}")

    # ---- 展示用取值换成更正后的版本（分类不变，账目不变）----
    def _with_fixed_values(rows: list) -> list:
        out_rows = []
        for r in rows:
            r2 = dict(r)
            fx = fixed_by_key.get(f"{r.get('topic','')}|{r.get('name','')}")
            if fx:
                for side in ("oldValue", "newValue"):
                    if fx.get(side) is not None:
                        r2[side] = fx[side]
                if fx.get("name_new"):
                    r2["name"] = fx["name_new"]
            out_rows.append(r2)
        return out_rows

    verified = _with_fixed_values(verified)
    same_text = _with_fixed_values(same_text)
    rule_dropped = _with_fixed_values(rule_dropped)
    wording = _with_fixed_values(wording)
    renumbered = _with_fixed_values(renumbered)

    # ---- 每条差值「到底算不算变化」的人工/规则判定 ----
    # 这是第 11.3.3 那张 45 行矩阵的「变化」列。以前那一列是把两个取值当字符串
    # 一比（`b === a`），于是「（4.0±1.0）HzHz」vs「(4.0±1.0)Hz」、
    # 「不大于500mm」vs「500m」都被判成**有变化** —— 45 行里 42 行是假的，
    # 而矩阵小结还写着「45 项有实质变化」。
    diff_verdicts = build_diff_verdicts(vds_fixed, fixed_by_key, {
        "numeric": verified, "sameText": same_text, "wording": wording,
        "renumbered": renumbered, "ruleDropped": rule_dropped,
    })
    vc = Counter(v["verdict"] for v in diff_verdicts.values())
    print("  差值判定分布：%s" % dict(vc))

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
            # 取**更正后**的行：11.8 印的是报告口径的取值。
            # 以前直接用抽取的原始行，于是「外界环境光1000lx~7000lx时近光灯响应」
            # 那行印着**别行的值**（大于5s，不大于300s）—— 报告里出现一个
            # 与该行无关的取值，比不印更糟。
            {"topic": w.get("topic", ""),
             "name": _fixed_row(w).get("name", w.get("name", "")),
             "oldValue": display_clean(_fixed_row(w).get("oldValue", "")),
             "newValue": display_clean(_fixed_row(w).get("newValue", ""))}
            for w in wording
        ],
        "topicColumns": cols,
        "stats": {"numeric": dict(st), "excerpts": cstats},
        # candidate-flow accounting: every valueDiff must land in exactly one
        # bucket, so the exec summary's "账目闭环" claim is checkable rather
        # than asserted. noise_filter_diffs returns three mutually exclusive
        # exhaustive lists over vds; classify_value_kind splits `verified` into
        # numeric/text; rule_dropped now carries the named structural rejects
        # instead of being an anonymous remainder.
        "flow": {
            "candidates": len(vds),
            "buckets": {
                "numeric": len(numeric_only),
                "text": len(text_only),
                "renumbered": len(renumbered),
                "wordingFiltered": len(wording),
                "sameTextDropped": len(same_text),
                "ruleDropped": len(rule_dropped),
            },
            # kept for back-compat with reportV6's counts.ruleDropped
            "ruleDropped": len(rule_dropped),
            "ruleDroppedByRule": dict(rule_counts),
            "ruleDroppedDetail": rule_dropped,
        },
        # Manual-audit findings — verified directly against A/B original PDF
        # text by human audit (v6.8), because the 18-topic diff pipeline
        # never inspects AFS/自适应前照灯 (not one of the 18 fixed topics).
        # Manual-audit findings — verified directly against A/B original PDF text
        # by human audit (v6.8), because the 18-topic diff pipeline never
        # inspects AFS/自适应前照灯 (not one of the 18 fixed topics).
        #
        # These used to be Python literals here, which meant the page numbers
        # were pinned to one revision of one PDF and nothing re-checked them at
        # generate time. They now live in data/manual-findings.json alongside
        # each source PDF's SHA-256; if a source changes, every entry is
        # demoted to 待重核 rather than presented as still-verified.
        "manualFindings": _load_manual_findings(),
        # 第 11.3.3 那张 45 行矩阵的**数据源**与**判定**。
        # 过去那张表直接读原始 diff-result.json，变化列是「两个取值当字符串一比」，
        # 于是抄错单位、重复单位、错配的取值全被算成「有变化」。
        # 现在：取值 = 清洗+更正后的版本；判定 = 人工裁定优先、其次证据分桶。
        "diffValueDiffs": vds_fixed,
        "diffVerdicts": diff_verdicts,
    }
    # Partition gate. Every candidate must be accounted for exactly once, or the
    # report's "合计 N，账目闭环" sentence would be printing a number nobody can
    # reconcile. Fail loudly rather than render a plausible-looking wrong total.
    _b = out["flow"]["buckets"]
    _total = sum(_b.values())
    if _total != len(vds):
        raise AssertionError(
            f"候选分流不闭合：分桶合计 {_total} != 候选数 {len(vds)}；分桶={_b}"
        )
    out["flow"]["partitionClosed"] = True
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
        # 第 11.3.3 矩阵的数据源与判定（见 run_verify 里的说明）
        "diffValueDiffs": out.get("diffValueDiffs", []),
        "diffVerdicts": out.get("diffVerdicts", {}),
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