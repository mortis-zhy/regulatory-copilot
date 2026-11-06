# -*- coding: utf-8 -*-
"""报告散文的**搬迁工具**与**校验器**。

两个用法：

    python scripts/extract_report_prose.py --migrate     # 从源码把散文搬进数据文件（换标准时用）
    python scripts/extract_report_prose.py --check       # 校验数据文件（闸门用）
    python scripts/extract_report_prose.py --fix-used-at # 只刷新每条散文的「用在哪」

## 为什么要有这个工具

报告正文里的散文（「UN R48 与 GB 的条款编号体系完全不同构，逐号对读会造出假对应」）
换一套标准时**必须重写** —— 而它们原来写在代码里，重写代码比改数据危险：
改坏了照样跑得出来，只是**说错话**。

搬进 `data/report-prose.json` 之后：agent 可以**只改数据**，人只核事实。

每条散文都带一份 `facts`（**从散文里扫出来的**事实声明：标准号 + 条款号）——
散文机器判不了**措辞**，但能判**事实**：事实不符 = 闸门红。

## 搬迁的时候要保住「逐字不变」

从源码里**解析**出那段字面量（不手抄），搬进 JSON，
再把代码里那一处换成查表 —— 输出必须一模一样。

## 校验器查什么（--check）

| 查什么 | 为什么 |
|---|---|
| 每条的 id 在代码里被引用 | 搬进数据文件却不引用 = 白搬 |
| 每条的 `usedAt` 与实际调用点一致 | 位置写错 → 人按着它找不到地方 |
| 每条的 `facts` 与散文里扫出来的一致 | 散文改了、事实没改 = 事实声明在骗人 |
| 代码里没有**同一段**散文 | 同一句话两处维护 = 迟早对不上 |

（`--check` 只读，不写 —— 检查器写产物 = 把问题顺手修好 = 永远验不出来。）
"""
import io
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

from hardcode_ledger import TOKEN_RE, class_of  # noqa: E402  （与扫描器同一份口径）

PROSE_JSON = os.path.join(ROOT, "data", "report-prose.json")

# 条款号：与扫描器同一套形状（`5.2.6` 这种，**不是** `5.2`）
CLAUSE_RE = re.compile(r"(?<![\d.])(\d+(?:\.\d+){1,3})(?![\d])")

# 不搬的字面量：
# · `reportV6.ts` 的输出文件名 —— 那是**文件名**，不是散文（归「交付件出稿脚本」那一族）；
# · `reportGenerator.ts` 的两处 —— 那是 **agent 的提示词**（给模型看的），
#   不是报告正文；搬它没有收益（提示词本来就是人写的、且**不在交付件里**）。
EXCLUDE = {
    ("server/reports/reportV6.ts", 81),
    ("server/reports/reportGenerator.ts", 448),
    ("server/reports/reportGenerator.ts", 787),
}


def scan():
    """跑 JS/TS 侧的扫描器（Python 侧扫不了 TS 语法）。"""
    r = subprocess.run(
        ["node", "scripts/hardcode_scan.mjs"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        raise SystemExit("hardcode_scan.mjs 跑失败：\n" + (r.stderr or "")[-1500:])
    return json.loads(r.stdout)


def prose_files():
    ledger = json.load(
        io.open(os.path.join(ROOT, "data", "hardcode-ledger.json"), encoding="utf-8")
    )
    rule = next((r for r in ledger["rules"] if r["id"] == "report-prose"), None)
    if not rule:
        raise SystemExit("台账里没有「报告正文的散文」那条规则 —— 不知道哪些文件算散文")
    return set(rule["files"])


def facts_of(text, classes=None):
    """从散文里扫出它**断言的事实**（标准号 + 条款号）。"""
    stds = sorted(set(classes)) if classes is not None else sorted(
        {class_of(m.group(0)) for m in TOKEN_RE.finditer(text)}
    )
    clauses = sorted(set(CLAUSE_RE.findall(text)))
    return {"standards": stds, "clauses": clauses}


def call_sites(ids):
    """id → 它在代码里的调用点（`file:line`）。"""
    want = set(ids)
    out = {}
    for rel in sorted(prose_files()):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            continue
        for i, ln in enumerate(io.open(p, encoding="utf-8").read().split("\n"), 1):
            for rid in want:
                if 'prose("%s")' % rid in ln:
                    out.setdefault(rid, []).append("%s:%d" % (rel, i))
    return out


# ------------------------------------------------------------------ 搬迁


def migrate():
    files = prose_files()
    recs = [x for x in scan() if x["file"] in files and x["sub"] == "文案"]
    recs = [x for x in recs if (x["file"], x["line"]) not in EXCLUDE]

    rows = []
    for x in recs:
        slug = os.path.basename(x["file"]).replace(".ts", "")
        rows.append(
            {
                "id": "%s.%d" % (slug, x["line"]),
                "file": x["file"],
                "text": x["text"],
                "facts": facts_of(x["text"], x["cls"]),
            }
        )

    doc = {
        "_why": (
            "**报告正文散文** —— 报告里那些「解释性的话」。\n"
            "\n"
            "它们换一套标准时**必须重写**（讲的是这一套标准怎么组织条款），\n"
            "而它们原来写在代码里 —— **改代码比改数据危险**：\n"
            "改坏了照样跑得出来，只是**说错话**。\n"
            "\n"
            "搬到这里之后：换标准时**只改这个文件**（agent 写、人核事实），\n"
            "而不是翻代码。\n"
            "\n"
            "每条都带 `facts`：**从散文里扫出来的**事实声明\n"
            "（它提到的标准号与条款号）—— 散文机器判不了**措辞**，\n"
            "但能判**事实**：事实不符 = 闸门红。\n"
            "\n"
            "`id` 里的行号是**搬迁时**它在源码里的位置（历史锚点）；\n"
            "它**现在用在哪**，看 `usedAt`。"
        ),
        "_generator": "scripts/extract_report_prose.py（从源码解析出来，逐字保真）",
        "rows": rows,
    }
    with io.open(PROSE_JSON, "w", encoding="utf-8") as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("写到 data/report-prose.json：%d 条" % len(rows))


# ------------------------------------------------------------------ 校验


def check():
    doc = json.load(io.open(PROSE_JSON, encoding="utf-8"))
    rows = doc.get("rows") or []
    errors = []

    if not rows:
        errors.append("data/report-prose.json 里一条散文都没有 —— 报告正文会少掉那些解释")

    # ① id 被引用 ② usedAt 对得上
    sites = call_sites([r["id"] for r in rows])
    for r in rows:
        rid = r["id"]
        if rid not in sites:
            errors.append(
                "散文「%s」在代码里**没被引用** —— 搬进数据文件却不引用，等于白搬" % rid
            )
            continue
        where = sites[rid]
        if r.get("usedAt") and r["usedAt"] not in where:
            errors.append(
                "散文「%s」的 `usedAt` 写的是 %s，实际在 %s —— 位置写错，人按着它找不到地方"
                % (rid, r.get("usedAt"), "、".join(where))
            )

    # ③ facts 与散文里扫出来的一致
    for r in rows:
        want = facts_of(r.get("text", ""))
        got = r.get("facts") or {}
        if sorted(got.get("standards") or []) != want["standards"] or sorted(
            got.get("clauses") or []
        ) != want["clauses"]:
            errors.append(
                "散文「%s」的 `facts` 与文字里扫出来的不一致 —— "
                "事实声明在骗人：声明 %s，扫出来 %s"
                % (rid_of(r), got, want)
            )

    # ④ 代码里没有同一段散文（同一句话两处维护 = 迟早对不上）
    row_texts = {r.get("text", "") for r in rows}
    for rec in scan():
        if rec.get("sub") != "文案":
            continue
        if rec.get("text") in row_texts:
            errors.append(
                "同一段散文在 %s:%d 里**又出现了一次** —— 两处维护，迟早对不上"
                % (rec.get("file"), rec.get("line"))
            )

    if errors:
        print("散文台账有 %d 处对不上：" % len(errors))
        for e in errors:
            print("  · " + e)
        raise SystemExit(1)

    print(
        "散文 %d 条 · 全部被引用 · facts 与文字一致 · 代码里没有重复"
        % len(rows)
    )


def rid_of(r):
    return r.get("id", "?")


def fix_used_at():
    doc = json.load(io.open(PROSE_JSON, encoding="utf-8"))
    rows = doc.get("rows") or []
    sites = call_sites([r["id"] for r in rows])
    n = 0
    for r in rows:
        w = sites.get(r["id"])
        if w and r.get("usedAt") != w[0]:
            r["usedAt"] = w[0]
            n += 1
    with io.open(PROSE_JSON, "w", encoding="utf-8") as f:
        f.write(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print("刷新了 %d 条 `usedAt`" % n)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "--check"
    if mode == "--migrate":
        migrate()
    elif mode == "--check":
        check()
    elif mode == "--fix-used-at":
        fix_used_at()
    else:
        raise SystemExit("用法：--migrate | --check | --fix-used-at")
