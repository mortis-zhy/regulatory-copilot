# -*- coding: utf-8 -*-
"""不变式：**条款索引里，同一章的条款号不能有洞；条款正文不能异常长**。

为什么要有这条 —— `clause_split.py` 的碎片拼接一旦被**正文行**打断
（见该文件里「走到这里 = 这一行既不是纯数字碎片、也不是『数字+空格+标题』」
那段注释），后面那条真条款会被拼成「23.4.10」这种**不存在的条款号**，
于是**整条丢掉**：B（GB 4785-2019）第 4 章的 4.10–4.31 曾经整段没进索引，
而 4.9 又被登记为「不在范围」，于是**一般要求整章对覆盖审计隐形** ——
电压、货车透光面、移动部件 0.15% / 遮挡 50%、可藏灯、光色…一条都没被清点过。

两条信号：

1. **条款号有洞** —— 标准自己编的号不会跳号（除非标准本身跳号，那种情况
   登记在 `data/clause-gap-allowlist.json` 里，写明理由）。
2. **条款正文异常长**（> LONG 字）—— 被吞掉的条款会挂在**上一条**身上，
   于是上一条变得特别长。附录、术语章、配光表天然很长，同样要登记。

用法： python scripts/clause_gap_check.py
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

ALLOW = os.path.join(ROOT, "data", "clause-gap-allowlist.json")
LONG = 5000          # 条款正文超过这么多字，多半是吞了别的条款


def main():
    docs = cs.pick_docs()
    allow = {}
    if os.path.exists(ALLOW):
        allow = json.load(io.open(ALLOW, encoding="utf-8"))
    out = []
    bad = []
    for v in ("A", "B", "C"):
        if v not in docs:
            continue
        idx = cs.split_clauses(docs[v])
        # 1) 条款号连续性（只看二级条款 x.y：子条款跳号不算）
        by_ch = {}
        for k in idx:
            parts = k.split(".")
            if len(parts) == 2 and all(p.isdigit() for p in parts):
                by_ch.setdefault(parts[0], []).append(int(parts[1]))
        for ch, nums in sorted(by_ch.items()):
            nums = sorted(set(nums))
            for a, b in zip(nums, nums[1:]):
                if b <= a + 1:
                    continue
                key = "%s:%d-%d" % (v, a, b)
                if key in allow:
                    out.append("  · %s 第%s章 %d→%d（已登记：%s）" % (v, ch, a, b, allow[key]))
                    continue
                bad.append("%s 第%s章：%d 之后直接跳到 %d —— 中间的条款没进索引" % (v, ch, a, b))
        # 2) 正文异常长
        for k, o in idx.items():
            n = len(o.get("body", ""))
            if n <= LONG:
                continue
            key = "%s:%s" % (v, k)
            if key in allow:
                out.append("  · %s §%s 正文 %d 字（已登记：%s）" % (v, k, n, allow[key]))
                continue
            bad.append("%s §%s 正文 %d 字（> %d）—— 疑似吞掉了后面的条款"
                       % (v, k, n, LONG))
    out.insert(0, "条款索引完整性检查：%d 处未登记的问题" % len(bad))
    out.extend("  ✗ " + b for b in bad)
    io.open(os.path.join(ROOT, "reports", "_clause_gap_check.txt"), "w",
            encoding="utf-8").write("\n".join(out))
    print("\n".join(out[:1]))
    for line in out[1:]:
        print(line)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
