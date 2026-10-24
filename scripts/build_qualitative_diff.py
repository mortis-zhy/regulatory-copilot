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


def device_map():
    """B 条款号 → A 条款号。

    **必须先过装置级重排表**（`server/reports/chapterStructural.ts` 的
    `DEVICE_RENUMBERING` + `STRUCTURAL_CHAPTERS`）：

        B 5.3 前雾灯  → A 5.4      B 5.4 倒车灯 → A 5.21
        B 5.5 转向灯  → A 5.6      B 5.6 危险警告 → A 7.1
        B 6 检验规则  → A 8        B 6.1 同一型式 → A 9
        B 7 实施日期  → A 10

    不做这一步就会把「A 的前雾灯横向位置」和「B 的倒车灯横向位置」
    摆在一起说「改了」—— **那是造出来的假变化**。

    映射表是**从 TS 源码里读的**（不是抄一份到 Python），
    这样改一处就够；抄两份迟早会漂。
    """
    src = io.open(
        os.path.join(ROOT, "server", "reports", "chapterStructural.ts"),
        encoding="utf-8",
    ).read()
    out = {}
    # 装置级：{ name: "前雾灯", bNumber: "5.3", aNumber: "5.4", ... }
    for m in re.finditer(
        r'\{\s*name:\s*"[^"]*",\s*bNumber:\s*"([^"]+)",\s*aNumber:\s*"([^"]+)"', src
    ):
        out[m.group(1)] = m.group(2)
    # 章节级：{ category: "renumbered", aNumber: "8", ..., bNumber: "6", ... }
    for m in re.finditer(
        r'category:\s*"renumbered",\s*aNumber:\s*"([^"]+)"[^}]*?bNumber:\s*"([^"]+)"', src
    ):
        out[m.group(2)] = m.group(1)
    return out


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
    """去掉页眉页脚、页码、本条款号与**尾部**下一条款号的碎片。

    **中间**的碎片**一律不动** —— 那是 PDF 把数字拆行造成的，
    拼回去才是原文：「宽度大于2.\\n10m」= **2.10m**，
    「按5.\\n2.\\n7.\\n6b)」= **5.2.7.6b)**。

    早先这里把中间的碎片也删掉（以为那是条款号），
    结果 **「2.10m」被吃成「10m」** —— 宽度门槛差了一个数量级，
    而它会**原样印在客户手里的附录 H 里**。
    宁可留一个「5.2.7.6b)」的引用，也绝不能印错一个数。
    """
    t = text
    t = re.sub(r"(?m)^\s*\d{1,3}\s*$", " ", t)              # 独立成行的页码
    t = re.sub(r"\d{1,3}\s*(?=GB\s*4785)", " ", t)         # 紧贴页脚的页码
    t = re.sub(r"GB\s*4785[—\-–]?\s*(?:X+|\d{4})", " ", t)  # 页眉/页脚
    t = re.sub(r"^\s*" + re.escape(clause) + r"\s*", "", t)  # 行首条款号
    t = re.sub(r"^\s*\d+(\.\d+)*\s*", "", t)                # B 侧被拆成 "1 配备"
    t = re.sub(r"(?:\d+\s*\.\s*\n?\s*)+$", "", t)           # 尾部下一条款号的碎片
    t = re.sub(r"\s+", " ", t).strip()
    # 切分器有时把**下一个装置的标题行**留在上一条的尾巴上
    # （A 的 5.11.4.2 尾巴上挂着「后雾灯」三个字）——
    # 那是标题，不是这一条的内容。尾部一段「只有汉字、没有标点」的短串去掉。
    m = re.search(r"^(.*?)([一-鿿]{2,8})$", t)
    if m and len(m.group(1).strip()) > 12:
        t = m.group(1).strip()
    return t


def norm(text):
    """归一化（只用于"是否同文"与"是否同款"的比较）。"""
    s = text.replace("㎜", "mm")
    for k, v in CN_DIGITS.items():
        s = s.replace(k, v)
    s = "".join(PUNCT_MAP.get(c, c) for c in s)
    s = re.sub(r"\s+", "", s)
    return s


def comp_pairs(text):
    """返回 (比较串, 原文字符列表, 原文字符下标) —— 便于把 diff 的下标映射回原文。

    比较串上的字符**已经归一化**（标点全角→半角、中文数字→阿拉伯数字），
    所以「两只」与「2只」不会被标成差异 —— **那是写法不同，不是内容不同**。
    """
    comp = []
    orig = []
    idx = []
    for i, ch in enumerate(text):
        c = PUNCT_MAP.get(ch, ch)
        c = CN_DIGITS.get(c, c)
        if c.isspace():
            continue
        comp.append(c)
        orig.append(ch)
        idx.append(i)
    return "".join(comp), orig, idx


def diff_segments(a_text, b_text, max_segments=4):
    """逐字差异片段 + **带标记的原文**。

    返回 (segments, a_marked, b_marked)：
    · segments = [{a, b}]，纯标点差异不计；
    · a_marked / b_marked = 原文，**差异处用 `**…**` 框住**。

    为什么要在原文里标出来：172 条「文字不同」里，绝大多数差别只有一两个字
    （「挂车不应安装」→「挂车不应使用」）。不给标记，读者得逐字比对两段
    几百字的中文；给了标记，一眼就看出是「整段新增」还是「换个词」。
    渲染器（htmlRenderV8 的 inlineMd）会在表格单元格里把 `**…**` 变成粗体。

    标记只加在**原文**上，不改一个字 —— 回源核验时把 `**` 去掉即可。
    """
    ca, oa, ia = comp_pairs(a_text)
    cb, ob, ib = comp_pairs(b_text)
    sm = difflib.SequenceMatcher(None, ca, cb, autojunk=False)
    out = []
    a_spans, b_spans = [], []
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
        if sa.strip():
            a_spans.append((i1, i2))
        if sb.strip():
            b_spans.append((j1, j2))
        if len(out) >= max_segments:
            break
    return out, _apply_marks(a_text, ia, a_spans), _apply_marks(b_text, ib, b_spans)


def _apply_marks(text, idx, spans):
    """在原文的指定区间外套 `**`（区间是「比较串」的下标，靠 idx 映射回原文）。"""
    if not spans:
        return text
    ranges = []
    for s, e in spans:
        if s >= len(idx) or e <= s:
            continue
        ranges.append((idx[s], idx[e - 1] + 1))
    ranges.sort()
    out = []
    cur = 0
    for s, e in ranges:
        if s < cur:
            continue
        out.append(text[cur:s])
        out.append("**" + text[s:e] + "**")
        cur = e
    out.append(text[cur:])
    return "".join(out)


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
    dev_map = device_map()

    def a_clause_of(b_clause):
        """B 条款号 → A 条款号（**最长前缀**匹配）。

        「最长前缀」很重要：B 6.1 拆成 A 9.1（同一型式判定独立成章），
        而 B 6.2/6.3 落在 A 8.2/8.3（检验规则）——
        同一个 B 章 6 里就有两种映射，短的优先会全错。
        """
        parts = b_clause.split(".")
        for i in range(len(parts), 0, -1):
            pre = ".".join(parts[:i])
            if pre in dev_map:
                return ".".join([dev_map[pre]] + parts[i:])
        # 没进重排表 = 编号未变（A 的 5.x 里除了那 11 个装置，其余不动）
        return b_clause

    for b_clause in sorted(B, key=lambda c: [int(x) for x in c.split(".")]):
        eb = B[b_clause]
        if not (eb.get("body") or "").strip():
            continue
        a_clause = a_clause_of(b_clause)
        ea = A.get(a_clause) if a_clause else None
        if not ea or not (ea.get("body") or "").strip():
            continue
        # 同一句话不能在 A/B 各算一遍（B 5.21 ↔ A 5.20，而 A 5.20 又在 B 5.20↔A 5.5 的射程外）
        if a_clause == b_clause and b_clause in dev_map:
            continue

        la, lb = clause_label(a_clause, ea), clause_label(b_clause, eb)
        a_text = clean_body(ea["body"], a_clause)
        b_text = clean_body(eb["body"], b_clause)
        if not a_text or not b_text:
            continue
        # **引出条款**：正文只有一个标题（如 A 的「5.22.7 电路连接」），
        # 实质内容在子条款里（A 5.22.7.1 / 5.22.7.2）。
        # 不标出来的话，读者会以为「A 这条没内容」——
        # 而事实是 A **拆得更细**。把子条款号列出来。
        a_kids = child_clauses(A, a_clause)
        b_kids = child_clauses(B, b_clause)
        a_lead = (la and a_text.startswith(la) and not a_text[len(la):].strip())
        b_lead = (lb and b_text.startswith(lb) and not b_text[len(lb):].strip())

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
                "device": device_name(B, b_clause),
                "aHead": (ea.get("head") or "").strip()[:60],
                "bHead": (eb.get("head") or "").strip()[:60],
                "aPage": ea.get("page") or 0,
                "bPage": eb.get("page") or 0,
            })
            continue

        na, nb = norm(a_text), norm(b_text)
        same = na == nb
        segs, a_marked, b_marked = diff_segments(a_text, b_text)
        pairs.append({
            "bClause": b_clause,
            "aClause": a_clause,
            "label": la or lb or "",
            "device": device_name(B, b_clause),
            "aPage": ea.get("page") or 0,
            "bPage": eb.get("page") or 0,
            "aText": a_text,
            "bText": b_text,
            "aMarked": a_marked,
            "bMarked": b_marked,
            "aLead": bool(a_lead),
            "bLead": bool(b_lead),
            "aKids": a_kids,
            "bKids": b_kids,
            "same": same,
            "diffs": segs,
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


def device_name(idx, clause):
    """条款所属的装置名（B 侧的**章**标题）。

    取**两段**前缀（B 5.3）的 head，不是最近的那个祖先 ——
    B 的 5.3.4 的 head 是「4 安装位置」（那是**款**，不是装置），
    按最近的祖先取会把装置名取成「安装位置」。
    """
    parts = clause.split(".")
    for i in (2, 1):
        if len(parts) < i:
            continue
        ent = idx.get(".".join(parts[:i]))
        if not ent:
            continue
        head = (ent.get("head") or "").strip()
        head = re.sub(r"^\d+(?:\.\d+)*\s*", "", head)
        head = re.sub(r"[（(].*", "", head).strip()
        if head and re.search(r"[一-鿿]", head):
            return head
    return ""


def child_clauses(idx, clause):
    """这一条下面的子条款号（引出条款的实质内容在它们身上）。"""
    pre = clause + "."
    kids = [k for k in idx if k.startswith(pre) and k.count(".") == clause.count(".") + 1]
    return sorted(kids, key=lambda c: [int(x) for x in c.split(".")])


def main():
    data = build()
    if "--write" in sys.argv:
        with io.open(OUT, "w", encoding="utf-8") as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print("wrote %s" % OUT)
    s = data["summary"]
    print("可并排 %d（同文 %d / 文字不同 %d）· 不可并排 %d"
          % (s["comparable"], s["sameText"], s["differentText"], s["notComparable"]))
    for p in data["pairs"]:
        if p["same"]:
            continue
        d = "；".join("「%s」→「%s」" % (x["a"] or "∅", x["b"] or "∅") for x in p["diffs"][:3])
        print("  %s→%s [%s] %s" % (p["bClause"], p["aClause"], p["label"], d[:110]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
