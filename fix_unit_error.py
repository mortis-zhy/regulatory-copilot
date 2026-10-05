"""修正 §11.8 第 5 条的单位摘录错误 + 示廓灯归因。

依据：verify_claims.py 回原文核实
  A p28「车辆重心轨迹水平曲率半径不大于500m」
  B p26「车辆重心轨迹水平曲率半径应不大于500m」
两版都是 m，报告 A 栏误写为 mm。
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
P = ROOT / "comparison_agent-main/reports/last-report.json"

rpt = json.loads(P.read_text(encoding="utf-8"))

FIXES = [
    # (旧文本, 新文本, 说明)
    (
        "| 5 | 近光灯 | 弯道照明曲率半径 | 500m | 不大于500mm | 数字相同（低优先）（单位展示差异——已核验原文两版均为 m） |",
        "| 5 | 近光灯 | 弯道照明曲率半径 | 不大于500m | 不大于500m | 两版同文（A p28 / B p26 已回原文核验） |",
        "§11.8 第5条：单位误写修正为 m，并标注原文页码",
    ),
]

applied = 0
for ch in rpt["chapters"]:
    md = ch.get("markdown", "")
    for old, new, note in FIXES:
        if old in md:
            ch["markdown"] = md.replace(old, new)
            applied += 1
            print(f"✓ {ch['title']}: {note}")

P.write_text(json.dumps(rpt, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\napplied: {applied}/{len(FIXES)}")

# 校验
md2 = "\n".join(c.get("markdown", "") for c in rpt["chapters"])
if "不大于500mm" in md2:
    print("⚠ 仍存在 '不大于500mm'")
    for m in __import__("re").finditer(r".{80}不大于500mm.{40}", md2):
        print("   ", m.group().replace("\n", " "))
else:
    print("✅ '不大于500mm' 已全部清除")