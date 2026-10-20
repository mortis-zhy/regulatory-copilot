# -*- coding: utf-8 -*-
"""审计 v2 —— 决定性检查：cell.match 这段文本，是否真的存在于源 PDF 里。

v1 的漏洞是把小数（1/2/4/5/10）当噪声跳过，正好放过了 15 行。
v2 不看数字，只问一句：你抽出来的那句话，原文里找得到吗？
"""
import json, io, os, re, sys
sys.stdout.reconfigure(encoding='utf-8')
OUTER = os.path.abspath('..')

SRC = {'A': '源文件_A_GB4785草案V4.3.5_103页.pdf',
       'B': '源文件_B_GB4785-2019_81页.pdf',
       'C': '源文件_C_UN-R48-09_147页.pdf'}
import fitz
DOCS = {k: fitz.open(os.path.join(OUTER, 'PDF对比', f)) for k, f in SRC.items()}
def _fold_latex(s):
    """LaTeX 宏 → 源 PDF 的纯文本写法。

    MinerU 把 GB 4785-2019 的角度写成 `$2 0 ^ { \circ }$`，源 PDF 印的是 `20°`。
    早期实现把 `$…$` 整段删掉，于是这一格的 match 被清空、审计报「查无此句」——
    而让检查变绿的唯一办法是去改**正确的数据**。归一化，不是删除。

    **不做 `$` 配对**：抽取器的捕获组常常不配对（源文 `$2 0 ^ { \circ }$`，
    spec 的组只框到 `}`），MinerU 的输出本来也常见不成对的数学定界符。
    假设配对的后果是归一化静默跳过，检查又开始误报。
    """
    BS = chr(92)
    for w in ("circ", "degree"):
        s = s.replace(BS + w, "°")
    for w in ("text", "mathrm", "mathit", "dfrac", "frac", "left", "right",
              "times", "cdot", "le", "ge", "quad", "qquad"):
        s = s.replace(BS + w, "")
    return s.replace("{", "").replace("}", "").replace("^", "")



def scrub_page(x):
    x = _fold_latex(x)
    # 单个数字之间的空格是一个数字（MinerU 硬换行），与 numbersOf() 同规则。
    x = re.sub("(?<![\\d.])" + r"\b(\d)\s+(\d)\b" + "(?![\\d.])", r"\1\2", x)
    return re.sub(r"[^0-9A-Za-z一-鿿.°±]", "", x)



PAGES = {k: [scrub_page(d[i].get_text()) for i in range(d.page_count)] for k, d in DOCS.items()}


def flat(s):
    return scrub_page(s)

rep = json.load(io.open('reports/last-report.json', encoding='utf-8'))
rows = rep['parameterMatrix']

exact = wrongpage = absent = 0
findings = []
for r in rows:
    # `cells` is the version→cell map; older reports carried A/B/C flat.
    for v, c in (r.get('cells') or {k: r[k] for k in 'ABC' if k in r}).items():
        if c.get('status') != 'verified':
            continue
        m = flat(str(c.get('match') or ''))
        # MinerU emits markup the source PDF does not contain: <sub>2</sub>,
        # ${\mathrm{W}}_{12}$, and markdown " | " pipe separators between table
        # cells (the PDF's text layer just runs them together: "W12绿色边界
        # y=0.150+0.640x"). Comparing raw match text against raw PDF text makes
        # every markup-bearing cell read as "not in the source" when the value is
        # demonstrably there. Strip markup and punctuation from BOTH sides and
        # keep only what carries meaning: digits, letters, CJK, . and °.
        def scrub(x):
            x = re.sub(r'</?[a-zA-Z]+>', '', x)
            x = _fold_latex(x)
            return re.sub(r'[^0-9A-Za-z一-鿿.°±]', '', x)
        # scrub the RAW match: flat() already deleted the angle brackets,
        # so by the time scrub() ran there was no <sub> left to strip and
        # "N<sub>2</sub>G" had become "Nsub2subG".
        m2 = scrub(str(c.get('match') or ''))
        pg = re.search(r'第(\d+)页', c.get('page', ''))
        p0 = int(pg.group(1)) if pg else None
        allp = PAGES[v]
        near = [p0 + d for d in range(-3, 4) if p0 and 1 <= p0 + d <= len(allp)]
        on_near = any(m and (m in allp[p - 1] or m2 in allp[p - 1]) for p in near)
        anywhere = any((m and m in pg_) or (m2 and m2 in pg_) for pg_ in allp)
        where = [i + 1 for i, pg_ in enumerate(allp) if (m and m in pg_) or (m2 and m2 in pg_)]
        if on_near:
            exact += 1
        elif anywhere:
            wrongpage += 1
            findings.append((r['name'], v, c.get('page'), '页码偏差 → 实际在 p%s' % where[:3], 'PAGE'))
        else:
            absent += 1
            findings.append((r['name'], v, c.get('page'), '★ 源 PDF 中找不到这段文本', 'MISSING'))

print('=' * 74)
print('审计 v2：原文逐句核对 —— 命中标注页 %d / 页码偏差 %d / 源PDF查无此句 %d'
      % (exact, wrongpage, absent))
print('=' * 74)
for n, v, p, why, kind in findings:
    print('  [%-4s] %-22s %-7s %s' % (kind, n[:20], p or '—', why))
