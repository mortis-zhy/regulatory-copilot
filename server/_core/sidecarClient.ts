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
 * Best-effort sidecar supervisor.
 *
 * The sidecar kept dying between requests — three 503s in one session, each
 * with an empty log and no traceback, i.e. the process was terminated rather
 * than crashing. Every occurrence meant a human had to notice the failure and
 * start `python python_service/main.py` by hand before the site worked again.
 *
 * So: if the health check fails, try to spawn it, wait for it to come up, and
 * report whether that worked. Never throws — the caller still gets a boolean
 * and can produce the same actionable 503 message if the restart fails.
 */
let sidecarSpawnInFlight: Promise<boolean> | null = null;

export async function ensureSidecar(timeoutMs = 60000): Promise<boolean> {
  if (await sidecarHealth(3000)) return true;
  if (sidecarSpawnInFlight) return sidecarSpawnInFlight;

  sidecarSpawnInFlight = (async () => {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    // Walk up until python_service/main.py appears. `import.meta.dirname`
    // points inside dist/ after bundling, and resolving "../.." from there
    // lands on the OUTER workbench repo — where python_service does not exist,
    // so the spawn silently produced a dead PID.
    let root = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6 && root; i++) {
      if (fs.existsSync(path.join(root, "python_service", "main.py"))) break;
      const up = path.dirname(root);
      if (up === root) break;
      root = up;
    }
    const entry = path.join(root, "python_service", "main.py");
    if (!fs.existsSync(entry)) {
      console.error("[sidecar] auto-start skipped — main.py not found under", root);
      sidecarSpawnInFlight = null;
      return false;
    }
    try {
      const child = spawn("python", [entry], {
        cwd: root,
        detached: true, // survive the parent process
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      console.log("[sidecar] not reachable — spawned", entry, `(pid ${child.pid})`);
    } catch (e) {
      console.error("[sidecar] auto-start failed:", e);
      sidecarSpawnInFlight = null;
      return false;
    }

    // Poll until /health answers. MinerU imports torch on boot, so the first
    // start takes well over ten seconds.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await sidecarHealth(3000)) {
        console.log("[sidecar] back up");
        sidecarSpawnInFlight = null;
        return true;
      }
    }
    console.error(`[sidecar] still unreachable after ${Math.round(timeoutMs / 1000)}s`);
    sidecarSpawnInFlight = null;
    return false;
  })();

  return sidecarSpawnInFlight;
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
  return await buildMinerUReport(extracted, vd);
}