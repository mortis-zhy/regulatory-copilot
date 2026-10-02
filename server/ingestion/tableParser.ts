/**
 * Deterministic table parser — bypasses LLM entirely for the 9 critical
 * GB4785 data indicators that live inside layout tables.
 *
 * Why this exists: structuredExtract's LLM over-extracts (22+ values per
 * topic) and uses inconsistent names between A and B, polluting the diff
 * with 300+ false positives. The 9 indicators the customer cares about
 * (DRL 400→500 cd, ESS 4→5 Hz, 侧标志灯 ≤6m→≤4m, LED 寿命 2000→3000 h,
 * 光通维持率 70→80%, 预热 30→60 min, AFS 切换 ≤2s→≤1.5s, ESS 光度,
 * DRL 可见度角度) are all in 4 specific tables. We parse those tables
 * directly from the Markdown emitted by pdfExtract.
 *
 * Pure derived data — zero LLM.
 */

/** A row × col matrix extracted from a Markdown table block. */
export type ParsedTable = {
  title: string;          // detected table title (e.g. "表11.1 装置发出的光色")
  pageHint: string;        // nearest preceding [第N页]
  header: string[];        // column headers (or [] if not detected)
  rows: string[][];        // data rows
  /** 1-based index of this table in the document (in detection order). */
  index: number;
};

/** A single canonicalised data indicator (the 9 the customer watches). */
export type CanonicalIndicator = {
  /** Stable ID (used by 11.4 for cross-reference). */
  id:
    | "drl-min-cd"
    | "ess-freq-hz"
    | "ess-cd"
    | "drl-visibility-deg"
    | "side-marker-spacing-m"
    | "led-life-h"
    | "lumen-maintenance"
    | "preheat-min"
    | "afs-switch-s";
  /** Display name shown in 11.4 / 附录. */
  label: string;
  /** Unit (cd / Hz / m / h / etc). */
  unit: string;
  /** Numeric or numeric-range value as a string (we keep ranges verbatim). */
  value: string;
  /** Page reference. */
  page: string;
  /** Anchor (clause + page). */
  anchor: string;
};

/**
 * Parse all layout tables out of a PDF's extracted text.
 * Each `[第N页] ...` block may contain one or more tables; we collect
 * them in document order.
 */
export function parseAllTables(docText: string): ParsedTable[] {
  const out: ParsedTable[] = [];
  const pages = docText.split(/\n(?=\[第\d+页\])/);

  for (const pageBlock of pages) {
    const pageMatch = pageBlock.match(/^\[第(\d+)页\]/);
    const pageHint = pageMatch ? `第${pageMatch[1]}页` : "";

    // Find each "| ... |" block. PyMuPDF-emitted Markdown tables are
    // contiguous pipe-delimited lines. We group consecutive pipe lines
    // into one ParsedTable.
    const lines = pageBlock.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!isTableLine(lines[i])) {
        i++;
        continue;
      }
      // Collect contiguous table block.
      const start = i;
      while (i < lines.length && (isTableLine(lines[i]) || lines[i].trim() === "")) {
        i++;
      }
      const block = lines
        .slice(start, i)
        .filter((l) => l.trim().length > 0)
        .map(stripMarkdown);
      if (block.length < 2) continue;
      const parsed = parseTableBlock(block, pageHint, out.length + 1);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function isTableLine(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|")) return false;
  if (!t.endsWith("|")) return false;
  // Exclude the "---|---|---" separator line which starts/ends with `|`
  // but is recognised below. We keep it here so consecutive blocks merge
  // correctly, then strip it inside parseTableBlock.
  return true;
}

function stripMarkdown(line: string): string {
  // Drop leading/trailing pipes and surrounding whitespace on each cell.
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") && !trimmed.startsWith("**")) {
    // Not a table line — return as-is.
    return trimmed;
  }
  let t = trimmed;
  if (t.startsWith("**")) t = t.slice(2);
  if (t.endsWith("**")) t = t.slice(0, -2);
  return t;
}

/**
 * Parse a contiguous pipe-delimited block into header + rows.
 * Skips separator rows (|---|).
 */
function parseTableBlock(block: string[], pageHint: string, index: number): ParsedTable | null {
  const cleaned = block
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && l.endsWith("|"))
    .map((l) => {
      // Strip outer pipes, split, trim each cell.
      const inner = l.slice(1, -1);
      return inner.split("|").map((c) => c.trim());
    });
  if (cleaned.length < 2) return null;

  // Detect separator row: e.g. ["---","---","---"].
  const isSep = (row: string[]) => row.every((c) => /^:?-+:?$/.test(c));
  const nonSep = cleaned.filter((r) => !isSep(r));
  if (nonSep.length < 2) return null;

  const header = nonSep[0];
  const rows = nonSep.slice(1);

  // Best-effort title: the previous bold line, if any (PyMuPDF's
  // tableToMarkdown prepends "**表N.X 标题**" above the table).
  let title = "";
  const titleIdx = block.findIndex((l) => l.trim().startsWith("**") && l.trim().endsWith("**"));
  if (titleIdx >= 0) {
    title = block[titleIdx].trim().replace(/^\*\*/, "").replace(/\*\*$/, "");
  }

  return { title, pageHint, header, rows, index };
}

/* -------------------------------------------------------------------------- */
/*  Canonical indicator extraction — the 9 metrics the customer watches        */
/* -------------------------------------------------------------------------- */

/** Lookup tables mapping the literal table-cell text → our canonical value. */
const NUMBER = (s: string) => {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? m[0] : s.trim();
};

/** Pattern matchers for each canonical indicator. */
function matchDriMinCd(t: ParsedTable): CanonicalIndicator | null {
  // DRL 最小光度. Often appears as 灯名 + cd; for DRL the row should
  // be findable in 灯具光色对应表 (or a separate 光度限值表).
  const row = t.rows.find((r) =>
    r.some((c) => /昼间行驶灯|DRL|daytime.running/i.test(c))
  );
  if (!row) return null;
  // Search for "400 cd" or "500 cd" in this row or the whole table.
  const txt = row.join(" ") + " " + t.rows.flat().join(" ");
  const cd = txt.match(/(\d{2,4})\s*(?:cd|cd\/m)/i);
  if (!cd) return null;
  return {
    id: "drl-min-cd",
    label: "DRL 最小光度",
    unit: "cd",
    value: cd[1],
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchEssFreqHz(t: ParsedTable): CanonicalIndicator | null {
  // ESS 闪烁频率 = (4.0±1.0) Hz in B; A might raise to (5.0±1.0).
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/(\d(?:\.\d+)?)\s*±\s*1(?:\.0)?\s*Hz/i);
  if (!m) return null;
  return {
    id: "ess-freq-hz",
    label: "紧急制动信号(ESS)闪烁频率",
    unit: "Hz",
    value: `${m[1]}±1.0`,
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchEssCd(t: ParsedTable): CanonicalIndicator | null {
  // ESS 光度: row 包含 "紧急制动信号" + 光强数字 (cd).
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/紧急制动信号[^。]*?(\d{2,4})\s*cd/i);
  if (!m) return null;
  return {
    id: "ess-cd",
    label: "紧急制动信号(ESS)光度",
    unit: "cd",
    value: m[1],
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchDriVisibilityDeg(t: ParsedTable): CanonicalIndicator | null {
  // DRL 可见度角度 = ±20° (B) / ±25° (A). 出现在 安装尺寸表 或 角度限值表.
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/±\s*(\d{1,2})\s*°\s*[^\d]*?昼间行驶|昼间行驶[^\d]*?±\s*(\d{1,2})\s*°/i);
  if (!m) return null;
  return {
    id: "drl-visibility-deg",
    label: "DRL 可见度角度",
    unit: "°",
    value: `±${m[1]}`,
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchSideMarkerSpacing(t: ParsedTable): CanonicalIndicator | null {
  // 侧标志灯间距 ≤6m (B) / ≤4m (A). 出现在 灯具安装尺寸表.
  const txt = t.rows.flat().join(" ");
  // Look for: 侧标志灯 ... m或 m. Pattern: row mentions 侧标志灯 + 间距 + m.
  const m = txt.match(/侧标志灯[^。]*?(?:间距|之间)?[^。]*?[≤<]\s*(\d(?:\.\d+)?)\s*m/i);
  if (!m) return null;
  return {
    id: "side-marker-spacing-m",
    label: "侧标志灯间距",
    unit: "m",
    value: `≤${m[1]}`,
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchLedLifeH(t: ParsedTable): CanonicalIndicator | null {
  // LED 寿命 2000 h / 3000 h. 在 试验项目表.
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/LED[^。]*?寿命[^。]*?(\d{3,4})\s*h/i);
  if (!m) return null;
  return {
    id: "led-life-h",
    label: "LED 模块寿命",
    unit: "h",
    value: m[1],
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchLumenMaintenance(t: ParsedTable): CanonicalIndicator | null {
  // 光通维持率 70%/80%. 在 试验项目表.
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/光通维持率[^。]*?(\d{1,3})\s*%/i);
  if (!m) return null;
  return {
    id: "lumen-maintenance",
    label: "LED 光通维持率",
    unit: "%",
    value: m[1],
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchPreheatMin(t: ParsedTable): CanonicalIndicator | null {
  // 预热点灯时间 30 min / 60 min. 在 试验项目表.
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/预热[^。]*?(\d{1,3})\s*min/i);
  if (!m) return null;
  return {
    id: "preheat-min",
    label: "光源预热点灯时间",
    unit: "min",
    value: m[1],
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

function matchAfsSwitchS(t: ParsedTable): CanonicalIndicator | null {
  // AFS 切换时间 ≤2s (B) / ≤1.5s (A). 在 AFS 试验项目表.
  const txt = t.rows.flat().join(" ");
  const m = txt.match(/AFS[^。]*?切换[^。]*?[≤<]\s*(\d(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  return {
    id: "afs-switch-s",
    label: "AFS 切换时间",
    unit: "s",
    value: `≤${m[1]}`,
    page: t.pageHint,
    anchor: `${t.title || "(表)"} (${t.pageHint})`,
  };
}

/**
 * Extract all 9 canonical indicators from a list of parsed tables.
 * Each table may produce 0..N indicators.
 */
export function extractCanonicalIndicators(tables: ParsedTable[]): CanonicalIndicator[] {
  const matchers = [
    matchDriMinCd,
    matchEssFreqHz,
    matchEssCd,
    matchDriVisibilityDeg,
    matchSideMarkerSpacing,
    matchLedLifeH,
    matchLumenMaintenance,
    matchPreheatMin,
    matchAfsSwitchS,
  ];
  const out: CanonicalIndicator[] = [];
  for (const t of tables) {
    for (const m of matchers) {
      try {
        const r = m(t);
        if (r) out.push(r);
      } catch {
        /* swallow — best-effort */
      }
    }
  }
  return out;
}

/** Group indicators by ID and aggregate values per document side. */
export function pairIndicatorsById(
  aInds: CanonicalIndicator[],
  bInds: CanonicalIndicator[],
): Array<{ id: CanonicalIndicator["id"]; label: string; unit: string; a?: CanonicalIndicator; b?: CanonicalIndicator }> {
  const allIds = new Set<CanonicalIndicator["id"]>();
  for (const i of aInds) allIds.add(i.id);
  for (const i of bInds) allIds.add(i.id);
  const labelById = new Map<CanonicalIndicator["id"], { label: string; unit: string }>();
  for (const i of [...aInds, ...bInds]) labelById.set(i.id, { label: i.label, unit: i.unit });
  const out: Array<{ id: CanonicalIndicator["id"]; label: string; unit: string; a?: CanonicalIndicator; b?: CanonicalIndicator }> = [];
  for (const id of allIds) {
    const a = aInds.find((x) => x.id === id);
    const b = bInds.find((x) => x.id === id);
    const meta = labelById.get(id) ?? { label: id, unit: "" };
    out.push({ id, label: meta.label, unit: meta.unit, a, b });
  }
  return out;
}