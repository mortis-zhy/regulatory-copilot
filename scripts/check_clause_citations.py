"""
**引用的标准号必须真的在它所引的那一条款里。**

## 为什么要有这道闸门

客户 DR-004（P1）与 DR-005（P1）都是同一类错：**把标准号写错了**，
而报告照常生成、闸门全绿：

| 明细 | 报告写的 | 原文 |
|---|---|---|
| DR-004 | R48 §5.30.1「带制造商徽标的光信号灯具应按 **UN R10** 等取得型式批准」 | 「the lamp shall be type approved according to the requirements of **the UN regulation No 148**」 |
| DR-005 | 「C 引 **UN R4511**」 | 「according to **UN Regulation No. 45**<sup>11</sup>」—— 11 是**脚注号** |

DR-005 那一处尤其阴险：OCR 把法规号与脚注上标粘在了一起，
于是「UN Regulation No. 45」+ 脚注「11」= 「UN R4511」，
**一个不存在的法规**被写进了交付件。客户会照着它去选认证依据。

## 判据

对**带条款号的引用**（要求台账的登记理由、§11.9 的三版原文摘录）：

    引用的标准号 ∈ 该条款原文里出现过的标准号

「该条款原文」= 该版语料里，条款号出现处往后的一段窗口。
窗口里的标准号按「前缀 + 号」归一（`UN regulation No 148` 与 `UN R148` 都算 UN148）。

**脚注上标要先摘掉内容再摘标签** ——
否则「UN Regulation No. 45<sup>11</sup>」会变成「UN Regulation No. 4511」，
判据自己就会把 OCR 的粘连当成真的。

跑：python scripts/check_clause_citations.py
"""
from __future__ import annotations

import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 窗口：条款号出现处往后多少字算「这一条的内容」
WINDOW = 600
# 标准号归一：前缀 + 号
UN_RE = re.compile(r"(?:UNECE|UN|ECE)\s*(?:REGULATIONS?\s*NOS?\.?|R)?\s*(\d{1,5})", re.I)
GB_RE = re.compile(r"GB\s*/?\s*(T|Z)?\s*(\d{3,5})", re.I)


def strip_footnotes(text: str) -> str:
    """摘掉脚注上标的**内容**，再摘掉其余标签。

    `UN Regulation No. 45<sup>11</sup>` → `UN Regulation No. 45`
    （11 是脚注号，不是法规号的一部分）
    而 `<sub>3</sub>` 这种**下标**要留着（`N<sub>3</sub>G` 是车辆类别）。
    """
    text = re.sub(r"<sup>.*?</sup>", "", text or "", flags=re.S)
    return re.sub(r"<[^>]+>", "", text)


def norm_spaces(text: str) -> str:
    return re.sub(r"\s+", "", text or "")


def standards_of(text: str) -> set:
    """文本里出现的标准号 → {'UN148', 'GBT21260', …}。"""
    out = set()
    for m in UN_RE.finditer(text):
        out.add(f"UN{m.group(1)}")
    for m in GB_RE.finditer(text):
        suffix = (m.group(1) or "").upper()
        out.add(f"GB{suffix}{m.group(2)}")
    return out


def cited_standards(text: str) -> set:
    """**引用里**点名的标准号 —— 与 standards_of 同一套归一，但要排除
    「GB 4785—XXXX」「UN R48-09」这类**本报告自己**的三版代号。"""
    out = set()
    for m in UN_RE.finditer(text):
        out.add(f"UN{m.group(1)}")
    for m in GB_RE.finditer(text):
        suffix = (m.group(1) or "").upper()
        out.add(f"GB{suffix}{m.group(2)}")
    # 本报告的三版代号不算「引用」
    for own in ("UN48", "GB4785", "UNR48"):
        out.discard(own)
    return out


def clause_window(full_text: str, clause: str) -> str | None:
    """条款号出现处往后的一段 —— 条款正文紧随其后。

    条款号在标题里常带**尾点**（「5.30.1.」），所以不能拿「后面不能跟点号」
    当判据 —— 那会把整条都判成「找不到」，于是这一条**静默地不查**。
    真正的判据是「后面不能跟**数字**」（避免把 5.30.1 认成 5.30.12）。
    """
    if not clause:
        return None
    for m in re.finditer(re.escape(clause) + r"(?!\.?\d)", full_text):
        return full_text[m.start(): m.start() + WINDOW]
    return None


def load_corpus() -> dict:
    p = os.path.join(ROOT, "dist", "mineru-v4-data.json")
    if not os.path.exists(p):
        return {}
    data = json.load(io.open(p, encoding="utf-8"))
    return {
        v: strip_footnotes(d.get("fullText", "") or "")
        for v, d in data.items()
        if isinstance(d, dict)
    }


def check_entry(version: str, clause: str, quoted: str, corpus: dict, where: str, problems: list) -> None:
    full = corpus.get(version)
    if full is None:
        return
    win = clause_window(full, clause)
    if win is None:
        # 条款号在这一版的语料里找不到 —— 那是另一类问题（条款号本身可能写错了），
        # 不在这里下结论。
        return
    have = standards_of(win)
    for cited in sorted(cited_standards(quoted)):
        if cited in have:
            continue
        problems.append(
            f"{where}：{version} §{clause} 里没有「{cited}」"
            f"（该条款窗口内实际有：{', '.join(sorted(have)) or '（无标准号）'}）"
        )


def main() -> int:
    corpus = load_corpus()
    if not corpus:
        print("  [FAIL] 语料不在（dist/mineru-v4-data.json）")
        return 1
    problems: list = []

    # ── ① 要求台账的登记理由（每条都带 version + clause） ──
    gaps_path = os.path.join(ROOT, "data", "requirement-gaps.json")
    if os.path.exists(gaps_path):
        gaps = json.load(io.open(gaps_path, encoding="utf-8")).get("gaps") or []
        for g in gaps:
            check_entry(
                str(g.get("version") or ""),
                str(g.get("clause") or ""),
                str(g.get("reason") or ""),
                corpus,
                f"requirement-gaps.json {g.get('version')} §{g.get('clause')}",
                problems,
            )

    # ── ② §11.9 定性义务清单的三版原文摘录 ──
    qo_path = os.path.join(ROOT, "data", "qualitative-obligations.json")
    if os.path.exists(qo_path):
        entries = json.load(io.open(qo_path, encoding="utf-8")).get("entries") or []
        for e in entries:
            for side, ver in (("a", "A"), ("b", "B"), ("c", "C")):
                s = e.get(side) or {}
                check_entry(
                    ver,
                    str(s.get("clause") or ""),
                    str(s.get("quote") or ""),
                    corpus,
                    f"qualitative-obligations.json {e.get('id')}/{ver} §{s.get('clause')}",
                    problems,
                )
            # nature / designImpact / testImpact **不查** ——
            # 那是**跨版本的说明文字**：它会提到三版各自的标准
            # （A/B 引 GB/T 21260、C 引 UN R45），拿单一条款去核它必然误报。
            # 而且它常常**故意**引着原文的错误形态（「OCR 把两者粘成了 UN R4511」）
            # 来解释这件事 —— 那是说明，不是引用。
            # **要查的是「引文」**：那才是报告对外的证据。

    # ── ③ 参数 spec 的 why 里点名的标准号（按该版该条的锚点核） ──
    spec_path = os.path.join(ROOT, "data", "parameter-specs.json")
    if os.path.exists(spec_path):
        specs = json.load(io.open(spec_path, encoding="utf-8")).get("specs") or []
        for s in specs:
            for ver, pat in (s.get("patterns") or {}).items():
                if not isinstance(pat, dict):
                    continue
                why = str(pat.get("why") or "")
                if not why:
                    continue
                # spec 的 why 里引的条款号：取第一个「§X.Y」形态
                cm = re.search(r"§\s*(\d+(?:\.\d+)+)", why)
                if not cm:
                    continue
                check_entry(
                    str(ver),
                    cm.group(1),
                    why,
                    corpus,
                    f"parameter-specs.json {s.get('id')}/{ver}",
                    problems,
                )

    for p in problems:
        print("  [FAIL] " + p)
    if problems:
        print(f"✗ {len(problems)} 处引用了条款里没有的标准号 —— 认证依据会选错")
        return 1
    print("✓ 引用的标准号都能在它所引的那一条款里找到")
    return 0


if __name__ == "__main__":
    sys.exit(main())
