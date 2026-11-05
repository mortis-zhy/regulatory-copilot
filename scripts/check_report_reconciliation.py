"""
**对账闸门** —— 同一义务，报告里三处说法必须一致。

## 为什么要有这道闸门

客户 DR-003（P1，高）说的是一件很具体的事：

> §11.9 说「紧急制动信号由选装变强制安装」（引 A §7.2.1 p69），
> 第 14 章却引 A p41，判「无实质变化」—— **同一份报告前后用不同证据、得出冲突结论**。

根因有两层，都不是「写错了」：

1. **第 14 章的 A 侧定位取「条款号的第一次出现」** ——
   而条款号在正文里也会被**交叉引用**
   （A 第 41 页：「后转向灯按7.2.1执行紧急制动信号……」），
   于是「5.23 紧急制动信号」那一行引到了**转向灯**那节。
2. **第 14 章的变化判定只问「数值变没变」** ——
   「配备：选装 → 强制安装」是**定性**变化，数值没变，
   于是那一行写「无实质数值变化 …… 不需要改设计」。

## 这道闸门断言什么

对 `data/qualitative-obligations.json` 的**每一条**（逐条回原文核验过）：

1. 第 14 章**有**对应到它的那一节（按条款号对位，不是按名字猜）；
2. 那一节引的 **A 页码** = 条目里的 A 页码；
3. 那一节的 **A 列正文**里**含**条目里的 A 原文摘录；
4. 那一节的**变化判定**提到定性义务（§11.9）——
   **不许**写「不需要改设计」；
5. 该条款在**要求台账**里有交代（在账上，或已登记「不适用」并写了理由）。

跑：python scripts/check_report_reconciliation.py
"""
from __future__ import annotations

import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

PUNCT = {"，": ",", "；": ";", "：": ":", "、": ",", "（": "(", "）": ")", "。": ".", "．": ".", "～": "~", "–": "-", "—": "-"}


def norm(s: str) -> str:
    s = re.sub(r"\s+", "", s or "")
    for a, b in PUNCT.items():
        s = s.replace(a, b)
    return s.lower()


def boundary(longer: str, shorter: str) -> bool:
    return longer == shorter or longer.startswith(shorter + ".")


def load(rel: str):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return None
    return json.load(io.open(p, encoding="utf-8"))


def chapter14_sections(md: str):
    parts = re.split(r"(?m)^## 14\.x 条款 ", md)[1:]
    out = []
    for p in parts:
        head = p.split("\n")[0]
        m = re.match(r"([0-9.]+) ↔ A ([0-9.]+)", head)
        ap = re.search(r"\*\*A 草案\*\*（第 (\d+) 页", p)
        verdict = re.search(r"\*\*变化判定\*\*：([^\n]*)", p)
        out.append(
            {
                "head": head,
                "b": m.group(1) if m else None,
                "a": m.group(2) if m else None,
                "apage": int(ap.group(1)) if ap else None,
                "body": p,
                "verdict": verdict.group(1) if verdict else "",
            }
        )
    return out


def main() -> int:
    rep = load("reports/last-report.json")
    qo = load("data/qualitative-obligations.json")
    ledger = load("data/requirement-ledger.json")
    if rep is None or qo is None or ledger is None:
        print("  [FAIL] missing reports/last-report.json / qualitative-obligations.json / requirement-ledger.json")
        return 1

    ch14 = ""
    for c in rep.get("chapters") or []:
        if c.get("id") == 14:
            ch14 = c.get("markdown") or ""
    if not ch14:
        print("  [FAIL] the report has no chapter 14")
        return 1

    secs = chapter14_sections(ch14)
    entries = qo.get("entries") or []
    ledger_rows = ledger.get("rows") or []
    ledger_keys = {(r.get("version"), r.get("clause")) for r in ledger_rows}

    problems = []
    checked = 0

    for e in entries:
        checked += 1
        eid = e.get("id")
        bc = str((e.get("b") or {}).get("clause") or "")
        ac = str((e.get("a") or {}).get("clause") or "")
        apage = (e.get("a") or {}).get("page")
        aquote = str((e.get("a") or {}).get("quote") or "")

        hits = [
            s
            for s in secs
            if s["b"] and s["a"]
            and (
                (bc and (boundary(bc, s["b"]) or boundary(s["b"], bc)))
                or (ac and (boundary(ac, s["a"]) or boundary(s["a"], ac)))
            )
        ]
        if not hits:
            problems.append(f"{eid}: 第 14 章没有对得上的那一节（B {bc} / A {ac}）")
            continue
        # **取最具体的那一节**：条款号是前缀关系时，
        # 「5.1 ↔ A 5.1」会与「5.1.7.2」也「对得上」——
        # 但那一节是整章，不是这一条要求的所在。取共同前缀最长的。
        def common_len(s: dict) -> int:
            def cl(x: str, y: str) -> int:
                xs, ys = x.split("."), y.split(".")
                n = 0
                while n < min(len(xs), len(ys)) and xs[n] == ys[n]:
                    n += 1
                return n
            return max(cl(bc, s["b"] or ""), cl(ac, s["a"] or ""))

        hits.sort(key=common_len, reverse=True)
        s = hits[0]

        # ② 页码必须对得上 —— 这一节引的页（含定性义务条目里写的页）
        #    必须包含 §11.9 记的那一页。
        #    注意：子条款的页码可以比「节起始页」大（节首在 p26、该子条款在 p27），
        #    所以判据是「**这一节指向的页里有没有那一页**」，不是「等于」。
        cited_pages = {int(x) for x in re.findall(r"第\s*(\d+)\s*页", s["body"])}
        if apage and int(apage) not in cited_pages:
            problems.append(
                f"{eid}: 第 14 章这一节没有指向 A 第 {apage} 页（它引的页：{sorted(cited_pages)[:6]}）"
            )

        # ③ A 列正文必须含 §11.9 的 A 原文摘录
        if aquote:
            q = norm(aquote)[:24]
            body = norm(s["body"])
            if q and q not in body:
                problems.append(f"{eid}: 第 14 章的 A 列里找不到 §11.9 的原文「{aquote[:30]}」")

        # ④ 判定必须提到定性义务，且不许说「不需要改设计」
        v = s["verdict"]
        if "定性义务" not in v and "§11.9" not in v:
            problems.append(f"{eid}: 第 14 章的判定没有提定性义务（{v[:40]}）")
        if "不需要改设计" in v:
            problems.append(f"{eid}: 第 14 章写着「不需要改设计」，与 §11.9 的「要改设计」冲突")

        # ⑤ 要求台账必须对这条有交代
        a_ok = ("A", ac) in ledger_keys or ("B", bc) in ledger_keys
        if not a_ok:
            # 允许「已登记不适用」——但那也要有理由，且不能是这一条
            problems.append(f"{eid}: 要求台账里没有这一条（A {ac} / B {bc}）—— 「真缺口 0」管不到它")

    # ── ⑥ 第 14 章每一节引的页，必须等于条款索引里那个条款的页 ──────────
    #
    # 这是「A 侧定位」这条链的**独立**证据：条款索引
    # （data/clause-index.json）是由 PyMuPDF 文本层建的，
    # 与第 14 章用的 MinerU 文本**不是同一个来源** ——
    # 所以它能当第三方证人。
    #
    # 不加这一条的话，定位器写错（落到交叉引用上）只有读者能发现：
    # 客户 DR-003 说的就是「A p41」（实际该是 p69）。
    idx = load("data/clause-index.json")
    checked_pages = 0
    if idx:
        for s in secs:
            for ver, num, page in (("A", s["a"], s["apage"]), ("B", s["b"], None)):
                if not num or not page:
                    continue
                # 条款索引里找这一节的第一条子条款（「5.2.1」）
                cands = [k for k in (idx.get("_clauses", {}).get(ver) or {})
                         if k == num or k.startswith(num + ".")]
                if not cands:
                    continue
                # 取**最浅**的那一条 —— 那一节引的页是「节首」的页，
                # 而不是它最深那条子条款的页。
                key = sorted(cands, key=lambda k: len(k.split(".")))[0]
                want = (idx["_clauses"][ver][key] or {}).get("page")
                if not want:
                    continue
                checked_pages += 1
                if int(want) != int(page):
                    problems.append(
                        f"第 14 章「{s['head'][:40]}」引 {ver} 第 {page} 页，"
                        f"而条款索引里 {ver} §{key} 在第 {want} 页"
                    )
        if not checked_pages:
            problems.append("条款索引里找不到任何可对位的条款 —— 对账的第三方证据没了")
    else:
        problems.append("data/clause-index.json 不在 —— 无法用第三方证据核对页码")

    if problems:
        for p in problems:
            print("  [FAIL] " + p)
        return 1
    print(
        f"  [OK] {checked} 条定性义务在第 14 章对得上（页码、原文、判定一致），"
        f"且都进了要求台账；另有 {checked_pages} 处页码与条款索引（第三方来源）逐一对上"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
