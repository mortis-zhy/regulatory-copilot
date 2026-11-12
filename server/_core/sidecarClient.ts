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
    // sidecar 脚本在**项目根**下 —— 用唯一那份根解析器算。
    //
    // 原来这里自己向上走（找 `python_service/main.py`）：
    // `import.meta.dirname` 打包后在 dist/ 里，从那儿算 `../..` 会落到
    // **外层**那个 workbench 仓库 —— 那里没有 python_service，
    // 于是 spawn 出一个死 PID 而**不报错**。
    //
    // 现在走同一个根：项目根由 `data/parameter-specs.json` 认定，
    // 找不到就抛错（宁可起不来，也不要读到别人的目录）。
    const { PROJECT_ROOT } = await import("./projectRoot");
    const root = PROJECT_ROOT;
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
  // 图版 —— 从**源 PDF** 抽位图（附录 B.2）。
  // 网页上传的 PDF 也要有图 ⇒ 这条路**必须**挂图版 ✓；
  // 离线重建（rebuild_report.mjs）走**同一份实现** ✓ —— 两份实现就会有一份忘抽 ✓。
  const { attachFigureGallery } = await import("../reports/figureGallery");
  try {
    attachFigureGallery(extracted);
  } catch (e) {
    // 抽图失败**不许**让整份报告出不来 ✓ ——
    // 但要**响亮**（console.error），不然就是「悄悄少了几十张图」✗。
    console.error("[figures] 抽图失败（报告仍会出，但没有图版）：", e);
  }
  const vd = verified ?? {
    numericChanges: [], topicColumns: [], stats: {}, renumberedOnly: [],
  };
  return await buildMinerUReport(extracted, vd);
}