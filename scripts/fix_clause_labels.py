# -*- coding: utf-8 -*-
"""还原 MinerU 揉坏的 R48 条款标签。

MinerU 把 R48 §6 的条款表**下一行的标签并进了上一行**：

    | 6.14.4.6.14.4.1. | Position In width: …      ← 真条款是 6.14.4.1
    | 6.27.9.6.27.9.1. | Other requirements …      ← 真条款是 6.27.9.1

源 PDF 的文本层里这些条款号是干净的（scripts/clause_split.py 建的索引）。
这个脚本拿**值 + 原文片段**去干净索引里反查真条款，产出
`data/clause-label-fixes.json`，由 reportV6.ts 在生成附录 D 时套用。

为什么值得做：附录 D 是客户用来回答「**还有没有漏**」的那张清单，
印着一个原文里根本不存在的条款号（`6.14.4.6.14.4.1`），客户翻不到；
而且按章匹配时它还会落到**错误的章**（§6.14 而不是 §6.13），
把已经覆盖的 200mm 误判成「未入矩阵」。

用法： python scripts/fix_clause_labels.py
"""
import io, json, os, re
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
import importlib.util

spec = importlib.util.spec_from_file_location("cs", os.path.join(ROOT, "scripts", "clause_split.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)

OUT = os.path.join(ROOT, "data", "clause-label-fixes.json")

WORD = re.compile(r"[A-Za-z]{4,}")
STOP = {"shall", "than", "with", "this", "that", "from", "which", "been", "were",
        "their", "there", "them", "they", "have", "been", "shall", "vehicle",
        "lamps", "class", "other", "such", "same", "only", "each", "not", "are"}


def words(s):
    return [w.lower() for w in WORD.findall(s) if w.lower() not in STOP]


def norm(s):
    """归一化：只留字母数字与汉字，丢掉空白与标点。"""
    return re.sub(r"[^0-9A-Za-z一-鿿]+", "", s).lower()


# 手工判定的两条：自动反查定不下来（那句话在源 PDF 里跨表又跨页），
# 理由写在这里，**每条都要能被人复核**。
MANUAL = {
    "6.14.6.14.1": (
        "6.13",
        "这条在**示廓灯章 §6.13 的表格行**里（p67）；MinerU 把它与 §6.14 的表格首行"
        "揉在一起，行首标签成了 `6.14.6.14.1`。源 PDF 里这句话跨表跨页，"
        "**定位不到条款号**，所以只给章级。",
    ),
    "6.14.4.3.6.14.5": (
        "6.14.5",
        "粘连标签 = 「6.14.4.3.」+「6.14.5.」，后半段才是真条款号："
        "内容是 6.14.5 几何可见度的下半句「Vertical angle: 10° above and below horizontal. "
        "However, where a retro-reflector is mounted below 750 mm …」。"
        "源 PDF 里 6.14.5 的正文被修订标记截断（只剩 'ha eliminato:'），"
        "所以自动反查定不下来。",
    ),
}


def main():
    docs = cs.pick_docs()
    idx = cs.split_clauses(docs["C"])
    rep = json.load(io.open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
    md = [a["markdown"] for a in rep["appendices"] if a.get("id") == "D"][0]
    i = md.find("## D.3")

    fixes = {}
    for line in md[i:].split("\n"):
        if not line.startswith("| 6."):
            continue
        c = [x.strip() for x in line.strip("|").split("|")]
        if len(c) < 6:
            continue
        label, value, unit, text = c[0], c[2], c[3], c[4]
        if label in idx or label in fixes:
            continue
        if label in MANUAL:
            fixes[label] = MANUAL[label][0]
            print("  %-28s → %-12s （人工判定：%s）" % (label, MANUAL[label][0], MANUAL[label][1][:40]))
            continue
        # ① 原文片段去掉开头的「｜ <粘连标签> ｜」—— 剩下的是条款正文，
        #    拿它去干净索引里找**包含这段文字**的条款。
        rest = text
        if rest.startswith("｜") or rest.startswith("|"):
            parts = rest.split("｜")
            rest = "｜".join(parts[2:]) if len(parts) > 2 else rest
        nrest = norm(rest)[:120]
        best = ""
        for clause, obj in idx.items():
            if not clause.startswith("6."):
                continue
            if nrest and nrest in norm(obj.get("body", "")):
                best = clause
                break
        if best:
            fixes[label] = best
            print("  %-28s → %-12s （原文片段逐字命中）" % (label, best))
            continue
        # ② 退一步：值 + 用词重合。**必须同章** —— 跨章的候选会把
        #    「6.14.4.3.6.14.5（应是 6.14.5）」错配到 6.9.5.2（也是 750mm）。
        chap = label.split(".")[:2]
        val = value.replace(",", "")
        tw = set(words(text))
        best, best_score = "", -1
        for clause, obj in idx.items():
            body = obj.get("body", "")
            if not clause.startswith("6."):
                continue
            if clause.split(".")[:2] != chap:
                continue
            if not re.search(r"(?<![\d.])" + re.escape(val) + r"(?![\d])", body):
                continue
            score = len(tw & set(words(body)))
            if score > best_score:
                best, best_score = clause, score
        if best and best_score >= 4:
            fixes[label] = best
            print("  %-28s → %-12s (用词重合 %d)" % (label, best, best_score))
        else:
            print("  %-28s → 没查到（保留原样）" % label)

    io.open(OUT, "w", encoding="utf-8", newline="").write(
        json.dumps(fixes, ensure_ascii=False, indent=2) + "\n")
    print("写入 %s（%d 条）" % (os.path.relpath(OUT, ROOT), len(fixes)))


if __name__ == "__main__":
    main()
