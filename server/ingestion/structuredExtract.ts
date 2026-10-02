/**
 * Structured, clause-anchored extraction from ONE regulation document.
 *
 * Why: the three demo PDFs renumber/restructure their clauses (A splits 5.x
 * into 主功能/从属/扩展, B keeps a flat 5.x, C is English 6.x), so any
 * clause-number-based diff by the LLM is wrong. Instead we ask the LLM to
 * emit a strict, topic-anchored table per document — facts only, quoted from
 * the text — and let diffEngine compare those tables mechanically.
 *
 * One LLM call per document (each doc fits comfortably in MiniMax-M3's
 * 1M-token window). Result is cached by content hash.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { streamMiniMaxChat } from "../integrations/minimax";

export type ExtractedValue = {
  /** 参数名, e.g. 远光灯最大光强 / 闪烁频率 / 安装高度 */
  name: string;
  value: string;
  unit: string;
};

export type TopicFact = {
  /** 固定主题名（见 TOPICS），保证三份文档可对齐 */
  topic: string;
  /** 该主题在本文档中的条款号原文，如 "5.1.9.1"；没有则 "" */
  clause: string;
  /** 所在页码（从文本中的 [第N页] 标记推断，让模型引用） */
  page: string;
  /** 原文摘录 ≥30 字 —— 禁止改写、禁止假设 */
  excerpt: string;
  /** 该主题下所有 数值+单位 */
  values: ExtractedValue[];
  /** 本文档是否有此主题: "yes" | "no" | "partial" */
  presence: "yes" | "no" | "partial";
};

export type DocStructure = {
  label: string;
  fileName: string;
  docTitle: string;
  topics: TopicFact[];
};

/** Fixed topic checklist → guarantees cross-document alignment. */
export const TOPICS = [
  "远光灯", "近光灯", "前雾灯", "转向信号灯", "位置灯（前/后）", "制动灯",
  "牌照灯", "危险警告信号", "倒车灯", "昼间行驶灯DRL", "慢行灯/限速灯",
  "回复反射器", "示廓灯", "安装位置与几何可见度", "光度与色度限值",
  "闪烁频率与时间要求", "电气与试验条件", "术语与定义",
  // Table-derived topics — extracted from layout tables, not prose.
  // Each maps to a row × column block the LLM should pull verbatim.
  "光色与色度坐标表",   // GB 4785: 颜色 / 色度区域边界 / 边界交点 x,y
  "灯具光色对应表",     // GB 4785: 灯具名称 / 光色 (27 行)
  "安装高度与角度限值表", // h range × 限值 / 初始照准
  "自动切换前照灯条件表", // 附录 C: 环境光 vs 响应时间
  "追尾警告信号 Vr 表", // Vr 范围 × TTC 条件
  "试验项目与判定表",     // 试验编号 × 项目 × 判定
] as const;

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "extract-cache");
const CACHE_VERSION = "v3"; // bumped when TOPICS change or extraction strategy changes

function cacheFile(text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 24);
  return path.join(CACHE_DIR, `${CACHE_VERSION}-${hash}.json`);
}

function buildPrompt(label: string, docText: string): string {
  const topicList = TOPICS.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return `你是法规结构化提取器。下面是文档 ${label} 的完整文本（已包含从 PDF 表格里提取的 Markdown 表格块）。请**只提取原文中出现的内容，禁止假设、禁止补全、禁止改写**。

为下列 ${TOPICS.length} 个固定主题逐一提取事实：
${topicList}

对每个主题输出（缺失就填 "presence": "no"，其余字段留空字符串/空数组）：
{
  "topic": "<主题名，必须与上面清单完全一致>",
  "presence": "yes" | "no" | "partial",
  "clause": "<该主题的条款号原文，如 5.1.9.1，找不到填空串>",
  "page": "<[第N页]标记的页码，找不到填空串>",
  "excerpt": "<原文摘录，≥30字，必须逐字摘自原文（**优先从表格里提取数值**）>",
  "values": [{"name": "<参数名>", "value": "<数值>", "unit": "<单位>"}]
}

【关键要求 — 表格主题必须 100% 完整】
**对于以下 6 个表格主题，必须提取表格中的每一行作为独立 value**（不要只取第一行）：

| 表格主题 | 必须提取的内容 |
|---------|--------------|
| 光色与色度坐标表 | 颜色名（白色/黄色/琥珀色/红色/蓝绿色）→ 每行作为一个独立 value |
| 灯具光色对应表 | 灯具名（远光灯/近光灯/前雾灯/驻车灯/示廓灯 等 27 行）→ 每行一个 value |
| 安装高度与角度限值表 | 每个 h 范围（h<0.8 / 0.8-1.0 / 1.0-2.5 等）→ 每个范围一个 value |
| 自动切换前照灯条件表 | 3 行：<1000 lx、1000-7000 lx、>7000 lx → 每行一个 value |
| 追尾警告信号 Vr 表 | 4 行：vr 定义、TTC 定义、vr>30 激活条件、vr≤30 激活条件 → 每行一个 value |
| 试验项目与判定表 | 试验编号 A/B/C/D/E → 每行一个 value |

value.name 用【中文描述性短语】，包括单位在内。例如：
- 「远光灯最大光强之和」「最小离地高度」「闪烁频率」「首次熄灭时间」
- 「外界环境光<1000 lx 时近光灯响应时间」「vr>30km/h 时 TTC 激活条件」

value.value 必须从原文逐字提取，不要总结。

其他要求：
- excerpt 必须是原文片段，不得总结
- 同时输出一个 "docTitle": 文档的正式名称（标准号+标题）

严格只输出一个 JSON 对象 {"docTitle": "...", "topics": [...]}，无任何其他文字。

【文档 ${label} 全文】
${docText}`;
}

/**
 * Model output is often truncated mid-array. Walk the string tracking
 * (depth, in-string) state, cut at the last COMPLETED top-level element,
 * strip a trailing comma, and close any open containers.
 */
function repairTruncatedJson(raw: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  let lastSafe = -1; // index AFTER a completed element worth keeping
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      if (!inStr && stack.length > 0) lastSafe = i + 1;
      continue;
    }
    if (inStr) continue;
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length > 0) lastSafe = i + 1; // inner element closed, outer still open
      else if (i === raw.length - 1) lastSafe = i + 1;
    }
  }
  if (lastSafe < 0) return raw;
  let head = raw.slice(0, lastSafe).replace(/,\s*$/, "");
  // recompute open containers on the kept head and close them
  const st: string[] = [];
  let s2 = false;
  let e2 = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (e2) {
      e2 = false;
      continue;
    }
    if (ch === "\\") {
      e2 = true;
      continue;
    }
    if (ch === '"') {
      s2 = !s2;
      continue;
    }
    if (s2) continue;
    if (ch === "{") st.push("}");
    else if (ch === "[") st.push("]");
    else if (ch === "}" || ch === "]") st.pop();
  }
  return head + st.reverse().join("");
}

/**
 * Extract (with on-disk cache keyed by content hash).
 */
export async function extractStructured(label: string, fileName: string, text: string): Promise<DocStructure> {
  const cache = cacheFile(text);
  if (existsSync(cache)) {
    try {
      const parsed = JSON.parse(readFileSync(cache, "utf-8")) as DocStructure;
      console.log(`[extract] ${label} cache hit`);
      return parsed;
    } catch {
      /* fall through to re-extract */
    }
  }

  const prompt = buildPrompt(label, text);
  let buf = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    buf = "";
    for await (const chunk of streamMiniMaxChat([{ role: "user", content: prompt }], {
      temperature: 0,
      maxTokens: 32768,
    })) {
      buf += chunk;
    }

    const m = buf.match(/\{[\s\S]*\}/);
    if (m) {
      let parsed: { docTitle?: string; topics?: TopicFact[] } | null = null;
      try {
        parsed = JSON.parse(m[0]) as { docTitle?: string; topics?: TopicFact[] };
      } catch {
        try {
          parsed = JSON.parse(repairTruncatedJson(m[0])) as { docTitle?: string; topics?: TopicFact[] };
          console.log(`[extract] ${label} JSON repaired after truncation`);
        } catch (e2) {
          console.error(`[extract] ${label} attempt ${attempt + 1} invalid: ${(e2 as Error).message}`);
        }
      }
      if (parsed && Array.isArray(parsed.topics)) {
        return finish(parsed, label, fileName, cache);
      }
    } else {
      console.error(`[extract] ${label} attempt ${attempt + 1} no JSON`);
    }
  }
  throw new Error(`[${label}] extraction failed after retries`);
}

function finish(
  parsed: { docTitle?: string; topics?: TopicFact[] },
  label: string,
  fileName: string,
  cache: string,
): DocStructure {

  const structure: DocStructure = {
    label,
    fileName,
    docTitle: parsed.docTitle ?? fileName,
    topics: Array.isArray(parsed.topics)
      ? parsed.topics
          .filter((t) => t && typeof t.topic === "string")
          .map((t) => ({
            topic: t.topic,
            clause: t.clause ?? "",
            page: t.page ?? "",
            excerpt: (t.excerpt ?? "").slice(0, 600),
            values: Array.isArray(t.values) ? t.values.filter((v) => v && v.name) : [],
            presence: t.presence === "no" ? "no" : t.presence === "partial" ? "partial" : "yes",
          }))
      : [],
  };

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cache, JSON.stringify(structure), "utf-8");
  console.log(`[extract] ${label} done: ${structure.topics.length} topics, cached`);
  return structure;
}
