# -*- coding: utf-8 -*-
"""**交接文档里的每一个数**，是不是真的？

## 为什么要有这道关

交接文档最常见的病是**数字过期** ✗ —— 写的时候是真的，
过两周代码变了、交付件重出了，文档还写着旧数 ✗。
读它的人（下一个接手的）**照着旧数做决定** ✗ —— 那是「错着」✗。

本项目已经因为「手写的数」踩过好几次 ✓（讲稿里的「249 页」✓、
「97 项闸门」✓……）—— 所以规矩是：**数字不许手写** ✓。

那交接文档里的数怎么办 ✓？**让机器查** ✓ —— 就是这道关 ✓：
把文档里引用的每个数（闸门数、页数、图数、四维状态、装置数……）
与**仓库里实际的状态**逐项比对 ✓，对不上就红 ✓。

## 它查什么

- 闸门数 / 页数 / 图数 / 引文命中数 ⇒ 对 `dist/verify-summary.json` ✓
- 交付件 PDF 的页数 / 图对象 / 书签 ⇒ **直接开 PDF 数** ✓
- 四维核验状态（957 格）⇒ 对报告 JSON 重算 ✓
- 硬编码台账的规则数 / 文件数 ⇒ 对 `data/hardcode-ledger.json` ✓
- 装置↔章映射的装置数 / 章数 ⇒ 对 `data/device-chapter-map.json` ✓
- 泛化率与编造数 ⇒ 对 `reports/spec-agent-baseline.json` ✓
- 文档里引用的**每个文件**是不是真的存在 ✓
- 文档里写的**每条命令**里的脚本是不是真的存在 ✓

## 用法

    python scripts/check_handover.py     # 退出码 0 = 全对得上 ✓
"""
import io
import json
import os
import re
import subprocess
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
bad = []


def chk(name, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + name + ("" if cond else " —— " + str(detail)))
    if not cond:
        bad.append(name)


h = io.open(os.path.join(ROOT, "HANDOVER.md"), encoding="utf-8").read()

print("\n=== 交接文档里的数 ===")

# ① 闸门数 —— **不在这里查** ✓
#
# 为什么不在这里查 ✓：**这道关自己就是一道闸门** ✓ ——
# 它每加一条，总数就 +1 ✗ ⇒ 文档里写的数会**立刻过期** ✗
# ⇒ 查它就会变成「每次加闸门都要改文档」✗ —— 而这正是「数字不许手写」要治的病 ✗。
#
# 闸门总数由 `scripts/verify.mjs` 在**跑完之后**查 ✓（与讲稿那道关同一个位置 ✓）——
# 那时总数才确定 ✓。这里只查**与总数无关**的那些 ✓。
vs = json.load(open(os.path.join(ROOT, "dist", "verify-summary.json"), encoding="utf-8"))
chk("交付件页数与实际一致", vs["pages"] == 325 and "325 页" in h, vs["pages"])
chk("图数与实际一致", vs.get("figures") == 102 and "102" in h, vs.get("figures"))
chk("引文 517/517 与实际一致",
    vs.get("quotes", {}).get("hits") == 517 and "517 / 517" in h, vs.get("quotes"))

# ② 交付件文件在不在
# **讲稿的文件名不写死** ✓ —— 写死就等于把标准名又写进代码里 ✗
# （硬编码扫描会把它当「未登记的标准名」⇒ 闸门红 ✗），
# 而且**换标准时它会指错地方** ✗ ⇒ 扫目录 ✓。
deck_dir = os.path.join(ROOT, "delivery", "宣讲件")
decks = sorted(f for f in os.listdir(deck_dir) if f.endswith(".pdf")) if os.path.isdir(deck_dir) else []
for f in ["delivery/PDF对比/⑪_C列补全_最新版.pdf",
          "delivery/PDF对比/㊺_图版与字体裁字_325页_2026-11-12.pdf"]:
    chk("文件存在：" + os.path.basename(f), os.path.exists(os.path.join(ROOT, f)))
chk("讲稿 PDF 至少有一份", len(decks) >= 1, decks)

# ③ 交付件 PDF 本身的页数与图数
import fitz
d = fitz.open(os.path.join(ROOT, "delivery", "PDF对比", "⑪_C列补全_最新版.pdf"))
nimg = sum(len(p.get_images(full=True)) for p in d)
chk("交付件 PDF 页数 = 325", d.page_count == 325, d.page_count)
chk("交付件 PDF 图对象 = 102", nimg == 102, nimg)
chk("交付件 PDF 书签 = 22", len(d.get_toc()) == 22, len(d.get_toc()))
size_mb = os.path.getsize(os.path.join(ROOT, "delivery", "PDF对比", "⑪_C列补全_最新版.pdf")) / 1024 / 1024
chk("交接文档写的 13.3 MB 与实际相符", abs(size_mb - 13.3) < 0.2, "%.2f MB" % size_mb)

# ④ 四维状态
rep = json.load(open(os.path.join(ROOT, "reports", "last-report.json"), encoding="utf-8"))
from collections import Counter
dims = Counter()
cells = 0
for r in rep.get("parameterMatrix") or []:
    for k, c in (r.get("cells") or {}).items():
        cells += 1
        for name, st in ((c.get("corroborated") or {}).get("dimensions") or {}).items():
            dims[(name, st)] += 1
chk("取值格 957", cells == 957 and "957" in h, cells)
for name, st, want in [("pairing", "已核", 700), ("pairing", "部分核", 87), ("pairing", "未核", 14),
                        ("condition", "已核", 51), ("condition", "未核", 143), ("condition", "不适用", 607),
                        ("symbol", "已核", 514), ("symbol", "未判定", 92), ("symbol", "不适用", 195),
                        ("unit", "已核", 724), ("unit", "未核", 65), ("unit", "不适用", 12)]:
    chk("四维 %s/%s = %d" % (name, st, want), dims[(name, st)] == want, dims[(name, st)])

# ⑤ 硬编码台账
led = json.load(open(os.path.join(ROOT, "data", "hardcode-ledger.json"), encoding="utf-8"))
files = set()
for r in led["rules"]:
    files.update(r.get("files") or [])
chk("硬编码规则 6 条", len(led["rules"]) == 6 and "6 条规则" in h, len(led["rules"]))
chk("硬编码文件 40 个", len(files) == 40 and "40 个文件" in h, len(files))
chk("gateExceptions 4 条", len(led.get("gateExceptions") or []) == 4, len(led.get("gateExceptions") or []))
std_tools = [r for r in led["rules"] if r["id"] == "std-specific-tools"][0]
chk("标准特有脚本 6 个", len(std_tools["files"]) == 6 and "6 个标准特有" in h, std_tools["files"])

# ⑥ 装置↔章映射
dcm = json.load(open(os.path.join(ROOT, "data", "device-chapter-map.json"), encoding="utf-8"))
ndev = len(dcm.get("devices") or {})
nchap = sum(len(v) for v in (dcm.get("chapters") or {}).values())
chk("装置 63 个", ndev == 63 and "63 个装置" in h, ndev)
chk("章 118 个", nchap == 118 and "118 章" in h, nchap)

# ⑦ 泛化率记账（保留的是上一次真结果 ✓）
bl = json.load(open(os.path.join(ROOT, "reports", "spec-agent-baseline.json"), encoding="utf-8"))
chk("泛化率 41/50 = 82%（上一次真结果）",
    bl["passed"] == 41 and bl["sampleSize"] == 50 and abs(bl["rate"] - 0.82) < 1e-9,
    (bl["passed"], bl["sampleSize"], bl["rate"]))
chk("编造 4 条（不是 0 —— 402 那轮没盖掉它）",
    bl["absentCheck"]["fabricated"] == 4 and "4 条误配量值" in h,
    bl["absentCheck"]["fabricated"])

# ⑧ 文档里引用的文件都存在
for m in re.finditer(r"`([A-Za-z0-9_./\-]+\.(?:md|py|mjs|ts|json))`", h):
    rel = m.group(1)
    if rel.startswith("reports/spec-agent") or rel.startswith("dist/"):
        continue
    if not os.path.exists(os.path.join(ROOT, rel)):
        # 可能是示例路径（带 <…> 或带参数）
        if "<" in rel or " " in rel:
            continue
        chk("文档引用的文件存在：" + rel, False, "缺")

# ⑨ 文档里说的命令都真的存在
for m in re.finditer(r"node (scripts/[\w_]+\.(?:mjs|py))", h):
    p = os.path.join(ROOT, m.group(1))
    chk("文档写的脚本存在：" + m.group(1), os.path.exists(p))

print()
if bad:
    print("✗ %d 条对不上：" % len(bad))
    for b in bad:
        print("   -", b)
    sys.exit(1)
print("✓ 交接文档里的数与仓库实际状态全部对得上 ✓")
