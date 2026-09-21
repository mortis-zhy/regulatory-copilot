import { ENV } from "../_core/env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function isMiniMaxConfigured() {
  return Boolean(ENV.minimaxApiKey);
}

/**
 * Stream chat completions from MiniMax (MiniMax-M3) using the OpenAI-compatible
 * chat/completions endpoint. The MiniMax-M3 model emits `<think>…</think>`
 * reasoning blocks; this helper strips them out of the yielded content and
 * exposes them via a separate callback so the UI can show them as a "thinking"
 * transcript without polluting the user-facing answer.
 */
export async function* streamMiniMaxChat(
  messages: ChatMessage[],
  options?: {
    model?: string;
    temperature?: number;
    onReasoning?: (delta: string) => void;
  },
): AsyncGenerator<string> {
  if (!ENV.minimaxApiKey) {
    throw new Error("MINIMAX_API_KEY is not configured");
  }
  const response = await fetch(`${ENV.minimaxBaseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ENV.minimaxApiKey}`,
    },
    body: JSON.stringify({
      model: options?.model ?? ENV.minimaxModel,
      messages,
      // MiniMax-M3 supports the `thinking` field; adaptive lets the model
      // decide when to reason. Reasoning tokens are emitted as <think> blocks.
      thinking: { type: "adaptive" },
      stream: true,
      temperature: options?.temperature ?? 0.2,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `MiniMax request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Track per-choice reasoning/content so we can interleave and strip think blocks.
  let reasoningCarry = "";
  let contentCarry = "";

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
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") return;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{
              delta?: { content?: string; reasoning_content?: string };
            }>;
          };
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
            if (flushed) yield flushed;
          }
        } catch {
          // Incomplete SSE frames arrive often; the next chunk will hold the remainder.
        }
      }
    }
    // Drain any remaining content at end of stream.
    const tail = flushContentCarry(true);
    if (tail) yield tail;
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