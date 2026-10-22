# -*- coding: utf-8 -*-
"""核验 GB4785 表 11.6 那 9 条数据指标 —— **直接读源 PDF**，不经过 MinerU。

为什么要有这一层
----------------
报告 11.4 节的 9 条指标来自 `reportV6.ts` 对 MinerU 文本的**正则扫描**。
那条链路有三个已知的失真点：

  1. MinerU 把同一个值写成两种形态 —— A 版「各20°」、B 版「$2 0 ^ { \\circ }$」；
     不归一化就会**造出一条假的版本差异**。
  2. 正则按主题名首次命中，会打到**别的条款**（如 DRL 的角度打到远光灯的 5.1.5）。
  3. 正则要求原文里没有的符号（如 ±），于是**永远匹配不上** ——
     结果被写成「[未找到]」，而原文其实有。

这三条都表现为「报告说没有，原文其实有」——比写错数值更隐蔽，因为读者无从发现。

所以这一层**绕开 MinerU**，用 fitz 直接读源 PDF：
  · 值  → 在指定的那一页上必须能查到
  · 页  → 必须是源 PDF 的真实页序
  · 缺失 → 必须在三版全文里都检索不到（否则是「没查对」，不是「没有」）

用���： python scripts/verify_indicators.py [--json]
"""
import importlib.util, io, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Windows 控制台默认 GBK —— 中文能印，「✓」「✗」不能。
# 闸门会把这个脚本的 stdout 直接读进断言里，编码错一个字符就是一次假失败。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

sys.path.insert(0, os.path.join(ROOT, "scripts"))
try:
    import fitz  # PyMuPDF
except Exception as e:  # pragma: no cover
    print("需要 PyMuPDF：%s" % e)
    raise SystemExit(2)


def _load(name, path):
    s = importlib.util.spec_from_file_location(name, path)
    m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m)
    return m


cs = _load("cs", os.path.join(ROOT, "scripts", "clause_split.py"))

# 归一化：把 PDF 文本里的全角/半角、空格、单位写法拉平
def norm(t):
    t = (t or "").replace("　", "")
    t = re.sub(r"\s+", "", t)
    return t


# 每条指标：
#   label / found = {版本: (值, 页)} 或 {}（缺失）
#   absent_in    = 必须在这些版本全文里 0 命中的关键词
#   probes       = 值必须在该页上出现的形态（多个候选，任一命中即可）
INDICATORS = [
    {
        "id": "drl_min_cd",
        "label": "DRL 转向冲突时减光后最大光强",
        "found": {"A": ("140", 57)},
        "absent_in": [],
        "probes": {"A": [r"最大光强不大于140cd"]},
        "why": "A 5.19.7.6 量化上限；B 无 cd 上限（5.19.7.5 只说「降低发光强度」）",
    },
    {
        "id": "ess_freq_hz",
        "label": "ESS 紧急制动信号闪烁频率",
        "found": {"B": ("4.0", 54), "A": ("4.0", 70)},
        "absent_in": [],
        "probes": {
            "B": [r"以\s*[(（]\s*4\s*\.\s*0\s*±\s*1\s*\.\s*0\s*[)）]\s*Hz"],
            "A": [r"以\s*[(（]\s*4\s*\.\s*0\s*±\s*1\s*\.\s*0\s*[)）]\s*Hz"],
        },
        "why": "B 5.23.7.1 / A 7.2.7.1 —— 两版都是 4.0±1.0 Hz",
    },
    {
        "id": "ess_cd",
        "label": "ESS 光度",
        "found": {},
        "absent_in": ["紧急制动信号"],
        "absent_probe": r"紧急制动信号[\s\S]{0,200}?(?:发光强度|光强|光度)\s*\d+\s*cd",
        "why": "B 5.23 全节无光度条款；ESS 只规定闪烁频率",
    },
    {
        "id": "drl_vis_deg",
        "label": "DRL 可见度角度",
        "found": {"B": ("20", 47), "A": ("20", 56)},
        "absent_in": [],
        "probes": {
            "B": [r"水平方向角\s*[βb]?\s*[:：]\s*向外、向内各\s*20\s*°"],
            "A": [r"水平方向角\s*[βb]?\s*[:：]\s*向外、向内各\s*20\s*°"],
        },
        "why": "B 5.19.5 / A 5.19.5 —— 两版都是各 20°（GB4785 声称的 25° 不存在）",
    },
    {
        "id": "side_marker_m",
        "label": "侧标志灯间距",
        "found": {"B": ("3", 46), "A": ("3", 55)},
        "absent_in": [],
        "probes": {
            "B": [r"两相邻侧标志灯的间距应不大于3m"],
            "A": [r"两相邻侧标志灯的间距应不大于3m"],
        },
        "why": "B 5.18.4.3 / A 5.18.4.3 —— 两版都是 3m（可增至 4m）",
    },
    {
        "id": "led_life_h",
        "label": "LED 寿命",
        "found": {},
        "absent_in": ["寿命"],
        "why": "三版全文 0 次「寿命」；光源寿命属光源标准（GB 15766 / UN R37 / R99 / R128）",
    },
    {
        "id": "lumen_pct",
        "label": "光通维持率",
        "found": {},
        "absent_in": ["光通维持率"],
        "why": "三版只有「目标光通量」（A 3.2.2 / B 3.7.8），无「光通维持率」",
    },
    {
        "id": "preheat_min",
        "label": "预热点灯时间",
        "found": {},
        "absent_in": ["预热"],
        "why": "三版全文 0 次「预热」",
    },
    {
        "id": "afs_switch_s",
        "label": "AFS 切换时间",
        "found": {},
        "absent_in": ["切换时间"],
        "why": "B 5.22「自适应前照明系统」全节无「切换时间」；全文「切换」只在附录 H 与 4.9b",
    },
]


def main():
    docs = cs.pick_docs()
    versions = cs.ordered_versions(docs)
    pages = {}   # version -> [page text]
    for v in versions:
        d = fitz.open(docs[v])
        pages[v] = [d[i].get_text() for i in range(d.page_count)]
        d.close()

    fails = []
    checks = 0

    for ind in INDICATORS:
        # 1) 找到的：值必须在**指定的那一页**上
        for v, (val, pg) in (ind.get("found") or {}).items():
            if v not in pages:
                fails.append("%s：版本 %s 不存在" % (ind["id"], v))
                continue
            total = len(pages[v])
            if not (1 <= pg <= total):
                fails.append("%s：%s 第%d页超出范围（共 %d 页）" % (ind["id"], v, pg, total))
                continue
            text = pages[v][pg - 1]
            probes = (ind.get("probes") or {}).get(v) or []
            ok = any(re.search(p, text) for p in probes)
            checks += 1
            if not ok:
                fails.append(
                    "%s：%s 第%d页上找不到 %s（页上应有 %s）"
                    % (ind["id"], v, pg, val, " 或 ".join(probes))
                )

        # 2) 缺失的：关键词必须在三版全文里都 0 命中
        for kw in ind.get("absent_in") or []:
            pat = ind.get("absent_probe")
            for v in versions:
                joined = norm("".join(pages[v]))
                if pat:
                    hit = re.search(pat.replace(" ", ""), joined) is not None
                else:
                    hit = norm(kw) in joined
                checks += 1
                if hit:
                    fails.append(
                        "%s：声称「原文里没有」，但 %s 版全文能查到「%s」—— "
                        "这是检索没找对，不能写成「未找到」" % (ind["id"], v, kw)
                    )

    out = {
        "checks": checks,
        "failures": fails,
        "indicators": len(INDICATORS),
        "versions": versions,
    }
    if "--json" in sys.argv:
        print(json.dumps(out, ensure_ascii=False, indent=1))
    else:
        print("=== 9 条指标回源核验：%d 项检查，%d 项失败" % (checks, len(fails)))
        for f in fails:
            print("  ✗ " + f)
        if not fails:
            print("  ✓ 全部命中：找到的值在指定源 PDF 页上；缺失的关键词在三版全文 0 命中")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
