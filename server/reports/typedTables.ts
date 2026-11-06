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

// 版本显示名表 —— 判据从它派生（见 normVersionLabel 的注释）。
// 单独成模块正是为了**不把整份 spec 拖进这个包**。
import { VERSION_META, normVersionText, activeVersions } from "./versionMeta";

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
  /** Present when the versions are header columns rather than row labels. */
  horizontalCols?: Record<string, number>;
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

/** 一个版本的几种「认得出它的写法」。 */
type VersionAliases = {
  key: string;
  /** 版本键本身：A */
  keyNorm: string;
  /** 展示名去掉版本键之后的那截：草案 / 现行 / UN R48-09 */
  labelTail: string;
  /** 文档名全文：GB4785草案V4.3.5 */
  docNorm: string;
  /** 标准号全文：GB4785—XXXX */
  stdNorm: string;
  /** 文档名去掉末尾的修订号（V4.3.5 / 2019 / 09）：GB4785草案 */
  revNorm: string;
  /** 再去掉「草案 / 现行」那截，只剩标准族：GB4785 */
  famNorm: string;
  /** 上面几截合起来 —— 键后面的部分拿它们去比。 */
  forms: string[];
};

/** 末尾的修订号：V4.3.5 · 2019 · 09 · XXXX */
const REV_TAIL = /[-–—\s]?(V?\d+(?:\.\d+)*|XXXX)\s*$/;
/** 末尾的「草案 / 现行」那截。 */
const LABEL_TAIL = /(草案|现行|国际法规|新编|旧版|修订版)$/;

/**
 * 按一张显示名表造出「标签 → 版本键」的判据。
 *
 * 拆成工厂是为了**能拿一张假表来驱动** ——
 * 判据是从表派生的，那么「换一套标准还对不对」就该用**换一张表**来验，
 * 而不是靠声称。
 *
 * ## 判据
 *
 * ① **版本键打头**：「A」「A 草案」「C UN」——
 *    键后面要么没有，要么是展示名那截的前缀，要么以「版」开头。
 * ② **按文档名/标准号认**：「GB 4785 草案 V4.3.5」「GB 4785—XXXX」「UN R48-09」——
 *    在所有版本的所有别名里取**最长**的那个前缀。
 * ③ **最长者若分属不同版本 → 认不出**（返回 null）。
 *    「GB 4785」就属于这一类：A 与 B 共用同一个标准族，
 *    光看族名**分不出是哪一版** —— 与其猜，不如不认。
 *
 * > 「宁可空着，不可错着」：认不出只是让表格退回普通样式；
 * > 认错会让**对照表把一版的数字摆到另一版的列名下**。
 *
 * ## 为什么判据是**派生**的
 *
 * 原来这里硬编码了「A 草案 / B 现行 / C UN R48」与「GB 4785 … 草案 / … 2019 /
 * UN R\d」这些形状。换一套标准，它们**全都不认** ——
 * 表会退化成普通表格（不报错，只是样式没了）。
 *
 * 现在判据从**声明式显示名表**（`versionMeta.ts` 的 `VERSION_META`）派生：
 * 每个版本的 `label`（"A 草案"）、`doc`（"GB 4785 草案 V4.3.5"）、
 * `std`（"GB 4785—XXXX"）都是判据的一部分。
 * 换标准 = 改那张表一行，**这里一个字都不用改**。
 *
 * 顺带修掉一个**正则优先级**的老 bug：
 * `/^GB\s*4785\D{0,3}XXXX|草案/` 里 `|` 的优先级最低，
 * 所以它其实是「以 GB 4785 开头 **或** 含『草案』」——
 * 于是**任何**带「草案」两个字的标签都被判成 A。
 */
export function buildVersionMatcher(
  meta: ReadonlyArray<{ key: string; label: string; doc: string; std: string }>,
): (label: string) => string | null {
  const aliases: VersionAliases[] = meta.map((m) => {
    const keyNorm = m.key.toUpperCase();
    const docNorm = normVersionText(m.doc);
    const stdNorm = normVersionText(m.std);
    const labelNorm = normVersionText(m.label);
    const labelTail = labelNorm.startsWith(keyNorm) ? labelNorm.slice(keyNorm.length) : labelNorm;
    const revNorm = docNorm.replace(REV_TAIL, "");
    const famNorm = revNorm.replace(LABEL_TAIL, "");
    return {
      key: m.key,
      keyNorm,
      labelTail,
      docNorm,
      stdNorm,
      revNorm,
      famNorm,
      forms: [labelTail, docNorm, stdNorm, revNorm, famNorm].filter(Boolean),
    };
  });

  return (label: string): string | null => {
    const t = normVersionText(label);
    if (!t) return null;

    // ① 版本键打头
    for (const a of aliases) {
      if (t === a.keyNorm) return a.key;
      if (!t.startsWith(a.keyNorm)) continue;
      const rest = t.slice(a.keyNorm.length);
      if (!rest) return a.key;
      if (rest.startsWith("版")) return a.key;
      // 键后面的那截，拿这个版本的**各种写法**去比，**两个方向**都认 ——
      //   rest 以它开头：「A 草案 V4.3.5」「A 草案（第 72 页）」「C UN R48 条款」；
      //   它以 rest 开头：「C UN」之于「C UN R48-09」。
      for (const f of a.forms) {
        if (f && (rest.startsWith(f) || f.startsWith(rest))) return a.key;
      }
    }

    // ② 按别名取**最长**前缀
    let bestLen = 0;
    const bestVersions = new Set<string>();
    for (const a of aliases) {
      for (const alias of [a.docNorm, a.stdNorm, a.revNorm, a.famNorm]) {
        if (!alias || !t.startsWith(alias)) continue;
        if (alias.length > bestLen) {
          bestLen = alias.length;
          bestVersions.clear();
          bestVersions.add(a.key);
        } else if (alias.length === bestLen) {
          bestVersions.add(a.key);
        }
      }
    }
    if (bestLen === 0) return null;
    // ③ 同样长却分属不同版本 → 分不出是哪一版，**不猜**
    if (bestVersions.size !== 1) return null;
    return [...bestVersions][0];
  };
}

/*
 * `defaultVersionMatcher` 在模块加载时就算好了 ——
 * 所以 `REV_TAIL` / `LABEL_TAIL`（工厂函数要用）必须**声明在它之前**。
 * 否则打包后 `var` 提升让它们是 undefined：
 * `docNorm.replace(undefined, "")` 变成「找字符串 undefined」，
 * **别名全部退化成文档名全文**，于是「UN R48」「GB 4785 草案」这类简写认不出来。
 *
 * 这个坑是 `_test_version_labels.mjs` 抓到的：
 * 用假表驱动工厂函数时是对的（那时常量已初始化），
 * 用默认表时是错的（初始化时机不同）——
 * **同一段逻辑，两条路，结果不一样。**
 */
const defaultVersionMatcher = buildVersionMatcher(VERSION_META);

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
export function normVersionLabel(label: string): string | null {
  return defaultVersionMatcher(label);
}

/** Find the version column (版本 / 来源 / version). */
function findVersionCol(header: string[]): number {
  // **只在第 0 列认版本列** —— 与 htmlRenderV8.ts 的 findVersionIdx 同一口径。
  // 放宽到任意一列，会把「版本是某一行的属性」的表误判成纵向对照表：
  // 渲染器按「每行一个文档」重排，**参数名列被整列丢掉**，
  // 交付件里那张表只剩页码与取值，看不出是哪一条参数。
  // 报告里所有合法的纵向对照表，版本列都在第 0 列。
  if (!header.length) return -1;
  const h = header[0].replace(/[\s*　]/g, "");
  if (/^(版本|来源|version)$/i.test(h)) return 0;
  return -1;
}

/**
 * Detect a horizontal three-version header:
 *   | 项目 | A（GB 4785 草案） | B（GB 4785-2019） | C（UN R48-09） |
 * The LLM emits this orientation on some runs; treating it as "plain" makes
 * every comparison table in such a report degrade to an unstyled grid.
 */
function findHorizontalVersionCols(header: string[]): Record<string, number> | null {
  const clean = header.map((h) => (h ?? "").replace(/\*/g, "").trim());
  const idx = (v: string) =>
    clean.findIndex((h) => new RegExp(`^\\s*${v}(?![A-Za-z])[（(【\\s]|${v}\\s*$`).test(h));
  // 版本列按**当前语料实际有的版本**认 —— 写死 A/B/C 的话，
  // 换一套标准（X/Y/Z）或加第四版时，整张横向对照表会退回普通表格
  // （不报错，只是样式没了 —— 但那正是「只有罗列，没有比较」）。
  const keys = activeVersions();
  const found: Record<string, number> = {};
  for (const k of keys) {
    const i = idx(k);
    if (i >= 0 && !Object.values(found).includes(i)) found[k] = i;
  }
  const got = Object.keys(found);
  if (got.length !== keys.length) return null;
  if (new Set(Object.values(found)).size !== got.length) return null;
  // The card layout shows ONE label and ONE value per row, so it can only carry
  // a topic column plus the version columns. Every extra column is silently
  // dropped — and for
  // `| 参数 | 单位 | A 草案 | B 现行 | C UN R48-09 | 判定 |` the two dropped
  // columns are the unit and the verdict, i.e. the whole point of the table.
  // Chapter 12.1 was printing 73 parameters as three unaligned number lists with
  // no units and no A=C≠B call-out, which is what 「只有罗列，没有比较」 meant.
  //
  // Measured on this report: every table that reached the card layout had 6 or 7
  // columns; the only 4-column horizontal tables carry no version columns at all
  // and were already rejected above. Anything wider belongs in a plain table.
  if (header.length !== got.length + 1) return null;
  return found;
}

function classifyTable(
  header: string[],
  rows: string[][],
): { kind: TypedTableKind; versionIdx: number; horizontalCols?: Record<string, number> } {
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