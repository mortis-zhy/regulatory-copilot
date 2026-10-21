# -*- coding: utf-8 -*-
"""不变式：**第 11 章差值表里的每一个取值，都必须站得住**。

为什么要有这条 —— 第 11 章是报告的**决策核心**（哪些参数变了、怎么变）。
它的取值来自 LLM 抽取的 `diff-result.json`，**没有回原文验过**。
逐条回原文核下来，问题不是个案，而是三类系统性事故：

    1. **单位抄错**   近光灯 · 弯道照明曲率半径：A 值被抄成「不大于 500mm」，
                     原文（A §5.2.7.4 / B §5.2.7.4 / C §6.2.7.4）都是
                     「**不大于 500m**」—— 差 1000 倍，而且这一行被标成「有变化」。
                     客户照着改设计，会把弯道照明的曲率半径要求改小 1000 倍。
    2. **行错配**     自动切换前照灯近光条件（A 附录C 表C.1 / B 附录H 表H.1
                     两表逐格相同）：抽取把「响应时间」列的值配到了「近光灯」列，
                     于是「近光灯状态：开启 → 不大于2s」这种**不成对的假变化**进了报告。
    3. **单位重复**   「（4.0±1.0）Hz**Hz**」「不得超过3**ss**」「1500mm（…）**mm**」
                     —— 机械噪声，由 `scripts/diff_corrections.py` 自动清理。

第 12 章的取值有 `clause_value_check.py` 守着（取值必须在所引条款里），
第 11 章这 45 条差值一直没有。这一条补上。

本脚本查四件事：
  A. 机械噪声没有残留（重复单位 / 重复百分号 / LaTeX 残渣）
  B. 每条**人工更正**都能在它标注的条款里找到
     —— 防止有人把更正表改成「随便改」
  C. 判成「有变化」的行，两侧的**数字 + 限值口径**必须不同（否则是假变化）
  D. 每行都有判定，不许有「待核实」（宁可空着不可错着：判不出来就不许下结论）

「取证」怎么算站得住
------------------
一条更正要成立，它引用的那一句必须**真的在原文里**。取证分三级：

| 级 | 证据 | 什么时候用 |
|---|---|---|
| 1 | **数字**：值里的数字（≥6，小数字到处都是不算数）必须出现在所引条款里 | 值里有可用数字时 |
| 2 | **逐字**：值必须**逐字**出现在所引条款（或其父章节）里 | 值里**没有**可用数字时（定性要求） |
| 3 | **锚点**：参数名（或主题词）必须出现在所引条款 / 所属章节里 | 总是 —— 证明这条更正说的就是这个参数 |

第 2 级是这一轮补上的：**定性**要求（配备、数量、光色……）根本没有数字，
以前的规则对它**一条都查不了** —— 等于「随便改都能过」。
现在这类更正必须给出**原文里逐字存在的句子**，改一个词都过不了。

引用**表格**的更正（表5 光色对应表、附录C/H 条件表）用 `aTable`/`bTable`
标注 MinerU 的**页码**，取证范围就是那一页的表格内容。

用法： python scripts/diff_value_check.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORPUS_PATH = os.path.join(ROOT, "dist", "mineru-v4-data.json")


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
dc = _load("dc", os.path.join(ROOT, "scripts", "diff_corrections.py"))

# 限值口径词：数字相同但口径相反（「不大于 65」vs「不小于 65」）是**真变化**，
# 所以比数字的时候必须连口径一起比。
POLARITY = ("不大于", "不小于", "不超过", "不低于", "不得大于", "不得小于",
            "不多于", "至少", "最多", "大于", "小于", "以上", "以下",
            "上限", "下限", "范围", "±", "+-")
DELETED_MARK = "已删除"
# 小数字到处都是（条款号、序号、比例），不能当证据
SMALL_NUMS = ("0", "1", "2", "3", "4", "5")
# 单位家族 —— 同一家族里换单位就是**换量级**（500m ↔ 500mm 差 1000 倍）。
# 比数字时必须连单位一起比，这就是「弯道照明曲率半径」那次事故的根因。
UNIT_FAMILY = {
    "mm": "len", "cm": "len", "m": "len",
    "cd": "luminous", "lx": "illum", "lm": "luminous_flux",
    "Hz": "freq", "次/min": "freq", "km/h": "speed",
    "V": "volt", "A": "amp", "%": "percent",
    "°": "degree", "度": "degree",
    "kg": "mass", "J": "joule", "N": "newton", "W": "watt",
    "s": "time", "秒": "time",
    "只": "count_lamp", "套": "count_set", "个": "count",
}
UNITS_SORTED = sorted(UNIT_FAMILY.keys(), key=len, reverse=True)
TOKEN_RE = re.compile(
    r"(\d+(?:\.\d+)?)\s*(%s)(?![A-Za-z0-9])"
    % "|".join(re.escape(u) for u in UNITS_SORTED)
)
# 全角/半角标点是**排版差异**，不是内容差异 —— 比对前统一
_PUNCT = {"，": ",", "；": ";", "：": ":", "、": ",", "（": "(", "）": ")",
          "。": ".", "．": ".", "～": "~", "–": "-", "—": "-"}


def unit_conflicts(value: str, scope: str) -> list:
    """单位对不上：值写「500mm」，原文同一个数写的是「500m」—— 差 1000 倍。

    只在**原文对同一个数用了同家族的另一个单位**时报错；
    原文里根本没有这个数（带单位的形态）时，交给数字规则去查。
    """
    problems = []
    stokens = TOKEN_RE.findall(scope or "")
    for num, unit in TOKEN_RE.findall(value or ""):
        fam = UNIT_FAMILY.get(unit)
        if not fam:
            continue
        same = [(n, u) for (n, u) in stokens
                if n == num and UNIT_FAMILY.get(u) == fam]
        if any(u == unit for _n, u in same):
            continue          # 原文就是这个单位 —— 有支撑
        if same:
            problems.append("单位对不上：值写「%s%s」，原文同一个数写的是「%s%s」"
                            % (num, unit, same[0][0], same[0][1]))
    return problems


def norm_text(s: str) -> str:
    """归一化：去空白 + 统一标点。"""
    s = re.sub(r"\s+", "", s or "")
    for a, b in _PUNCT.items():
        s = s.replace(a, b)
    return s


def signature(s: str) -> tuple:
    """取值里的「数字 + 口径」签名。"""
    t = re.sub(r"\s+", "", s or "")
    t = re.sub(r"[，。、；：()（）【】\[\]<>|]", "", t)
    numbers = tuple(re.findall(r"-?\d+(?:\.\d+)?", t))
    polarity = tuple(w for w in POLARITY if w in t)
    return numbers, polarity


def cjk_fragments(name: str, min_len: int = 3):
    """从参数名里切出中文片段，用来确认「这条更正说的确实是这个条款」。"""
    out = []
    for frag in re.split(r"[^一-鿿]+", name or ""):
        if len(frag) >= min_len:
            out.append(frag)
    # 再切出更长的子串（"弯道照明曲率半径" → "曲率半径" 之类）
    for frag in list(out):
        for i in range(len(frag)):
            for j in range(len(frag), i + min_len - 1, -1):
                sub = frag[i:j]
                if len(sub) >= min_len and sub not in out:
                    out.append(sub)
    return sorted(out, key=len, reverse=True)


def clause_scope(clauses: dict, clause: str) -> str:
    """条款 + 它后代的正文。条款号写不成点分数字（"附录C 表C.1"、"4.25b"）时返回空。"""
    if not clause or not re.fullmatch(r"\d+(?:\.\d+)*", clause or ""):
        return ""
    out = []
    for k, body in clauses.items():
        if k == clause or k.startswith(clause + "."):
            out.append(body)
    return "\n".join(out)


def parent_clause(clause: str) -> str:
    parts = (clause or "").split(".")
    return ".".join(parts[:-1]) if len(parts) > 1 else ""


def load_corpus(docs: dict) -> dict:
    """{版本: {"clauses": {条款号: 正文}, "tables": {页码: 表格文本}, "doc": 全文}}"""
    raw = {}
    if os.path.exists(CORPUS_PATH):
        try:
            raw = json.load(io.open(CORPUS_PATH, encoding="utf-8"))
        except Exception:
            raw = {}
    out = {}
    for v, path in (docs or {}).items():
        idx = cs.split_clauses(path)
        clauses = {k: (o.get("body") or "") for k, o in idx.items()}
        doc = raw.get(v) or {}
        tables = {}
        for t in doc.get("tables") or []:
            try:
                pg = int(t.get("page") or 0)
            except Exception:
                pg = 0
            tables.setdefault(pg, []).append(t.get("content") or "")
        hay = "\n".join(clauses.values())
        hay += "\n" + "\n".join(t.get("content") or "" for t in doc.get("tables") or [])
        hay += "\n" + (doc.get("fullText") or "")
        out[v] = {
            "clauses": clauses,
            "tables": tables,
            "doc": hay,
            "doc_norm": norm_text(hay),
        }
    return out


def evidence_windows(corp: dict, clause: str, table_page) -> dict:
    """取证范围。

    - 引用表格（table_page）→ 那一页的表格内容
    - 引用条款（点分数字）→ 该条款 + 其父章节
    - 条款号写不成点分数字（「附录C 表C.1」「4.25b」）→ 全文（**兜底，最弱**）
    """
    doc = corp.get("doc") or ""
    doc_norm = corp.get("doc_norm") or ""
    if table_page:
        try:
            pg = int(table_page)
        except Exception:
            pg = 0
        t = "\n".join(corp.get("tables", {}).get(pg, []))
        if not t.strip():
            return {"strict": "", "wide": "", "strict_norm": "", "wide_norm": "",
                    "doc": doc, "doc_norm": doc_norm}
        return {"strict": t, "wide": t,
                "strict_norm": norm_text(t), "wide_norm": norm_text(t),
                "doc": doc, "doc_norm": doc_norm}
    if clause and re.fullmatch(r"\d+(?:\.\d+)*", clause):
        strict = clause_scope(corp.get("clauses") or {}, clause)
        parent = clause_scope(corp.get("clauses") or {}, parent_clause(clause))
        wide = strict + "\n" + parent
        return {"strict": strict, "wide": wide,
                "strict_norm": norm_text(strict), "wide_norm": norm_text(wide),
                "doc": doc, "doc_norm": doc_norm}
    return {"strict": doc, "wide": doc,
            "strict_norm": doc_norm, "wide_norm": doc_norm,
            "doc": doc, "doc_norm": doc_norm}


def evaluate_side(c: dict, side: str, ver: str, key: str, tkey: str,
                  corpus: dict) -> list:
    """核一条更正的一侧取值。返回问题列表（空 = 站得住）。

    取证三级（见模块 docstring）：数字 → 逐字 → 锚点。
    """
    topic = c.get("topic") or ""
    name = c.get("name") or ""
    val = str(c.get(side))
    clause = str(c.get(key) or "")
    page = c.get(tkey)
    corp = corpus.get(ver) or {}
    win = evidence_windows(corp, clause, page)
    problems = []
    if not win["strict"].strip():
        return ["更正无法复核：%s|%s 的 %s 条款 %s%s 在原文里找不到"
                % (topic, name, ver, clause or "(未标注)",
                   (" 第%s页表格" % page) if page else "")]
    nums = [n for n in re.findall(r"-?\d+(?:\.\d+)?", val) if n not in SMALL_NUMS]
    # 1b 级证据：单位不能对不上（500m ↔ 500mm 是量级事故）—— 与有没有可用数字无关
    if DELETED_MARK not in val:
        for p in unit_conflicts(val, win["strict"]):
            problems.append("更正对不上原文：%s|%s 的 %s 值「%s」—— %s"
                            % (topic, name, side, val, p))
    if nums:
        # 1 级证据：数字必须出现在所引条款里
        for num in nums:
            pat = r"\s*".join(re.escape(ch) for ch in num)
            if re.search(pat, win["strict"]) is None:
                problems.append("更正对不上原文：%s|%s 的 %s 值「%s」里的 %s 在 %s §%s 里找不到"
                                % (topic, name, side, val, num, ver, clause or "?"))
                break
    elif DELETED_MARK not in val:
        # 2 级证据：**定性**要求没有数字 → 值必须逐字出现在原文里
        nv = norm_text(val)
        if len(nv) >= 2 and nv not in win["wide_norm"]:
            problems.append("更正对不上原文：%s|%s 的 %s 值「%s」在 %s §%s 里"
                            "逐字找不到（定性取值必须逐字引自原文）"
                            % (topic, name, side, val, ver, clause or "?"))
    # 3 级证据：锚点 —— 参数名必须在所引条款里；名字太短时退回主题词
    frags = cjk_fragments(name)
    if frags:
        if not any(f in win["strict_norm"] for f in frags):
            problems.append("更正指错了条款：%s|%s 的 %s 值「%s」与 %s §%s 的内容对不上"
                            % (topic, name, side, val, ver, clause or "?"))
    else:
        tf = [f for f in cjk_fragments(topic) if f in win["doc_norm"]]
        if tf and not any(f in win["wide_norm"] for f in tf):
            problems.append("更正指错了条款：%s|%s 的 %s 值「%s」在 %s §%s "
                            "所属章节里找不到主题词「%s」"
                            % (topic, name, side, val, ver, clause or "?", topic))
    return problems


def main():
    docs = cs.pick_docs()
    corpus = load_corpus(docs)
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    diff = json.load(io.open(os.path.join(ROOT, "diff-result.json"), encoding="utf-8"))
    rows = diff.get("valueDiffs") or []
    fixed, applied, unmatched, residual = dc.apply_corrections(rows)

    problems = []
    notes = []

    # --- A. 机械噪声残留 ---
    for r in residual:
        problems.append("机械噪声未清理：%s / %s —— %s「%s」"
                        % (r[0], r[1], r[2], r[3]))
    if unmatched:
        for c in unmatched:
            problems.append("更正表里的条目在 valueDiffs 里找不到对应行：%s|%s"
                            % (c.get("topic"), c.get("name")))

    # --- B. 每条人工更正都要在它标注的条款里站得住 ---
    for c in applied:
        topic = c.get("topic") or ""
        name = c.get("name") or ""
        for side, ver, key, tkey in (("newValue", "A", "aClause", "aTable"),
                                     ("oldValue", "B", "bClause", "bTable")):
            if c.get(side) is None:
                continue
            problems.extend(evaluate_side(c, side, ver, key, tkey, corpus))
        notes.append("  · %-26s %-10s %s" % (name[:24], c.get("verdict", ""),
                                              (c.get("reason") or "")[:52]))

    # --- C/D. 判定与签名的一致性 ---
    verdicts_path = os.path.join(ROOT, "dist", "facts.json")
    if not os.path.exists(verdicts_path):
        problems.append("找不到 dist/facts.json —— 先跑 `python verify_claims.py`")
    else:
        facts = json.load(io.open(verdicts_path, encoding="utf-8"))
        vd = facts.get("diffVerdicts") or {}
        if len(vd) != len(rows):
            problems.append("判定条数与差值条数对不上：%d vs %d" % (len(vd), len(rows)))
        manual = {"%s|%s" % (c.get("topic"), c.get("name")) for c in applied}
        for r in fixed:
            key = "%s|%s" % (r.get("topic", ""), r.get("name", ""))
            v = vd.get(key)
            if not v:
                problems.append("这一行没有判定：%s" % key)
                continue
            verdict = v.get("verdict", "")
            so = signature(r.get("oldValue", ""))
            sn = signature(r.get("newValue", ""))
            same = so == sn and so[0]
            if verdict.startswith("有变化"):
                if same and key not in manual:
                    problems.append("假变化：%s 判成「%s」，但两版的数字与口径完全一样（%s）"
                                    % (key, verdict, so[0]))
            if verdict == "待核实":
                problems.append("判不出来：%s 仍是「待核实」—— 宁可空着，不可错着" % key)

    out = ["差值表复核：%d 条差值，%d 条人工更正" % (len(rows), len(applied))]
    out.extend(notes)
    if problems:
        out.append("查出 %d 处问题：" % len(problems))
        out.extend("  ✗ " + p for p in problems)
    else:
        out.append("全部通过：取值都能在原文里找到，判定与数字/口径一致 ✓")
    io.open(os.path.join(ROOT, "reports", "_diff_value_check.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
