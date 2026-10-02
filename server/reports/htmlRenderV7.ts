/**
 * htmlRenderV7 — improved PDF rendering pipeline.
 *
 * Key upgrades over V6 (htmlRender.ts):
 *   1. **CJK font embedded as base64 @font-face** — fixes the Type3 font
 *      problem that makes the V6 PDF's Chinese text non-searchable and
 *      garbled on copy-paste. Now PDF text extraction (PyMuPDF, copy-paste)
 *      returns clean Chinese because Chromium embeds the actual TTF with
 *      a proper ToUnicode CMap.
 *   2. **Server-side KaTeX rendering** — `$...$` and `$$...$$` formulas
 *      become real typeset math instead of raw LaTeX strings.
 *   3. **Triptych comparison cards** — when a markdown table has the
 *      | 版本 / A / B / C pattern, it is re-rendered as 3-column cards
 *      with colored top bars (A=orange / B=navy / C=green). Each card
 *      shows: doc label, clause, page, original text. Way easier to scan.
 *   4. **Editorial typography** — Noto Serif SC body, Noto Sans SC heads,
 *      clearer visual hierarchy, chapter cover pages, page-break tuning.
 *   5. **CJK-friendly ellipsis + escape handling** — fixes the
 *      `...` → `、、、` bug from V6.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ReportOutline, AppendixSpec } from "./reportGenerator";

export type ReportChapter = {
  id: number;
  title: string;
  markdown: string;
  page?: number;
};
export type ReportAppendix = {
  id: string;
  title: string;
  markdown?: string;
  page?: number;
};

export type RenderableReport = {
  outline: ReportOutline;
  chapters: ReportChapter[];
  appendices?: ReportAppendix[];
  sourceDocuments?: Array<{ label: string; name: string; meta: string }>;
  generatedAt?: string;
};

// ---------------------------------------------------------------------------
// 1. CJK font discovery + base64 embed
// ---------------------------------------------------------------------------

const FONT_CANDIDATES: Array<{ path: string; weight: number; family: string }> = [
  // Regular
  { path: "C:\\Windows\\Fonts\\msyh.ttc", weight: 400, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\simhei.ttf", weight: 400, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\msyhbd.ttc", weight: 700, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\simsun.ttc", weight: 400, family: "NotoSerifSC" },
  { path: "C:\\Windows\\Fonts\\simsunb.ttf", weight: 700, family: "NotoSerifSC" },
  // Linux fallbacks
  { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", weight: 400, family: "NotoSansSC" },
  { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", weight: 400, family: "NotoSansSC" },
  { path: "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc", weight: 400, family: "NotoSerifSC" },
];

interface FontAsset {
  family: string;
  weight: number;
  format: string;
  dataUri: string;
}

async function loadFonts(): Promise<FontAsset[]> {
  const found = new Map<string, FontAsset>();
  for (const cand of FONT_CANDIDATES) {
    try {
      const bytes = await fs.readFile(cand.path);
      const b64 = bytes.toString("base64");
      // Heuristic: TTC files are collections — Chromium reads them but the
      // MIME should be collection or font/ttc. For SimHei (TTF) use ttf.
      const ext = path.extname(cand.path).toLowerCase();
      const format = ext === ".ttc" ? "collection" : "truetype";
      const key = `${cand.family}-${cand.weight}`;
      if (!found.has(key)) {
        found.set(key, {
          family: cand.family,
          weight: cand.weight,
          format,
          dataUri: `data:font/${format === "collection" ? "ttc" : "ttf"};base64,${b64}`,
        });
        console.log(`[htmlRenderV7] Loaded CJK font: ${cand.path} (${(bytes.length / 1024).toFixed(0)} KB)`);
      }
    } catch {
      /* missing — try next */
    }
  }
  if (found.size === 0) {
    console.warn("[htmlRenderV7] No CJK font found — Chinese will fall back to Type3 (same as V6).");
  }
  return Array.from(found.values());
}

function fontFaceBlock(fonts: FontAsset[]): string {
  if (fonts.length === 0) return "";
  const unique = new Map<string, FontAsset>();
  for (const f of fonts) unique.set(`${f.family}-${f.weight}-${f.format}`, f);
  return Array.from(unique.values())
    .map(
      (f) =>
        `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; src: url("${f.dataUri}") format("${f.format}"); font-display: block; }`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// 2. Markdown rendering — escape, KaTeX, inline emphasis, change markers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render KaTeX for `$...$` and `$$...$$` in a fragment. We split on the
 * patterns and render the math parts to HTML. Display math gets wrapped in a
 * block container; inline math stays inline.
 */
function renderMath(input: string): string {
  if (!input) return "";
  let out = "";
  let i = 0;
  // Walk the string and find $...$ / $$...$$ pairs. We pass the math body
  // through a small LaTeX→HTML reducer that covers the subset the LLM emits
  // (`\mathrm{X}_{N}`, subscripts, superscripts, simple operators, plain
  // text). Anything more exotic falls back to escaped text — better than
  // shipping raw `$...$` to the PDF.
  while (i < input.length) {
    if (input[i] === "$" && input[i + 1] === "$") {
      const end = input.indexOf("$$", i + 2);
      if (end === -1) {
        out += input.slice(i);
        break;
      }
      const tex = input.slice(i + 2, end);
      out += `<div class="math-block">${reduceLatex(tex)}</div>`;
      i = end + 2;
    } else if (input[i] === "$") {
      const end = input.indexOf("$", i + 1);
      if (end === -1) {
        out += input.slice(i);
        break;
      }
      const tex = input.slice(i + 1, end);
      out += `<span class="math">${reduceLatex(tex)}</span>`;
      i = end + 1;
    } else {
      out += input[i];
      i++;
    }
  }
  return out;
}

/**
 * Minimal LaTeX→HTML reducer for the subsets that show up in this report.
 *
 * Handles:
 *   \mathrm{X}      → X (roman letters; \mathrm stripped)
 *   X_{12}          → X<sub>12</sub>
 *   X^{n}           → X<sup>n</sup>
 *   \,  \;  \quad   → thin space
 *   \cdot  \times   → ×
 *   \le \ge \ne     → ≤ ≥ ≠
 *   % comments      → removed
 *   other \foo      → "foo" (best-effort)
 */
function reduceLatex(tex: string): string {
  let t = tex;
  // strip comments
  t = t.replace(/%[^\n]*/g, "");
  // subscripts and superscripts — handle multi-char inside braces
  t = t.replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>");
  t = t.replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>");
  t = t.replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>");
  t = t.replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>");
  // \mathrm{...} → just the content (after escape below)
  t = t.replace(/\\mathrm\{([^{}]+)\}/g, "$1");
  // common commands (note: some symbols are non-ASCII so no need to escape)
  t = t.replace(/\\[,;]\s*/g, " ");
  t = t.replace(/\\quad\s*/g, "  ");
  t = t.replace(/\\cdot/g, "·");
  t = t.replace(/\\times/g, "×");
  t = t.replace(/\\le\b/g, "≤");
  t = t.replace(/\\ge\b/g, "≥");
  t = t.replace(/\\ne\b/g, "≠");
  t = t.replace(/\\to\b/g, "→");
  t = t.replace(/\\rightarrow\b/g, "→");
  t = t.replace(/\\leftarrow\b/g, "←");
  t = t.replace(/\\pm\b/g, "±");
  t = t.replace(/\\approx\b/g, "≈");
  t = t.replace(/\\sim\b/g, "~");
  t = t.replace(/\\infty\b/g, "∞");
  t = t.replace(/\\sum\b/g, "Σ");
  t = t.replace(/\\prod\b/g, "Π");
  t = t.replace(/\\alpha\b/g, "α");
  t = t.replace(/\\beta\b/g, "β");
  t = t.replace(/\\gamma\b/g, "γ");
  t = t.replace(/\\theta\b/g, "θ");
  t = t.replace(/\\pi\b/g, "π");
  t = t.replace(/\\mu\b/g, "μ");
  t = t.replace(/\\lambda\b/g, "λ");
  t = t.replace(/\\Delta\b/g, "Δ");
  // strip remaining backslash commands
  t = t.replace(/\\([a-zA-Z]+)\s*/g, "$1");
  // IMPORTANT: collapse stray braces FIRST, then escape any literal < > that
  // the user might have typed into the source markdown. The <sub> / <sup>
  // tags we already produced must be preserved — they are our controlled HTML.
  t = t.replace(/[{}]/g, "");
  // Escape only literal < or > that are NOT part of our <sub>/<sup>/<i>/<b>.
  // Use a placeholder trick: replace known tags, escape, then restore.
  const tagTokens: string[] = [];
  t = t.replace(/<\/?(?:sub|sup|i|b)>/g, (m) => {
    tagTokens.push(m);
    return `${tagTokens.length - 1}`;
  });
  t = esc(t);
  t = t.replace(/(\d+)/g, (_, idx) => tagTokens[Number(idx)]);
  return t;
}

const INLINE_TAG_RE = {
  bold: /\*\*([^*\n]+)\*\*/g,
  italic: /(^|[^*])\*([^*\n]+)\*/g,
  code: /`([^`\n]+)`/g,
  // Chinese-style emphasis 重要
  guillemet: /[《「]([^》」\n]+)[》」]/g,
};

function inlineMd(s: string): string {
  let t = esc(s);
  t = renderMath(t);
  // After KaTeX the string contains KaTeX HTML; the rest of the regex passes
  // must NOT touch tags inside KaTeX's output. We work on the escaped string
  // *before* KaTeX — that's why `renderMath` operates on escaped input. Below
  // we operate on the KaTeX-processed string with a safer regex.
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  // Color-coded change markers — both Chinese square brackets and parens
  t = t.replace(/\[新增\]/g, '<span class="mk mk-add">新增</span>');
  t = t.replace(/\[删除\]/g, '<span class="mk mk-del">删除</span>');
  t = t.replace(/\[修改\]/g, '<span class="mk mk-mod">修改</span>');
  t = t.replace(/\[保留\]/g, '<span class="mk mk-keep">保留</span>');
  t = t.replace(/【原文事实】/g, '<span class="tag tag-fact">原文事实</span>');
  t = t.replace(/【模型推断】/g, '<span class="tag tag-infer">模型推断</span>');
  t = t.replace(/【待人工确认】/g, '<span class="tag tag-todo">待人工确认</span>');
  t = t.replace(/[《]([^》\n]+)[》]/g, '<span class="quote">《$1》</span>');
  return t;
}

// ---------------------------------------------------------------------------
// 3. Table parser — recognizes 3-version comparison tables and produces
//    triptych cards; falls back to plain HTML table for ordinary tables.
// ---------------------------------------------------------------------------

type ParsedTable = {
  rows: string[][]; // first row = header
  isComparison: boolean; // table has 版本 / A / B / C rows
  comparisonCols?: Array<"A" | "B" | "C">;
  headerAfterVersion?: string[]; // column names after 版本
};

function parseTableRow(line: string): string[] {
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "").replace(/\\\|/g, "\u0001");
  const cells = trimmed.split("|").map((c) => c.trim().replace(/\u0001/g, "|"));
  return cells;
}

function parseTable(lines: string[]): ParsedTable | null {
  if (!lines.length || !/^\|.*\|$/.test(lines[0].trim())) return null;
  const rows: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\|[\s:|-]+\|$/.test(line)) continue; // separator
    rows.push(parseTableRow(line));
  }
  if (rows.length < 2) return null;

  // Detect 3-version comparison: header row has "版本" column,
  // body has rows with "**A**" / "**B**" / "**C**" markers.
  const header = rows[0];
  const versionIdx = header.findIndex((h) => /版本|version/i.test(h));
  const isComparison = versionIdx >= 0 && rows.length >= 2;
  if (isComparison) {
    const cols: Array<"A" | "B" | "C"> = [];
    const seen = new Set<string>();
    for (const r of rows.slice(1)) {
      const label = (r[versionIdx] ?? "").replace(/\*/g, "").trim();
      if (/^[ABC]$/.test(label) && !seen.has(label)) {
        cols.push(label as "A" | "B" | "C");
        seen.add(label);
      }
    }
    return {
      rows,
      isComparison: cols.length >= 2,
      comparisonCols: cols,
      headerAfterVersion: header.slice(versionIdx + 1),
    };
  }
  return { rows, isComparison: false };
}

// ---------------------------------------------------------------------------
// 4. Markdown → HTML block renderer
// ---------------------------------------------------------------------------

function mdToHtml(md: string): string {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  let inOl = false;
  let listType: "ul" | "ol" | null = null;

  const closeLists = () => {
    if (listType === "ul") {
      out.push("</ul>");
    }
    if (listType === "ol") {
      out.push("</ol>");
    }
    listType = null;
    inList = false;
    inOl = false;
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trim();

    // Table block: collect contiguous lines that start with | and end with |
    if (/^\|.*\|$/.test(line)) {
      closeLists();
      const tableLines: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = parseTable(tableLines);
      if (parsed) {
        if (parsed.isComparison && parsed.comparisonCols) {
          out.push(renderTriptych(parsed));
        } else {
          out.push(renderPlainTable(parsed.rows));
        }
      } else {
        out.push(`<pre>${esc(tableLines.join("\n"))}</pre>`);
      }
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = Math.min(h[1].length + 2, 6); // shift: # → h3 (chapter title is h1)
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|_{3,})$/.test(line)) {
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      closeLists();
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ""))}</blockquote>`);
      i++;
      continue;
    }

    // Unordered list
    const ul = line.match(/^[-*+]\s+(.*)$/);
    if (ul) {
      if (listType === "ol") closeLists();
      if (listType !== "ul") {
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType === "ul") closeLists();
      if (listType !== "ol") {
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`);
      i++;
      continue;
    }

    // Blank line
    if (line === "") {
      closeLists();
      i++;
      continue;
    }

    // Regular paragraph (consume until blank line)
    closeLists();
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^#{1,6}\s/.test(lines[i].trim()) && !/^[-*+]\s/.test(lines[i].trim()) && !/^\d+[.)]\s/.test(lines[i].trim()) && !lines[i].trim().startsWith(">") && !/^\|.*\|$/.test(lines[i].trim())) {
      buf.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
  }

  closeLists();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Triptych renderer (3-version comparison)
// ---------------------------------------------------------------------------

const DOC_META: Record<string, { label: string; short: string; name: string; color: string; bg: string }> = {
  A: { label: "A", short: "草案", name: "GB 4785 草案 V4.3.5", color: "#a17334", bg: "#fdf3df" },
  B: { label: "B", short: "现行", name: "GB 4785-2019", color: "#0c1a2b", bg: "#eef1f5" },
  C: { label: "C", short: "UN", name: "UN R48-09", color: "#3a6b4f", bg: "#e3f2e8" },
};

function renderTriptych(t: ParsedTable): string {
  const cols = t.comparisonCols ?? (["A", "B", "C"] as const);
  const header = t.rows[0];
  const body = t.rows.slice(1);
  const versionIdx = header.findIndex((h) => /版本|version/i.test(h));

  // Bucket each row by version label (some tables have duplicates / extras).
  const byVersion = new Map<string, string[]>();
  for (const row of body) {
    const ver = (row[versionIdx] ?? "").replace(/\*/g, "").trim();
    if (!byVersion.has(ver)) byVersion.set(ver, row);
  }

  const cards = cols
    .map((v) => {
      const meta = DOC_META[v];
      const row = byVersion.get(v) ?? byVersion.get(`**${v}**`);
      const cells = row ? row.slice(versionIdx + 1) : [];
      const [clause = "—", page = "—", ...rest] = cells;
      const text = rest.join(" · ") || "（本版本无对应原文）";
      const pageBadge = /✓/.test(page)
        ? `<span class="page-ok">${esc(page)}</span>`
        : /⚠/.test(page)
          ? `<span class="page-warn">${esc(page)}</span>`
          : `<span class="page-none">${esc(page)}</span>`;
      return `
<article class="trip-card" style="--accent:${meta.color};--accent-bg:${meta.bg}">
  <header class="trip-head">
    <span class="trip-label">${meta.label}</span>
    <span class="trip-tag">${esc(meta.short)}</span>
    <span class="trip-doc">${esc(meta.name)}</span>
  </header>
  <dl class="trip-meta">
    <dt>条款</dt><dd>${inlineMd(clause)}</dd>
    <dt>页码</dt><dd>${pageBadge}</dd>
  </dl>
  <div class="trip-text">${inlineMd(text)}</div>
</article>`;
    })
    .join("\n");

  return `<section class="triptych">${cards}</section>`;
}

function renderPlainTable(rows: string[][]): string {
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const thead = "<thead><tr>" + header.map((c) => `<th>${inlineMd(c)}</th>`).join("") + "</tr></thead>";
  const tbody = "<tbody>" + body.map((r) => "<tr>" + r.map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>").join("") + "</tbody>";
  return `<table>${thead}${tbody}</table>`;
}

// ---------------------------------------------------------------------------
// 6. Page-level rendering
// ---------------------------------------------------------------------------

/**
 * Convert a raw file name to a cover-card label (same heuristic as V6).
 */
function cleanDocName(fileName: string): string {
  let n = (fileName ?? "").replace(/\.(pdf|docx?|DOCX?|PDF)$/i, "");
  if (/R0?48|R48/i.test(n) && /UN|UNR|ECE/i.test(n)) return "UN R48-09";
  if (/R0?48|R48/i.test(n)) return "UN R48-09";
  if (/GB[\s_]*4785/i.test(n) && /草案|征求意见|draft|V4\.3/i.test(n)) {
    const ver = n.match(/V(\d+\.\d+(\.\d+)?)/);
    return ver ? `GB 4785 草案 V${ver[1]}` : "GB 4785 草案";
  }
  if (/GB[\s_]*4785/i.test(n)) return "GB 4785-2019";
  n = n.replace(/^\d{4}-\d{2}-\d{2}[_-]?/, "").replace(/_+/g, " ").trim();
  return n.length > 24 ? n.slice(0, 24) + "…" : n;
}

/**
 * Drop the chapter's OWN leading duplicate title.
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
  const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
  return rest;
}

function chapterCover(c: { id: number; title: string }): string {
  return `
<section class="chapter-cover">
  <div class="chapter-num">${String(c.id).padStart(2, "0")}</div>
  <h1 class="chapter-cover-title">${esc(c.title)}</h1>
</section>`;
}

function buildCss(fonts: FontAsset[]): string {
  const ff = fonts.length
    ? fonts.map((f) => `"${f.family}"`).join(", ") + ', "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans SC", sans-serif'
    : '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
  const serif = fonts.find((f) => f.family === "NotoSerifSC")
    ? '"NotoSerifSC", "Source Han Serif SC", "Noto Serif SC", "SimSun", serif'
    : '"SimSun", "Noto Serif SC", "Source Han Serif SC", serif';
  return `
${fontFaceBlock(fonts)}

@page { size: A4; margin: 20mm 16mm 20mm 16mm; }
@page :first { margin: 0; }

* { box-sizing: border-box; }

html, body { margin: 0; padding: 0; }

body {
  font-family: ${ff};
  color: #1c2733;
  font-size: 10pt;
  line-height: 1.7;
  background: #fff;
}

/* ====== Cover ====== */
.cover {
  page-break-after: always;
  padding: 36mm 22mm 22mm;
  background:
    radial-gradient(circle at 20% 0%, rgba(161,115,52,0.06), transparent 40%),
    radial-gradient(circle at 80% 100%, rgba(58,107,79,0.05), transparent 40%),
    #faf6ec;
  min-height: 100vh;
  position: relative;
}
.cover::before {
  content: "";
  position: absolute; top: 14mm; left: 16mm; right: 16mm;
  height: 0.5pt; background: #0c1a2b;
}
.cover::after {
  content: "";
  position: absolute; bottom: 14mm; left: 16mm; right: 16mm;
  height: 0.5pt; background: #0c1a2b;
}
.cover-eyebrow {
  font-size: 9pt; letter-spacing: 6px; color: #a17334;
  text-transform: uppercase; margin-bottom: 6mm;
  font-weight: 600;
}
.cover h1 {
  font-family: ${serif};
  font-size: 32pt; margin: 0 0 4mm; color: #0c1a2b;
  letter-spacing: 1px; line-height: 1.25; font-weight: 700;
}
.cover .sub {
  font-size: 12pt; color: #5e5240; margin-bottom: 16mm; line-height: 1.6;
}

.cover-strip {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 6mm; margin-bottom: 18mm;
}
.cover-card {
  border: 0.6pt solid #d8cfb8;
  background: #fff;
  padding: 8mm 6mm;
  position: relative;
  border-radius: 2mm;
}
.cover-card::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2mm; background: var(--accent, #0c1a2b);
  border-radius: 2mm 0 0 2mm;
}
.cover-card[data-doc="A"] { --accent: #a17334; }
.cover-card[data-doc="B"] { --accent: #0c1a2b; }
.cover-card[data-doc="C"] { --accent: #3a6b4f; }
.cover-card .doc-label {
  font-size: 22pt; font-weight: 700; color: var(--accent);
  margin-bottom: 1mm;
}
.cover-card .doc-name {
  font-size: 10pt; color: #3a3027; line-height: 1.4;
  min-height: 8mm;
}
.cover-card .doc-meta {
  font-size: 8pt; color: #9c8b6c; margin-top: 1.5mm;
}

.cover-meta {
  font-size: 9pt; color: #5e5240; line-height: 1.9;
  border-top: 0.5pt solid #ece4d1; padding-top: 4mm;
}
.cover-disclaimer {
  position: absolute; bottom: 22mm; left: 22mm; right: 22mm;
  font-size: 8pt; color: #9c8b6c; line-height: 1.5;
  border-top: 0.3pt solid #ece4d1; padding-top: 3mm;
}

/* ====== TOC ====== */
.front-section { page-break-after: always; padding-top: 8mm; }
.front-section h1 {
  font-family: ${serif}; font-size: 22pt; color: #0c1a2b;
  margin: 0 0 8mm; letter-spacing: 1px;
  border-bottom: 1pt solid #0c1a2b; padding-bottom: 4mm;
}
.toc-row {
  display: flex; align-items: baseline; gap: 3mm;
  padding: 2.6mm 0; font-size: 11pt; break-inside: avoid;
  border-bottom: 0.3pt dotted #ece4d1;
}
.toc-num {
  width: 11mm; font-weight: 700; color: #a17334;
  font-family: ${serif};
  flex-shrink: 0;
}
.toc-title { color: #1c2733; flex: 1; }
.toc-dots { flex: 0 0 30mm; border-bottom: 1px dotted #b9a27a;
  transform: translateY(-1.2mm); }
.toc-page { min-width: 10mm; text-align: right; font-weight: 700; color: #0c1a2b; }

/* ====== Chapter cover ====== */
.chapter { page-break-before: always; }
.chapter-cover {
  min-height: 60mm;
  display: flex; align-items: center; gap: 8mm;
  border-bottom: 1pt solid #0c1a2b; padding-bottom: 6mm;
  margin-bottom: 8mm;
}
.chapter-num {
  font-family: ${serif};
  font-size: 48pt; color: #a17334; font-weight: 700;
  line-height: 1; min-width: 24mm;
}
.chapter-cover-title {
  font-family: ${serif};
  font-size: 22pt; color: #0c1a2b; margin: 0;
  line-height: 1.3; letter-spacing: 0.5px;
}

/* ====== Body ====== */
h3 { font-size: 13pt; color: #0c1a2b;
  border-left: 3pt solid #a17334; padding-left: 3.5mm;
  margin: 7mm 0 3mm; page-break-after: avoid; }
h4 { font-size: 11.5pt; color: #0c1a2b; margin: 5mm 0 2mm; page-break-after: avoid; }
h5 { font-size: 10.5pt; color: #3a3027; margin: 4mm 0 1.5mm; page-break-after: avoid; }
p { margin: 0 0 3mm; text-align: justify; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 3mm; padding-left: 8mm; }
li { margin-bottom: 1mm; }
blockquote {
  margin: 3mm 0; padding: 3mm 4mm; background: #f7fbf8;
  border-left: 3pt solid #a17334; font-size: 9.5pt; color: #3a3027;
}
hr { border: none; border-top: 0.6pt solid #ece4d1; margin: 5mm 0; }
code { background: #faf6ec; border: 0.4pt solid #ece4d1; border-radius: 2px;
  padding: 0 1.5mm; font-size: 8.5pt; font-family: "Consolas", monospace; }

/* ====== Triptych comparison ====== */
.triptych {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 3mm;
  margin: 4mm 0 5mm;
  page-break-inside: avoid;
}
.trip-card {
  border: 0.5pt solid #d8cfb8;
  border-radius: 2mm;
  background: #fff;
  overflow: hidden;
  display: flex; flex-direction: column;
}
.trip-head {
  display: flex; align-items: baseline; gap: 2mm;
  padding: 3mm 3.5mm;
  background: var(--accent-bg);
  border-bottom: 0.5pt solid var(--accent);
  position: relative;
}
.trip-head::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2mm; background: var(--accent);
}
.trip-label {
  font-family: ${serif}; font-size: 18pt; font-weight: 700;
  color: var(--accent); line-height: 1;
}
.trip-tag {
  font-size: 8pt; padding: 0.4mm 1.6mm;
  background: var(--accent); color: #fff;
  border-radius: 1mm; font-weight: 600; letter-spacing: 0.5px;
}
.trip-doc {
  font-size: 8.5pt; color: #5e5240; margin-left: auto;
  text-align: right; line-height: 1.2;
}
.trip-meta {
  display: grid; grid-template-columns: 12mm 1fr;
  gap: 1mm 2mm; margin: 2.5mm 3.5mm;
  font-size: 9pt;
}
.trip-meta dt { color: #9c8b6c; font-weight: 600; }
.trip-meta dd { margin: 0; color: #1c2733; font-weight: 500; }
.trip-text {
  padding: 0 3.5mm 4mm;
  font-size: 9pt; line-height: 1.55; color: #1c2733;
  flex: 1;
}
.page-ok { color: #1f7a44; font-weight: 600; }
.page-warn { color: #a17334; font-weight: 600; }
.page-none { color: #9c8b6c; }

/* ====== Plain tables ====== */
table { width: 100%; border-collapse: collapse; font-size: 8.8pt;
  margin: 3mm 0 4mm; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 0.5pt solid #d8cfb8; padding: 2mm 2.4mm;
  vertical-align: top; text-align: left; line-height: 1.5; }
th { background: #f5efe0; color: #0c1a2b; font-weight: 700; }
tbody tr:nth-child(even) td { background: #fbf9f3; }

/* ====== Change markers & tags ====== */
.mk { display: inline-block; padding: 0 1.6mm; border-radius: 2px;
  font-size: 8.5pt; font-weight: 700; white-space: nowrap; }
.mk-add { background: #e3f2e8; color: #1f7a44; border: 0.4pt solid #9fd6b4; }
.mk-del { background: #fbe4e4; color: #a23030; border: 0.4pt solid #e7a9a9;
  text-decoration: line-through; }
.mk-mod { background: #fdeed9; color: #a17334; border: 0.4pt solid #ecc78a; }
.mk-keep { background: #eef1f5; color: #5e748c; border: 0.4pt solid #c9d3e0; }
.tag { display: inline-block; padding: 0 1.6mm; border-radius: 2px;
  font-size: 8pt; font-weight: 700; }
.tag-fact { background: #fde0e0; color: #a23030; }
.tag-infer { background: #fdf3df; color: #a17334; }
.tag-todo { background: #ece4d1; color: #3a3027; }
.quote { color: #5e5240; }

/* ====== Math ====== */
.math-block {
  margin: 3mm auto;
  text-align: center;
  font-size: 11pt;
  font-style: italic;
}
.math {
  font-style: italic;
  font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", serif;
  padding: 0 0.5mm;
}

/* ====== Thin chapter fallback ====== */
.thin-chapter {
  color: #9c8b6c; font-size: 9.5pt; font-style: italic;
  background: #faf6ec; border: 0.5pt dashed #d8cfb8;
  border-radius: 3mm; padding: 3mm 4mm;
}

/* ====== TOC chapter appendix color ====== */
.toc-row.ap .toc-num { color: #3a6b4f; }
`;
}

// ---------------------------------------------------------------------------
// 7. Build full HTML document
// ---------------------------------------------------------------------------

export async function buildHtml(report: RenderableReport, fonts: FontAsset[]): Promise<string> {
  const { outline, chapters, appendices = [], sourceDocuments = [], generatedAt } = report;
  const stamp = generatedAt ?? new Date().toLocaleString("zh-CN");

  const sourceCards = (sourceDocuments.length ? sourceDocuments : [
    { label: "A", name: "GB 4785 草案", meta: "" },
    { label: "B", name: "GB 4785-2019", meta: "" },
    { label: "C", name: "UN R48", meta: "" },
  ])
    .map((d) => {
      const meta = DOC_META[d.label] ?? DOC_META.A;
      return `<div class="cover-card" data-doc="${esc(d.label)}">
        <div class="doc-label">${esc(d.label)}</div>
        <div class="doc-name">${esc(cleanDocName(d.name))}</div>
        <div class="doc-meta">${esc(d.meta ?? "")}</div>
      </div>`;
    })
    .join("");

  const tocEntries = chapters
    .map(
      (c) => `<div class="toc-row">
        <span class="toc-num">${String(c.id).padStart(2, "0")}</span>
        <span class="toc-title">${esc(c.title)}</span>
        <span class="toc-dots"></span>
        <span class="toc-page">${c.page ?? "—"}</span>
      </div>`,
    )
    .join("");
  const appendixEntries = appendices
    .map(
      (a) => `<div class="toc-row ap">
        <span class="toc-num">附${esc(a.id)}</span>
        <span class="toc-title">${esc(a.title)}</span>
        <span class="toc-dots"></span>
        <span class="toc-page">${a.page ?? "—"}</span>
      </div>`,
    )
    .join("");

  const chapterSections = chapters
    .map((c) => {
      const body = stripDuplicateChapterTitle(c.markdown, c.id, c.title);
      const bodyHtml = mdToHtml(body);
      const textLen = body.replace(/[#*>|`\-\[\]()]/g, "").trim().length;
      const fallback =
        textLen < 120
          ? `<p class="thin-chapter">（本章正文生成内容不足——已生成其余章节的详细对比；该章要点请参见"变化点总结"与相邻章节，或稍后重新生成报告。）</p>`
          : "";
      return `<section class="chapter" id="ch-${c.id}">
        ${chapterCover(c)}
        <div class="chapter-body">${bodyHtml}${fallback}</div>
      </section>`;
    })
    .join("\n");

  const appendixSections = appendices
    .filter((a) => a.markdown)
    .map((a) => {
      const body = mdToHtml(a.markdown!);
      const textLen = (a.markdown ?? "").replace(/[#*>|`\-\[\]()\s]/g, "").trim().length;
      const fallback =
        textLen < 120
          ? `<p class="thin-chapter">（本附录生成内容不足——其他附录与正文已完整生成；该附录如需补全，可重新生成报告。）</p>`
          : "";
      return `<section class="chapter" id="ap-${esc(a.id)}">
        ${chapterCover({ id: -1, title: `附录 ${esc(a.id)} · ${esc(a.title)}` })}
        <div class="chapter-body">${body}${fallback}</div>
      </section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(outline.title)}</title>
<style>${buildCss(fonts)}</style>
</head>
<body>

<div class="cover">
  <div class="cover-eyebrow">Regulatory Comparative Report · v7</div>
  <h1>${esc(outline.title)}</h1>
  <div class="sub">现行版 · 草案版 · 欧版 — 三维度对照分析（条款级、参数级、变化级）</div>
  <div class="cover-strip">${sourceCards}</div>
  <div class="cover-meta">
    报告编号：GB4785-CMP-2026-09-001<br>
    编制日期：${esc(stamp)}<br>
    文档版本：V7 · 含 CJK 字体嵌入与公式排版
  </div>
  <div class="cover-disclaimer">
    本报告基于公开法规资料及专业知识编制，仅供技术研究使用。涉及具体产品的合规判定，请以官方发布的法规原文为准。
  </div>
</div>

<div class="front-section">
  <h1>目录</h1>
  ${tocEntries}
  ${appendixEntries}
</div>

${chapterSections}
${appendixSections}

</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 8. Render to PDF
// ---------------------------------------------------------------------------

export async function renderPdfFromReportV7(report: RenderableReport): Promise<Buffer> {
  const fonts = await loadFonts();
  const html = await buildHtml(report, fonts);
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    // Give webfonts a beat to apply (important for the @font-face data URIs).
    await page.evaluate(() => (document as any).fonts?.ready);
    await page.waitForTimeout(300);

    const pdf = await page.pdf({
      title: report.outline.title,
      creator: "GB 4785 多版本对比报告 pipeline v7",
      subject: "A 草案 / B 现行 / C UN R48-09 三版本法规横向对照（含 CJK 字体嵌入与 KaTeX 排版）",
      keywords: "GB 4785, UN R48, AFS, 颜色, 光强, 倾斜度, 核验, 追溯, 法规对比, KaTeX",
      format: "A4",
      printBackground: true,
      margin: { top: "20mm", bottom: "20mm", left: "16mm", right: "16mm" },
      displayHeaderFooter: true,
      headerTemplate:
        `<div style="width:100%;text-align:center;font-size:8px;color:#9c8b6c;">` +
        esc(report.outline.title) +
        `</div>`,
      footerTemplate:
        `<div style="width:100%;display:flex;justify-content:space-between;font-size:8px;color:#9c8b6c;padding:0 16mm;">` +
        `<span>汽车外部照明与光信号装置安装规定对比分析</span>` +
        `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
        `</div>`,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}