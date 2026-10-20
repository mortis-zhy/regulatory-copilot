# -*- coding: utf-8 -*-
"""不变式：**矩阵报出的取值，必须就在它引用的那条条款里**。

这是「值对、条款错」那一类错的克星：
- 引用 4.25（供电电压）却报 5° → 4.25 里没有 5° → 报错；
- 引用 6.14.4.1 却报 1500mm → 该条款里没有这个数 → 报错。

对照表：条款索引（scripts/clause_split.py，源 PDF 文本层）× 矩阵取值。

用法： python scripts/clause_value_check.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

# ── 单位与数值 ───────────────────────────────────────────────────────────
UNIT_ALIAS = {
    "mm": "mm", "㎜": "mm", "cm": "cm", "cd": "cd", "hz": "Hz",
    "km/h": "km/h", "°": "°", "%": "%", "v": "V", "w": "W",
    "lx": "lx", "cd/m²": "cd/m²", "cd/m2": "cd/m²", "nm": "Nm",
    "min": "min", "s": "s", "m": "m", "km": "km", "cm²": "cm²", "cm2": "cm²",
    "mm²": "mm²", "mm2": "mm²", "mrad": "mrad", "n": "N",
}
# 值 + 单位。千分位「1,500」与小数「0,1」在正则里分不开，
# 统一按「逗号后 3 位 = 千分位，否则是小数」在 parse_num 里还原。
VAL = re.compile(
    r"(?<![\d.])(\d+(?:[ ,]\d+)*(?:\.\d+)?)\s*"
    r"(mm|㎜|cm|cd|Hz|km\s*/\s*h|kmh|°|%|V|W|lx|Nm|cd\s*/\s*m\s*(?:2|²)|cm\s*2|mm\s*2|min|mrad)?",
    re.I,
)


def parse_num(raw):
    """「1,500」→ 1500.0；「0,1」→ 0.1；「1 500」→ 1500.0。"""
    s = raw.replace(" ", "")
    if "," in s:
        a, _, b = s.partition(",")
        s = ("%s.%s" % (a, b)) if len(b) != 3 else a + b
    return float(s)


def unit_of(u):
    if not u:
        return ""
    k = re.sub(r"\s+", "", u).lower()
    k = k.replace("kmh", "km/h").replace("cd/m2", "cd/m²").replace("cm2", "cm²").replace("mm2", "mm²")
    return UNIT_ALIAS.get(k, k)


def values_in(body):
    """条款正文里的 (数值, 单位) 列表。"""
    clean = re.sub(r"\s+", " ", body)
    out = []
    for m in VAL.finditer(clean):
        raw, unit = m.group(1), unit_of(m.group(2))
        try:
            v = parse_num(raw)
        except ValueError:
            continue
        # 「3.15」这种条款号形态、纯小数（无单位）先跳过
        if not unit and "." in raw:
            continue
        out.append((v, unit))
    return out


def to_mm(v, unit):
    """米 → 毫米（矩阵的 unit=mm 时用）。"""
    if unit == "m":
        return v * 1000.0
    return v


def main():
    docs = cs.pick_docs()
    idx = {v: cs.split_clauses(p) for v, p in docs.items()}
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    checked = skipped = 0
    bad = []
    for r in rows:
        row_unit = r.get("unit", "")
        for v in ("A", "B", "C"):
            c = r["cells"].get(v, {})
            if c.get("status") != "verified":
                continue
            cl = (c.get("clause") or "").strip()
            nums = c.get("nums") or []
            if not cl or not nums:
                skipped += 1
                continue
            body = idx.get(v, {}).get(cl, {}).get("body")
            if not body or not body.strip():
                skipped += 1          # 条款索引里没有 / 正文为空（索引不全，不是矛盾）
                continue
            have = values_in(body)
            # 父条款（5.7.5 几何可见度）的值常在子条款里（5.7.5.1）——
            # 把**后代条款**的值也算进来。
            for k, c2 in idx.get(v, {}).items():
                if k.startswith(cl + "."):
                    have += values_in(c2.get("body", ""))
            have_mm = [(to_mm(x, u), u) for x, u in have]
            for n in nums:
                try:
                    fv = float(n)
                except ValueError:
                    continue
                ok = any(abs(x - fv) < 1e-6 and (not u or not row_unit or u == row_unit)
                         for x, u in have_mm)
                if not ok:
                    # 再给一次机会：单位不同但数值相同（% / 无单位这类）
                    ok = any(abs(x - fv) < 1e-6 for x, u in have_mm if u in ("", row_unit))
                if not ok:
                    bad.append((r["id"], v, cl, n, row_unit, sorted(set(have_mm))[:8]))
                checked += 1
    print("检查了 %d 个取值格，%d 个格因无条款号/条款不在索引里而跳过" % (checked, skipped))
    if bad:
        print("不符 %d 处：" % len(bad))
        for b in bad:
            print("   %-42s %s 条款 %-12s 报 %s%s   该条款里的值: %s"
                  % (b[0], b[1], b[2], b[3], b[4], b[5]))
    else:
        print("全部通过 ✓")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
