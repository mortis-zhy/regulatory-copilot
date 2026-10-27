import { PDFDocument, rgb, PDFFont, PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "node:fs/promises";
import { ENV } from "../_core/env";

export type SourceDoc = { name: string; version: string };

export type ReportPayload = {
  title: string;
  templateName?: string;
  /** Documents that were analysed — optional so older callers don't crash. */
  sourceDocuments?: SourceDoc[];
  /** Full prose answer (markdown-ish). Rendered ahead of the structured tables. */
  content?: string;
  summary?: string;
  changes?: Array<{ id: string; title: string; type: string; severity: string; oldText: string; newText: string; impact: string; source: string }>;
  parameters?: Array<{ name: string; oldValue: string; newValue: string; unit: string; impact: string; source: string }>;
  evidence?: Array<{ title: string; source: string; url?: string; retrievedAt: string }>;
};

function escapeHtml(value: string | undefined | null) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char] ?? char));
}

export function renderWordHtml(report: ReportPayload) {
  // Every list is optional. The browser always sends all three, but this
  // endpoint is also a public API — a payload carrying only `content` used
  // to crash with "Cannot read properties of undefined (reading 'map')"
  // and surface a raw 500 HTML page instead of a document.
  const docs = (report.sourceDocuments ?? []).map(doc => `<li>${escapeHtml(doc.name)} · ${escapeHtml(doc.version)}</li>`).join("");
  const changes = (report.changes ?? []).map(change => `<tr><td>${escapeHtml(change.id)}</td><td>${escapeHtml(change.title)}</td><td>${escapeHtml(change.type)}</td><td>${escapeHtml(change.severity)}</td><td>${escapeHtml(change.oldText)}</td><td>${escapeHtml(change.newText)}</td><td>${escapeHtml(change.impact)}</td><td>${escapeHtml(change.source)}</td></tr>`).join("");
  const parameters = (report.parameters ?? []).map(item => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.oldValue)}</td><td>${escapeHtml(item.newValue)}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.impact)}</td><td>${escapeHtml(item.source)}</td></tr>`).join("");
  const evidence = (report.evidence ?? []).map(item => `<li><strong>${escapeHtml(item.title)}</strong> · ${escapeHtml(item.source)} · ${escapeHtml(item.retrievedAt)}${item.url ? ` · ${escapeHtml(item.url)}` : ""}</li>`).join("");
  const prose = report.content ? `<h2>分析正文</h2><div class="summary">${escapeHtml(report.content).replace(/\n/g, "<br>")}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(report.title)}</title><style>body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#202020;line-height:1.6}h1{color:#10283f}h2{border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%;font-size:10pt}th,td{border:1px solid #bbb;padding:6px;vertical-align:top}th{background:#eef3f6}small{color:#666}.summary{background:#f7f8ff;padding:12px;border-left:4px solid #5968cc;white-space:pre-wrap}</style></head><body><h1>${escapeHtml(report.title)}</h1><p><small>生成时间：${new Date().toLocaleString("zh-CN")}</small></p>${docs ? `<h2>一、对比范围</h2><ul>${docs}</ul>` : ""}${prose}${report.summary ? `<h2>二、结论摘要</h2><div class="summary">${escapeHtml(report.summary).replace(/\n/g, "<br>")}</div>` : ""}<h2>三、变化点总表</h2><table><thead><tr><th>编号</th><th>变化点</th><th>类型</th><th>影响等级</th><th>原文</th><th>新文</th><th>产品影响</th><th>证据定位</th></tr></thead><tbody>${changes}</tbody></table><h2>四、专业参数</h2><table><thead><tr><th>参数</th><th>旧值</th><th>新值</th><th>单位</th><th>影响</th><th>证据</th></tr></thead><tbody>${parameters}</tbody></table><h2>五、联网调研证据</h2><ul>${evidence}</ul><h2>六、审阅说明</h2><p>本报告由法规智能体生成，所有结论应结合原文定位和专业人员审核后使用。冻结后如输入文件、规则或模型版本变化，应生成新的报告版本。</p></body></html>`;
}

async function loadCjkFont(): Promise<Buffer | null> {
  // Prefer .ttf over .ttc because pdf-lib's bundled fontkit has limited TTC support.
  const candidates = [
    ENV.reportFontPath,
    "C:\\Windows\\Fonts\\simhei.ttf",
    "C:\\Windows\\Fonts\\simsunb.ttf",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "C:\\Windows\\Fonts\\msyh.ttc",
    "C:\\Windows\\Fonts\\msyhbd.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf",
  ];

  for (const path of candidates) {
    if (!path) continue;
    try {
      const bytes = await fs.readFile(path);
      console.log(`[PDF] Found CJK font candidate: ${path} (${bytes.length} bytes)`);
      return bytes;
    } catch (err) {
      console.log(`[PDF] Font not found: ${path} — ${(err as Error).message}`);
    }
  }
  console.warn("[PDF] No CJK font found on system");
  return null;
}

/** Page geometry for A4. */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 44;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM_LIMIT = 56;

/**
 * Break text into lines that fit `maxWidth`, measuring with the real font so
 * CJK / latin mixed content wraps correctly.
 */
function wrapToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!text) return [""];
  const lines: string[] = [];
  let current = "";
  for (const ch of text) {
    const candidate = current + ch;
    let width = 0;
    try {
      width = font.widthOfTextAtSize(candidate, size);
    } catch {
      width = candidate.length * size; // fallback estimate
    }
    if (width > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

/**
 * Render a markdown table block into a PDF table.
 * `rows` already has cells split by `|`.
 */
function drawTable(
  page: PDFPage,
  font: PDFFont,
  rows: string[][],
  startY: number,
  ensurePage: (needed: number) => { page: PDFPage; y: number },
): { page: PDFPage; y: number } {
  const colCount = Math.max(...rows.map(r => r.length));
  const colWidth = CONTENT_W / colCount;
  const cellPad = 3;
  const lineHeight = 9;

  let { page: cur, y } = ensurePage(40);
  const header = rows[0];
  const body = rows.slice(1);

  // Per-column width budget (cap to 5 columns to keep readability).
  const effectiveColCount = Math.min(colCount, 5);
  const effectiveColWidth = CONTENT_W / effectiveColCount;

  const drawRow = (cells: string[], isHeader: boolean) => {
    const display = cells.slice(0, effectiveColCount);
    while (display.length < effectiveColCount) display.push("");
    const cellLines = display.map(cell => wrapToWidth(cell, font, 7.5, effectiveColWidth - cellPad * 2));
    const rowHeight = Math.max(...cellLines.map(l => l.length), 1) * lineHeight + cellPad * 2;

    // Page break: if the row doesn't fit, start a new page and redraw the
    // header on top so the table stays self-contained.
    if (y - rowHeight < BOTTOM_LIMIT) {
      cur = pdf!.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      if (!isHeader) {
        drawRow(header, true);
        return;
      }
    }

    let x = MARGIN;
    for (let c = 0; c < effectiveColCount; c++) {
      const lines = cellLines[c] ?? [""];
      cur.drawRectangle({
        x, y: y - rowHeight, width: effectiveColWidth, height: rowHeight,
        borderColor: rgb(0.82, 0.82, 0.78), borderWidth: 0.4,
        color: isHeader ? rgb(0.98, 0.96, 0.92) : rgb(1, 1, 1),
      });
      let ty = y - cellPad - lineHeight + 2;
      for (const line of lines) {
        cur.drawText(line, { x: x + cellPad, y: ty, size: 7.5, font, color: rgb(0.15, 0.15, 0.15) });
        ty -= lineHeight;
      }
      x += effectiveColWidth;
    }
    y -= rowHeight;
  };

  drawRow(header, true);
  for (const r of body) drawRow(r, false);
  y -= 6;
  return { page: cur, y };
}

/** Reference to the active document so drawTable can add pages. */
let pdf: PDFDocument | null = null;

export async function renderPdf(report: ReportPayload) {
  const doc = await PDFDocument.create();
  pdf = doc;
  doc.registerFontkit(fontkit);

  const fontBytes = await loadCjkFont();
  let font: PDFFont;
  if (fontBytes) {
    try {
      font = await doc.embedFont(fontBytes);
      console.log("[PDF] CJK font embedded successfully");
    } catch (err) {
      console.error("[PDF] Failed to embed CJK font:", (err as Error).message);
      font = await doc.embedFont("Helvetica");
    }
  } else {
    font = await doc.embedFont("Helvetica");
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensurePage = (needed: number) => {
    if (y - needed < BOTTOM_LIMIT) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
    return { page, y };
  };

  const addText = (text: string, size = 10, color = rgb(0.12, 0.12, 0.12), gap = size + 5) => {
    for (const line of wrapToWidth(text, font, size, CONTENT_W)) {
      const r = ensurePage(gap + 4);
      page = r.page; y = r.y;
      page.drawText(line, { x: MARGIN, y, size, font, color });
      y -= gap;
    }
  };

  // ---- Title ----
  addText(report.title, 18, rgb(0.06, 0.16, 0.25), 24);
  addText(`生成时间：${new Date().toLocaleString("zh-CN")}`, 8.5, rgb(0.45, 0.45, 0.45), 16);

  // ---- Source documents ----
  const docs = report.sourceDocuments ?? [];
  if (docs.length) {
    y -= 4;
    addText("一、对比范围", 13, rgb(0.06, 0.16, 0.25), 20);
    for (const d of docs) addText(`• ${d.name}${d.version ? ` · ${d.version}` : ""}`, 9.5, rgb(0.2, 0.2, 0.2), 15);
  }

  // ---- Prose content (the full answer) ----
  if (report.content && report.content.trim()) {
    y -= 8;
    addText("二、分析正文", 13, rgb(0.06, 0.16, 0.25), 20);
    renderProse(report.content, font, addText, ensurePage, (rows, sy) => {
      const r = drawTable(page, font, rows, sy, ensurePage);
      page = r.page; y = r.y;
    });
  }

  // ---- Structured findings ----
  if (report.changes?.length) {
    y -= 8;
    addText("三、变化点总表", 13, rgb(0.06, 0.16, 0.25), 20);
    for (const c of report.changes ?? []) {
      addText(`${c.id}｜${c.title}`, 10, rgb(0.06, 0.16, 0.25), 15);
      addText(`  类型：${c.type}｜影响：${c.severity}${c.impact ? `｜产品影响：${c.impact}` : ""}`, 8.5, rgb(0.35, 0.35, 0.35), 13);
      if (c.oldText || c.newText) addText(`  原文：${c.oldText || "—"}`, 8.5, rgb(0.45, 0.2, 0.2), 13);
      if (c.newText) addText(`  新文：${c.newText}`, 8.5, rgb(0.15, 0.45, 0.25), 13);
      if (c.source) addText(`  定位：${c.source}`, 8.5, rgb(0.4, 0.4, 0.4), 15);
    }
  }

  if (report.parameters?.length) {
    y -= 8;
    addText("四、专业参数", 13, rgb(0.06, 0.16, 0.25), 20);
    const rows = [
      ["参数", "旧值", "新值", "单位", "影响"],
      ...(report.parameters ?? []).map(p => [p.name, p.oldValue || "—", p.newValue || "—", p.unit || "—", p.impact || "—"]),
    ];
    const r = drawTable(page, font, rows, y, ensurePage);
    page = r.page; y = r.y;
  }

  if (report.evidence?.length) {
    y -= 8;
    addText("五、联网调研证据", 13, rgb(0.06, 0.16, 0.25), 20);
    for (const e of report.evidence ?? []) {
      addText(`• ${e.title}`, 9.5, rgb(0.2, 0.2, 0.2), 15);
      addText(`  来源：${e.source}｜时间：${e.retrievedAt}${e.url ? `｜${e.url}` : ""}`, 8.5, rgb(0.4, 0.4, 0.4), 15);
    }
  }

  y -= 10;
  addText("六、审阅说明", 13, rgb(0.06, 0.16, 0.25), 18);
  addText("本报告由法规智能体生成，所有结论应结合原文定位和专业人员审核后使用。标注【待人工确认】的条目须由法务或认证团队核实。", 9, rgb(0.4, 0.4, 0.4), 15);

  pdf = null;
  return doc.save();
}

/**
 * Strip inline markdown emphasis so `**bold**` / `` `code` `` don't leak into
 * the PDF as literal asterisks and backticks.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

/**
 * Render the prose answer. Recognises markdown headings, tables, bullet lists
 * and plain paragraphs so the PDF mirrors what the user saw on screen.
 */
function renderProse(
  content: string,
  font: PDFFont,
  addText: (text: string, size?: number, color?: ReturnType<typeof rgb>, gap?: number) => void,
  ensurePage: (needed: number) => { page: PDFPage; y: number },
  drawTable: (rows: string[][], startY: number) => void,
) {
  const lines = content.split("\n");
  let tableBuf: string[][] = [];

  const flushTable = () => {
    if (tableBuf.length === 0) return;
    const colCount = Math.max(...tableBuf.map(l => (l.match(/\|/g) || []).length - 1), 1);
    const rows = tableBuf.map(l => {
      const cells = stripInlineMarkdown(l).replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      // Pad to the widest row so the PDF table has straight columns.
      while (cells.length < colCount) cells.push("");
      return cells;
    });
    drawTable(rows, 0);
    tableBuf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Table rows — accept rows missing the trailing pipe, which the model
    // emits fairly often.
    if (line.startsWith("|")) {
      // Skip the separator row (|---|---|)
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      tableBuf.push(line);
      continue;
    }
    flushTable();

    const clean = stripInlineMarkdown(line);
    if (clean.startsWith("#### ")) addText(clean.slice(5), 10, rgb(0.1, 0.1, 0.1), 16);
    else if (clean.startsWith("### ")) addText(clean.slice(4), 11, rgb(0.06, 0.16, 0.25), 17);
    else if (clean.startsWith("## ")) addText(clean.slice(3), 12.5, rgb(0.06, 0.16, 0.25), 19);
    else if (clean.startsWith("# ")) addText(clean.slice(2), 14, rgb(0.06, 0.16, 0.25), 22);
    else if (/^[-*]\s+/.test(clean)) addText(`• ${clean.replace(/^[-*]\s+/, "")}`, 9.5, rgb(0.2, 0.2, 0.2), 14);
    else if (/^\d+\.\s+/.test(clean)) addText(clean, 9.5, rgb(0.2, 0.2, 0.2), 14);
    else if (clean === "---") addText(" ", 9.5, rgb(0.2, 0.2, 0.2), 8);
    else addText(clean, 9.5, rgb(0.2, 0.2, 0.2), 14);
  }
  flushTable();
}
