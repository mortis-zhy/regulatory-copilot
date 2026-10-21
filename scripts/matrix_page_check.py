# -*- coding: utf-8 -*-
"""不变式：**矩阵每一格引用的页，源 PDF 的那一页上真的有那段话**。

为什么单独一个脚本：第 12 章矩阵的页码来自 MinerU 的分页标记，
而**主题列**早就做过「源 PDF 页码复核」（verify_claims.py 的
「源 PDF 页码复核」那一遍，四个格因此被降级）。**矩阵这一路没做过。**

后果是页码整体错位：B 的 MinerU 全文 81 页、页标记 1–81 齐全，
但「向内几何可见度角可由 45°减至 20°」这段在 MinerU 标成第 31 页，
在源 PDF 里其实在**第 32 页**（5.5.5.2 的起始页）。读者翻到第 31 页，
找不到那句话 —— 页码本身就是一条错误信息。

本脚本拿**引文本身**当证据：
1. 把引文归一化（去标签、去 LaTeX、去空白）；
2. 在源 PDF 每一页里找它；
3. 找到的页 ≠ 矩阵报的页 → 报出来。

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


def norm(s: str) -> str:
    s = TAGS.sub(" ", s)
    s = MATH.sub(lambda m: m.group(1), s)
    s = CMD.sub(" ", s)
    s = s.replace("^", "").replace("{", "").replace("}", "")
    s = s.replace("㎜", "mm").replace("°", "°")
    return WS.sub("", s)


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


def main():
    docs = cs.pick_docs()
    pages = {v: cs.doc_lines(p) for v, p in docs.items()}
    normed = {v: [(p, norm("\n".join(ls))) for p, ls in pages[v]] for v in pages}
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    rows = rep["parameterMatrix"]

    bad = []
    checked = 0
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
            frag = fragment(val, str(c.get("match") or ""))
            if len(frag) < 8:
                skipped += 1
                continue
            found = [p for p, t in normed[v] if frag in t]
            if not found:
                skipped += 1          # MinerU 与源 PDF 措辞不同，查不到不算错
                continue
            checked += 1
            if cited not in found:
                bad.append((r["id"], v, cited, found, c.get("source")))
    out = ["核了 %d 个取值格（引文能在源 PDF 里定位），跳过 %d 个" % (checked, skipped)]
    if not bad:
        out.append("页码全部对得上")
    else:
        out.append("页码对不上 %d 处：" % len(bad))
        for b in bad:
            out.append("   %-44s %s  报第%s页  源 PDF 实为 %s  （来源 %s）"
                       % (b[0], b[1], b[2], b[3], b[4]))
    io.open(os.path.join(ROOT, "reports", "_matrix_page_check.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out[:1]))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
