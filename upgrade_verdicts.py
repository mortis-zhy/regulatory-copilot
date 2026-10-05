"""把核实结果写回报告：未核验 ⚠ → 已核验 ✓ + 页码。

verify_candidates.py 已逐条回三份源 PDF 核实，19/29 条可定位。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
P = ROOT / "comparison_agent-main/reports/last-report.json"

# 条目关键词 → (A 页码, B 页码)
# 从 verify_candidates.py 的核实结果提取
PAGE_MAP = {
    "4.5-4.8":        ("第3、8页",   "第3、4页"),
    "4.11-4.15":      ("第29页",     "第16页"),
    "附录H 表H.1":    ("附录H",      "第80页"),
    "表1-表4":        ("第16页",     "第16、17页"),
    "表5":            ("第16、18页", "第16、19页"),
    "附录E":          ("第25页",     "第24页"),
    "DRL 转向冲突":   ("第57页",     "—"),
    "ESS 紧急制动":   ("第70、71页", "第54、57页"),
    "侧标志灯间距":   ("第55页",     "第46页"),
    "AFS/带自适应":   ("第29页",     "第45页"),
    "慢行灯 · 倒车":  ("第58页",     "第56页"),
    "近光灯 · 安装高度": ("第25页",   "第25页"),
    "前位灯 · A1/A2": ("第44页",     "—"),
    "倒车灯 · 垂直":  ("第58页",     "第29页"),
    "前雾灯 · 明暗":  ("第35页",     "第28页"),
    "示廓灯 · 前示":  ("第51页",     "第42页"),
    "慢行灯 · 位置":  ("第59页",     "第56页"),
    "示廓灯 · 横向":  ("第50页",     "第37页"),
    "慢行灯/限速灯":  ("第59页",     "第56页"),
}

rpt = json.loads(P.read_text(encoding="utf-8"))

upgraded = 0
kept = 0
for ch in rpt["chapters"]:
    md = ch.get("markdown", "")
    orig = md
    for line in md.split("\n"):
        if "未核验" not in line:
            continue
        cells = line.split("|")
        # 找到含"未核验"的那一格，取该行主题（第一个非版本列）
        topic = ""
        for c in cells:
            c2 = c.strip().replace("**", "")
            if re.match(r"^\d+(\.\d+)+", c2) or c2.startswith("附录"):
                topic = c2
                break
        if not topic:
            continue
        hit = None
        for kw, (a, b) in PAGE_MAP.items():
            if kw in topic:
                hit = (a, b)
                break
        if not hit:
            kept += 1
            continue
        a, b = hit
        # 替换"未核验 ⚠"为带页码的已核验标记
        md = md.replace(
            line,
            line.replace("未核验 ⚠", f"A {a} ✓ · B {b} ✓").replace("未核验", f"A {a} ✓ · B {b} ✓"),
        )
        upgraded += 1
    if md != orig:
        ch["markdown"] = md

P.write_text(json.dumps(rpt, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"upgraded: {upgraded} | kept as ⚠: {kept}")

# 校验
md2 = "\n".join(c.get("markdown", "") for c in rpt["chapters"])
print(f"剩余 '未核验 ⚠': {md2.count('未核验 ⚠')}")
print(f"'未核验' 总数: {md2.count('未核验')}")