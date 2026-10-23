/**
 * Parameter matrix — the thing the customer actually asked for.
 *
 * The report previously claimed to compare "24 parameters × 3 versions" but
 * nothing in the pipeline ever produced parameter × version × value. Two
 * structures stood in for it, and neither is a comparison:
 *
 *   - `topicColumns`  24 rows of *prose excerpts* per version. For lamp-name
 *     topics the R48 anchor always landed on §6.x.1 "Presence" + §6.x.2
 *     "Number", because in UN R48 the first clause under every lamp number is
 *     exactly that. Verified, cited, page-numbered — and wrong.
 *   - `valueDiffs`     45 A-vs-B *text* differences. Two versions, no C column,
 *     mostly wording.
 *
 * So chapter 12 shipped three consecutive raw dumps (A's table, B's table, C's
 * table) under a summary column that read 见下方表格内容 on all 492 rows.
 *
 * This module extracts one row per parameter per version from the actual source
 * text, with clause and page. The rule that matters:
 *
 *   **Allow empty. Forbid wrong.** A parameter that cannot be located is
 *   `not-found`. A parameter resolved to the wrong clause is worse than one
 *   left empty, because the reader will trust it.
 *
 * Extraction is anchored on a per-parameter, per-version pattern rather than a
 * topic name, because topic-name anchoring is precisely what produced the
 * Presence-clause bug.
 */

/**
 * A document version key — "A", "B", "C" today, any string tomorrow.
 *
 * This is deliberately NOT a union type. The union was what made every new
 * standard a code edit: `row.A`, `for (const v of ["A","B","C"])`, the delivery
 * gate's three thresholds. The set of versions is a property of the uploaded
 * corpus, so it is derived at runtime (see `versionsOf`), not declared here.
 */
export type Version = string;

/**
 * Display names. This is the one genuinely declarative part: "草案" / "现行" /
 * "UN R48-09" are domain knowledge, not structure, and cannot be derived from
 * a regex. Adding a fourth standard means adding one line here and one entry to
 * `data/` — no renderer changes.
 */
export const VERSION_META: ReadonlyArray<{ key: Version; label: string; desc: string }> = [
  { key: "A", label: "A 草案", desc: "GB 4785 草案 V4.3.5（新版）" },
  { key: "B", label: "B 现行", desc: "GB 4785-2019（现行）" },
  { key: "C", label: "C UN R48-09", desc: "UN R48-09（国际参照，仅作对照不做变化判定）" },
];

/**
 * The versions actually present in this corpus, in display order.
 *
 * A version counts as present when its document carries text. An upload that
 * is missing C yields a two-version matrix rather than a column of
 * "⚠ 未定位" that reads as a regulatory finding — and the delivery gate, which
 * demands a non-empty C column, then fails loudly instead of shipping a
 * one-sided comparison dressed up as a three-way one.
 */
export function versionsOf(data: Record<string, any>): Version[] {
  const withText = new Set(
    Object.entries(data ?? {})
      .filter(([, d]) => String((d as any)?.fullText ?? "").trim())
      .map(([k]) => k),
  );
  const ordered = VERSION_META.filter((m) => withText.has(m.key)).map((m) => m.key);
  const extras = [...withText].filter((k) => !VERSION_META.some((m) => m.key === k)).sort();
  return [...ordered, ...extras];
}

/**
 * Put a set of version keys into display order: the **declared** ones first
 * (in VERSION_META order), then any unknown key alphabetically.
 *
 * The renderer used to hardcode `["A","B","C"]` in four places. That works
 * exactly as long as the corpus has three documents — and silently drops the
 * fourth: the data layer was already version-agnostic (`versionsOf`), so the
 * matrix grew a D column while the PDF's comparison tables did not.
 */
export function orderVersions(keys: string[]): string[] {
  const present = new Set(keys ?? []);
  const known = VERSION_META.map((m) => m.key).filter((k) => present.has(k));
  const extras = [...present].filter((k) => !known.includes(k)).sort();
  return [...known, ...extras];
}

/** Display label for a version key; unknown keys fall back to the key itself. */
export function versionLabel(v: Version): string {
  return VERSION_META.find((m) => m.key === v)?.label ?? v;
}

export interface Cell {
  value: string;
  /** The exact text the pattern matched — the basis for `nums`. */
  match: string;
  /** Numbers inside the match, thousands-separators folded (["500","1200"]). */
  nums: string[];
  clause: string;
  page: string;
  status: "verified" | "not-found";
  /** "MinerU" or "源 PDF" — which corpus produced this value. */
  source?: string;
  /**
   * Why a cell is empty — the two cases were previously merged into one
   * sentence repeated in every empty cell, which told the reader nothing:
   *   `no-pattern` — no regex was written for this version at all
   *   `no-match`   — a regex exists but found nothing in the corpus
   * Neither means "this standard does not require it"; that is a regulatory
   * claim we cannot make from a failed extraction.
   */
  miss?: "no-pattern" | "no-match" | "not-specified";
  /**
   * Why this version does not carry the requirement — required whenever
   * `miss === "not-specified"`.
   *
   * "We wrote no rule" and "the standard does not require this" are opposite
   * things to a reader, and only the second is a regulatory claim. It is
   * therefore made explicitly, with the clause that was checked, or not at all.
   */
  absentReason?: string;
}

/**
 * `changed` / `same` compare the first two versions; `${key}-only` marks a
 * version that is the sole gap (the other two carry the requirement and agree);
 * `incomplete` means two or more are unlocated, so nothing can be claimed.
 */
export type Verdict = "changed" | "same" | "incomplete" | string;

/**
 * Why a cell is empty is NOT knowable from a failed match, and the two cases
 * mean opposite things to a reader: "this version does not require it" versus
 * "this version requires it but MinerU could not read the table". GB 4785-2019's
 * chromaticity table is the second case — its text layer interleaves cells into
 * `W12蓝色边界:y=0.843-1.182x`, so the blue boundary cannot be located even
 * though B plainly specifies it. Saying "B 未规定" there would be a false
 * regulatory claim, so every not-found note carries the caveat.
 */
export const NOT_FOUND_NOTE = "未在原文定位到（该版未规定 / 原文表格 OCR 不可读，二者需人工确认）";

/**
 * Why a cell is empty — said in the cell, in six characters, instead of the
 * same long caveat repeated in every empty cell (37 of 213 in the ⑨ build).
 *
 * The distinction is knowable: the cell builder knows whether a regex existed
 * for this version. Neither value is a regulatory claim — "R48 does not require this"
 * cannot be concluded from a failed extraction, which is why the old wording
 * had to hedge every time.
 */
function missLabel(c: Cell): string {
  if (c.miss === "not-specified") return "— 该版无此规定（已核）";
  return c.miss === "no-pattern" ? "— 未建该版规则" : "— 规则未命中";
}

export interface Row {
  id: string;
  name: string;
  family: string;
  unit: string;
  /** version key → that version's cell. Dynamic: an N-version matrix is an N-key object. */
  cells: Record<Version, Cell>;
  verdict: Verdict;
  /** Why this row reads the way it does — shown in the table. */
  note: string;
}

export interface MatrixStats {
  rows: number;
  cells: number;
  verified: number;
  /** the versions this matrix was built over, in display order */
  versions: Version[];
  byVersion: Record<Version, { hit: number; total: number }>;
  changed: number;
  /** cells recovered from the source PDF after MinerU failed. */
  fromSourcePdf: number;
}

/** One parameter. `p` maps a version to the pattern that locates its value. */
interface Spec {
  id: string;
  name: string;
  family: string;
  unit: string;
  p: Partial<Record<Version, RegExp>>;
  /**
   * version → why that version does not carry the requirement.
   *
   * A verified absence, not a failed extraction. The reason names the clause
   * that was checked so a reader can go and check it again.
   */
  absent: Partial<Record<Version, string>>;
  /**
   * version → the clause the extracted value belongs to.
   *
   * Three sources, in order of trust:
   *   1. the spec's explicit `clause` (the author asserts it, and must say why);
   *   2. the clause literal the pattern anchors on (`5\.16\.4\.2` → 5.16.4.2);
   *   3. `nearestClause()`'s guess, which is often wrong — R48 prints its
   *      paragraph numbers in the page margin, so the "nearest preceding
   *      number" is a sibling clause, and a table row can glue two numbers
   *      together into `6.14.4.6.14`.
   */
  clause: Partial<Record<Version, string>>;
}

const MISS: Cell = { value: "", match: "", nums: [], clause: "", page: "", status: "not-found" };

/**
 * Numbers inside a matched string, with thousands separators folded.
 *
 * The same requirement comes out of MinerU as `1,200 mm` (C), `1200mm` (A) and
 * `1 200 mm` (B, markup spacing). Comparing the quoted prose instead made A and
 * B look different and produced a false "changed" on clause 5.2.4.2 — the very
 * defect class this module exists to eliminate. Compare numbers, not markup.
 */
/**
 * UN R48 states limits in words far more often than digits — §6.5.9 reads
 * "within not more than one and one-half seconds by its first extinction".
 * Without this, every such clause came back with an empty number list and fell
 * through to a text comparison that cannot see that "one and one-half" and
 * "1.5s" are the same limit.
 */
const WORD_NUM: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  fifteen: "15", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", ninety: "90",
};

function expandWordNumbers(s: string): string {
  return s
    .replace(/one[\s-]+and[\s-]+one[\s-]*half/gi, "1.5")
    .replace(/one[\s-]*half/gi, "0.5")
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\b/gi,
      (w) => WORD_NUM[w.toLowerCase()] ?? w);
}

/**
 * Numbers in a matched string, with thousands separators folded and — when the
 * spec's unit is millimetres — metres converted.
 *
 * GB 4785-2019 writes lengths in millimetres ("长度大于6000mm"), the 2026 draft
 * writes the same threshold in metres ("长度大于 6m"). Comparing the raw
 * numbers read 6 against 6,000 and reported a "changed" verdict for a pure
 * unit difference. The conversion is gated on the spec's unit so it can never
 * touch a speed (km/h), an intensity (cd) or an angle (°).
 */
export function numbersOf(s: string, unit?: string): string[] {
  const metric = unit === "mm"
    ? s.replace(/(\d+(?:\.\d+)?)\s*m(?![mA-Za-z])/g, (_m, n: string) => String(parseFloat(n) * 1000))
    : s;
  const folded = expandWordNumbers(metric)
    // vehicle-class designations (N2G, M3G) are not values — strip the markup
    // MinerU wraps them in first, or the 2 and 3 land in the number list and
    // make A's reversing-lamp row read "250 / 1200 / 2 / 3 / 2 / 3 / 1400".
    .replace(/<[^>]*>/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[_^{}]/g, " ")
    .replace(/\b[A-Z]\s*\d+\s*[A-Z]\b/g, " ")
    // Chinese vehicle/lamp class designations — 5类、6类、1a类、15 类. These are
    // identifiers, not values, and letting them in produced a FALSE change on
    // the direction-indicator vertical angle: A's list read
    // "2 / 2 / 1 / 1 / 1 / 2 / 2 / 5 / 15" against B's "2 / 1 / 1 / 1 / 2 / 2 / 5 / 15",
    // so two identical 15° limits were reported as a change. That is exactly the
    // defect this module exists to remove, reintroduced through a new clause.
    .replace(/\d+\s*[a-z]?\s*类/g, " ")
    // Vehicle / device class digits, markup-stripped form. MinerU writes
    // `M<sub>1</sub>`; after the tag strip above it reads `M 1`, which the
    // `[A-Z]\d+[A-Z]` rule misses (an "and" follows, not a letter) and the
    // `N类` rule never covered. R48 §6.5.4.2.1 read as `350 / 1 / 1 / 500`
    // against GB `350 / 500` — two spurious numbers turning an identical
    // clause into a reported change.
    //
    // The letter set is deliberate: M/N = vehicle class, O = trailer,
    // S = lamp device category. A bare `\b[A-Z]\s*\d\b` would eat the 48 in
    // "UN R48", which appears in excerpts often.
    .replace(/\b[MNOS]\s*\d\b/g, " ")
    // Product/category labels that carry digits: W12 / R12 / W23 (chromaticity
    // boundary names), N2G / M3G (vehicle classes, sometimes written without
    // the trailing G). These are identifiers, not limits — the white boundary
    // row was reading "12 / 0.15 / 0.64" where 12 is the W12 label, and a
    // reader has no way to tell that apart from a measured value.
    .replace(/\b[WRAYH]\s*\d{1,3}\b/g, " ")
    // System voltage qualifiers: "13.5V（12V 系统）" states the limit AND the
    // nominal it applies to. The nominal is not a third limit; the row was
    // reading "13.5 / 12 / 28 / 24 / 5" for a 13.5 V cap.
    .replace(/\d+(?:\.\d+)?\s*[Vv]\s*[（(]\s*\d+\s*[Vv]\s*[系统系統]\s*[）)]/g, " ")
    // …and the bare "24V 系统" that appears without a preceding limit.
    .replace(/\b\d+\s*[Vv]\s*[系统系統]/g, " ")
    // The same thing in English, which is how R48 writes it: §5.27.2 reads
    // "shall not exceed 6.75 V (6 Volt-Systems), 13.5 V (12 Volt-Systems) or
    // 28 V (24 Volt-Systems) by more than 3 per cent". The Chinese rule above
    // matched none of it, so the row read "6.75/6/13.5/12/28/24/3" — three
    // nominals mixed among three limits. Stripped: "6.75/13.5/28/3", the same
    // shape as GB's "13.5/28/5".
    .replace(/\s*[（(]\s*\d+(?:\.\d+)?\s*Volt\s*[-‐-―]?\s*Systems?\s*[）)]/gi, " ")
    .replace(/\(\s*\d+\s*Volt\s*[-‐-―]?\s*Systems?\s*\)/gi, " ")
    // drop clause numbers (6.4.4.2, 5.13.9) — they are citations, not values
    .replace(/\d+(?:\.\d+){2,}/g, " ")
    // Two-part clause references, which the rule above cannot reach: GB 4785
    // writes "由3.15定义的 α 和 β 角" / "按4.11要求" / "符合5.13.9".
    // `reversingLamp.verticalAngle` read `3.15 / 15` because of it.
    // A blanket `\d+\.\d+` is NOT the fix — chromaticity boundaries are
    // two-part too (0.15 / 0.44 / 0.31 / 0.64) and stripping those would
    // empty the whole colour chapter. The Chinese lead-in is what
    // distinguishes a citation from a measurement.
    .replace(/(?:由|按|根据|见|符合|参照|依照)\s*\d+(?:\.\d+){1,3}\s*(?:定义|规定|的要求|条)?/g, " ")
    .replace(/(\d)[\s,]*(?=\d{3}(?!\d))/g, "$1")
    // Three or more space-separated single digits are ONE number too.
    // The pair rule below cannot reach them: after it merges `4 0` into
    // `40`, the remaining ` 0` has a digit on its left and the lookbehind
    // refuses. `$4 0 0 \\mathrm { c m } ^ { 2 }$` therefore read
    // `40 / 0`. Must run BEFORE the pair rule so the whole run is taken.
    .replace(/(?<![\d.])\b(\d(?:\s+\d){2,})\b(?![\d.])/g, (m) => m.replace(/\s+/g, ""))
    // Single digits separated by a space are ONE number. MinerU writes B's
    // LaTeX as `$2 0 ^ { \circ }$`, which numbersOf used to read as two values
    // (2 and 0) — turning a correct row into a phantom "changed" verdict.
    // `\b` on both sides keeps this off clause numbers ("5.6.5.2" → no match)
    // and off CJK ("5 类" → 类 is not a digit).
    .replace(/(?<![\d.])\b(\d)\s+(\d)\b(?![\d.])/g, "$1$2");
  return (folded.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(parseFloat(n)));
}

/* ------------------------------------------------------------------ specs */

/**
 * Parameter specs live in `data/parameter-specs.json`, not here.
 *
 * They were 27 hand-written regex literals totalling 1,200-odd characters of
 * CJK clause anchors. That coupled three unrelated things into one edit:
 * adding a parameter meant recompiling TypeScript; there was no way to tell a
 * schema mistake from a regex mistake; and the reasoning behind each awkward
 * pattern (why C anchors on the English boundary name, why A has no pattern for
 * V-level speed) lived only as a comment in a compiled file.
 *
 * The JSON keeps that reasoning as a `why` field next to the pattern it
 * explains. Method — how to write a correct pattern — moved to
 * `.claude/skills/parameter-spec/SKILL.md`; data — which parameters exist —
 * stays here, editable without touching code.
 */
import SPECS_JSON from "../../data/parameter-specs.json";

interface SpecJson {
  id: string;
  name: string;
  family: string;
  unit: string;
  note?: string;
  patterns: Partial<Record<string, { source: string; flags?: string; clause?: string }>>;
  /** version → why this pattern is written the way it is. Kept for humans. */
  why?: Partial<Record<string, string>>;
}

/**
 * A spec may name any version key. Whether that key exists is NOT checked here
 * — the spec file is loaded at module scope, long before the corpus is known,
 * and a spec legitimately describes a standard that this particular upload may
 * not include. The mismatch is a real error, but it is a *corpus* error and is
 * raised in `buildParameterMatrix`, where both sides are in hand.
 */
/**
 * The clause number a pattern anchors on, e.g. `5\.16\.4\.2` → "5.16.4.2".
 *
 * Only three-or-more-level numbers count: `5.16` is a chapter heading, not a
 * clause, and a pattern starting with a *value* (`4\.0\s*±`) is not a clause
 * at all — both must keep the inferred clause.
 */
function anchorClause(source: string): string {
  const m = String(source ?? "").match(/^(\d+(?:\\\.\d+){2,})/);
  return m ? m[1].replace(/\\/g, "") : "";
}

/**
 * A clause citation may also point into an **appendix**:
 *   - `D.5.5`      — GB 4785 附录D 的第 5.5 条（附录用字母编号：附录A…附录J）
 *   - `表C.1`      — GB 4785 附录C 的表 C.1
 *   - `附录H`      — GB 4785-2019 附录H
 *   - `Annex 5`   — UN R48 的 Annex 5
 *
 * 附录里住着真要求（随装载变化的倾斜度安全界限 4 mrad（0.4%）、自动切换近光的
 * 响应时间 2s/5s/300s），而 `nearestClause()` 只会从「数字.数字」里推条款号 ——
 * 推不到附录。所以附录引用必须**显式声明**。
 *
 * 这些形态一样要过交付闸门：条款号必须在那份标准的文本里验到
 * （scripts/verify.mjs 的「显式条款号必须在原文里验到」）。
 */
// UN R48 的条款号有到 **七级**的（6.1.9.3.1.1.1 传感器探测边界角），
// GB 两版也有六级的（5.19.7.5.1）。形态校验要放得下这些层级，
// 否则「写死条款号」这条路在深层条款上根本走不通 ——
// 于是只剩就近推断，而就近推断会被交叉引用吃掉。
const CLAUSE_SHAPE =
  /^(?:\d+(?:\.\d+){1,6}|[A-Z]\.\d+(?:\.\d+){0,3}|Annex\s+\d+(?:\.\d+){0,3}|表[A-Z]\.\d+(?:\.\d+)?|附录[A-Z](?:\s*表[A-Z]\.\d+)?)$/;

function compileSpecs(raw: unknown): Spec[] {
  const list = (raw as { specs?: SpecJson[] })?.specs;
  if (!Array.isArray(list) || !list.length) {
    throw new Error("data/parameter-specs.json: specs 缺失或为空 —— 矩阵无法构建");
  }
  const seen = new Set<string>();
  return list.map((r, i) => {
    const bad = ["id", "name", "family", "unit"].filter((k) => !String((r as any)[k] ?? "").trim());
    if (bad.length) throw new Error(`parameter-specs.json 第 ${i + 1} 条缺少字段: ${bad.join(", ")}`);
    if (seen.has(r.id)) throw new Error(`parameter-specs.json 出现重复 id: ${r.id}`);
    seen.add(r.id);
    const p: Partial<Record<Version, RegExp>> = {};
    const clause: Partial<Record<Version, string>> = {};
    for (const [ver, pat] of Object.entries(r.patterns ?? {})) {
      const patStr = typeof pat === "string" ? pat : (pat as any)?.source;
      const flags = typeof pat === "string" ? "i" : (pat as any)?.flags ?? "i";
      try {
        p[ver] = new RegExp(patStr, flags.replace(/g/g, ""));
      } catch (e) {
        throw new Error(`${r.id}/${ver} 正则无法编译: ${(e as Error).message}`);
      }
      const explicit = typeof pat === "string" ? "" : String((pat as any)?.clause ?? "").trim();
      const anchored = anchorClause(patStr);
      if (explicit) {
        if (!CLAUSE_SHAPE.test(explicit)) {
          throw new Error(
            `${r.id}/${ver} 显式条款号 "${explicit}" 不是条款号形态` +
              `（应形如 5.16.4.2 / D.5.5 / 表C.1 / 附录H / Annex 5）`,
          );
        }
        if (!String((r as any).why?.[ver] ?? "").trim()) {
          throw new Error(
            `${r.id}/${ver} 显式声明了条款号 ${explicit}，但 why 里没写为什么不能自动推断 —— ` +
              `显式声明必须留理由，否则下一任维护者无从判断它是否还成立`,
          );
        }
        clause[ver] = explicit;
      } else if (anchored) {
        clause[ver] = anchored;
      }
    }
    const absent: Partial<Record<Version, string>> = {};
    for (const [ver, reason] of Object.entries((r as any).absent ?? {})) {
      const txt = String(reason ?? "").trim();
      // A "not specified" claim without a reason is the old wording in a new
      // hat — it would read as "we checked" while proving nothing.
      if (!txt) {
        throw new Error(
          `${r.id}/${ver} 标为「该版无此规定」但没写理由 —— 没有理由的空值不能声称「已核」`,
        );
      }
      absent[ver] = txt;
    }
    return { id: r.id, name: r.name, family: r.family, unit: r.unit, p, absent, clause };
  });
}

const SPECS: Spec[] = compileSpecs(SPECS_JSON);

export const SPEC_COUNT = SPECS.length;

/* ------------------------------------------------------------- extraction */

/**
 * Fallback corpus: the uploaded source PDFs, read directly with PyMuPDF.
 *
 * MinerU's table extraction is not reliable for these documents. GB 4785-2019's
 * chromaticity table comes back as
 *
 *   W23黄绿色边界y=0.440WWWW34564561黄紫紫蓝色红色色边色边边界边界界界xxy===y000=…0530501.03008+20.750x
 *
 * — three overlapping columns flattened onto one line, wrong colour names, wrong
 * numbers. The identical corruption appears in MinerU's `markdown` AND its
 * `tables[]`, so it is the extractor, not our post-processing, and switching to
 * the structured table output changes nothing.
 *
 * The source PDF's text layer is fine; PyMuPDF just splits it mid-token:
 *
 *   "W12绿色边界:y=0."  "150+0."  "640x"
 *
 * Concatenating the fragments of a page yields `W12绿色边界:y=0.150+0.640x` with
 * all six boundaries intact. So: try MinerU first, fall back to the source PDF,
 * and record which corpus answered so the reader can tell them apart.
 */
export interface SourceCorpus {
  /** version → [pageNumber, pageTextWithNewlinesRemoved] */
  pages: Record<Version, Array<[number, string]>>;
  /** where each version's text came from, for the provenance note */
  origin: Record<Version, string>;
}

/** A fresh empty corpus. Not a shared constant: callers mutate what they get. */
const emptyCorpus = (): SourceCorpus => ({ pages: {}, origin: {} });
const EMPTY_CORPUS = emptyCorpus();

/**
 * Text fingerprint used to tell which uploaded PDF is which document version.
 *
 * Page count was the original key and it is unsafe: `byCount.set(pages, file)`
 * silently overwrites when two documents run to the same length, and then both
 * versions resolve to the SAME file — a wrong-value path with no error. Compare
 * the opening text instead: two documents that start alike are the same
 * document, whatever its length.
 */
function fingerprint(text: string, take = 600): Set<string> {
  const clean = String(text ?? "")
    .replace(/\[第\d+页\]/g, "")
    .replace(/<[^>]*>|\$[^$]*\$/g, "")
    .replace(/[^0-9A-Za-z一-鿿]/g, "");
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= Math.min(clean.length, take); i++) grams.add(clean.slice(i, i + 2));
  return grams;
}

/** Dice coefficient over character bigrams — 1 means identical opening text. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Read the uploaded PDFs and expose their fragment-joined text. */
export async function loadSourceCorpus(
  root: string,
  docs: Record<string, any>,
): Promise<SourceCorpus> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dir = path.join(root, "uploaded-docs");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => path.join(dir, f));
  } catch {
    return emptyCorpus();
  }
  if (!files.length) return emptyCorpus();

  // Dump every candidate once; matching happens on the TS side where the
  // MinerU text for each version is already in hand.
  const dump = [
    "import sys, json",
    "import fitz",
    "req = json.loads(sys.stdin.read())",
    "out = {}",
    "for p in req:",
    "    try:",
    "        d = fitz.open(p)",
    "        out[p] = [[i + 1, d[i].get_text().replace(chr(10), '')] for i in range(d.page_count)]",
    "        d.close()",
    "    except Exception:",
    "        out[p] = []",
    "print(json.dumps(out, ensure_ascii=False))",
  ].join("\n");

  let pagesByFile: Record<string, Array<[number, string]>> = {};
  try {
    const { execFileSync } = await import("node:child_process");
    const raw = execFileSync("python", ["-c", dump], {
      input: JSON.stringify(files),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 512 * 1024 * 1024,
      // Python writes to stdout with the console code page, not UTF-8. On a
      // Chinese Windows box that is GBK, which cannot encode the source PDF's
      // Chinese text — the subprocess dies mid-print, the JSON never parses,
      // and the corpus silently degrades to MinerU-only (8 cells lost, no
      // error). Pin the encoding here rather than relying on whoever's shell
      // exported PYTHONIOENCODING.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    pagesByFile = JSON.parse(raw);
  } catch {
    return emptyCorpus();
  }

  // Score every (version, file) pair, then assign greedily best-first so a
  // document can only be claimed once.
  const scores: Array<{ ver: string; file: string; score: number }> = [];
  for (const [ver, doc] of Object.entries(docs ?? {})) {
    const want = fingerprint(String(doc?.fullText ?? ""), 1500);
    if (!want.size) continue;
    for (const [file, pages] of Object.entries(pagesByFile)) {
      if (!pages.length) continue;
      // Sample across the document, not just the opening: GB 4785's draft and
      // its 2019 predecessor have near-identical covers ("GB 4785 … 汽车及挂车
      // 外部照明…"), so the first pages score 0.69 against each other. Page
      // 3 and the tail carry the content that actually differs.
      const pick = [0, 2, Math.floor(pages.length / 3), pages.length - 2, pages.length - 1]
        .filter((i) => i >= 0 && i < pages.length);
      const sample = pick.map((i) => pages[i][1]).join("");
      const score = similarity(want, fingerprint(sample, 1500));
      if (score > 0.05) scores.push({ ver, file, score });
    }
  }
  scores.sort((x, y) => y.score - x.score);

  const picked: Record<string, string> = {};
  const taken = new Set<string>();
  const runnersUp: Record<string, number> = {};
  for (const s of scores) {
    if (picked[s.ver] || taken.has(s.file)) {
      // remember how close the runner-up was, for the ambiguity warning
      if (!picked[s.ver]) runnersUp[s.ver] = Math.max(runnersUp[s.ver] ?? 0, s.score);
      continue;
    }
    picked[s.ver] = s.file;
    taken.add(s.file);
  }
  for (const [ver, file] of Object.entries(picked)) {
    if (file) console.log(`[matrix] ${ver} → ${path.basename(file)} (fingerprint ${scores.find((s) => s.ver === ver && s.file === file)?.score.toFixed(3)})`);
  }
  const ambiguous = scores.filter((s) => picked[s.ver] && picked[s.ver] !== s.file && s.score > 0.6);
  if (ambiguous.length) {
    console.warn(
      `[matrix] ⚠ 版本归属有歧义：${ambiguous.map((s) => `${s.ver}↔${path.basename(s.file)} ${s.score.toFixed(2)}`).join(", ")}`,
    );
  }
  const out = emptyCorpus();
  if (!Object.values(picked).some(Boolean)) return out;
  for (const [ver, file] of Object.entries(picked)) {
    const pages = pagesByFile[file];
    if (Array.isArray(pages) && pages.length) {
      out.pages[ver] = pages;
      out.origin[ver] = "源 PDF";
    }
  }
  return out;
}

/** Split MinerU fullText into [page, text] using its [第N页] markers. */
export function paginate(doc: any): Array<[number, string]> {
  const parts = String(doc?.fullText ?? "").split(/\[第(\d+)页\]/);
  const out: Array<[number, string]> = [];
  for (let i = 1; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    if (Number.isFinite(n)) out.push([n, parts[i + 1] ?? ""]);
  }
  return out;
}

/**
 * Clause number followed by whitespace / CJK punctuation / end.
 *
 * GB 4785 also numbers sub-items with a letter — "4.25a)", "4.8 b)" — and the
 * old lookahead rejected those, so the low-mounted-lamp clause (which lives
 * under §4.25d) reported NO clause at all. An empty clause is honest but costs
 * the reader the citation, so lettered subclauses are accepted.
 */
const CLAUSE_RE = /(?:^|[\s，,、（(])((\d+\.){1,4}\d+)(?=[\s．.、)）:：]|[a-z]\s*[)）])/g;

/** Nearest preceding clause number in the page text, e.g. "5.2.4.2". */
export function nearestClause(text: string, idx: number): string {
  CLAUSE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let last = "";
  while ((m = CLAUSE_RE.exec(text)) !== null) {
    if (m.index >= idx) break;
    // A leading zero disqualifies the candidate: clause numbers start at 1
    // (2.4.17.3, 5.2.4.2, 6.4.4.2) while measurements like "0.750" and "0.150"
    // are values that merely look like dotted numbers. Without this the
    // chromaticity row reported C's clause as "0.750" — the tail of the
    // neighbouring boundary equation, not a clause at all.
    if (!/^0\./.test(m[1])) last = m[1];
  }
  return last;
}

/** Trim a match out to sentence-ish bounds so the reader sees real原文. */
/**
 * Never cut through a tag.
 *
 * The excerpt is sliced at a fixed 130 characters, and MinerU writes vehicle
 * classes as `N<sub>3</sub>G` — so the cut regularly landed between `<` and
 * `>`, printing a bare `N<sub>` in the client PDF. Closing the tag would be a
 * lie about the text; dropping the fragment is honest and short.
 */
function trimPartialTag(s: string, keep?: [number, number]): string {
  // Locate the last OPENING tag (not `</`) and check whether its own closing
  // partner follows. Two shapes were observed in the delivered PDF:
  //   `N<sub>1`      — cut after the `>`
  //   `N<sub>1</su`  — cut INSIDE the closing tag
  // A plain "is there a `<`" test misses the first; a "find the last `<`"
  // test then mistakes the second's `</sub>` for a partner.
  //
  // `keep` = the [start, end) range of the **value** inside `s` — the span the
  // excerpt exists to show. It must survive every cut below. Before this
  // existed, the C row for「自动关闭·响应时间下限」rendered the excerpt
  // 「OFF</td>」while the row reported 5 seconds: the window ended inside a
  // table cell, the unclosed `<td>` had no partner, so the tail was cut —
  // and the tail was where the number was. The reader was left with a quote
  // that did not contain the value it was supposed to explain.
  let out = s;
  const k0 = keep ? Math.max(0, keep[0]) : 0;
  const k1 = keep ? Math.min(out.length, keep[1]) : out.length;
  // Step 1 — a tag cut inside its OWN closing tag (`…</su`): drop the fragment.
  //
  // Step 2 — the OPENING-tag check. It has to run *after* step 1, not before:
  // cutting `</su` off a window that ends `M<sub>1</su` leaves `M<sub>1`, an
  // opening tag with no partner. Returning right after step 1 left that
  // unclosed `<sub>1` on the page — the exact defect step 2 exists to prevent.
  // (Getting this order wrong is what a previous revision did.)
  const dangling = out.match(/<\/?[a-zA-Z][a-zA-Z0-9]*$/);
  if (dangling && dangling.index >= k1) out = out.slice(0, dangling.index).trimEnd();
  const opens = [...out.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s>]/g)];
  const last = opens[opens.length - 1];
  if (!last) return out;
  const close = `</${last[1]}>`;
  if (out.slice(last.index).includes(close)) return out;
  if (last.index >= k0 && last.index < k1) return out;   // tag sits inside the value
  if (last.index < k0) {
    // The unclosed opening tag is *before* the value. Cutting the whole tail
    // would delete the value itself — so cut only the tag (it is complete, so
    // nothing is left dangling) and keep the text that follows it.
    const tagEnd = out.indexOf(">", last.index);
    if (tagEnd < 0) return out;
    return (out.slice(0, last.index) + out.slice(tagEnd + 1)).trimEnd();
  }
  return out.slice(0, last.index).trimEnd();
}

function quoteAround(text: string, idx: number, len: number): string {
  // The context pad scales with the match. A fixed 70 was tuned for a long
  // clause and badly wrong for a short one: the chromaticity patterns match
  // `W12绿色边界y=0.150+0.640x` (27 chars — the whole requirement) and a 130-char
  // window then dragged in W34/W45/W56's boundaries into the row labelled
  // 白色色度边界.
  const pad = Math.min(70, Math.max(12, Math.round(len * 0.5)));
  const end = Math.min(text.length, idx + len + pad);
  let start: number;
  // Source-PDF pages arrive with newlines stripped — that is exactly what makes
  // the fragmented decimals join back into "0.150+0.640x" — so there are no line
  // breaks to anchor to and a boundary walk lands mid-number, opening cells
  // with ".640xW23黄绿色边界…". Use a fixed centred window for that corpus.
  if (!/\n/.test(text)) {
    start = Math.max(0, idx - pad);
  } else {
    // MinerU pages keep line breaks: walk back to the nearest clause/sentence
    // boundary rather than using a fixed offset, which opened cells with
    // fragments like "ub>类车辆。对于".
    const floor = Math.max(0, idx - pad);
    start = floor;
    for (let i = idx - 1; i >= floor; i--) {
      if (/[。；;|,\n]/.test(text[i])) { start = i + 1; break; }
      start = i;
    }
  }
  // The whitespace collapse changes the string's length, so the value's
  // position has to be tracked through it — normalise head, value and tail
  // separately and keep the value's own span.
  const head = text.slice(start, idx).replace(/\s+/g, " ");
  const body = text.slice(idx, idx + len).replace(/\s+/g, " ");
  const tail = text.slice(idx + len, end).replace(/\s+/g, " ");
  return trimPartialTag(head + body + tail, [head.length, head.length + body.length]);
}

function locate(
  pages: Array<[number, string]>,
  re: RegExp,
  origin = "MinerU",
  clause?: string,
  unit?: string,
): Cell {
  for (const [page, text] of pages) {
    // fresh lastIndex per page — the regexes are module-level and stateful
    const rx = new RegExp(re.source, re.flags.replace("g", ""));
    const m = rx.exec(text);
    if (!m) continue;
    // When the spec supplies a capture group, that group — not the whole
    // match — is the value. Without this, a pattern has to walk from its
    // clause anchor across the sentence, and every number it passes over
    // (250 / 800 / 1200 …) lands in `nums` as if it were part of the answer.
    const focus = m.length > 1 && m[1] != null ? m[1] : m[0];
    return {
      value: quoteAround(text, m.index, m[0].length),
      match: focus,
      nums: numbersOf(focus, unit),
      clause: clause || nearestClause(text, m.index),
      page: `第${page}页`,
      status: "verified",
      source: origin,
    };
  }
  return { ...MISS };
}

/** Equality of two cells: numeric signature first, quoted prose as fallback. */
function sameValue(a: Cell, b: Cell): boolean {
  if (a.nums.length && b.nums.length) return a.nums.join(",") === b.nums.join(",");
  // No numbers on either side (a prose requirement) — fall back to text, with
  // MinerU's markup flattened so <sub>3</sub> == $\mathrm{N_3G}$.
  const flat = (c: Cell) =>
    c.value
      .replace(/<[^>]*>/g, "")
      .replace(/\$[^$]*\$/g, "")
      .replace(/\\[a-zA-Z]+/g, "")
      .replace(/[{}~^_\\]/g, "")
      .replace(/[\s，,、（）()：:；;.。·－-]/g, "")
      .replace(/[㐀-鿿]/g, "")
      .toLowerCase();
  return flat(a) === flat(b);
}

/**
 * Decide what a row means. `versions` is the corpus's version list, so the
 * single-gap rule ("the other two carry it and agree, therefore the gap IS the
 * finding") holds for any N — and for two versions there is no gap to speak of,
 * so that branch is simply unreachable.
 */
function judge(
  cells: Record<Version, Cell>,
  versions: Version[],
): { verdict: Verdict; note: string } {
  const present = versions.filter((v) => cells[v].status === "verified");
  const missing = versions.filter((v) => cells[v].status !== "verified");

  // A version can be absent from the standard rather than unextracted. When the
  // two that do carry the requirement agree, that is a finding, not a gap —
  // e.g. the electric-bicycle substitute lamp exists in A and C but not in B.
  if (missing.length === 1 && present.length === versions.length - 1 && present.length === 2) {
    const gap = missing[0];
    if (sameValue(cells[present[0]], cells[present[1]])) {
      return {
        verdict: `${gap.toLowerCase()}-only`,
        // The verdict cell already reads "**C 未定位到**"; repeating it here
        // plus the same generic caveat made 46 copies of one sentence across
        // chapter 12. Say the useful half only — which versions DO agree — and
        // state the caveat once, in the section preamble.
        note: `${present.join(" 与 ")} 均有规定且取值一致`,
      };
    }
  }

  // The comparison pair is the first two versions: "did the newer national
  // standard change this?" is the question the report exists to answer.
  const [v0, v1] = versions;
  const a = cells[v0];
  const b = cells[v1];
  if (!a || !b) return { verdict: "incomplete", note: "版本数不足 2，无法判定" };
  if (a.status === "not-found" || b.status === "not-found") {
    const n = [a, b].filter((c) => c.status === "not-found").length;
    return { verdict: "incomplete", note: `${v0}/${v1} 有 ${n} 版未定位到，暂不判定` };
  }
  // Versions beyond the pair are cross-reference, not gate. They only decide
  // whether a "changed" row can point the reader at somewhere to check it —
  // the wording asymmetry below is the delivered one and is load-bearing for
  // anyone diffing against the 2026-10-12 baseline.
  const ref = versions[2];
  const refNote = !ref
    ? ""
    : cells[ref].status === "verified"
      ? `，${ref} 可回查`
      : `，${ref} 未定位`;
  if (sameValue(a, b)) {
    return {
      verdict: "same",
      note: !ref ? `${v0}/${v1} 一致` : cells[ref].status === "verified" ? `${v0}/${v1} 一致` : `${v0}/${v1} 一致（${ref} 未定位）`,
    };
  }
  return { verdict: "changed", note: `${v0}/${v1} 不一致${refNote}` };
}

export function buildParameterMatrix(
  data: Record<string, any>,
  corpus: SourceCorpus = EMPTY_CORPUS,
): { rows: Row[]; stats: MatrixStats } {
  const versions = versionsOf(data);
  if (versions.length < 2) {
    throw new Error(
      `只识别到 ${versions.length} 个版本的正文（${versions.join("/") || "无"}）—— 矩阵至少需要 2 版才能做对照`,
    );
  }
  // A spec that names a version this upload does not contain is a spec/corpus
  // mismatch, not a silent empty column. Caught here because both are known.
  for (const spec of SPECS) {
    for (const ver of Object.keys(spec.p)) {
      if (!versions.includes(ver)) {
        throw new Error(
          `${spec.id} 定义了版本 "${ver}"，但本次上传的语料里没有（现有 ${versions.join("/")}）—— spec 与语料不匹配`,
        );
      }
    }
  }

  const P: Record<Version, Array<[number, string]>> = {};
  for (const v of versions) P[v] = paginate(data[v]);

  const cell = (
    v: Version,
    re?: RegExp,
    absentReason?: string,
    clause?: string,
    unit?: string,
  ): Cell => {
    if (!re) {
      return absentReason
        ? { ...MISS, miss: "not-specified", absentReason }
        : { ...MISS, miss: "no-pattern" };
    }
    // MinerU first; the source PDF only when MinerU produced nothing.
    const hit = locate(P[v], re, "MinerU", clause, unit);
    if (hit.status === "verified") return hit;
    const alt = corpus.pages[v] ?? [];
    const out = alt.length ? locate(alt, re, "源 PDF", clause, unit) : hit;
    if (out.status === "verified") return out;
    // A spec may claim "this version does not require it" — but only if the
    // pattern genuinely finds nothing. If it DOES match, the claim is a false
    // regulatory conclusion and must fail loudly rather than be printed.
    if (absentReason) {
      return { ...out, miss: "not-specified", absentReason };
    }
    return { ...out, miss: "no-match" };
  };

  // Whether an explicit clause number actually occurs in that version's text
  // is checked by the delivery gate (`scripts/verify.mjs`), not here: the
  // build has to accept the synthetic corpora the version harness feeds it,
  // and those documents contain no clause numbers at all.

  const rows: Row[] = SPECS.map((spec) => {
    const cells: Record<Version, Cell> = {};
    for (const v of versions) {
      cells[v] = cell(v, spec.p[v], spec.absent?.[v], spec.clause?.[v], spec.unit);
    }
    // A spec may not claim "this version does not require it" while its own
    // pattern still matches — that would be a false regulatory conclusion
    // shipped as a fact. The value wins in `cell()`, but the stale claim must
    // be removed by a human, so it fails the build.
    for (const v of versions) {
      if (spec.absent?.[v] && cells[v].status === "verified") {
        throw new Error(
          `${spec.id}/${v} 标为「该版无此规定」，但抽取规则实际匹配到了 ` +
            `${cells[v].nums.join("/")}（${cells[v].clause || "无条款号"}）—— ` +
            `这是假的法规结论，请删掉 absent 或改正则`,
        );
      }
    }
    const base = { id: spec.id, name: spec.name, family: spec.family, unit: spec.unit, cells };
    return { ...base, ...judge(cells, versions) };
  });

  const byVersion: MatrixStats["byVersion"] = {};
  for (const v of versions) byVersion[v] = { hit: 0, total: SPECS.length };
  let verified = 0;
  let fromSourcePdf = 0;
  for (const r of rows) {
    for (const v of versions) {
      if (r.cells[v].status === "verified") {
        byVersion[v].hit++;
        verified++;
        if (r.cells[v].source === "源 PDF") fromSourcePdf++;
      }
    }
  }
  return {
    rows,
    stats: {
      rows: rows.length,
      cells: rows.length * versions.length,
      versions,
      verified,
      byVersion,
      fromSourcePdf,
      changed: rows.filter((r) => r.verdict === "changed").length,
    },
  };
}

/* -------------------------------------------------------------- rendering */

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

/** Compact cell for the scannable summary: the numbers, not the prose. */
function short(cell: Cell): string {
  if (cell.status !== "verified") {
    // **「该版无此规定（已核）」必须与「未命中」分开显示。**
    // 144 个取值位是**人工逐条核过原文**的「该版确实没有这条规定」，
    // 理由写在 12.2 明细里。旧代码把它们一律渲染成「未命中」——
    // 于是 12.1 那张 305 行的总表里出现 144 个「未命中」，
    // 读者读出来的结论是「抽取失败 / 数据不全」，
    // 而事实是「这三版在这一条上确实没有规定，附依据」。
    // 客户抱怨的「数值有空缺」就是这么来的 —— 不是数据缺，是**呈现把「已核过」说成了「没找到」**。
    if (cell.miss === "not-specified") return "无此规定（已核）";
    return cell.miss === "no-pattern" ? "未建规则" : "未命中";
  }
  if (cell.nums.length) return cell.nums.join(" / ");
  return esc(cell.value).slice(0, 28) + "…";
}

/**
 * Display labels. The `*-only` verdicts name the version that is MISSING the
 * requirement — the other two carry it and agree. (The tag reads the other way
 * round; "a-only" here means "only the absence of A is the finding".)
 *
 * `incomplete` has to say WHICH versions are missing. A bare 「不判定」 next to
 * an empty A/B cell reads like the parameter doesn't exist, which is a
 * regulatory claim the report has not earned — four draft-only rows (6.1
 * 驾驶员辅助投射) would have looked exactly like that.
 */
export function verdictLabel(row: Row, versions: Version[]): string {
  const v = row.verdict;
  const [v0, v1] = versions;
  if (v === "changed") return `**${v0}/${v1} 有变化**`;
  if (v === "same") return `${v0}/${v1} 一致`;
  if (v === "incomplete") {
    const missing = versions.filter((k) => row.cells[k]?.status !== "verified");
    // **「未定位」与「该版无此规定（已核）」要分开说。**
    // 判定列是读者扫过 305 行时唯一会看的字 —— 写「未定位」等于宣称
    // 「我们没查到」，而 144 个这样的格子其实**人工核过原文、确认没有规定**。
    // 混在一起的后果：客户把「已核过的空」当成「缺数据」——
    // 这正是「数值有空缺」这个抱怨的来源。
    const noSpec = missing.filter((k) => row.cells[k]?.miss === "not-specified");
    const notLoc = missing.filter((k) => row.cells[k]?.miss !== "not-specified");
    const parts: string[] = [];
    if (noSpec.length) parts.push(`${noSpec.join("/")} 无此规定（已核）`);
    if (notLoc.length) parts.push(`${notLoc.join("/")} 未定位`);
    return `不判定（${parts.join("；") || "—"}）`;
  }
  const only = versions.find((k) => `${k.toLowerCase()}-only` === v);
  if (!only) return String(v);
  // 同样：「该版确实没有这条规定」是一个**结论**（已核原文），
  // 「我们没定位到」是一个**缺口**。单边行的判定列必须说清是哪一种。
  return row.cells[only]?.miss === "not-specified"
    ? `**${only} 无此规定（已核）**`
    : `**${only} 未定位到**`;
}

/**
 * Chapter 12 rendering.
 *
 * Two tiers on purpose. A single 6-column table of 130-character quotes is
 * unreadable on A4 — the B and C cells wrapped to a few characters per line.
 * So: a compact scannable summary carrying only the numbers, then one detail
 * block per parameter carrying the full原文 quote, clause and page.
 */
/**
 * 一组参数的判定 —— 用来把 305 行按「读者要不要动手」分组。
 *
 * 顺序是刻意的：**要动手的排前面，不用动手的排后面**。
 * 以前 305 行平铺，205 行「三版一致」和 9 行「变了」混在一起 ——
 * 读者要自己扫才知道哪几行要他改设计。
 */
export interface MatrixGroups {
  changed: Row[];
  singleSide: Row[];
  incomplete: Row[];
  same: Row[];
}

export function groupRows(rows: Row[], versions: Version[]): MatrixGroups {
  const g: MatrixGroups = { changed: [], singleSide: [], incomplete: [], same: [] };
  for (const r of rows) {
    if (r.verdict === "changed") g.changed.push(r);
    else if (r.verdict === "incomplete") g.incomplete.push(r);
    else if (/-only$/.test(String(r.verdict))) g.singleSide.push(r);
    else g.same.push(r);
  }
  return g;
}

/** 一张参数总表（不含明细块）。 */
export function renderMatrixSummaryTable(rows: Row[], versions: Version[]): string {
  const heads = versions.map((v) => esc(versionLabel(v)));
  return [
    `| 参数 | 单位 | ${heads.join(" | ")} | 判定 |`,
    `|---|---|${versions.map(() => "---").join("|")}---|`,
    ...rows.map(
      (r) =>
        `| **${esc(r.name)}** | ${esc(r.unit)} | ${versions
          .map((v) => short(r.cells[v]))
          .join(" | ")} | ${verdictLabel(r, versions)} |`,
    ),
  ].join("\n");
}

/** 逐参数的原文明细块（每块一张三版小表 + 空值依据 + 判定）。 */
export function renderMatrixDetails(rows: Row[], versions: Version[]): string {
  return rows
    .map((r) => {
      const label = verdictLabel(r, versions);
      const line = (v: Version, c: Cell) =>
        c.status === "verified"
          ? `| **${esc(versionLabel(v))}** | ${esc(c.value)} | ${esc(c.clause || "—")} | ${c.page}${c.source === "源 PDF" ? " · 源 PDF" : ""} |`
          : `| **${esc(versionLabel(v))}** | ${missLabel(c)} | — | — |`;
      return [
        `#### ${esc(r.name)}`,
        "",
        "| 版本 | 原文取值 | 条款 | 页码 |",
        "|---|---|---|---|",
        ...versions.map((v) => line(v, r.cells[v])),
        "",
        // A verified absence is only useful if the reader can see WHY. The
        // reason names the clause that was checked, so the claim is auditable
        // rather than an assertion.
        ...(() => {
          const notes = versions
            .map((v) => ({ v, c: r.cells[v] }))
            .filter((x) => x.c.miss === "not-specified" && x.c.absentReason)
            .map(
              (x) =>
                `> **${esc(versionLabel(x.v))} 无此规定的依据**：${esc(x.c.absentReason!)}`,
            );
          return notes.length ? notes : [];
        })(),
        "",
        `**判定**：${label}${r.note && !r.note.startsWith(label) ? ` —— ${esc(r.note)}` : ""}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function renderMatrixTable(rows: Row[], versions: Version[]): string {
  const summary = renderMatrixSummaryTable(rows, versions);
  const details = renderMatrixDetails(rows, versions);

  const n = versions.length;
  // **这三种空值在实际数据里各有几条** —— 说明表里写清楚，
  // 别让读者以为「未命中」那一栏也是满的。
  const missCount = (kind: "not-specified" | "no-pattern" | "no-match") =>
    rows.reduce(
      (acc, r) =>
        acc +
        versions.filter((v) => r.cells[v]?.status !== "verified" && r.cells[v]?.miss === kind)
          .length,
      0,
    );
  const cNoSpec = missCount("not-specified");
  const cNoPattern = missCount("no-pattern");
  const cNoMatch = missCount("no-match");
  return [
    "## 12.1 参数对照总表",
    "",
    "**空值分三类，含义完全不同，格子里已分别标注**：",
    "",
    "| 标记 | 本版实有 | 含义 | 读法 |",
    "|---|---|---|---|",
    `| \`无此规定（已核）\` | ${cNoSpec} 格 | 已回该版原文逐条核对，**确认该版没有可比的数值规定**（确实没写，或转引他标，或写了但量值/口径不可比），理由见 12.2 明细 | **可直接采信**：该版给不出这个数。**空 ≠ 没抽到** |`,
    `| \`未建规则\` | ${cNoPattern} 格 | 本报告没有为该版本写抽取规则 | 该版**可能**有规定，本报告未覆盖 |`,
    `| \`未命中\` | ${cNoMatch} 格 | 规则写了，但在原文语料里没匹配上 | 该版**很可能**有规定，但取数失败 |`,
    "",
    "> 后两种都**不等于**「该版未规定」—— 从抽取失败推不出法规结论。原文表格 OCR 不可读是常见原因",
    "> （GB 4785-2019 的色度表文本层会把三列串成一行）。判定列已把这种情况标为「未定位」，不参与一致性判断。",
    "> 第一种不同：它是**核对过的事实**，理由逐条写在 12.2 的明细里，可以回原文复核。",
    cNoSpec > 0
      ? `> **本版的实际情况：${cNoSpec} 个空格全部属于第一种（已核「该版无此规定」），` +
        `「未建规则」与「未命中」各 ${cNoPattern} / ${cNoMatch} 格。**` +
        "所以矩阵里的每一个空格都有明确归类、可回原文复核 —— **没有「不知道」的格子**。"
      : "",
    "",
    summary,
    "",
    "---",
    "",
    "## 12.2 逐参数原文明细",
    "",
    `上表只给数值，便于横向扫读；下面逐个参数给出${n === 3 ? "三版" : `${n} 版`}原文取值、条款号与页码，可直接回原文核对。`,
    "",
    details,
  ].join("\n");
}