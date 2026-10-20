# -*- coding: utf-8 -*-
"""条款归属审计：把每条 spec 正则**开头锚定的条款号**（期望值）与
`nearestClause()` 推断出的条款号（实际值）对比。

不一致 = 这条正则匹配到了**别的条款**（或别的灯具）—— 是「按值锚定」那类
假正确：数值对了，引用错了。

用法： python _clauseaudit.py
"""
import io, json, re, sys

SPEC = "data/parameter-specs.json"
CORP = "dist/mineru-v4-data.json"

CLAUSE_RE = re.compile(r"(?:^|[\s，,、（(])((?:\d+\.){1,4}\d+)(?=[\s．.、)）:：]|[a-z]\s*[)）])")


def nearest_clause(text, idx):
    last = ""
    for m in CLAUSE_RE.finditer(text):
        if m.start() >= idx:
            break
        if not m.group(1).startswith("0."):
            last = m.group(1)
    return last


def expected_clause(src):
    """正则开头锚定的条款号（`6\\.19\\.7\\.6` → 6.19.7.6）。"""
    m = re.match(r"^(\d+(?:\\\.\d+)+)", src)
    if not m:
        return None
    return m.group(1).replace("\\", "")


def pages(d, v):
    parts = re.split(r"\[第(\d+)页\]", d[v]["fullText"])
    return [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts), 2)]


d = json.load(io.open(CORP, encoding="utf-8"))
specs = json.load(io.open(SPEC, encoding="utf-8"))["specs"]

bad, noanchor, nomatch, declared = [], [], [], []
for s in specs:
    for v in ("A", "B", "C"):
        p = s.get("patterns", {}).get(v)
        if not p:
            continue
        src = p["source"]
        exp = expected_clause(src)
        # 显式声明的条款号（patterns[v].clause）也是一种「锚」——
        # 它不是自动推断出来的，抽取器会直接用它，所以不算「靠措辞匹配」。
        explicit = p.get("clause") if isinstance(p, dict) else None
        rx = re.compile(src, re.I)
        hit = None
        for pg, t in pages(d, v):
            m = rx.search(t)
            if m:
                hit = (pg, t, m)
                break
        if not hit:
            nomatch.append((s["id"], v, exp))
            continue
        pg, t, m = hit
        got = nearest_clause(t, m.start())
        if explicit:
            declared.append((s["id"], v, explicit, got, pg))
            continue
        if exp and got and exp != got:
            bad.append((s["id"], v, exp, got, pg))
        elif not exp:
            noanchor.append((s["id"], v, got, pg))

print("=" * 78)
print("① 条款不一致（期望 %s ≠ 实际）—— 匹配到了别的条款/别的灯具")
for sid, v, exp, got, pg in bad:
    print("  %-46s %s  期望 %-10s 实际 %-10s p%d" % (sid, v, exp, got, pg))
print("  共 %d 条" % len(bad))

print("=" * 78)
print("② 无条款锚（靠措辞匹配）—— 需人工确认没撞别的灯具")
for sid, v, got, pg in noanchor:
    print("  %-46s %s  推断 %-10s p%d" % (sid, v, got or "—", pg))
print("  共 %d 条" % len(noanchor))

print("=" * 78)
print("②b 显式声明的条款号（抽取器直接采用，不再推断）")
for sid, v, explicit, got, pg in declared:
    flag = "" if explicit == got else "   （就近条款号不同 —— 显式声明覆盖了推断值，理由在 why 里）"
    print("  %-46s %s  声明 %-10s 就近 %-10s p%d%s" % (sid, v, explicit, got or "—", pg, flag))
print("  共 %d 条" % len(declared))

print("=" * 78)
print("③ MinerU 未命中（需走源 PDF 兜底）")
for sid, v, exp in nomatch:
    print("  %-46s %s  期望 %s" % (sid, v, exp))
print("  共 %d 条" % len(nomatch))
