# -*- coding: utf-8 -*-
"""条款级清点：把三份标准的正文切成「条款」，并给每个条款列��它写了哪些量值。

为什么要有这个脚本
------------------
现在第 12 章的矩阵是**逐参数手写正则**得到的：199 行 × 3 版 = 552 条正则，
每条正则只负责把**一个数**从**一个版本**里抠出来。后果有三个：

1. **值对了条款可能是错的** —— 正则锚错了条款，数值照样取得到
   （倒车灯作慢行灯取到角灯的 15km/h、低装向下角取到电压条款 4.25）。
2. **一行有两个值就会掉一个** —— `locate()` 只读第 1 个捕获组。
3. **「该版无此规定」是手写的断言** —— 写错了没人拦（已发生两次假断言）。

根源是**工作单位选错了**：应当以**条款**为单位 —— 一个条款里的所有量值
（水平角、垂直角、离地高度、间距…）在原文里是**挨着**的，一次读对就全对；
而以参数为单位，就要把同一个条款**读 N 遍**，N 遍都可能读错。

这个脚本先把三份标准切成条款（条款号 + 标题 + 正文 + 所属灯具 + 页码），
再按条款列出量值。条款号相同的两个版本可以直接对比 ——
这才是「同一语义位置」的可比口径。

用法
----
    python scripts/clause_inventory.py                 # 统计概览
    python scripts/clause_inventory.py --list A        # 列出 A 的条款
    python scripts/clause_inventory.py --clause 6.7.4.2.1 --ver C   # 看某条款的全部量值
"""
import io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CORP = os.path.join(ROOT, "dist", "mineru-v4-data.json")

# 条款号：6.9.5.1. / 5.11.5 / 4.26 —— 至少两段。
# 行首允许一个竖线：R48 的条款表是 markdown 表格行（`| 6.14.2. | Number Two,…`），
# 不放过竖线就整张 §6.14 的条款都进不了索引。
CLAUSE_HEAD = re.compile(r"^\|?\s*(\d+(?:\.\d+)+)\.?(?=\s|[^\d.]|$)")

# 目录行：「- 5.9 前位灯.... 40」「5.19 昼间行驶灯(符合GB23255要求的灯具).... 47」
TOC_LINE = re.compile(r"\.{3,}\s*\d+\s*$")


def load_corpus():
    return json.load(io.open(CORP, encoding="utf-8"))


def pages(corpus, ver):
    ft = corpus[ver]["fullText"]
    parts = re.split(r"\[第(\d+)页\]", ft)
    return [(int(parts[i]), parts[i + 1]) for i in range(1, len(parts), 2)]


def is_toc_line(line):
    """目录行：含「….页码」，或是表格里的条款标签行。"""
    return bool(TOC_LINE.search(line))


def split_clauses(corpus, ver):
    """把一版切成条款：{clause: {page, head, body, device?}}"""
    out = {}
    for pg, text in pages(corpus, ver):
        # 先按行切开，剔除目录行
        lines = text.split("\n")
        kept = []
        for ln in lines:
            s = ln.strip()
            if not s:
                continue
            if is_toc_line(s):
                continue
            kept.append((ln, s))
        # 逐行找条款起始
        starts = []
        for i, (raw, s) in enumerate(kept):
            m = CLAUSE_HEAD.match(s)
            if not m:
                continue
            num = m.group(1)
            # 条款号后面必须紧跟标题/正文，而不是小数或句号连写
            if num.count(".") == 0:
                continue
            starts.append((i, num, s[m.end():].strip()))
        for k, (i, num, head) in enumerate(starts):
            end = starts[k + 1][0] if k + 1 < len(starts) else len(kept)
            body = "\n".join(r for r, _ in kept[i:end])
            # 同一条款号在多处出现（R48 页边栏、表格行）——保留第一次，后面的并进来
            if num in out:
                out[num]["body"] += "\n" + body
            else:
                out[num] = {"page": pg, "head": head, "body": body, "ver": ver}
    return out


# ── 章节 → 灯具 ───────────────────────────────────────────────────────────
# A 取目录（正文无章号），B/C 取正文标题。
CHAPTER_DEVICE = {
    "A": {
        "5.1": "远光灯", "5.2": "近光灯", "5.3": "自适应前照灯", "5.4": "前雾灯",
        "5.5": "角灯", "5.6": "转向信号灯", "5.7": "制动灯", "5.8": "牌照灯",
        "5.9": "前位灯", "5.10": "后位灯", "5.11": "后雾灯", "5.12": "驻车灯",
        "5.13": "示廓灯", "5.14": "非三角形后回复反射器", "5.15": "三角形后回复反射器",
        "5.16": "非三角形前回复反射器", "5.17": "非三角形侧回复反射器",
        "5.18": "侧标志灯", "5.19": "昼间行驶灯", "5.20": "醒目标志",
        "5.21": "倒车灯", "5.22": "慢行灯", "5.23": "牵引杆挂车标志灯",
        "5.24": "ADS 标志灯", "6.1": "驾驶员辅助投射", "6.2": "光信号投射",
        "6.3": "图文交互", "6.4": "发光徽标", "7.1": "危险警告信号",
        "7.2": "紧急制动信号", "7.3": "追尾警告信号",
    },
    "B": {
        "5.1": "远光灯", "5.2": "近光灯", "5.3": "前雾灯", "5.4": "倒车灯",
        "5.5": "转向信号灯", "5.6": "危险警告信号", "5.7": "制动灯", "5.8": "牌照灯",
        "5.9": "前位灯", "5.10": "后位灯", "5.11": "后雾灯", "5.12": "驻车灯",
        "5.13": "示廓灯", "5.14": "非三角形后回复反射器", "5.15": "三角形后回复反射器",
        "5.16": "非三角形前回复反射器", "5.17": "非三角形侧回复反射器",
        "5.18": "侧标志灯", "5.19": "昼间行驶灯", "5.20": "角灯", "5.21": "醒目标志",
        "5.22": "自适应前照明系统(AFS)", "5.23": "紧急制动信号",
        "5.24": "牵引杆挂车标志灯", "5.25": "慢行灯", "5.26": "追尾警告信号",
    },
    "C": {
        "6.1": "远光灯", "6.2": "近光灯", "6.3": "前雾灯", "6.4": "倒车灯",
        "6.5": "转向信号灯", "6.6": "危险警告信号", "6.7": "制动灯",
        "6.8": "后牌照板照明装置", "6.9": "前位灯", "6.10": "后位灯",
        "6.11": "后雾灯", "6.12": "驻车灯", "6.13": "示廓灯",
        "6.14": "非三角形后回复反射器", "6.15": "三角形后回复反射器",
        "6.16": "非三角形前回复反射器", "6.17": "非三角形侧回复反射器",
        "6.18": "侧标志灯", "6.19": "昼间行驶灯", "6.20": "角灯",
        "6.21": "醒目标志", "6.22": "自适应前照明系统(AFS)",
        "6.23": "紧急制动信号", "6.24": "礼貌灯", "6.26": "操纵灯",
        "6.27": "应答信号",
    },
}


def device_of(ver, clause):
    parts = clause.split(".")
    for n in (2, 3):
        if len(parts) >= n:
            key = ".".join(parts[:n])
            d = CHAPTER_DEVICE.get(ver, {}).get(key)
            if d:
                return d
    return ""


# ── 量值识别 ─────────────────────────────────────────────────────────────
# 前置断言只用 `[\d.]`：**不能写 `\w`** —— Python 的 `\w` 匹配汉字，
# 于是「不小于350㎜」里的 350 前面是「于」，整条被否掉，
# A 版条款会显示成「没有量值」（GB 2019 因为数字前面是空格，反而能找到）。
NUM = re.compile(r"(?<![\d.])(\d+(?:[ ,]\d{3})*(?:\.\d+)?)\s*(mm|㎜|cm|cd|Hz|km\s*/\s*h|°|%|V|W|Nm|cd/m²)?", re.I)

# 明显不是量值的：条款号、车型编号（5类、N3G）、年份
SKIP = re.compile(r"^\d+\.\d+")

LA = re.compile(r"\$[^$]*\$|<[^>]*>")


def values_in(body):
    """列出条款正文里的量值：[(值, 单位, 前后文)]"""
    clean = LA.sub(" ", body)
    clean = re.sub(r"[_\^{}]", " ", clean)
    out = []
    for m in NUM.finditer(clean):
        raw = m.group(1)
        unit = (m.group(2) or "").strip()
        try:
            val = float(raw.replace(",", "").replace(" ", ""))
        except ValueError:
            continue
        if SKIP.match(raw) and "." in raw:
            continue
        ctx = clean[max(0, m.start() - 70):m.end() + 40].replace("\n", " ")
        out.append((raw, unit, re.sub(r"\s+", " ", ctx)))
    return out


def main():
    corpus = load_corpus()
    args = sys.argv[1:]
    if "--clause" in args:
        i = args.index("--clause")
        want = args[i + 1]
        ver = args[args.index("--ver") + 1] if "--ver" in args else "C"
        cls = split_clauses(corpus, ver)
        c = cls.get(want)
        if not c:
            print("没有条款 %s（%s 版）" % (want, ver))
            print("同前缀的条款：", [k for k in cls if k.startswith(want.rsplit(".", 1)[0])][:20])
            return
        print("【%s %s】%s  (p%d, %s)" % (ver, want, c["head"][:60], c["page"], device_of(ver, want)))
        print("-" * 78)
        body = re.sub(r"\n+", "\n", c["body"]).strip()
        print(body[:2500])
        print("-" * 78)
        print("量值：")
        for v, u, ctx in values_in(c["body"]):
            print("   %-10s %-8s … %s" % (v, u, ctx[-95:]))
        return

    print("条款清点")
    for ver in ("A", "B", "C"):
        cls = split_clauses(corpus, ver)
        withval = [k for k, c in cls.items() if values_in(c["body"])]
        print("  %s 版：%d 个条款，其中 %d 个含量值" % (ver, len(cls), len(withval)))


if __name__ == "__main__":
    main()
