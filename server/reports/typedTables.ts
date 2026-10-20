/**
 * typedTables — TypeScript port of extract_aligned_tables.py
 *
 * Why this exists
 * ---------------
 * The Python extractor used to run out-of-band (extract_aligned_tables.py →
 * dist/aligned-tables.json), which meant the render pipeline had a hard
 * external dependency: no Python, no correct tables. It also created a
 * staleness hazard (an old bundle silently overwriting a fresh report —
 * see the source_generated_at guard in htmlRenderV8).
 *
 * We measured the cost of dropping it: markdown-only rendering lost 19
 * triptych cards (141 pages → 125). Multi-line rows make the markdown
 * parser mis-classify A/B comparison tables as plain tables. So the
 * normalization pass is load-bearing, and it has to live in-process.
 *
 * This module is a faithful 1:1 port:
 *   - parseMdTables()      → blocks split by blank lines
 *   - parseOneTable()      → header/sep/body + multi-line row collector
 *   - normalizeRow()       → pad short rows with "—", merge long rows with <br>
 *   - classifyTable()      → triptych vs plain
 *   - extractTypedTables() → whole-report entry list
 */

export type TypedTableKind = "triptych" | "plain";

export type TypedTableEntry = {
  /** e.g. "ch13.t9" — chapter index + table ordinal within the chapter. */
  id: string;
  /** Chapter title, for debugging / grouping. */
  chapter: string;
  kind: TypedTableKind;
  header: string[];
  /** Body rows, already width-normalized to header.length. */
  rows: string[][];
  /** Index of the version column within header (triptych only), else -1. */
  versionIdx: number;
  /** Present when A/B/C are header columns rather than row labels. */
  horizontalCols?: { A: number; B: number; C: number };
};

export type TypedTablesBundle = {
  tables: TypedTableEntry[];
  stats: {
    total_chapters: number;
    total_tables: number;
    triptych_tables: number;
    plain_tables: number;
    rows_normalized: number;
  };
};

// ---------------------------------------------------------------------------
// Markdown table parsing
// ---------------------------------------------------------------------------

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * Parse one table out of a blank-line-delimited block.
 *
 * Multi-line row collector (mirrors collectTableRows in htmlRenderV8):
 *   - every `|`-leading line starts a NEW row (previous row is flushed first)
 *   - non-pipe lines accumulate into the current row while it's "open"
 *     (i.e. the opening line didn't end with `|`)
 *   - trailing open row is always flushed
 *
 * The "always flush on pipe-start" rule is what fixes A/B rows being merged
 * into one cell when the first row's last cell has multi-line content.
 */
function parseOneTable(
  block: string[],
): { header: string[]; rows: string[][] } | null {
  if (block.length < 2) return null;

  const header = splitRow(block[0]);
  const sep = block[1].trim();
  // Separator row must be |---|---| style
  if (!/^[\s:|-]+$/.test(sep)) return null;

  const rawRows: string[] = [];
  let cur: string[] = [];
  let open = false;

  for (const raw of block.slice(2)) {
    const t = raw.trim();
    if (t === "") break;
    if (t.startsWith("|")) {
      if (cur.length) rawRows.push(cur.join("\n"));
      cur = [raw];
      open = !t.endsWith("|");
      continue;
    }
    if (open) {
      cur.push(raw);
      continue;
    }
    break; // orphan non-pipe line: table ends
  }
  if (cur.length) rawRows.push(cur.join("\n"));

  return { header, rows: rawRows.map(splitRow) };
}

/**
 * Split a markdown document into blank-line-delimited blocks and parse each
 * block that looks like a table (≥2 pipe-leading lines).
 */
export function parseMdTables(md: string): Array<{ header: string[]; rows: string[][] }> {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) blocks.push(cur);
      cur = [];
    } else {
      cur.push(l);
    }
  }
  if (cur.length) blocks.push(cur);

  const out: Array<{ header: string[]; rows: string[][] }> = [];
  for (const block of blocks) {
    const pipeLines = block.filter((l) => l.trim().startsWith("|")).length;
    if (pipeLines < 2) continue;
    const parsed = parseOneTable(block);
    if (parsed) out.push(parsed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Row-width normalization (the "缺角" fix)
// ---------------------------------------------------------------------------

/**
 * Normalize a row's cell count to the header width.
 *   - shorter → pad with "—"
 *   - longer  → merge overflow into the last cell with <br>
 */
export function normalizeRow(row: string[], width: number): string[] {
  if (row.length === width) return row;
  if (row.length < width) {
    return [...row, ...Array<string>(width - row.length).fill("—")];
  }
  const head = row.slice(0, width - 1);
  const tail = row.slice(width - 1).filter((c) => c && c.trim() !== "");
  const merged = tail.length ? tail.join("<br>") : "—";
  return [...head, merged];
}

// ---------------------------------------------------------------------------
// Triptych classification
// ---------------------------------------------------------------------------

/**
 * Normalize a version cell to A / B / C.
 *
 * Accepts every shape the report actually contains:
 *   "A"  "**A**"  "A 草案"  "A 版"  "GB 4785 草案"
 *   "B"  "**B**"  "B 现行"  "B 版"  "GB 4785-2019"
 *   "C"  "**C**"  "C UN"    "UN R48-09"
 *
 * NOTE: htmlRenderV8's own normVersion() requires a suffix (A 草案 / A 版);
 * this one deliberately also accepts the bare letter, because source markdown
 * frequently writes just "**A**" and a bare-letter miss would silently
 * downgrade a real comparison table to a plain table.
 */
function normVersionLabel(label: string): "A" | "B" | "C" | null {
  const t = (label ?? "")
    .replace(/\*/g, "")
    .replace(/[`_\s]/g, "")
    .trim()
    .toUpperCase();
  if (!t) return null;
  if (/^A(版|草案|$)/.test(t)) return "A";
  if (/^B(版|现行|2019|$)/.test(t)) return "B";
  if (/^C(版|UN|R48|$)/.test(t)) return "C";
  // Long-form labels used in the "文档" index column
  if (/^GB\s*4785\D{0,3}XXXX|草案/.test(t)) return "A";
  if (/^GB\s*4785\D{0,3}2019|现行/.test(t)) return "B";
  if (/^UN\s*R\d/.test(t)) return "C";
  return null;
}

/** Find the version column (版本 / 来源 / version). */
function findVersionCol(header: string[]): number {
  const norm = header.map((h) => h.replace(/[\s*　]/g, ""));
  for (let i = 0; i < norm.length; i++) {
    if (/^(版本|来源|version)$/i.test(norm[i])) return i;
  }
  return -1;
}

/**
 * Detect a horizontal three-version header:
 *   | 项目 | A（GB 4785 草案） | B（GB 4785-2019） | C（UN R48-09） |
 * The LLM emits this orientation on some runs; treating it as "plain" makes
 * every comparison table in such a report degrade to an unstyled grid.
 */
function findHorizontalVersionCols(header: string[]): { A: number; B: number; C: number } | null {
  const clean = header.map((h) => (h ?? "").replace(/\*/g, "").trim());
  const idx = (v: "A" | "B" | "C") =>
    clean.findIndex((h) => new RegExp(`^\\s*${v}(?![A-Za-z])[（(【\\s]|${v}\\s*$`).test(h));
  const A = idx("A");
  const B = idx("B");
  const C = idx("C");
  if (A < 0 || B < 0 || C < 0) return null;
  if (new Set([A, B, C]).size !== 3) return null;
  // The card layout shows ONE label and ONE value per row, so it can only carry
  // a topic column plus A/B/C. Every extra column is silently dropped — and for
  // `| 参数 | 单位 | A 草案 | B 现行 | C UN R48-09 | 判定 |` the two dropped
  // columns are the unit and the verdict, i.e. the whole point of the table.
  // Chapter 12.1 was printing 73 parameters as three unaligned number lists with
  // no units and no A=C≠B call-out, which is what 「只有罗列，没有比较」 meant.
  //
  // Measured on this report: every table that reached the card layout had 6 or 7
  // columns; the only 4-column horizontal tables carry no A/B/C at all and were
  // already rejected above. Anything wider belongs in a plain table.
  if (header.length !== 4) return null;
  return { A, B, C };
}

function classifyTable(
  header: string[],
  rows: string[][],
): { kind: TypedTableKind; versionIdx: number; horizontalCols?: { A: number; B: number; C: number } } {
  const versionCol = findVersionCol(header);

  if (versionCol >= 0) {
    const versionRows = rows.filter((r) =>
      normVersionLabel(r[versionCol] ?? ""),
    );
    if (versionRows.length >= 1) return { kind: "triptych", versionIdx: versionCol };
  }

  // Fallback: first column holds A/B/C markers on ≥2 rows
  const abC = rows.filter((r) => normVersionLabel(r[0] ?? ""));
  if (abC.length >= 2) return { kind: "triptych", versionIdx: 0 };

  // Horizontal form: A/B/C are header columns.
  const hCols = findHorizontalVersionCols(header);
  if (hCols) return { kind: "triptych", versionIdx: -1, horizontalCols: hCols };

  return { kind: "plain", versionIdx: -1 };
}

// ---------------------------------------------------------------------------
// Whole-report extraction
// ---------------------------------------------------------------------------

/**
 * Extract every table from a RenderableReport-shaped object.
 *
 * `chapters` entries need { markdown: string } and an index; the title is
 * only used for the entry's `chapter` field.
 */
export function extractTypedTables(
  chapters: Array<{ markdown?: string }>,
  titleOf?: (index: number) => string,
): TypedTablesBundle {
  const stats = {
    total_chapters: 0,
    total_tables: 0,
    triptych_tables: 0,
    plain_tables: 0,
    rows_normalized: 0,
  };
  const tables: TypedTableEntry[] = [];

  chapters.forEach((ch, ci) => {
    const md = ch?.markdown ?? "";
    if (!md) return;
    stats.total_chapters++;

    const chapterTitle = titleOf ? titleOf(ci) : "";
    const parsed = parseMdTables(md);

    parsed.forEach((tbl, ti) => {
      stats.total_tables++;
      const width = tbl.header.length;
      const rows = tbl.rows.map((r) => {
        if (r.length !== width) stats.rows_normalized++;
        return normalizeRow(r, width);
      });

      const { kind, versionIdx, horizontalCols } = classifyTable(tbl.header, rows);
      if (kind === "triptych") stats.triptych_tables++;
      else stats.plain_tables++;

      tables.push({
        id: `ch${ci}.t${ti}`,
        chapter: chapterTitle,
        kind,
        header: tbl.header,
        rows,
        versionIdx,
        ...(horizontalCols ? { horizontalCols } : {}),
      });
    });
  });

  return { tables, stats };
}