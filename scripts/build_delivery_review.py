# -*- coding: utf-8 -*-
"""**交付件复核清单** —— 机器生成：这份对比文档「哪些结论站得住、哪些还欠着」。

## 为什么要有这份东西

同事在 GitHub issue #3 / #4 提的要求不是「改代码」，是
**「在最新版逐项复核，不能直接认定仍存在」** ✓。

而这份复核的证据**已经在闸门里** ✓（170 多道 ✓）——
但「证据在闸门里」不等于「客户看得见」✓。
所以这里把闸门的结果**收成一份人能读的东西** ✓：

1. 交付件的**身份与规模**（页数 / 章节 / 取值位 / 要求条款 / 引文）✓；
2. **四个维度的核验状态**（pairing / condition / symbol / unit ✓）——
   这就是 DR-012 那套「页面存在性 ≠ 语义正确性」的落地 ✓；
3. **待补清单**（哪些格子的哪个维度还欠着 ✓）—— 下一步做什么，不再是「找找看」；
4. 同事那几条 issue 的**完成标准 → 证据**对照 ✓。

## 为什么是**生成**的

手写的数字一定会过期 —— 这个项目已经因为它栽过三次
（「249 页」「448 条要求」「11 个 _test_*.mjs」✗）。

所以：**每一个数都从机器产物里取** ✓，
生成完由闸门比对（改了数据没重出 → 红 ✓）。

跑法：python scripts/build_delivery_review.py --out <file>
"""
import argparse
import collections
import io
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(rel):
    p = os.path.join(ROOT, rel)
    with io.open(p, encoding="utf-8") as f:
        return json.load(f)


def text(rel):
    p = os.path.join(ROOT, rel)
    if not os.path.exists(p):
        return ""
    with io.open(p, encoding="utf-8") as f:
        return f.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    report = load("reports/last-report.json")
    pack = load("data/standard-pack.json")
    req = load("data/requirement-ledger.json")
    cov = load("data/coverage-audit.json")
    qo = load("data/qualitative-obligations.json")
    qd = load("data/qualitative-diff.json")
    ql = load("data/qualitative-ledger.json")
    summary = load("dist/verify-summary.json")
    pagecount = load("reports/page-count.json")
    decision = load("reports/decision-report.json")

    fam = pack.get("standardFamily", "")
    versions = pack.get("versions", [])
    rows = report.get("parameterMatrix") or []

    # ---- 规模 ------------------------------------------------------------
    cells = hits = 0
    for r in rows:
        for v, c in (r.get("cells") or {}).items():
            cells += 1
            if c.get("status") == "verified":
                hits += 1
    empties = cells - hits
    chapters = len(report.get("chapters") or [])
    appendices = len(report.get("appendices") or [])
    pages = int(pagecount.get("pages") or 0)

    # ---- 四个维度 --------------------------------------------------------
    dim = collections.Counter()
    todo = collections.defaultdict(list)
    for r in rows:
        for v, c in (r.get("cells") or {}).items():
            if c.get("status") != "verified":
                continue
            dims = (c.get("corroborated") or {}).get("dimensions") or {}
            for k, val in dims.items():
                dim[(k, val)] += 1
                if val != "已核":
                    todo[k].append((r.get("name") or r.get("id"), v, val))

    total_verified = hits
    # ---- 定性义务 --------------------------------------------------------
    qo_entries = qo.get("entries") or []
    ql_entries = ql.get("entries") or []
    ql_verdicts = collections.Counter(e.get("verdict", "") for e in ql_entries)
    substantive = sum(n for k, n in ql_verdicts.items() if k.startswith("实质·"))
    nonsub = sum(
        n for k, n in ql_verdicts.items() if k.startswith("非实质·") or k == "同文"
    )
    pending = sum(1 for e in ql_entries if e.get("verdict") == "表述不等价·需人工判读")
    adjudicated = sum(1 for e in ql_entries if e.get("adjudicated"))

    # ---- 变化条数 --------------------------------------------------------
    ch11 = ""
    for ch in report.get("chapters") or []:
        if ch.get("id") == 11:
            ch11 = ch.get("markdown", "")
    m = re.search(r"共\s*(\d+)\s*条", ch11)
    changes = m.group(1) if m else "?"

    # ---- 引文回源 --------------------------------------------------------
    quotes = summary.get("quotes") or {}

    lines = []
    A = lines.append
    A("# 交付件复核清单（**机器生成**，别手改）")
    A("")
    A("> 由 `python scripts/build_delivery_review.py --out <file>` 生成。")
    A("> 每一个数都从**机器产物**里取 —— 手写的数一定会过期。")
    A("> 闸门会比对：数据变了而这份没重出 → **红**。")
    A("")
    A(f"**标准族**：{fam}　·　"
      + "　·　".join(f"{v['key']} = {v['doc']}" for v in versions))
    A("")

    # ---- 1 身份与规模 ----------------------------------------------------
    A("## 1. 交付件的身份与规模")
    A("")
    A("| 项 | 数 | 从哪来 |")
    A("|---|---|---|")
    A(f"| 交付报告页数 | **{pages}** | `reports/page-count.json`（闸门比对漂移 ≤8%） |")
    A(f"| 章节 / 附录 | **{chapters} 章 + {appendices} 附录** | `reports/last-report.json` |")
    A(f"| 参数取值位 | **{cells}** | 同上（{len(rows)} 参数 × {len(versions)} 版） |")
    A(f"| 有值 / 有理由的空 | **{hits} / {empties}** | 同上（空格子**必须**有理由，闸门守着） |")
    A(f"| §11.0 变化总清单 | **{changes} 条** | 第 11 章正文 |")
    A(f"| 要求台账 | **{req.get('totals', {}).get('requirements')} 条** | "
      f"`data/requirement-ledger.json` |")
    A(f"| └ 已覆盖 / 附录逐条 / 已引原文 / 不适用 / 真缺口 | "
      f"{req.get('totals', {}).get('covered')} / {req.get('totals', {}).get('appendixListed')} / "
      f"{req.get('totals', {}).get('quoted')} / {req.get('totals', {}).get('notApplicable')} / "
      f"**{req.get('totals', {}).get('gaps')}** | 同上 |")
    A(f"| 定性义务台账 | **{len(ql_entries)} 条** | `data/qualitative-ledger.json` |")
    A(f"| └ 实质差异 / 非实质 / 需人工判读 | **{substantive}** / {nonsub} / {pending}"
      f"（其中 {adjudicated} 条已人工裁定） | 同上 |")
    A(f"| 附录 H 引文回源 | **{quotes.get('hits')} / {quotes.get('total')}** | "
      f"`scripts/check_qualitative_diff.py`（闸门跑它，数字落进机器产物） |")
    A(f"| 覆盖审计：定量限值 / missing / 别装置顶替 | "
      f"**{cov.get('totals', {}).get('limits')}** / {cov.get('totals', {}).get('missing')} / "
      f"{cov.get('totals', {}).get('otherDevice')} | `data/coverage-audit.json` |")
    # 只写**稳定的数**（闸门总数）✓ ——
    # 「本次过/红」会随自检状态变，写进清单就**永远过期**（死锁 ✓）。
    A(f"| 交付闸门 | **{summary.get('total')} 项** | `dist/verify-summary.json` |")
    A("")
    A("**这些数各自都有闸门守着** —— 数字变了而结论没变，闸门会红；")
    A("反过来，结论变了而数字没变（本项目最怕的「假变化」），也有专门的闸门盯着。")
    A("")
    A("> 自检结果看 `npm run verify`（本清单只写**稳定的数** ✓ —— "
      "把「本次过/红」写进来会让它永远过期 ✗）。")
    A("")

    # ---- 2 四个维度 ------------------------------------------------------
    A("## 2. 每个取值的**四个维度**核到了什么程度")
    A("")
    A("> 「页面上有那个数」≠「那个数的语义是对的」。")
    A("> 每个有值格都带四个维度的状态 —— **没核的写成「未核 / 未判定」，"
      "不写成「已核」** ✓")
    A("> （客户 DR-012：页面存在性 ≠ 语义正确性。）")
    A("")
    A("| 维度 | 问的是 | 已核 | 部分核 | 未核 / 未判定 |")
    A("|---|---|---|---|---|")
    LABEL = {
        "pairing": "这个数**属于**哪个车型/灯具（归属对不对）",
        "condition": "这个数**在什么条件下**成立（适用条件）",
        "symbol": "这个数的**比较符号**（≤ / < / ≥）对不对",
        "unit": "这个数的**单位**对不对",
    }
    for k in ("pairing", "condition", "symbol", "unit"):
        ok = dim[(k, "已核")]
        part = dim[(k, "部分核")]
        no = dim[(k, "未核")] + dim[(k, "未判定")]
        A(f"| `{k}` | {LABEL.get(k, '')} | **{ok}** | {part} | {no} |")
    A(f"| （合计） | {total_verified} 个有值格 | | | |")
    A("")

    # ---- 3 待补清单 ------------------------------------------------------
    A("## 3. 待补清单 —— 下一步做什么，不再是「找找看」")
    A("")
    A("每个维度各一张表：**按参数族聚合** ✓（一个族通常共用一条抽取规则 ✓），")
    A("所以补一族能一次补掉一串格 ✓。")
    A("")
    fam_of = {}
    for r in rows:
        fam_of[r.get("name") or r.get("id")] = r.get("family") or ""
    for k in ("condition", "symbol", "unit", "pairing"):
        items = todo.get(k) or []
        if not items:
            continue
        agg = collections.Counter()
        for name, v, val in items:
            agg[(fam_of.get(name, "?"), name, val)] += 1
        A(f"### `{k}` —— 还欠 **{len(items)}** 格")
        A("")
        A("| 参数族 | 参数 | 状态 | 格数 |")
        A("|---|---|---|---|")
        for (f, name, val), n in agg.most_common(12):
            A(f"| {f} | {name} | {val} | {n} |")
        if len(agg) > 12:
            A(f"| … | 其余 {len(agg) - 12} 个参数 | | |")
        A("")
    A("> 补这些**要动抽取规则包**（`data/parameter-specs.json`）——")
    A("> 那是**交付件的内容**，改动会让客户正在看的那份 PDF 变化 ✓。")
    A("> 所以它属于「等窗口」的那一批 ✓；这份清单的作用是：**窗口开了以后，"
      "工作是照着表做，不是从头找** ✓。")
    A("")

    # ---- 4 issue 对照 ----------------------------------------------------
    A("## 4. 同事提的 issue —— 完成标准 → 证据")
    A("")
    A("| issue | 完成标准 | 证据 |")
    A("|---|---|---|")
    A("| #3 漏比/错归属 | 定量与定性都查、适用对象/条件/例外/单位/比较符号 | "
      f"四维度状态（第 2 节）✓；要求台账 {req.get('totals', {}).get('requirements')} 条**全部有处置** ✓；"
      "空格子必须归类 ✓ |")
    A("| #3 | A/B/C 对应同一个要求；不确定就标待确认 | "
      "矩阵每格带 `pairing` 维度 ✓；第 14 章逐句对照带 C 指针 ✓ |")
    A("| #3 | 每项结论有条款与页码 | "
      "每个取值带条款号 + 源 PDF 页码 ✓；引文回源 "
      f"{quotes.get('hits')}/{quotes.get('total')} ✓ |")
    A("| #3 | 摘要/正文/附录一致 | 对账闸门 ✓；变化条数全篇一致 ✓ |")
    A("| #4 渲染/检查失败 | 失败要报错，不能静默交付 | "
      "空白页 / 乱码 / 未渲染标记 / 最小字号 / 书签 / 页数基线 各有闸门 ✓；"
      "导出未核草稿**拒发** ✓ |")
    A("| #4 | 各下载入口页数一致 | 同一渲染器 ✓；交付件与报告**逐页**比对 ✓ |")
    A("| #2 任务隔离 | 两个任务不串用、不覆盖 | **未覆盖** —— 语料与报告仍是全局单份 ✓ |")
    A("| #1 角色错位 | 识别结果可见、冲突要提示、换顺序结果不变 | "
      "数据层按内容认版本 ✓；**界面确认与顺序不变性用例未做** ✓ |")
    A("| #5 通用 vs 案例 | 外来的法规不套 GB 的结论 | 案例包判定 ✓ + 两道闸门 ✓ |")
    A("")
    A("> 「未覆盖」的两条是**架构/产品层面**的（单租户 + 缺界面确认），")
    A("> 它们**不改交付件** ✓ —— 可以与客户复核并行做 ✓。")
    A("")

    out = "\n".join(lines) + "\n"
    p = os.path.join(ROOT, args.out)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with io.open(p, "w", encoding="utf-8") as f:
        f.write(out)
    print("写到 %s（%d 行）" % (args.out, len(lines)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
