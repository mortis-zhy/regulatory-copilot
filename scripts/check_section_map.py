#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对「章节 → 灯」映射表与语料**对不对得上**。

## 为什么要有这一关

`R48_SECTIONS`（scripts/propose_parameters_c.py）是手写的 25 行表。
手写的东西会错，而且**错了不报错** —— 本表曾把 6.14 标成
「Direction-indicator position」，而 6.14 实为 Rear retro-reflector，
于是所有「侧转向灯」行都被派到回复反射器的条款里，
候选句**全是错的**，而表本身看着完全正常。

换标准时更糟：这张表不跟着语料走，于是**候选池整体错位**，
而 pipeline 一声不吭。

## 这一关做什么

**自动核对，不自动替换。**

表里每一条的英文名，都去**语料里那��章自己的标题**对一次：
- 对得上 → ✓
- 对不上 → ✗ **报错退出**（这就是要抓的那类错）
- 语料里取不到 → 「取不到，需人工核」（**不装作通过了**）

自动生成整张表**做不到**：表里有人的判断
（例如 6.21 Conspicuity markings 对应的是 GB 的「醒目标志」而不是按编号对齐的 5.21），
推不出来就不该推 —— 「宁可空着，不可错着」。

所以这一关的定位是：**手写表必须与语料对账**，
换标准时它会告诉你哪几行该改，而不是让你自己发现整张表已经错位。

用法：
    python scripts/check_section_map.py          # 核对；有不一致就 exit 1
    python scripts/check_section_map.py --report # 只打印，退出码恒为 0
"""
import importlib.util
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MINERU = os.path.join(ROOT, "dist", "mineru-v4-data.json")

# 章节标题后面常跟的正文开头（用来切「标题 / 正文」）。
SENTENCE_OPENERS = (
    "Where", "As specified", "Presence", "Number", "Arrangement", "Position",
    "General", "Optional", "Mandatory", "Every", "The ", "For ", "This ", "Any ",
    "It ", "Vehicles", "Installed", "Height", "Angle", "Luminous", "Photometric",
    "Colour", "Color", "Function", "Requirements", "Remarks", "Note", "If ",
    "When", "Each", "One", "Two", "Reserved", "Introduction", "Scope",
    "Definitions", "In ", "Shall", "May", "Reference", "These", "Such",
)


def load_sections():
    """读出手写表（唯一手写处）。"""
    spec = importlib.util.spec_from_file_location(
        "pc", os.path.join(ROOT, "scripts", "propose_parameters_c.py"))
    pc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pc)
    return pc.R48_SECTIONS


def extract_chapter_titles(text):
    """从语料里取出每章自己的标题 → {章节号: 标题}。

    三种形态（都是 MinerU 在 R48 ���上真实出现过的）：
      A. `6.4. Reversing lamp`                          —— 独占一行
      B. `6.22. Adaptive front lighting system (AFS) Where …` —— 标题后面跟着正文
      C. `| 6.25.6.25.1. | Rear-end collision alert signal …`   —— 被并进表格行
    """
    out = {}

    # ── 形态 A / B：行首的 `6.x.` + 标题 ────────────────────────────────
    #   形态 A：标题独占一行；形态 B：标题后面**跟着正文**（同一行）。
    #   所以这里**不锚定行尾** —— 锚定了就永远取不到形态 B。
    #
    #   这一条**先跑**：行首形态是明确的，表格行形态容易被目录行误伤。
    for m in re.finditer(r"^\s*(6\.\d+)\.\s+([A-Z][^\n]{2,90})", text, re.M):
        no, rest = m.group(1), m.group(2).strip()
        # 在第一个「句子开头」处切开
        cut = len(rest)
        for op in SENTENCE_OPENERS:
            idx = rest.find(" " + op)
            if 0 < idx < cut:
                cut = idx
        title = rest[:cut].strip().rstrip(".,")
        out.setdefault(no, title)

    # ── 形态 C：并进表格行的标题（行标签被揉坏，标题在第二格）────────────
    #   真实的行标签形态是 `| 6.25.6.25.1. |` —— **章号出现两次**
    #   （「6.25.」+「6.25.1.」被并成了一格）。
    #
    #   这个「出现两次」是判据的关键：R48 §6 开头那张**目录行**长得像
    #   `| 6.6.1.6.1.1. | Individual specifications Main-beam headlamp …`
    #   —— 章号只出现一次（后面跟的是 1.6.1.1.），那不是章节标题行，
    #   抓进来会把 6.6 的名字换成目录里的一句话。
    for m in re.finditer(
            r"\|\s*(6\.\d+)\.\s*\1\.\d+\.\s*\|\s*([A-Z][^\n|]{3,70}?)\s*(?:Presence|Optional|Mandatory|Number|Arrangement|Position|\s\s|$)",
            text):
        no, title = m.group(1), m.group(2).strip()
        out.setdefault(no, title)

    return out


def normalize(s):
    """比较用的归一化：去掉大小写、空白、标点、括注。"""
    s = re.sub(r"\(.*?\)", " ", s or "")
    s = re.sub(r"[^0-9A-Za-z一-鿿]+", " ", s.lower())
    return " ".join(s.split())


def section_text(text, no):
    """取某一章的正文（从章首到下一章首）。取不到返回 None。"""
    m = re.search(r"(?m)^\s*%s\.\s" % re.escape(no), text)
    if not m:
        # 形态 C：并进表格行的章首
        m = re.search(r"\|\s*%s\.\s*%s\." % (re.escape(no), re.escape(no)), text)
    if not m:
        return None
    start = m.start()
    m2 = re.search(r"(?m)^\s*6\.\d+\.\s", text[start + 10:])
    end = start + 10 + m2.start() if m2 else min(len(text), start + 20000)
    return text[start:end]


def distinctive_token(name):
    """名字里最长的那个词 —— 这一章正文的标志词。

    「Rear retro-reflector, non-triangular」→ "retro-reflector"
    「Direction-indicator position」→ "direction-indicator"
    """
    words = [w.strip(",.;:()[]").lower() for w in re.split(r"[\s,]+", name or "")]
    words = [w for w in words if len(w) >= 5]
    return max(words, key=len) if words else ""


# 语料里**取不到标题**的章节 —— 每一处都要写清楚为什么。
#
# 6.14 的标题在 MinerU 的表格里真的丢了：R48 §6 开头那张「individual
# specifications」表把行标签揉成了 `| 6.14.6.14.1. |`，
# 第二格接的是上一段的正文 —— 「Rear retro-reflector, non-triangular」
# 这行字**在语料里根本不存在**。
#
# 所以这一条**没法靠语料核对**，只能靠人。
# （它恰恰是当初标错过的那一条：曾被写成「Direction-indicator position」，
#   于是所有「侧转向灯」行都派到了回复反射器的条款里。）
#
# 换标准时这个名单会变 —— **多出一条就要人工确认一次**，
# 不许悄悄多一条「取不到」。
KNOWN_UNVERIFIABLE = {
    "6.14": "MinerU 把 §6 目录表的行标签揉坏，这一章的标题在语料里不存在",
}


def main():
    if not os.path.exists(MINERU):
        print("[section-map] 读不到 %s —— 先跑抽取" % MINERU)
        return 2
    data = json.load(io.open(MINERU, encoding="utf-8"))
    text = data["C"]["fullText"]
    titles = extract_chapter_titles(text)
    rows = load_sections()

    print("语料里取到的章节标题：%d 个；手写表 %d 行" % (len(titles), len(rows)))
    print("-" * 96)
    ok = unknown = bad = 0
    problems = []
    unverified = []
    wrong_token = []
    for no, name, probe, kw in rows:
        auto = titles.get(no)
        if not auto:
            unknown += 1
            unverified.append(no)
            # 取不到标题的那几条，退一步查**名字里的标志词在不在本章正文里** ——
            # 这是它们**唯一**的自动化信号。
            # 当年那个 bug（6.14 被写成「Direction-indicator position」）
            # 靠的正是这一条：「direction-indicator」不在 6.14 的正文里。
            body = section_text(text, no)
            token = distinctive_token(name)
            in_body = bool(body and token and token in body.lower())
            if in_body:
                status = "≈ 标题取不到，但标志词在正文里"
            else:
                status = "✗ 标志词不在本章正文里"
                wrong_token.append(no)
                bad += 1
                problems.append(
                    "%s 表里写「%s」，它的标志词「%s」**不在这一章的正文里** —— " % (no, name, token) +
                    "名字多半是张冠李戴（取错章会让候选句整章错位）。")
            if no not in KNOWN_UNVERIFIABLE:
                problems.append(
                    "%s 表里写「%s」，但语料里取不到这一章的标题 —— " % (no, name) +
                    "它不在 KNOWN_UNVERIFIABLE 名单里：要么语料变了，要么 MinerU 又揉坏了一处。")
        elif normalize(auto) == normalize(name):
            status = "✓ 一致"
            ok += 1
        else:
            status = "✗ 不一致"
            bad += 1
            problems.append(
                "%s 表里写「%s」，语料里这一章的标题是「%s」—— 取错章会让候选句整章错位"
                % (no, name, auto))
        print("%-6s %-44s %s" % (no, name[:42], status))
    print("-" * 96)
    print("一致 %d · 不一致 %d · 取不到 %d" % (ok, bad, unknown))

    if problems:
        print()
        for p in problems:
            print("  · " + p)

    if "--report" in sys.argv:
        return 0
    # 不一致 → 红；「取不到」但不在名单里 → 也红（多一条就要人工确认一次）
    return 1 if (bad or [n for n in unverified if n not in KNOWN_UNVERIFIABLE]) else 0


if __name__ == "__main__":
    sys.exit(main())
