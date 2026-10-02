/**
 * Chapter-level diff — bridges the gap that structuredExtract alone can't
 * see: "A has this WHOLE chapter / appendix that B doesn't" (ADB 系统、
 * 矩阵式 LED、Logo 投影灯、迎宾灯、智能照明综合章、附录 D / E 等).
 *
 * Pure derived data — no LLM. Inputs come from chapterScan.ts which scans
 * the page-tagged extracted text for X.Y / X.Y.Z / 附录 X / Annex N
 * headings.
 */
import {
  diffChapters,
  type ChapterDiff,
  type ChapterHeading,
} from "../ingestion/chapterScan";

export type ChapterChange = {
  /** Number key as displayed in the report (e.g. "6", "5.5", "D"). */
  number: string;
  /** Level for the table render. */
  level: "chapter" | "section" | "subsection" | "appendix";
  /** Title in the source document that has the chapter. */
  title: string;
  /** Page reference in the source document. */
  page: string;
  /** Optional C-side match for context (always anchor only). */
  cTitle?: string;
  cPage?: string;
};

/**
 * Combine chapter-level diff + structured topic diff into a single list of
 * "structural" changes that go into 11.1 / 11.2 of the report. Pure
 * derived — never reaches for the LLM.
 */
export function buildChapterChanges(diff: ChapterDiff): {
  added: ChapterChange[];
  removed: ChapterChange[];
} {
  const added: ChapterChange[] = diff.addedChapters.map((c) => ({
    number: numberOf(c.a),
    level: c.a.level,
    title: c.a.title,
    page: c.a.page,
    cTitle: c.matchedInC?.title,
    cPage: c.matchedInC?.page,
  }));
  const removed: ChapterChange[] = diff.removedChapters.map((c) => ({
    number: numberOf(c.b),
    level: c.b.level,
    title: c.b.title,
    page: c.b.page,
    cTitle: c.matchedInC?.title,
    cPage: c.matchedInC?.page,
  }));
  return { added, removed };
}

function numberOf(h: ChapterHeading): string {
  return h.level === "appendix" ? (h.number.startsWith("A") ? h.number : `${h.number}`) : h.number;
}

/** Heuristic classifier — is this heading a NEW DEVICE CLASS
 *  (e.g. ADB 系统 / 矩阵式 LED) or just a structural re-org? */
const NEW_DEVICE_MARKERS = [
  "ADB",
  "自适应远光",
  "矩阵式",
  "Matrix",
  "LED",
  "像素",
  "降级",
  "失效模式",
  "Logo",
  "投影",
  "迎宾",
  "发光徽标",
  "图文交互",
  "驾驶员辅助投射",
  "光信号投射",
  "ADS",
  "自动化驾驶",
  "智能照明",
  "外部状态指示器",
  "外部氛围",
  "数字化认证",
  "网络安全",
  "远程诊断",
];

export function isNewDevice(c: ChapterChange): boolean {
  if (c.level !== "section" && c.level !== "subsection" && c.level !== "appendix") {
    // Chapters like "第 12 章 智能照明" count as device-class too.
    return NEW_DEVICE_MARKERS.some((m) => c.title.includes(m));
  }
  return NEW_DEVICE_MARKERS.some((m) => c.title.includes(m));
}