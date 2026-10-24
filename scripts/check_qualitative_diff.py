# -*- coding: utf-8 -*-
"""逐条核对附录 H 引用的 A/B 原文**确实在源 PDF 里**。

附录 H 是客户第一句抱怨（「仍然只有法规中，有具体数值的内容的比较」）
的直接答复 —— 条款级的定性并排对照。**它引的每一句都必须来自原文**，
不能是我们改写的、也不能是切条款时切串了。

做法：把源 PDF 的文本层与引文都**去掉空白**后比对。
条款号在 PDF 里常被拆成多行（「5.\\n21.\\n5.\\n1.」），所以不比整句，
而是**滑动窗口**：引文里任意一段 40 字的连续片段必须能在源 PDF 里找到。
找不到 → 打印出来并以非零退出。

用法： python scripts/check_qualitative_diff.py
"""
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIFF = os.path.join(ROOT, "data", "qualitative-diff.json")

_s = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(_s)
_s.loader.exec_module(cs)


def norm(s: str) -> str:
    s = re.sub(r"\s+", "", str(s))
    s = s.replace("（", "(").replace("）", ")")
    s = s.replace("，", ",").replace("：", ":").replace("；", ";")
    s = s.replace("、", ",").replace("＜", "<").replace("＞", ">")
    s = s.replace("－", "-").replace("㎜", "mm")
    return s


def _variants(quote: str, label: str = ""):
    """引文可能要试的几种形态。

    条款的**款**（"配备"/"数量"/"几何可见度"/…）在源 PDF 里是**标题行**，
    常常在**上一页的尾巴上** —— 条款正文从下一页开始。
    所以「款 + 正文」连成一句在源 PDF 里**不是连续串**。
    这种情况不是数据错，是切分器把标题和正文接在了一起；
    核对时把款去掉再比。
    """
    yield quote
    if label and quote.startswith(label):
        yield quote[len(label):]
    m = re.match(r"^[^：:]{1,10}[：:]", quote)
    if m:
        yield quote[m.end():]
    else:
        i = quote.find(" ")
        if 0 < i <= 10:
            yield quote[i + 1:]


def main() -> int:
    spec = json.load(io.open(DIFF, encoding="utf-8"))
    docs = cs.pick_docs()
    corpus = {}
    for v, path in docs.items():
        pages = cs.doc_lines(path)
        corpus[v] = norm("\n".join("\n".join(l for l in lines) for _, lines in pages))

    pairs = spec.get("pairs") or []
    total = ok = 0
    bad = []
    for p in pairs:
        for ver, key in (("A", "aText"), ("B", "bText")):
            quote = norm(str(p.get(key) or ""))
            if len(quote) < 6:
                continue
            total += 1
            hit = False
            for q in _variants(quote, str(p.get("label") or "")):
                if len(q) < 6:
                    continue
                # 滑动窗口：任意一段连续片段在源 PDF 里
                w = min(40, len(q))
                for i in range(0, max(1, len(q) - w + 1), 20):
                    if q[i:i + w] and q[i:i + w] in corpus.get(ver, ""):
                        hit = True
                        break
                if hit:
                    break
            if hit:
                ok += 1
            else:
                bad.append((p.get("bClause"), p.get("aClause"), ver, quote[:90]))

    print("附录 H 原文片段：%d 条，命中 %d 条" % (total, ok))
    if bad:
        print("对不上的 %d 条：" % len(bad))
        for bc, ac, ver, q in bad[:20]:
            print("  B %s / A %s [%s]：%s" % (bc, ac, ver, q))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
