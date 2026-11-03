# -*- coding: utf-8 -*-
"""不变式：**矩阵每一格的取值，都能在源 PDF 的那一页上找到证据**。

为什么单独一个脚本：第 12 章矩阵的页码来自 MinerU 的分页标记，
而**主题列**早就做过「源 PDF 页码复核」（verify_claims.py 的
「源 PDF 页码复核」那一遍，四个格因此被降级）。**矩阵这一路没做过。**

后果是页码整体错位：B 的 MinerU 全文 81 页、页标记 1–81 齐全，
但「向内几何可见度角可由 45°减至 20°」这段在 MinerU 标成第 31 页，
在源 PDF 里其实在**第 32 页**（5.5.5.2 的起始页）。读者翻到第 31 页，
找不到那句话 —— 页码本身就是一条错误信息。

## 三档证据（任一档落在所报的那一页上，即算定位成功）

| 档 | 证据 | 说明 |
|---|---|---|
| 引文 | 引文片段在所报页上 | 最强：读者翻过去能看到那句话 |
| 取值 | 取值字面量在所报页上 | 源 PDF 与转写的写法不同（千分位 / 单位 / LaTeX）时用 |
| 条款 | 条款号在所报页上 | 取值是英文词展开（two minutes → 2）时用 |

## 为什么取值这一档不能省

旧版只查引文，查不到就归为「skipped —— MinerU 与源 PDF 措辞不同，查不到不算错」。
**那个「不算错」是没有证据的免罪**：实测 796 个取值格里 120 格的引文根本查不到
（引文本身就是纯数值：'1300'、'2 0 ^'、'20 ㎜'，源 PDF 写成 '1,300'、'20°'、'20 mm'），
而「措辞不同」与**「这个值是编出来的」**在那一格里长得一模一样。

所以复核下沉到**取值层**：不看引文，直接看这个值本身在不在源 PDF 里。
三档都不在所报页、且整份文档里也找不到 → **疑似编造**，直接判失败。

用法： python scripts/matrix_page_check.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

TAGS = re.compile(r"<[^>]+>")
MATH = re.compile(r"\$\s*\\mathrm\s*\{([^}]*)\}\s*\$")
CMD = re.compile(r"\\[a-zA-Z]+")
WS = re.compile(r"\s+")
# 数字 token：允许千分位逗号与小数点连用（'1,300' / '0.150'）。
NUMTOK = re.compile(r"\d+(?:[.,]\d+)*")
# 数字之间的逗号（千分位）。
COMMA = re.compile(r"(\d)[,，](\d)")


def norm(s: str) -> str:
    """去标签 / 去 LaTeX / 去表格竖线 / 去空白 / 去千分位逗号。

    **源页文本与引文片段必须用同一套归一化** —— 两边不一致时，
    '7,000 lx' 的引文永远匹配不上 '7000lx' 的页面（实测少 115 格）。
    """
    s = TAGS.sub(" ", s)
    s = MATH.sub(lambda m: m.group(1), s)
    s = CMD.sub(" ", s)
    s = s.replace("^", "").replace("{", "").replace("}", "").replace("_", "")
    s = s.replace("|", "")
    s = s.replace("㎜", "mm")
    s = WS.sub("", s)
    prev = None
    while prev != s:
        prev = s
        s = COMMA.sub(r"\1\2", s)
    return s


def fragment(excerpt: str, match: str = "", width: int = 14) -> str:
    """挑一段足够独特、又不会太长的连续文字。

    片段要**围绕取值本身**取：只按引文开头取，会拿到
    「在H平面下方的向内几何可见度角可由45°」这种在几十页里都出现的
    通用句，于是「引文在第 31 页和第 32 页都出现」被判成通过 ——
    而真正该引的那一页是第 32 页。
    """
    n = norm(excerpt)
    if len(n) < width:
        return n
    m = norm(match) if match else ""
    at = n.find(m) if m else -1
    if at < 0 or not m:
        return n[:width * 2]
    # 片段**从取值开始往后取**，不往前带：
    # 往前带会撞上排版差异 —— 源 PDF 原文是「无特殊要求;———对于其他类车辆…」
    # （带破折号），MinerU 的引文里破折号没了，于是片段在前 14 个字符上对不上，
    # 只好退到另一处同句的页面上去（那里没有破折号）→ 误报「页码对不上」。
    return n[at:at + len(m) + width]


def value_candidates(match: str, nums) -> list:
    """这个取值在源 PDF 里可能的所有写法。

    '1300'      → '1300' / '1,300' / '1 300'
    '0.150'     → '0.150' / '0.15'（规范化后的数值）
    '2 0 ^'     → '20'（LaTeX 把一个数字拆成两位）
    """
    out = set()
    for m in NUMTOK.finditer(match or ""):
        tok = m.group(0)
        if tok.count(".") >= 2:
            continue                      # 条款号 5.2.4.2，不是值
        out.add(tok)
        out.add(tok.replace(",", ""))
    for n in nums or []:
        s = str(n).replace(",", "")
        if not s:
            continue
        out.add(s)
        if re.fullmatch(r"\d{4,}", s):
            out.add(s[:-3] + "," + s[-3:])
            out.add(s[:-3] + " " + s[-3:])
    return sorted(out)


def has_literal(page: str, lit: str) -> bool:
    """字面量是否作为一个**独立的数**出现在压平后的页文本里。

    前后都不能是数字；前后也不能是「小数点 + 数字」
    （否则 '0.15' 会命中 '0.150' 的前半截）。
    """
    if not lit:
        return False
    i = page.find(lit)
    while i >= 0:
        before = page[i - 1] if i > 0 else ""
        after = page[i + len(lit)] if i + len(lit) < len(page) else ""
        before_bad = before.isdigit() or (before == "." and i >= 2 and page[i - 2].isdigit())
        after_bad = after.isdigit() or (after == "." and i + len(lit) + 1 < len(page) and page[i + len(lit) + 1].isdigit())
        if not before_bad and not after_bad:
            return True
        i = page.find(lit, i + 1)
    return False


def main():
    docs = cs.pick_docs()
    pages = {v: cs.doc_lines(p) for v, p in docs.items()}
    normed = {v: [(p, norm("\n".join(ls))) for p, ls in pages[v]] for v in pages}
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    bad = []            # 页码对不上
    fatal = []          # 三档证据在整份文档里都查不到 —— 疑似编造
    checked = 0
    by_evidence = {"引文": 0, "取值": 0, "条款": 0}
    skipped = 0
    for r in rows:
        for v in ("A", "B", "C"):
            c = r["cells"].get(v) or {}
            if c.get("status") != "verified":
                continue
            val = str(c.get("value") or "")
            m = re.search(r"第\s*(\d+)\s*页", str(c.get("page") or ""))
            if not m or not val:
                skipped += 1
                continue
            cited = int(m.group(1))

            # 档一：引文片段
            frag = fragment(val, str(c.get("match") or ""))
            frag_pages = [p for p, t in normed[v] if len(frag) >= 8 and frag in t]

            # 档二：取值字面量
            cands = value_candidates(str(c.get("match") or ""), c.get("nums") or [])
            val_pages = [p for p, t in normed[v] if any(has_literal(t, cd) for cd in cands)]

            # 档三：条款号
            clause = str(c.get("clause") or "").strip()
            cl_pages = [p for p, t in normed[v] if clause and has_literal(t, clause)]

            everywhere = set(frag_pages) | set(val_pages) | set(cl_pages)
            if not everywhere:
                # **三档证据在整份源 PDF 里都查不到** —— 这个值可能是编出来的。
                fatal.append((r["id"], v, cited, c.get("nums"), c.get("match")))
                continue
            checked += 1
            if cited in frag_pages:
                by_evidence["引文"] += 1
            elif cited in val_pages:
                by_evidence["取值"] += 1
            elif cited in cl_pages:
                by_evidence["条款"] += 1
            else:
                bad.append((r["id"], v, cited, sorted(everywhere)[:6], c.get("source")))

    out = ["核了 %d 个取值格（三档证据回源 PDF 均能定位），跳过 %d 个"
           % (checked, skipped)]
    out.append("证据分布：引文 %d · 取值 %d · 条款 %d"
               % (by_evidence["引文"], by_evidence["取值"], by_evidence["条款"]))
    if fatal:
        out.append("**查不到 %d 处（疑似编造，必须为 0）**：" % len(fatal))
        for f in fatal:
            out.append("   %-44s %s 报第%s页 取值=%s  match=%s" % (f[0], f[1], f[2], f[3], str(f[4])[:50]))
    if not bad:
        out.append("页码全部对得上")
    else:
        out.append("页码对不上 %d 处：" % len(bad))
        for b in bad:
            out.append("   %-44s %s 报第%s页  源 PDF 实为 %s  （来源 %s）"
                       % (b[0], b[1], b[2], b[3], b[4]))
    io.open(os.path.join(ROOT, "reports", "_matrix_page_check.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out[:2]))
    return 1 if (bad or fatal) else 0


if __name__ == "__main__":
    sys.exit(main())
