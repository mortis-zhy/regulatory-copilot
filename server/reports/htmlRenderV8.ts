/**
 * htmlRenderV8 — full three-version design system (final).
 *
 * v8 improvements over v7:
 *   1. CJK font base64 @font-face embed (searchable/copyable Chinese text).
 *   2. LaTeX $...$ / $$...$$ reduced to HTML (sub/sup/greek/operators),
 *      with a bulletproof escape round-trip (no sentinel collisions).
 *   3. Triptych comparison cards for every `| 版本/来源 |` table — ALWAYS
 *      three cards; missing version rows get an honest gray placeholder
 *      ("源数据未提供"). Handles multi-line table rows (ch14 style).
 *   4. 4-dim Impact Matrix (🔧 设计 / 🧪 测试 / 📋 认证 / ⚠ 风险) parsed
 *      from `> 🔧 …` blockquote or bare-emoji lines.
 *   5. 变化判定 verdict strip (backtick or emoji labels) styled by severity.
 *   6. Master Parameter Index at the front — header-driven column mapping
 *      (参数 col, per-version value/条款/页码 cols, B-before-A safe), with
 *      a numeric guard so only real quantitative rows are listed.
 *   7. Clause cross-reference index at the front — A/B/C 条款+页码 per topic,
 *      harvested from every version-row comparison table.
 *   8. Two-pass rendering with mupdf anchor search → real TOC page numbers.
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractTypedTables, type TypedTableEntry as ExtractedTypedTable } from "./typedTables";
import {
  extractClosureCounts as extractClosureCountsFromMd,
  reportMarkdown,
} from "./trustChecks";
import { buildLedger, ledgerToCounts } from "./closureLedger";
import type { ReportOutline } from "./reportGenerator";

export type ReportChapter = { id: number; title: string; markdown: string; page?: number };
export type ReportAppendix = { id: string; title: string; markdown?: string; page?: number };

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
  { path: "C:\\Windows\\Fonts\\msyh.ttc", weight: 400, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\simhei.ttf", weight: 400, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\msyhbd.ttc", weight: 700, family: "NotoSansSC" },
  { path: "C:\\Windows\\Fonts\\simsun.ttc", weight: 400, family: "NotoSerifSC" },
  { path: "C:\\Windows\\Fonts\\simsunb.ttf", weight: 700, family: "NotoSerifSC" },
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
      const ext = path.extname(cand.path).toLowerCase();
      const format = ext === ".ttc" ? "collection" : "truetype";
      const key = `${cand.family}-${cand.weight}`;
      if (!found.has(key)) {
        found.set(key, {
          family: cand.family,
          weight: cand.weight,
          format,
          dataUri: `data:font/${format === "collection" ? "ttc" : "ttf"};base64,${bytes.toString("base64")}`,
        });
        console.log(`[htmlRenderV8] font loaded: ${cand.path} (${(bytes.length / 1024).toFixed(0)} KB)`);
      }
    } catch {
      /* try next candidate */
    }
  }
  if (found.size === 0) console.warn("[htmlRenderV8] no CJK font found — Chinese will fall back to Type3");
  return Array.from(found.values());
}

function fontFaceBlock(fonts: FontAsset[]): string {
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
// 2. Escape / math / inline
// ---------------------------------------------------------------------------

/**
 * CJK Kangxi/radical → real unified ideograph map.
 *
 * Upstream PDF extraction (and some PDF viewers' copy) can emit radical
 * codepoints (⻚⾊⻅⽅ …) instead of real characters (页色见方). NFKC does
 * NOT fix these, so we keep a conservative map of unambiguous equivalents.
 */
const RADICAL_MAP: Record<string, string> = {
  "⻚": "页", "⾊": "色", "⻅": "见", "⽅": "方", "⻋": "车", "⻉": "贝",
  "⻔": "门", "⻢": "马", "⻥": "鱼", "⻦": "鸟", "⻰": "龙",
  "⼈": "人", "⼉": "儿", "⼊": "入", "⼑": "刀", "⼒": "力",
  "⼗": "十", "⼝": "口", "⼠": "士", "⼤": "大", "⼥": "女", "⼦": "子",
  "⼩": "小", "⼭": "山", "⼯": "工", "⼰": "己", "⼣": "夕", "⼴": "广",
  "⼱": "巾", "⼲": "干", "⼸": "弓", "⼼": "心", "⼿": "手",
  "⽆": "无", "⽇": "日", "⽉": "月", "⽊": "木", "⽋": "欠",
  "⽌": "止", "⽍": "歹", "⽓": "气", "⽔": "水", "⽕": "火", "⽗": "父",
  "⽜": "牛", "⽞": "玄", "⽟": "玉", "⽢": "甘", "⽣": "生", "⽤": "用",
  "⽥": "田", "⽪": "皮", "⽬": "目", "⽯": "石", "⽰": "示", "⽲": "禾",
  "⽳": "穴", "⽴": "立", "⽵": "竹", "⽶": "米", "⽷": "糸", "⽻": "羽",
  "⽼": "老", "⽽": "而", "⽿": "耳", "⾃": "自", "⾄": "至", "⾆": "舌",
  "⾈": "舟", "⾍": "虫", "⾎": "血", "⾏": "行", "⾐": "衣",
  "⾒": "见", "⾓": "角", "⾔": "言", "⾕": "谷", "⾖": "豆", "⾚": "赤",
  "⾛": "走", "⾞": "车", "⾟": "辛", "⾠": "辰",
  "⾣": "酉", "⾤": "采", "⾥": "里", "⾦": "金", "⾨": "门",
  "⾬": "雨", "⾭": "青", "⾮": "非", "⾯": "面",
  "⾰": "革", "⾱": "韦", "⾲": "韭", "⾳": "音", "⾴": "页", "⾵": "风",
  "⾶": "飞", "⾷": "食", "⾹": "香", "⾺": "马", "⾻": "骨", "⾼": "高",
  "⿂": "鱼", "⿃": "鸟", "⿅": "鹿", "⿆": "麦", "⿇": "麻",
  "⿈": "黄", "⿉": "黍", "⿊": "黑",
  "⿍": "鼎", "⿎": "鼓", "⿏": "鼠", "⿐": "鼻", "⿑": "齐",
  "⿒": "齿", "⿓": "龙", "⿔": "龟",
};

function fixRadicals(s: string): string {
  if (!s) return s;
  // U+2E80–U+2FDF = CJK Radicals Supplement + Kangxi Radicals (the full
  // range both the observed and plausible variants live in).
  return s.replace(/[⺀-⿟]/g, (ch) => RADICAL_MAP[ch] ?? ch);
}

function esc(s: string): string {
  return fixRadicals(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Undo inlineMd's pre-escaping so we operate on raw text inside $...$. */
function unesc(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Reduce a LaTeX fragment to HTML. Escape everything, then restore only the
 * exact tags we emit — no sentinel/placeholder tricks.
 */
function reduceLatex(tex: string): string {
  let t = unesc(tex);
  t = t.replace(/%[^\n]*/g, "");
  // Normalize upstream spacing damage FIRST:
  //   \mathrm { O } _ { 2 }  →  \mathrm{O}_{2}
  t = t.replace(/\\([a-zA-Z]+)\s*\{/g, "\\$1{");
  t = t.replace(/([_^])\s*\{/g, "$1{");
  t = t.replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>");
  t = t.replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>");
  t = t.replace(/_([A-Za-z0-9])/g, "<sub>$1</sub>");
  t = t.replace(/\^([A-Za-z0-9])/g, "<sup>$1</sup>");
  // \mathrm{X} — double-brace form first ({ {FR} }), then single, trimming
  // inner spaces. Both tolerate the spacing normalized above.
  t = t.replace(/\\mathrm\s*\{\{([^{}]+)\}\}/g, (_m, c: string) => c.trim());
  t = t.replace(/\\mathrm\s*\{([^{}]*)\}/g, (_m, c: string) => c.trim());
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
  t = t.replace(/\\([a-zA-Z]+)\s*/g, "$1");
  // After the backslash strip above, leftover backslash-less `mathrm` tokens
  // (upstream extraction sometimes drops the backslash entirely):
  t = t.replace(/(^|[^a-zA-Z])mathrm\s*\{([^{}]*)\}/g, (_m, a: string, b: string) => a + b.trim());
  t = t.replace(/(^|[^a-zA-Z])mathrm\b/g, "$1");
  t = t.replace(/[{}]/g, "");
  t = t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  t = t.replace(/&lt;(\/?)(sub|sup|i|b)&gt;/g, "<$1$2>");
  return t;
}

function renderMath(input: string): string {
  if (!input) return "";
  let out = "";
  let i = 0;
  while (i < input.length) {
    if (input[i] === "$" && input[i + 1] === "$") {
      const end = input.indexOf("$$", i + 2);
      if (end === -1) {
        out += input.slice(i);
        break;
      }
      out += `<div class="math-block">${reduceLatex(input.slice(i + 2, end))}</div>`;
      i = end + 2;
    } else if (input[i] === "$") {
      const end = input.indexOf("$", i + 1);
      if (end === -1) {
        out += input.slice(i);
        break;
      }
      out += `<span class="math">${reduceLatex(input.slice(i + 1, end))}</span>`;
      i = end + 1;
    } else {
      out += input[i];
      i++;
    }
  }
  return out;
}

function inlineMd(s: string): string {
  let t = esc(s ?? "");
  t = renderMath(t);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[新增\]/g, '<span class="mk mk-add">新增</span>');
  t = t.replace(/\[删除\]/g, '<span class="mk mk-del">删除</span>');
  t = t.replace(/\[修改\]/g, '<span class="mk mk-mod">修改</span>');
  t = t.replace(/\[保留\]/g, '<span class="mk mk-keep">保留</span>');
  t = t.replace(/【原文事实】/g, '<span class="tag tag-fact">原文事实</span>');
  t = t.replace(/【模型推断】/g, '<span class="tag tag-infer">模型推断</span>');
  t = t.replace(/【待人工确认】/g, '<span class="tag tag-todo">待人工确认</span>');
  t = t.replace(/《([^》\n]+)》/g, '<span class="quote">《$1》</span>');
  return t;
}

/** Render a table cell — multi-line cells become <br> separated lines. */
function cellHtml(s: string): string {
  if (!s) return "";
  return s
    .split("\n")
    .map((l) => inlineMd(l))
    .join("<br>");
}

// ---------------------------------------------------------------------------
// 3. Table collection (multi-line rows) + parsing
// ---------------------------------------------------------------------------

type ParsedTable = {
  rows: string[][]; // rows[0] = header; multi-line cells joined with \n
  isComparison: boolean; // version-in-row table (| 版本/来源 | ... |)
  versionIdx: number;
  comparisonCols: Array<"A" | "B" | "C">;
  /** Present when the table is horizontal (A/B/C as header columns). */
  horizontalCols?: { A: number; B: number; C: number };
};

function parseTableRow(line: string): string[] {
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "").replace(/\\\|/g, "@@PIPE@@");
  return trimmed.split("|").map((c) => c.trim().replace(/@@PIPE@@/g, "|"));
}

/**
 * Collect a table block starting at `start`. Each `|`-leading line starts a
 * NEW row (regardless of whether the previous row was "open" / multi-line).
 * Within a row, non-`|` continuation lines accumulate until the next `|` line.
 *
 * Why the change: when a row's last cell has multi-line content (no trailing
 * `|`), the previous implementation kept accumulating into a `open=true`
 * state, then when it hit the next `|`-leading line (which is supposed to be
 * the NEXT row), it incorrectly appended that line to the same row. The fix
 * is to always treat `|`-leading lines as new-row boundaries.
 */
function collectTableRows(lines: string[], start: number): { rowLines: string[]; next: number } {
  const rowLines: string[] = [];
  let cur: string[] = [];
  let open = false;
  let i = start;
  while (i < lines.length) {
    const raw = lines[i];
    const t = raw.trim();
    if (t === "") break;
    if (t.startsWith("|")) {
      // Always flush previous row, then start a new one. A row that ends
      // with `|` still needs to be pushed (old code only pushed when the
      // row was "open" / multi-line, which silently dropped closed rows).
      if (cur.length) rowLines.push(cur.join("\n"));
      cur = [raw];
      open = !t.endsWith("|");
      i++;
      continue;
    }
    if (open) {
      cur.push(raw);
      i++;
      continue;
    }
    break;
  }
  if (cur.length) rowLines.push(cur.join("\n"));
  return { rowLines, next: i };
}

/** Which header cell holds the version label (版本 / 来源 / version). */
function findVersionIdx(header: string[]): number {
  for (let i = 0; i < header.length; i++) {
    const h = (header[i] ?? "").replace(/\*/g, "").trim();
    if (/^(版本|来源|version)$/i.test(h)) return i;
  }
  return -1;
}

/** Normalize a raw version label ("A 草案", "**B 现行**", "C") to A/B/C. */
function normVersion(label: string): "A" | "B" | "C" | null {
  const t = (label ?? "").replace(/\*/g, "").trim().toUpperCase();
  if (/^A(\s|$|版|草案)/.test(t)) return "A";
  if (/^B(\s|$|版|现行)/.test(t)) return "B";
  if (/^C(\s|$|版|UN|R48)/.test(t)) return "C";
  return null;
}

function parseTable(rowLines: string[]): ParsedTable | null {
  if (rowLines.length < 2) return null;
  const rows: string[][] = [];
  for (const raw of rowLines) {
    const line = raw.trim();
    if (/^\|[\s:|-]+\|?$/.test(line) && !line.includes("\n")) continue; // separator row
    rows.push(parseTableRow(raw));
  }
  if (rows.length < 2) return null;
  const header = rows[0];
  const versionIdx = findVersionIdx(header);
  if (versionIdx < 0) {
    // No 版本/来源 column — try the horizontal form before giving up.
    const hCols = findHorizontalVersionCols(header);
    if (hCols) {
      return {
        rows,
        isComparison: true,
        versionIdx: -1,
        comparisonCols: ["A", "B", "C"],
        horizontalCols: hCols,
      };
    }
    return { rows, isComparison: false, versionIdx: -1, comparisonCols: [] };
  }
  const cols: Array<"A" | "B" | "C"> = [];
  for (const r of rows.slice(1)) {
    const v = normVersion(r[versionIdx] ?? "");
    if (v && !cols.includes(v)) cols.push(v);
  }
  return {
    rows,
    isComparison: cols.length >= 1,
    versionIdx,
    comparisonCols: (["A", "B", "C"] as const).filter((v) => cols.includes(v)),
  };
}

// ---------------------------------------------------------------------------
// 4. Impact Matrix (🔧 🧪 📋 ⚠)
// ---------------------------------------------------------------------------

type ImpactMatrix = { design: string; test: string; certification: string; risk: string };

function extractImpactMatrix(block: string): ImpactMatrix | null {
  const pick = (icon: string, label: string): string => {
    const re = new RegExp(`${icon}\\s*\\**\\s*${label}\\s*\\**\\s*[：:]\\s*([^\\n]+)`);
    const m = block.match(re);
    return m ? m[1].trim().replace(/\*\*/g, "") : "";
  };
  const design = pick("🔧", "设计影响");
  const test = pick("🧪", "测试影响");
  const certification = pick("📋", "认证影响");
  const risk = pick("⚠", "风险等级");
  if (!design && !test && !certification && !risk) return null;
  return { design, test, certification, risk };
}

function renderImpactMatrix(im: ImpactMatrix): string {
  const cell = (icon: string, label: string, content: string, accent: string) => `
<div class="impact-cell" style="--accent:${accent}">
  <div class="impact-head"><span class="impact-icon">${icon}</span><span class="impact-label">${esc(label)}</span></div>
  <div class="impact-body">${content ? cellHtml(content) : '<span class="impact-empty">未填写</span>'}</div>
</div>`;
  return `
<div class="impact-matrix">
  ${cell("🔧", "设计影响", im.design, "#a17334")}
  ${cell("🧪", "测试影响", im.test, "#0c1a2b")}
  ${cell("📋", "认证影响", im.certification, "#3a6b4f")}
  ${cell("⚠", "风险等级", im.risk, "#a23030")}
</div>`;
}

const IMPACT_LINE = /^(🔧|🧪|📋|⚠)/;

function tryExtractImpactMatrix(lines: string[], start: number): { html: string; consumed: number } | null {
  const buffer: string[] = [];
  let i = start;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t.startsWith(">") || IMPACT_LINE.test(t)) {
      buffer.push(t.replace(/^>\s?/, ""));
      i++;
    } else break;
  }
  if (buffer.length < 2) return null;
  const im = extractImpactMatrix(buffer.join("\n"));
  if (!im) return null;
  return { html: renderImpactMatrix(im), consumed: buffer.length };
}

// ---------------------------------------------------------------------------
// 5. 变化判定 verdict strip
// ---------------------------------------------------------------------------

function renderVerdict(text: string): string {
  // Normalize bold markers FIRST so `**变化判定**：` matches the patterns.
  const src = text.replace(/\*\*变化判定\*\*/g, "变化判定").replace(/\*\*/g, "");
  const bk = src.match(/变化判定\s*[：:]\s*`([^`]+)`/);
  const em = bk ? null : src.match(/变化判定\s*[：:]\s*([🔴🟢🟡⚪🟠]\s*[^\s—–|，,。;；]*)/);
  const pl = bk || em ? null : src.match(/变化判定\s*[：:]\s*([^\s—–|，,。;；]+)/);
  const label = bk ? bk[1].trim() : em ? em[1].trim() : pl ? pl[1].trim() : "变化判定";
  let rest = src.replace(/变化判定\s*[：:]\s*/, "");
  if (bk) rest = rest.replace(`\`${bk[1]}\``, "");
  else if (em) rest = rest.replace(em[1], "");
  else if (pl) rest = rest.replace(pl[1], "");
  rest = rest.replace(/^[｜|\s·\-—*]+/, "").trim();
  let cls = "v-gray";
  if (/🔴|实质/.test(label)) cls = "v-red";
  else if (/🟡|格式|局部/.test(label)) cls = "v-amber";
  else if (/🟢|一致|相同|保留|无需/.test(label)) cls = "v-green";
  return `<div class="verdict-strip ${cls}"><span class="v-chip">${esc(label)}</span><span class="v-rest">${cellHtml(rest)}</span></div>`;
}

// ---------------------------------------------------------------------------
// 6. Master Parameter Index (header-driven, numeric-guarded)
// ---------------------------------------------------------------------------

type MasterParamRow = { param: string; aValue: string; bValue: string; cValue: string; note: string; src: string };

const PARAM_PATTERNS = [/主题·参数/, /参数/, /项目/, /指标/, /^主题$/, /^装置$/, /^类别$/, /新概念/];

function findCol(header: string[], re: RegExp): number {
  return header.findIndex((h) => re.test((h ?? "").replace(/\*/g, "").trim()));
}

function extractMasterParams(chapters: ReportChapter[]): MasterParamRow[] {
  const seen = new Map<string, MasterParamRow>();
  // Quantitative guard: digit next to a unit, or a decimal number.
  const quantitative = /(\d+(\.\d+)?\s*(mm|cm|km\/h|m\b|cd|Hz|%|°|lx|s\b|ms|min|V\b|mA\b|W\b|nm|只|条|个|级|档|类|种|km\b))|(\d+\.\d+)/i;

  for (const ch of chapters) {
    const lines = ch.markdown.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim().startsWith("|")) {
        i++;
        continue;
      }
      const { rowLines, next } = collectTableRows(lines, i);
      i = next;
      const parsed = parseTable(rowLines);
      if (!parsed || parsed.rows.length < 2) continue;
      const header = parsed.rows[0];

      // Must be an A/B comparison table with explicit version columns.
      const bValue = findCol(header, /B\s*现行/);
      const aValue = findCol(header, /A\s*草案/);
      if (aValue < 0 || bValue < 0) continue;

      // Param column by priority.
      let paramIdx = -1;
      for (const p of PARAM_PATTERNS) {
        paramIdx = findCol(header, p);
        if (paramIdx >= 0) break;
      }
      if (paramIdx < 0 || paramIdx === aValue || paramIdx === bValue) continue;

      // Optional locator / C / note columns.
      const aClause = findCol(header, /A\s*编号/);
      const aPage = findCol(header, /A\s*页码/);
      const bClause = findCol(header, /B\s*编号/);
      const bPage = findCol(header, /B\s*页码/);
      const cIdx = findCol(header, /C\s*参照|C\s*UN|R48|国际参照/);
      const noteIdx = findCol(header, /差异|说明|降级|分级|判定|状态|核验/);

      const clean = (s: string): string => {
        const t = (s ?? "").replace(/\*\*/g, " ").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
        if (!t) return "—";
        return t.length > 44 ? t.slice(0, 44) + "…" : t;
      };
      const joinCols = (row: string[], ...idxs: number[]): string => {
        const parts: string[] = [];
        for (const idx of idxs) {
          if (idx < 0 || idx === paramIdx) continue;
          const v = clean(row[idx] ?? "");
          if (v && v !== "—" && !parts.includes(v)) parts.push(v);
        }
        return parts.join(" · ");
      };

      for (const row of parsed.rows.slice(1)) {
        const param = clean(row[paramIdx] ?? "");
        if (!param || param === "—" || param.length < 2 || param.length > 60) continue;
        if (seen.has(param)) continue;
        const aC = clean(joinCols(row, aValue, aClause, aPage) || "—");
        const bC = clean(joinCols(row, bValue, bClause, bPage) || "—");
        const cC = cIdx >= 0 ? clean(row[cIdx] ?? "") : "—";
        if (!quantitative.test(`${aC} ${bC} ${cC}`)) continue;
        seen.set(param, {
          param,
          aValue: aC,
          bValue: bC,
          cValue: cC,
          note: noteIdx >= 0 ? clean(row[noteIdx] ?? "") : "",
          src: `${ch.id} ${ch.title}`,
        });
        if (seen.size >= 40) break;
      }
      if (seen.size >= 40) break;
    }
  }
  return Array.from(seen.values());
}

function renderMasterParams(rows: MasterParamRow[]): string {
  if (!rows.length) return "";
  const body = rows
    .map(
      (r) => `<tr>
      <td class="mp-name">${cellHtml(r.param)}</td>
      <td>${cellHtml(r.aValue)}</td>
      <td>${cellHtml(r.bValue)}</td>
      <td>${cellHtml(r.cValue)}</td>
      <td class="mp-note">${cellHtml(r.note || "—")}</td>
      <td class="mp-src">${esc(r.src)}</td>
    </tr>`,
    )
    .join("");
  return `
<section class="front-block">
  <header class="mp-head">
    <span class="mp-eyebrow">Master Parameter Index</span>
    <h2>核心参数 A/B/C 同框总表</h2>
    <p class="mp-sub">从全报告扫描并按表头对齐的关键量化参数（A/B/C 三版并排）· 共 ${rows.length} 项 · “—” = 源数据未提供该版本数值</p>
  </header>
  <table class="mp-table">
    <thead>
      <tr>
        <th>参数</th>
        <th style="--c:#a17334">A 草案</th>
        <th style="--c:#0c1a2b">B 现行</th>
        <th style="--c:#3a6b4f">C UN R48</th>
        <th>差异 / 状态</th>
        <th>来源</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// 7. Clause cross-reference index (from version-row comparison tables)
// ---------------------------------------------------------------------------

type ClauseMapRow = { topic: string; a: string; b: string; c: string; src: string };

function looksLikePage(s: string): boolean {
  return /第\s*\d+\s*页|^p\s*\d+$/i.test((s ?? "").trim());
}

function extractClauseMapping(chapters: ReportChapter[]): ClauseMapRow[] {
  const rows: ClauseMapRow[] = [];
  const seen = new Set<string>();
  for (const ch of chapters) {
    const lines = ch.markdown.split("\n");
    let topic = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const hm = line.match(/^#{2,4}\s+(.*)$/);
      if (hm) {
        topic = hm[1].replace(/[*`]/g, "").trim().slice(0, 36);
        i++;
        continue;
      }
      if (line.startsWith("|")) {
        const { rowLines, next } = collectTableRows(lines, i);
        i = next;
        const parsed = parseTable(rowLines);
        if (!parsed || !parsed.isComparison) continue;
        const vIdx = parsed.versionIdx;
        const byVer: Record<string, string[]> = {};
        for (const r of parsed.rows.slice(1)) {
          const v = normVersion(r[vIdx] ?? "");
          if (v && !byVer[v]) byVer[v] = r.slice(vIdx + 1);
        }
        if (!byVer.A && !byVer.B && !byVer.C) continue;
        const fmt = (cells?: string[]): string => {
          if (!cells || !cells.length) return "—";
          const page = cells.find((c) => looksLikePage(c));
          // clause: a short cell that is not a page, not a raw formula, and
          // not a pointer/placeholder or column-header name from the source
          // table (见下方表格内容 / 表头摘要 … are NOT clause identifiers).
          const POINTER = /^(见下方|见下表|见上面|见上表|见表|见下|见上|同上|同左|同前|略|无|N\/?A|（略）)/;
          const HEADER_NAME = /^(表头摘要|完整内容|页码|来源|条款|页|编号|版本|状态|说明|备注)$/;
          const clause = cells.find((c) => {
            const s = (c ?? "").replace(/[*\s]/g, "");
            return s && !looksLikePage(c) && !/[$\\{}]/.test(c) && !POINTER.test(s) && !HEADER_NAME.test(s) && s.length <= 30;
          });
          const parts: string[] = [];
          if (clause) parts.push(clause.replace(/\*\*/g, "").replace(/\n/g, " ").slice(0, 24));
          if (page) parts.push(page.replace(/\*\*/g, "").trim());
          return parts.join(" · ") || "—";
        };
        const entry: ClauseMapRow = {
          topic: topic || "（本章）",
          a: fmt(byVer.A),
          b: fmt(byVer.B),
          c: fmt(byVer.C),
          src: `第${ch.id}章`,
        };
        const key = `${entry.a}|${entry.b}|${entry.c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(entry);
        if (rows.length >= 70) return rows;
        continue;
      }
      i++;
    }
  }
  return rows;
}

function renderMappingIndex(rows: ClauseMapRow[]): string {
  if (!rows.length) return "";
  const body = rows
    .map(
      (r) => `<tr>
        <td class="mp-name">${cellHtml(r.topic)}</td>
        <td>${cellHtml(r.a)}</td>
        <td>${cellHtml(r.b)}</td>
        <td>${cellHtml(r.c)}</td>
        <td class="mp-src">${esc(r.src)}</td>
      </tr>`,
    )
    .join("");
  return `
<section class="front-block">
  <header class="mp-head">
    <span class="mp-eyebrow">Cross-Reference Index</span>
    <h2>三版条款 · 页码映射总表</h2>
    <p class="mp-sub">按主题横向对应 A / B / C 三份文件的条款号与原文页码 · 共 ${rows.length} 条 · 用于全文反查定位</p>
  </header>
  <table class="mp-table">
    <thead>
      <tr>
        <th style="width:26%">主题</th>
        <th style="--c:#a17334">A 草案 条款 · 页</th>
        <th style="--c:#0c1a2b">B 现行 条款 · 页</th>
        <th style="--c:#3a6b4f">C UN R48 条款 · 页</th>
        <th>来源</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// 8. Triptych (always 3 cards) + plain table
// ---------------------------------------------------------------------------

const DOC_META: Record<string, { label: string; short: string; name: string; color: string; bg: string }> = {
  A: { label: "A", short: "草案", name: "GB 4785 草案 V4.3.5", color: "#a17334", bg: "#fdf3df" },
  B: { label: "B", short: "现行", name: "GB 4785-2019", color: "#0c1a2b", bg: "#eef1f5" },
  C: { label: "C", short: "UN", name: "UN R48-09", color: "#3a6b4f", bg: "#e3f2e8" },
};

/**
 * Front-matter symbol legend page. Explains every tag the report uses so
 * readers don't lose context between chapters. Pre-pended by buildHtml.
 */
function renderSymbolLegend(): string {
  const status = [
    { sym: "✅", tag: "已核验", cls: "ok",     desc: "实质技术变更 — A、B 两份原文 + 双方页码均已核验到位。", sample: "可直接作为变更依据。" },
    { sym: "⚠", tag: "待复核", cls: "warn",   desc: "单源核验 / 未定位 / 待人工确认 — 不能直接采信。", sample: "需工程师逐条人工核对原始 PDF。" },
    { sym: "🟡", tag: "同文勘误", cls: "muted", desc: "文本差异但实质内容相同 — 常见于 OCR 截断、标点差异。", sample: "通常从「变更汇总」中剔除。" },
    { sym: "🔢", tag: "仅编号重排", cls: "muted", desc: "A 草案做章节重组，条款号变化但技术内容未变。", sample: "不计入技术变化。" },
    { sym: "✍", tag: "格式同义改写", cls: "muted", desc: "措辞 / 标点 / 数字格式差异，技术含义一致。", sample: "如「两只」→「2只」。不计入技术变化。" },
  ];
  const impact = [
    { sym: "🔧", tag: "设计影响",   cls: "design", desc: "硬件 / 软件设计层面需要变更的内容。", sample: "例：增加 AFS 单元 / 重新开模。" },
    { sym: "🧪", tag: "测试影响",   cls: "test",   desc: "新增 / 调整的测试项目或试验条件。", sample: "例：近光 4° 对称性测试。" },
    { sym: "📋", tag: "认证影响",   cls: "cert",   desc: "对认证流程 / 周期 / 文件的影响。", sample: "例：型式认证新增 1 道工序。" },
    { sym: "⚠", tag: "风险等级",   cls: "warn",   desc: "高 / 中 / 低 — 由 4 维影响卡自动归类。", sample: "风险高 → 立刻评估产品端。" },
    { sym: "本版未规定", tag: "占位", cls: "muted", desc: "该版本无对应子条款 / 数据未抽取。", sample: "灰色卡，不视作差异。" },
    { sym: "•", tag: "项目符号",   cls: "muted", desc: "执行摘要 / 速查表的列表项，每行一项。", sample: "" },
  ];
  const card = (g: typeof status[0]) => `
    <article class="legend-card legend-${g.cls}">
      <header class="legend-card-h">
        <span class="legend-sym">${esc(g.sym)}</span>
        <span class="legend-tag">${esc(g.tag)}</span>
      </header>
      <p class="legend-desc">${esc(g.desc)}</p>
      ${g.sample ? `<p class="legend-sample">${esc(g.sample)}</p>` : ""}
    </article>`;
  return `
<section class="symbol-legend">
  <h1 class="legend-title">符号说明 · Report Legend</h1>
  <p class="legend-intro">本报告所有章节共用以下符号。请在阅读任意章节前先浏览一遍，避免忘记标记含义。</p>

  <h2 class="legend-h2">状态标记 · 决定条目是否可信</h2>
  <div class="legend-grid">
    ${status.map(card).join("\n")}
  </div>

  <h2 class="legend-h2">影响标记 · 决定工程师关注点</h2>
  <div class="legend-grid">
    ${impact.map(card).join("\n")}
  </div>

  <p class="legend-warn">⚠ 重要：执行摘要（首页）只引用 ✅ 条目；⚠ / 🟡 / 🔢 / ✍ 仅出现在主章节与汇总表中，不得作为变更依据。</p>
</section>`;
}

/**
 * Aggregate candidate-difference closure counts.
 *
 * Delegates to trustChecks.extractClosureCounts so the PDF front-matter and
 * the /review workbench can never disagree. This used to be a second,
 * slightly-different implementation (it filtered chapters by title), which
 * produced 27/21/3 in the PDF vs 39/30/4 in the UI for the same report —
 * exactly the kind of drift a reader loses trust over.
 */
function extractClosureCounts(chapters: { markdown?: string }[]) {
  const md = reportMarkdown(chapters as Array<{ markdown?: string }>);
  return extractClosureCountsFromMd(md);
}

/**
 * Classify a transition row by intended audience — this drives the row's
 * visual grouping in the table.
 */
function classifyScope(text: string): "新申请车型" | "已获批准车型" | "通用" {
  if (/新申请|新近|2026-09-?30|现行|本日|新型式/.test(text)) return "新申请车型";
  if (/已获|已批准|扩展|延续|transitional|extension/.test(text)) return "已获批准车型";
  return "通用";
}

/**
 * Extract transitional/effective-date mentions across all chapters. Heuristic
 * scan for ISO 8601 (yyyy-MM-dd), Chinese 年/月/日, and "N months after entry
 * into force" patterns. Returns one row per clause/source excerpt.
 */
function extractTransitionDates(chapters: { title: string; markdown?: string }[]) {
  type Row = { tag: string; trigger: string; delay: string; excerpt: string; scope: "新申请车型" | "已获批准车型" | "通用" };
  const rows: Row[] = [];
  const tagSet = new Set<string>();
  // Match dates inside clauses like 12.7.2 / 12.8.4 / 12.8.5 and following text
  const clauseRx = /(12\.[78]\.\d+(?:\.\d+)?|表\s*\d+|图\s*\d+|本文件(?:实施|施行)|自本文件实施之日起[^,。;\n]{0,20})/;
  const dateRx = /(20\d{2}[-/](?:0?[1-9]|1[0-2])(?:[-/](?:0?[1-9]|[12]\d|3[01]))?|第?\s*\d+\s*个?月|2025-09-26|2026-?09-30|2027|实施之日起[^,。;\n]{0,30}|生效[^,。;\n]{0,15})/;
  for (const ch of chapters) {
    const md = ch.markdown || "";
    // find lines containing clause + date
    for (const line of md.split(/\n+/)) {
      const clause = line.match(clauseRx)?.[0];
      const date = line.match(dateRx)?.[0];
      if (!clause && !date) continue;
      // Heuristic: only count lines with date-like content
      if (!/\d{4}\s*年|\d{4}-\d{2}|个?月|施行|生效|起/.test(line)) continue;
      const tag = clause || line.slice(0, 40);
      if (tagSet.has(tag)) continue;
      tagSet.add(tag);
      const excerpt = line.slice(0, 200).replace(/\|/g, " ");
      rows.push({
        tag,
        trigger: (date || "").trim(),
        delay: /\d+\s*个?月/.test(line) ? (line.match(/\d+\s*个?月[^,。;\n]{0,15}/)?.[0] ?? "") : "",
        excerpt,
        scope: classifyScope(excerpt),
      });
      if (rows.length >= 12) return rows;
    }
  }
  return rows;
}

/**
 * Bold key milestones (25/37/61/24/36 个月, transition dates) inside the
 * excerpt so they survive a quick scan.
 */
function highlightMilestones(html: string): string {
  return html
    .replace(/(\d{1,3}\s*个?月)/g, '<strong class="ms">$1</strong>')
    .replace(/(20\d{2}-\d{2}-\d{2})/g, '<strong class="ms">$1</strong>');
}

function renderTransitionTable(rows: ReturnType<typeof extractTransitionDates>): string {
  if (!rows.length) return "";
  const order = { "新申请车型": 0, "已获批准车型": 1, "通用": 2 } as const;
  const sorted = [...rows].sort((a, b) => order[a.scope] - order[b.scope]);
  let lastScope = "";
  const body = sorted.map((r) => {
    const scopeRow = r.scope !== lastScope
      ? `<tr class="scope-row"><td colspan="3">${esc(r.scope)}</td></tr>`
      : "";
    lastScope = r.scope;
    const trigger = [r.trigger, r.delay].filter(Boolean).join(" · ");
    return `${scopeRow}<tr>
      <td class="td-tag">${esc(r.tag)}</td>
      <td class="td-trigger">${esc(trigger)}</td>
      <td class="td-excerpt">${highlightMilestones(esc(r.excerpt))}</td>
    </tr>`;
  }).join("\n");
  return `
<section class="transition-table">
  <h1 class="transition-title">过渡期生效汇总表 · Transition Periods</h1>
  <p class="transition-intro">按「新申请车型 / 已获批准车型 / 通用」三类分组；按出现顺序抓取最多 12 条。<strong class="ms">加粗月份</strong>为关键节点，必须按版本发布日换算绝对生效日。</p>
  <table class="transition-grid">
    <thead>
      <tr><th class="bg-mono">条款 / 表号</th><th class="bg-mono">生效触发</th><th>原文摘录（<strong class="ms">关键月份加粗</strong>）</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>
  <p class="transition-warn">以上为机器抓取 — 完整日期表请回阅第 10 章「附录与实施」与附录 A 原始表格。</p>
</section>`;
}

function renderClosureDashboard(counts: ReturnType<typeof extractClosureCounts>, discrepancies: string[] = []): string {
  const total = counts.confirmed + counts.candidate + counts.errata + counts.renum + counts.format;
  const pct = (n: number) => total > 0 ? Math.round((n / total) * 100) : 0;
  const candidateShare = pct(counts.candidate);
  const isHighRisk = candidateShare >= 50;

  // Stacked-bar chart at the top. Segments are laid out left-to-right by
  // accumulating a running offset — computing x from (1 - pct) made every
  // segment start at 0, so they overlapped and only the last one was visible.
  let offset = 0;
  const seg = (n: number, color: string) => {
    if (n <= 0 || total <= 0) return "";
    const w = (n / total) * 100;
    const rect = `<rect x="${offset.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="14" fill="${color}" />`;
    offset += w;
    return rect;
  };
  const bar = `
  <svg class="dashboard-bar" viewBox="0 0 100 14" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
    ${seg(counts.confirmed, "#3a6b4f")}
    ${seg(counts.candidate, isHighRisk ? "#c9542a" : "#b9a173")}
    ${seg(counts.errata, "#9c8b6c")}
    ${seg(counts.renum, "#c0b89c")}
    ${seg(counts.format, "#d9cfb6")}
  </svg>`;

  const row = (cls: string, icon: string, label: string, n: number, note: string) => `
    <tr class="${cls}">
      <td class="td-icon">${esc(icon)}</td>
      <td class="td-label">${esc(label)}</td>
      <td class="td-count">${n}</td>
      <td class="td-pct">${pct(n)}%</td>
      <td class="td-note">${esc(note)}</td>
    </tr>`;

  return `
<section class="closure-dashboard">
  <h1 class="dashboard-title">候选差异闭环统计 · Closure Dashboard</h1>
  <p class="dashboard-intro">对第 11 章「关键变化点汇总」与第 10 章「新增/删除/重大修订」逐项扫描后，按 5 类差异标记分类计数。${total} 条候选差异中，<strong>${counts.candidate} 条 (${candidateShare}%) 仍处于待复核状态</strong>${isHighRisk ? " — 比例偏高，工程师在采信前必须人工逐条核对原始 PDF。" : "。"}</p>

  <figure class="claim-figure">
    ${bar}
    <figcaption class="claim-caption">
      <span><b style="color:#3a6b4f">✅</b> ${pct(counts.confirmed)}%</span>
      <span><b style="color:${isHighRisk ? "#c9542a" : "#b9a173"}">⚠</b> ${candidateShare}%</span>
      <span><b style="color:#9c8b6c">🟡</b> ${pct(counts.errata)}%</span>
      <span><b style="color:#c0b89c">🔢</b> ${pct(counts.renum)}%</span>
      <span><b style="color:#d9cfb6">✍</b> ${pct(counts.format)}%</span>
    </figcaption>
  </figure>

  <table class="closure-table">
    <thead>
      <tr><th>标记</th><th>类别</th><th>数量</th><th>占比</th><th>说明</th></tr>
    </thead>
    <tbody>
      ${row("row-confirmed", "✅", "已双源核验", counts.confirmed, "A、B 原文与页码均已定位，可作为变更依据")}
      ${row("row-candidate", "⚠", "待复核", counts.candidate, "单源 / 缺页码 — 仅供工程师参考，输入合规判定前必须人工确认")}
      ${row("row-errata", "🟡", "同文勘误", counts.errata, "之前误判为变化的文本差异，实质内容相同")}
      ${row("row-renum", "🔢", "仅编号重排", counts.renum, "章节号变更但技术内容不变 — 不计入技术变化")}
      ${row("row-format", "✍", "格式同义改写", counts.format, "标点 / 措辞差异（如「两只」→「2只」）— 不计入技术变化")}
      <tr class="row-total">
        <td colspan="2"><strong>合计</strong></td>
        <td><strong>${total}</strong></td>
        <td>100%</td>
        <td>—</td>
      </tr>
    </tbody>
  </table>

  ${isHighRisk
    ? `<p class="dashboard-disclaimer dashboard-risk">⚠ 风险提示：本报告 ${candidateShare}% 的差异尚未完成双源核验 — 切勿直接采信任何 ⚠ 条目结论。所有 ✅ / ⚠ 之外的标记（🟡 / 🔢 / ✍）均不计入「实质技术变化」总数。</p>`
    : `<p class="dashboard-disclaimer">注：本报告为 AI 自动生成的辅助研究工具，合规判定必须查阅官方原始标准文本（GB 4785-2019 / GB 4785 草案 V4.3.5 / UN R48-09）。</p>`}

  <p class="dashboard-method">
    统计口径：以上数字由 <b>条目级台账</b>逐表统计得出（每个数字 = 对应表格的实际行数），
    <u>不是</u>对标记字符串的出现次数。台账来源：§11.3 数值变化表 · §11.3.0 同文勘误表 ·
    §11.6.1 章节重排表 · §11.8 表述复核清单 · 各章 ⚠ 未找到 / manual-audit 行。
  </p>
${discrepancies.length ? `<div class="reconcile-box">
    <p class="reconcile-title">⚠ 账目对账：报告自述与台账实算不一致（${discrepancies.length} 项）</p>
    <ul class="reconcile-list">
      ${discrepancies.map((d) => `<li>${esc(d)}</li>`).join("\n      ")}
    </ul>
    <p class="reconcile-hint">以上差异源于报告正文自述数字与表格实际行数不符。
    以台账（表格行数）为准；正文中冲突的数字需人工裁定后修正。</p>
  </div>` : ""}
</section>`;
}

/**
 * 待复核明细 — every ⚠ entry, one row each.
 *
 * The dashboard only says "26 条待复核". An engineer cannot act on a count;
 * they need to know WHICH parameters, WHY each is unverified, and which pages
 * to open. This renders the ledger's candidate rows as a worklist.
 */
function renderCandidateWorklist(ledger: ReturnType<typeof buildLedger>): string {
  const items = ledger.entries.filter((e) => e.category === "candidate");
  if (!items.length) return "";

  // Group by reason so a reviewer can see which failure mode dominates.
  const byReason = new Map<string, number>();
  for (const it of items) {
    const key = (it.reason ?? "未分类").slice(0, 24);
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const reasonSummary = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<li><b>${esc(r)}</b> · ${n} 条</li>`)
    .join("");

  const rows = items
    .map((it, i) => {
      const pages = (it.pages ?? []).length ? it.pages.join(" / ") : "—";
      const sec = it.section && it.section !== "正文" ? it.section : "—";
      return `<tr>
        <td class="cw-idx">${i + 1}</td>
        <td class="cw-topic">${cellHtml(it.topic)}</td>
        <td class="cw-sec">${esc(sec)}</td>
        <td class="cw-reason">${esc(it.reason ?? "未分类")}</td>
        <td class="cw-pages">${esc(pages)}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section class="candidate-worklist">
  <h1 class="cw-title">待复核明细清单 · Review Worklist</h1>
  <p class="cw-intro">
    下表逐条列出本报告 <b>${items.length}</b> 个尚未完成双源核验的条目 ——
    每条含参数、所在章节、未核验原因、可回查的原文页码。工程师可按「原因」分组分工，
    逐条打开页码核对后在审阅工作台（<code>/review</code>）标记确认 / 驳回。
  </p>
  <div class="cw-reasons">
    <p class="cw-reasons-title">未核验原因分布</p>
    <ul>${reasonSummary}</ul>
  </div>
  <table class="cw-table">
    <thead>
      <tr><th class="cw-idx">#</th><th>参数 / 主题</th><th>章节</th><th>未核验原因</th><th>可回查页码</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="cw-warn">⚠ 本清单条目<b>不得</b>直接作为合规判定依据。核验方式：打开对应页码，
  逐字比对 A 草案 V4.3.5 与 B GB 4785-2019 原文，确认差异是否真实存在。</p>
</section>`;
}

/**
 * Detect a HORIZONTAL three-version table:
 *   | 项目 | A（GB 4785 草案） | B（GB 4785-2019） | C（UN R48-09） |
 *   |------|-----|-----|-----|
 *   | 成对/对称要求 | … | … | … |
 *
 * The LLM picks the orientation per run. Only supporting the vertical form
 * (| 版本 | … | rows `| **A 草案** |`) made every horizontal table in a fresh
 * report degrade to a plain table — no triptych cards, no version colors.
 *
 * Returns the column index for A/B/C, or null when this isn't such a table.
 */
function findHorizontalVersionCols(header: string[]): { A: number; B: number; C: number } | null {
  const clean = header.map((h) => (h ?? "").replace(/\*/g, "").trim());
  const idx = (v: "A" | "B" | "C") =>
    clean.findIndex((h) => new RegExp(`^\\s*${v}(?![A-Za-z])[（(【\\s]|${v}\\s*$`).test(h));
  const A = idx("A");
  const B = idx("B");
  const C = idx("C");
  // Require three distinct columns and at least one non-version first column
  // (the topic column). Column 0 being "项目" is fine.
  if (A < 0 || B < 0 || C < 0) return null;
  if (new Set([A, B, C]).size !== 3) return null;
  return { A, B, C };
}

/** Render a horizontal 3-version table as the same triptych card layout. */
function renderHorizontalTriptych(t: ParsedTable, cols: { A: number; B: number; C: number }): string {
  const header = t.rows[0] ?? [];
  const body = t.rows.slice(1);
  // The topic column is whatever sits left of the first version column. Using
  // "first column" instead breaks on tables that begin with an empty cell.
  const versionCols = new Set([cols.A, cols.B, cols.C]);
  let topicIdx = 0;
  for (let i = 0; i < header.length; i++) {
    if (!versionCols.has(i)) { topicIdx = i; break; }
  }
  const topicLabel = (header[topicIdx] ?? "").trim() || "对比项";

  const cards = (["A", "B", "C"] as const)
    .map((v) => {
      const meta = DOC_META[v];
      const col = cols[v];
      const entries: Array<{ topic: string; text: string }> = [];
      body.forEach((r, ri) => {
        const tName = (r[topicIdx] ?? "").trim() || `第 ${ri + 1} 项`;
        const val = (r[col] ?? "").replace(/^\*\*|\*\*$/g, "").trim();
        if (val) entries.push({ topic: tName, text: val });
      });

      if (entries.length === 0) {
        return `
<article class="trip-card trip-card-missing" style="--accent:#b9a27a;--accent-bg:#f0eada">
  <header class="trip-head">
    <span class="trip-label">${esc(meta.label)}</span>
    <span class="trip-tag">${esc(meta.short)}</span>
    <span class="trip-doc">${esc(meta.name)}</span>
  </header>
  <div class="trip-missing">
    <div class="missing-mark">—</div>
    <div class="missing-text">源数据未提供</div>
    <div class="missing-hint">（本表无 ${esc(meta.label)} 版对应内容）</div>
  </div>
</article>`;
      }

      const rowsHtml = entries
        .map(
          (e) => `<div class="hz-row">
            <div class="hz-topic">${cellHtml(e.topic)}</div>
            <div class="hz-text">${cellHtml(e.text)}</div>
          </div>`,
        )
        .join("\n");
      return `
<article class="trip-card" style="--accent:${meta.color};--accent-bg:${meta.bg}">
  <header class="trip-head">
    <span class="trip-label">${esc(meta.label)}</span>
    <span class="trip-tag">${esc(meta.short)}</span>
    <span class="trip-doc">${esc(meta.name)}</span>
  </header>
  <div class="trip-meta">
    <dt>维度</dt><dd>${cellHtml(topicLabel)}</dd>
    <dt>条目</dt><dd>${entries.length}</dd>
  </div>
  <div class="hz-rows">${rowsHtml}</div>
</article>`;
    })
    .join("\n");
  return `<section class="triptych">${cards}</section>`;
}

function renderTriptych(t: ParsedTable): string {
  // Horizontal tables take a different path — see renderHorizontalTriptych.
  if (t.horizontalCols) return renderHorizontalTriptych(t, t.horizontalCols);
  const cols: Array<"A" | "B" | "C"> = ["A", "B", "C"]; // always three columns
  const body = t.rows.slice(1);
  const byVersion = new Map<string, string[]>();
  for (const row of body) {
    const v = normVersion(row[t.versionIdx] ?? "");
    if (v && !byVersion.has(v)) byVersion.set(v, row);
  }

  // Map columns by header names instead of position — real tables use
  // either |版本|条款|页码|原文摘录| or |来源|页码|表头摘要|完整内容|.
  const header = t.rows[0] ?? [];
  const normH = (h: string) => (h ?? "").replace(/[\s*]/g, "");
  const clauseCol = header.findIndex(
    (h, i) =>
      i > t.versionIdx &&
      normH(h).length <= 6 &&
      /条款|条目|主题|对照项|参数|位置|项目|级别|装置/.test(normH(h)) &&
      !/正文|摘录|内容/.test(normH(h)),
  );
  const pageCol = header.findIndex((h, i) => i > t.versionIdx && /^(页码|页)$/.test(normH(h)));
  let cCol = clauseCol;
  let pCol = pageCol;
  if (cCol < 0 && pCol < 0) {
    // completely unknown header — fall back to positional convention
    cCol = t.versionIdx + 1;
    pCol = t.versionIdx + 2;
  }
  const textCols = header.map((_, i) => i).filter((i) => i > t.versionIdx && i !== cCol && i !== pCol);

  const cards = cols
    .map((v) => {
      const meta = DOC_META[v];
      const row = byVersion.get(v);
      if (!row) {
        return `
<article class="trip-card trip-card-missing" style="--accent:#b9a27a;--accent-bg:#f0eada">
  <header class="trip-head">
    <span class="trip-label">${meta.label}</span>
    <span class="trip-tag">${esc(meta.short)}</span>
    <span class="trip-doc">${esc(meta.name)}</span>
  </header>
  <div class="trip-missing">
    <div class="missing-mark">—</div>
    <div class="missing-text">源数据未提供</div>
    <div class="missing-hint">（报告生成时 ${meta.label} 版无对应条款行；<br>渲染器补位以保持三栏对齐）</div>
  </div>
</article>`;
      }
      const clause = cCol >= 0 ? (row[cCol] ?? "—") : "—";
      const page = pCol >= 0 ? (row[pCol] ?? "—") : "—";
      const text = textCols
        .map((i) => row[i] ?? "")
        .filter((s) => s && s !== "—")
        .join("\n");
      const badge = (p: string): string => {
        const s = (p ?? "").replace(/\*\*/g, "").trim() || "—";
        const inner = cellHtml(s); // math-safe (cells may hold $...$ formulas)
        if (/✓/.test(s)) return `<span class="page-ok">${inner}</span>`;
        if (/⚠|未核验/.test(s)) return `<span class="page-warn">${inner}</span>`;
        if (/^—$|未规定|未适用/.test(s)) return `<span class="page-none">${inner}</span>`;
        return `<span class="page-ok">${inner}</span>`;
      };
      return `
<article class="trip-card" style="--accent:${meta.color};--accent-bg:${meta.bg}">
  <header class="trip-head">
    <span class="trip-label">${meta.label}</span>
    <span class="trip-tag">${esc(meta.short)}</span>
    <span class="trip-doc">${esc(meta.name)}</span>
  </header>
  <dl class="trip-meta">
    <dt>条款</dt><dd>${cellHtml(clause)}</dd>
    <dt>页码</dt><dd>${badge(page)}</dd>
  </dl>
  <div class="trip-text">${text ? cellHtml(text) : '<span class="impact-empty">本版本无对应原文</span>'}</div>
</article>`;
    })
    .join("\n");
  return `<section class="triptych">${cards}</section>`;
}

/**
 * Normalize a row's cell count to match the header width.
 * - row shorter than header → pad with "—" placeholders
 * - row longer than header → merge overflow into the last cell with <br>
 * This fixes "缺角" tables where markdown source extraction produced
 * inconsistent row widths (e.g., p41 速度 row has 4 cells vs 3-column header,
 * p39 B 表 has rows with only 2 cells vs 3-column header).
 */
function normalizeRow(row: string[], width: number): string[] {
  if (row.length === width) return row;
  if (row.length < width) {
    const pad = Array(width - row.length).fill("—");
    return [...row, ...pad];
  }
  // row.length > width — merge overflow into last cell
  const head = row.slice(0, width - 1);
  const tail = row.slice(width - 1).filter((c) => c && c.trim() !== "");
  const merged = tail.length ? tail.join("<br>") : "—";
  return [...head, merged];
}

/**
 * Cells that mean "we could not extract a real title from the source PDF".
 * These must be visually loud — a reader who mistakes one for a real title
 * will trust a caption that was never in the document.
 */
const PLACEHOLDER_TITLE_RE =
  /^[\s（(【\[]*(图标题未抽取|无题注|未抽取|待人工补充|需查源\s*PDF|源数据未提供|本版未规定)/;

/** Render a cell, flagging extraction-failure placeholders with a CSS class. */
function cellHtmlFlagged(s: string): string {
  if (!s) return "";
  const inner = cellHtml(s);
  return PLACEHOLDER_TITLE_RE.test(s.trim())
    ? `<td class="cell-placeholder">${inner}</td>`
    : `<td>${inner}</td>`;
}

function renderPlainTable(rows: string[][]): string {
  if (!rows.length) return "";
  const [header, ...body] = rows;
  const width = header.length;
  // Normalize every body row to header width so the table renders without
  // ragged columns. Cells with no source data become "—".
  const normBody = body.map((r) => normalizeRow(r, width));
  const thead = "<thead><tr>" + header.map((c) => `<th>${cellHtml(c)}</th>`).join("") + "</tr></thead>";
  const tbody =
    "<tbody>" +
    normBody
      .map((r) => "<tr>" + r.map((c) => cellHtmlFlagged(c || "—")).join("") + "</tr>")
      .join("") +
    "</tbody>";
  return `<table>${thead}${tbody}</table>`;
}

// ---------------------------------------------------------------------------
// 9. Markdown → HTML
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8.5 Typed table loader (aligned-tables.json)
// ---------------------------------------------------------------------------

/**
 * Renderer-side view of a typed table. Produced either by
 * extractTypedTables() (in-process, primary) or by deserializing the legacy
 * dist/aligned-tables.json (fallback) — both feed the same shape.
 */
type TypedTableEntry = ExtractedTypedTable & {
  source_page_hint?: { A?: string | null; B?: string | null; C?: string | null };
};

type TypedTablesBundle = {
  tables: TypedTableEntry[];
  stats?: Record<string, unknown>;
  /** generatedAt of the report JSON this bundle was extracted from. */
  source_generated_at?: string;
};

/**
 * Load aligned-tables.json produced by extract_aligned_tables.py.
 * Returns an empty bundle if the file is missing or malformed — the caller
 * can then fall back to the legacy markdown path without crashing.
 */
/**
 * Legacy loader — kept ONLY as a fallback for environments where in-process
 * extraction somehow yields nothing. The primary path is extractTypedTables()
 * (typedTables.ts), which needs no external file and can't go stale.
 */
function loadTypedTables(distDir: string): TypedTablesBundle {
  try {
    const path = `${distDir}/aligned-tables.json`;
    if (!existsSync(path)) return { tables: [] };
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw);
    return {
      tables: Array.isArray(data.tables) ? data.tables : [],
      stats: data.stats,
      source_generated_at: typeof data.source_generated_at === "string" ? data.source_generated_at : undefined,
    };
  } catch {
    return { tables: [] };
  }
}

/**
 * Build per-chapter Map<"tN", preRenderedHtml>. N is the ordinal of the
 * markdown table within the chapter. mdToHtml looks up "t0" for the first
 * table, "t1" for the second, etc.
 *
 * For triptych entries we route through renderTriptych (the same renderer
 * used by the markdown path) so the visual output is identical to before
 * but the cell values come from the already-normalized typed payload.
 */
function buildTableOverrideMap(
  chapterTables: TypedTableEntry[],
): Map<string, string> {
  const map = new Map<string, string>();
  chapterTables.forEach((entry, idx) => {
    try {
      const parsed: ParsedTable = {
        rows: [entry.header, ...entry.rows],
        isComparison: entry.kind === "triptych",
        versionIdx: entry.kind === "triptych" ? findVersionIdx(entry.header) : -1,
        comparisonCols: [],
        // Horizontal tables (A/B/C as header columns) need this to reach
        // renderHorizontalTriptych — without it they silently fall through to
        // the vertical path, which finds no version column and renders the
        // comparison as an unstyled grid.
        ...(entry.horizontalCols ? { horizontalCols: entry.horizontalCols } : {}),
      };
      const html =
        entry.kind === "triptych"
          ? renderTriptych(parsed)
          : renderPlainTable(parsed.rows);
      map.set(`t${idx}`, html);
    } catch {
      // Skip entry on parse error; markdown fallback will render this slot.
    }
  });
  return map;
}

function mdToHtml(md: string, tableOverrides?: Map<string, string>): string {
  if (!md) return "";
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let tableCounter = 0; // local counter; used as override key suffix
  const closeLists = () => {
    if (listType === "ul") out.push("</ul>");
    if (listType === "ol") out.push("</ol>");
    listType = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Impact matrix: blockquote lines or bare emoji lines.
    if (line.startsWith(">") || IMPACT_LINE.test(line)) {
      closeLists();
      const ex = tryExtractImpactMatrix(lines, i);
      if (ex) {
        out.push(ex.html);
        i += ex.consumed;
        continue;
      }
      if (line.startsWith(">")) {
        out.push(`<blockquote>${cellHtml(line.replace(/^>\s?/, ""))}</blockquote>`);
        i++;
        continue;
      }
      // bare emoji line that is not an impact matrix → fall through to paragraph
    }

    // Table
    if (line.startsWith("|")) {
      closeLists();
      const overrideKey = tableOverrides ? `t${tableCounter}` : undefined;
      tableCounter++;
      if (overrideKey && tableOverrides?.has(overrideKey)) {
        // Use pre-rendered typed HTML from aligned-tables.json
        out.push(tableOverrides.get(overrideKey)!);
        // skip the markdown table block (consume until next non-pipe line)
        while (i < lines.length && /\|/.test(lines[i])) i++;
        continue;
      }
      const { rowLines, next } = collectTableRows(lines, i);
      i = next;
      const parsed = parseTable(rowLines);
      if (parsed) {
        if (parsed.isComparison) out.push(renderTriptych(parsed));
        else out.push(renderPlainTable(parsed.rows));
      } else if (rowLines.length) {
        out.push(`<pre>${esc(rowLines.join("\n"))}</pre>`);
      }
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = Math.min(h[1].length + 2, 6); // # → h3 (chapter title is h1)
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|_{3,})$/.test(line)) {
      closeLists();
      out.push("<hr>");
      i++;
      continue;
    }
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
    if (line === "") {
      closeLists();
      i++;
      continue;
    }

    // Paragraph (consume until blank / structural line)
    closeLists();
    const buf: string[] = [line];
    i++;
    while (i < lines.length) {
      const t = lines[i].trim();
      if (
        t === "" ||
        /^#{1,6}\s/.test(t) ||
        /^[-*+]\s/.test(t) ||
        /^\d+[.)]\s/.test(t) ||
        t.startsWith(">") ||
        t.startsWith("|") ||
        IMPACT_LINE.test(t)
      )
        break;
      buf.push(t);
      i++;
    }
    const joined = buf.join(" ");
    if (/变化判定/.test(joined)) {
      out.push(renderVerdict(joined));
      continue;
    }
    out.push(`<p>${cellHtml(joined)}</p>`);
  }
  closeLists();
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 10. Cover / TOC / chapter utilities
// ---------------------------------------------------------------------------

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
  return lines.slice(1).join("\n").replace(/^\n+/, "");
}

function chapterCover(numLabel: string, title: string): string {
  return `
<section class="chapter-cover">
  <div class="chapter-num">${numLabel}</div>
  <h1 class="chapter-cover-title">${esc(title)}</h1>
</section>`;
}

const chAnchor = (id: number) => `CHPAGEANCHOR${String(id).padStart(3, "0")}`;
const apAnchor = (id: string) => `CHPAGEANCHORAP${id}`;

// ---------------------------------------------------------------------------
// 11. CSS
// ---------------------------------------------------------------------------

function buildCss(fonts: FontAsset[]): string {
  const ff = fonts.length
    ? fonts.map((f) => `"${f.family}"`).join(", ") + ', "Microsoft YaHei", "PingFang SC", "Source Han Sans SC", "Noto Sans SC", sans-serif'
    : '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
  const serif = fonts.find((f) => f.family === "NotoSerifSC")
    ? '"NotoSerifSC", "Source Han Serif SC", "Noto Serif SC", "SimSun", serif'
    : '"SimSun", "Noto Serif SC", "Source Han Serif SC", serif';
  const mono = '"Consolas", "JetBrains Mono", "Source Code Pro", "Courier New", monospace';
  return `
${fontFaceBlock(fonts)}

@page { size: A4; margin: 18mm 14mm 18mm 14mm; }
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

/* invisible anchor for two-pass TOC page numbering */
.ch-anchor { font-size: 2pt; color: #ffffff; }

/* ====== Cover ====== */
.cover {
  page-break-after: always;
  padding: 36mm 22mm 22mm;
  background:
    radial-gradient(circle at 20% 0%, rgba(161,115,52,0.08), transparent 40%),
    radial-gradient(circle at 80% 100%, rgba(58,107,79,0.06), transparent 40%),
    #faf6ec;
  min-height: 100vh;
  position: relative;
}
.cover::before {
  content: ""; position: absolute; top: 14mm; left: 16mm; right: 16mm;
  height: 0.5pt; background: #0c1a2b;
}
.cover::after {
  content: ""; position: absolute; bottom: 14mm; left: 16mm; right: 16mm;
  height: 0.5pt; background: #0c1a2b;
}
.cover-eyebrow {
  font-size: 9pt; letter-spacing: 6px; color: #a17334;
  text-transform: uppercase; margin-bottom: 6mm; font-weight: 600;
}
.cover h1 {
  font-family: ${serif};
  font-size: 30pt; margin: 0 0 4mm; color: #0c1a2b;
  letter-spacing: 1px; line-height: 1.25; font-weight: 700;
}
.cover .sub { font-size: 12pt; color: #5e5240; margin-bottom: 14mm; line-height: 1.6; }
.cover-strip {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 6mm; margin-bottom: 16mm;
}
.cover-card {
  border: 0.6pt solid #d8cfb8; background: #fff;
  padding: 8mm 6mm; position: relative; border-radius: 2mm;
}
.cover-card::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2mm; background: var(--accent, #0c1a2b);
  border-radius: 2mm 0 0 2mm;
}
.cover-card[data-doc="A"] { --accent: #a17334; }
.cover-card[data-doc="B"] { --accent: #0c1a2b; }
.cover-card[data-doc="C"] { --accent: #3a6b4f; }
.cover-card .doc-label { font-size: 22pt; font-weight: 700; color: var(--accent); margin-bottom: 1mm; }
.cover-card .doc-name { font-size: 10pt; color: #3a3027; line-height: 1.4; min-height: 8mm; }
.cover-card .doc-meta { font-size: 8pt; color: #9c8b6c; margin-top: 1.5mm; }
.cover-meta { font-size: 9pt; color: #5e5240; line-height: 1.9; border-top: 0.5pt solid #ece4d1; padding-top: 4mm; }
.cover-disclaimer {
  position: absolute; bottom: 22mm; left: 22mm; right: 22mm;
  font-size: 8pt; color: #9c8b6c; line-height: 1.5;
  border-top: 0.3pt solid #ece4d1; padding-top: 3mm;
}

/* ====== Front blocks: mapping index / master params ====== */
.front-block { page-break-after: always; padding-top: 2mm; }
.mp-head { margin-bottom: 5mm; border-bottom: 1pt solid #0c1a2b; padding-bottom: 3mm; }
.mp-eyebrow { font-size: 8pt; letter-spacing: 4px; color: #a17334; text-transform: uppercase; font-weight: 600; }
.mp-head h2 {
  font-family: ${serif};
  font-size: 19pt; color: #0c1a2b;
  margin: 2mm 0 1mm; letter-spacing: 1px;
}
.mp-sub { font-size: 9.5pt; color: #5e5240; margin: 0; line-height: 1.55; }
.mp-table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.mp-table th {
  text-align: left; padding: 2mm 2.2mm;
  border-bottom: 1pt solid #0c1a2b;
  color: var(--c, #0c1a2b);
  font-weight: 700; font-size: 8.8pt;
}
.mp-table td { padding: 1.8mm 2.2mm; border-bottom: 0.4pt solid #ece4d1; vertical-align: top; line-height: 1.45; }
.mp-table tbody tr:nth-child(even) td { background: #fbf9f3; }
.mp-table .mp-name { font-weight: 600; color: #0c1a2b; }
.mp-table .mp-note { font-size: 8pt; color: #5e5240; }
.mp-table .mp-src { font-size: 7.8pt; color: #9c8b6c; font-style: italic; white-space: nowrap; }

/* ====== TOC ====== */
.front-section { page-break-after: always; padding-top: 6mm; }
.front-section h1 {
  font-family: ${serif}; font-size: 22pt; color: #0c1a2b;
  margin: 0 0 6mm; letter-spacing: 1px;
  border-bottom: 1pt solid #0c1a2b; padding-bottom: 3mm;
}
.toc-row {
  display: flex; align-items: baseline; gap: 3mm;
  padding: 2.6mm 0; font-size: 11pt; break-inside: avoid;
  border-bottom: 0.3pt dotted #ece4d1;
}
.toc-num { width: 11mm; font-weight: 700; color: #a17334; font-family: ${serif}; flex-shrink: 0; }
.toc-title { color: #1c2733; flex: 1; }
.toc-dots { flex: 0 0 30mm; border-bottom: 1px dotted #b9a27a; transform: translateY(-1.2mm); }
.toc-page { min-width: 10mm; text-align: right; font-weight: 700; color: #0c1a2b; }
.toc-row.ap .toc-num { color: #3a6b4f; }

/* ====== Chapter ====== */
.chapter { page-break-before: always; }
.chapter-cover {
  min-height: 46mm;
  display: flex; align-items: center; gap: 8mm;
  border-bottom: 1pt solid #0c1a2b; padding-bottom: 5mm;
  margin-bottom: 6mm;
}
.chapter-num { font-family: ${serif}; font-size: 42pt; color: #a17334; font-weight: 700; line-height: 1; min-width: 22mm; }
.chapter-cover-title { font-family: ${serif}; font-size: 20pt; color: #0c1a2b; margin: 0; line-height: 1.3; }

/* ====== Body ====== */
h3 { font-size: 13pt; color: #0c1a2b; border-left: 3pt solid #a17334; padding-left: 3.5mm;
  margin: 6mm 0 3mm; page-break-after: avoid; }
h4 { font-size: 11.5pt; color: #0c1a2b; margin: 4mm 0 2mm; page-break-after: avoid; }
h5 { font-size: 10.5pt; color: #3a3027; margin: 3mm 0 1.5mm; page-break-after: avoid; }
h6 { font-size: 10pt; color: #5e5240; margin: 3mm 0 1.5mm; page-break-after: avoid; }
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

/* ====== Triptych ====== */
.triptych {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 3mm; margin: 4mm 0; page-break-inside: avoid;
}
.trip-card {
  border: 0.5pt solid #d8cfb8; border-radius: 2mm;
  background: #fff; overflow: hidden;
  display: flex; flex-direction: column;
}
.trip-head {
  display: flex; align-items: baseline; gap: 2mm;
  padding: 3mm 3.5mm; background: var(--accent-bg);
  border-bottom: 0.5pt solid var(--accent); position: relative;
}
.trip-head::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: 2mm; background: var(--accent);
}
.trip-label { font-family: ${serif}; font-size: 17pt; font-weight: 700; color: var(--accent); line-height: 1; }
.trip-tag { font-size: 8pt; padding: 0.4mm 1.6mm; background: var(--accent); color: #fff;
  border-radius: 1mm; font-weight: 600; letter-spacing: 0.5px; }
.trip-doc { font-size: 8.2pt; color: #5e5240; margin-left: auto; text-align: right; line-height: 1.2; }
.trip-meta { display: grid; grid-template-columns: 11mm 1fr; gap: 1mm 2mm; margin: 2.5mm 3.5mm; font-size: 8.8pt; }
.trip-meta dt { color: #9c8b6c; font-weight: 600; }
.trip-meta dd { margin: 0; color: #1c2733; font-weight: 500; }

/* Symbol legend page */
.symbol-legend { padding: 4mm 0 8mm; page-break-after: always; }
.legend-title { font-family: ${serif}; font-size: 22pt; font-weight: 700; color: #0c1a2b; margin: 0 0 2mm; border-bottom: 1pt solid #a17334; padding-bottom: 2mm; }
.legend-intro { font-size: 9pt; color: #5e5240; margin: 0 0 5mm; line-height: 1.5; }
.legend-h2 { font-family: ${serif}; font-size: 11pt; font-weight: 700; color: #a17334; margin: 4mm 0 2mm; letter-spacing: 0.4px; }
.legend-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 2.5mm; margin: 0 0 4mm; }
.legend-card { border: 0.6pt solid #d8cfb8; border-radius: 2mm; padding: 3mm 3mm 3.5mm; background: #fbf9f3; page-break-inside: avoid; }
.legend-card-h { display: flex; align-items: baseline; gap: 2mm; margin-bottom: 1.5mm; }
.legend-sym { font-size: 14pt; line-height: 1; }
.legend-tag { font-family: ${serif}; font-size: 10pt; font-weight: 700; color: #1c2733; }
.legend-desc { font-size: 8.5pt; color: #1c2733; margin: 0 0 1.5mm; line-height: 1.45; }
.legend-sample { font-size: 8pt; color: #5e5240; margin: 0; padding-left: 7mm; text-indent: -7mm; line-height: 1.4; }
.legend-warn { font-size: 9pt; color: #c9542a; background: #fbf6f0; border-left: 3pt solid #c9542a; padding: 2mm 3mm; margin: 4mm 0 0; line-height: 1.5; }
.legend-ok     { background: #f1f5ec; border-color: #b7c8a8; }
.legend-warn   { background: #fbf6f0; border-color: #e0c8a8; }
.legend-design { background: #f6f2e7; border-color: #d6cba8; }
.legend-test   { background: #f0eee9; border-color: #c8c0aa; }
.legend-cert   { background: #f0f1ee; border-color: #b5c0b0; }
.legend-muted  { background: #fbf9f3; border-color: #d8cfb8; }

/* Extraction-failure placeholders must never be mistaken for real content. */
.cell-placeholder {
  background: #fbf6f0 !important;
  color: #a17334 !important;
  font-style: italic;
  position: relative;
  padding-left: 5mm !important;
}
.cell-placeholder::before {
  content: "⚠";
  position: absolute; left: 1.8mm; top: 50%; transform: translateY(-50%);
  font-style: normal; font-size: 8pt;
}

/* Closure dashboard */
.closure-dashboard { padding: 4mm 0 6mm; page-break-after: always; }
.dashboard-title { font-family: ${serif}; font-size: 22pt; font-weight: 700; color: #0c1a2b; margin: 0 0 3mm; border-bottom: 1pt solid #a17334; padding-bottom: 2mm; }
.dashboard-intro { font-size: 9.5pt; color: #1c2733; margin: 0 0 4mm; line-height: 1.55; }
.dashboard-intro strong { color: #c9542a; font-weight: 700; }
.claim-figure { margin: 0 0 5mm; }
.claim-figure .dashboard-bar { width: 100%; height: 18px; display: block; border-radius: 2mm; overflow: hidden; }
.claim-caption { display: flex; gap: 8mm; margin-top: 1.5mm; font-size: 9pt; color: #4a4a4a; flex-wrap: wrap; }
.claim-caption span { display: inline-flex; align-items: center; gap: 2mm; font-family: ${mono}; }
.closure-table { width: 100%; border-collapse: collapse; font-size: 9pt; }
.closure-table th { background: #fdf3df; color: #a17334; padding: 2mm 3mm; text-align: left; font-weight: 600; border-bottom: 0.8pt solid #a17334; }
.closure-table td { padding: 1.8mm 3mm; border-bottom: 0.4pt solid #ece4d1; vertical-align: middle; }
.closure-table .td-icon { font-family: ${mono}; font-size: 11pt; width: 8mm; text-align: center; }
.closure-table .td-label { font-weight: 600; color: #1c2733; width: 28mm; }
.closure-table .td-count { font-family: ${mono}; font-size: 11pt; font-weight: 700; color: #0c1a2b; width: 14mm; text-align: right; }
.closure-table .td-pct { font-family: ${mono}; font-size: 9pt; color: #5e5240; width: 14mm; text-align: right; }
.closure-table .td-note { font-size: 8.5pt; color: #5e5240; line-height: 1.4; }
.closure-table .row-confirmed .td-count { color: #3a6b4f; }
.closure-table .row-candidate .td-count { color: #b94e2c; }
.closure-table .row-errata .td-count,
.closure-table .row-renum .td-count,
.closure-table .row-format .td-count { color: #9c8b6c; }
.closure-table .row-total td { background: #f7f1e3; border-top: 0.6pt solid #a17334; }
.dashboard-disclaimer { font-size: 8.5pt; color: #5e5240; margin: 4mm 0 0; padding: 2mm 3mm; border-left: 2pt solid #b94e2c; background: #fbf6f0; line-height: 1.5; }
.dashboard-disclaimer.dashboard-risk { color: #c9542a; border-left-width: 3pt; background: #fbede2; }
.dashboard-method {
  font-size: 8pt; color: #8a7a5c; margin: 4mm 0 0; padding: 2mm 3mm;
  background: #f7f4ec; border-left: 2pt solid #c9bfa8; line-height: 1.5;
}
.dashboard-method b { color: #5e5240; }
.reconcile-box {
  margin-top: 4mm; padding: 3mm 4mm; border: 0.8pt solid #c9542a;
  border-radius: 2mm; background: #fdf3f0;
}
.reconcile-title {
  font-size: 9.5pt; font-weight: 700; color: #c9542a; margin: 0 0 2mm;
}
.reconcile-list { margin: 0 0 2mm; padding-left: 5mm; }
.reconcile-list li { font-size: 8.5pt; color: #5e5240; line-height: 1.5; margin-bottom: 1mm; }
.reconcile-hint { font-size: 8pt; color: #8a7a5c; margin: 0; line-height: 1.5; }

/* Candidate worklist */
.candidate-worklist { padding: 4mm 0 6mm; page-break-after: always; }
.cw-title { font-family: ${serif}; font-size: 22pt; font-weight: 700; color: #0c1a2b; margin: 0 0 3mm; border-bottom: 1pt solid #a17334; padding-bottom: 2mm; }
.cw-intro { font-size: 9pt; color: #1c2733; margin: 0 0 3mm; line-height: 1.55; }
.cw-intro b { color: #c9542a; }
.cw-intro code { font-family: ${mono}; font-size: 8.5pt; background: #f0eada; padding: 0.3mm 1.2mm; border-radius: 1mm; }
.cw-reasons { margin: 0 0 4mm; padding: 2.5mm 4mm; background: #fdf3df; border-left: 2.5pt solid #a17334; border-radius: 1.5mm; }
.cw-reasons-title { font-size: 9pt; font-weight: 700; color: #a17334; margin: 0 0 1.5mm; }
.cw-reasons ul { margin: 0; padding-left: 5mm; columns: 2; column-gap: 6mm; }
.cw-reasons li { font-size: 8.5pt; color: #5e5240; line-height: 1.5; break-inside: avoid; }
.cw-reasons li b { color: #1c2733; }
.cw-table { width: 100%; border-collapse: collapse; font-size: 8.2pt; }
.cw-table th { background: #eef1f5; color: #0c1a2b; padding: 1.8mm 2.2mm; text-align: left; font-weight: 600; border-bottom: 0.6pt solid #0c1a2b; }
.cw-table td { padding: 1.5mm 2.2mm; border-bottom: 0.3pt solid #ece4d1; vertical-align: top; }
.cw-table tr:nth-child(even) td { background: #fbf9f3; }
.cw-table .cw-idx { font-family: ${mono}; font-size: 8pt; color: #9c8b6c; width: 7mm; text-align: right; }
.cw-table .cw-topic { font-weight: 600; color: #1c2733; width: 62mm; }
.cw-table .cw-sec { font-family: ${mono}; font-size: 7.5pt; color: #a17334; width: 14mm; }
.cw-table .cw-reason { color: #8a6a4a; width: 46mm; line-height: 1.4; }
.cw-table .cw-pages { font-family: ${mono}; font-size: 8pt; color: #3a6b4f; width: 22mm; }
.cw-warn {
  font-size: 8.5pt; color: #c9542a; margin: 4mm 0 0; padding: 2mm 3mm;
  border-left: 3pt solid #c9542a; background: #fbede2; line-height: 1.5;
}

/* Transition period table */
.transition-table { padding: 4mm 0 6mm; page-break-after: always; }
.transition-title { font-family: ${serif}; font-size: 22pt; font-weight: 700; color: #0c1a2b; margin: 0 0 3mm; border-bottom: 1pt solid #a17334; padding-bottom: 2mm; }
.transition-intro { font-size: 9.5pt; color: #1c2733; margin: 0 0 4mm; line-height: 1.55; }
.transition-intro .ms { color: #c9542a; font-weight: 700; }
.transition-grid { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.transition-grid th { background: #eef1f5; color: #0c1a2b; padding: 1.8mm 2.5mm; text-align: left; border-bottom: 0.6pt solid #0c1a2b; }
.transition-grid th.bg-mono { font-family: ${mono}; font-size: 8pt; }
.transition-grid td { padding: 1.6mm 2.5mm; border-bottom: 0.3pt solid #ece4d1; vertical-align: top; }
.transition-grid .scope-row td { background: #fbf3df; padding: 1.2mm 2.5mm; font-family: ${serif}; font-weight: 700; color: #a17334; font-size: 9pt; letter-spacing: 0.4px; border-bottom: 0.3pt solid #e5d6a8; }
.transition-grid .td-tag { font-family: ${mono}; font-weight: 600; color: #a17334; width: 22mm; }
.transition-grid .td-trigger { font-family: ${mono}; color: #0c1a2b; width: 32mm; }
.transition-grid .td-excerpt { font-size: 8pt; color: #5e5240; line-height: 1.45; }
.transition-grid .ms { color: #c9542a; font-weight: 700; background: #fbede2; padding: 0 1mm; border-radius: 1mm; }
.transition-warn { font-size: 8.5pt; color: #9c8b6c; margin: 3mm 0 0; padding: 2mm 2.5mm; border-left: 3pt solid #b9a173; background: #fbf6f0; line-height: 1.5; }
.trip-text { padding: 0 3.5mm 4mm; font-size: 8.8pt; line-height: 1.5; color: #1c2733; flex: 1; }

/* Horizontal-table triptych: many topic/value pairs stacked in one card */
.hz-rows { padding: 0 3.5mm 3.5mm; flex: 1; font-size: 8.2pt; line-height: 1.45; }
.hz-row { padding: 1.4mm 0; border-bottom: 0.3pt solid #ece4d1; }
.hz-row:last-child { border-bottom: none; }
.hz-topic { font-weight: 600; color: #5e5240; font-size: 8pt; margin-bottom: 0.6mm; }
.hz-text { color: #1c2733; }

.trip-card-missing { background: #faf6ec; border-style: dashed; border-color: #d8cfb8; }
.trip-card-missing .trip-head { background: #f0eada; border-bottom-color: #b9a27a; }
.trip-card-missing .trip-label { color: #9c8b6c; }
.trip-card-missing .trip-tag { background: #b9a27a; }
.trip-card-missing .trip-doc { color: #9c8b6c; }
.trip-missing { flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; padding: 7mm 4mm; text-align: center; color: #9c8b6c; }
.missing-mark { font-family: ${serif}; font-size: 26pt; color: #c8b893; line-height: 1; margin-bottom: 2mm; }
.missing-text { font-size: 10.5pt; color: #7c6a4f; font-weight: 600; margin-bottom: 1.5mm; }
.missing-hint { font-size: 7.2pt; color: #9c8b6c; line-height: 1.4; font-style: italic; }

.page-ok { color: #1f7a44; font-weight: 600; }
.page-warn { color: #a17334; font-weight: 600; }
.page-none { color: #9c8b6c; }

/* ====== Impact Matrix ====== */
.impact-matrix {
  display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 2.5mm; margin: 3mm 0 5mm; page-break-inside: avoid;
}
.impact-cell {
  border: 0.5pt solid #d8cfb8; border-left: 2mm solid var(--accent);
  background: #fff; border-radius: 2mm; padding: 2.5mm 3mm;
  display: flex; flex-direction: column;
}
.impact-head { display: flex; align-items: center; gap: 2mm; margin-bottom: 1.5mm; }
.impact-icon { font-size: 11pt; width: 5mm; }
.impact-label { font-size: 8.8pt; color: var(--accent); font-weight: 700; letter-spacing: 0.5px; }
.impact-body { font-size: 8.6pt; line-height: 1.5; color: #1c2733; }
.impact-empty { color: #b9a27a; font-style: italic; font-size: 8pt; }

/* ====== 变化判定 verdict strip ====== */
.verdict-strip {
  display: flex; align-items: baseline; gap: 3mm;
  margin: 3mm 0 4mm; padding: 2.5mm 3mm;
  border-left: 2.5mm solid var(--v-color, #9c8b6c);
  background: var(--v-bg, #f7f8fa);
  border-radius: 1.5mm;
  font-size: 9.2pt;
  page-break-inside: avoid;
}
.verdict-strip .v-chip { font-weight: 700; color: var(--v-color); white-space: nowrap; }
.verdict-strip .v-rest { color: #3a3027; flex: 1; }
.v-red { --v-color: #a23030; --v-bg: #fdf0f0; }
.v-amber { --v-color: #a17334; --v-bg: #fdf7ec; }
.v-green { --v-color: #1f7a44; --v-bg: #f0faf4; }
.v-gray { --v-color: #5e748c; --v-bg: #f4f6f9; }

/* ====== Plain tables ====== */
table { width: 100%; border-collapse: collapse; font-size: 8.6pt;
  margin: 3mm 0 4mm; page-break-inside: auto; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 0.5pt solid #d8cfb8; padding: 1.8mm 2.2mm;
  vertical-align: top; text-align: left; line-height: 1.45; }
th { background: #f5efe0; color: #0c1a2b; font-weight: 700; }
tbody tr:nth-child(even) td { background: #fbf9f3; }

/* ====== Markers & tags ====== */
.mk { display: inline-block; padding: 0 1.6mm; border-radius: 2px;
  font-size: 8.5pt; font-weight: 700; white-space: nowrap; }
.mk-add { background: #e3f2e8; color: #1f7a44; border: 0.4pt solid #9fd6b4; }
.mk-del { background: #fbe4e4; color: #a23030; border: 0.4pt solid #e7a9a9; text-decoration: line-through; }
.mk-mod { background: #fdeed9; color: #a17334; border: 0.4pt solid #ecc78a; }
.mk-keep { background: #eef1f5; color: #5e748c; border: 0.4pt solid #c9d3e0; }
.tag { display: inline-block; padding: 0 1.6mm; border-radius: 2px; font-size: 8pt; font-weight: 700; }
.tag-fact { background: #fde0e0; color: #a23030; }
.tag-infer { background: #fdf3df; color: #a17334; }
.tag-todo { background: #ece4d1; color: #3a3027; }
.quote { color: #5e5240; }

/* ====== Math ====== */
.math-block { margin: 3mm auto; text-align: center; font-size: 11pt; font-style: italic; }
.math { font-style: italic; font-family: "Cambria Math", "STIX Two Math", "Latin Modern Math", serif; padding: 0 0.5mm; }

/* ====== Thin chapter fallback ====== */
.thin-chapter {
  color: #9c8b6c; font-size: 9.5pt; font-style: italic;
  background: #faf6ec; border: 0.5pt dashed #d8cfb8;
  border-radius: 3mm; padding: 3mm 4mm;
}
`;
}

// ---------------------------------------------------------------------------
// 12. Build full HTML document
// ---------------------------------------------------------------------------

export async function buildHtml(
  report: RenderableReport,
  fonts: FontAsset[],
  opts: { withAnchors?: boolean; distDir?: string } = {},
): Promise<string> {
  // Defensive: clients occasionally POST partial RenderableReport JSON
  // (missing chapters/appendices/outline). Default to empty collections so
  // the renderer never crashes with "Cannot read properties of undefined
  // (reading 'map')".
  const outline = report?.outline ?? { title: "", chapters: [], appendices: [] };
  const chapters = Array.isArray(report?.chapters) ? report.chapters : [];
  const appendices = Array.isArray(report?.appendices) ? report.appendices : [];
  const sourceDocuments = Array.isArray(report?.sourceDocuments) ? report.sourceDocuments : [];
  const generatedAt = report?.generatedAt;
  const stamp = generatedAt ?? new Date().toLocaleString("zh-CN");

  // ── Typed-table bundle ──────────────────────────────────────────────
  // PRIMARY PATH: extract in-process from this very report. No external file,
  // no staleness hazard, no Python dependency. This is what makes the render
  // pipeline self-contained (measured impact: markdown-only loses 19 triptych
  // cards / 16 pages, because multi-line rows break plain-table detection).
  //
  // FALLBACK: dist/aligned-tables.json, only when in-process extraction comes
  // back empty (e.g. an unusual report shape). Guarded by source_generated_at.
  let typedTables: TypedTableEntry[] = [];
  let usedFallback = false;
  try {
    const inProc = extractTypedTables(
      chapters.map((c) => ({ markdown: c.markdown ?? "" })),
      (ci) => chapters[ci]?.title ?? "",
    );
    typedTables = inProc.tables as TypedTableEntry[];
  } catch (e) {
    console.warn("[htmlRenderV8] in-process typed-table extraction failed:", e);
  }

  if (typedTables.length === 0) {
    const distDir = opts.distDir ?? path.resolve(process.cwd(), "dist");
    const legacy = loadTypedTables(distDir);
    const fresh =
      !!legacy.source_generated_at &&
      !!report?.generatedAt &&
      legacy.source_generated_at === report.generatedAt;
    if (fresh) {
      typedTables = legacy.tables as TypedTableEntry[];
      usedFallback = true;
    } else {
      console.warn(
        `[htmlRenderV8] typed-table fallback bundle is STALE (bundle=${legacy.source_generated_at}, report=${report?.generatedAt}) — using markdown render path`,
      );
    }
  }
  if (typedTables.length) {
    console.log(
      `[htmlRenderV8] typed tables: ${typedTables.length}${usedFallback ? " (from fallback bundle)" : " (in-process)"}`,
    );
  }

  const chapterOverrides = new Map<number, Map<string, string>>();
  {
    const byChapter = new Map<number, TypedTableEntry[]>();
    for (const t of typedTables) {
      const m = t.id.match(/^ch(\d+)\.t(\d+)$/);
      if (!m) continue;
      const ci = Number(m[1]);
      const list = byChapter.get(ci) ?? [];
      list.push(t);
      byChapter.set(ci, list);
    }
    for (const [ci, list] of byChapter) {
      list.sort((a, b) => {
        const na = Number(a.id.match(/\.t(\d+)$/)?.[1] ?? 0);
        const nb = Number(b.id.match(/\.t(\d+)$/)?.[1] ?? 0);
        return na - nb;
      });
      chapterOverrides.set(ci, buildTableOverrideMap(list));
    }
  }

  const sourceCards = (sourceDocuments.length
    ? sourceDocuments
    : [
        { label: "A", name: "GB 4785 草案", meta: "" },
        { label: "B", name: "GB 4785-2019", meta: "" },
        { label: "C", name: "UN R48", meta: "" },
      ]
  )
    .map(
      (d) => `<div class="cover-card" data-doc="${esc(d.label)}">
        <div class="doc-label">${esc(d.label)}</div>
        <div class="doc-name">${esc(cleanDocName(d.name))}</div>
        <div class="doc-meta">${esc(d.meta ?? "")}</div>
      </div>`,
    )
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

  // Front blocks (skip when empty to avoid blank pages)
  const mappingHtml = renderMappingIndex(extractClauseMapping(chapters));
  const masterParamsHtml = renderMasterParams(extractMasterParams(chapters));

  const chapterSections = chapters
    .map((c, ci) => {
      const body = stripDuplicateChapterTitle(c.markdown, c.id, c.title);
      const bodyHtml = mdToHtml(body, chapterOverrides.get(ci));
      const textLen = body.replace(/[#*>|`\-\[\]()]/g, "").trim().length;
      const fallback =
        textLen < 120
          ? `<p class="thin-chapter">（本章正文生成内容不足——已生成其余章节的详细对比；该章要点请参见"变化点总结"与相邻章节，或稍后重新生成报告。）</p>`
          : "";
      return `<section class="chapter" id="ch-${c.id}">
        ${opts.withAnchors === false ? "" : `<span class="ch-anchor">${chAnchor(c.id)}</span>`}
        ${chapterCover(String(c.id).padStart(2, "0"), c.title)}
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
        ${opts.withAnchors === false ? "" : `<span class="ch-anchor">${apAnchor(a.id)}</span>`}
        ${chapterCover(`附${esc(a.id)}`, a.title)}
        <div class="chapter-body">${body}${fallback}</div>
      </section>`;
    })
    .join("\n");

  const symbolLegendHtml = renderSymbolLegend();
  const ledger = buildLedger(chapters.map((c) => ({ markdown: c.markdown ?? "" })));
  const closureDashboardHtml = renderClosureDashboard(
    ledgerToCounts(ledger) as ReturnType<typeof extractClosureCounts>,
    ledger.discrepancies,
  );
  const transitionHtml = renderTransitionTable(extractTransitionDates(chapters));
  const worklistHtml = renderCandidateWorklist(ledger);
  const frontBlocks = [symbolLegendHtml, closureDashboardHtml, worklistHtml, transitionHtml, mappingHtml, masterParamsHtml].filter(Boolean).join("\n");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(outline.title)}</title>
<style>${buildCss(fonts)}</style>
</head>
<body>

<div class="cover">
  <div class="cover-eyebrow">Regulatory Comparative Report · V8</div>
  <h1>${esc(outline.title)}</h1>
  <div class="sub">现行版 · 草案版 · 欧版 — 三维度对照分析（条款级 · 参数级 · 影响级 · 映射级）</div>
  <div class="cover-strip">${sourceCards}</div>
  <div class="cover-meta">
    报告编号：GB4785-CMP-2026-09-001<br>
    编制日期：${esc(stamp)}<br>
    文档版本：V8 · CJK 字体嵌入 · 公式排版 · 三版同框 · 4 维影响卡 · 映射索引 · 参数总表
  </div>
  <div class="cover-disclaimer">
    本报告基于公开法规资料及专业知识编制，仅供技术研究使用。涉及具体产品的合规判定，请以官方发布的法规原文为准。
  </div>
</div>

${frontBlocks}

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
// 13. Two-pass PDF rendering (mupdf anchor search → TOC page numbers)
// ---------------------------------------------------------------------------

async function findAnchorPages(pdf: Buffer, anchors: string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  try {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(pdf, "application/pdf");
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      for (const a of anchors) {
        if (found.has(a)) continue;
        try {
          const quads = page.search(a, {});
          if (quads && quads.length) found.set(a, i + 1);
        } catch {
          /* search unsupported on this page — skip */
        }
      }
      if (found.size === anchors.length) break;
    }
    try { doc.destroy(); } catch { /* already freed */ }
  } catch (e) {
    console.warn("[htmlRenderV8] anchor page search failed:", (e as Error).message);
  }
  return found;
}

export async function renderPdfFromReportV8(report: RenderableReport): Promise<Buffer> {
  const fonts = await loadFonts();
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const render = async (html: string): Promise<Buffer> => {
      await page.setContent(html, { waitUntil: "load", timeout: 120_000 });
      await page.evaluate(() => (document as any).fonts?.ready);
      await page.waitForTimeout(250);
      const pdf = await page.pdf({
        title: report.outline.title,
        creator: "GB 4785 多版本对比报告 pipeline v8",
        subject: "A 草案 / B 现行 / C UN R48-09 三版本法规横向对照（三版同框 · 4 维影响卡 · 参数总表 · 条款映射）",
        keywords: "GB 4785, UN R48, AFS, 三版对比, 影响卡, 参数总表, 条款映射, CJK",
        format: "A4",
        printBackground: true,
        margin: { top: "18mm", bottom: "18mm", left: "14mm", right: "14mm" },
        displayHeaderFooter: true,
        headerTemplate:
          `<div style="width:100%;text-align:center;font-size:8px;color:#9c8b6c;">` + esc(report.outline.title) + `</div>`,
        footerTemplate:
          `<div style="width:100%;display:flex;justify-content:space-between;font-size:8px;color:#9c8b6c;padding:0 14mm;">` +
          `<span>汽车外部照明与光信号装置安装规定对比分析 · V8</span>` +
          `<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>` +
          `</div>`,
      });
      return Buffer.from(pdf);
    };

    // Pass 1 — render with invisible anchors to discover chapter page numbers.
    // Normalize the arrays here exactly like buildHtml does — this function
    // is the entry point for POST /report/render and receives whatever the
    // client POSTed, which may be missing chapters/appendices entirely.
    const safeChapters = Array.isArray(report?.chapters) ? report.chapters : [];
    const safeAppendices = Array.isArray(report?.appendices) ? report.appendices : [];
    const pdf1 = await render(await buildHtml(report, fonts, { withAnchors: true }));
    const anchors = [
      ...safeChapters.map((c) => chAnchor(c.id)),
      ...safeAppendices.filter((a) => a.markdown).map((a) => apAnchor(a.id)),
    ];
    const pages = await findAnchorPages(pdf1, anchors);
    for (const c of safeChapters) {
      const p = pages.get(chAnchor(c.id));
      if (p) c.page = p;
    }
    for (const a of report.appendices ?? []) {
      if (!a.markdown) continue;
      const p = pages.get(apAnchor(a.id));
      if (p) a.page = p;
    }
    // Pass 2 — final PDF: TOC shows real page numbers AND the invisible
    // anchor strings are dropped from the text layer entirely.
    // (TOC rows are fixed-height, so pagination does not shift between passes.)
    console.log(`[htmlRenderV8] pass-2 render without anchors (${pages.size}/${anchors.length} anchors found)`);
    return await render(await buildHtml(report, fonts, { withAnchors: false }));
  } finally {
    await browser.close();
  }
}