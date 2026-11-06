#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""源码里的「标准特定字面量」台账 —— 换一套标准时**必须改**的那些地方。

## 这个脚本回答什么

> 源码里有哪些地方**写死了「本标准集的名字」**？换标准时逐条该怎么改？

它把三件事合成一件：

1. **量** —— 扫出所有硬编码点，按性质分类（注释 / 文案 / 判据 / 标识符）；
2. **管** —— 每一片源码都得在台账里**登记一条规则**，写清「为什么在这儿」「换标准时改成什么」；
3. **列** —— 把台账 + 扫描结果合成一张**可执行的换标准清单**。

## 为什么必须「登记」，而不是「扫出来就算」

因为**清单会骗人**。

一份扫出来的原始清单只有「第 37 行有个 GB 4785」，没告诉人
**那是什么、为什么在那儿、换标准时该改成什么**。
而真正会出事的地方是**漏项** —— 清单上没写的地方，人就不会去看。

所以这里的规矩是：**没登记的硬编码 = 闸门红**。
新写进去一句带标准名的话，必须同时登记它是什么。

## 性质怎么分 —— 为什么这么分

| 类别 | 换标准后不换会怎样 |
|---|---|
| `注释` | 没事（只是过时） |
| `文案` | **静默说错** —— 读者以为那是新标准的规定 |
| `判据` | **响亮失败** —— 认不出新标准的文件 |
| `标识符` | 响亮失败或无害 |

**判据错了会响，文案错了只会骗人。**
所以「文案」是重点盯的，「判据」可以稍宽 —— 宁可多盯。

## 用法

----
    python scripts/hardcode_ledger.py                 # 报告（覆盖率 + 分类统计）
    python scripts/hardcode_ledger.py --verify        # 闸门：未登记 / 规则失效 → exit 1
    python scripts/hardcode_ledger.py --checklist     # 生成「换标准操作清单」（markdown）
    python scripts/hardcode_ledger.py --checklist --out reports/xxx.md
"""
import io
import json
import os
import re
import subprocess
import sys
import tokenize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEDGER = os.path.join(ROOT, "data", "hardcode-ledger.json")

SCAN_DIRS = ["server", "client/src", "shared", "python_service", "scripts", "tools"]
ROOT_PY = [
    "verify_claims.py", "extract_mineru_v4_sdk.py", "audit.py", "audit_pages.py",
    "audit2.py", "extract_pymupdf.py", "extract_v5.py", "extract_toc_pages.py",
    "ocr_full.py", "render_gate.py", "set_pdf_meta.py", "stamp_bookmarks.py",
]

# 与 scripts/hardcode_scan.mjs **必须一致**（那边扫 JS/TS，这边扫 Python）。
#
# 分隔符允许「反斜杠转义 / 字符类 / 量词」夹在标准名的各部分之间 ——
# 因为判据往往把标准名拆进正则里（`GB[\s_-]*4785`、`UN[\s_-]*R0?48`），
# 只按字面找会**整类漏掉**，而那恰恰是「换标准后认不出新文件」的那一类。
SEP = r"(?:\\[a-zA-Z]|\[[^\]]*\]|0\??|[\s_\-—–*+?])*"
TOKEN_RE = re.compile(
    r"GB" + SEP + r"4785" + SEP + r"(?:[-—–]" + SEP + r"2019)?(?![\d.])"
    r"|UN" + SEP + r"R" + SEP + r"0?48(?![\d])"
    r"|ECE" + SEP + r"R" + SEP + r"0?48(?![\d])"
    r"|V" + SEP + r"4" + SEP + r"3" + SEP + r"5(?![\d])")

# 「正则的味道」。判据宁可多判，文案不许漏判 —— 所以长散文一律算文案。
REGEX_SMELL = re.compile(r"\\|\(\?[=!<]|\{\d|[\^$]")


def class_of(txt):
    if txt.startswith("GB"):
        return "gb4785-2019" if "2019" in txt else "gb4785"
    if txt.startswith("UN"):
        return "un-r48"
    if txt.startswith("ECE"):
        return "ece-r48"
    return "v4-3-5"


# ---------------------------------------------------------------- Python 侧

def _py_regions(text):
    """把一个 .py 文件切成 (start, end, kind, text) 区域。

    kind: comment（含 docstring） / string / code

    **docstring 必须算注释** —— 它是给人看的说明，不是会打印出来的文案。
    判据：它是某个逻辑行的**第一个有效 token**。
    """
    regions = []
    lines = text.splitlines(True)
    offsets = []
    acc = 0
    for ln in lines:
        offsets.append(acc)
        acc += len(ln)

    def off(row, col):
        return offsets[row - 1] + col if 0 < row <= len(offsets) else 0

    prev = None
    try:
        toks = list(tokenize.generate_tokens(io.StringIO(text).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return regions

    for t in toks:
        if t.type == tokenize.NEWLINE:
            prev = None
            continue
        if t.type in (tokenize.NL, tokenize.INDENT, tokenize.DEDENT):
            continue
        if t.type == tokenize.COMMENT:
            s, e = off(t.start[0], t.start[1]), off(t.end[0], t.end[1])
            regions.append((s, e, "comment", t.string))
            continue
        if t.type == tokenize.STRING:
            s, e = off(t.start[0], t.start[1]), off(t.end[0], t.end[1])
            if prev is None:
                # 逻辑行的第一个有效 token 是字符串 → docstring
                regions.append((s, e, "comment", t.string))
            else:
                regions.append((s, e, "string", t.string))
            prev = t.type
            continue
        if getattr(tokenize, "FSTRING_START", None) is not None and t.type in (
            getattr(tokenize, "FSTRING_START"), getattr(tokenize, "FSTRING_MIDDLE"),
            getattr(tokenize, "FSTRING_END")):
            s, e = off(t.start[0], t.start[1]), off(t.end[0], t.end[1])
            regions.append((s, e, "string", t.string))
            prev = t.type
            continue
        prev = t.type
    return regions


def _sub_of(kind, raw):
    if kind == "comment":
        return "注释"
    body = raw or ""
    if len(body) >= 3 and body[:3] in ('"""', "'''"):
        body = body[3:-3]
    elif len(body) >= 2 and body[0] in "\"'":
        body = body[1:-1]
    # 长散文与提示词不是判据 —— 把它们误判成「判据」等于从重点里拿掉，
    # 那是危险的那一侧。
    if len(body) > 200:
        return "文案"
    return "判据" if REGEX_SMELL.search(body) else "文案"


def scan_py(rel):
    text = io.open(os.path.join(ROOT, rel), encoding="utf-8").read()
    regions = _py_regions(text)
    regions.sort()
    lines = text.splitlines()
    out = []

    def region_of(pos):
        for s, e, kind, raw in regions:
            if s <= pos < e:
                return (s, e, kind, raw)
            if s > pos:
                break
        return None

    seen = set()
    for m in TOKEN_RE.finditer(text):
        reg = region_of(m.start())
        if reg:
            s, e, kind, raw = reg
            if s in seen:
                continue
            seen.add(s)
            line = text.count("\n", 0, s) + 1
            out.append({
                "file": rel, "line": line, "col": 1,
                "cls": [class_of(m.group(0))],
                "kind": "comment" if kind == "comment" else "string",
                "sub": _sub_of(kind, raw),
                "text": raw,
                "excerpt": (lines[line - 1] if 0 < line <= len(lines) else "").strip(),
            })
        else:
            line = text.count("\n", 0, m.start()) + 1
            out.append({
                "file": rel, "line": line, "col": m.start() - (text.rfind("\n", 0, m.start()) + 1) + 1,
                "cls": [class_of(m.group(0))],
                "kind": "code", "sub": "标识符", "text": None,
                "excerpt": (lines[line - 1] if 0 < line <= len(lines) else "").strip(),
            })
    return out


def collect_py_files():
    out = []
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames
                           if x not in ("node_modules", "dist", "__pycache__") and not x.startswith(".")]
            for fn in filenames:
                if fn.endswith(".py"):
                    out.append(os.path.relpath(os.path.join(dirpath, fn), ROOT).replace("\\", "/"))
    for f in ROOT_PY:
        if os.path.exists(os.path.join(ROOT, f)):
            out.append(f)
    return sorted(set(out))


# ---------------------------------------------------------------- 合并

def scan_all():
    recs = []
    # JS/TS 侧交给 Node（那边有 TypeScript 的词法器，能精确切出注释与字面量）
    js = subprocess.run(
        ["node", os.path.join("scripts", "hardcode_scan.mjs")],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
    if js.returncode != 0:
        raise SystemExit("hardcode_scan.mjs 跑失败：\n" + (js.stderr or "")[-2000:])
    recs.extend(json.loads(js.stdout))
    for f in collect_py_files():
        recs.extend(scan_py(f))
    return recs


def load_rules():
    if not os.path.exists(LEDGER):
        return []
    return json.load(io.open(LEDGER, encoding="utf-8")).get("rules", [])


def load_data_packs():
    """标准专属的**数据文件**。

    这些文件不会被扫（它们**本来就是声明**），但换标准时同样要动 ——
    而且「要动」的方式跟源码不一样：源码是**改**，数据文件多半是**重做**。
    漏掉它们的后果跟漏掉源码一样：清单上没有的事，人就不会去做。
    """
    if not os.path.exists(LEDGER):
        return []
    return json.load(io.open(LEDGER, encoding="utf-8")).get("dataPacks", [])


def covers(rule, rec):
    files = rule.get("files") or []
    if rec["file"] not in files:
        return False
    subs = rule.get("sub")
    if subs and rec["sub"] not in (subs if isinstance(subs, list) else [subs]):
        return False
    cls = rule.get("cls")
    if cls and not (set(cls) & set(rec.get("cls") or [])):
        return False
    return True


def analyse():
    recs = scan_all()
    rules = load_rules()
    live = [r for r in recs if r["sub"] != "注释"]
    uncovered = [r for r in live if not any(covers(rule, r) for rule in rules)]
    used = []
    for rule in rules:
        n = sum(1 for r in live if covers(rule, r))
        used.append((rule, n))
    return recs, rules, live, uncovered, used


# ---------------------------------------------------------------- 输出

def print_report(recs, rules, live, uncovered, used):
    by = {}
    for r in live:
        by.setdefault(r["sub"], 0)
        by[r["sub"]] += 1
    print("源码里的标准特定硬编码：%d 处（另有注释 %d 处，不计入）"
          % (len(live), len(recs) - len(live)))
    for k in ("文案", "判据", "标识符"):
        print("  %-4s %3d 处   ← %s" % (
            k, by.get(k, 0),
            "换标准后不换就**静默说错**" if k == "文案" else
            ("换标准后不换就**认不出文件**（会响）" if k == "判据" else "名字，一般无害")))
    print("-" * 88)
    print("台账规则 %d 条；未被任何规则覆盖的硬编码：%d 处" % (len(rules), len(uncovered)))
    for rule, n in used:
        mark = "✓" if n else "✗ 已失效"
        print("  %s %-28s %3d 处   %s" % (mark, rule.get("id", "?"), n, rule.get("why", "")[:48]))
    if uncovered:
        print("-" * 88)
        for r in uncovered:
            print("  · %s:%d  [%s] %s" % (r["file"], r["line"], r["sub"], _context(r, 80)))


def _context(r, width=110):
    """清单里那一行的显示文本 —— **命中处前后**的上下文。

    早先显示的是字面量的开头，于是多行模板字面量里的标准名
    （往往在几十行之后）指不到 —— 打开那一行**看不见任何标准名**。
    """
    text = r.get("text") or ""
    off = int(r.get("offset") or 0)
    if not text:
        return (r.get("excerpt") or "")[:width]
    if 0 < off < len(text):
        start = max(0, off - width // 2)
        frag = text[start : off + width // 2]
        if start > 0:
            frag = "…" + frag
        if off + width // 2 < len(text):
            frag = frag + "…"
    else:
        frag = text[:width]
    frag = frag.replace("\n", "\\n").replace("\r", "").strip()
    return frag


def build_checklist(recs, rules, live, packs):
    out = []
    out.append("# 换标准操作清单（**机器生成**，别手改）\n")
    out.append("> 由 `python scripts/hardcode_ledger.py --checklist` 生成。")
    out.append("> 数据源：源码实测 + `data/hardcode-ledger.json` 的规则。")
    out.append("> 换了标准后重跑一次这个脚本，清单会自己更新。\n")
    order = {"文案": 0, "判据": 1, "标识符": 2}
    grouped = {}
    for rule in rules:
        hits = [r for r in live if covers(rule, r)]
        if not hits:
            continue
        grouped.setdefault(rule.get("id", "?"), (rule, hits))
    for rid, (rule, hits) in grouped.items():
        out.append("## %s — %s" % (rid, rule.get("title", rule.get("why", "")[:40])))
        out.append("")
        out.append("- **为什么在这儿**：%s" % rule.get("why", "（没写 —— 这是台账的缺口）"))
        out.append("- **换标准时怎么改**：%s" % rule.get("swap", "（没写 —— 这是台账的缺口）"))
        hits = sorted(hits, key=lambda r: (order.get(r["sub"], 9), r["file"], r["line"]))
        out.append("- **共 %d 处**：" % len(hits))
        for r in hits:
            # 显示**命中处前后**的上下文，而不是字面量的开头 ——
            # 多行字面量的开头往往离标准名很远，指过去看不见东西可改。
            t = _context(r)
            out.append("  - `%s:%d` **[%s]** %s" % (r["file"], r["line"], r["sub"], t))
        out.append("")
    if packs:
        out.append("---\n")
        out.append("# 数据文件（**重做**，不是改）\n")
        out.append("> 这些文件不会被扫 —— 它们**本来就是声明**。")
        out.append("> 但换标准时同样要动：漏掉的后果与漏掉源码一样。\n")
        for p in packs:
            out.append("## %s — %s" % (p.get("id", "?"), p.get("title", "")))
            out.append("")
            out.append("- **是什么**：%s" % p.get("why", ""))
            out.append("- **换标准时怎么改**：%s" % p.get("swap", ""))
            out.append("- **文件**：")
            for f in p.get("files", []):
                out.append("  - `%s`" % f)
            out.append("")
    return "\n".join(out)


def main():
    recs, rules, live, uncovered, used = analyse()
    packs = load_data_packs()
    args = set(sys.argv[1:])

    if "--checklist" in args:
        md = build_checklist(recs, rules, live, packs)
        if "--out" in args:
            i = sys.argv.index("--out")
            path = sys.argv[i + 1] if i + 1 < len(sys.argv) else "reports/swap-standard-checklist.md"
            full = path if os.path.isabs(path) else os.path.join(ROOT, path)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            io.open(full, "w", encoding="utf-8").write(md)
            print("清单已写到 %s（%d 处硬编码 · %d 组数据文件）" % (path, len(live), len(packs)))
        else:
            print(md)
        return 0

    print_report(recs, rules, live, uncovered, used)

    if "--verify" not in args:
        return 0

    problems = []
    # ① 未登记的硬编码 —— 清单上没写的地方，人就不会去看
    if uncovered:
        problems.append(
            "源码里有 %d 处标准名硬编码**没有登记**（清单上不会有它们，换标准时就会漏）：\n    %s"
            % (len(uncovered),
               "\n    ".join("%s:%d [%s] %s" % (r["file"], r["line"], r["sub"], (r["text"] or r["excerpt"])[:60])
                            for r in uncovered[:20])))
    # ② 规则失效 —— 台账里的这一项已经不存在了，清单会骗人
    for rule, n in used:
        if n == 0:
            problems.append("台账规则「%s」已经没有对应的代码了 —— 清单里的这一项是假的，删掉它"
                            % rule.get("id"))
        if not (rule.get("why") or "").strip():
            problems.append("台账规则「%s」没写 why —— 换标准时的人不知道这是干什么的" % rule.get("id"))
        if not (rule.get("swap") or "").strip():
            problems.append("台账规则「%s」没写 swap —— 换标准时的人不知道该改成什么" % rule.get("id"))
    # ③ 数据文件清单里提到的文件必须真的在
    for p in packs:
        for f in p.get("files", []):
            if not os.path.exists(os.path.join(ROOT, f)):
                problems.append("台账的数据文件清单「%s」里列的 `%s` **不存在** —— "
                                "清单会骗人（要么补上文件，要么删掉这一行）" % (p.get("id"), f))
        if not (p.get("why") or "").strip() or not (p.get("swap") or "").strip():
            problems.append("台账的数据包「%s」没写 why/swap" % p.get("id"))

    if problems:
        print()
        for p in problems:
            print("  ✗ " + p)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
