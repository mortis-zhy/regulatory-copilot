"""口径说明前置 + 术语对照表 + §11.7 边界强化。

回应评审三点：
1. 「章节新增 vs 主题级零新增」不是矛盾，是两个维度 → 在 §11.1/§11.2 与执行摘要
   同步加【口径说明】
2. 发光面/视表面/透光面 **物理含义不同**（回原文核实：A p7「透光面 light emitting
   surface」= 光线穿过的配光镜外表面；「发光面 illuminating surface」= 灯具有效辐射面），
   不能替换 → 改为在符号说明页加术语对照表
3. §11.7.1 是模型推断 → 标题后加黑体边界提示，每条加「推演」标签
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
P = ROOT / "comparison_agent-main/reports/last-report.json"
rpt = json.loads(P.read_text(encoding="utf-8"))

CALIBER = """> **【口径说明】** 本章的新增 / 删除按**两个维度**分别统计，二者视角不同，**并非矛盾**：
> - **① 文本结构维度**：分「章节级」（新增整章，如第 6 章从属功能、第 7 章扩展功能）
>   与「子条款级」（章节内新增装置条款）。用于标准文档管理、条款号映射、认证目录更新。
> - **② 功能主题维度**：基于 18 项传统照明固定主题（远光 / 近光 / 转向 / 制动 / 位置 …）。
>   本版**零新增**指这 18 类传统灯具大类在新旧版本中均有完整覆盖，未出现全新灯具门类。
>   用于传统灯具平台的兼容性快速评估。
>
> 两套维度均为工程师高频场景，请按需取用，**不要交叉相加**。
"""

EXEC_NOTE = (
    "> **【口径说明】** 上述「新增 9 项」为**文本结构维度**（2 章节级 + 7 装置级）；"
    "第 11 章另按**功能主题维度**统计传统照明门类（18 项固定主题，本版零新增）。"
    "两套维度视角不同，均非矛盾，详见 §11.1。\n\n"
)

BOUNDARY = (
    "> ## ⚠ 阅读前必读\n"
    "> **本节为基于条款文本的工程影响推演，不是标准原文规定，也不构成合规判定依据。**\n"
    "> 依据是 §11.1–§11.6 已锁定的条款事实，判断方式是模型推演（标记「推演」）。\n"
    "> 同一条款变化对乘用车 / 商用车 / 越野车的影响范围完全不同\n"
    "> （例：倒车灯高度放宽仅涉及 N2G/N3G 等越野类）。\n"
    "> **具体影响必须结合车辆类别、整车架构、认证状态逐项评估。**\n\n"
)

applied = {"caliber": 0, "exec": 0, "boundary": 0}

for ch in rpt["chapters"]:
    md = ch.get("markdown", "")
    title = ch.get("title", "")

    # 1. §11.1 / §11.2 口径说明
    if "11.1 新增条款汇总" in md and "【口径说明】" not in md:
        md = md.replace(
            "## 11.1 新增条款汇总",
            "## 11.1 新增条款汇总\n\n" + CALIBER,
            1,
        )
        ch["markdown"] = md
        applied["caliber"] += 1
        print(f'✓ {title}: §11.1 已加双维度口径说明')

    # 2. 执行摘要同步
    if "【核心结论】" in md or "核心结论" in md:
        if "【口径说明】" not in md:
            anchor = "**1. 结构变化**"
            i = md.find(anchor)
            if i > 0:
                # 找到这一段结束（下一个 **2.）
                j = md.find("**2.", i)
                if j > 0:
                    md = md[:j] + EXEC_NOTE + md[j:]
                    ch["markdown"] = md
                    applied["exec"] += 1
                    print(f'✓ {title}: 执行摘要已加口径说明')

    # 3. §11.7 边界提示
    if "11.7 关键变化点的影响分析" in md and "阅读前必读" not in md:
        md = md.replace(
            "### 11.7 关键变化点的影响分析",
            "### 11.7 关键变化点的影响分析\n\n" + BOUNDARY,
            1,
        )
        ch["markdown"] = md
        applied["boundary"] += 1
        print(f'✓ {title}: §11.7 已加强制边界提示')

P.write_text(json.dumps(rpt, ensure_ascii=False, indent=2), encoding="utf-8")
print(f"\napplied: {applied}")
print("术语对照表 → 下一步在渲染器符号说明页加（不改报告正文）")