# -*- coding: utf-8 -*-
"""差值表（`diff-result.json` → 第 11 章）的**取值清洗 + 人工更正**。

为什么需要这一层
----------------
第 11 章的 45 条差值来自 18 主题 diff 管线的 **LLM 抽取**，是全报告唯一
没有回原文核验过的取值来源。回原文逐条核下来，三类问题反复出现：

1. **单位被重复写了一遍**（抽取时把「值 + 单位」拼了两遍）
   ——「（4.0±1.0）Hz**Hz**」「不得超过3**ss**」「1500mm（可放宽至2300mm）**mm**」
   「（90±30）次/min**次/min**」「（100±20）km/h**km/h**」「2只（成对）**只**」
   「各30°**度**」……这类**不改数字**，纯机械噪声，可自动清理。
2. **LaTeX 残渣**（`4.0_{-1.0}` 被抽成「4.0 0 -1.0」）—— 需人工还原。
3. **错配 / 抄错单位**（真错）：
   - 近光灯 · 弯道照明曲率半径：A 值被抄成「不大于500**mm**」，
     原文（A §5.2.7.4 / B §5.2.7.4 / C §6.2.7.4）都是「**不大于 500m**」；
     抽取时误取了同章 5.2.4.2（离地高度下限「不小于500mm」）的单位。
     差 1000 倍，且被标成「有变化」——客户照着改设计会把曲率半径要求改小 1000 倍。
   - 自动切换前照灯近光条件（A 附录C 表C.1 / B 附录H 表H.1）：**两表逐格相同**，
     但抽取把「响应时间」列的值错配到了「近光灯」列，
     于是「近光灯状态：开启 → 不大于2s」这种**不成对的假变化**进了报告。
   - 终端稳定电压（A §4.25b / B §4.27b）：抽取把 12V 档的值配给了 6V 档、
     把 24V 档的值配给了 12V 档。真实情况是 **A 删除了 6V 档**，
     12V 档（13.5V）与 24V 档（28.0V）两版相同。

因此分两层：

- `normalize_value()` —— **机械**噪声（重复单位、重复百分号）。只删重复的尾巴，
  **一个数字都不动**。
- `data/diff-corrections.json` —— **人工**更正（还原 LaTeX、改错配、改抄错的单位、
  改错条款号）。每条都带**原文条款号**与**为什么**，并由
  `scripts/diff_value_check.py` 回原文复核后才算数。

判定口径
--------
`verdict` 字段是这一行**到底算不算变化**的人工裁定：

| verdict | 含义 | 在报告里显示为 |
|---|---|---|
| `change` | 回原文核验，确实是变化 | **有变化** |
| `no-change` | 回原文核验，两版实质相同（仅措辞/格式/错配） | 两版同文（非变化） |
| `duplicate` | 与其他行是同一参数 | 重复行（已合并） |
| `unverified` | 未能回原文核实 | 待核实（**不写「有变化」**） |

留空 = 交给证据规则（`verify_claims.py` 的分桶）去判。

用法： python scripts/diff_corrections.py          # 自检 + 打印
      python scripts/diff_corrections.py --write  # 写出 dist/diff-normalized.json
"""
import io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORRECTIONS_PATH = os.path.join(ROOT, "data", "diff-corrections.json")
DIFF_PATH = os.path.join(ROOT, "diff-result.json")
OUT_PATH = os.path.join(ROOT, "dist", "diff-normalized.json")

# 单位词元（**长的排前面**，避免 "km/h" 里的 "m" 被当成单位）。
# 家族用于判定「同一个单位的两种写法」——° 与 度 是同一个单位，
# 但 m 与 mm 是**不同**单位（500m 与 500mm 差 1000 倍，绝不能当成同一个）。
UNIT_FAMILY = {
    "次/min": "freq", "km/h": "speed", "mm": "len_mm", "cm": "len_cm", "m": "len_m",
    "cd": "luminous", "lx": "illum", "lm": "luminous_flux", "Hz": "freq_hz",
    "kg": "mass", "V": "volt", "A": "amp", "度": "degree", "°": "degree",
    "秒": "time_cn", "s": "time_en", "次": "count", "只": "count_lamp",
    "套": "count_set", "个": "count_gen", "%": "percent", "N": "newton", "J": "joule",
}
UNITS = sorted(UNIT_FAMILY.keys(), key=len, reverse=True)

# 汉字数字：跟数字一样，「两只」「每侧一只」里的「只」是数字自己的单位
_CN_DIGITS = "〇零一二三四五六七八九十两"


# --------------------------------------------------------------------------
# 一、机械清洗
# --------------------------------------------------------------------------
def _unit_spans(s: str):
    """返回 (起点, 终点, 单位, 家族) 列表，按出现顺序，长单位优先且不重叠。"""
    spans = []
    i = 0
    n = len(s)
    while i < n:
        hit = None
        for u in UNITS:
            if s.startswith(u, i):
                hit = u
                break
        if hit:
            spans.append((i, i + len(hit), hit, UNIT_FAMILY[hit]))
            i += len(hit)
        else:
            i += 1
    return spans


def normalize_value(s: str) -> str:
    """去掉抽取时重复写上的单位尾巴，以及重复的百分号。

    只在**下面两条都成立**时才删结尾那个单位：
      1. 同一个单位（或同家族的写法，如 °/度）在前面已经出现过；
      2. 结尾这个单位**不紧跟数字** —— 即它是个悬空的尾巴，而不是某个数字的单位。

    第 2 条是关键：不加它就会把「1s~1.5s」这种**区间**写法的第二个单位删掉
    （变成「1s~1.5」，数值被改小了 —— 这比留着噪声更糟）。
    加了它之后：
      「（4.0±1.0）HzHz」→「（4.0±1.0）Hz」   尾巴前面是字母 → 悬空
      「2只（成对）只」→「2只（成对）」          尾巴前面是「）」→ 悬空
      「1500mm（可放宽至2300mm）mm」→「1500mm（可放宽至2300mm）」
      「1s~1.5s」→ 不动                        尾巴前面是「5」→ 数字自己的单位
      「1200mm」→ 不动                          同上
    另外「%%」→「%」。
    """
    if not s:
        return s
    out = s.replace("%%", "%")
    spans = _unit_spans(out)
    if not spans:
        return out
    start, end, unit, fam = spans[-1]
    if start == 0:
        return out
    earlier_same_family = any(f == fam for (_a, _b, _u, f) in spans[:-1])
    if not earlier_same_family:
        return out
    prev_char = out[start - 1]
    if prev_char.isdigit() or prev_char in _CN_DIGITS:
        return out  # 尾巴紧跟数字（阿拉伯或汉字）—— 那是数字自己的单位，不能动
    return out[:start].rstrip() + out[end:]


def residual_artifact(s: str) -> str:
    """检查清洗后**仍残留**的机械噪声；返回问题描述（空 = 干净）。"""
    problems = []
    if "%%" in s:
        problems.append("重复百分号")
    spans = _unit_spans(s)
    for i in range(1, len(spans)):
        if spans[i][3] == spans[i - 1][3] and spans[i][0] == spans[i - 1][1]:
            problems.append("相邻重复单位 %s" % spans[i][2])
    if re.search(r"\d\s+\d+\s*[-±]\s*\d", s):
        problems.append("LaTeX 下标残渣")
    if re.search(r"\{|\}|\\[a-zA-Z]+", s):
        problems.append("LaTeX 标记残渣")
    return "；".join(problems)


# --------------------------------------------------------------------------
# 二、人工更正表
# --------------------------------------------------------------------------
def load_corrections() -> list:
    if not os.path.exists(CORRECTIONS_PATH):
        raise FileNotFoundError(
            "差值更正表缺失：%s —— 它记录了回原文核实过的取值更正，"
            "缺失会让第 11 章重新显示抄错的单位与错配的取值。" % CORRECTIONS_PATH
        )
    doc = json.load(io.open(CORRECTIONS_PATH, encoding="utf-8"))
    items = doc.get("corrections") or []
    if not items:
        raise ValueError("%s 的 corrections 为空 —— 更正数据疑似损坏" % CORRECTIONS_PATH)
    return items


def _key(topic: str, name: str) -> str:
    return "%s|%s" % (str(topic or "").strip(), str(name or "").strip())


def apply_corrections(rows: list) -> tuple:
    """给原始 valueDiffs 打上清洗后的取值与人工判定。

    返回 (rows_out, applied, unmatched, residual)：
    - rows_out：清洗 + 更正后的行（每行多出 verdict / verdictReason / aClause / bClause）
    - applied：实际命中的更正条目
    - unmatched：更正表里没能在 valueDiffs 里找到对应行的条目（**必须为空**）
    - residual：机械清洗后**仍残留**噪声、且没有被更正表覆盖的行（**必须为空**）
    """
    items = load_corrections()
    by_key = {_key(i.get("topic"), i.get("name")): i for i in items}
    out = []
    applied = []
    seen = set()
    residual = []
    for r in rows or []:
        row = dict(r)
        k = _key(row.get("topic"), row.get("name"))
        seen.add(k)
        for side in ("oldValue", "newValue"):
            if side in row and isinstance(row[side], str):
                row[side] = normalize_value(row[side])
        c = by_key.get(k)
        if c:
            applied.append(c)
            if c.get("name_new"):
                row["name"] = c["name_new"]
            for side in ("oldValue", "newValue"):
                if c.get(side) is not None:
                    row[side] = c[side]
            if c.get("verdict"):
                row["verdict"] = c["verdict"]
            if c.get("reason"):
                row["verdictReason"] = c["reason"]
            if c.get("aClause"):
                row["aClause"] = c["aClause"]
            if c.get("bClause"):
                row["bClause"] = c["bClause"]
            if c.get("source"):
                row["source"] = c["source"]
        else:
            # 没有人工兜底的行：机械清洗后仍带噪声 = 没人管过，必须报出来
            for side in ("oldValue", "newValue"):
                p = residual_artifact(str(row.get(side) or ""))
                if p:
                    residual.append((row.get("name"), side, p, row.get(side)))
        out.append(row)
    unmatched = [i for i in items if _key(i.get("topic"), i.get("name")) not in seen]
    return out, applied, unmatched, residual


def main():
    diff = json.load(io.open(DIFF_PATH, encoding="utf-8"))
    rows = diff.get("valueDiffs") or []
    out, applied, unmatched, residual = apply_corrections(rows)
    lines = ["原始 %d 条，更正后 %d 条" % (len(rows), len(out))]
    lines.append("命中人工更正 %d 条" % len(applied))
    for c in applied:
        lines.append("   · %-28s %-10s %s" % (
            (c.get("name") or "")[:26], c.get("verdict", ""), (c.get("reason") or "")[:60]))
    if unmatched:
        lines.append("!! 更正表里有 %d 条没能在 valueDiffs 里找到对应行（键写错了？）" % len(unmatched))
        for c in unmatched:
            lines.append("   · %s|%s" % (c.get("topic"), c.get("name")))
    lines.append("残留机械噪声（无人工兜底）%d 处" % len(residual))
    for d in residual:
        lines.append("   · %-24s %-9s %-16s 「%s」" % (str(d[0])[:22], d[1], d[2], d[3]))
    if "--write" in sys.argv:
        os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
        payload = {
            "_note": "由 scripts/diff_corrections.py 生成：45 条差值的清洗与人工更正结果。"
                     "报告渲染与 scripts/diff_value_check.py 都以这份为准。",
            "valueDiffs": out,
            "correctionsApplied": applied,
        }
        io.open(OUT_PATH, "w", encoding="utf-8", newline="").write(
            json.dumps(payload, ensure_ascii=False, indent=1) + "\n")
        lines.append("已写出 %s" % OUT_PATH)
    print("\n".join(lines))
    return 1 if (unmatched or residual) else 0


if __name__ == "__main__":
    sys.exit(main())
