#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""逐页比较两个 PDF 的**文本**。

## 为什么比文本而不是比字节

PDF 里存着生成时刻（creationDate）、文档 ID 等每次都不同的元数据 ——
字节级比较必然报「不一样」，而那**不是**内容变了。
所以比的是**逐页抽出来的文本**：那才是读者看到的东西。

用法
----
    echo '{"a": "/path/a.pdf", "b": "/path/b.pdf"}' | python scripts/compare_pdfs.py

输出（stdout，JSON）::

    {"pagesA": 258, "pagesB": 249, "diffPages": [50, 51], "firstDiff": "..."}

退出码：0 = 一致；1 = 不一致；2 = 打不开文件。
"""
import io
import json
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

# 封面上的「编制日期」是**每次渲染都变**的时间戳（报告 JSON 的 generatedAt）——
# 两次渲染同一份报告，它也必然不同。
# 所以比较前把它归一化掉；**其余部分必须逐字相同**。
#
# 只抹 ISO 时刻（带 T 与时区），**不抹纯日期** ——
# 报告正文里引用的标准发布日期（2026-09-01）是内容的一部分。
TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z")


def norm(text):
    return TIMESTAMP_RE.sub("<时间戳>", text or "")


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"error": "stdin 不是 JSON：%s" % e}, ensure_ascii=False))
        return 2
    a_path, b_path = payload.get("a"), payload.get("b")
    if not a_path or not b_path:
        print(json.dumps({"error": "需要 a 与 b 两个路径"}, ensure_ascii=False))
        return 2
    try:
        import fitz
    except ImportError:
        print(json.dumps({"error": "没有 PyMuPDF"}, ensure_ascii=False))
        return 2

    try:
        da = fitz.open(a_path)
        db = fitz.open(b_path)
    except Exception as e:
        print(json.dumps({"error": "打不开 PDF：%s" % e}, ensure_ascii=False))
        return 2

    ta = [norm(p.get_text()) for p in da]
    tb = [norm(p.get_text()) for p in db]

    diff = []
    first = None
    for i in range(max(len(ta), len(tb))):
        x = ta[i] if i < len(ta) else None
        y = tb[i] if i < len(tb) else None
        if x != y:
            diff.append(i + 1)
            if first is None:
                xs = (x or "")[:160].replace("\n", "⏎")
                ys = (y or "")[:160].replace("\n", "⏎")
                first = "第 %d 页：A=%r / B=%r" % (i + 1, xs, ys)

    out = {
        "pagesA": len(ta),
        "pagesB": len(tb),
        "diffPages": diff[:20],
        "diffCount": len(diff),
        "firstDiff": first,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0 if not diff else 1


if __name__ == "__main__":
    sys.exit(main())
