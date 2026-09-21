import { ENV } from "../_core/env";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function isDeepSeekConfigured() {
  return Boolean(ENV.deepSeekApiKey);
}

export async function* streamDeepSeekChat(messages: ChatMessage[], options?: { model?: string; temperature?: number }) {
  if (!ENV.deepSeekApiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  const response = await fetch(`${ENV.deepSeekBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENV.deepSeekApiKey}` },
    body: JSON.stringify({ model: options?.model ?? ENV.deepSeekModel, messages, temperature: options?.temperature ?? 0.2, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`DeepSeek request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
          const json = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Ignore incomplete SSE frames; the next chunk will contain the remainder.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
