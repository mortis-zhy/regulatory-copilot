import { ENV } from "../_core/env";
import { minimaxKeyPool, isKeyRotationError } from "../_core/minimaxPool";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function isMiniMaxConfigured() {
  return minimaxKeyPool().length > 0;
}

/**
 * 用**一把** key 做一次流式调用。
 *
 * 若在**还没吐出任何内容之前**撞上配额/权限类失败，抛一个带 `retriable`
 * 标记的错误 —— 外层据此换下一把 key 重来（此时没有半截输出，重来是干净的）。
 * 一旦已经吐过内容，就只能如实报错：重来的话用户会看到重复的段落。
 */
async function* streamWithKey(
  key: string,
  nativeUrl: string,
  compatUrl: string,
  payload: unknown,
  options?: {
    onReasoning?: (delta: string) => void;
  },
): AsyncGenerator<string> {
  const init: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
  };

  let response = await fetch(nativeUrl, init);
  if (response.status === 402 || response.status === 404) {
    // Native route refused this key outright — retry once on the compat route.
    await response.text().catch(() => "");
    response = await fetch(compatUrl, init);
  }

  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => response.statusText);
    const err = new Error(`MiniMax request failed (${response.status}): ${body}`) as Error & {
      retriable?: boolean;
      status?: number;
    };
    err.status = response.status;
    // 额度/权限类 → 可以换一把 key；400 之类 → 换了也没用
    err.retriable = isKeyRotationError(response.status, body);
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Track per-choice reasoning/content so we can interleave and strip think blocks.
  let reasoningCarry = "";
  let contentCarry = "";
  // 已吐出的内容字数 —— 用来判断「还能不能干净地换 key 重来」
  let emitted = 0;
  // Set when the stream carries a real API-level error (e.g. out of credit on
  // the native route, which reports HTTP 200 + base_resp). Rethrown after the
  // read loop because the per-frame `catch` below must not swallow it.
  let fatal: (Error & { retriable?: boolean }) | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payloadText = trimmed.slice(5).trim();
        if (payloadText === "[DONE]") return;
        try {
          const json = JSON.parse(payloadText) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
            base_resp?: { status_code?: number; status_msg?: string };
          };
          // The native route returns HTTP 200 with `choices: null` and an
          // error inside `base_resp` when the account is out of credit. Without
          // this check the whole stream is silently skipped and the caller
          // receives an empty chapter with no explanation.
          const br = json.base_resp;
          if (br && typeof br.status_code === "number" && br.status_code !== 0) {
            const msg = br.status_msg || "error";
            fatal = new Error(
              `MiniMax ${msg} (code ${br.status_code}) — 检查 MINIMAX_API_KEY 账户余额或改用可用 key`,
            ) as Error & { retriable?: boolean };
            // 还没吐出内容 → 可以换一把 key 重来；已经吐过了 → 只能报错
            fatal.retriable = emitted === 0 && isKeyRotationError(200, JSON.stringify(br));
            break;
          }
          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          // 1. Reasoning: forward to UI separately, no public yield.
          if (delta.reasoning_content) {
            reasoningCarry += delta.reasoning_content;
            options?.onReasoning?.(delta.reasoning_content);
          }
          // 2. Content: feed through a state machine that hides <think> blocks.
          if (delta.content) {
            contentCarry += delta.content;
            const flushed = flushContentCarry();
            if (flushed) {
              emitted += flushed.length;
              yield flushed;
            }
          }
        } catch {
          // Incomplete SSE frames arrive often; the next chunk will hold the remainder.
        }
      }
      if (fatal) break;
    }
    // Drain any remaining content at end of stream.
    const tail = flushContentCarry(true);
    if (tail) {
      emitted += tail.length;
      yield tail;
    }
    if (fatal) throw fatal;
  } finally {
    reader.releaseLock();
  }

  function flushContentCarry(final = false): string {
    // Strip <think>…</think> blocks (possibly multi-chunk) so the UI never sees
    // raw reasoning. Anything before the first `<` is safe to emit immediately.
    let out = "";
    while (contentCarry.length > 0) {
      const thinkStart = contentCarry.indexOf("<think>");
      if (thinkStart === -1) {
        // No think block in flight; safe to flush everything except a possible
        // partial `<` that might be the start of `<think>`.
        const lastLt = contentCarry.lastIndexOf("<");
        const safe = lastLt >= 0 && contentCarry.length - lastLt < 8
          ? contentCarry.slice(0, lastLt)
          : contentCarry;
        out += safe;
        contentCarry = contentCarry.slice(safe.length);
        break;
      }
      // Emit pre-think content.
      out += contentCarry.slice(0, thinkStart);
      const thinkEnd = contentCarry.indexOf("</think>", thinkStart);
      if (thinkEnd === -1) {
        // Think block not yet closed; keep tail in carry until next chunk
        // unless this is the final flush, in which case drop it.
        if (final) {
          contentCarry = contentCarry.slice(thinkStart + "<think>".length);
        } else {
          contentCarry = contentCarry.slice(thinkStart);
        }
        break;
      }
      // Skip the closed think block and continue scanning.
      contentCarry = contentCarry.slice(thinkEnd + "</think>".length);
    }
    return out;
  }
}

/**
 * Stream chat completions from MiniMax (MiniMax-M3) using the OpenAI-compatible
 * chat/completions endpoint. The MiniMax-M3 model emits `<think>…</think>`
 * reasoning blocks; this helper strips them out of the yielded content and
 * exposes them via a separate callback so the UI can show them as a "thinking"
 * transcript without polluting the user-facing answer.
 *
 * **多把 key 轮换**：主 key 撞「Token Plan 用量上限」时自动切下一把
 * （`.env` 的 MINIMAX_API_KEY_FALLBACK，可用逗号分隔多把）。
 * 否则配额一用完整条 agent 链路就断了 —— 而报告生成、闸门、参数取值
 * 全是确定性管线，不该被一把 key 卡住。
 */
export async function* streamMiniMaxChat(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    /** Max output tokens. Default 8192 — large enough for a deep multi-section
     * comparison of 100+ page regulatory documents. */
    maxTokens?: number;
    onReasoning?: (delta: string) => void;
  },
): AsyncGenerator<string> {
  const pool = minimaxKeyPool();
  if (!pool.length) {
    throw new Error("MINIMAX_API_KEY is not configured");
  }
  // Endpoint note: the OpenAI-compatible route `/v1/chat/completions` on some
  // MiniMax accounts returns `402 insufficient_balance` even when the native
  // route for the same key/model returns 200. We probe the native route first
  // and only fall back to the compat route if the native one is unavailable.
  //
  // CRITICAL: the native route returns HTTP 200 even when the account has no
  // balance — the failure is reported inside the body as
  // `base_resp.status_code: 1008, status_msg: "insufficient balance"`.
  // So HTTP status alone is NOT a success signal here; check both.
  const base = ENV.minimaxBaseUrl.replace(/\/$/, "");
  const nativeUrl = `${base}/v1/text/chatcompletion_v2`;
  const compatUrl = `${base}/v1/chat/completions`;
  const payload = {
    model: options?.model ?? ENV.minimaxModel,
    messages,
    thinking: { type: "adaptive" },
    stream: true,
    temperature: options?.temperature ?? 0.2,
    max_tokens: options?.maxTokens ?? 8192,
  };

  let lastErr: Error | null = null;
  for (let i = 0; i < pool.length; i++) {
    try {
      yield* streamWithKey(pool[i], nativeUrl, compatUrl, payload, options);
      return;
    } catch (e) {
      const err = e as Error & { retriable?: boolean };
      const isLast = i === pool.length - 1;
      if (err?.retriable && !isLast) {
        console.warn(
          `[minimax-stream] 第 ${i + 1} 把 key 不可用（${String(err.message).slice(0, 120)}），自动切下一把`,
        );
        lastErr = err;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("MiniMax 无可用 key");
}
