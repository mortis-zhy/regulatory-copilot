import re

path = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\client\src\pages\Home.tsx"
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

start_marker = "  const docContext = docs.length\n    ? `"
# Find the start position
start_idx = text.find(start_marker)
if start_idx < 0:
    print("not found")
    raise SystemExit(1)

# Find the matching closing backtick + semi. The structure is:
#   ? `...`
#   : `...`;
# So we find the first standalone ":`" at line start followed by "`...`;"
# Easier: find the closing pattern that is ";\n  const trimmedHistory"
end_marker = "  const trimmedHistory"
end_idx = text.find(end_marker, start_idx)
if end_idx < 0:
    print("end not found")
    raise SystemExit(1)

new_block = r"""  const docContext = docs.length
    ? `\n\n[当前已上传 ${docs.length} 份文件]\n${docSummaries}\n\n请严格基于上述真实文本进行分析${docs.length >= 2 ? "——多文件时按上传顺序识别为 A、B、C 等基线" : ""}。\n\n【强制要求——逐章生成详细数据表格】\n\n请按以下顺序逐章生成对比内容，每章给出真实数据表格（不要只做概括）：\n\n## 章节对比模板（每章必填）\n对每份 PDF 的第 N 章，输出一行表格：\n\n| 章节号 | A（草案）具体内容 | B（2019 版）具体内容 | 差异（新增/修改/删除/无变化） |\n|---|---|---|---|\n\n## 必须覆盖的章节\n1. 远光灯条款（找 "远光灯"、"high beam"、"远光"）\n2. 近光灯条款（找 "近光灯"、"dipped beam"、"近光"）\n3. 前雾灯条款（"前雾灯"、"front fog lamp"）\n4. 转向信号灯条款（"转向"、"direction indicator"、"闪烁频率 Hz"）\n5. 倒车灯条款（"倒车灯"、"reversing lamp"）\n6. 位置灯条款（"位置灯"、"position lamp"）\n7. 制动灯条款（"制动灯"、"stop lamp"、"制动信号"）\n8. 牌照灯条款（"牌照灯"、"rear registration plate"）\n9. 危险警告信号（"危险警告"、"hazard"）\n10. 安装尺寸（"安装高度"、"安装角度"、"尺寸要求"）\n11. 试验条件（"试验电压"、"试验方法"、"环境条件"）\n12. 章节体系（"第 X 章"、"主功能/从属功能/扩展"）\n\n每一条要求包含：\n- 原文摘录（A/B/C 各自的原文片段，至少 20 字）\n- 具体数值（强度 cd、频率 Hz、尺寸 mm/°、时间 s、电压 V 等）\n- 章节号 + 页码（例如 "B 第 22 页"）\n\n【重要】你的回答必须包含两个部分：\n第一部分：按"结构对齐 → 内容对比 →专业参数 → 联网证据"四层组织的详细分析（markdown 格式）。内容对比部分必须包含至少 12 个章节对比表格（按上面的章节清单），每个表格至少 3-5 行数据。\n第二部分：在回答末尾必须输出一个 JSON 代码块（三个反引号包 json 开头，三个反引号结束），包含以下三个数组：\n- changes: 每个变化点包含 id、title、type（added/removed/modified/renumbered）、severity、oldExcerpt、newExcerpt、anchor。至少 20 条。\n- parameters: 每个参数包含 name、oldValue、newValue、unit、source。至少 20 条。\n- evidence: 每条证据包含 title、sourceName、sourceUrl、level。\n\n每条结论必须给出来源页码 / 章节号 / 表号等原文锚点；找不到的内容请使用【待人工确认】前缀。]`
    : `\n\n[当前未上传任何文件。请明确告知需要补充的材料，并按照\"结构对齐 → 内容对比 →专业参数 → 联网证据\"四层承诺交付物。]`;
"""

text = text[:start_idx] + new_block + text[end_idx:]
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
print("✅ docContext replaced")
