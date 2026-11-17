#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""**开发侧清点表**与**扫描产物**对不上 ⇒ 红。

## 为什么要有这一步

`docs/requirement-discovery-r148-audit.md` 是一张**人写的**逐条清点表 ✓ ——
它写的时候是对的 ✓，但扫描器后来又跑过几轮（run1 → run2 → context-run1 ✓）——
**表里的「未触发候选」可能早就过时了** ✗。

过时的清点表是最危险的一类文档 ✗：读的人拿它当「这个扫描器漏了哪些」的依据 ✗，
而它列的漏项**其实已经补上了** ✗ —— 于是去修一个**不存在的问题** ✗。

这与本项目里「交付件复核清单 / 换标准操作清单」是**同一类**病 ✓
（清单是生成的、会过期 ⇒ 必须有闸门盯着 ✓）。

## 它比什么

- 表里的**条款锚点**集合 ↔ 扫描产物里的**条款锚点**集合 ✓（两边各有、各缺 ✓）；
- 表里标「未触发候选」的条款 ↔ 产物里**到底有没有**候选 ✓；
- 表里标「候选已定位」的条款 ↔ 产物里**到底在不在** ✓。

**只比「有没有候选」** ✓ —— 不比语义 ✓（表里也明说语义未核 ✓）。

用法：
    python scripts/check_discovery_audit.py --audit docs/...audit.md --run tmp/discovery/.../discovery.json
"""
import argparse
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 表格行：| 4.3.1 | 11 | 上下文待关联，未触发候选 | ... |
ROW = re.compile(r"^\|\s*([0-9]+(?:\.[0-9]+)+)\s*\|\s*([0-9,\s]+)\s*\|\s*([^|]+?)\s*\|")


def parse_audit(path):
    """→ {clause: status_text}"""
    out = {}
    for line in io.open(path, encoding="utf-8"):
        m = ROW.match(line.strip())
        if not m:
            continue
        out[m.group(1)] = m.group(3).strip()
    return out


OUT_OF_RANGE = re.compile(r"<!--\s*out-of-range:\s*([^>]*?)-->")


def main():
    ap = argparse.ArgumentParser(description="清点表 vs 扫描产物")
    ap.add_argument("--audit", required=True)
    ap.add_argument("--run", help="扫描产物 discovery.json（有 PDF 时用）")
    ap.add_argument("--fixture", help="提交进仓库的**锚点快照**（没有 PDF 也能查）")
    ap.add_argument("--emit-fixture", help="把这次的锚点写成快照（只有锚点与理由，**不含原文** ✓）")
    args = ap.parse_args()
    if not args.run and not args.fixture:
        ap.error("要给 --run 或 --fixture")

    doc = io.open(os.path.join(ROOT, args.audit), encoding="utf-8").read()
    audit = parse_audit(os.path.join(ROOT, args.audit))
    # 「范围外的锚点」由清点表里的一段**机器可读注释**声明 ✓ ——
    # 它们**不算第 4 章的要求** ✓，但也不能从台账里消失 ✓ ⇒ 单独列 ✓。
    m = OUT_OF_RANGE.search(doc)
    declared_out = (
        {x.strip() for x in m.group(1).split(",") if x.strip()} if m else set()
    )

    if args.run:
        run = json.load(io.open(os.path.join(ROOT, args.run), encoding="utf-8"))
        candidates = run.get("candidates") or []
    else:
        run = json.load(io.open(os.path.join(ROOT, args.fixture), encoding="utf-8"))
        candidates = run.get("candidates") or []
    have = {c["clause"] for c in candidates if c.get("clause")}

    if args.emit_fixture:
        # **只存锚点与触发理由** ✓ —— 不存原文 ✓（第三方标准原文不跟着进仓库 ✓）
        snap = {
            "_why":
                "R148 第 4 章扫描的**锚点快照** —— 只有条款锚点、触发理由与物理页 ✓，"
                "不含任何标准原文 ✓。"
                "它让 `python scripts/check_discovery_audit.py --audit … --fixture …` "
                "在**没有原始 PDF 的机器上**也能核对清点表是否过期 ✓。"
                "重跑扫描后要重新生成它 ✓（命令见 docs/requirement-discovery-r148-smoke.md ✓）。",
            "source": {
                "document": (run.get("source") or {}).get("fileName"),
                "sha256": (run.get("source") or {}).get("sha256"),
                "version": (run.get("source") or {}).get("version"),
                "selectedPages": (run.get("source") or {}).get("selectedPages"),
            },
            "runStatus": (run.get("run") or {}).get("status"),
            "candidates": [
                {
                    "clause": c.get("clause"),
                    "reasons": c.get("reasons"),
                    "page": (c.get("evidence") or [{}])[0].get("page"),
                }
                for c in sorted(candidates, key=lambda x: [int(p) for p in (x.get("clause") or "0").split(".")])
            ],
        }
        out = os.path.join(ROOT, args.emit_fixture)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        io.open(out, "w", encoding="utf-8").write(json.dumps(snap, ensure_ascii=False, indent=1) + "\n")
        print("快照已写：%s（%d 个锚点 ✓）" % (args.emit_fixture, len(snap["candidates"])))

    # 表里声称「没有候选」的
    said_none = {k for k, v in audit.items() if "未触发候选" in v}
    # 表里声称「有候选」的
    said_has = {k for k, v in audit.items() if "候选已定位" in v}

    print("清点表：%d 个条款锚点 · 声称有候选 %d · 声称无候选 %d"
          % (len(audit), len(said_has), len(said_none)))
    print("扫描产物：%d 个候选（带锚点 %d 个）\n" % (len(run.get("candidates") or []), len(have)))

    problems = []

    # ① 表说「没有候选」，产物里**其实有** ⇒ 表过期 ✓（这是本轮要找的）
    stale_none = sorted(said_none & have, key=lambda s: [int(x) for x in s.split(".")])
    for c in stale_none:
        problems.append(
            "表说「%s 未触发候选」，但产物里**有**它的候选 —— 表过期了 ✓" % c
        )

    # ② 表说「有候选」，产物里**没有** ⇒ 要么产物回退了 ✗，要么表写错了 ✗
    missing = sorted(said_has - have, key=lambda s: [int(x) for x in s.split(".")])
    for c in missing:
        problems.append(
            "表说「%s 候选已定位」，但产物里**没有**它的候选 —— 扫描器回退了？还是表写错了？"
            % c
        )

    # ③ 表里根本没列的锚点（产物有、表没有）⇒ 表不全 ✗
    #    但「范围外的锚点」**本来就该在表外** ✓（它们在注释里声明过 ✓）
    unlisted = sorted(have - set(audit) - declared_out, key=lambda s: [int(x) for x in s.split(".")])
    for c in unlisted:
        problems.append("产物里有 %s 的候选，但清点表**没列这一条** ✗" % c)

    # ④ 声明了「范围外」但产物里**没有** ⇒ 声明过期了 ✗（或者扫描器漏了 ✗）
    for c in sorted(declared_out - have, key=lambda s: [int(x) for x in s.split(".")]):
        problems.append("清点表声明 %s 是「范围外的锚点」，但产物里**没有**它 ✗" % c)

    if problems:
        print("✗ %d 处对不上：\n" % len(problems))
        for p in problems:
            print("   ·", p)
        sys.exit(1)
    print("✓ 清点表与扫描产物**逐条对得上**（%d 个锚点）" % len(audit))


if __name__ == "__main__":
    main()
