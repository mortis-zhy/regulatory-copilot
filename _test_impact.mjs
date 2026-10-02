import { buildHtml } from "./dist/htmlRenderV8.js";

const report = {
  outline: { title: "T", chapters: [{ id: 1, title: "t", sections: [] }], appendices: [] },
  chapters: [
    {
      id: 1,
      title: "影响卡测试",
      markdown: [
        "## 测试节",
        "",
        "| 版本 | 条款 | 页码 | 原文摘录 |",
        "|---|---|---|---|",
        "| **A** | 5.2.6 | 第27页 ✓ | A 版原文摘录内容示例。 |",
        "| **B** | 5.2.6 | 第25页 ✓ | B 版原文摘录内容示例。 |",
        "",
        "> 🔧 设计影响：灯具外壳需重新开模以容纳 AFS 单元（15 天模具周期）",
        "> 🧪 测试影响：新增近光 4° 对称性测试",
        "> 📋 认证影响：型式认证新增 1 道工序，周期 +2-3 周",
        "> ⚠ 风险等级：中（GB 4785 §5.2.6 新增条款）",
        "",
        "**变化判定**：`实质差异`｜工程师核验任务：请逐字比对差异。",
      ].join("\n"),
    },
  ],
  sourceDocuments: [],
  generatedAt: "2026-09-30",
};

const html = await buildHtml(report, [], { withAnchors: false });
const checks = {
  "impact-matrix present": html.includes('class="impact-matrix"'),
  "4 impact cells": (html.match(/class="impact-cell"/g) || []).length === 4,
  "design text": html.includes("重新开模"),
  "test text": html.includes("4° 对称性"),
  "cert text": html.includes("1 道工序"),
  "risk chip": html.includes("风险等级") && html.includes("中（GB 4785"),
  "C placeholder card": html.includes("源数据未提供"),
  "verdict strip red": html.includes('verdict-strip v-red') && html.includes("实质差异"),
  "triptych present": html.includes('class="triptych"'),
};
let pass = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "PASS" : "FAIL"} - ${k}`);
  if (v) pass++;
}
console.log(`${pass}/${Object.keys(checks).length} passed`);
process.exit(pass === Object.keys(checks).length ? 0 : 1);
