import { ENV } from "../_core/env";
import type { ParseResult } from "../ingestion/pipeline";

export function isRagAnythingConfigured() {
  return Boolean(ENV.ragAnythingBaseUrl && ENV.ragAnythingApiKey);
}

export async function parseWithRagAnything(input: { fileName: string; mimeType: string; bytes: Uint8Array }): Promise<ParseResult> {
  if (!isRagAnythingConfigured()) throw new Error("RAG_ANYTHING_BASE_URL and RAG_ANYTHING_API_KEY are not configured");
  const response = await fetch(`${ENV.ragAnythingBaseUrl.replace(/\/$/, "")}/v1/parse`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ENV.ragAnythingApiKey}` },
    body: JSON.stringify({
      file_name: input.fileName,
      mime_type: input.mimeType,
      content_base64: Buffer.from(input.bytes).toString("base64"),
      parser: "mineru",
      multimodal: true,
      extract: ["hierarchy", "tables", "figures", "equations", "citations", "knowledge_graph"],
    }),
  });
  if (!response.ok) throw new Error(`RAG-Anything parse failed (${response.status}): ${await response.text().catch(() => response.statusText)}`);
  return response.json() as Promise<ParseResult>;
}
