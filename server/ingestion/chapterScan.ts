/**
 * Chapter / section heading extractor.
 *
 * The three demo PDFs embed no usable TOC, so we recover the structure by
 * regex-scanning the page-tagged extracted text. Each heading carries a
 * stable "number" (1, 5, 5.5, 5.5.1, ...) that lets us compare structural
 * depth across A/B without trusting Chinese titles.
 *
 * Output is purely derived — no LLM, deterministic.
 */
export type HeadingLevel = "chapter" | "section" | "subsection" | "appendix";

export type ChapterHeading = {
  /** Level: 1-digit = chapter, 2-digit = section, 3-digit = subsection,
   *  "附录 X" / "Annex N" = appendix. */
  level: HeadingLevel;
  /** Normalised numeric ID: "5", "5.5", "5.5.1", "D", "1", ... */
  number: string;
  /** Original heading title, e.g. "主功能特殊规定" / "ADB 系统" */
  title: string;
  /** Page from the nearest preceding [第N页] marker. */
  page: string;
  /** Source document label (A / B / C). */
  label: string;
};

const RE_PAGE = /\[第(\d+)页\]/g;
const RE_CHAPTER = /^\s*(\d+)\s+([^\n]{2,40})\s*$/m; // "5  主功能特殊规定"
const RE_SECTION = /^\s*(\d+\.\d+)\s+([^\n]{2,60})\s*$/m; // "5.5  ADB 系统"
const RE_SUBSECTION = /^\s*(\d+\.\d+\.\d+)\s+([^\n]{2,80})\s*$/m; // "5.5.1  配备"
const RE_APPENDIX_CN = /^\s*附录\s*([A-Z\d]+)\s*([^\n]{0,60})\s*$/m; // "附录 D  ADB 测试"
const RE_APPENDIX_EN = /^\s*Annex\s*(\d+)\s*([^\n]{0,60})\s*$/im; // "Annex 4  ..."

/** Strip the [第N页] marker from a chunk so heading regex doesn't get fooled. */
function stripPages(text: string): string {
  return text.replace(RE_PAGE, "");
}

/** Chinese prose markers that suggest the matched text is NOT a heading
 *  (it would be content like "1 和 2：两只..." or "4.10 a)和 4.10 b)"). */
const PROSE_MARKERS = [
  "，", "。", "、", "（", ")", "≤", "≥", "＜", "＞", "—", "%", "/", "(", ")",
  ":", "：", ".", " ", "　", // also block Latin period + extra spaces
];

/** Common Chinese function verbs that signal body text rather than a title. */
const BODY_VERBS = ["应", "可", "不", "为", "由", "从", "向", "对", "与", "当", "在", "其", "或"];

/** Whitelist of "structural" chapter-level titles used in regulatory
 *  documents. Only headings whose title matches this set are considered
 *  top-level chapters — anything else with a 1-2 digit number is a
 *  sub-clause label (5.1 远光灯, 6.1 驾驶员辅助投射, ...). */
const STRUCTURAL_TITLES = new Set([
  "范围", "规范性引用文件", "术语和定义", "术语", "定义", "一般要求",
  "一般规定", "特殊规定", "主功能的特殊规定", "从属功能的特殊规定",
  "扩展功能的特殊规定", "检验规则", "同一型式判定", "同一型式判定及检验",
  "型式检验", "生产一致性检验", "实施日期", "过渡条款", "附录", "附件",
  "前言", "引言", "摘要",
]);

function isStructuralTitle(title: string): boolean {
  if (STRUCTURAL_TITLES.has(title)) return true;
  // Allow titles ending with these structural suffixes.
  for (const s of STRUCTURAL_TITLES) {
    if (title.endsWith(s) || title.startsWith(s)) return true;
  }
  return false;
}

/** Count CJK characters in a string. */
function cjkCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

/** True iff the candidate title looks like a real heading. The strict
 *  constraints are: short length, mostly CJK content, no prose markers
 *  (commas/periods), no function verbs that signal body text. */
function isHeadingLike(title: string): boolean {
  if (!title) return false;
  // Real headings are short: ≤ 25 chars total, ≥ 2 CJK chars, ≥ 60% CJK.
  if (title.length > 25) return false;
  const cjk = cjkCount(title);
  if (cjk < 2) return false;
  if (cjk / title.length < 0.6) return false;
  // No comma / period / colon — those are body text markers.
  for (const m of PROSE_MARKERS) {
    if (title.includes(m)) return false;
  }
  // No function verbs (应/可/不/在/其 etc) — body text starts with these.
  for (const v of BODY_VERBS) {
    if (title.includes(v)) return false;
  }
  // First char must be Chinese or letter (not digit, not punctuation).
  const c = title.charCodeAt(0);
  const isCjk = c >= 0x4e00 && c <= 0x9fff;
  const isLetter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
  return isCjk || isLetter;
}

/** Walk the text page-by-page (our extractor inserts [第N页] markers). */
export function scanHeadings(label: string, text: string): ChapterHeading[] {
  const out: ChapterHeading[] = [];
  let currentPage = "";
  const lines = text.split("\n");

  for (const line of lines) {
    const pageMatch = line.match(/^\[第(\d+)页\]/);
    if (pageMatch) {
      currentPage = `第${pageMatch[1]}页`;
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    let m: RegExpMatchArray | null;
    if ((m = trimmed.match(/^附录\s*([A-Z\d]+)\s*(\S.{0,40})$/))) {
      if (isHeadingLike(m[2])) {
        out.push({ level: "appendix", number: m[1], title: m[2].trim(), page: currentPage, label });
      }
      continue;
    }
    if ((m = trimmed.match(/^Annex\s*(\d+)\s*(\S.{0,60})$/i))) {
      if (isHeadingLike(m[2])) {
        out.push({ level: "appendix", number: m[1], title: m[2].trim(), page: currentPage, label });
      }
      continue;
    }
    if ((m = trimmed.match(/^(\d+\.\d+\.\d+)\s+(\S.{1,60})$/))) {
      if (isHeadingLike(m[2])) {
        out.push({ level: "subsection", number: m[1], title: m[2].trim(), page: currentPage, label });
      }
      continue;
    }
    if ((m = trimmed.match(/^(\d+\.\d+)\s+(\S.{1,40})$/))) {
      if (isHeadingLike(m[2])) {
        out.push({ level: "section", number: m[1], title: m[2].trim(), page: currentPage, label });
      }
      continue;
    }
    if ((m = trimmed.match(/^(\d+)\s+(\S.{1,30})$/))) {
      if (m[1].length > 2) continue;
      if (isHeadingLike(m[2]) && isStructuralTitle(m[2].trim())) {
        out.push({ level: "chapter", number: m[1], title: m[2].trim(), page: currentPage, label });
      }
      continue;
    }
  }

  return dedupe(out);
}

function dedupe(heads: ChapterHeading[]): ChapterHeading[] {
  const seen = new Map<string, ChapterHeading>();
  for (const h of heads) {
    const key = `${h.label}:${h.level}:${h.number}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, h);
    } else if (h.title.length > existing.title.length) {
      // prefer longer title (more specific)
      seen.set(key, h);
    }
  }
  return Array.from(seen.values());
}

/**
 * Diff the heading sets between A (草案) and B (现行).
 * Returns:
 *   - addedChapters: 章节/子章节/附录 在 A 存在但在 B 不存在 → 结构性新增
 *   - removedChapters: 在 B 存在但在 A 不存在 → 结构性删除
 *   - matchedChapters: A 和 B 都有的（即使标题略有不同）
 *
 * Match logic: numeric ID prefix match (5 ↔ 5, 5.5 ↔ 5.5, 5.5.1 ↔ 5.5.1).
 * C is reference only — its headings are not used for add/remove decisions
 * but are passed through as anchor context.
 *
 * Note: only chapter- and section-level headings contribute to the add/
 * remove list. Subsection-level differences are too granular (200+ false
 * positives from renumbering) and are surfaced only in the appendix.
 */
export type ChapterDiff = {
  addedChapters: Array<{ a: ChapterHeading; matchedInC?: ChapterHeading }>;
  removedChapters: Array<{ b: ChapterHeading; matchedInC?: ChapterHeading }>;
  matchedChapters: Array<{ a: ChapterHeading; b: ChapterHeading }>;
  /** Subsection-level mismatches — kept for the appendix, NOT promoted
   *  into 11.1 / 11.2 (would explode the section). */
  subsectionOnlyMismatches: Array<{ a: ChapterHeading; b?: ChapterHeading }>;
};

export function diffChapters(
  aHeads: ChapterHeading[],
  bHeads: ChapterHeading[],
  cHeads?: ChapterHeading[],
): ChapterDiff {
  // Build maps for chapter/section level only.
  const aCoarse = aHeads.filter((h) => h.level === "chapter" || h.level === "section" || h.level === "appendix");
  const bCoarse = bHeads.filter((h) => h.level === "chapter" || h.level === "section" || h.level === "appendix");
  const bByNum = new Map(bCoarse.map((h) => [numberKey(h), h]));
  const aByNum = new Map(aCoarse.map((h) => [numberKey(h), h]));
  const cByNum = cHeads ? new Map(cHeads.map((h) => [numberKey(h), h])) : new Map<string, ChapterHeading>();

  const added: ChapterDiff["addedChapters"] = [];
  const removed: ChapterDiff["removedChapters"] = [];
  const matched: ChapterDiff["matchedChapters"] = [];

  for (const a of aCoarse) {
    const k = numberKey(a);
    const b = bByNum.get(k);
    if (b) {
      matched.push({ a, b });
    } else {
      added.push({ a, matchedInC: cByNum.get(k) });
    }
  }
  for (const b of bCoarse) {
    const k = numberKey(b);
    if (!aByNum.has(k)) {
      removed.push({ b, matchedInC: cByNum.get(k) });
    }
  }

  // Subsection mismatches (informational only) — A has a subsection like
  // "5.1.1" but B doesn't, OR B's matching subsection has a different parent.
  const aSub = aHeads.filter((h) => h.level === "subsection");
  const bSubs = bHeads.filter((h) => h.level === "subsection");
  const subsectionOnlyMismatches: ChapterDiff["subsectionOnlyMismatches"] = [];
  for (const a of aSub) {
    // We just need a sample of A's subsection count that B doesn't carry
    // under the same numberKey. Don't include them in the main add list.
    if (!bSubs.find((b) => numberKey(b) === numberKey(a))) {
      subsectionOnlyMismatches.push({ a });
    }
  }
  // Cap to a reasonable count for the appendix (avoid 200-row tables).
  subsectionOnlyMismatches.length = Math.min(subsectionOnlyMismatches.length, 50);

  return { addedChapters: added, removedChapters: removed, matchedChapters: matched, subsectionOnlyMismatches };
}

/** Normalise the numeric key for matching. "5" / "5.0" / "5" all collapse
 *  to "5" so chapter-level A5 ↔ B5 lines up regardless of sub-section
 *  numbering differences. */
function numberKey(h: ChapterHeading): string {
  if (h.level === "appendix") return `appendix:${h.number}`;
  // Trim trailing .0 if present, keep dot-separated hierarchy.
  const parts = h.number.split(".").filter((p) => p !== "0" && p !== "");
  return parts.join(".");
}