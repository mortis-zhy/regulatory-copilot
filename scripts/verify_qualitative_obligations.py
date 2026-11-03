#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""核实 data/qualitative-obligations.json —— 第 11.9 节「定性义务变化清单」。

为什么要有这个文件
------------------
第 12 章参数矩阵只装得下**数值**。客户真正要的是「产品哪里不一样、要不要改」——
配备 / 禁止 / 适用范围 / 控制逻辑 这类**定性**义务变化，矩阵里一行都装不下，
于是整份报告给人的印象是「这版和之前差别不大」。§11.9 补的就是这块。

这份清单为什么可信
------------------
清单里的每一条都带 A/B/C 三版的**条款号 + 页码 + 原文摘录**。本脚本把每一条
对回 `data/clause-index.json`（机器建的条款索引）逐项核：

  1. 条款号在该版索引里存在；
  2. 索引记录的页码 == 清单写的页码；
  3. 原文摘录确实出现在该条款正文里（归一化后子串匹配）；
  4. `absentTerms`（「某版没有此规定」）确实**不出现**在该条款正文里；
  5. `noteClause` 里引到的旁证条款（形如 `A §5.2.6.2.2（p27）`）同样存在且页码对得上。

第 4 条是关键：**「某版没有这条规定」不是凭印象写的，是在该版原文里扫过确认的**。
本项目最深的一类错误正是「无此规定（已核）」这类散文式理由 —— 至少三条曾经是假的，
而且每一条都写得很笃定。所以这里不接受散文式理由，只接受可复现的扫描结果。

退出码：0 = 全部通过；1 = 有不通过项。
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8")

# 归一化：去掉所有空白 + 统一中西文标点 + 全角转半角。
# 索引里的正文来自 MinerU/源 PDF 的文本层，标点形态与清单里手抄的不一定一致，
# 不归一化就会把「查无此句」的误报当成真错（这个坑踩过）。
_PUNCT_MAP = {
    "，": ",", "：": ":", "；": ";", "（": "(", "）": ")",
    "，": ",", "、": ",", "。": ".", "“": '"', "”": '"',
    "‘": "'", "’": "'", "－": "-", "—": "-", "–": "-",
    "＆": "&", "％": "%", "＃": "#",
}


def norm(s: str) -> str:
    if not s:
        return ""
    s = s.replace("　", " ")
    for a, b in _PUNCT_MAP.items():
        s = s.replace(a, b)
    # 全角字母数字 → 半角
    out = []
    for ch in s:
        code = ord(ch)
        if 0xFF01 <= code <= 0xFF5E:
            out.append(chr(code - 0xFEE0))
        else:
            out.append(ch)
    s = "".join(out)
    # 去掉所有空白
    return re.sub(r"\s+", "", s)


def norm_cf(s: str) -> str:
    """大小写不敏感的归一化（用于 latin 词条的 absentTerms）。"""
    return norm(s).lower()


NOTE_CLAUSE_RE = re.compile(r"([ABC])\s*§\s*([0-9]+(?:\.[0-9]+)+)\s*[（(]\s*p\s*([0-9]+)\s*[）)]")


def main() -> int:
    data_path = ROOT / "data" / "qualitative-obligations.json"
    idx_path = ROOT / "data" / "clause-index.json"

    failures = []
    if not data_path.exists():
        print("FAIL  data/qualitative-obligations.json 不存在")
        return 1
    if not idx_path.exists():
        print("FAIL  data/clause-index.json 不存在")
        return 1

    spec = json.loads(data_path.read_text(encoding="utf-8"))
    index = json.loads(idx_path.read_text(encoding="utf-8")).get("_clauses", {})

    meta = spec.get("_meta", {})
    entries = spec.get("entries", [])
    aspects = set(meta.get("aspects", []))
    c_statuses = set(meta.get("cStatuses", []))
    if not aspects:
        failures.append("_meta.aspects 为空 —— 无法检查 aspect 取值")
    if not entries:
        failures.append("entries 为空 —— 清单里一条都没有")
        print("FAIL  定性义务清单没有条目")
        return 1

    seen_ids = set()
    seen_pairs = set()
    checked_clauses = 0
    checked_absences = 0
    checked_notes = 0

    for e in entries:
        eid = e.get("id", "(无 id)")
        where = f"{eid} / {e.get('device', '?')} / {e.get('aspect', '?')}"

        if eid in seen_ids:
            failures.append(f"{where}: id 重复")
        seen_ids.add(eid)

        pair = (e.get("device", ""), e.get("aspect", ""))
        if pair in seen_pairs:
            failures.append(f"{where}: (装置, 义务面) 组合重复 —— 同一条变化不能列两次")
        seen_pairs.add(pair)

        if aspects and e.get("aspect") not in aspects:
            failures.append(f"{where}: aspect '{e.get('aspect')}' 不在 _meta.aspects 内")

        for field in ("device", "aspect", "title", "nature", "designImpact", "testImpact", "evidence"):
            if not str(e.get(field, "")).strip():
                failures.append(f"{where}: 缺字段 {field}")

        c = e.get("c", {})
        if c_statuses and c.get("status") not in c_statuses:
            failures.append(f"{where}: C 状态 '{c.get('status')}' 不在 _meta.cStatuses 内")

        for ver in ("a", "b", "c"):
            side = e.get(ver)
            if not isinstance(side, dict):
                failures.append(f"{where}: 缺 {ver.upper()} 侧")
                continue
            clause = side.get("clause")
            page = side.get("page")
            quote = side.get("quote")
            if not clause or page is None or not quote:
                failures.append(f"{where}: {ver.upper()} 侧缺 clause / page / quote")
                continue

            body = index.get(ver.upper(), {}).get(clause)
            if not body:
                failures.append(f"{where}: {ver.upper()} §{clause} 在条款索引里不存在")
                continue
            checked_clauses += 1

            idx_page = body.get("page")
            if idx_page != page:
                failures.append(
                    f"{where}: {ver.upper()} §{clause} 页码不符 —— 清单写 p{page}，索引是 p{idx_page}"
                )

            nq = norm(quote)
            nb = norm(body.get("body", ""))
            if nq not in nb:
                failures.append(
                    f"{where}: {ver.upper()} §{clause} 原文摘录在条款正文里查不到 —— {quote[:40]!r}"
                )

            # 「某版没有此规定」必须可复现：在该版原文中扫过确认。
            for term in side.get("absentTerms", []) or []:
                checked_absences += 1
                if norm_cf(term) in norm_cf(body.get("body", "")):
                    failures.append(
                        f"{where}: {ver.upper()} §{clause} 声称不含「{term}」，但原文里出现了 —— "
                        "absentTerms 写错了（这会让「本版无此规定」变成假话）"
                    )

            # 旁证条款（形如 "A §5.2.6.2.2（p27）"）也要能对上。
            for m in NOTE_CLAUSE_RE.finditer(str(side.get("noteClause", "")) + " " + str(e.get("note", ""))):
                nv, nc, np_ = m.group(1), m.group(2), int(m.group(3))
                nb2 = index.get(nv, {}).get(nc)
                if not nb2:
                    failures.append(f"{where}: 旁证条款 {nv} §{nc} 在索引里不存在")
                    continue
                checked_notes += 1
                if nb2.get("page") != np_:
                    failures.append(
                        f"{where}: 旁证条款 {nv} §{nc} 页码不符 —— 写的 p{np_}，索引是 p{nb2.get('page')}"
                    )

    # 覆盖率口径：清单必须覆盖到客户抱怨的几种义务面，而不是只有一种。
    covered_aspects = {e.get("aspect") for e in entries}
    for want in ("配备", "禁止", "适用范围"):
        if want not in covered_aspects:
            failures.append(f"义务面覆盖缺口：没有一条「{want}」类的变化")

    print(f"定性义务清单：{len(entries)} 条")
    print(f"  条款核验 {checked_clauses} 项（条款号 / 页码 / 原文摘录）")
    print(f"  缺失核验 {checked_absences} 项（absentTerms 在原文中扫过）")
    print(f"  旁证核验 {checked_notes} 项")
    print(f"  义务面覆盖：{'、'.join(sorted(a for a in covered_aspects if a))}")

    if failures:
        print()
        for f in failures:
            print("FAIL  " + f)
        print(f"\n{len(failures)} 项不通过")
        return 1

    print("  全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
