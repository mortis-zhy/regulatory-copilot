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
                     于是报告里出现「近光灯状态：开启 → 不大于2s」这种**不成对的假变化**。
    3. **单位重复**   「（4.0±1.0）Hz**Hz**」「不得超过3**ss**」「1500mm（…）**mm**」
                     —— 机械噪声，由 `scripts/diff_corrections.py` 自动清理。

第 12 章的取值有 `clause_value_check.py` 守着（取值必须在所引条款里），
第 11 章这 45 条差值一直没有。这一条补上。

本脚本查四件事：
  A. 机械噪声没有残留（重复单位 / 重复百分号 / LaTeX 残渣）
  B. 每条**人工更正**都能在它标注的条款里找到（数字对得上、名称片段对得上）
     —— 防止有人把更正表改成「随便改」
  C. 判成「有变化」的行，两侧的**数字 + 限值口径**必须不同（否则是假变化）
  D. 每行都有判定，不许有「待核实」（宁可空着不可错着：判不出来就不许下结论）

用法： python scripts/diff_value_check.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


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


def clause_scope(idx: dict, clause: str) -> str:
    """条款 + 它后代的正文。条款号写不成点分数字（"附录C 表C.1"、"4.25b"）时返回空。"""
    if not clause or not re.fullmatch(r"\d+(?:\.\d+)*", clause or ""):
        return ""
    out = []
    for k, o in idx.items():
        if k == clause or k.startswith(clause + "."):
            out.append(o.get("body", ""))
    return "\n".join(out)


def main():
    docs = cs.pick_docs()
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
        for side, ver, key in (("newValue", "A", "aClause"), ("oldValue", "B", "bClause")):
            if c.get(side) is None:
                continue
            val = str(c[side])
            clause = str(c.get(key) or "")
            scope = clause_scope(idx.get(ver, {}), clause)
            whole = idx.get(ver, {})
            hay = scope if scope else "\n".join(o.get("body", "") for o in whole.values())
            if not hay.strip():
                problems.append("更正无法复核：%s|%s 的 %s 条款 %s 在原文里找不到"
                                % (topic, name, ver, clause or "(未标注)"))
                continue
            hn = re.sub(r"\s+", "", hay)
            # 数字必须对得上。原文的排版常把小数拆开（「4. 0 0 -1. 0 Hz」），
            # 所以按「每个字符之间允许有空白」来匹配。
            for num in re.findall(r"-?\d+(?:\.\d+)?", val):
                if num in ("0", "1", "2", "3", "4", "5"):
                    continue  # 小数字到处都是，不作为证据
                pat = r"\s*".join(re.escape(ch) for ch in num)
                if re.search(pat, hay) is None:
                    problems.append("更正对不上原文：%s|%s 的 %s 值「%s」里的 %s 在 %s §%s 里找不到"
                                    % (topic, name, side, val, num, ver, clause or "?"))
                    break
            else:
                # 名称片段必须对得上（证明这条更正说的就是这个条款）
                if DELETED_MARK not in val:
                    frags = cjk_fragments(name)
                    if frags and not any(f in hn for f in frags):
                        problems.append("更正指错了条款：%s|%s 的 %s 值「%s」与 %s §%s 的内容对不上"
                                        % (topic, name, side, val, ver, clause or "?"))
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
        manual = {f"{c.get('topic')}|{c.get('name')}" for c in applied}
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
