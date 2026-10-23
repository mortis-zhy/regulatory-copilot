/**
 * **取值规格提议 agent** —— 让「加一版标准 / 加一个参数」不再等于「手写一条正则」。
 *
 * 为什么要有这个
 * --------------
 * `data/parameter-specs.json` 里现在有 **305 个参数 × 3 版 = 788 条手写正则**。
 * 每一条都要人读原文、找到条款号、把值框进捕获组、记下为什么不能写得更简单。
 * 这套东西**准确**（每条都回原文核过），但它是**泛化性的天花板**：
 * 换一套标准、换一个版本，就要重写一遍。
 *
 * 三层结构
 * --------
 * ```
 *   ① 确定性候选层（无模型）   ② 模型选择层（有模型）   ③ 校验层（无模型）
 *   从语料里把这个装置、这个     在候选句里挑出值，       用与抽取器**完全相同**
 *   版本、这个参数族的带数值     产出条款锚定的正则       的语义跑一遍：命中？
 *   句子捞出来（带条款号页码）                              捕获组框到值了吗？
 *                                                         落在对的章吗？
 * ```
 *
 * ① 与 ③ 是**泛化性的关键**：它们不知道「近光灯最大离地高度」是什么，
 * 只知道「这个装置的章里有带数字的句子」。换一套标准时，
 * 要改的只有「哪个装置对应哪一章」那一张映射表 —— 也就是
 * `data/r48-chapter-map.json` 那种表。
 *
 * ② 只在「一句话是不是这个参数的值」这种语义判断上用模型，
 * 而且**模型的产物必须过 ③**。模型说的每一句都不算数，
 * 语料说的才算 —— 这是本项目一贯的口径（「宁可空着，不可错着」）。
 *
 * 为什么第 ③ 层必须**逐字复用**抽取器的实现
 * ------------------------------------------
 * `locate()` 是**按页扫描**的：它一页一页试，**第一个命中的页就是结果**。
 * 所以一条正则如果在更早的某一页也能命中（哪怕是别的章的句子），
 * 抽取器就会取出错的值 —— 「值对、条款错」是这里最贵的一类 bug。
 * 校验层因此必须复刻「第一页命中」这个语义，而不是「能不能在全文命中」。
 */
import { numbersOf, nearestClause, paginate } from "./parameterMatrix";

export type Version = string;

export interface SpecSlot {
  /** 参数 id（`data/parameter-specs.json` 里的 id） */
  id: string;
  /** 参数中文名 */
  name: string;
  /** 参数族 */
  family: string;
  /** 单位 */
  unit: string;
  /** 标准代号 A / B / C */
  version: Version;
  /** 装置前缀（id 的第一段） */
  device: string;
}

export interface Candidate {
  clause: string;
  page: number;
  sentence: string;
  /** 句子里抽出来的数字（已按单位的口径归一） */
  nums: string[];
  /** 是否带该参数的单位 —— 带单位的候选优先 */
  hasUnit: boolean;
}

export interface Proposal {
  id: string;
  version: Version;
  device: string;
  name: string;
  /** 正则源码 —— 模型产出的条款锚定正则 */
  source?: string;
  flags?: string;
  /** 模型自己写的理由（为什么这么写 / 为什么该版没有这条） */
  why?: string;
  /** 模型判定「该版确实没有这条规定」 */
  absent?: string;
  /** 出错时的说明 */
  error?: string;
}

export interface Validation {
  ok: boolean;
  reason?: string;
  /** 抽取器实际会取到的值 */
  nums?: string[];
  /** 抽取器实际会引用的条款 */
  clause?: string;
  /** 抽取器实际会标注的页码 */
  page?: number;
  /** 整份语料里**所有**命中页（第一个才是抽取器会用的） */
  hitPages?: number[];
}

/* -------------------------------------------------------------------------- */
/* ① 确定性候选层                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 这个装置在这一版里对应哪几章。
 *
 * **从已有的手写正则里反推**，不另建映射表 ——
 * 同一个装置前缀的兄弟参数里，凡是在这一版有正则的，
 * 它的条款号前两段就是这个装置在这一版的章。
 * （GB 是「5.13 示廓灯」这种两段，R48 是「6.13 End-outline marker」也是两段。）
 *
 * 这样做的理由：**装置↔章的对应关系本来就已经写在数据里了**，
 * 再建一张表就是第二个真相来源。而且这张表是**自校准**的 ——
 * 手写正则改了，这里跟着变。
 */
export function deviceChapterPrefixes(
  specs: Array<{ id: string; patterns?: Record<string, { source?: string }> }>,
  device: string,
  version: Version,
): string[] {
  const counts = new Map<string, number>();
  for (const s of specs) {
    if (s.id.split(".")[0] !== device) continue;
    const src = s.patterns?.[version]?.source;
    if (!src) continue;
    // 正则源码里的条款锚点形如 `5\\.13\\.4\\.2`（点被转义了）
    const m = String(src).match(/^\s*(\d+(?:\\?\.\d+)+)/);
    if (!m) continue;
    const clause = m[1].replace(/\\/g, "");
    const parts = clause.split(".");
    if (parts.length < 2) continue;
    const prefix = parts.slice(0, 2).join(".");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  if (!counts.size) return [];
  // **只保留占多数的章**。
  //
  // 同一个 id 前缀里偶尔混进一条**别的灯**的规格 ——
  // `dippedBeam.offRoadHeightOnly` 的中文名其实是「前雾灯越野车型放宽高度」，
  // 锚在 A 5.4.4.2 / B 5.3.4.2 / C 6.3.4.2 —— **前雾灯的章**。
  // 它的取值和条款都是对的（只是归错了 id 前缀），但把它算进近光灯的章，
  // 候选句就会混进前雾灯的条文，agent 很可能挑错灯 ——
  // 那正是这个项目最贵的一类错（值对、条款错）。
  const max = Math.max(...Array.from(counts.values()));
  return Array.from(counts.entries())
    .filter(([, n]) => n === max)
    .map(([p]) => p)
    .sort();
}

/** 一句话里带数字吗。 */
function hasNumber(s: string): boolean {
  return /\d/.test(s);
}

/**
 * 这个句子里带这个单位吗。
 *
 * 单位表是**按语义族**给的，不是一个单位一个字符串 ——
 * 频率在 R48 里写 Hz、在 GB 里写「次/分钟」，电压写 V/V，
 * 角度写 °/度/cd·m⁻² 之类。写死一种写法，候选就会大面积漏掉。
 */
const UNIT_WORDS: Record<string, RegExp> = {
  mm: /\d\s*(?:mm|㎜|毫米|m(?![mA-Za-z]))/i,
  cm: /\d\s*(?:cm|厘米)/i,
  cd: /\d\s*(?:cd|坎德拉)/i,
  lx: /\d\s*(?:lx|勒克斯)/i,
  lm: /\d\s*(?:lm|流明)/i,
  "°": /\d\s*(?:°|度)/,
  Hz: /\d\s*(?:hz|赫兹|次\/分|次每分钟|闪\/分)/i,
  s: /\d\s*(?:s\b|秒)/i,
  V: /\d\s*v\b/i,
  A: /\d\s*a\b/i,
  "km/h": /\d\s*(?:km\s*\/\s*h|公里\/小时)/i,
  "%": /\d\s*%/,
};

export function unitRegex(unit: string): RegExp | null {
  return UNIT_WORDS[unit] ?? null;
}

/**
 * 候选句 —— 从条款索引里把这个装置这一版的、带数字的句子捞出来。
 *
 * 用的是 `data/clause-index.json`（`scripts/export_clause_index.py` 的产物），
 * 不是原始 MinerU 文本：条款索引已经把条款号和页码切好了，
 * 候选句自带「条款号 + 页码」，模型不用猜自己在读哪一条。
 */
export function candidateSentences(
  clauseIndex: Record<string, Record<string, { page?: number; body?: string }>>,
  version: Version,
  prefixes: string[],
  opts: { unit?: string; limit?: number; onlyWithUnit?: boolean } = {},
): Candidate[] {
  const clauses = clauseIndex[version] ?? {};
  const unitRe = opts.unit ? unitRegex(opts.unit) : null;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const [clause, info] of Object.entries(clauses)) {
    if (!prefixes.some((p) => clause === p || clause.startsWith(p + "."))) continue;
    const body = String(info.body ?? "");
    if (!body) continue;
    // 按句切：中文句号/分号/换行，以及 a) b) 这类列举项
    const parts = body
      .split(/(?<=[。；;])|\n+|(?=\s*[a-z]\)\s)/)
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const raw of parts) {
      const sentence = raw.length > 260 ? raw.slice(0, 260) + "…" : raw;
      if (!hasNumber(sentence)) continue;
      const key = clause + "|" + sentence.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      const nums = numbersOf(sentence, opts.unit);
      if (!nums.length) continue;
      const hasUnit = unitRe ? unitRe.test(sentence) : true;
      if (opts.onlyWithUnit && !hasUnit) continue;
      out.push({ clause, page: Number(info.page ?? 0), sentence, nums, hasUnit });
    }
  }
  // 带单位的排前面，其余按条款号排
  out.sort((a, b) => (b.hasUnit ? 1 : 0) - (a.hasUnit ? 1 : 0));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/* -------------------------------------------------------------------------- */
/* ③ 校验层                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 用**抽取器完全相同的语义**跑一遍这条正则。
 *
 * `locate()` 的语义（`server/reports/parameterMatrix.ts`）：
 *   · **按页扫描**，第一个命中的页就是结果 —— 不是全文里第一个命中；
 *   · 捕获组 1 才是「值」，没有捕获组就拿整个匹配当值；
 *   · 页码与条款号从**命中位置所在页**取。
 *
 * 这里逐条复刻，并把「第一页命中落在哪个章」当成硬条件：
 * 一条正则如果在更早的别的章也能命中，抽取器就会取出错的值 ——
 * 那是最贵的一类 bug（值对、条款错）。
 */
export function validateProposal(
  proposal: Proposal,
  doc: any,
  prefixes: string[],
  opts: { unit?: string } = {},
): Validation {
  if (proposal.absent) {
    return { ok: true, reason: "该版无此规定（模型判定，需人工确认）" };
  }
  const source = String(proposal.source ?? "").trim();
  if (!source) return { ok: false, reason: "没有产出正则" };
  let re: RegExp;
  try {
    re = new RegExp(source, (proposal.flags ?? "i").replace("g", ""));
  } catch (e) {
    return { ok: false, reason: `正则编译失败：${(e as Error).message}` };
  }

  const pages = paginate(doc);
  const hitPages: number[] = [];
  let first: { page: number; text: string; m: RegExpExecArray } | null = null;
  for (const [page, text] of pages) {
    const rx = new RegExp(re.source, re.flags.replace("g", ""));
    const m = rx.exec(text);
    if (!m) continue;
    hitPages.push(page);
    if (!first) first = { page, text, m };
  }
  if (!first) {
    return { ok: false, reason: "在语料里一条页都没命中 —— 条款锚点多半写错了", hitPages };
  }

  // 第一页命中必须落在这个装置的章里
  const firstClause = nearestClause(first.text, first.m.index);
  const inChapter = prefixes.some((p) => firstClause === p || firstClause.startsWith(p + "."));
  if (!inChapter) {
    return {
      ok: false,
      reason:
        `第一页命中落在 §${firstClause || "?"}，不在本装置的章（${prefixes.join("/") || "?"}）里 —— ` +
        "抽取器取的是**第一页命中**，会取到别的章的值",
      hitPages,
    };
  }

  const focus = first.m.length > 1 && first.m[1] != null ? first.m[1] : first.m[0];
  const nums = numbersOf(focus, opts.unit);
  if (!nums.length) {
    return {
      ok: false,
      reason: `捕获组框到的不是值（捕获到「${String(focus).slice(0, 50)}」）—— 数字在框外`,
      hitPages,
    };
  }

  // 命中页过多 = 正则太松，早晚会命中别的东西
  const maxHits = 3;
  if (hitPages.length > maxHits) {
    return {
      ok: false,
      reason: `在 ${hitPages.length} 页上命中（上限 ${maxHits}）—— 正则太松，多半会抓到别的条款`,
      hitPages,
    };
  }

  return {
    ok: true,
    nums,
    clause: firstClause,
    page: first.page,
    hitPages,
  };
}

/* -------------------------------------------------------------------------- */
/* ② 模型选择层（含工具调用循环）                                             */
/* -------------------------------------------------------------------------- */

/** agent 需要的上下文：条款索引 + 语料 + 「装置→章」的推导 + 候选句。 */
export interface SpecAgentCtx {
  clauseIndex: Record<string, Record<string, { page?: number; body?: string }>>;
  /** 某一版的 MinerU 文档（`{fullText}`）—— `test_regex` 要用 */
  docFor(version: Version): any;
  prefixesFor(device: string, version: Version): string[];
  candidatesFor(device: string, version: Version, prefixes: string[]): Candidate[];
}

/** 一次模型调用的结果。`call` 由调用方注入（真实 MiniMax 或假模型）。 */
export interface ModelReply {
  /** 去掉 `<think>` 之后的正文 */
  content: string;
  /** 原始正文（含思考）—— 只用于排查 */
  raw?: string;
  toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: any }; name?: string; args?: any }>;
  /** `length` = 回答被截断（思考吃光了预算） */
  finishReason?: string;
}

export type ModelCaller = (messages: any[], tools: any[]) => Promise<ModelReply>;

/**
 * 剥掉 `<think>…</think>`。
 *
 * MiniMax-M3 会把整段思考**写在 content 里**（不是单独的 reasoning_content），
 * 而且思考与答案共用 max_tokens —— 思考吃光预算时，JSON 根本没输出。
 * 剥掉它有两个好处：解析 JSON 时不会先撞上思考里的 `{`；
 * 工具调用的文本标记解析也不会被思考里的括号带偏。
 */
export function stripThink(text: string): string {
  return String(text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * 从正文里的文本标记里抠出工具调用。
 *
 * MiniMax 偶尔只把工具调用写进 content（不带 `tool_calls` 字段），
 * 形态形如 `<invoke name="get_clause_text">{…}</invoke>`。
 */
export function toolCallsFromContent(content: string): Array<{ id: string; name: string; args: any }> {
  const out: Array<{ id: string; name: string; args: any }> = [];
  const re = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    let args: any = {};
    try {
      args = JSON.parse(m[2].trim());
    } catch {
      args = {};
    }
    out.push({ id: `call_${out.length}`, name: m[1], args });
  }
  return out;
}

export const SPEC_AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "test_regex",
      description:
        "**把你写的正则放到真实语料上跑一遍**，返回抽取器会取到的值、条款号、页码，" +
        "以及为什么没过。这是抽取器用的**同一套语义**（逐页扫描、只读第 1 个捕获组）。" +
        "写完正则先用它验一遍；没过就按它给的理由改，直到通过。",
      parameters: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["A", "B", "C"] },
          source: { type: "string", description: "正则源码" },
          flags: { type: "string", description: "正则标志，默认 i" },
          device: { type: "string", description: "装置前缀（如 dippedBeam），用来核对条款落在哪个章" },
          unit: { type: "string", description: "参数单位（如 mm、°），用于判定捕获组框到的是不是值" },
        },
        required: ["version", "source", "device"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_clause_text",
      description: "读某个版本某一条款的完整原文（带页码）。候选句被截断时用它看全文。",
      parameters: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["A", "B", "C"] },
          clause: { type: "string", description: "条款号，如 5.13.4.2" },
        },
        required: ["version", "clause"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_more_candidates",
      description: "这个装置在这个版本下的更多候选句（接着上一批往后翻）。",
      parameters: {
        type: "object",
        properties: {
          version: { type: "string", enum: ["A", "B", "C"] },
          device: { type: "string", description: "装置前缀，如 dippedBeam" },
          offset: { type: "number", description: "从第几条开始（0 起）" },
          limit: { type: "number", description: "要几条（默认 30）" },
        },
        required: ["version", "device"],
      },
    },
  },
];

function runAgentTool(ctx: SpecAgentCtx, name: string, a: any): any {
  if (name === "test_regex") {
    const v = String(a?.version ?? "");
    const source = String(a?.source ?? "");
    const flags = String(a?.flags ?? "i");
    const device = String(a?.device ?? "");
    const unit = a?.unit ? String(a.unit) : undefined;
    const prefixes = ctx.prefixesFor(device, v);
    const doc = ctx.docFor(v);
    if (!doc) return { error: `没有 ${v} 版的语料` };
    const val = validateProposal(
      { id: "test", version: v, device, name: "test", source, flags },
      doc,
      prefixes,
      { unit },
    );
    return {
      ok: val.ok,
      reason: val.reason ?? null,
      clause: val.clause ?? null,
      page: val.page ?? null,
      nums: val.nums ?? [],
      hitPages: val.hitPages ?? [],
      note:
        "ok=true 表示抽取器会取到上面的值；" +
        "nums 为空说明捕获组没框到值；" +
        "clause 不对说明抓错条款了。",
    };
  }
  if (name === "get_clause_text") {
    const v = String(a?.version ?? "");
    const cl = String(a?.clause ?? "").trim();
    const hit = ctx.clauseIndex[v]?.[cl];
    if (!hit) return { error: `没找到 ${v} §${cl}` };
    return { version: v, clause: cl, page: hit.page ?? 0, body: String(hit.body ?? "").slice(0, 4000) };
  }
  if (name === "get_more_candidates") {
    const v = String(a?.version ?? "");
    const dev = String(a?.device ?? "");
    const prefixes = ctx.prefixesFor(dev, v);
    const all = ctx.candidatesFor(dev, v, prefixes);
    const off = Number(a?.offset ?? 0) || 0;
    const lim = Number(a?.limit ?? 30) || 30;
    return {
      version: v,
      device: dev,
      total: all.length,
      offset: off,
      candidates: all.slice(off, off + lim).map((c) => ({
        clause: c.clause,
        page: c.page,
        sentence: c.sentence,
      })),
    };
  }
  return { error: `未知工具 ${name}` };
}

/**
 * 跑一个完整的 agent 回合（带工具调用），返回模型的最终文本。
 *
 * 循环规则：模型返回工具调用 → 执行 → 结果回灌 → 继续；最多 5 轮。
 * 收口轮**不发 `tools` 字段** —— MiniMax 的 `tool_choice:"none"` 不生效，
 * 发了它照样会把工具调用写进正文。
 */
export async function runSpecAgent(
  ctx: SpecAgentCtx,
  slot: SpecSlot,
  candidates: Candidate[],
  call: ModelCaller,
  opts: { maxRounds?: number } = {},
): Promise<string> {
  // 轮次预算：写 → 验 → 改 → 验 → 答，至少 5 轮；给到 8 轮留余量。
  const maxRounds = opts.maxRounds ?? 8;
  const user = [
    `参数：**${slot.name}**`,
    `参数族：${slot.family}`,
    `单位：${slot.unit}`,
    `标准：**${slot.version}**`,
    `装置前缀：${slot.device}`,
    "",
    "候选原文句（每条带条款号与页码）：",
    formatCandidates(candidates, 40),
    "",
    "如果候选句不够，用 get_clause_text 读完整条款，用 get_more_candidates 往后翻。",
    "写完正则**务必用 test_regex 验一遍**（version / source / device / unit），",
    "不过就按它给的理由改，再验。确认通过后，只输出一个 JSON 对象（source/flags/why 或 absent）。",
  ].join("\n");

  const messages: any[] = [
    { role: "system", content: SPEC_AGENT_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];

  let lastAssistant = "";
  for (let round = 0; round < maxRounds; round++) {
    const r = await call(messages, round < maxRounds - 1 ? SPEC_AGENT_TOOLS : []);
    const content = stripThink(r.content ?? "");
    let calls = (r.toolCalls ?? []).map((c) => ({
      id: c.id ?? `call_${c.function?.name ?? "x"}`,
      name: c.function?.name ?? c.name ?? "",
      args: safeArgs(c.function?.arguments ?? c.args),
    }));
    if (!calls.length) calls = toolCallsFromContent(content);
    if (!calls.length) {
      // 空回答 + finish_reason=length = **被截断**（思考吃光了预算）。
      // 这不是「模型不会」，是预算问题 —— 要说清楚，别报成别的错。
      if (!content && r.finishReason === "length") return "__TRUNCATED__ ";
      return content;
    }
    messages.push({
      role: "assistant",
      content,
      ...(r.toolCalls?.length ? { tool_calls: r.toolCalls } : {}),
    });
    lastAssistant = content;
    for (const c of calls) {
      const out = runAgentTool(ctx, c.name, c.args ?? {});
      messages.push({
        role: "tool",
        tool_call_id: c.id,
        name: c.name,
        content: JSON.stringify(out).slice(0, 6000),
      });
    }
  }
  // 轮次用完还没给出答案 —— 返回**模型最后的正文**（可能是空）。
  // 不能返回最后一条消息：那是工具结果，会被当成答案解析。
  return lastAssistant;
}

function safeArgs(a: any): any {
  if (a && typeof a === "object") return a;
  try {
    return JSON.parse(String(a ?? "{}"));
  } catch {
    return {};
  }
}

/** 候选句给模型看的样子。 */
export function formatCandidates(candidates: Candidate[], limit = 40): string {
  return candidates
    .slice(0, limit)
    .map(
      (c, i) =>
        `${i + 1}. [${c.clause} · 第${c.page}页] ${c.sentence}` +
        `${c.hasUnit ? "" : "   ←（该句没有本参数的单位，可能不是值）"}`,
    )
    .join("\n");
}

export const SPEC_AGENT_SYSTEM_PROMPT = `你是一个**法规取值抽取**助手。任务：为某个参数在某个标准版本里，
写出一条**能稳定抽取取值的正则**。

# 输入
- 参数中文名、参数族、单位
- 标准代号（A=GB 4785 草案 V4.3.5，B=GB 4785-2019，C=UN R48-09）
- 该装置在该版本下的**候选原文句**列表，每条带条款号与页码

# 工具：写完必须自己验一遍
你有 **test_regex** 工具：把你写的正则放到真实语料上跑，返回抽取器会取到的
值 / 条款号 / 页码，以及没过的原因。**先写正则 → test_regex → 不过就按理由改 →
再验**。最多改 3 次。

# 输出（只输出一个 JSON 对象，不要任何解释文字）
成功：
{"source": "<正则源码>", "flags": "i", "why": "<为什么这么写>"}
该版本确实没有这条规定：
{"absent": "<为什么该版没有这条规定>"}

# 抽取器的语义（决定正则该怎么写）
- 它**一页一页**地扫，**第一个命中的页就是结果**。
  → 正则的窗口跨到下一页**不会**误命中（那一页上没有这个锚点），
    所以**窗口要给足**（用 \`[\\s\\S]{0,900}?\` 或更大），别因为怕跨页就写短。
  → 但**值必须和条款锚点在同一页** —— 值在下一页就换一条候选句。
- 它**只读第 1 个捕获组**。没有捕获组时它拿整个匹配当值 ——
  那会把句子里所有数字（车型编号、别的限值）一起当成值。

# 正则的硬性要求
1. **必须以条款号开头做锚定**，例如 \`5\\.13\\.4\\.2\` 或 \`6\\.22\\.4\\.1\\.2\`。
   抽取器靠这个条款号把取值归到正确的条款下；不锚定就会「值对、条款错」。
2. **捕获组只框住「值」**，形如 \`(1500)\\s*mm\`。
3. **值是区间时，整个区间放进同一个捕获组**：
   \`(\\d+\\s*°\\s*(?:to|至|~)\\s*\\d+\\s*°)\`。
   写成两个捕获组，抽取器只会读到第一个数。
4. **条款锚点与值之间允许有别的字**，用窗口连接：
   \`5\\.3\\.4\\.1[\\s\\S]{0,900}?相邻发光单元最大水平距离应不大于\\s*(140)\\s*mm\`。
   不要写成 \`5\\.3\\.4\\.1\\.\\s*相邻…\` 这种「必须紧挨着」的形状。
5. **不要用 \`[^.]\` 排除小数点**。\`[^.]*?\` 会在 "2.0 Hz" 的小数点处断掉，
   正则就再也匹配不上。要连字符就用 \`[\\s\\S]{0,N}?\`。
6. **字面量必须与候选句逐字一致**。原文里是 \`$\\beta$\` 就写 \`\\$\\\\beta\\$\`，
   原文里写的是「至」就别写成 "to"。不要自己"规范化"原文。
7. **千分位逗号**：原文写 "1,000 mm" 就要写 \`1[ ,]?000\` 或 \`1,?000\` ——
   直接写 1000 在原文里匹配不到。
8. **车型编号不是值**：「第5类」「N2G」「M3G」「1a 类」是编号，要框在捕获组外。
9. 正则源码里的点要转义成 \`\\.\`，其它正则元字符照常转义。

# 判断「哪一句是这个参数的值」
- 看参数的**名字**：「最大离地高度」对应「不大于 1500mm」；
  「最小离地高度」对应「不小于 250mm」。上限和下限是两行不同的值，别选错。
- 看**单位**：参数的单位是 mm 就找带 mm 的句子。带单位的候选优先。
- 看**上下文**：句子里说的是不是这个装置、这个方向、这个条件。
- **最要紧的一条：找到数字 ≠ 找到了这个参数的量值。**
  同一章里常常有**别的要求**的数字。实测过的两个例子：
  · R48 §6.1.9.1 的「shall not exceed 100」是**参考值（reference value）**，
    不是 GB 的「同时点亮远光灯最大发光强度之和」；
  · R48 §6.3.6.1 的「-1.0 per cent」是**截止线倾斜度限值**，
    不是 GB 的「制造商标注准确度」。
  遇到这种情况要判「**这一版没有这个参数的要求**」，而不是把那个数填进去。
- 宁可说 {"absent": ...} 也不要选一个不像的句子 ——
  **选错值比不选更糟**：错误的值会被当成法规结论发给客户。

# 诚实
- 如果候选句里确实没有这个参数的值，就返回 {"absent": ...} 并说明你查了哪些条款。
- 不要凭记忆写数值。**所有数值必须来自候选句**。`;

export type SpecAgentCall = (opts: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}) => Promise<string>;

/**
 * 跑一次提议（带工具调用）。
 *
 * 调用方注入 `call` —— 这样单元测试可以用假模型，
 * 真实运行用 MiniMax（`scripts/run_spec_agent.mjs`）。
 */
export async function proposeSpec(
  ctx: SpecAgentCtx,
  slot: SpecSlot,
  candidates: Candidate[],
  call: ModelCaller,
  opts: { maxRounds?: number } = {},
): Promise<Proposal> {
  const base: Proposal = {
    id: slot.id,
    version: slot.version,
    device: slot.device,
    name: slot.name,
  };
  if (!candidates.length) {
    return { ...base, absent: `该装置在这一版里没有带数值的句子（候选为空）` };
  }
  const user = [
    `参数：**${slot.name}**`,
    `参数族：${slot.family}`,
    `单位：${slot.unit}`,
    `标准：**${slot.version}**`,
    `装置：${slot.device}`,
    "",
    "候选原文句（每条带条款号与页码）：",
    formatCandidates(candidates, 40),
    "",
    "请给出 JSON：",
  ].join("\n");
  let raw = "";
  try {
    raw = await runSpecAgent(ctx, slot, candidates, call, opts);
  } catch (e) {
    return { ...base, error: `模型调用失败：${(e as Error).message}` };
  }
  if (raw.startsWith("__TRUNCATED__")) {
    return {
      ...base,
      error:
        "模型回答被**截断**（思考吃光了 token 预算）—— " +
        "调大 SPEC_AGENT_MAX_TOKENS，或把候选句裁短",
    };
  }
  if (!raw.trim()) {
    return {
      ...base,
      error: "模型没有给出回答（回答被截断，或轮次用尽还没输出 JSON）",
    };
  }
  const parsed = parseJson(raw);
  if (!parsed) {
    return { ...base, error: `模型没有返回可解析的 JSON：${String(raw).slice(0, 700)}` };
  }
  if (typeof parsed.absent === "string" && parsed.absent.trim()) {
    return { ...base, absent: parsed.absent.trim() };
  }
  if (typeof parsed.source === "string" && parsed.source.trim()) {
    return {
      ...base,
      source: parsed.source.trim(),
      flags: typeof parsed.flags === "string" ? parsed.flags : "i",
      why: typeof parsed.why === "string" ? parsed.why.trim() : "",
    };
  }
  return { ...base, error: `模型返回的 JSON 里既没有 source 也没有 absent：${String(raw).slice(0, 700)}` };
}

/**
 * 从模型的回答里抠出 JSON。
 *
 * MiniMax 有时会把 JSON 包在 ```json 里，有时前后带话。
 * 这里只认**第一个完整的 JSON 对象**，不做更宽松的猜 ——
 * 猜出来的正则比没有正则更危险。
 */
export function parseJson(raw: string): any | null {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
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
      continue;
    }
    if (inStr) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
