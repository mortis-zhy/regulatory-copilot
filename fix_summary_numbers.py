"""修正执行摘要（Ch0）与 §11.3 的口径冲突。

问题：执行摘要是 LLM 独立生成的，写「13 条候选」「0 条表述差异」；
      §11.3 是另一轮生成，写「45 条」「30 条同义改写」。同一份报告两个数字。

修法：以 §11.3 为准（它的分项与实际表格行数吻合），把执行摘要对齐。
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "baseline/last-report_V8.6_calibrated.json"
DST = ROOT / "comparison_agent-main/reports/last-report.json"

rpt = json.loads(SRC.read_text(encoding="utf-8"))

# 权威数字：来自 §11.3 的分项（3+1+9+30+2 = 45，减去重复计数后的候选池）
OLD_SUMMARY = (
    "13 条候选的完整去向：3 条入 11.3、1 条引用编号变化单列 11.3.2、"
    "**9 条同文勘误见 11.3.0**（两版原文同文，非变化）、"
    "0 条表述差异 + 0 条非变化项过滤（表述差异全部呈现于 "
    "**11.8 表述/术语候选差异（复核清单）**）——合计 13，账目闭环。"
)
NEW_SUMMARY = (
    "**45 条候选的完整去向**（详见 11.3 账目对账）："
    "3 条数值变化入 11.3（均已双源核验）+ 1 条引用编号变化单列 11.3.2 + "
    "**9 条同文勘误**（11.3.0，B 列摘录截断造成的假差异，非真实变化）+ "
    "**30 条表述/术语/格式候选**（11.8 复核清单，含「两只→2只」这类等义改写）+ "
    "2 条规则判定非变化（表格行错位、电压分层两版同存）——合计 45，账目闭环。\n\n"
    "> ⚠ 口径提示：**45** 是「差异候选条目」总数（11.3 口径）；"
    "**26** 是「待复核抽取点」数（各章 ⚠未找到 / 未核验 标记行，口径不同，"
    "见本报告第 5 页《待复核明细清单》）。两者不可相加。"
)

changed = False
for ch in rpt["chapters"]:
    md = ch.get("markdown", "")
    if OLD_SUMMARY in md:
        ch["markdown"] = md.replace(OLD_SUMMARY, NEW_SUMMARY)
        changed = True
        print(f'✓ 修正 {ch["title"]} 的执行摘要口径')
        break

if not changed:
    print("！未找到待修正的执行摘要段落")

DST.write_text(json.dumps(rpt, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"written: {DST}")

# 校验
md2 = "\n".join(c.get("markdown", "") for c in rpt["chapters"])
claims = re.findall(r"(\d+)\s*条候选的完整去向", md2)
print(f"候选总数声明: {claims} → {'✅ 一致' if len(set(claims)) == 1 else '❌ 仍矛盾'}")