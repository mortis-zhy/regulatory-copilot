# -*- coding: utf-8 -*-
"""生成附录 H 的数据：A 草案 ↔ B 现行的**定性条款**并排对照。

为什么要有这个
--------------
客户看完 ㉖ 说「仍然只有法规中，有具体数值的内容的比较」。
第 12 章的矩阵全是标量，第 14 章是**章级**的整段原文并排 ——
但**条款级**的定性差异（"后位灯首次点亮可用顺序点亮" 这类要求），
在整份报告里只是**罗列**在附录 E.5.1 的清单里，**没有并排对比**。

这份数据就是补上这一层：把 A、B 两版**同一装置的同一条款**拉到一起，
逐条给出两版原文与差异处。

安全规则（本项目第一原则：宁可空着，不可错着）
------------------------------------------
1. **同号 ≠ 同条款。** A 与 B 在装置级**重排过编号** ——
   A 的 5.4 是**前雾灯**，B 的 5.4 是**倒车灯**；
   A 的 5.21 是倒车灯，B 的 5.21 是醒目标志。
   只按编号配对，会把「前雾灯的横向位置」和「倒车灯的横向位置」摆在一起
   说"改了" —— **那是造出来的假变化**。
   所以配对必须先过**装置级重排表**（`server/reports/chapterStructural.ts`
   的 `DEVICE_RENUMBERING`，11 条，已回原文核验）：B 的 5.3 前雾灯 → A 的 5.4。
2. 光有装置对应还不够，**"款"也必须一致**才配对：款 = 条款的标签
   （配备/数量/布局/位置/横向/高度/纵向/几何可见度/方向/电路连接/指示器/其他要求…）。
   款不一致 → 判为**编号重排**，**不并排**（单列在"未并排"一节）。
3. 无款的条款（单段落散文）只有在**前 10 个归一化字符完全相同**时才配对；
   否则不配对。这一条是保守方向：宁可漏，不错。
4. 归一化（比"是否同文"用）：去空白、去标点、中文数字→阿拉伯数字、
   ㎜→mm。**"文字不同"只说明字面不同，不判"实质变化"** ——
   实质变化是工程判断，报告不替读者下结论；差异片段直接标出来。

用法： python scripts/build_qualitative_diff.py [--write]
"""
import difflib
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "data", "clause-index.json")
OUT = os.path.join(ROOT, "data", "qualitative-diff.json")

# 条款的"款"（标签）—— GB 4785 里每个子条款都以此开头
TITLES = {
    "配备", "数量", "布局", "位置", "横向", "高度", "纵向", "几何可见度",
    "方向", "电路连接", "指示器", "其他要求", "通用要求", "环境条件",
    "试验方法", "等级", "定义", "符号", "缩略语",
}

CN_DIGITS = {
    "零": "0", "一": "1", "二": "2", "两": "2", "三": "3", "四": "4",
    "五": "5", "六": "6", "七": "7", "八": "8", "九": "9", "十": "10",
}

# 全角→半角（只影响"是否同文"的比较，不影响展示的原文）
PUNCT_MAP = {
    "，": ",", "。": ".", "；": ";", "：": ":", "（": "(", "）": ")",
    "、": ",", "＜": "<", "＞": ">", "－": "-", "—": "-", "–": "-",
    "“": '"', "”": '"', "‘": "'", "’": "'", "！": "!", "？": "?",
    "％": "%", "·": ".", "〔": "(", "〕": ")",
}


def load_index():
    with io.open(INDEX, encoding="utf-8") as f:
        return json.load(f)["_clauses"]


def clause_label(clause, ent):
    """取条款的"款"（标签）。取不到返回 None。"""
    body = ent.get("body") or ""
    if not body.strip():
        return None
    first = body.split("\n")[0]
    first = re.sub(r"^\s*" + re.escape(clause) + r"\s*", "", first)
    first = re.sub(r"^\s*\d+(\.\d+)*\s*", "", first)
    m = re.match(r"^([^\s:：]{1,10})[:：]", first)
    if m:
        # "水平方向角β" 与 "水平方向角" 是同一条款（β 只是记号）
        return re.sub(r"[αβγδ]+$", "", m.group(1)).strip()
    s = first.strip()
    if s in TITLES:
        return s
    if len(s) <= 4 and re.match(r"^[一-鿿]+$", s):
        return s
    return None


def clean_body(text, clause):
    """去掉页眉页脚、被 MinerU 拆散的条款号、页码残片。"""
    t = text
    t = re.sub(r"GB\s*4785[—\-–]?\s*(X+|\d{4})", " ", t)   # 页眉 GB 4785—XXXX / GB4785—2019
    t = re.sub(r"^\s*" + re.escape(clause) + r"\s*", "", t)  # 行首条款号
    t = re.sub(r"^\s*\d+(\.\d+)*\s*", "", t)                # B 侧被拆成 "1 配备"
    t = re.sub(r"(?:\d+\s*\.\s*\n?\s*)+$", "", t)           # 尾部拆散的条款号
    t = re.sub(r"^\s*(?:\d+\s*\.\s*\n?\s*)+", "", t)
    t = re.sub(r"(?:\d+\s*\.\s*\n?\s*)+", " ", t)            # 中间的拆散条款号
    t = re.sub(r"(?m)^\s*\d{1,3}\s*$", " ", t)              # 独立成行的页码
    return re.sub(r"\s+", " ", t).strip()


def norm(text):
    """归一化（只用于"是否同文"与"是否同款"的比较）。"""
    s = text.replace("㎜", "mm")
    for k, v in CN_DIGITS.items():
        s = s.replace(k, v)
    s = "".join(PUNCT_MAP.get(c, c) for c in s)
    s = re.sub(r"\s+", "", s)
    return s


def comp_pairs(text):
    """返回 (比较串, 原文字符列表) —— 便于把 diff 的下标映射回原文。"""
    comp = []
    orig = []
    for ch in text:
        c = PUNCT_MAP.get(ch, ch)
        if c.isspace():
            continue
        comp.append(c)
        orig.append(ch)
    return "".join(comp), orig


def diff_segments(a_text, b_text, max_segments=4):
    """逐字差异片段。返回 [{a, b}]，纯标点差异不计。"""
    ca, oa = comp_pairs(a_text)
    cb, ob = comp_pairs(b_text)
    sm = difflib.SequenceMatcher(None, ca, cb, autojunk=False)
    out = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        sa = "".join(oa[i1:i2]).strip()
        sb = "".join(ob[j1:j2]).strip()
        if not sa and not sb:
            continue
        # 只是标点不同 → 不算差异
        if not re.sub(r"[^\w一-鿿]", "", sa) and not re.sub(r"[^\w一-鿿]", "", sb):
            continue
        out.append({"a": sa, "b": sb})
        if len(out) >= max_segments:
            break
    return out


def truncate(text, limit=320):
    if len(text) <= limit:
        return text
    cut = text[:limit]
    for sep in ("。", "；", "，", " "):
        idx = cut.rfind(sep)
        if idx > limit * 0.6:
            return cut[: idx + 1]
    return cut + "……"


def build():
    idx = load_index()
    A, B = idx.get("A", {}), idx.get("B", {})
    pairs, unpaired = [], []

    # B 条款号 → A 条款号。先按装置级重排表换第一段（装置号），
    # 后面的子条款号原样保留 —— A 只是把装置**挪了位置**，装置内部的
    # 子条款编号没动（§11.6.2 已核验）。
    def a_clause_of(b_clause):
        parts = b_clause.split(".")
        head = parts[0]
        mapped = DEVICE_B_TO_A.get(head)
        if mapped is None:
            return None
        return ".".join([mapped] + parts[1:])

    for b_clause in sorted(B, key=lambda c: [int(x) for x in c.split(".")]):
        eb = B[b_clause]
        if not (eb.get("body") or "").strip():
            continue
        a_clause = a_clause_of(b_clause)
        ea = A.get(a_clause) if a_clause else None
        if not ea or not (ea.get("body") or "").strip():
            continue

        la, lb = clause_label(a_clause, ea), clause_label(b_clause, eb)
        a_text = clean_body(ea["body"], a_clause)
        b_text = clean_body(eb["body"], b_clause)
        if not a_text or not b_text:
            continue

        if la and lb:
            matched = la == lb
        else:
            # 无款：只有前 10 个归一化字符完全相同才认为是同一条款
            na, nb = norm(a_text), norm(b_text)
            matched = bool(na[:10]) and na[:10] == nb[:10]

        if not matched:
            unpaired.append({
                "bClause": b_clause,
                "aClause": a_clause,
                "aLabel": la or "",
                "bLabel": lb or "",
                "aHead": (ea.get("head") or "").strip()[:60],
                "bHead": (eb.get("head") or "").strip()[:60],
                "aPage": ea.get("page") or 0,
                "bPage": eb.get("page") or 0,
            })
            continue

        na, nb = norm(a_text), norm(b_text)
        same = na == nb
        pairs.append({
            "bClause": b_clause,
            "aClause": a_clause,
            "label": la or lb or "",
            "device": DEVICE_B_TO_A.get(b_clause.split(".")[0], ""),
            "aPage": ea.get("page") or 0,
            "bPage": eb.get("page") or 0,
            "aText": a_text,
            "bText": b_text,
            "same": same,
            "diffs": [] if same else diff_segments(a_text, b_text),
        })

    diff_pairs = [p for p in pairs if not p["same"]]
    same_pairs = [p for p in pairs if p["same"]]
    return {
        "generatedAt": None,
        "summary": {
            "comparable": len(pairs),
            "sameText": len(same_pairs),
            "differentText": len(diff_pairs),
            "notComparable": len(unpaired),
        },
        "pairs": pairs,
        "unpaired": unpaired,
    }


def main():
    data = build()
    if "--write" in sys.argv:
        with io.open(OUT, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=1))
        print("wrote %s" % OUT)
    s = data["summary"]
    print("同号对 %d · 可并排 %d（同文 %d / 文字不同 %d）· 不可并排 %d"
          % (s["sameNumberPairs"], s["comparable"], s["sameText"], s["differentText"], s["notComparable"]))
    for p in data["pairs"]:
        if p["same"]:
            continue
        d = "；".join("「%s」→「%s」" % (x["a"] or "∅", x["b"] or "∅") for x in p["diffs"][:3])
        print("  %s [%s] %s" % (p["clause"], p["label"], d[:120]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
