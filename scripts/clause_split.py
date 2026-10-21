# -*- coding: utf-8 -*-
"""条款切分（源 PDF 文本层，按**行**处理，把被拆开的条款号拼回来）。

为什么不用平铺文本
------------------
GB 4785 的 PDF 把条款号拆成几行：

    5.
    9.
    4.
    1 横向:在基准轴线方向上,离车辆纵向对称平面最远的视表面上的点,…

平铺之后是「5.9.4.1 横向:…」，但**正文里到处是交叉引用**（「按5.5.4.2规定」、
「paragraph 5.7」）—— 平铺文本按「数字+空格」切，会把这些引用当成条款开头，
条款的正文就被切得七零八落（C 6.21.7.5 的正文曾被切到上一条去）。

按行处理就稳了：条款号要么完整地出现在一行里，要么被拆成
「5.」「9.」「4.」这样的**纯数字碎片**，而交叉引用不会独占一行。

用法
----
    python scripts/clause_split.py                      # 三版清点
    python scripts/clause_split.py --clause 5.7.4.2.1 --ver B
"""
import io, json, os, re, glob, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "uploaded-docs")

# 一行**只有**数字 → 可能是被拆开的条款号碎片
PURE_NUM = re.compile(r"^(\d+(?:\.\d+)*)\.?$")
# 一行以「数字」开头且数字后有空白 → 条款号 + 标题
NUM_HEAD = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+(.*)$")
# 目录行：点引线（中文本用「……」，英文本用「....」）。
# 中文目录的页码往往**独占一行**（「远光灯」/「18」/「…………」），
# 所以「整行都是点引线」也算目录。
TOC = re.compile(r"^(?:[….]{6,})|(?:[0-9]{1,3}[…]{2,}\s*$)|(?:\.{4,}\s*$)")


def pick_docs():
    out = {}
    for p in sorted(glob.glob(os.path.join(DOCS, "*.pdf"))):
        try:
            import fitz
            d = fitz.open(p)
            head = "".join(d[i].get_text() for i in range(min(3, d.page_count)))
            d.close()
        except Exception:
            continue
        nodash = re.sub(r"[—–‐‑‒−-]", "", re.sub(r"\s+", "", head))
        if "UnitedNationsRegulations" in nodash or "AgreementConcerning" in nodash:
            out["C"] = p
        elif "4785XXXX" in nodash:
            out["A"] = p
        elif "47852019" in nodash:
            out["B"] = p
    return out


def doc_lines(path):
    import fitz
    d = fitz.open(path)
    pages = [(i + 1, d[i].get_text().split("\n")) for i in range(d.page_count)]
    d.close()
    return pages


def is_toc_entry(lines, i):
    """第 i 行是不是**目录**里的一项？

    目录项的形状是「条款号 + 标题」后面跟着「页码（独占一行）」+「点引线」：
        5.
        1 远光灯
        18
        ………………………………………………
    正文里没有点引线，所以「后面两行是页码+点引线」这个判据很干净。
    """
    nxt = [l.strip() for l in lines[i + 1:i + 3]]
    if len(nxt) < 2:
        return False
    if re.fullmatch(r"\d{1,3}", nxt[0]) and re.match(r"^[….]{6,}", nxt[1]):
        return True
    if re.match(r"^[….]{6,}", nxt[0]):
        return True
    return False


def clause_starts(lines, last=None):
    """在一页的行里找出条款起点。

    返回 [(行号, 条款号, 标题)]。
    碎片拼接：连续的纯数字行（"5." / "9." / "4."）攒起来，
    直到出现「数字+内容」的那一行才成形。
    章节约束：条款号必须与上一个条款**同章**或**章/节推进** ——
    否则正文里的「按4.11要求」「3.15 定义的」会被当成条款开头。
    """
    starts = []
    frag = []          # 攒着的数字碎片
    for i, raw in enumerate(lines):
        s = raw.strip()
        if not s:
            continue
        if TOC.search(s):
            frag = []
            continue
        pm = PURE_NUM.match(s)
        if pm:
            num = pm.group(1)
            if num.count(".") >= 1:
                # 完整条款号（6.14.4.1），标题在后面的行里
                if same_chapter(num, last) and not is_toc_entry(lines, i):
                    starts.append((i, num, ""))
                    last = num
                frag = []
            else:
                frag.append(num + ".")     # 碎片："5." / "9." / "4."
            continue
        hm = NUM_HEAD.match(s)
        if hm:
            num, head = hm.group(1), hm.group(2).strip()
            if num.count(".") >= 1:
                if same_chapter(num, last) and not is_toc_entry(lines, i):
                    starts.append((i, num, head))
                    last = num
                frag = []
            elif frag:
                joined = "".join(frag) + num
                if same_chapter(joined, last) and not is_toc_entry(lines, i):
                    starts.append((i, joined, head))
                    last = joined
                frag = []
            else:
                frag = []      # 列表项（"1 车辆自动挡…"）
            continue
        # 走到这里 = 这一行**既不是纯数字碎片、也不是「数字+空格+标题」**。
        # 碎片链到此为止。
        #
        # 原来只在「这一行不以数字开头」时才断链，于是**以数字开头、但数字后面
        # 没有空格**的正文行被漏了过去 ——「1执行紧急制动信号时不得使用该闪烁方式。」
        # 就是这种。碎片链因此继续攒：上一行的交叉引用碎片「23.」（出自
        # 「按5.23.1执行」）和下一行的真条款碎片「4.」被拼成「23.4.10」，
        # 一个**不存在的条款号**，于是这条真条款被丢掉。
        #
        # 代价是 B（GB 4785-2019）第 4 章的 **4.10–4.31 整段没进条款索引** ——
        # 而 4.9 又被登记为「不在范围」，于是**一般要求整章对覆盖审计隐形**：
        # 电压（4.27）、货车透光面（4.29）、移动部件遮挡 50%（4.21）、
        # 可藏灯（4.14）、光色（4.15）…一条都没被清点过。
        frag = []
    return starts, last


def same_chapter(a, b):
    """这个条款号能不能出现在上一个条款号之后。

    接受：
    - 同章（前两段相同）—— 子条款、兄弟条款都算；
    - 章推进：5.9 → 5.10（第二段 +1）、5.24 → 6.1（第一段 +1，且是二级号）。

    拒绝：
    - 正文里的交叉引用（「按4.11要求」「3.15 定义的基准」）——
      它们既不同章，也不是章推进。
    """
    if not b:
        return True
    pa, pb = a.split("."), b.split(".")
    if len(pa) < 2 or len(pb) < 2:
        return pa[0] == pb[0]
    if pa[0] == pb[0] and pa[1] == pb[1]:
        return True
    try:
        if int(pa[0]) == int(pb[0]) and int(pa[1]) == int(pb[1]) + 1:
            return True                       # 5.8.9 → 5.9.4（节推进）
        # 新章，且**从 .1 开始**：5.24 → 6.1、3.x → 5.1.1（草案第 4 章正文里
        # 没有条款号，章号可以跳）。必须是**更大的章号** —— 否则正文里回指的
        # 「5.1.9.2.1」会被当成新章开头，把后面的条款全带偏。
        if int(pa[0]) > int(pb[0]) and int(pa[1]) == 1:
            return True
    except ValueError:
        pass
    return False


def split_clauses(path):
    """切成 {条款号: {page, head, body}}。

    **正文跨页时要接上** —— 条款号在页尾、正文在次页的情况很常见
    （R48 6.14.5 标题在 p67、正文在 p68；C 6.21.4.3.1 标题在 p79、正文在 p80）。
    早期版本按页切，跨页条款的正文只到本页为止，于是：
    - 覆盖审计看不见那一段的量值 → 报「真漏」；
    - 取值核对报「条款里没有这个值」→ 假阳性。
    所以这里用**全局行流**（页码只是附带信息），条款边界按下一个条款号切。
    """
    out = {}
    last = None
    flat = []
    for pg, lines in doc_lines(path):
        for ln in lines:
            flat.append((pg, ln))
    starts, last = clause_starts([ln for _, ln in flat], last)
    for k, (i, num, head) in enumerate(starts):
        end = starts[k + 1][0] if k + 1 < len(starts) else len(flat)
        body = "\n".join(l.strip() for _, l in flat[i:end] if l.strip())
        body = re.sub(r"\n{2,}", "\n", body)
        pg = flat[i][0]
        if num in out:
            out[num]["body"] += "\n" + body
        else:
            out[num] = {"page": pg, "head": head, "body": body}
    return out


def main():
    docs = pick_docs()
    idx = {v: split_clauses(p) for v, p in docs.items()}
    args = sys.argv[1:]
    if "--clause" in args:
        want = args[args.index("--clause") + 1]
        ver = args[args.index("--ver") + 1] if "--ver" in args else "B"
        c = idx.get(ver, {}).get(want)
        if not c:
            print("没有条款 %s（%s 版）" % (want, ver))
            print("   同前缀：", [k for k in idx.get(ver, {}) if k.startswith(want.rsplit(".", 1)[0])][:16])
            return
        print("【%s %s】%s  (p%d)" % (ver, want, c["head"][:60], c["page"]))
        print("-" * 78)
        print(c["body"][:1800])
        return
    for ver in ("A", "B", "C"):
        if ver in idx:
            print("  %s 版：%d 个条款" % (ver, len(idx[ver])))
        else:
            print("  %s 版：源 PDF 没找到" % ver)


if __name__ == "__main__":
    main()
