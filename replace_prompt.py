import re

path = r"C:\Users\zsndz\Desktop\comparison_agent-main\comparison_agent-main\client\src\pages\Home.tsx"
with open(path, "r", encoding="utf-8") as f:
    text = f.read()

# Find from "const docContext" to the next line containing only "const trimmedHistory"
# (the docContext template literal is well-defined)
start_marker = "  const docContext = docs.length"
end_marker = "  const trimmedHistory = history"

i = text.index(start_marker)
j = text.index(end_marker, i)

old_block = text[i:j]
print(f"Old block ({len(old_block)} chars):")
print(repr(old_block[:300]))
print("...")

new_block = """  const docContext = docs.length
    ? `\\n\\n[当前已上传 ${docs.length} 份文件]\\n${docSummaries}\\n\\n请严格基于上述真实文本进行分析${docs.length >= 2 ? "——多文件时按上传顺序识别为 A、B、C 等基线" : ""}。

【核心要求——你必须逐条列出具体改动】不要只做"结构对齐"或"概括"。"内容对比"层必须：

1. **新增条款**：草案相对于现行版全新加入了什么（条款号 + 原文摘录 + 页码）
2. **修改条款**：哪些条款的数值、文字、范围变了（旧文摘录 vs 新文摘录 + 章节号 + 页码）
3. **删除条款**：2019 版有哪些内容被草案删除了（旧文摘录 + 章节号）
4. **引用关系变化**：条款 X 现在引用了章节 Y，而以前没有（指明新增的引用）
5. **数值参数变化**：所有能从文档中找到的数值（强度、频率、尺寸、时间、电压等）只要在不同文档中数值不同就要列出
6. **每一条改动**都必须包含：旧文原文摘录 + 新文原文摘录 + 章节号 + 页码 + 是哪种改动（新增/修改/删除/引用变化）

【重要】你的回答必须包含两个部分：
第一部分：按"结构对齐 → 内容对比 →专业参数 → 联网证据"四层组织的详细分析（markdown 格式）。changes 至少 15 条。
第二部分：在回答末尾必须输出一个 JSON 代码块，格式为 \\\\`\\\\`\\\\`json \\\\\\.\\\\\.\\\\\. \\\\\`\\\\`\\\\` 结束，包含以下三个数组：
- changes: 每个变化点包含 id、title、type（added/removed/modified/renumbered）、severity、oldExcerpt、newExcerpt、anchor。至少 15 条。
- parameters: 每个参数包含 name、oldValue、newValue、unit、source。至少 10 条。
- evidence: 每条证据包含 title、sourceName、sourceUrl、level。

每条结论必须给出来源页码 / 章节号 / 表号等原文锚点；找不到的内容请使用【待人工确认】前缀。]`
    : `\\n\\n[当前未上传任何文件。请明确告知需要补充的材料，并按照\\"结构对齐 → 内容对比 →专业参数 → 联网证据\\"四层承诺交付物。]`;
"""

text = text[:i] + new_block + text[j:]
with open(path, "w", encoding="utf-8") as f:
    f.write(text)
print("✅ done")
