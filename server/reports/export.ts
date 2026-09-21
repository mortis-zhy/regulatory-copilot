import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs/promises";
import { ENV } from "../_core/env";

export type ReportPayload = {
  title: string;
  sourceDocuments: Array<{ name: string; version: string }>;
  summary: string;
  changes: Array<{ id: string; title: string; type: string; severity: string; oldText: string; newText: string; impact: string; source: string }>;
  parameters: Array<{ name: string; oldValue: string; newValue: string; unit: string; impact: string; source: string }>;
  evidence: Array<{ title: string; source: string; url?: string; retrievedAt: string }>;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

export function renderWordHtml(report: ReportPayload) {
  const docs = report.sourceDocuments.map(doc => `<li>${escapeHtml(doc.name)} · ${escapeHtml(doc.version)}</li>`).join("");
  const changes = report.changes.map(change => `<tr><td>${escapeHtml(change.id)}</td><td>${escapeHtml(change.title)}</td><td>${escapeHtml(change.type)}</td><td>${escapeHtml(change.severity)}</td><td>${escapeHtml(change.oldText)}</td><td>${escapeHtml(change.newText)}</td><td>${escapeHtml(change.impact)}</td><td>${escapeHtml(change.source)}</td></tr>`).join("");
  const parameters = report.parameters.map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.oldValue)}</td><td>${escapeHtml(item.newValue)}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.impact)}</td><td>${escapeHtml(item.source)}</td></tr>`).join("");
  const evidence = report.evidence.map(item => `<li><strong>${escapeHtml(item.title)}</strong> · ${escapeHtml(item.source)} · ${escapeHtml(item.retrievedAt)}${item.url ? ` · ${escapeHtml(item.url)}` : ""}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#202020;line-height:1.6}h1{color:#10283f}h2{border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%;font-size:10pt}th,td{border:1px solid #bbb;padding:6px;vertical-align:top}th{background:#eef3f6}small{color:#666}.summary{background:#f7f8ff;padding:12px;border-left:4px solid #5968cc}</style></head><body><h1>${escapeHtml(report.title)}</h1><p><small>生成时间：${new Date().toLocaleString("zh-CN")}</small></p><h2>一、对比范围</h2><ul>${docs}</ul><h2>二、结论摘要</h2><div class="summary">${escapeHtml(report.summary).replace(/\n/g, "<br>")}</div><h2>三、变化点总表</h2><table><thead><tr><th>编号</th><th>变化点</th><th>类型</th><th>影响等级</th><th>原文</th><th>新文</th><th>产品影响</th><th>证据定位</th></tr></thead><tbody>${changes}</tbody></table><h2>四、专业参数</h2><table><thead><tr><th>参数</th><th>旧值</th><th>新值</th><th>单位</th><th>影响</th><th>证据</th></tr></thead><tbody>${parameters}</tbody></table><h2>五、联网调研证据</h2><ul>${evidence}</ul><h2>六、审阅说明</h2><p>本报告由法规智能体生成，所有结论应结合原文定位和专业人员审核后使用。冻结后如输入文件、规则或模型版本变化，应生成新的报告版本。</p></body></html>`;
}

function wrapText(text: string, maxChars = 42) {
  const chars = Array.from(text);
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += maxChars) lines.push(chars.slice(i, i + maxChars).join(""));
  return lines.length ? lines : [""];
}

export async function renderPdf(report: ReportPayload) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  let font;
  try {
    const bytes = await fs.readFile(ENV.reportFontPath);
    font = await pdf.embedFont(bytes, { subset: true });
  } catch {
    font = await pdf.embedFont("Helvetica");
  }
  let page = pdf.addPage([595, 842]);
  let y = 800;
  const addLine = (text: string, size = 10, color = rgb(0.12, 0.12, 0.12)) => {
    for (const line of wrapText(text, size > 16 ? 30 : 52)) {
      if (y < 48) { page = pdf.addPage([595, 842]); y = 800; }
      page.drawText(line, { x: 42, y, size, font, color });
      y -= size + 6;
    }
  };
  addLine(report.title, 20, rgb(0.06, 0.16, 0.25)); y -= 8;
  addLine(`生成时间：${new Date().toLocaleString("zh-CN")}`, 9, rgb(0.4, 0.4, 0.4)); y -= 10;
  addLine("一、对比范围", 14, rgb(0.06, 0.16, 0.25));
  report.sourceDocuments.forEach(doc => addLine(`• ${doc.name} · ${doc.version}`)); y -= 8;
  addLine("二、结论摘要", 14, rgb(0.06, 0.16, 0.25));
  report.summary.split("\n").forEach(line => addLine(line)); y -= 8;
  addLine("三、变化点", 14, rgb(0.06, 0.16, 0.25));
  report.changes.forEach(change => addLine(`${change.id}｜${change.title}｜${change.type}｜${change.severity}｜${change.impact}`)); y -= 8;
  addLine("四、专业参数", 14, rgb(0.06, 0.16, 0.25));
  report.parameters.forEach(item => addLine(`${item.name}：${item.oldValue} → ${item.newValue} ${item.unit}｜${item.impact}`)); y -= 8;
  addLine("五、联网调研证据", 14, rgb(0.06, 0.16, 0.25));
  report.evidence.forEach(item => addLine(`${item.title}｜${item.source}｜${item.retrievedAt}`));
  return pdf.save();
}
