/**
 * **取证工具集** —— 让 agent 能自己去查，而不是让用户翻 224 页报告。
 *
 * 为什么要有这个
 * --------------
 * 现在的 `/api/agent/chat/stream` 把 system prompt + 用户消息直接丢给模型，
 * 模型**看不到项目里的任何数据** —— 它只能凭训练记忆里的 GB 4785 知识回答，
 * 或者要求用户把报告里的段落贴进来。这就是「agent 参与度」低的原因：
 * 它在**聊天**，不在**工作**。
 *
 * 给它一组**只读**工具后，它能：
 *   · 查某条条款的原文与页码（回源 PDF，不是复述）
 *   · 查某个取值在源 PDF 的哪一页
 *   · 查覆盖台账：这三条标准有没有缺口
 *   · 查差值判定：这条到底算不算变化
 *   · 查要求级台账：哪些要求没进矩阵
 *
 * 工具**全部只读**、全部**回源** —— agent 的每个结论都能指回源 PDF 的某一页。
 * 这与整个项目的原则一致：**宁可空着，不可错着**。
 *
 * 设计要点
 * --------
 * 1. **工具返回的是事实，不是检索结果**：每条都带页码与原文，
 *    agent 在回答里引用即可，不需要自己再核实。
 * 2. **没找到就说没找到**：查不到时返回明确的「未找到」，
 *    工具**不编造** —— 那是 LLM 层的事，工具层只给数据。
 * 3. **一份实现**：工具的取证逻辑与报告/闸门用同一套数据
 *    （facts.json / requirement-ledger.json / coverage-audit.json / 源 PDF）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * 内层仓库根（dist/ 与 data/ 都在那儿）。
 *
 * 这个模块有两个运行位置：
 *   · 源码 `server/reports/agentTools.ts` → 上两层是仓库根
 *   · 构建产物 `dist/agentTools.js`        → 上**一层**才是仓库根
 * 写死任何一种都会让另一半读不到 data/ —— 表现为「工具全查不到」。
 */
const ROOT = path.basename(HERE) === "dist"
  ? path.resolve(HERE, "..")
  : path.resolve(HERE, "..", "..");

type Json = Record<string, any>;

/* ------------------------------------------------------------------------- */
/* 数据加载（带缓存）                                                        */
/* ------------------------------------------------------------------------- */

let _facts: Json | null = null;
let _ledger: Json | null = null;
let _audit: Json | null = null;
let _specs: Json | null = null;
let _corpus: Json | null = null;
let _pdfPages: Record<string, string[]> | null = null;
let _clauseIndex: Json | null = null;

function readJson(rel: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  } catch {
    return null;
  }
}

function facts(): Json {
  if (!_facts) _facts = readJson("dist/facts.json") ?? {};
  return _facts;
}
function ledger(): Json {
  if (!_ledger) _ledger = readJson("data/requirement-ledger.json") ?? {};
  return _ledger;
}
function audit(): Json {
  if (!_audit) _audit = readJson("data/coverage-audit.json") ?? {};
  return _audit;
}
function specs(): Json {
  if (!_specs) {
    const raw = readJson("data/parameter-specs.json");
    // 文件是 {version, note, specs:[...]} —— 也可能是裸数组（历史格式）
    if (Array.isArray(raw)) _specs = { list: raw };
    else _specs = { list: (raw?.specs ?? []) as Json[] };
  }
  return _specs!;
}
/** 条款索引（由 scripts/export_clause_index.py 从 python 的切分器导出）。
 *  条款号在 PDF 文本层里常被拆成多行（「5.
2.
4.
2」），
 *  所以这个索引不能靠 TS 现搜 —— 必须用 python 切分器的结果。 */
function clauseIndex(): Json {
  if (!_clauseIndex) _clauseIndex = readJson("data/clause-index.json") ?? {};
  return _clauseIndex!;
}

/** 某版本的条款索引。 */
function clausesOf(v: string): Json {
  return (clauseIndex()._clauses ?? {})[v] ?? {};
}

/** 版本 → 源 PDF 的映射（由 python 按内容指纹认出，不靠文件名猜）。 */
function sourcePdfOf(v: string): { file: string; absPath: string } | null {
  const m = (clauseIndex()._sourcePdfs ?? {})[v];
  return m ? { file: m.file, absPath: m.absPath } : null;
}

function corpus(): Json {
  if (!_corpus) _corpus = readJson("dist/mineru-v4-data.json") ?? {};
  return _corpus!;
}

/** 源 PDF 的每页文本（回源取证的底座）。 */
async function pdfPages(): Promise<Record<string, string[]>> {
  if (_pdfPages) return _pdfPages;
  const out: Record<string, string[]> = {};
  for (const v of ["A", "B", "C"]) {
    // **版本 → 源 PDF 必须用 python 给的映射**。
    // 以前这里按文件名猜，三个版本会读到同一份文件 ——
    // 而 agent 的回源核实（find_quote）会因此给出**看似有页码、其实是别版**的答案。
    const src = sourcePdfOf(v);
    if (!src) continue;
    const pick = src.file;
    const abs = fs.existsSync(src.absPath) ? src.absPath : path.join(ROOT, "uploaded-docs", pick);
    if (!fs.existsSync(abs)) continue;
    try {
      // mupdf 是**纯 ESM** 包 —— require() 会抛
      // ERR_REQUIRE_ASYNC_MODULE（它的图里有顶层 await）。
      // 只能用动态 import()。
      const mupdf: any = await import("mupdf");
      const doc = mupdf.Document.openDocument(abs);
      const pages: string[] = [];
      const count = doc.countPages();
      for (let i = 0; i < count; i++) {
        const page = doc.loadPage(i);
        pages.push(page.toStructuredText("preserve-whitespace").asText());
      }
      out[v] = pages;
    } catch {
      /* 没有 PDF 绑定时，工具降级为「只有台账数据」 */
    }
  }
  _pdfPages = out;
  return out;
}

function shaOf(fileName: string): string {
  const m = fileName.match(/([0-9a-f]{12,})/);
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------------- */
/* 工具定义（OpenAI function-calling 格式）                                  */
/* ------------------------------------------------------------------------- */

export type ToolDef = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Json;
  };
};

export const AGENT_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "lookup_clause",
      description:
        "按标准代号与条款号查法规原文。A=GB 4785 草案 V4.3.5，B=GB 4785-2019，C=UN R48-09。" +
        "返回该条款的原文摘录与源 PDF 页码。查不到就返回未找到 —— 不要猜。",
      parameters: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["A", "B", "C"], description: "标准代号" },
          clause: { type: "string", description: "条款号，如 5.2.4.2、6.23.7.2、4.25b" },
        },
        required: ["version", "clause"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_quote",
      description:
        "在源 PDF 全文里找一段话出自哪一页。给一段原文摘录，返回它出现在哪些版本、哪些页。" +
        "这是回源核实用的 —— 拿到任何引文都应该用它验一遍。",
      parameters: {
        type: "object",
        properties: {
          quote: { type: "string", description: "原文摘录（≥10 字）" },
        },
        required: ["quote"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_parameter",
      description:
        "查参数矩阵里某个参数的取值与条款号。按参数名或 id 查（中文名或 camelCase id 都能查）。" +
        "返回 A/B/C 三版取值、单位、条款号与页码。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "参数名或 id，如「近光灯最大离地高度」或 headlamp.maxHeight" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diff_verdict",
      description:
        "查第 11 章差值表的逐行判定：某个参数在 A/B 两版之间到底算不算变化，" +
        "以及人工裁定的理由。按「主题|参数名」或参数名查。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "参数名，或「主题|参数名」" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_coverage_status",
      description:
        "查覆盖台账：这份报告有没有缺口。返回限值级（938 条量化限值）与" +
        "要求级（445 条要求条款）的分档统计，以及「真缺口」清单。" +
        "回答「有没有少数据」时先调它。",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["limits", "requirements", "both"],
            description: "查哪个口径（默认 both）",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_requirement_gaps",
      description:
        "列出要求级台账里**没进参数矩阵**的要求条款（处置=附录逐条），" +
        "带条款号、页码、原文与「为什么不进矩阵」的理由。" +
        "回答「这条要求报告讲了吗」时先调它。",
      parameters: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["A", "B", "C", "all"], description: "标准代号" },
          limit: { type: "number", description: "最多返回几条（默认 30）" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_topic_excerpts",
      description:
        "查某个主题的 A|B|C 三版原文摘录与页码（如「远光灯」「闪烁频率与时间要求」）。" +
        "24 个主题都查得到。",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "主题名" },
        },
        required: ["topic"],
      },
    },
  },
];

/* ------------------------------------------------------------------------- */
/* 工具执行                                                                 */
/* ------------------------------------------------------------------------- */

const VER_LABEL: Record<string, string> = {
  A: "GB 4785 草案 V4.3.5",
  B: "GB 4785-2019",
  C: "UN R48-09",
};

function norm(s: string): string {
  const P: Record<string, string> = {
    "，": ",", "；": ";", "：": ":", "、": ",", "（": "(", "）": ")",
    "。": ".", "．": ".", "～": "~", "–": "-", "—": "-",
  };
  let t = (s ?? "").replace(/\s+/g, "");
  for (const [a, b] of Object.entries(P)) t = t.split(a).join(b);
  return t.toLowerCase();
}

function findQuoteInPages(quote: string, pages: string[]): number[] {
  const q = norm(quote);
  if (q.length < 2) return [];
  const hits: number[] = [];
  // 探针阶梯。**每一档都必须 ≤ 引文长度** —— 否则整档被跳过。
  // 旧代码是 `[24,18,14,10]` 且 `if (q.length < L) continue`：
  // 引文不足 10 字时四档全跳过 → 直接返回「查不到」。
  // 而「查不到」在报告里会被当成「原文里没有这条」——
  // 这正是本项目最贵的一类 bug（宁可空着，不可错着，反过来也不可「错着说没有」）。
  let ladder = [24, 18, 14, 10].filter((L) => L <= q.length);
  if (!ladder.length) ladder = [q.length]; // 短引文：整段必须连续出现
  for (let i = 0; i < pages.length; i++) {
    const pt = norm(pages[i]);
    for (const L of ladder) {
      let ok = false;
      for (let s = 0; s <= Math.max(0, q.length - L); s += Math.max(1, L >> 2)) {
        if (pt.includes(q.slice(s, s + L))) { ok = true; break; }
      }
      if (ok) { hits.push(i + 1); break; }
    }
  }
  return hits;
}

/**
 * 关键词级的**精确**命中 —— 与 `findQuoteInPages` 的语义不同。
 *
 * 引文命中用的是「一段连续片段」，关键词要的是「这个词本身在不在」。
 * 所以这里只做整串包含，不做片段窗口。
 *
 * 最短 3 字：2 字中文（如「光」）几乎每页都有，报出来只是噪声。
 */
function findKeywordInPages(kw: string, pages: string[]): number[] {
  const k = norm(kw);
  if (k.length < 3) return [];
  const hits: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (norm(pages[i]).includes(k)) hits.push(i + 1);
  }
  return hits;
}

/**
 * 从一段话里切出**概念关键词** —— 连续的中文/英文词块。
 *
 * 用途：整段引文在原文里**不连续命中**时（LLM 转述过、或摘录跨了两处），
 * 逐个关键词查还能定位到页。查不到就说明这个概念**根本不在**原文里。
 */
function keywordsOf(quote: string): string[] {
  const runs = (quote ?? "").match(/[一-鿿]{2,}|[A-Za-z][A-Za-z-]{2,}/g) ?? [];
  const out: string[] = [];
  for (const r of runs) {
    if (/[一-鿿]/.test(r)) {
      // 短词块本身就是术语（「光通维持率」），整段保留
      if (r.length <= 8) out.push(r);
      // 再切 3 字窗，覆盖长句（LLM 转述时整段对不上）
      for (let i = 0; i + 3 <= r.length; i += 2) out.push(r.slice(i, i + 3));
    } else {
      out.push(r);
    }
  }
  return [...new Set(out)].slice(0, 10);
}

export type ToolResult = { ok: boolean; data: Json; note?: string };

export async function runAgentTool(name: string, args: Json): Promise<ToolResult> {
  switch (name) {
    /* ---------------------------------------------------------------- */
    case "lookup_clause": {
      const v = String(args.version ?? "").toUpperCase();
      const clause = String(args.clause ?? "").trim();
      if (!v || !clause) {
        return { ok: false, data: { error: "需要 version 与 clause" } };
      }
      const out: Json = { version: v, label: VER_LABEL[v] ?? v, clause };
      // 1) **条款索引**（python 切分器导出的）—— 最权威的一份
      const idx = clausesOf(v);
      const hit = idx[clause];
      const found: Json[] = [];
      if (hit) {
        found.push({
          source: "clause-index",
          excerpt: String(hit.body ?? "").replace(/\s+/g, " ").trim().slice(0, 400),
          head: hit.head,
          page: hit.page ? `第${hit.page}页` : null,
        });
      }
      // 1b) 主题列里同名条款的摘录（核验过的，带核验状态）
      for (const t of facts().topicColumns ?? []) {
        const col = t?.[v];
        if (!col) continue;
        if (String(col.clause ?? "") === clause) {
          found.push({
            source: "topic-column",
            topic: t.topic,
            excerpt: col.excerpt,
            page: col.actualPage,
            status: col.status,
          });
        }
      }
      if (found.length) {
        out.matches = found;
      } else {
        // 2) 退到要求级台账（每一条要求条款都有原文与页码）
        const rows = (ledger().rows ?? []).filter(
          (r: Json) => r.version === v && String(r.clause) === clause,
        );
        // 2b) 条款号写错时，给出**最接近**的候选（编辑距离）——
        //     agent 常把「5.2.4.2」写成「5.2.4」或「5.2.4.2.1」
        if (!rows.length) {
          const near = Object.keys(idx)
            .filter((k) => k.startsWith(clause) || clause.startsWith(k))
            .slice(0, 8);
          if (near.length) {
            out.nearbyClauses = near.map((k) => ({
              clause: k,
              page: idx[k].page ? `第${idx[k].page}页` : null,
              head: String(idx[k].head ?? "").slice(0, 120),
            }));
          }
        }
        if (rows.length) {
          out.matches = rows.map((r: Json) => ({
            topic: r.head,
            excerpt: r.excerpt,
            page: r.page ? `第${r.page}页` : null,
            status: r.disposition,
            reason: r.reason,
          }));
        } else {
          // 3) 再退到报告正文里找这个条款号的上下文
          const rep = readJson("reports/last-report.json");
          const body = String(rep?.chapters?.[0]?.markdown ?? "");
          out.matches = [];
          out.note =
            `未在条款索引/要求台账里找到 ${v} §${clause}。` +
            (body ? "（报告正文里有引用，但不在结构化索引里 —— 建议改用 find_quote 按原文查）" : "");
          return { ok: false, data: out };
        }
      }
      return { ok: true, data: out };
    }

    /* ---------------------------------------------------------------- */
    case "find_quote": {
      const quote = String(args.quote ?? "");
      if (quote.length < 4) {
        return { ok: false, data: { error: "摘录太短（≥4 字）" } };
      }
      const pages = await pdfPages();
      const out: Json = { quote, hits: [], keywords: [] };

      // 1) 整段连续命中
      for (const v of ["A", "B", "C"]) {
        const p = pages[v];
        if (!p) continue;
        const hit = findQuoteInPages(quote, p);
        if (hit.length) {
          out.hits.push({
            version: v,
            label: VER_LABEL[v],
            pages: hit.map((n) => `第${n}页`),
            pageNumbers: hit,
          });
        }
      }

      // 2) **关键词命中** —— 整段找不到时，逐个关键词查。
      //    这一步是关键：没有它，agent 只能反复改写引文碰运气，
      //    把取证轮数耗光还没结论。
      //    有了它，「这个概念在原文里根本没有」是一步就能确认的事实。
      const totalPages = Math.max(
        1,
        ...["A", "B", "C"].map((v) => (pages[v]?.length ?? 0)),
      );
      const kw = keywordsOf(quote);
      for (const k of kw) {
        const where: Json[] = [];
        let hitCount = 0;
        for (const v of ["A", "B", "C"]) {
          const p = pages[v];
          if (!p) continue;
          const pn = findKeywordInPages(k, p);
          if (pn.length) {
            hitCount += pn.length;
            where.push({ version: v, label: VER_LABEL[v], pages: pn.slice(0, 6) });
          }
        }
        // **区分度**：一个词在几乎每一页都出现（「信号」「车辆」），
        // 命中它说明不了任何事 —— 判定「原文里没有」只能靠**有区分度**的词。
        const ratio = hitCount / totalPages;
        out.keywords.push({
          keyword: k,
          found: where.length > 0,
          hitCount,
          distinctive: where.length === 0 || ratio < 0.25,
          where,
        });
      }

      // 判定只看**有区分度**的关键词：命中一片的常用词不算证据。
      const distinctive = (out.keywords as Json[]).filter((k: Json) => k.distinctive);
      const judged = distinctive.length ? distinctive : (out.keywords as Json[]);
      const hitList = judged.filter((k: Json) => k.found);
      // **过半才算「有」** —— 一两个 3 字窗口的偶然命中说明不了概念存在。
      //（「不存在」这种词在标准里也真的出现过；只看「有没有一个词命中」会得出
      //   完全相反的结论。）
      const majority = hitList.length > judged.length / 2;
      const anyCommonHit = (out.keywords as Json[]).some(
        (k: Json) => k.found && !k.distinctive,
      );

      if (!out.hits.length && !majority) {
        out.note =
          "这段话在源 PDF 的三版里**都找不到**（整段不命中，关键词也未过半命中）。" +
          "结论：这三条标准里没有这段内容 —— 引用前请核对是不是转述而非原文。" +
          (hitList.length
            ? `（偶然命中的片段：${hitList.map((k: Json) => `「${k.keyword}」`).join("、")}——` +
              "不足以说明该内容存在。）"
            : anyCommonHit
              ? "（命中的都是「信号」「车辆」这类到处都是的常用词，不构成证据。）"
              : "");
        return { ok: false, data: out };
      }
      if (!out.hits.length) {
        out.note =
          "整段不连续命中，但**多数关键词**在原文里有（见 keywords）。" +
          "这通常意味着引文是**转述**而非逐字原文 —— 请用关键词定位页码后再回原文核对。";
      }
      return { ok: true, data: out };
    }

    /* ---------------------------------------------------------------- */
    case "lookup_parameter": {
      const q = String(args.name ?? "").trim();
      const list = Array.isArray(specs().list) ? specs().list : [];
      const lower = q.toLowerCase();
      const hit =
        list.find((s: Json) => String(s.id).toLowerCase() === lower) ??
        list.find((s: Json) => String(s.name ?? "").includes(q)) ??
        list.find((s: Json) => lower && String(s.name ?? "").toLowerCase().includes(lower));
      if (!hit) {
        return {
          ok: false,
          data: { error: `参数矩阵里没有「${q}」`, hint: "参数名用中文，如「近光灯最大离地高度」" },
        };
      }
      const f = facts();
      // 从报告的矩阵里取三版取值（facts 里没有矩阵行，取 last-report）
      const rep = readJson("reports/last-report.json");
      const rows = rep?.parameterMatrix ?? [];
      const row = rows.find((r: Json) => String(r.id) === String(hit.id));
      const cells: Json = {};
      for (const v of ["A", "B", "C"]) {
        const c = row?.cells?.[v];
        if (!c) continue;
        cells[v] = {
          value: c.nums?.length ? c.nums.join(" / ") : (c.value ?? null),
          unit: c.unit ?? hit.unit ?? null,
          clause: c.clause ?? null,
          page: c.actualPage ?? c.page ?? null,
          status: c.status ?? null,
        };
      }
      return {
        ok: true,
        data: {
          id: hit.id,
          name: hit.name,
          family: hit.family,
          unit: hit.unit,
          cells,
          note: cells.C ? undefined : "C 列未定位到取值（见报告第 12 章的定位失败清单）",
        },
      };
    }

    /* ---------------------------------------------------------------- */
    case "get_diff_verdict": {
      const q = String(args.name ?? "").trim();
      const vd = facts().diffVerdicts ?? {};
      const entries = Object.entries(vd as Record<string, Json>);
      const hit =
        entries.find(([k]) => k === q) ??
        entries.find(([k]) => k.endsWith(`|${q}`)) ??
        entries.find(([k]) => k.split("|")[1] === q) ??
        entries.find(([k]) => k.includes(q));
      if (!hit) {
        return { ok: false, data: { error: `差值表里没有「${q}」`, hint: "用「主题|参数名」或参数名" } };
      }
      const [key, v] = hit;
      return {
        ok: true,
        data: {
          key,
          topic: v.topic,
          name: v.name,
          verdict: v.verdict,
          reason: v.reason,
          oldValue: v.oldValue,
          newValue: v.newValue,
          aClause: v.aClause,
          bClause: v.bClause,
        },
      };
    }

    /* ---------------------------------------------------------------- */
    case "get_coverage_status": {
      const scope = String(args.scope ?? "both");
      const out: Json = {};
      if (scope === "limits" || scope === "both") {
        const a = audit();
        out.limits = {
          total: a.totals?.limits ?? a.limits ?? null,
          missing: a.totals?.missing ?? a.missing ?? null,
          same: a.totals?.same ?? null,
          otherChapter: a.totals?.otherChapter ?? null,
          general: a.totals?.general ?? null,
          otherDevice: a.totals?.otherDevice ?? null,
        };
        out.limitsNote =
          "限值级口径：统计单位是**一条可量化的限值**（解析器 limit_scan 认得出的那些）。" +
          "「真缺口」= 这些限值里没有在报告里找到出处的。";
      }
      if (scope === "requirements" || scope === "both") {
        const t = ledger().totals ?? {};
        out.requirements = {
          total: t.requirements ?? 0,
          covered: t.covered ?? 0,
          appendixListed: t.appendixListed ?? 0,
          quoted: t.quoted ?? 0,
          weak: t.weak ?? 0,
          notApplicable: t.notApplicable ?? 0,
          gaps: t.gaps ?? 0,
        };
        out.requirementsNote =
          "要求级口径：统计单位是**一条要求条款**（含「应当/必须/不得/shall」等要求语）。" +
          "六档处置：已覆盖（报告明确引用）/ 附录逐条（E.5.1 列出原文+页码+理由）/" +
          "已引原文（正文随长摘录带入）/ 同章别处（弱）/ 不适用（登记理由）/ 真缺口。";
      }
      out.source = "data/requirement-ledger.json · data/coverage-audit.json（scripts 现算，非手写）";
      return { ok: true, data: out };
    }

    /* ---------------------------------------------------------------- */
    case "list_requirement_gaps": {
      const v = String(args.version ?? "all").toUpperCase();
      const limit = Math.max(1, Math.min(200, Number(args.limit ?? 30)));
      const rows = (ledger().rows ?? []).filter(
        (r: Json) => r.disposition === "附录逐条" && (v === "ALL" || r.version === v),
      );
      return {
        ok: true,
        data: {
          count: rows.length,
          shown: Math.min(limit, rows.length),
          items: rows.slice(0, limit).map((r: Json) => ({
            version: r.version,
            label: VER_LABEL[r.version] ?? r.version,
            clause: r.clause,
            page: r.page ? `第${r.page}页` : null,
            excerpt: r.excerpt,
            why: r.reason,
          })),
          note: "这些是**定性要求** —— 没有可压缩的标量（不是安装高度、不是光强、不是频率），" +
            "所以不进第 12 章的参数矩阵，而是在这里逐条列出原文与页码。" +
            "报告的附录 E.5.1 有完整清单。",
        },
      };
    }

    /* ---------------------------------------------------------------- */
    case "get_topic_excerpts": {
      const q = String(args.topic ?? "").trim();
      const cols = facts().topicColumns ?? [];
      const hit = cols.find((t: Json) => String(t.topic).includes(q) || q.includes(String(t.topic)));
      if (!hit) {
        const names = cols.map((t: Json) => t.topic);
        return {
          ok: false,
          data: { error: `没有主题「${q}」`, available: names },
        };
      }
      const out: Json = { topic: hit.topic, versions: {} };
      for (const v of ["A", "B", "C"]) {
        const c = hit[v];
        if (!c) continue;
        out.versions[v] = {
          label: VER_LABEL[v],
          clause: c.clause,
          page: c.actualPage,
          status: c.status,
          excerpt: c.excerpt,
        };
      }
      return { ok: true, data: out };
    }

    default:
      return { ok: false, data: { error: `未知工具：${name}` } };
  }
}

/** 给模型看的工具清单（去掉内部字段）。 */
export function toolSchemas(): ToolDef[] {
  return AGENT_TOOLS;
}
