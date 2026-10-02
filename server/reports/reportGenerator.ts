/**
 * Multi-chapter regulatory report generator.
 *
 * Instead of asking the LLM to write a whole 20-page report in one call
 * (which always truncates to 2-3 pages), we:
 *
 *   1. Ask the LLM for a chapter OUTLINE first  (1 call)
 *   2. Generate each chapter separately          (N calls, streamed)
 *
 * Every call receives the full document text + the regex-extracted clause
 * index / numeric values, so chapters cite precise, provenvenance-tracked
 * numbers.
 *
 * Progress is reported through an event callback so the caller can stream
 * it to the browser over SSE.
 */

import { readFileSync } from "node:fs";
import { streamMiniMaxChat, type ChatMessage } from "../integrations/minimax";
import { extractStructured } from "../ingestion/structuredExtract";
import { diffDocuments } from "./diffEngine";
import { buildChangePointsChapter, type ChangeChapterInput } from "./changePointChapter";
import { detectDeviceClasses, deviceClassesAsChapterChanges } from "./deviceClassScan";
import { detectStructuralChapters } from "./chapterStructural";

export type ChapterSpec = {
  id: number;
  title: string;
  sections: string[];
};

export type AppendixSpec = { id: string; title: string };

export type ReportOutline = {
  title: string;
  chapters: ChapterSpec[];
  appendices: AppendixSpec[];
};

export type ReportEvent =
  | { type: "outline"; outline: ReportOutline }
  | { type: "regex_stats"; clauses: number; values: number }
  | { type: "chapter_start"; id: number; title: string; index: number; total: number }
  | { type: "chapter_content"; id: number; delta: string }
  | { type: "chapter_done"; id: number; title: string; markdown: string }
  | { type: "appendix_start"; id: string; title: string; index: number; total: number }
  | { type: "appendix_content"; id: string; delta: string }
  | { type: "appendix_done"; id: string; title: string; markdown: string }
  | { type: "all_done" }
  | { type: "error"; message: string };

export type DocInput = {
  label: string;
  fileName: string;
  text: string;
};

const FALLBACK_OUTLINE: ReportOutline = {
  title: "多版本法规横向对比研究报告",
  chapters: [
    { id: 1, title: "引言", sections: ["研究背景", "对比目的与方法", "数据来源"] },
    { id: 2, title: "法规背景与适用范围", sections: ["各版本概况", "适用范围对比", "对齐度评估"] },
    { id: 3, title: "章节体系与结构对比", sections: ["章节结构总览", "新增/删除章节", "章节对照矩阵"] },
    { id: 4, title: "术语与定义对比", sections: ["术语体系概览", "新增术语详解", "删除术语分析"] },
    { id: 5, title: "一般要求对比", sections: ["安装基本要求", "颜色与色度要求", "电气连接与控制"] },
    { id: 6, title: "前照灯安装规定对比", sections: ["远光灯", "近光灯", "AFS", "ADB", "矩阵式LED"] },
    { id: 7, title: "信号灯安装规定对比", sections: ["转向信号灯", "制动灯", "位置灯", "昼间行驶灯", "紧急制动信号"] },
    { id: 8, title: "反射器与识别标志对比", sections: ["反射器类型", "后反射器", "识别标志"] },
    { id: 9, title: "光度色度要求对比", sections: ["发光强度限值", "色度坐标", "闪烁频率"] },
    { id: 10, title: "测试方法对比", sections: ["试验条件", "测量方法"] },
    { id: 11, title: "变化点总结", sections: ["新增条款汇总", "修改条款汇总", "删除条款汇总"] },
    { id: 12, title: "合规影响分析", sections: ["对整车厂影响", "对供应商影响", "对检测认证影响"] },
    { id: 13, title: "结论与建议", sections: ["核心结论", "合规建议", "后续关注"] },
  ],
  appendices: [
    { id: "A", title: "三版本章节对照表" },
    { id: "B", title: "关键数值差异汇总" },
    { id: "C", title: "术语对照表" },
    { id: "D", title: "数据溯源索引" },
  ],
};

/**
 * Build the change-points chapter deterministically from the uploaded
 * documents, skipping the LLM entirely. Used when `reportGenerator`
 * encounters a "变化点 / 关键变化" chapter — we don't want LLM to
 * hallucinate the entries (it already failed at this in the previous
 * report).
 *
 * Returns null if anything goes wrong (e.g. structured extraction failed)
 * — the caller can fall back to LLM generation in that case.
 */
async function buildDeterministicChangeChapter(docs: DocInput[]): Promise<string | null> {
  if (docs.length < 2) return null;
  try {
    const [aDoc, bDoc, ...rest] = await Promise.all([
      extractStructured("A", docs[0].fileName, docs[0].text),
      extractStructured("B", docs[1].fileName, docs[1].text),
      ...docs.slice(2).map((d, i) => extractStructured(String.fromCharCode(67 + i), d.fileName, d.text)),
    ]);
    const diff = diffDocuments(aDoc, bDoc, rest[0]);
    const devs = detectDeviceClasses(docs[0].text, docs[1].text);
    const struct = detectStructuralChapters();
    const chapterChanges = {
      added: [
        ...struct.added.map((c) => ({
          number: c.number,
          level: "chapter" as const,
          title: c.title,
          page: c.page,
        })),
        ...deviceClassesAsChapterChanges(devs),
      ],
      removed: struct.removed.map((c) => ({
        number: c.number,
        level: "chapter" as const,
        title: c.title,
        page: c.page,
      })),
      renumbered: struct.renumbered,
    };
    const ch = buildChangePointsChapter(
      {
        diff,
        chapterAdded: chapterChanges.added,
        chapterRemoved: chapterChanges.removed,
        chapterRenumbered: chapterChanges.renumbered,
      } as ChangeChapterInput,
      11,
    );
    return ch.fullMarkdown;
  } catch (e) {
    console.error("[report] deterministic change chapter failed:", e);
    return null;
  }
}

/**
 * Ask the LLM for a report outline tailored to the uploaded documents.
 * Falls back to the regulatory-comparison default if parsing fails.
 */
async function generateOutline(docs: DocInput[], labels: string[]): Promise<ReportOutline> {
  const docHeads = docs
    .map((d) => `${d.label}（${d.fileName}）前 3000 字：\n${d.text.slice(0, 3000)}`)
    .join("\n\n---\n\n");

  const prompt = `以下是三份待对比的法规文件的开头内容。请根据这些文件的实际结构，为一份多版本横向对比研究报告生成章节大纲。

${docHeads}

要求：
- 8~15 个正文章节（N. 标题），每个章节包含 2~5 个小节标题
- 附录 A~D：章节对照表、关键数值差异汇总、术语对照表、数据溯源索引
- 标题要具体，贴合这三份法规的实际内容（不要泛泛的"第N章"）

严格只输出 JSON，格式：
{
  "title": "报告标题",
  "chapters": [{ "id": 1, "title": "章节标题", "sections": ["小节1", "小节2"] }],
  "appendices": [{ "id": "A", "title": "附录标题" }]
}`;

  try {
    let buf = "";
    for await (const chunk of streamMiniMaxChat(
      [{ role: "user", content: prompt }],
      { temperature: 0.2, maxTokens: 4096 },
    )) {
      buf += chunk;
    }
    const m = buf.match(/\{[\s\S]*\}/);
    if (m) {
      const parsed = JSON.parse(m[0]) as ReportOutline;
      if (Array.isArray(parsed.chapters) && parsed.chapters.length >= 5) {
        // Normalise: ensure every chapter has sections
        parsed.chapters = parsed.chapters.map((c, i) => ({
          id: c.id ?? i + 1,
          title: c.title ?? `第 ${i + 1} 章`,
          sections: Array.isArray(c.sections) && c.sections.length ? c.sections : ["概述"],
        }));
        if (!Array.isArray(parsed.appendices) || !parsed.appendices.length) {
          parsed.appendices = FALLBACK_OUTLINE.appendices;
        }
        return parsed;
      }
    }
  } catch (e) {
    console.error("[report] outline generation failed, using fallback:", e);
  }
  return FALLBACK_OUTLINE;
}

/**
 * Build a set of 2-character grams from the chapter title + sections, used to
 * score which document blocks are relevant. Chinese is unsegmented, so 2-grams
 * work well as a poor man's keyword index ("前照灯" → 前照/照灯).
 */
function chapterKeywords(chapter: ChapterSpec): Set<string> {
  const text = chapter.title + " " + chapter.sections.join(" ");
  const grams = new Set<string>();
  const clean = text.replace(/[^一-龥a-zA-Z0-9]/g, " ");
  for (const piece of clean.split(/\s+/)) {
    if (piece.length <= 2) {
      if (piece) grams.add(piece);
      continue;
    }
    for (let i = 0; i + 2 <= piece.length; i++) grams.add(piece.slice(i, i + 2));
    // also keep whole word for latin terms (ADB, AFS, LED…)
    if (/[a-zA-Z]/.test(piece)) grams.add(piece.toLowerCase());
  }
  return grams;
}

/** Score a text block by how many keyword grams it contains. */
function scoreBlock(block: string, keywords: Set<string>): number {
  let score = 0;
  const lower = block.toLowerCase();
  for (const g of keywords) {
    if (lower.includes(g)) score++;
  }
  return score;
}

/**
 * Slice each document down to the pages most relevant to the chapter.
 *
 * Rationale: sending all 452K chars to every one of 13 chapter calls costs
 * ~5.9M input tokens per report and blows the MiniMax Token Plan in one run.
 * Each regulation page only relates to a few chapters, so we page-rank by
 * keyword overlap and send only the top pages (budgeted), which cuts input
 * by ~10x while keeping every citable clause in reach.
 */
function sliceRelevantContext(
  chapter: ChapterSpec,
  docs: DocInput[],
  budgetPerDoc = 16_000,
): string {
  const keywords = chapterKeywords(chapter);
  const parts: string[] = [];

  for (const d of docs) {
    // Split into page blocks using the [第N页] markers our extractor emits.
    const blocks: Array<{ page: string; text: string }> = [];
    const pieces = d.text.split(/\n(?=\[第\d+页\])/);
    for (const piece of pieces) {
      const pageMatch = piece.match(/^\[(第\d+页)\]/);
      blocks.push({ page: pageMatch ? pageMatch[1] : "", text: piece });
    }

    const scored = blocks
      .map((b, i) => ({ ...b, i, score: scoreBlock(b.text, keywords) }))
      .sort((a, b) => b.score - a.score);

    // Keep the highest scoring blocks until budget; then restore reading order.
    const kept: typeof scored = [];
    let used = 0;
    const scoredNonEmpty = scored.filter((b) => b.text.trim().length > 0);
    // Always keep at least the first block (file identity / scope) when it's the header page.
    for (const b of scoredNonEmpty) {
      if (used + b.text.length > budgetPerDoc && kept.length > 0) continue;
      if (used > budgetPerDoc * 1.5) break;
      kept.push(b);
      used += b.text.length;
    }
    kept.sort((a, b) => a.i - b.i);

    const joined = kept
      .map((b) => (b.score > 0 ? b.text : ""))
      .filter(Boolean)
      .join("\n");

    parts.push(
      `===== 文档 ${d.label}（${d.fileName}，已按本章主题选取 ${kept.filter((b) => b.score > 0).length} 个相关页段）=====\n${joined || kept.map((b) => b.text).join("\n").slice(0, budgetPerDoc)}`,
    );
  }
  return parts.join("\n\n");
}

/** Trim the regex data to entries relevant to this chapter (plus a small cap). */
function trimRegexForChapter(chapter: ChapterSpec, regexJson: string): string {
  try {
    const data = JSON.parse(regexJson) as {
      clauses: Array<Record<string, unknown>>;
      numericValues: Array<Record<string, unknown>>;
    };
    const keywords = chapterKeywords(chapter);
    const matches = (item: Record<string, unknown>) => {
      const hay = JSON.stringify(item).toLowerCase();
      for (const g of keywords) if (hay.includes(g)) return true;
      return false;
    };
    let clauses = data.clauses.filter(matches);
    let values = data.numericValues.filter(matches);
    if (clauses.length < 15) clauses = data.clauses.slice(0, 150);
    if (values.length < 20) values = data.numericValues.slice(0, 200);
    clauses = clauses.slice(0, 250);
    values = values.slice(0, 300);
    return JSON.stringify({ clauses, numericValues: values });
  } catch {
    return regexJson;
  }
}

/**
 * Version roles — THE single most important semantic rule for this report:
 * changes run B(现行 2019) → A(草案新版); C(UN R48) is international
 * reference only (anchor, never mixed into 原文/新文).
 */
const VERSION_RULES = `
【版本角色——必须严格遵守，否则报告作废】
- A = GB 4785 草案 V4.3.5（新版，待发布）
- B = GB 4785-2019（现行版，旧版）
- C = UN R48-09（国际法规，只做参照）
- 一切"变化"都指 **B → A**：oldExcerpt/原文 = B 的原文，newExcerpt/新文 = A 的原文
- C 的值只写进 anchor/定位（如"C=6.1"），绝对不要拼进"新文"字段
- A 与 B 相同的内容 = [保留]，不是变化，不要列为 change
- 每条变化必须是【条款级】的：给出条款号、具体技术内容或数值（如"5.24:新增 ADS 标志灯，透光面≤400cm²"），禁止只写"章节数不同"这类元数据
`;

/**
 * A trimmed copy of the reference report's chapter 11 (变化点总结) — the format
 * the client approved. Injected into change-related chapter prompts as a
 * few-shot example so our output matches its structure:
 *   新增条款汇总 → 删除条款汇总 → 重大修订条款，each a table of
 *   条款号 + 具体技术内容。
 */
let cachedChangeExample: string | null = null;
function changeStyleExample(): string {
  if (cachedChangeExample !== null) return cachedChangeExample;
  try {
    const file = new URL("../change_example.md", import.meta.url);
    const raw = readFileSync(file, "utf-8");
    // Keep only the core 11.1–11.3 format sections (drop trailing noise)
    const cut = raw.search(/11\.4|变化点的影响与/);
    cachedChangeExample = (cut > 0 ? raw.slice(0, cut) : raw).slice(0, 6000);
  } catch (e) {
    console.error("[report] change_example.md not loaded:", e);
    cachedChangeExample = "";
  }
  return cachedChangeExample;
}

/** Build the per-chapter prompt with relevance-sliced doc text + regex data. */
function chapterPrompt(
  chapter: ChapterSpec,
  docs: DocInput[],
  regexJson: string,
  prevSummaries: string,
): string {
  const docText = sliceRelevantContext(chapter, docs);
  const trimmedRegex = trimRegexForChapter(chapter, regexJson);
  const sections = chapter.sections.map((s) => `### ${s}`).join("\n");
  const isChangeChapter = /变化|修订|趋势|立法|动向/.test(chapter.title + chapter.sections.join(" "));
  const example = isChangeChapter ? changeStyleExample() : "";
  console.log(
    `[report] ch${chapter.id}「${chapter.title}」 prompt: docs=${docText.length} regex=${trimmedRegex.length} chars (全量文档=${docs.reduce((s, d) => s + d.text.length, 0)})`,
  );

  return `你是资深法规对比研究员。请为《多版本横向对比研究报告》撰写"第 ${chapter.id} 章 ${chapter.title}"。
${VERSION_RULES}
【本章小节结构】
${sections}
${example ? `\n【格式范例——客户已认可的"变化点总结"标准写法（参考报告第 11 章），照此结构与颗粒度撰写】\n${example}\n` : ""}
【撰写要求——非常重要】
1. 每个小节都必须包含**三版本对比表格**（列：项目 | ${docs.map((d) => d.label).join(" | ")}），把实际条款内容填入表格单元格
2. **强制三栏对齐**：每张对比表都必须输出 A / B / C 三行（即使某版本无对应条款，也必须写一行 “本版未规定” 占位，**绝对不允许省略**——PDF 渲染器会基于此输出三栏卡片，缺一行就破布局）
3. 每条对比必须给出**原文摘录 + 条款号 + 页码**作为锚点（例如：「A 5.3.4.1：…（第44页）」）
4. 变更必须标注 [新增] / [删除] / [修改] / [保留]
5. **每个 triptych 对比表之后必须输出一段「4 维影响卡」**（格式见下方），把这条差异的产品设计 / 测试 / 认证 / 风险影响写清楚——这是客户的核心需求，绝对不能省略：
   🔧 设计影响：…（一句话，影响产品设计的具体方面）
   🧪 测试影响：…（一句话，新增/调整的测试项目）
   📋 认证影响：…（一句话，对认证流程/工期的影响）
   ⚠ 风险等级：高/中/低（一条）
6. 优先使用下面"Regex 精确提取"里的数值和条款号——它们来自原文，可直接引用
7. 章节长度目标 800~2000 字，要有实质内容，不要只写概括
8. 章节末尾给出「本章小结」段落
9. 不要输出 JSON，不要写"以下是"之类的引语，直接输出 markdown 正文

【4 维影响卡的写法范例】
> 🔧 设计影响：灯具外壳需重新开模以容纳 AFS 单元（预估 15 天模具周期）
> 🧪 测试影响：新增近光 4° 对称性测试 + 远光自动切换时序验证
> 📋 认证影响：型式认证流程新增 1 道工序，整体认证周期延长 2-3 周
> ⚠ 风险等级：中（GB 4785 §5.2.6 新增条款）

【Regex 精确提取数据（可直接引用，含条款号与页码）】
${trimmedRegex}

${prevSummaries ? `【前文已生成的章节摘要（保持连贯，避免重复）】\n${prevSummaries}\n\n` : ""}【三份法规全文（本章相关页段）】
${docText}

现在直接输出第 ${chapter.id} 章的 markdown 正文：`;
}

/**
 * Generate the whole report. `onEvent` receives progress; chapter markdown
 * is yielded through the `chapter_done` events.
 */
export async function* generateReport(
  docs: DocInput[],
  regexJson: string,
  onEvent?: (e: ReportEvent) => void,
): AsyncGenerator<ReportEvent> {
  // 1. Outline
  onEvent?.({ type: "regex_stats", clauses: 0, values: 0 });
  let outline: ReportOutline;
  try {
    outline = await generateOutline(docs, docs.map((d) => d.label));
  } catch (e) {
    onEvent?.({ type: "error", message: `大纲生成失败: ${e}` });
    outline = FALLBACK_OUTLINE;
  }
  onEvent?.({ type: "outline", outline });
  yield { type: "outline", outline };

  // 1.5 Pre-build the change-points chapter deterministically (no LLM)
  //     for any chapter that matches the change-points pattern. The LLM
  //     previously fabricated 36 entries with wrong page numbers and
  //     paraphrased quotes — never again.
  const deterministicChapters = new Map<number, string>();
  for (const ch of outline.chapters) {
    if (/变化点|修订|关键变化/.test(ch.title + ch.sections.join(" "))) {
      const md = await buildDeterministicChangeChapter(docs);
      if (md) {
        deterministicChapters.set(ch.id, md);
        console.log(`[report] pre-built deterministic chapter ${ch.id} "${ch.title}"`);
      }
    }
  }

  const total = outline.chapters.length;
  const prevSummaries: string[] = [];

  // 2. Chapters, one LLM call each
  for (let i = 0; i < outline.chapters.length; i++) {
    const ch = outline.chapters[i];
    const start: ReportEvent = {
      type: "chapter_start",
      id: ch.id,
      title: ch.title,
      index: i + 1,
      total,
    };
    onEvent?.(start);
    yield start;

    // 2.1 If we have a deterministic version for this chapter, yield it
    //     and skip the LLM call entirely.
    const preBuilt = deterministicChapters.get(ch.id);
    if (preBuilt) {
      const delta: ReportEvent = { type: "chapter_content", id: ch.id, delta: preBuilt };
      onEvent?.(delta);
      yield delta;
      const done: ReportEvent = { type: "chapter_done", id: ch.id, title: ch.title, markdown: preBuilt };
      onEvent?.(done);
      yield done;
      continue;
    }

    let md = "";
    let hardFail = false;
    // Exponential backoff: 429 here is a RATE limit (consecutive big requests),
    // not necessarily quota exhaustion — probe showed the API still accepts
    // HTTP 200. Retry with growing waits before giving up.
    const waits = [15_000, 45_000, 90_000];
    for (let attempt = 0; attempt <= waits.length && !md; attempt++) {
      try {
        for await (const chunk of streamMiniMaxChat(
          [{ role: "user", content: chapterPrompt(ch, docs, regexJson, prevSummaries.join("\n")) }],
          { temperature: 0.2, maxTokens: 8192 },
        )) {
          md += chunk;
          const delta: ReportEvent = { type: "chapter_content", id: ch.id, delta: chunk };
          onEvent?.(delta);
          yield delta;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isRateLimit = /429|rate_limit/i.test(msg);
        if (isRateLimit && attempt < waits.length) {
          // Rate limited → back off and retry the SAME chapter.
          const wait = waits[attempt];
          const notice: ReportEvent = {
            type: "chapter_content",
            id: ch.id,
            delta: `\n\n⏳ 触发速率限制（429），${Math.round(wait / 1000)} 秒后自动重试…\n\n`,
          };
          onEvent?.(notice);
          yield notice;
          await new Promise((r) => setTimeout(r, wait));
        } else if (isRateLimit) {
          hardFail = true;
          const err: ReportEvent = {
            type: "error",
            message: `第${ch.id}章连续 ${waits.length + 1} 次被速率限制（429）。请在 MiniMax 控制台确认限流档位，稍后重试；已生成的章节会保留。`,
          };
          onEvent?.(err);
          yield err;
          md = "";
        } else if (attempt === 0) {
          // transient non-429 error → short retry
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          const err: ReportEvent = { type: "error", message: `第${ch.id}章生成失败: ${msg}` };
          onEvent?.(err);
          yield err;
          md = `（本章生成失败：${msg}）`;
        }
      }
    }

    if (hardFail) {
      // Stop the whole run after exhausting retries.
      const skipped: ReportEvent = {
        type: "error",
        message: `已中止：第 ${ch.id} 章起的 ${total - i + 1} 个章节因持续限流未生成。稍后可重新生成。`,
      };
      onEvent?.(skipped);
      yield skipped;
      const doneEarly: ReportEvent = { type: "all_done" };
      onEvent?.(doneEarly);
      yield doneEarly;
      return;
    }

    if (!md) {
      // Retries exhausted with empty content — record and stop.
      const err: ReportEvent = { type: "error", message: `第${ch.id}章生成失败（无内容）` };
      onEvent?.(err);
      yield err;
      md = `（本章生成失败）`;
    }

    // Quality gate: a chapter that came back essentially empty (the model
    // sometimes stops right after the heading) would become an orphan-title
    // page in the PDF. Retry it once with an emphatic prompt.
    const plainLen = md.replace(/[#*>|`\-\[\]()\s]/g, "").length;
    if (plainLen < 400 && !md.includes("生成失败")) {
      const notice: ReportEvent = {
        type: "chapter_content",
        id: ch.id,
        delta: "\n\n⏳ 本章内容过短，正在重新生成更完整的版本…\n\n",
      };
      onEvent?.(notice);
      yield notice;
      try {
        let retry = "";
        for await (const chunk of streamMiniMaxChat(
          [
            {
              role: "user",
              content:
                chapterPrompt(ch, docs, regexJson, prevSummaries.join("\n")) +
                "\n\n【警告】你上一次输出过短。本次必须输出不少于 800 字的完整章节正文，" +
                "包含三版本对比表格、原文摘录和本章小结，禁止只写标题。",
            },
          ],
          { temperature: 0.3, maxTokens: 8192 },
        )) {
          retry += chunk;
          const delta: ReportEvent = { type: "chapter_content", id: ch.id, delta: chunk };
          onEvent?.(delta);
          yield delta;
        }
        const retryLen = retry.replace(/[#*>|`\-\[\]()\s]/g, "").length;
        if (retryLen > plainLen && retryLen >= 300) md = retry;
      } catch (e) {
        // keep the short version if the retry itself failed
        console.error(`[report] ch${ch.id} thin-chapter retry failed:`, e);
      }
    }

    // Keep a short summary for cross-chapter coherence
    prevSummaries.push(`第${ch.id}章 ${ch.title}: ${md.slice(0, 300).replace(/\n/g, " ")}`);
    if (prevSummaries.length > 4) prevSummaries.shift();

    const done: ReportEvent = { type: "chapter_done", id: ch.id, title: ch.title, markdown: md };
    onEvent?.(done);
    yield done;

    // Gentle pacing between chapters so we stay under the RPM/TPM window.
    if (i + 1 < total) await new Promise((r) => setTimeout(r, 4_000));
  }

  // ---- Appendices (对照表 / 数值汇总 / 术语表 / 溯源索引) ----
  const appendixSpecs = outline.appendices ?? [];
  const aTotal = appendixSpecs.length;
  for (let ai = 0; ai < aTotal; ai++) {
    const ap = appendixSpecs[ai];
    const start: ReportEvent = {
      type: "appendix_start",
      id: ap.id,
      title: ap.title,
      index: ai + 1,
      total: aTotal,
    };
    onEvent?.(start);
    yield start;

    const docText = sliceRelevantContext(
      { id: 99, title: ap.title, sections: [ap.title] },
      docs,
      14_000,
    );
    const chapterList = outline.chapters.map((c) => `${c.id} ${c.title}`).join("；");
    const prompt = `你是资深法规对比研究员。请为《${outline.title}》撰写"附录 ${ap.id} ${ap.title}"。

【报告章节结构（供交叉引用）】
${chapterList}

【要求】
1. 这是数据型附录：优先输出**大表格**（markdown 表格），把散落在正文中的数据集中汇总
2. 附录类型提示：
   - 章节结构对照表 → 三列（A草案/B 2019/C UN R48）逐章对照
   - 关键数值差异 → 数值 | A值 | B值 | C值 | 差异说明，至少 15 行
   - 术语对照 → 中文 | 英文 | A出现位置 | B出现位置，至少 15 行
   - 数据溯源 → 条款号 | 原始 PDF 页码 | 版本批次，列出 20+ 条
3. 每条数据带原文锚点（条款号/页码）
4. 600~2000 字，不要写"以下是"引语，直接输出 markdown

【Regex 精确提取数据（可直接引用）】
${trimRegexForChapter({ id: 99, title: ap.title, sections: [ap.title] }, regexJson)}

【三份法规全文（相关页段）】
${docText}

现在直接输出附录 ${ap.id} 的 markdown 正文：`;

    let md = "";
    for (let attempt = 0; attempt < 2 && !md; attempt++) {
      try {
        for await (const chunk of streamMiniMaxChat([{ role: "user", content: prompt }], {
          temperature: 0.2,
          maxTokens: 8192,
        })) {
          md += chunk;
          const delta: ReportEvent = { type: "appendix_content", id: ap.id, delta: chunk };
          onEvent?.(delta);
          yield delta;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/429|rate_limit/i.test(msg) && attempt === 0) {
          const notice: ReportEvent = {
            type: "appendix_content",
            id: ap.id,
            delta: "\n\n⏳ 触发速率限制（429），15 秒后自动重试…\n\n",
          };
          onEvent?.(notice);
          yield notice;
          await new Promise((r) => setTimeout(r, 15_000));
        } else {
          const err: ReportEvent = { type: "error", message: `附录 ${ap.id} 生成失败: ${msg}` };
          onEvent?.(err);
          yield err;
          md = `（附录生成失败：${msg}）`;
        }
      }
    }

    // Quality gate: an appendix that came back empty/near-empty (rate limits
    // sometimes yield whitespace only) gets one emphatic retry.
    if (md.replace(/[#*>|`\-\[\]()\s]/g, "").length < 200 && !md.includes("生成失败")) {
      try {
        let retry = "";
        for await (const chunk of streamMiniMaxChat(
          [
            {
              role: "user",
              content:
                prompt +
                "\n\n【警告】你上一次输出为空或过短。本次必须输出不少于 600 字的完整附录正文，" +
                "包含大表格（至少 10 行数据），直接输出 markdown，禁止只写标题。",
            },
          ],
          { temperature: 0.3, maxTokens: 8192 },
        )) {
          retry += chunk;
          const delta: ReportEvent = { type: "appendix_content", id: ap.id, delta: chunk };
          onEvent?.(delta);
          yield delta;
        }
        if (retry.replace(/[#*>|`\-\[\]()\s]/g, "").length >= 300) md = retry;
      } catch (e) {
        console.error(`[report] appendix ${ap.id} thin retry failed:`, e);
      }
    }

    const aDone: ReportEvent = {
      type: "appendix_done",
      id: ap.id,
      title: ap.title,
      markdown: md || "（附录生成失败）",
    };
    onEvent?.(aDone);
    yield aDone;

    if (ai + 1 < aTotal) await new Promise((r) => setTimeout(r, 4_000));
  }

  const done: ReportEvent = { type: "all_done" };
  onEvent?.(done);
  yield done;
}
