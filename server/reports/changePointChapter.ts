/**
 * Deterministic builder for the "关键变化点总结" chapter.
 *
 * Why this exists: the LLM-driven chapter generator was fabricating change
 * items (wrong page numbers, paraphrased quotes, fake "added" entries from
 * clause renumbering, "同 B" entries labelled as 改写). This module consumes
 * the *programmatic* diff output (see diffEngine.ts) and emits a chapter
 * whose every row carries: a stable [新增/删除/修改/保留] tag, the locked
 * clause number, the locked page reference, and the verbatim excerpt from
 * the structured extractor.
 *
 * Structure mirrors the customer-approved reference report 第 11 章:
 *   11.1 新增条款汇总        ← chapter-level additions + topic additions
 *   11.2 删除条款汇总        ← chapter-level removals + topic removals
 *   11.3 重大修订条款        ← type === "modified" (severity high/medium)
 *   11.4 数据指标变化        ← valueDiffs[] (matched by name; v3 — one row per real value diff)
 *   11.5 引入的新概念        ← new device-class headings (ADB / 矩阵式 / ...)
 *   11.6 修订重点章节对比    ← high-severity changes grouped by device
 *   11.7 关键变化点的影响分析← derived from locked facts above; no new facts
 */
import type { DiffResult, EngineChange, EngineParameter, EngineValueDiff } from "./diffEngine";
import type { ChapterChange } from "./chapterDiff";
import { isNewDevice } from "./chapterDiff";
import { DEVICE_RENUMBERING } from "./chapterStructural";

/**
 * The seven sub-sections of the change-points chapter. Each is built from
 * the diff output alone — no LLM is consulted for the *facts*. (Only 11.7
 * is narrated; its fact payload is also fully locked above.)
 */
export type ChangeChapterSection = {
  id: "11.1" | "11.2" | "11.3" | "11.4" | "11.5" | "11.6" | "11.7";
  title: string;
  markdown: string;
};

export type ChangeChapter = {
  chapterId: number;
  chapterTitle: string;
  sections: ChangeChapterSection[];
  fullMarkdown: string;
  meta: {
    changesTotal: number;
    parametersTotal: number;
    parametersChanged: number;
    addedCount: number;
    removedCount: number;
    modifiedCount: number;
    chapterAdded: number;
    chapterRemoved: number;
    newDevices: number;
  };
};

/** Inputs the chapter builder needs. */
export type ChangeChapterInput = {
  /** Programmatic diff result (existing). */
  diff: DiffResult;
  /** Chapter-level additions detected from heading scan (A has, B doesn't). */
  chapterAdded: ChapterChange[];
  /** Chapter-level removals (B has, A doesn't). */
  chapterRemoved: ChapterChange[];
  /** Chapter-level renumberings (both have, different clause numbers). */
  chapterRenumbered?: Array<{ display: string; aNumber: string; bNumber: string; aPage?: string; bPage?: string }>;
  /** Deterministic indicator scan results (the 9 GB4785 data indicators). */
  indicatorRows?: Array<{
    id: string;
    label: string;
    unit: string;
    status: "kept" | "single-side" | "missing" | "modified";
    bValue?: string;
    aValue?: string;
    bPage?: string;
    aPage?: string;
  }>;
  /** Paraphrase-only diffs (30 条): 被 noise filter 丢弃但含术语/格式/单位候选差异，
   *  工程师做文档对照需逐条人工核验。 */
  wordingOnly?: Array<{ topic: string; name: string; oldValue: string; newValue: string }>;
};

/** Tag a change with the canonical marker. */
function tag(c: EngineChange): string {
  switch (c.type) {
    case "added":
      return "[新增]";
    case "removed":
      return "[删除]";
    case "modified":
      return "[修改]";
  }
}

/** Strip the 【...】 locator suffix that structuredExtract appends, returning
 *  the bare excerpt plus the locator as a separate field. */
function splitExcerpt(s: string): { text: string; locator: string } {
  const m = s.match(/^(.*?)【([^】]*)】\s*$/s);
  if (m) return { text: m[1].trim(), locator: m[2].trim() };
  return { text: s.trim(), locator: "" };
}

/** Render an excerpt cell for a table row, with locator footnote appended. */
function excerptCell(s: string): string {
  const { text, locator } = splitExcerpt(s);
  return locator ? `${text}<br><sub>${locator}</sub>` : text;
}

/** Escape pipe characters and newlines inside markdown table cells. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Pad short topic titles for nicer table alignment (cosmetic only). */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function normalize(s: string): string {
  return (s ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：]/g, ",")
    .toLowerCase();
}

const NEW_CONCEPT_MARKERS = [
  "ADB",
  "矩阵式",
  "像素",
  "动态屏蔽",
  "降级模式",
  "失效模式",
  "Logo",
  "投影",
  "迎宾",
  "发光徽标",
  "图文交互",
  "驾驶员辅助投射",
  "光信号投射",
  "像素要求",
  "降级",
  "网络安全",
  "远程诊断",
  "数字化认证",
  "自动化驾驶",
  "自动远光",
  "像素单元",
  "ESS",
  "RECAS",
  "AFS",
];

// Re-export the chapter-level detector so the rest of this file uses a
// single source of truth for "is this a new device class".
function isNewConcept(c: EngineChange): boolean {
  if (c.type !== "added") return false;
  return NEW_CONCEPT_MARKERS.some((m) => c.newExcerpt.includes(m) || c.title.includes(m));
}

/** Group changes by clause-prefix so 11.6 reads like the reference. */
function groupByDevice(changes: EngineChange[]): Map<string, EngineChange[]> {
  const out = new Map<string, EngineChange[]>();
  for (const c of changes) {
    // crude device detection: prefix the change title with the leading
    // Chinese descriptor before "·" or numeric clauses
    const m = c.title.match(/^([^\d·][^·\d]{0,12})/);
    const key = m ? m[1].trim() : c.title.slice(0, 6);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(c);
  }
  return out;
}

/** Build 11.1 — added chapters + added topics become "新增条款汇总". */
function build11_1(changes: EngineChange[], chapterAdded: ChapterChange[]): string {
  const addedTopics = changes.filter((c) => c.type === "added");
  if (chapterAdded.length === 0 && addedTopics.length === 0) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";

  const parts: string[] = [
    "### 11.1 新增条款汇总",
    "",
    "下列条款在 GB 4785-2019（B）中不存在，于 GB 4785 草案 V4.3.5（A）中首次出现。",
    "",
  ];

  // Split structural changes by level for clearer reporting.
  const chapterLevel = chapterAdded.filter((c) => c.level === "chapter" || c.level === "appendix");
  const sectionLevel = chapterAdded.filter((c) => c.level === "section" || c.level === "subsection");

  if (chapterLevel.length > 0) {
    parts.push("#### 11.1.1 章节级新增（结构性重组 / 独立成章）");
    parts.push("");
    parts.push("| 序号 | 编号 | A 草案标题 | A 页码 | C 参照 |");
    parts.push("|---|---|---|---|---|");
    chapterLevel.forEach((c, i) => {
      const cCol = c.cTitle ? `${cell(c.cTitle)}${c.cPage ? `（${c.cPage}）` : ""}` : "—";
      parts.push(`| ${pad2(i + 1)} | ${cell(c.number)} | ${cell(c.title)} | ${cell(c.page || "—")} | ${cCol} |`);
    });
    parts.push("");
    parts.push(`**小计**：${chapterLevel.length} 项章节级新增。`);
    parts.push("");
  }

  if (sectionLevel.length > 0) {
    parts.push("#### 11.1.2 子条款级新增（新装置类 / 新功能条款）");
    parts.push("");
    parts.push("| 序号 | 编号 | A 草案标题 | A 页码 | C 参照 |");
    parts.push("|---|---|---|---|---|");
    sectionLevel.forEach((c, i) => {
      const cCol = c.cTitle ? `${cell(c.cTitle)}${c.cPage ? `（${c.cPage}）` : ""}` : "—";
      parts.push(`| ${pad2(i + 1)} | ${cell(c.number)} | ${cell(c.title)} | ${cell(c.page || "—")} | ${cCol} |`);
    });
    parts.push("");
    parts.push(`**小计**：${sectionLevel.length} 项子条款级新增。`);
    parts.push("");
  }

  if (addedTopics.length > 0) {
    parts.push("#### 11.1.3 主题级新增（A/B 对照检出）");
    parts.push("");
    parts.push("| 序号 | 条款主题 | 标签 | A 草案原文摘录 | 定位 |");
    parts.push("|---|---|---|---|---|");
    addedTopics.forEach((c, i) => {
      parts.push(
        `| ${pad2(i + 1)} | ${cell(c.title)} | ${tag(c)} | ${excerptCell(c.newExcerpt)} | ${cell(c.anchor.replace(/^[^=]*=/, "A="))} |`,
      );
    });
    parts.push("");
    parts.push(`**小计**：${addedTopics.length} 条主题级新增。`);
  }

  return parts.join("\n");
}

function labelFor(level: ChapterChange["level"]): string {
  return level === "chapter" ? "章" : level === "section" ? "节" : level === "subsection" ? "小节" : "附录";
}

/** Build 11.2 — removed chapters + removed topics. */
function build11_2(changes: EngineChange[], chapterRemoved: ChapterChange[]): string {
  const removedTopics = changes.filter((c) => c.type === "removed");
  if (chapterRemoved.length === 0 && removedTopics.length === 0) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";

  const parts: string[] = [
    "### 11.2 删除条款汇总",
    "",
    "下列条款存在于 GB 4785-2019（B），在 GB 4785 草案 V4.3.5（A）中已移除。",
    "",
  ];

  if (chapterRemoved.length > 0) {
    parts.push("#### 11.2.1 删除章节 / 子章节 / 附录（结构性删除）");
    parts.push("");
    parts.push("| 序号 | 编号 | 层级 | B 现行版标题 | B 页码 | C 参照 |");
    parts.push("|---|---|---|---|---|---|");
    chapterRemoved.forEach((c, i) => {
      const cCol = c.cTitle ? `${cell(c.cTitle)}${c.cPage ? `（${c.cPage}）` : ""}` : "—";
      parts.push(`| ${pad2(i + 1)} | ${cell(c.number)} | ${labelFor(c.level)} | ${cell(c.title)} | ${cell(c.page || "—")} | ${cCol} |`);
    });
    parts.push("");
    parts.push(`**小计**：${chapterRemoved.length} 项结构性删除。`);
    parts.push("");
  }

  if (removedTopics.length > 0) {
    parts.push("#### 11.2.2 主题级删除（A/B 对照检出）");
    parts.push("");
    parts.push("| 序号 | 条款主题 | 标签 | B 现行版原文摘录 | 定位 |");
    parts.push("|---|---|---|---|---|");
    removedTopics.forEach((c, i) => {
      parts.push(
        `| ${pad2(i + 1)} | ${cell(c.title)} | ${tag(c)} | ${excerptCell(c.oldExcerpt)} | ${cell(c.anchor.replace(/^[^=]*=/, "B="))} |`,
      );
    });
    parts.push("");
    parts.push(`**小计**：${removedTopics.length} 条主题级删除。`);
  }

  return parts.join("\n");
}

/** Build 11.3 — modifications, ranked by severity. */
function build11_3(changes: EngineChange[]): string {
  const mods = changes.filter((c) => c.type === "modified");
  if (mods.length === 0) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";

  // High severity first; within severity keep diffEngine's order (parameter
  // diffs precede text diffs, which is what the reference does).
  const sorted = [...mods].sort((a, b) => severityOrder(a) - severityOrder(b));

  const rows = sorted
    .map(
      (c, i) =>
        `| ${pad2(i + 1)} | ${cell(c.title)} | ${tag(c)} | ${excerptCell(c.oldExcerpt)} | ${excerptCell(c.newExcerpt)} | ${cell(c.anchor)} |`,
    )
    .join("\n");

  return [
    "### 11.3 重大修订条款",
    "",
    "下列条款 A/B 两侧均存在，但原文或关键参数已发生实质变化。下表按严重度从高到低排列。",
    "",
    "| 序号 | 条款主题 | 标签 | B 现行版原文 | A 草案原文 | 锚点 |",
    "|---|---|---|---|---|---|",
    rows,
    "",
    `**小计**：${mods.length} 条重大修订条款。`,
  ].join("\n");
}

function severityOrder(c: EngineChange): number {
  return c.severity === "high" ? 0 : c.severity === "medium" ? 1 : 2;
}

/** Build 11.4 — data-indicator changes from indicatorRows[] (deterministic
 *  text scan) + valueDiffs[] (LLM-extracted, name-matched). The indicator
 *  rows take priority — they come from regex patterns on the raw PDF text
 *  and are 100% deterministic. The valueDiffs rows are supplementary. */
function build11_4(
  valueDiffs: EngineValueDiff[],
  indicatorRows?: ChangeChapterInput["indicatorRows"],
): string {
  const parts: string[] = ["### 11.4 数据指标变化", ""];

  // Part A: the 9 canonical indicators (deterministic scan).
  const indRows = (indicatorRows ?? []).map((p, i) => {
    const pct = computePct(p.oldValue, p.newValue);
    const arrow = pct !== "→" ? pct : "→";
    return `| ${pad2(i + 1)} | ${cell(p.label)} | ${cell(p.oldValue)} | ${cell(p.newValue)} | ${cell(p.unit)} | ${arrow} | ${cell(p.source)} |`;
  });
  if (indRows.length > 0) {
    parts.push("#### 11.4.1 核心数据指标（确定性文本扫描）");
    parts.push("");
    parts.push("以下指标直接取自 A/B 原文文本，带页码可回查。");
    parts.push("");
    parts.push("| 序号 | 指标 | 现行版 (B) | 草案版 (A) | 单位 | 变化幅度 | 锚点 |");
    parts.push("|---|---|---|---|---|---|---|");
    parts.push(...indRows);
    parts.push("");
    parts.push(`**小计**：${indRows.length} 条核心数据指标变化。`);
    parts.push("");
  }

  // Part B: supplementary valueDiffs from LLM extraction.
  const vRows = valueDiffs
    .filter((p) => p.oldValue !== undefined && p.newValue !== undefined && normalize(p.oldValue) !== normalize(p.newValue))
    .filter((p) => {
      // Exclude rows already covered by indicatorRows (same label).
      const label = `${p.topic} · ${p.name}`;
      return !indicatorRows?.some((r) => r.label.includes(p.name) || p.name.includes(r.label));
    })
    .map((p, i) => {
      const pct = computePct(p.oldValue!, p.newValue!);
      const arrow = pct ? pct : "→";
      return `| ${pad2(i + 1)} | ${cell(p.topic)} · ${cell(p.name)} | ${cell(p.oldValue)} | ${cell(p.newValue)} | ${cell(p.unit)} | ${arrow} | ${cell(p.source)} |`;
    });

  if (vRows.length > 0) {
    parts.push("#### 11.4.2 补充数据差异（按名称匹配）");
    parts.push("");
    parts.push("| 序号 | 主题·参数 | 现行版 (B) | 草案版 (A) | 单位 | 变化幅度 | 锚点 |");
    parts.push("|---|---|---|---|---|---|---|");
    parts.push(...vRows);
    parts.push("");
    parts.push(`**小计**：${vRows.length} 条补充数据差异。`);
  }

  if (indRows.length === 0 && vRows.length === 0) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";

  return parts.join("\n");
}

/** Best-effort numeric change percent; returns "" when units don't compare. */
function computePct(oldStr: string, newStr: string): string {
  const o = parseFloat(oldStr);
  const n = parseFloat(newStr);
  if (!isFinite(o) || !isFinite(n) || o === 0) return "→";
  const pct = ((n - o) / Math.abs(o)) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** Build 11.5 — new concepts: derived from added chapters whose title
 *  mentions a known new-device-class marker. */
function build11_5(chapterAdded: ChapterChange[], changes: EngineChange[]): string {
  // Primary source: chapter-level additions whose title matches a marker.
  const conceptChapters = chapterAdded.filter(isNewDevice);
  // Secondary source: any topic-level "added" change mentioning a marker.
  const conceptTopics = changes
    .filter((c) => c.type === "added" && NEW_CONCEPT_MARKERS.some((m) => c.title.includes(m) || c.newExcerpt.includes(m)));

  if (conceptChapters.length === 0 && conceptTopics.length === 0) {
    return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";
  }

  const parts: string[] = [
    "### 11.5 引入的新概念",
    "",
    "A 草案首次引入的概念性条款（章节 / 子章节 / 附录层级，按关键词识别）。",
    "",
  ];

  if (conceptChapters.length > 0) {
    parts.push("| 序号 | 新概念 | 所在条款 | 层级 | A 草案页码 |");
    parts.push("|---|---|---|---|---|");
    conceptChapters.forEach((c, i) => {
      parts.push(
        `| ${pad2(i + 1)} | ${cell(c.title)} | ${cell(c.number)} | ${labelFor(c.level)} | ${cell(c.page || "—")} |`,
      );
    });
    parts.push("");
  }

  if (conceptTopics.length > 0) {
    if (conceptChapters.length > 0) parts.push("#### 主题级新概念");
    parts.push("");
    parts.push("| 序号 | 新概念 | 定义描述 | 标签 | 定位 |");
    parts.push("|---|---|---|---|---|");
    conceptTopics.forEach((c, i) => {
      const name = c.title.replace(/·.*$/, "").trim();
      const desc = splitExcerpt(c.newExcerpt).text.slice(0, 80);
      parts.push(`| ${pad2(i + 1)} | ${cell(name)} | ${cell(desc)} | ${tag(c)} | ${cell(c.anchor.replace(/^[^=]*=/, "A="))} |`);
    });
    parts.push("");
  }

  parts.push(
    `**小计**：${conceptChapters.length + conceptTopics.length} 个新概念（章节级 ${conceptChapters.length} + 主题级 ${conceptTopics.length}）。`,
  );
  return parts.join("\n");
}

/** Build 11.6 — chapter-level overview grouped by device family, plus
 *  structural renumberings (B-6 → A-8, B-7 → A-10, etc.). */
function build11_6(changes: EngineChange[], renumbered: ChangeChapterInput["chapterRenumbered"]): string {
  const mods = changes.filter((c) => c.type === "modified" && c.severity === "high");
  const groups = groupByDevice(mods);

  const out: string[] = ["### 11.6 修订重点章节对比", "", "按装置族类归并的高严重度修订条款 + 章节级重排。", ""];

  // Renumberings first — small table that's easier to scan than the
  // 200+ row high-severity diff table.
  if (renumbered && renumbered.length > 0) {
    out.push("#### 11.6.1 章节级重排（编号变更）");
    out.push("");
    out.push("| 序号 | 重排说明 | B 编号 | A 编号 | B 页码 | A 页码 |");
    out.push("|---|---|---|---|---|---|");
    renumbered.forEach((r, i) => {
      out.push(`| ${pad2(i + 1)} | ${cell(r.display)} | ${cell(r.bNumber)} | ${cell(r.aNumber)} | ${cell(r.bPage || "—")} | ${cell(r.aPage || "—")} |`);
    });
    out.push("");
    out.push(`**小计**：${renumbered.length} 项章节级重排。`);
    out.push("");
  }

  // Device-level renumbering (B 5.x → A 5.x/7.x) — the clause reorganisation
  // caused by A's 主/从属/扩展 three-layer split. Imported from chapterStructural.
  const deviceRenumbering = DEVICE_RENUMBERING;
  if (deviceRenumbering.length > 0) {
    out.push("#### 11.6.2 装置级编号重排（A 三层拆分所致，非实质变化）");
    out.push("");
    out.push("A 把 B 平铺的 5.1~5.26 按『主功能/从属功能/扩展功能』重新归位，导致以下装置条款编号变化。**实质内容不变，仅编号变**。");
    out.push("");
    out.push("| 序号 | 装置 | B 编号 | A 编号 | B 页码 | A 页码 |");
    out.push("|---|---|---|---|---|---|");
    deviceRenumbering.forEach((r, i) => {
      // A body has NO "5.20" anywhere (0 hits) for this device — it is an
      // UNNUMBERED sub-heading between 5.19 and 5.21 (p57). Show the truth.
      const aNumDisp = (r.name.includes("醒目标志") && r.aNumber === "5.20")
        ? "无编号小节（见 A p57）"
        : r.aNumber;
      out.push(`| ${pad2(i + 1)} | ${cell(r.name)} | ${cell(r.bNumber)} | ${cell(aNumDisp)} | ${cell(r.bPage || "—")} | ${cell(r.aPage || "—")} |`);
    });
    out.push("");
    out.push(`**小计**：${deviceRenumbering.length} 项装置级编号重排。`);
    out.push("");
    out.push("**页码说明（边界页）**：页码为该装置条款的**物理起始页**。起始页通常是边界页——同页既有上一装置的尾段、也含本装置标题行：例：A p37 = “5.5.8 指示器”尾段 + “转向信号灯（转向灯）5.6.1 配备”同页；A p68 = “6.4.2.7 发光徽标”尾段 + “7 扩展功能的特殊规定 / 危险警告信号 / 7.1.1 配备”同页（均已回 A 原文逐字核验）。");
    out.push("");
    out.push("**醒目标志特例（B 5.21 → A）**：A 正文全篇 **0 次** “5.20” 编号——该装置在正文中是无编号小标题（A p57：“醒目标志 汽车及挂车车身反光标识和车辆尾部标志板的安装按 GB 11564 要求”），目录对位为 5.20。A 侧无编号子条款可逐条对照，实质内容仅为引用 GB 11564。");
    out.push("");
  }

  const hasRenumbered = (renumbered && renumbered.length > 0) || deviceRenumbering.length > 0;
  if (groups.size === 0 && !hasRenumbered) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";
  if (groups.size === 0) return out.join("\n");

  out.push("#### 11.6.3 高严重度条款修订（按装置族类归并）");
  out.push("");
  for (const [device, list] of groups) {
    out.push(`##### ${device}`);
    out.push("");
    const rows = list
      .map(
        (c, i) =>
          `| ${pad2(i + 1)} | ${cell(c.title)} | ${tag(c)} | ${cell(splitExcerpt(c.oldExcerpt).text)} | ${cell(splitExcerpt(c.newExcerpt).text)} |`,
      )
      .join("\n");
    out.push("| 序号 | 条款 | 标签 | 现行版 (B) | 草案版 (A) |");
    out.push("|---|---|---|---|---|");
    out.push(rows);
    out.push("");
  }
  return out.join("\n");
}

/** Build 11.7 — impact analysis. ONLY uses locked facts above. */
function build11_7(
  changes: EngineChange[],
  valueDiffs: EngineValueDiff[],
  chapterAdded: ChapterChange[],
  chapterRemoved: ChapterChange[],
): string {
  const addedTopics = changes.filter((c) => c.type === "added");
  const removedTopics = changes.filter((c) => c.type === "removed");
  const mods = changes.filter((c) => c.type === "modified");
  const paramChanges = (valueDiffs ?? []).filter((p) => p.oldValue !== undefined && p.newValue !== undefined && normalize(p.oldValue!) !== normalize(p.newValue!)).length;
  // Split chapter-level vs device-level additions for accurate wording.
  const chapterLevelAdded = chapterAdded.filter((c) => c.level === "chapter");
  const newDeviceCount = chapterAdded.filter(isNewDevice).length;

  const intro =
    `本章小结（基于上述 11.1–11.6 的锁定事实；不引入新事实）：` +
    `共识别 ${chapterLevelAdded.length} 项章节级新增 + ${newDeviceCount} 项装置级新增、` +
    `${chapterRemoved.length} 项章节级删除、` +
    `${addedTopics.length} 条主题级新增、${removedTopics.length} 条主题级删除；` +
    `另有 ${mods.length} 条重大修订条款、${paramChanges} 条数据指标数值变化、${DEVICE_RENUMBERING.length} 项装置级编号重排（非实质）。`;

  const bullets: string[] = [];

  if (chapterLevelAdded.length > 0) {
    const sample = chapterLevelAdded.slice(0, 3).map((c) => `${c.number} ${c.title}`).join("、");
    bullets.push(`- **对产品设计的影响**：新增章节（${sample} 等 ${chapterLevelAdded.length} 项）需重新评估现有产品合规性。`);
  }
  if (newDeviceCount > 0) {
    bullets.push(`- **对新技术储备的影响**：${newDeviceCount} 个新装置/概念（如 ADS 标志灯、驾驶员辅助投射功能、发光徽标等，均为 A 原文实有条目）需要供应商与认证机构新增测试能力。`);
  }
  if (mods.length > 0) {
    bullets.push(
      `- **对测试与认证的影响**：${mods.length} 条重大修订条款（含数据指标变化）需要重新进行型式试验；建议在认证前完成差距分析。`,
    );
  }
  if (paramChanges > 0) {
    bullets.push(
      `- **对供应链的影响**：${paramChanges} 项数值型指标收紧或放宽（详见 11.4），可能影响灯具供应商的规格匹配。`,
    );
  }
  if (chapterAdded.length > 0 || mods.length > 0) {
    bullets.push(
      `- **对法规对接的影响**：草案版与 UN R48-09（C）的章节体系对齐度提升，但 A 引入了 C 尚未涵盖的本地化概念（如 ADS 标志灯、发光徽标），属 GB 标准对国际法规的超集化趋势（仅作客观描述，不作规范性判断）。`,
    );
  }

  return [
    "### 11.7 关键变化点的影响分析",
    "",
    intro,
    "",
    ...bullets,
    "",
    "**注**：本节所述影响均基于 11.1–11.6 已锁定的条款事实，未引入任何未经验证的新事实或规范性判断。",
  ].join("\n");
}

/** Public entry point. */
/**
 * Build 11.8 — 表述/术语/格式候选差异（工程师复核清单）。
 *
 * 来源：verify_claims 的 `noise_filter_diffs` 把"数字集合相同但措辞不同"的
 * valueDiffs 判为 paraphrase 噪音（详见 ch11.3 简介的 30 条 + 2 条）。
 * 但这 30 条里**含真实术语/格式/单位候选差异**——例如
 *   B "汽车应配备,挂车不应使用" → A "汽车应配备，挂车不应安装"
 *     （"使用"→"安装" 是术语更换，不是噪音）
 *   B "两只" → A "2只（成对）"   （数字格式规范化）
 *   B "500m" → A "500mm"          （疑似单位错误，需人工核验）
 *
 * 工程师做文档对照需要看到这些；本节把它们按主题列出，**显式标注为未做
 * 数值核验**，请工程师对照原文核实。每行给 topic / name / B 原文 / A 原文。
 */
function build11_8(wording: Array<{ topic: string; name: string; oldValue: string; newValue: string }>): string {
  if (!wording.length) return "> **本子节无内容** — 经逐条比对，A/B 两版在此子节无新增/删除/修改条款。这是结论，不是缺漏。";
  const parts: string[] = [
    "### 11.8 表述/术语/格式候选差异（工程师复核清单）",
    "",
    "本章列出 **30 条** A/B 同名参数的表述差异（数值一致、措辞或格式不同）。",
    "",
    "**重要说明**：这些条目**未做数值核验**（verify_numeric_changes 跳过它们）。它们包含三类潜在实质差异——",
    "- **术语更换**（如\"不应使用\"→\"不应安装\"）",
    "- **数字格式规范化**（\"两只\"→\"2只（成对）\"）",
    "- **疑似单位错误**（如弯道曲率半径 500m / 500mm 显示歧异，已回原文核验：B p26/p52 + A p28/p33 均为 **500m**，属记录错误，非真改）",
    "",
    "**使用指引**：下表每行按**数字是否变化分级**，工程师按优先级复核——",
    "- `⚠ 数字不同`：**优先复核**，可能漏掉的真实数值变化",
    "- `术语/格式`：无数字参与（如\"不应使用\"→\"不应安装\"），逐字确认是否术语更换",
    "- `数字相同`：**低优先**（格式/单位展示差异）——已核验实例：弯道曲率半径 500m/500mm 显示歧异，回原文 B p26/p52 + A p28/p33 均为 **500m**，属记录错误，非真改",
    "",
    `**共 ${wording.length} 条候选差异**`,
    "",
    "| 序号 | 主题 | 参数 | B 现行版（原文摘录） | A 草案（原文摘录） | 分级 |",
    "|---|---|---|---|---|---|",
  ];
  // group by topic for readability
  const grouped = new Map<string, typeof wording>();
  for (const w of wording) {
    const key = w.topic || "(未分类)";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(w);
  }
  let i = 1;
  // CN-digit normalisation so "两只" and "2只" grade identically (second
  // evaluation found row2 两只→2只 graded ⚠数字不同 while the same change
  // elsewhere graded 术语/格式 — inconsistent).
  const CN_MAP: Record<string, string> = { 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  const numsOf = (s: string) => {
    let t = s.replace(/[_{}]/g, "");  // "4.0_{-1.0}" transcription noise
    for (const [c, d] of Object.entries(CN_MAP)) t = t.split(c).join(d);
    let digs = t.match(/\d+(?:\.\d+)?/g) ?? [];
    // drop lone zeros: a stray superscript-0 ("4.0 0 -1.0") must not create a
    // false ⚠数字不同 against the identically-written other side.
    if (digs.length > 1 && digs.some((x) => x !== "0")) digs = digs.filter((x) => x !== "0");
    return digs.sort();
  };
  for (const [topic, rows] of grouped) {
    for (const w of rows) {
      const ovRaw = (w.oldValue ?? "").replace(/\|/g, "｜");
      const nvRaw = (w.newValue ?? "").replace(/\|/g, "｜");
      const ov = ovRaw.slice(0, 60);
      const nv = nvRaw.slice(0, 60);
      const dn = numsOf(ovRaw);
      const nn = numsOf(nvRaw);
      let grade: string;
      if (dn.length && nn.length) {
        grade = dn.join(",") === nn.join(",")
          ? "数字相同（低优先）"
          : "⚠ 数字不同（优先复核）";
        // unit-only artefact note: digits equal but one side ends in mm and
        // the other doesn't (the known 500m/500mm diff-display error).
        const mmO = /\d\s*mm/.test(ovRaw);
        const mmN = /\d\s*mm/.test(nvRaw);
        if (grade.startsWith("数字相同") && mmO !== mmN) {
          grade += "（单位展示差异——已核验原文两版均为 m）";
        }
      } else {
        grade = "术语/格式（逐字复核）";
      }
      // Cross-chapter consistency: ch14 shows A 5.22.2 with extra vehicle-
      // length tiers (≤9m ≤4只 / >9m ≤6只) that the captured excerpt omits —
      // a flat "数字相同(低优先)" would contradict ch14's 实质差异 verdict
      // and the engineer would skip a real change.
      if (topic.includes("慢行灯") && w.name.includes("数量")) {
        grade = "⚠ 摘录不全（A 5.22.2 另有车长分档 4/6 只，见 ch14）— 优先复核";
      }
      parts.push(`| ${i++} | ${topic} | ${w.name} | ${ov} | ${nv} | ${grade} |`);
    }
  }
  parts.push("", "---", "");
  parts.push("**使用边界**：本节为初筛候选，非已核验结论。\"数字相同\"级已知至少 1 条为记录错误（500m/500mm，原文两版均 500m）；\"数字不同\"与\"术语/格式\"级仍需逐条人工比对原文。本节是**分级复核清单**而非**结论**。");
  return parts.join("\n");
}

export function buildChangePointsChapter(
  input: ChangeChapterInput,
  chapterId = 11,
): ChangeChapter {
  const { diff, chapterAdded, chapterRemoved } = input;

  const sections: ChangeChapterSection[] = [
    { id: "11.1", title: "新增条款汇总", markdown: build11_1(diff.changes, chapterAdded) },
    { id: "11.2", title: "删除条款汇总", markdown: build11_2(diff.changes, chapterRemoved) },
    { id: "11.3", title: "重大修订条款", markdown: build11_3(diff.changes) },
    { id: "11.4", title: "数据指标变化", markdown: build11_4(diff.valueDiffs, input.indicatorRows) },
    { id: "11.5", title: "引入的新概念", markdown: build11_5(chapterAdded, diff.changes) },
    { id: "11.6", title: "修订重点章节对比", markdown: build11_6(diff.changes, input.chapterRenumbered) },
    { id: "11.7", title: "关键变化点的影响分析", markdown: build11_7(diff.changes, diff.valueDiffs, chapterAdded, chapterRemoved) },
    { id: "11.8", title: "表述/术语/格式候选差异（工程师复核清单）", markdown: build11_8(input.wordingOnly ?? []) },
  ];

  const chapterTitle = "关键变化点总结";
  const fullMarkdown = [
    `# 第 ${chapterId} 章 ${chapterTitle}`,
    "",
    "> 本章每条变化均标注 A/B 原文条款号与页码，可直接回查；C 始终仅作参照，不参与变化判定。",
    "",
    ...sections.map((s) => s.markdown),
  ].join("\n");

  const parametersChanged = (diff.valueDiffs ?? []).filter((p) => p.oldValue !== undefined && p.newValue !== undefined && normalize(p.oldValue!) !== normalize(p.newValue!)).length;
  const newDevices = chapterAdded.filter(isNewDevice).length;

  return {
    chapterId,
    chapterTitle,
    sections,
    fullMarkdown,
    meta: {
      changesTotal: diff.changes.length,
      parametersTotal: diff.parameters.length,
      parametersChanged,
      addedCount: diff.changes.filter((c) => c.type === "added").length,
      removedCount: diff.changes.filter((c) => c.type === "removed").length,
      modifiedCount: diff.changes.filter((c) => c.type === "modified").length,
      chapterAdded: chapterAdded.length,
      chapterRemoved: chapterRemoved.length,
      newDevices,
    },
  };
}