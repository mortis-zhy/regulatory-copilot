/**
 * Detect chapter-level structural changes between A 草案 and B 现行.
 *
 * Why this exists separately from chapterScan.ts: chapterScan tries to
 * pull every numbered heading from the body text (which is unreliable for
 * PDFs without embedded TOCs). chapterStructural.ts is the focused, narrow
 * detector for THE structural reorganisation of GB 4785:
 *
 *   A 草案 splits B's flat "5 特殊规定" (B.5.1..5.26) into three layers
 *   (主/从属/扩展) plus two new standalone chapters (同一型式判定,
 *   实施日期分阶段). This module reports exactly that restructuring —
 *   nothing else, no false positives.
 *
 * Pure derived data — no LLM, no regex on body prose.
 */
export type StructuralChapterChange = {
  number: string;
  level: "chapter";
  title: string;
  /** Which document this lives in: "A" only, "B" only, or "both". */
  source: "A-only" | "B-only" | "both";
  /** Page reference from the document that carries it. */
  page: string;
};

/**
 * Structural chapter catalogue. The three categories matter for 11.1:
 * - "new"          : A has this chapter, B has nothing at all here
 * - "renumbered"   : both have it but with different clause numbers
 * - "renamed"      : both have it under the same clause number but
 *                    different title (A renames B's flat "特殊规定"
 *                    to "主功能的特殊规定" — same chapter, new name)
 *
 * Only `new` and `removed` flow into 11.1 / 11.2 as structural changes.
 * `renumbered` / `renamed` flow into 11.6 修订重点章节对比 as
 * "chapter-level structural reorganisations".
 */
type StructuralChapter = {
  category: "new" | "removed" | "renumbered" | "renamed";
  aNumber?: string;
  aTitle?: string;
  aPage?: string;
  bNumber?: string;
  bTitle?: string;
  bPage?: string;
  /** Display label for renumbered/renamed. */
  display?: string;
};

const STRUCTURAL_CHAPTERS: StructuralChapter[] = [
  // PAGE CONVENTION: all pages are PHYSICAL PDF pages (what a PDF viewer
  // shows), machine-verified against the original PDFs with PyMuPDF by
  // audit_pages.py. The documents' printed/TOC page numbers are exactly
  // physical − 4. NEVER hand-copy page numbers from a table of contents.
  // A renames B's flat "5 特殊规定" → "5 主功能的特殊规定" (same chapter, new name).
  {
    category: "renamed",
    aNumber: "5", aTitle: "主功能的特殊规定", aPage: "第23页",
    bNumber: "5", bTitle: "特殊规定", bPage: "第22页",
    display: "B 的『特殊规定』改为 A 的『主功能的特殊规定』",
  },
  // NEW: A splits B's flat 5 into three layers (5/6/7).
  { category: "new", aNumber: "6", aTitle: "从属功能的特殊规定", aPage: "第64页" },
  { category: "new", aNumber: "7", aTitle: "扩展功能的特殊规定", aPage: "第68页" },
  // RENUMBERED: both have 检验规则 but A renumbers 6→8.
  {
    category: "renumbered",
    aNumber: "8", aTitle: "检验规则", aPage: "第71页",
    bNumber: "6", bTitle: "检验规则", bPage: "第58页",
    display: "B 第 6 章『检验规则』改为 A 第 8 章『检验规则』",
  },
  // RENUMBERED (NOT new): B has 6.1 同一型式判定及检验; A splits it into a
  // standalone chapter 9. This is a SPLIT, not a brand-new chapter.
  {
    category: "renumbered",
    aNumber: "9", aTitle: "同一型式判定", aPage: "第72页",
    bNumber: "6.1", bTitle: "同一型式判定及检验", bPage: "第58页",
    display: "B 第 6.1 节『同一型式判定及检验』拆分为 A 第 9 章『同一型式判定』独立成章",
  },
  // RENUMBERED: 实施日期 B7 → A10.
  {
    category: "renumbered",
    aNumber: "10", aTitle: "实施日期", aPage: "第72页",
    bNumber: "7", bTitle: "实施日期", bPage: "第59页",
    display: "B 第 7 章『实施日期』改为 A 第 10 章『实施日期』",
  },
];

/**
 * 装置级编号重排（B 5.x → A 5.x/7.x）——A 把 B 的平铺 5.1-5.26 重新排序，
 * 拆入主功能/从属功能/扩展功能三层。每一条都是「编号变，实质内容不变」。
 * 单独成表，避免和「章节级重排」混在一起。
 *
 * 页码约定：全部为**物理 PDF 页码**（阅读器显示的页码），由 audit_pages.py
 * 用 PyMuPDF 回原始 PDF 逐条核验；目录印刷页码 = 物理页 − 4。禁止手抄目录页码。
 * 本表 11 行与两份原文目录 diff 的编号变化完全一致（audit_pages.py 完整性校验）。
 */
export const DEVICE_RENUMBERING: Array<{
  name: string;
  bNumber: string;
  aNumber: string;
  bPage: string;
  aPage: string;
}> = [
  { name: "前雾灯", bNumber: "5.3", aNumber: "5.4", bPage: "第27页", aPage: "第35页" },
  { name: "倒车灯", bNumber: "5.4", aNumber: "5.21", bPage: "第29页", aPage: "第57页" },
  { name: "转向信号灯", bNumber: "5.5", aNumber: "5.6", bPage: "第30页", aPage: "第37页" },
  { name: "危险警告信号", bNumber: "5.6", aNumber: "7.1", bPage: "第33页", aPage: "第68页" },
  { name: "醒目标志", bNumber: "5.21", aNumber: "5.20", bPage: "第49页", aPage: "第57页" },
  { name: "角灯", bNumber: "5.20", aNumber: "5.5", bPage: "第48页", aPage: "第36页" },
  { name: "自适应前照明系统 (AFS)", bNumber: "5.22", aNumber: "5.3", bPage: "第49页", aPage: "第29页" },
  { name: "紧急制动信号", bNumber: "5.23", aNumber: "7.2", bPage: "第54页", aPage: "第69页" },
  { name: "牵引杆挂车标志灯", bNumber: "5.24", aNumber: "5.23", bPage: "第55页", aPage: "第60页" },
  { name: "慢行灯", bNumber: "5.25", aNumber: "5.22", bPage: "第56页", aPage: "第59页" },
  { name: "追尾警告信号", bNumber: "5.26", aNumber: "7.3", bPage: "第57页", aPage: "第70页" },
];

export function detectStructuralChapters(): {
  added: StructuralChapterChange[];
  removed: StructuralChapterChange[];
  renumbered: Array<{ display: string; aNumber: string; bNumber: string; aPage?: string; bPage?: string }>;
} {
  const added: StructuralChapterChange[] = [];
  const removed: StructuralChapterChange[] = [];
  const renumbered: Array<{ display: string; aNumber: string; bNumber: string; aPage?: string; bPage?: string }> = [];

  for (const c of STRUCTURAL_CHAPTERS) {
    if (c.category === "new" && c.aTitle) {
      added.push({ number: c.aNumber!, level: "chapter", title: c.aTitle, source: "A-only", page: c.aPage ?? "—" });
    } else if (c.category === "removed" && c.bTitle) {
      removed.push({ number: c.bNumber!, level: "chapter", title: c.bTitle, source: "B-only", page: c.bPage ?? "—" });
    } else if (c.category === "renumbered" && c.display && c.aNumber && c.bNumber) {
      renumbered.push({ display: c.display, aNumber: c.aNumber, bNumber: c.bNumber, aPage: c.aPage, bPage: c.bPage });
    }
    // renamed — skip (same chapter, different label; not an addition)
  }

  return { added, removed, renumbered };
}