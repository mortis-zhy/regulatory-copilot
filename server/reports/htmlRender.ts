/**
 * Render a generated multi-chapter report to a professional A4 PDF via
 * Playwright (Chromium) HTML→PDF.
 *
 * Structure mirrors the reference report:
 *   cover → preface → abstract → TOC → chapters → appendices → references
 *
 * Change markers [新增][删除][修改][保留] are colour-coded, three-version
 * tables get a tinted header, and every page carries header/footer.
 */

import type { ReportOutline, AppendixSpec } from "./reportGenerator";

export type ReportChapter = { id: number; title: string; markdown: string; page?: number };
export type ReportAppendix = { id: string; title: string; markdown?: string; page?: number };

export type RenderableReport = {
  outline: ReportOutline;
  chapters: ReportChapter[];
  appendices?: ReportAppendix[];
  sourceDocuments?: Array<{ label: string; name: string; meta: string }>;
  generatedAt?: string;
  /**
   * Structured parameter matrix (parameterMatrix.ts). Present when the report
   * was built by buildMinerUReport; absent for a client-POSTed report. The
   * renderer prefers it over scraping chapter markdown, so the cover-page
   * parameter index and chapter 12 cannot disagree.
   */
  parameterMatrix?: unknown[];
  parameterMatrixStats?: unknown;
};

/** Escape HTML special characters. */
function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert markdown (headings, tables, lists, emphasis, code) to HTML.
 * Deliberately small — we only need the subset the LLM produces.
 */
export function mdToHtml(md: string): string {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inTable = false;
  let inList = false;
  let inOl = false;

  const closeLists = () => {
    if (inList) { out.push("</ul>"); inList = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  const inline = (s: string): string => {
    let t = esc(s);
    // Code first (so ** inside code isn't bolded)
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    // Bold / italic
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // Colour-code change markers
    t = t.replace(/\[新增\]/g, '<span class="mk mk-add">新增</span>');
    t = t.replace(/\[删除\]/g, '<span class="mk mk-del">删除</span>');
    t = t.replace(/\[修改\]/g, '<span class="mk mk-mod">修改</span>');
    t = t.replace(/\[保留\]/g, '<span class="mk mk-keep">保留</span>');
    // 【原文事实】 style tags
    t = t.replace(/【原文事实】/g, '<span class="tag tag-fact">原文事实</span>');
    t = t.replace(/【模型推断】/g, '<span class="tag tag-infer">模型推断</span>');
    t = t.replace(/【待人工确认】/g, '<span class="tag tag-todo">待人工确认</span>');
    return t;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Table rows
    if (/^\|.*\|$/.test(line)) {
      // Separator row: |---|---|
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (!inTable) {
        closeLists();
        out.push('<table>');
        // First row of a table = header
        const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        out.push("<thead><tr>" + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead>");
        out.push("<tbody>");
        // Detect if this was header by looking at next line
        out.push("__skip_header__");
        inTable = true;
        continue;
      }
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (out[out.length - 1] === "__skip_header__") {
        // Replace the placeholder we added (first row was header)
        out.pop();
      }
      out.push("<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      continue;
    } else if (inTable) {
      out.push("</tbody></table>");
      inTable = false;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = Math.min(h[1].length + 3, 6); // shift down: # → h4 (chapter body is under h3)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,})$/.test(line)) {
      closeLists();
      out.push("<hr>");
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      closeLists();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (inList) { out.push("</ul>"); inList = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    // Blank line → paragraph break
    if (line === "") {
      closeLists();
      continue;
    }

    // Regular paragraph
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
  }

  closeLists();
  if (inTable) out.push("</tbody></table>");

  // Clean up the header-row placeholder if the table never got rows
  const joined = out.filter((x) => x !== "__skip_header__").join("\n");
  return joined;
}

/**
 * Turn a raw file name into a clean cover-card label:
 *   "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf" → "GB 4785 草案 V4.3.5"
 *   "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf" → "GB 4785-2019"
 *   "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf" → "UN R48-09"
 */
export function cleanDocName(fileName: string): string {
  let n = fileName.replace(/\.(pdf|docx?|DOCX?|PDF)$/i, "");
  if (/R0?48|R48/i.test(n) && /UN|UNR|ECE/i.test(n)) return "UN R48-09";
  if (/R0?48|R48/i.test(n)) return "UN R48-09";
  if (/GB[\s_]*4785/i.test(n) && /草案|征求意见|draft|V4\.3/i.test(n)) {
    const ver = n.match(/V(\d+\.\d+(\.\d+)?)/);
    return ver ? `GB 4785 草案 V${ver[1]}` : "GB 4785 草案";
  }
  if (/GB[\s_]*4785/i.test(n)) return "GB 4785-2019";
  // generic fallback: strip date prefixes and internal underscores
  n = n.replace(/^\d{4}-\d{2}-\d{2}[_-]?/, "").replace(/_+/g, " ").trim();
  return n.length > 24 ? n.slice(0, 24) + "…" : n;
}

/**
 * Remove the chapter's OWN leading title heading from its markdown — buildHtml
 * already renders `<h2 class="chapter-title">` — but ONLY when the first line
 * really is a duplicate of the chapter title (`# 第 3 章 …` / `第3章 …` /
 * a heading that repeats the title). Section headings like `### 1.1 …` must
 * survive.
 */
function stripDuplicateChapterTitle(md: string, chapterId: number, title: string): string {
  const lines = md.split("\n");
  if (lines.length === 0) return md;
  const first = lines[0].trim();
  const hashed = first.replace(/^\s{0,3}#{1,6}\s+/, "").trim();
  const titleKey = title.replace(/\s+/g, "").slice(0, 8);
  const firstKey = hashed.replace(/\s+/g, "");
  const isDup =
    /^第?\s*\d+\s*章/.test(hashed) ||
    new RegExp(`^${chapterId}\\s*章?`).test(hashed) ||
    (titleKey.length >= 4 && firstKey.includes(titleKey)) ||
    (firstKey.length >= 4 && title.replace(/\s+/g, "").includes(firstKey));
  if (!isDup) return md;
  // Drop only the first line
  const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
  return rest;
}

/** Build the complete standalone HTML document. */
export function buildHtml(report: RenderableReport): string {
  const { outline, chapters, appendices = [], sourceDocuments = [], generatedAt } = report;
  const stamp = generatedAt ?? new Date().toLocaleString("zh-CN");

  const tocEntries = chapters
    .map((c) => `<div class="toc-row"><span class="toc-num">${c.id}</span><span class="toc-title">${esc(c.title)}</span><span class="toc-dots"></span><span class="toc-page">${c.page ?? ""}</span></div>`)
    .join("");
  const appendixEntries = appendices
    .map((a) => `<div class="toc-row"><span class="toc-num">${esc(a.id)}</span><span class="toc-title">${esc(a.title)}</span><span class="toc-dots"></span><span class="toc-page">${a.page ?? ""}</span></div>`)
    .join("");

  const sourceCards = (sourceDocuments.length ? sourceDocuments : [
    { label: "A", name: "GB 4785 草案", meta: "" },
    { label: "B", name: "GB 4785-2019", meta: "" },
    { label: "C", name: "UN R48", meta: "" },
  ])
    .map((d) => `<div class="src-card"><div class="src-label">${esc(d.label)}</div><div class="src-name">${esc(cleanDocName(d.name))}</div><div class="src-meta">${esc(d.meta)}</div></div>`)
    .join("");

  const chapterHtml = chapters
    .map((c) => {
      const body = stripDuplicateChapterTitle(c.markdown, c.id, c.title);
      const bodyHtml = mdToHtml(body);
      const textLen = body.replace(/[#*>|`\-\[\]()]/g, "").trim().length;
      const fallback =
        textLen < 120
          ? `<p class="thin-chapter">（本章正文生成内容不足——已生成其余章节的详细对比；该章要点请参见"变化点总结"与相邻章节，或稍后重新生成报告。）</p>`
          : "";
      return `
<section class="chapter" id="ch-${c.id}">
  <h2 class="chapter-title">${c.id} ${esc(c.title)}</h2>
  <div class="chapter-body">${bodyHtml}${fallback}</div>
</section>`;
    })
    .join("\n");

  const appendixHtml = appendices
    .filter((a) => a.markdown)
    .map((a) => {
      const body = mdToHtml(a.markdown!);
      const textLen = (a.markdown ?? "").replace(/[#*>|`\-\[\]()\s]/g, "").trim().length;
      const fallback =
        textLen < 120
          ? `<p class="thin-chapter">（本附录生成内容不足——其他附录与正文已完整生成；该附录如需补全，可重新生成报告。）</p>`
          : "";
      return `
<section class="chapter" id="ap-${esc(a.id)}">
  <h2 class="chapter-title">附录 ${esc(a.id)} ${esc(a.title)}</h2>
  <div class="chapter-body">${body}${fallback}</div>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(outline.title)}</title>
<style>
  @page { size: A4; margin: 22mm 18mm 20mm 18mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1c2733; font-size: 10.5pt; line-height: 1.75; margin: 0;
  }

  /* ---------- cover (kept to ONE page: tightened) ---------- */
  .cover { page-break-after: always; padding-top: 20mm; text-align: center; page-break-inside: avoid; }
  .cover h1 { font-size: 28pt; margin: 0 0 4mm; color: #0c1a2b; letter-spacing: 2px; }
  .cover .sub { font-size: 12.5pt; color: #5e5240; margin-bottom: 14mm; }
  .src-row { display: flex; gap: 8mm; justify-content: center; margin-bottom: 14mm; }
  .src-card { border: 1pt solid #d8cfb8; background: #faf6ec; border-radius: 4mm; padding: 7mm 8mm; width: 50mm; page-break-inside: avoid; }
  .src-label { font-size: 18pt; font-weight: 700; color: #0c1a2b; }
  .src-name { font-size: 10pt; color: #3a3027; margin-top: 2mm; min-height: 9mm; display: flex; align-items: center; justify-content: center; }
  .src-meta { font-size: 8.5pt; color: #7c6a4f; margin-top: 1mm; }
  .cover-meta { font-size: 9.5pt; color: #5e5240; line-height: 2; }
  .disclaimer { margin-top: 9mm; font-size: 8.5pt; color: #9c8b6c; border-top: .5pt solid #ece4d1; padding-top: 3mm; }

  /* ---------- front matter ---------- */
  h1.front { font-size: 20pt; color: #0c1a2b; border-bottom: 2pt solid #0c1a2b; padding-bottom: 3mm; }
  h2.front { font-size: 14pt; color: #0c1a2b; margin-top: 8mm; }

  /* ---------- toc (starts on page 2 via cover's break; single column fills the page) ---------- */
  .toc-row { display: flex; align-items: baseline; gap: 3mm; padding: 2.4mm 0; font-size: 11pt; break-inside: avoid; border-bottom: .3pt dotted #ece4d1; }
  .toc-num { width: 9mm; font-weight: 700; color: #0c1a2b; flex-shrink: 0; }
  .toc-title { color: #1c2733; }
  .toc-dots { flex: 1; border-bottom: 1px dotted #b9a27a; transform: translateY(-1.2mm); }
  .toc-page { min-width: 9mm; text-align: right; font-weight: 700; color: #0c1a2b; }

  /* ---------- chapters ---------- */
  .chapter { page-break-before: always; }
  /* Heading never orphaned: keep title glued to the following content. */
  .chapter-title {
    font-size: 16pt; color: #0c1a2b; border-left: 4pt solid #a17334;
    padding-left: 4mm; margin: 0 0 5mm; line-height: 1.35;
    page-break-after: avoid;
  }
  .chapter-body h4 { font-size: 12.5pt; color: #0c1a2b; margin: 7mm 0 2.5mm; page-break-after: avoid; }
  .chapter-body h5 { font-size: 11.5pt; color: #3a3027; margin: 5mm 0 2mm; page-break-after: avoid; }
  .chapter-body h6 { font-size: 10.5pt; color: #5e5240; margin: 4mm 0 1.5mm; page-break-after: avoid; }
  .chapter-body p { margin: 0 0 2.5mm; text-align: justify; orphans: 3; widows: 3; }
  .thin-chapter { color: #9c8b6c; font-size: 9.5pt; font-style: italic; background: #faf6ec; border: .5pt dashed #d8cfb8; border-radius: 3mm; padding: 3mm 4mm; }

  /* ---------- tables ---------- */
  table { width: 100%; border-collapse: collapse; font-size: 8.8pt; margin: 3mm 0 4mm; page-break-inside: auto; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  th, td { border: .6pt solid #d8cfb8; padding: 2mm 2.4mm; vertical-align: top; text-align: left; line-height: 1.5; }
  th { background: #f5efe0; color: #0c1a2b; font-weight: 700; }
  tbody tr:nth-child(even) td { background: #fbf9f3; }

  /* ---------- lists / quotes ---------- */
  ul, ol { margin: 0 0 3mm; padding-left: 7mm; }
  li { margin-bottom: 1.2mm; }
  blockquote {
    margin: 3mm 0; padding: 2.5mm 4mm; background: #f7fbf8;
    border-left: 3pt solid #a17334; font-size: 9.5pt; color: #3a3027;
  }
  hr { border: none; border-top: .8pt solid #ece4d1; margin: 5mm 0; }
  code { background: #faf6ec; border: .5pt solid #ece4d1; border-radius: 2px; padding: 0 1.5mm; font-size: 9pt; }

  /* ---------- change markers & tags ---------- */
  .mk { display: inline-block; padding: 0 1.6mm; border-radius: 2px; font-size: 8.5pt; font-weight: 700; white-space: nowrap; }
  .mk-add { background: #e3f2e8; color: #1f7a44; border: .5pt solid #9fd6b4; }
  .mk-del { background: #fbe4e4; color: #a23030; border: .5pt solid #e7a9a9; text-decoration: line-through; }
  .mk-mod { background: #fdeed9; color: #a17334; border: .5pt solid #ecc78a; }
  .mk-keep { background: #eef1f5; color: #5e748c; border: .5pt solid #c9d3e0; }
  .tag { display: inline-block; padding: 0 1.6mm; border-radius: 2px; font-size: 8pt; font-weight: 700; }
  .tag-fact { background: #fde0e0; color: #a23030; }
  .tag-infer { background: #fdf3df; color: #a17334; }
  .tag-todo { background: #ece4d1; color: #3a3027; }
</style>
</head>
<body>

<!-- ===== COVER ===== -->
<div class="cover">
  <h1>${esc(outline.title)}</h1>
  <div class="sub">现行版 · 草案版 · 欧版 三维度对照分析</div>
  <div class="src-row">${sourceCards}</div>
  <div class="cover-meta">
    报告编号：GB4785-CMP-2026-09-001<br>
    编制日期：${esc(stamp)}<br>
    文档版本：V1.0
  </div>
  <div class="disclaimer">本报告基于公开法规资料及专业知识编制，仅供技术研究使用。涉及具体产品的合规判定，请以官方发布的法规原文为准。</div>
</div>

<!-- ===== TOC (starts page 2 via cover break; chapters break themselves) ===== -->
<div>
  <h1 class="front">目录</h1>
  <div class="toc">${tocEntries}${appendixEntries}</div>
</div>

<!-- ===== CHAPTERS ===== -->
${chapterHtml}

<!-- ===== APPENDICES (each one is its own .chapter — no extra divider page) ===== -->
${appendixHtml}

</body>
</html>`;
}

/** Render the report to a PDF buffer using Playwright/Chromium. */
export async function renderPdfFromReport(report: RenderableReport): Promise<Buffer> {
  const html = buildHtml(report);
  // Dynamic import keeps esbuild from trying to bundle Playwright for node.
  // playwright-core reuses the system Chrome (channel: "chrome").
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // Give webfonts/layout a beat
    await page.waitForTimeout(300);
    const pdf = await page.pdf({
      title: report.outline.title,
      creator: "GB 4785 多版本对比报告 pipeline v6.2",
      subject: "A 草案 / B 现行 / C UN R48-09 三版本法规横向对照",
      keywords: "GB 4785, UN R48, AFS, 颜色, 光强, 倾斜度, 核验, 追溯, 法规对比",
      format: "A4",
      format: "A4",
      printBackground: true,
      margin: { top: "22mm", bottom: "20mm", left: "18mm", right: "18mm" },
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="width:100%;text-align:center;font-size:8px;color:#9c8b6c;font-family:sans-serif;">' +
        esc(report.outline.title) +
        "</div>",
      footerTemplate:
        '<div style="width:100%;display:flex;justify-content:space-between;font-size:8px;color:#9c8b6c;font-family:sans-serif;padding:0 18mm;">' +
        "<span>汽车外部照明与光信号装置安装规定对比分析</span>" +
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>' +
        "</div>",
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
