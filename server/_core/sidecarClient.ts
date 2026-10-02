/**
 * Python sidecar client — calls the MinerU extraction/verification service.
 *
 * The sidecar (python_service/main.py, port 8300) exposes:
 *   GET  /health       → liveness
 *   POST /extract      → MinerU 4.0.6 multimodal extraction of one PDF
 *   POST /report-data  → extract all documents in one call
 *
 * When PYTHON_SERVICE_URL is configured, report generation swaps from the
 * MuPDF.js+LLM path to the deterministic MinerU+v6.5 renderer.
 */
import { ENV } from "./env";

export const SIDECAR_URL = (ENV.pythonServiceUrl || "http://127.0.0.1:8300").replace(/\/$/, "");

export function sidecarConfigured(): boolean {
  return Boolean(ENV.pythonServiceUrl);
}

export type SidecarExtractResult = {
  label: string;
  fileName: string;
  fileHash: string;
  pages: number;
  markdownLen: number;
  fullTextLen: number;
  blockCounts: Record<string, number>;
  tableCount: number;
  figureCount: number;
  equationCount: number;
  headingCount: number;
  extractionSeconds: number;
  cached: boolean;
  data: Record<string, any>; // full per-doc MinerU dict
};

export async function sidecarHealth(timeoutMs = 5000): Promise<boolean> {
  try {
    const r = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Extract all three documents through the sidecar. Returns a dict keyed by
 * label with the full MinerU per-doc object (markdown/fullText/tables/figures/
 * equations/headings/blockTypes).
 *
 * If the sidecar is unreachable, throws — the caller must fall back to the
 * legacy MuPDF.js path.
 */
export async function sidecarExtractDocs(
  docs: Array<{ label: string; fileName: string; filePath: string }>,
): Promise<Record<string, any>> {
  const payload = { documents: docs };
  const r = await fetch(`${SIDECAR_URL}/report-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`sidecar /report-data failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const out = await r.json();
  if (out.errors?.length) {
    const first = out.errors[0];
    throw new Error(`sidecar extraction error [${first.label || "?"}]: ${first.error}`);
  }
  return out.extracted ?? {};
}

/**
 * Run cross-doc verification through the sidecar, returning the
 * verified-comparison.json shape (numericChanges + topicColumns + stats).
 */
export async function sidecarVerify(): Promise<any> {
  const r = await fetch(`${SIDECAR_URL}/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`sidecar /verify failed (${r.status}): ${text.slice(0, 300)}`);
  }
  return r.json();
}

/**
 * Generate the deterministic MinerU report for the given extracted dict, and
 * return the RenderableReport (caller renders via renderPdfFromReport).
 */
export async function buildSidecarReport(
  extracted: Record<string, any>,
  verified?: any,
): Promise<{ report: any; indicatorResults: any[] }> {
  const { buildMinerUReport } = await import("../reports/reportV6");
  const vd = verified ?? {
    numericChanges: [], topicColumns: [], stats: {}, renumberedOnly: [],
  };
  return buildMinerUReport(extracted, vd);
}