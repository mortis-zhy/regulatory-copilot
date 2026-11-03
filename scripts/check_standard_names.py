#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对：交付件里提到的每个标准名，**语料里是不是真的有它**。

## 为什么要有这一关

换一套标准时，报告里的**散文**（第 11.4 节的 GB4785 表 11.6 九条指标、
第 12.4 节「A 在向 R48 对齐」、§11.3.1 的人工补录……）是**手写**的，
它们不跟着语料走。

于是新标准的报告里会**继续讲 GB 4785 的事** ——
而那不是「空着」，是**说错了**：读者会以为那是新标准的规定。

这一关抓的是同一形状的病：**报告里出现了语料里根本没有的标准**。
（实测就抓到一处：报告的解读栏写「UN R13 / R131」，
而同一行的**原文摘录**写的是「UN Regulations Nos. 13 and 13-H」——
解读与引文对不上，而引文是对的。）

## 判定怎么算「语料里有」

- **剥标签**：MinerU 会把脚注上标写成 `45<sup>11</sup>`（= 4511），
  不剥标签就找不到「UN Regulation No. 4511」。
- **认两种写法**：`UN R149` 与原文的 `UN Regulation No. 149` 是同一个东西；
  UN 文件里不带前缀的 `Regulation No. 97` 也算 UN。
- **不把条款号当标准号**：`GB 5.4.5.1` 是「GB 文件的 5.4.5.1 条款」，
  不是标准（标准号不会有三段点号）。

用法
----
    python scripts/check_standard_names.py            # 核对；有不符就 exit 1
    python scripts/check_standard_names.py --report   # 只打印，退出码恒 0
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, "reports", "last-report.json")
MINERU = os.path.join(ROOT, "dist", "mineru-v4-data.json")

# 语料里**没有**、但报告可以引用的**背景法规** —— 每一处都要写清为什么。
#
# 判据不是「报告里能不能出现语料外的标准」，而是：
# **报告不许拿语料外的标准去讲本标准的事**。
# 「UN R10 中的『Modifications and extensions of approval…』」说的是
# 另一个法规里的术语，不是对 GB 4785 / R48 的声明 ——
# 换标准后这句话仍然是关于 UN R10 的，不会变成假声明。
#
# 而「GB 4785」「UN R48」这类**本标准集自己的名字**，
# 一旦换了标准就会变成假声明 —— 那正是这一关要抓的，
# 所以它们**不许**进这个名单。
ALLOWED_BACKGROUND = {
    "UN R10": "R48 §7「Modifications and extensions of approval of the vehicle type」"
              "的上位 EU 认证程序法规。报告引用的是 UN R10 里的术语，"
              "不是对本语料三版的声明 —— 换标准后这句话仍然成立。",
    "UN R112": "LED 前照灯的型式试验法规。语料里 C 版只引 UN R149（AFS），"
               "R112 是背景补充（光度值在型式试验法规里）。",
}

# 标准号：一段前缀 + 一个号（可有 -N 后缀）。
# **不允许三段以上点号** —— 那是条款号，不是标准号。
STD_RE = re.compile(
    r"\b(GB\s*/?\s*T?|GB\s*/?\s*Z|UNECE|UN|ECE)\s*([A-Z]?)\s*(\d{1,5})(?:\s*[-–]\s*(\d{1,4}))?"
    r"(?![\d.])")
# 条款号形态：前缀后面跟三段以上点号 → 不是标准
CLAUSE_RE = re.compile(r"\b(?:GB|UN|ECE)\s*[A-Z]?\s*\d+(?:\.\d+){2,}")


def strip_tags(s):
    """剥 HTML 标签 —— MinerU 把脚注上标写成 <sup>11</sup>。"""
    return re.sub(r"<[^>]+>", "", s or "")


def norm(s):
    s = (s or "").upper()
    s = re.sub(r"[—–‐‑‒−\-]", "", s)
    s = re.sub(r"\s+", "", s)
    return s


def report_text(report):
    parts = [c.get("markdown", "") for c in report.get("chapters", [])]
    parts += [a.get("markdown", "") or "" for a in (report.get("appendices") or [])]
    parts.append(report.get("outline", {}).get("title", ""))
    return "\n".join(parts)


def corpus_text(mineru):
    parts = []
    for d in mineru.values():
        parts.append(d.get("fullText", "") or "")
        parts.append(d.get("markdown", "") or "")
        parts.append(json.dumps(d.get("tables") or [], ensure_ascii=False))
        parts.append(json.dumps(d.get("headings") or [], ensure_ascii=False))
    return strip_tags("\n".join(parts))


def corpus_standard_numbers(text):
    """语料里出现过的标准号 → {'UN': {'149','4511',…}, 'GB': {…}}。

    两种写法都认：
      · `UN Regulation No. 149` / `UN R149` → UN{149}
      · UN 文件里不带前缀的 `Regulation No. 97` → UN{97}
        （UN 文件里的 "Regulation No." 指的就是 UN 法规）
    """
    out = {"UN": set(), "UNECE": set(), "ECE": set(), "GB": set(), "GBT": set(), "GBZ": set()}
    n = norm(text)

    # ① 带前缀的：`UNR107` / `GB4785` / `GBT30036`
    #
    # **不要加「后面不能跟数字」的判断** —— 语料里标准号后面常常紧跟条款号：
    #   "UNREGULATIONNO.4511.6.2.9.3"（4511 后面是条款号）
    #   "GB/T300362013"（30036 后面是**年份**）
    # 加了就会把真标准判成「语料里没有」。`\d{1,5}` 本身就会在非数字处停下。
    for m in re.finditer(r"(GB/T|GB/Z|GB|UNECE|UN|ECE)(?:REGULATIONS?NOS?\.?|R)?(\d{1,5})", n):
        prefix, num = m.group(1), m.group(2)
        key = {"GB/T": "GBT", "GB/Z": "GBZ"}.get(prefix, prefix)
        out.setdefault(key, set()).add(num)

    # ② UN 文件里不带前缀的 `Regulation No. N` / `Nos. N and M`
    for m in re.finditer(r"REGULATIONSN?OS?\.?(\d{1,5}(?:AND\d{1,5}(?:-H)?)?)", n):
        for num in re.findall(r"\d{1,5}", m.group(1)):
            out["UN"].add(num)
    # ③ `Regulation No. 97, 116, 162` —— 逗号分隔的一串
    for m in re.finditer(r"REGULATIONNO\.(\d{1,5}(?:,\d{1,5}){1,4})", n):
        for num in m.group(1).split(","):
            out["UN"].add(num.strip())
    return out


def main():
    if not os.path.exists(REPORT):
        print("[std-names] 读不到 %s" % REPORT)
        return 2
    report = json.load(io.open(REPORT, encoding="utf-8"))
    mineru = json.load(io.open(MINERU, encoding="utf-8"))

    rtext = report_text(report)
    ctext = corpus_text(mineru)
    backed = corpus_standard_numbers(ctext)
    cnorm = norm(ctext)

    # 报告里出现的标准号（先去掉条款号形态，免得把 GB 的条款当标准）
    rtext_wo_clause = CLAUSE_RE.sub(" ", rtext)
    found = {}
    for m in STD_RE.finditer(rtext_wo_clause):
        prefix = m.group(1).upper().replace(" ", "")
        key = {"GB/T": "GBT", "GB/Z": "GBZ"}.get(prefix, prefix)
        num = m.group(3) + (("-" + m.group(4)) if m.group(4) else "")
        found.setdefault((key, num), m.group(0).strip())

    unknown = []
    for (key, num), disp in sorted(found.items()):
        plain = num.split("-")[0]
        if plain in backed.get(key, set()):
            continue
        # 语料里原样出现（例：UN R48 就在原文里这么写）
        if norm(key + num) in cnorm:
            continue
        # 同号不同前缀也算（GB 24599 / GB/T 24599）
        if any(plain in s for k, s in backed.items() if k.startswith("GB")):
            continue
        # 明确登记过的**背景引用**（每条都要写清为什么）
        if disp in ALLOWED_BACKGROUND:
            continue
        unknown.append((key, num, disp))

    print("报告里出现的标准号 %d 个；语料里找不到的 %d 个" % (len(found), len(unknown)))
    print("-" * 88)
    for (key, num), disp in sorted(found.items(), key=lambda kv: kv[1]):
        mark = "✗ 语料里没有" if any(k == key and n == num for k, n, _ in unknown) else "✓"
        note = "（背景引用，已登记）" if disp in ALLOWED_BACKGROUND else ""
        print("%-4s %s%s" % (mark, disp, note))
    print("-" * 88)
    if unknown:
        print()
        for key, num, disp in unknown:
            print("  · 报告里讲「%s」，但**语料里根本没有它** —— " % disp)
            print("    换标准后这就是一句**假声明**（读者会以为那是新标准的规定）。")
    else:
        print("全部标准号都能在语料里找到（或已登记为背景引用）。")

    if "--report" in sys.argv:
        return 0
    return 1 if unknown else 0


if __name__ == "__main__":
    sys.exit(main())
