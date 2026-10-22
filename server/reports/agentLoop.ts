/**
 * **工具调用循环** —— agent 自己取证、回答。
 *
 * 为什么要有这一层
 * ----------------
 * 原来的 `/api/agent/chat/stream` 是「一问一答」：system prompt + 消息 → 模型 → 文本。
 * 模型**看不到项目里的任何数据**，只能凭训练记忆回答 GB 4785，
 * 或者让用户把报告段落贴进来。这不是 agent，是聊天机器人。
 *
 * 有了工具之后，模型可以自己：
 *   1. 调 `lookup_clause` 拿到原文与页码
 *   2. 调 `find_quote` 确认那段话真的在源 PDF 的哪一页
 *   3. 调 `get_coverage_status` 回答「有没有少数据」
 *   4. 把结果写进回答，**带页码**
 *
 * 循环规则
 * --------
 *  · 模型返回 `tool_calls` → 执行工具 → 结果作为 `role:"tool"` 消息回灌 → 继续
 *  · 最多 `maxRounds` 轮（默认 6）—— 防止工具循环打转
 *  · 工具**只读**、**回源**；查不到就返回「未找到」，由模型如实转述
 *  · 回答里的每个事实都应当来自工具返回（含页码），模型自己的记忆**不算**证据
 *
 * 为什么用 SSE 而不是一次性返回
 * ----------------------------
 * 工具调用会花时间（回源 PDF 全文检索尤其慢），
 * 中间还要把「我正在查 XX」给用户看。流式是必须的。
 */
import { type ChatMessage } from "../integrations/minimax";
import { runAgentTool, toolSchemas } from "./agentTools";

/**
 * 工具回灌需要 role:"tool" —— integrations/minimax 的 ChatMessage 不含它。
 *
 * `tool_call_id` **必须带**：OpenAI 兼容的接口靠它把工具结果与调用对上，
 * 不带的话模型会看到一堆无主的 JSON，第二轮就不知道该接哪一条。
 */
type ConvoMessage =
  | ChatMessage
  | { role: "tool"; content: string; tool_call_id?: string; name?: string }
  | { role: "assistant"; content: string; tool_calls?: unknown[] };

export type AgentEvent =
  | { type: "reasoning"; delta: string }
  | { type: "content"; delta: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "done"; rounds: number; toolCalls: number }
  | { type: "error"; message: string };

/**
 * 工具结果的简短摘要（给 UI 显示，不给模型看）。
 *
 * **不要带工具名** —— UI 会在旁边单独列一列工具名，
 * 带上就是「lookup_clause lookup_clause → …」这样的重复。
 */
function summarize(name: string, data: any, ok: boolean): string {
  if (!ok) {
    const e = data?.error ?? data?.note ?? "未找到";
    return `未找到：${String(e).slice(0, 120)}`;
  }
  switch (name) {
    case "lookup_clause": {
      const m = data?.matches?.[0];
      return m ? `${data.version} §${data.clause}（${m.page ?? "页码未知"}）` : `${data.version} §${data.clause}`;
    }
    case "find_quote": {
      const h = data?.hits?.[0];
      return h ? `${h.label} ${h.pages?.slice(0, 3).join("/")}` : "无命中";
    }
    case "lookup_parameter":
      return String(data?.name ?? "?");
    case "get_diff_verdict":
      return `${data?.key}：${data?.verdict}`;
    case "get_coverage_status":
      return "覆盖台账";
    case "list_requirement_gaps":
      return `${data?.count ?? 0} 条`;
    case "get_topic_excerpts":
      return String(data?.topic ?? "");
    default:
      return "ok";
  }
}

/** MiniMax 的一次非流式调用（工具循环要用到 tool_calls，流式拿不到完整结构）。 */
async function callWithTools(
  messages: ConvoMessage[],
  tools: unknown[],
  opts: { model?: string; temperature?: number; maxTokens?: number; toolChoice?: string },
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}> {
  const base = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn").replace(/\/$/, "");
  const url = `${base}/v1/chat/completions`;
  const key = process.env.MINIMAX_API_KEY ?? "";
  if (!key) throw new Error("MINIMAX_API_KEY 未配置");

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model ?? process.env.MINIMAX_MODEL ?? "MiniMax-M3",
      messages,
      // **tools 为空时整个字段不发出去** —— 发了空数组模型也会当成「有工具」。
      // 收口轮靠这个真正断掉工具。
      ...(tools && tools.length ? { tools, tool_choice: opts.toolChoice ?? "auto" } : {}),
      max_tokens: opts.maxTokens ?? 8192,
      temperature: opts.temperature ?? 0.2,
      stream: false,
    }),
  });
  if (!r.ok) {
    const errTxt = await r.text();
    if (process.env.AGENT_DEBUG) {
      const body = JSON.stringify({ model: opts.model, messages, tools });
      const m = /index (\d+)/.exec(errTxt);
      const at = m ? Number(m[1]) : -1;
      console.log("[DEBUG api 400]", errTxt.slice(0, 400));
      if (at > 0) console.log("[DEBUG payload around]", body.slice(Math.max(0, at - 400), at + 200));
    }
    throw new Error(`MiniMax ${r.status}: ${errTxt.slice(0, 200)}`);
  }
  const j: any = await r.json();
  const msg = j?.choices?.[0]?.message ?? {};
  const toolCalls = (msg.tool_calls ?? []).map((tc: any) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc?.function?.arguments ?? "{}");
    } catch {
      args = {};
    }
    return { id: tc?.id ?? "", name: tc?.function?.name ?? "", args };
  });
  return {
    content: String(msg.content ?? ""),
    reasoning: String(msg.reasoning_content ?? ""),
    toolCalls,
  };
}

/** 从模型输出里剥掉 <think>…</think>（MiniMax-M3 会输出思维链）。 */
function stripThink(s: string): string {
  return (s ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

/**
 * MiniMax **有时把工具调用写进正文**，而不是放进结构化的 `tool_calls` 字段：
 *
 *   <tool_call>
 *   <invoke name="find_quote">
 *   <quote>转向信号灯的开关应独立于其他灯具</quote>
 *   </invoke>
 *   </tool_call>
 *
 * 不解析它，这一轮就白跑了 —— 模型以为它调了工具，我们却什么都没执行，
 * 它拿到一个空回执还会接着编。实测 MiniMax-M3 在 `tool_choice: "none"`
 * 与多轮回灌之后都会出现这个形态。
 *
 * 所以：**结构化字段为空时，从正文里再捞一次。**
 */
function parseNativeToolCalls(
  content: string,
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const out: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  const re = /<[\s]*invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/[\s]*invoke>/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(content ?? "")) !== null) {
    const name = m[1];
    const body = m[2] ?? "";
    const args: Record<string, unknown> = {};
    const argRe = /<([A-Za-z_][A-Za-z0-9_]*)\s*>([\s\S]*?)<\/\1>/g;
    let a: RegExpExecArray | null;
    while ((a = argRe.exec(body)) !== null) args[a[1]] = a[2].trim();
    out.push({ id: `native_${++n}`, name, args });
  }
  return out;
}

/** 把正文里的工具调用标记删掉 —— 免得它被当成答案念给用户听。 */
function stripToolMarkup(s: string): string {
  return (s ?? "")
    .replace(/<[\s]*tool_call>[\s\S]*?<\/[\s]*tool_call>/g, "")
    .replace(/<[\s]*invoke\s+name="[^"]+"\s*>[\s\S]*?<\/[\s]*invoke>/g, "")
    .trim();
}

/**
 * 收集「查过但没命中的关键词」—— 收口时告诉模型它到底试过什么。
 *
 * 这些关键词来自 find_quote 工具自己的 `keywords` 字段（工具回源查过、
 * 确认三版原文里都没有），所以它们是**已核实的事实**，不是模型的自述。
 */
function collectMissedKeywords(convo: ConvoMessage[]): string[] {
  const out: string[] = [];
  for (const m of convo) {
    if ((m as any).role !== "tool") continue;
    try {
      const d = JSON.parse((m as { content: string }).content);
      const kws = Array.isArray(d?.keywords) ? d.keywords : [];
      for (const k of kws) {
        // 只收**有区分度**的未命中词 —— 「信号」「车辆」命中一片说明不了任何事
        if (k && k.found === false && k.distinctive !== false && typeof k.keyword === "string") {
          out.push(k.keyword);
        }
      }
    } catch {
      /* 工具结果不是 JSON —— 忽略 */
    }
  }
  return [...new Set(out)].slice(0, 10);
}

export async function* runAgentLoop(opts: {
  messages: ChatMessage[];
  systemPrompt: string;
  model?: string;
  temperature?: number;
  maxRounds?: number;
}): AsyncGenerator<AgentEvent> {
  const maxRounds = Math.max(1, Math.min(12, opts.maxRounds ?? 6));
  const tools = toolSchemas();
  const convo: ConvoMessage[] = [
    { role: "system", content: opts.systemPrompt },
    ...opts.messages,
  ];
  let rounds = 0;
  let toolCalls = 0;
  /** 连续「整轮都没查着」的轮数 —— 用来判断是否该收口了 */
  let failRounds = 0;
  /** 已经强制作答过（避免重复收口） */
  let forced = false;

  while (rounds < maxRounds) {
    rounds++;
    let res: Awaited<ReturnType<typeof callWithTools>>;
    try {
      res = await callWithTools(convo, tools, {
        model: opts.model,
        temperature: opts.temperature ?? 0.2,
        maxTokens: 8192,
        toolChoice: "auto",
      });
    } catch (e) {
      yield { type: "error", message: e instanceof Error ? e.message : String(e) };
      return;
    }

    if (res.reasoning) {
      for (const line of res.reasoning.split(/(?<=[。！？\n])/)) {
        if (line.trim()) yield { type: "reasoning", delta: line };
      }
    }

    // 结构化字段为空时，从正文里再捞一次 —— MiniMax 有时把工具调用写成文本标记
    let calls = res.toolCalls;
    if (!calls.length) calls = parseNativeToolCalls(res.content);

    if (!calls.length) {
      // 模型的最终回答
      const text = stripThink(stripToolMarkup(res.content));
      if (text) {
        for (const line of text.split(/(?<=[。！？\n])/)) {
          if (line) yield { type: "content", delta: line };
        }
        yield { type: "done", rounds, toolCalls };
        return;
      }
      // **既没有工具调用也没有正文** —— 模型把 token 全花在思维链上、
      // 答案被截断了。这跟「查不到」是两回事：一个是没写完，一个是没找到。
      // 也不能就这么返回 —— 用户会收到一条空消息。
      // 交给收口轮（更大的 token 上限 + 明确的收口指令）再试一次。
      break;
    }

    // 有工具调用 → 执行 → 回灌
    let roundOk = 0;
    convo.push({
      role: "assistant",
      content: res.content || "",
      tool_calls: calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    });
    for (const tc of calls) {
      toolCalls++;
      yield { type: "tool_call", name: tc.name, args: tc.args };
      let out: { ok: boolean; data: any };
      try {
        out = await runAgentTool(tc.name, tc.args);
      } catch (e) {
        out = { ok: false, data: { error: e instanceof Error ? e.message : String(e) } };
      }
      const summary = summarize(tc.name, out.data, out.ok);
      if (out.ok) roundOk++;
      yield { type: "tool_result", name: tc.name, ok: out.ok, summary };
      convo.push({
        role: "tool",
        content: JSON.stringify(out.data),
        tool_call_id: tc.id,
        name: tc.name,
      });
    }

    // **收口判定**：整轮工具全失败（查了，但一样都没查着）。
    // 连续两轮如此，说明这个问题在这三份源 PDF 里**确实查不到** ——
    // 再查下去只是换措辞碰运气，把取证轮数耗光而已。
    if (roundOk === 0) failRounds++;
    else failRounds = 0;

    if (failRounds >= 2 && !forced) {
      forced = true;
      convo.push({
        role: "user",
        content: closeOutDirective(collectMissedKeywords(convo)),
      } as ConvoMessage);
    }
  }

  // ── 收口轮 ────────────────────────────────────────────────────────────
  // 工具轮用尽（或已经判定「查到了」）之后，**把工具撤掉**再问一次，
  // 只为拿一段可以念给用户听的结论。
  //
  // 为什么不是「在最后一轮用 tool_choice:none」：
  //   MiniMax 对 `tool_choice: "none"` 的处理是把工具调用**写成正文里的文本标记**
  //   （`<invoke name="find_quote">…</invoke>`），正文就成了半截工具调用，
  //   用户看到的是一堆 XML，而不是答案。撤掉 tools 才是真的不给它调用的机会。
  //
  // 为什么 token 上限要放大：MiniMax-M3 会先输出一大段思维链，
  // 8192 有时不够写完「思维链 + 答案」—— 答案会被截断，
  // 而「答案被截断」看起来和「查不到」一模一样。两者的区别很重要。
  if (!forced) {
    convo.push({
      role: "user",
      content: closeOutDirective(collectMissedKeywords(convo)),
    } as ConvoMessage);
  }
  let finalRes: Awaited<ReturnType<typeof callWithTools>> | null = null;
  try {
    finalRes = await callWithTools(convo, [], {
      model: opts.model,
      temperature: opts.temperature ?? 0.2,
      maxTokens: 16384,
      toolChoice: "auto",
    });
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }
  if (finalRes.reasoning) {
    for (const line of finalRes.reasoning.split(/(?<=[。！？\n])/)) {
      if (line.trim()) yield { type: "reasoning", delta: line };
    }
  }
  const finalText = stripThink(stripToolMarkup(finalRes.content));
  if (finalText) {
    for (const line of finalText.split(/(?<=[。！？\n])/)) {
      if (line) yield { type: "content", delta: line };
    }
  } else {
    // 撤掉工具后模型仍然只吐了工具标记 —— 明确说「未找到」，不许留白
    yield {
      type: "content",
      delta:
        "\n> 上述内容在源 PDF 中**未找到**，此处留空而非填写推测值。\n" +
        "> （取证轮数已用尽：最多 " +
        maxRounds +
        " 轮工具调用 + 1 轮收口。）\n",
    };
  }
  yield { type: "done", rounds: rounds + 1, toolCalls };
}

/**
 * 收口指令 —— 模型查够了（或查不到）之后，命令它给出结论。
 *
 * 措辞是刻意的：明确给出「查不到」的标准写法（未找到 / 没有规定 / 查不到），
 * 并明令不得编造页码。模型自己拿捏「查不到」的分寸时，
 * 十次里有三四次会含糊成「该标准未对此作出明确规定」——
 * 那句话读起来像结论，其实没有告诉读者「没找到」。
 */
function closeOutDirective(missed: string[]): string {
  return (
    "【取证指令】不要再调用任何工具。请现在就给结论，规则如下：\n" +
    "1. 如实说明该内容在 GB 4785 草案 / GB 4785-2019 / UN R48-09 三份源 PDF 中**未找到**" +
    "（必须写「未找到」「没有规定」「查不到」这类**明确措辞**，不要含糊成「未作明确规定」）；\n" +
    "2. 列出你**确实已经核实**的内容及其页码（若一条都没有，就写「未能核实到任何一条」）；\n" +
    "3. **绝对不要**编造页码、条款号或数值 —— 宁可空着，不可错着。\n" +
    (missed.length ? `已尝试但在原文中无命中的关键词：${missed.join("、")}。\n` : "")
  );
}
