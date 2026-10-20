# -*- coding: utf-8 -*-
"""条款级清点 —— **以源 PDF 的文本层为准**，MinerU 只作兜底。

为什么换底本
------------
MinerU 的表格抽取把 R48 的条款表整行揉坏：

    | 6.14.4.6.14.4.1. | Position In width: …      ← 真实条款是 6.14.4.1
    | 6.14.4.3.6.14.5. | In length: … 30° inwards   ← 真实条款是 6.14.4.3 和 6.14.5
    | 6.14.6.14.1.     | …end-outline marker lamp… ← 真实条款是 6.13.9

**下一行的标签被并进了上一行的标签**。而 `data/parameter-specs.json` 里的
552 条正则，有一批正是照着这个揉坏的文本写的 —— 每写一条就多一个「绕开揉坏」的
特例，也就多一个出错的机会（已经出了两次：条款号取到别的条款、整行取值丢掉一个）。

源 PDF 的文本层是干净的（PyMuPDF 逐字取出，只在行尾断行）：

    6.14.3. | Arrangement | No special requirement.
    6.14.4. | Position
    6.14.4.1. | In width: that point on the illuminating surface … shall not be more than 400 mm …

条款号、层级、顺序全对。**所以条款索引必须建在源 PDF 上**：
- 条款号可靠 → 条款归属不会再「就近取错」；
- 数字没有 LaTeX 化 → 捕获组不用再绕 `${ 4 5 } ^ { \circ }$`；
- 一个条款的正文完整 → 一次读对，条款里所有量值都对。

用法
----
    python scripts/clause_index_src.py                  # 三版条款清点
    python scripts/clause_index_src.py --clause 6.14.4.1 --ver C
"""
import io, json, os, re, sys, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOCS = os.path.join(ROOT, "uploaded-docs")

# 条款号：行首（允许表格竖线），至少两段
CLAUSE_HEAD = re.compile(r"^\|?\s*(\d+(?:\.\d+)+)\.?(?=\s|[^\d.]|$)")
# 目录行：「- 5.9 前位灯.... 40」
TOC_LINE = re.compile(r"\.{3,}\s*\d+\s*$")


def pick_docs():
    """按封面内容认版本。

    - A 草案：封面写「GB 4785—XXXX」
    - B 2019：封面写「GB4785—2019」（**没有空格** —— 草案那份有空格：GB 4785—XXXX）
    - C R48：封面是「Agreement … United Nations Regulations」

    注意：不能靠「含 UN R48 字样」判断 —— GB 两版的规范性引用文件里都写着
    UN R37/R48，会把中国标准认成 R48。
    """
    out = {}
    for p in sorted(glob.glob(os.path.join(DOCS, "*.pdf"))):
        try:
            import fitz
            d = fitz.open(p)
            head = "".join(d[i].get_text() for i in range(min(3, d.page_count)))
            d.close()
        except Exception:
            continue
        flat = re.sub(r"\s+", "", head)
        # 破折号有三种写法（— U+2014 / – U+2013 / -），先把所有破折号去掉再比
        nodash = re.sub(r"[—–‐‑‒−-]", "", flat)
        if "UnitedNationsRegulations" in nodash or "AgreementConcerning" in nodash:
            out["C"] = p
        elif "4785XXXX" in nodash:
            out["A"] = p          # 草案封面也写着「代替 GB 4785-2019」，所以 XXXX 要先判
        elif "47852019" in nodash:
            out["B"] = p
    return out


def doc_pages(path):
    """逐页取文本，**去掉换行**。

    为什么去换行：GB 4785-2019 的 PDF 文本层把条款号拆成几行 ——
    「5.」/「9.」/「4.」/「1 横向:…」各占一行，PyMuPDF 原样吐出来。
    去掉换行才拼回「5.9.4.1 横向:…」。抽取器（parameterMatrix.ts）也是这么做的。
    """
    import fitz
    d = fitz.open(path)
    pages = [(i + 1, d[i].get_text().replace("\n", "")) for i in range(d.page_count)]
    d.close()
    return pages


# 平铺文本里的条款号候选：数字.数字(.数字)* 后跟一个空格
CLAUSE_FLAT = re.compile(r"(?<![\d.])(\d+(?:\.\d+)+)\.?(?=\s)")


def split_clauses(pages):
    """把平铺文本切成条款：{clause: {page, head, body}}。

    目录行要剔掉：「5.9 前位灯33…………」这种带点引线的不是条款。
    """
    out = {}
    for pg, text in pages:
        starts = []
        for m in CLAUSE_FLAT.finditer(text):
            num = m.group(1)
            if num.count(".") == 0:
                continue
            after = text[m.end():m.end() + 60]
            if "……" in after or "···" in after:
                continue  # 目录行
            starts.append((m.start(), m.end(), num, after))
        for k, (s0, e0, num, after) in enumerate(starts):
            end = starts[k + 1][0] if k + 1 < len(starts) else len(text)
            body = text[e0:end].strip()
            head = after[:40].strip()
            if num in out:
                out[num]["body"] += "\n" + body
            else:
                out[num] = {"page": pg, "head": head, "body": body}
    return out


# ── 章节 → 灯具 ───────────────────────────────────────────────────────────
CHAPTER_DEVICE = {
    "A": {"5.1": "远光灯", "5.2": "近光灯", "5.3": "自适应前照灯", "5.4": "前雾灯",
          "5.5": "角灯", "5.6": "转向信号灯", "5.7": "制动灯", "5.8": "牌照灯",
          "5.9": "前位灯", "5.10": "后位灯", "5.11": "后雾灯", "5.12": "驻车灯",
          "5.13": "示廓灯", "5.14": "非三角形后回复反射器", "5.15": "三角形后回复反射器",
          "5.16": "非三角形前回复反射器", "5.17": "非三角形侧回复反射器",
          "5.18": "侧标志灯", "5.19": "昼间行驶灯", "5.20": "醒目标志",
          "5.21": "倒车灯", "5.22": "慢行灯", "5.23": "牵引杆挂车标志灯",
          "5.24": "ADS 标志灯", "6.1": "驾驶员辅助投射", "6.2": "光信号投射",
          "6.3": "图文交互", "6.4": "发光徽标", "7.1": "危险警告信号",
          "7.2": "紧急制动信号", "7.3": "追尾警告信号"},
    "B": {"5.1": "远光灯", "5.2": "近光灯", "5.3": "前雾灯", "5.4": "倒车灯",
          "5.5": "转向信号灯", "5.6": "危险警告信号", "5.7": "制动灯", "5.8": "牌照灯",
          "5.9": "前位灯", "5.10": "后位灯", "5.11": "后雾灯", "5.12": "驻车灯",
          "5.13": "示廓灯", "5.14": "非三角形后回复反射器", "5.15": "三角形后回复反射器",
          "5.16": "非三角形前回复反射器", "5.17": "非三角形侧回复反射器",
          "5.18": "侧标志灯", "5.19": "昼间行驶灯", "5.20": "角灯", "5.21": "醒目标志",
          "5.22": "自适应前照明系统(AFS)", "5.23": "紧急制动信号",
          "5.24": "牵引杆挂车标志灯", "5.25": "慢行灯", "5.26": "追尾警告信号"},
    "C": {"6.1": "远光灯", "6.2": "近光灯", "6.3": "前雾灯", "6.4": "倒车灯",
          "6.5": "转向信号灯", "6.6": "危险警告信号", "6.7": "制动灯",
          "6.8": "后牌照板照明装置", "6.9": "前位灯", "6.10": "后位灯",
          "6.11": "后雾灯", "6.12": "驻车灯", "6.13": "示廓灯",
          "6.14": "非三角形后回复反射器", "6.15": "三角形后回复反射器",
          "6.16": "非三角形前回复反射器", "6.17": "非三角形侧回复反射器",
          "6.18": "侧标志灯", "6.19": "昼间行驶灯", "6.20": "角灯",
          "6.21": "醒目标志", "6.22": "自适应前照明系统(AFS)",
          "6.23": "紧急制动信号", "6.24": "礼貌灯", "6.26": "操纵灯",
          "6.27": "应答信号"},
}


def device_of(ver, clause):
    parts = clause.split(".")
    for n in (2, 3):
        if len(parts) >= n:
            d = CHAPTER_DEVICE.get(ver, {}).get(".".join(parts[:n]))
            if d:
                return d
    return ""


NUM = re.compile(r"(?<![\d.])(\d+(?:[ ,]\d{3})*(?:\.\d+)?)\s*(mm|㎜|cm|cd|Hz|km\s*/\s*h|°|%|V|W|Nm)?", re.I)
LA = re.compile(r"\$[^$]*\$|<[^>]*>")


def values_in(body):
    clean = LA.sub(" ", body)
    clean = re.sub(r"[_\^{}]", " ", clean)
    out = []
    for m in NUM.finditer(clean):
        raw, unit = m.group(1), (m.group(2) or "").strip()
        try:
            float(raw.replace(",", "").replace(" ", ""))
        except ValueError:
            continue
        if "." in raw and re.match(r"^\d+\.\d+", raw):
            continue
        ctx = re.sub(r"\s+", " ", clean[max(0, m.start() - 70):m.end() + 40])
        out.append((raw, unit, ctx))
    return out


def build():
    docs = pick_docs()
    idx = {}
    for ver, path in docs.items():
        idx[ver] = split_clauses(doc_pages(path))
    return idx


def main():
    idx = build()
    args = sys.argv[1:]
    if "--clause" in args:
        want = args[args.index("--clause") + 1]
        ver = args[args.index("--ver") + 1] if "--ver" in args else "C"
        c = idx.get(ver, {}).get(want)
        if not c:
            print("没有条款 %s（%s 版）" % (want, ver))
            return
        print("【%s %s】%s  (p%d, %s)" % (ver, want, c["head"][:70], c["page"], device_of(ver, want)))
        print("-" * 78)
        print(re.sub(r"\n{2,}", "\n", c["body"]).strip()[:2200])
        print("-" * 78)
        for v, u, ctx in values_in(c["body"]):
            print("   %-10s %-8s … %s" % (v, u, ctx[-95:]))
        return

    print("源 PDF 条款清点")
    for ver in ("A", "B", "C"):
        if ver not in idx:
            print("  %s 版：源 PDF 没找到" % ver)
            continue
        cls = idx[ver]
        wv = [k for k, c in cls.items() if values_in(c["body"])]
        print("  %s 版：%d 个条款，其中 %d 个含量值" % (ver, len(cls), len(wv)))


if __name__ == "__main__":
    main()
