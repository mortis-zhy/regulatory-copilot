# -*- coding: utf-8 -*-
"""**GB 章节 → R48 章节** 对应表的构建与自检。

为什么要有这个
--------------
第 14 章的 C 列（欧标）原先靠 24 个「主题」的粗粒度反查。两类错：

  ① **指错** —— 「后位灯」被指到 §6.9.4.1（那是**前位灯**的位置条款），
     四个回复反射器全被指到 §6.14（非三角形后回复反射器）。
     「错着」比「空着」贵一个数量级：读者会当真。
  ② **漏指** —— R48 明明有 §6.11 后雾灯 / §6.12 驻车灯 / §6.18 侧标志灯 /
     §6.20 角灯 / §6.21 醒目标志 / §6.22 AFS / §6.23 紧急制动信号，
     报告却写「UN R48-09 无同构章节」。客户说的「无欧标」就是这条。

本脚本从 `dist/mineru-v4-data.json` 的 C 版语料里**逐条把对应关系验一遍**，
验不过就**当场退出非零** —— 一张对不上语料的映射表比没有映射表更糟。

三道验
------
1. `probe` 必须在 R48 语料里出现（英文标题原文）。
2. R48 章节号必须出现在 `probe` 前后各 400 字内 —— 否则 probe 命中的
   是别处的引文（比如 §2.6 的定义里也写着 "Rear-end collision alert signal"）。
3. `gbName` 必须出现在第 14 章对应节的 GB 标题里 —— 防 GB 改版重编号
   之后这张表悄悄指错。

用法：
    python scripts/build_r48_chapters.py            # 生成
    python scripts/build_r48_chapters.py --check    # 只验，不写（闸门用）
"""
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAP_PATH = os.path.join(ROOT, "data", "r48-chapter-map.json")
OUT_PATH = os.path.join(ROOT, "data", "r48-chapters.json")
CORPUS_PATH = os.path.join(ROOT, "dist", "mineru-v4-data.json")
REPORT_PATH = os.path.join(ROOT, "reports", "last-report.json")

# 摘录长度：够看清这一章在讲什么，又不至于把整章灌进表格单元格
EXCERPT_CHARS = 420
NEAR_WINDOW = 400


def _norm(s):
    """归一化：统一空白、去软连字符。R48 语料里有 `-\n` 造成的断词。"""
    s = re.sub(r"-\s*\n\s*", "", s or "")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def _page_at(full_text, pos):
    """字符位置 → 该位置所在的 R48 源页码（语料用 `[第N页]` 分页）。"""
    best = 0
    for m in re.finditer(r"\[第(\d+)页\]", full_text[:pos]):
        best = int(m.group(1))
    return best


def _clause_token(clause):
    """章节号 → 独立 token 的正则（前后都不能挨着数字/点）。

    「6.1」不能匹配到「6.16」；「2.4.17.3」不能匹配到「2.4.17.30」。
    """
    return r"(?<![\d.])%s(?![\d])" % re.escape(clause)


def locate(full_text, clause, probe):
    """在 R48 语料里定位这一章，返回 (起点, 命中次数)。

    命中规则：`probe` 出现，且 R48 章节号在 probe 前后各 400 字内出现。
    命中 0 次 = 映射表与语料不符 —— 必须炸。
    命中多次 = 取第一处，但把次数记下来供审计（§2 的定义里也会出现同一个词）。
    """
    clause_re = re.compile(_clause_token(clause))
    hits = []
    for m in re.finditer(re.escape(probe), full_text):
        lo = max(0, m.start() - NEAR_WINDOW)
        hi = min(len(full_text), m.end() + NEAR_WINDOW)
        if clause_re.search(full_text[lo:m.start()]) or clause_re.search(
            full_text[m.end():hi]
        ):
            hits.append(m.start())
    return (hits[0] if hits else -1), len(hits)


def excerpt_from(full_text, start, clause):
    """从定位点切一段可读的原文。

    优先把**条款号**带上：R48 的章节标题多数是「6.10. Rear position lamp」
    这种形态；少数被 MinerU 并进表格行（§6.1 / §6.14 / §6.25），那时
    标题前面没有号 —— 就从标题文字起切，条款号由报告侧另行打印。
    """
    head = full_text[max(0, start - 40):start]
    m = re.search(re.escape(clause) + r"\.", head)
    body = full_text[start:start + EXCERPT_CHARS * 2]
    out = _norm(body)
    if len(out) > EXCERPT_CHARS:
        out = out[:EXCERPT_CHARS].rstrip() + "…"
    return out


def gb_titles_from_report():
    """第 14 章每一节的 GB 标题 —— 用来验 `gbName`。"""
    if not os.path.exists(REPORT_PATH):
        return {}
    rep = json.load(io.open(REPORT_PATH, encoding="utf-8"))
    out = {}
    for ch in rep.get("chapters") or []:
        if ch.get("id") != 14:
            continue
        for m in re.finditer(r"(?m)^## 14\.x 条款 (.+?) — (.+)$", ch.get("markdown") or ""):
            clause, title = m.group(1).strip(), m.group(2).strip()
            b_side = clause.split("↔")[0].strip()
            # A 独有的章 B 侧没有编号（「— ↔ A 7（A 独有）」）—— 用整串做 key，
            # 否则两个 A 独有章会挤成同一个 key。
            out[b_side if re.match(r"^\d", b_side) else clause] = title
    return out


def matrix_row_names():
    """第 12 章矩阵的行名 —— 用来验 `matrixToken`。"""
    if not os.path.exists(REPORT_PATH):
        return []
    rep = json.load(io.open(REPORT_PATH, encoding="utf-8"))
    return [str(m.get("name") or "") for m in (rep.get("parameterMatrix") or [])]


def main():
    check_only = "--check" in sys.argv
    if not os.path.exists(CORPUS_PATH):
        print("找不到语料 %s —— 先跑抽取" % CORPUS_PATH)
        return 1

    corpus = json.load(io.open(CORPUS_PATH, encoding="utf-8"))
    c_doc = corpus.get("C") or {}
    full_text = c_doc.get("fullText") or ""
    if not full_text:
        print("C 版语料没有 fullText")
        return 1

    mp = json.load(io.open(MAP_PATH, encoding="utf-8"))
    entries = mp.get("map") or {}
    gb_only = mp.get("gbOnly") or {}
    gb_titles = gb_titles_from_report()
    matrix_names = matrix_row_names()

    built = {}
    problems = []
    for gb in sorted(entries.keys(), key=lambda x: [int(p) for p in x.split(".")]):
        e = entries[gb]
        clause = str(e.get("r48") or "")
        probe = str(e.get("probe") or "")
        near = str(e.get("near") or clause)
        if not clause or not probe:
            problems.append("GB %s：缺 r48 或 probe" % gb)
            continue

        start, n = locate(full_text, near, probe)
        if start < 0:
            problems.append(
                "GB %s → R48 §%s：在原文里找不到「%s」，"
                "或它前后 400 字内没有 §%s —— 映射表与语料不符" % (gb, clause, probe, near)
            )
            continue

        # 第 3 道验：GB 标题里必须真的写着这个装置名
        title = gb_titles.get(gb, "")
        gb_name = str(e.get("gbName") or "")
        if title and gb_name and gb_name not in title:
            problems.append(
                "GB %s：第 14 章标题是「%s」，不含映射表写的「%s」 —— GB 改版重编号了？" % (gb, title, gb_name)
            )
            continue

        page = _page_at(full_text, start)
        # 第 4 道验：`matrixToken` 必须真的能抓到矩阵行 ——
        # 抓不到就说明这一节会挂一个空表，或者挂错装置的行。
        matrix_token = str(e.get("matrixToken") if e.get("matrixToken") is not None else "")
        if matrix_token and matrix_names:
            if not any(matrix_token in n for n in matrix_names):
                problems.append(
                    "GB %s：matrixToken「%s」在第 12 章矩阵里一行都匹配不到 —— "
                    "这一节的「三版取值」小表会挂空" % (gb, matrix_token)
                )
                continue
        built[gb] = {
            "gb": gb,
            "gbName": gb_name,
            "r48": clause,
            "r48Name": probe,
            "page": page,
            "pageLabel": ("第%d页" % page) if page else "页码未核验",
            "excerpt": excerpt_from(full_text, start, clause),
            "hits": n,
            "matrixToken": matrix_token,
            "note": str(e.get("note") or ""),
            "verified": True,
        }

    if problems:
        print("✗ R48 章节对应表有 %d 处对不上语料：" % len(problems))
        for p in problems:
            print("   · " + p)
        return 1

    # 不在映射表里的 GB 章，必须在 `gbOnly` 里写明为什么没有对应章 ——
    # 否则「漏指」会静默发生（这正是原表把 §6.11 后雾灯写成「无同构章节」的原因）。
    unmapped = []
    for gb, title in sorted(gb_titles.items()):
        if gb in built:
            continue
        if gb in gb_only:
            continue
        # 「— ↔ A 6（A 独有）」这类 **A 独有的章**没有 B 侧编号 ——
        # 它们不是「漏指」，是**另一头**独有。但同样要说明为什么没有对应章。
        if not re.match(r"^\d", gb):
            unmapped.append("GB %s（%s，A 独有章）" % (gb, title))
            continue
        unmapped.append("GB %s（%s）" % (gb, title))
    if unmapped:
        print("✗ 有 %d 个 GB 章既不在对应表里，也没在 gbOnly 里说明为什么没有对应章：" % len(unmapped))
        for u in unmapped:
            print("   · " + u)
        print("   —— 「漏指」就是从这里来的：补进 map 或补进 gbOnly。")
        return 1

    out = {
        "_comment": "由 scripts/build_r48_chapters.py 生成 —— **不要手改**。"
                    "GB 章节 → UN R48-09 章节的对应关系，每条都回 R48 原文验过。",
        "generatedFrom": "dist/mineru-v4-data.json",
        "map": built,
        "gbOnly": gb_only,
    }
    payload = json.dumps(out, ensure_ascii=False, indent=1) + "\n"

    if check_only:
        try:
            old = io.open(OUT_PATH, encoding="utf-8").read()
        except Exception as e:
            print("读不到 %s：%s" % (OUT_PATH, e))
            return 1
        if old != payload:
            print("✗ data/r48-chapters.json 与现算结果不一致 —— 跑一次 "
                  "python scripts/build_r48_chapters.py")
            return 1
        print("R48 章节对应表与现算一致：%d 条对应 + %d 条 GB 独有（全部验过）"
              % (len(built), len(gb_only)))
        return 0

    io.open(OUT_PATH, "w", encoding="utf-8", newline="").write(payload)
    print("已写出 %s（%d 条对应 + %d 条 GB 独有）" % (OUT_PATH, len(built), len(gb_only)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
