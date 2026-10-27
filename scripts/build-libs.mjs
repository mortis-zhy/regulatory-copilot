/**
 * Build the individually-loadable dist/ modules.
 *
 * `npm run build` (vite + esbuild --outdir) only ever emits dist/index.js, but
 * the _test_*.mjs harness and the standalone re-render scripts import several
 * other modules by exact path:
 *
 *   _test_math.mjs      → dist/htmlRenderV8.js
 *   _test_impact.mjs    → dist/htmlRenderV8.js
 *   _test_gap_guard.mjs → dist/htmlRenderV8.js, dist/typedTables.js
 *   _test_exec_retry.mjs→ dist/reportGenerator.js
 *
 * Historically those were produced by hand-written one-off `esbuild` commands
 * recorded only in HANDOVER.md, which did not even mention typedTables. That
 * made a fresh clone unbuildable-by-default. This script makes them part of the
 * normal build.
 *
 * Deliberately NOT `--outdir` with multiple entry points: esbuild then infers a
 * common outbase of `server/` and emits dist/_core/index.js + dist/reports/*.js,
 * which is not where anything imports from. One explicit `--outfile` per entry
 * keeps the paths predictable.
 *
 * Also writes dist/.build-manifest.json (source sha256 per entry) so
 * `npm run verify` can detect "source edited but dist never rebuilt" — the exact
 * failure that made three earlier fixes evaporate, since dist/ is gitignored.
 */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Array<[entry: string, outfile: string]>} */
const ENTRIES = [
  ["server/_core/index.ts", "dist/index.js"],
  ["server/reports/htmlRenderV8.ts", "dist/htmlRenderV8.js"],
  ["server/reports/typedTables.ts", "dist/typedTables.js"],
  ["server/reports/reportGenerator.ts", "dist/reportGenerator.js"],
  ["server/reports/closureLedger.ts", "dist/closureLedger.js"],
  // reportV6 owns the chapter builders and the executive summary. It is
  // bundled into dist/index.js, but index.js does not re-export it, so the
  // offline rebuild path (rebuild_report.mjs) could not reach buildMinerUReport.
  ["server/reports/reportV6.ts", "dist/reportV6.js"],
  ["server/reports/parameterMatrix.ts", "dist/parameterMatrix.js"],
  // consistency.ts is the report's self-check. It needs its own module so
  // _test_consistency.mjs can feed it **synthetic** tables — the false
  // positives it used to raise (55 medium findings, 53 of them the checker's
  // own fault) could only be caught that way, not by looking at the real
  // report and squinting.
  ["server/reports/consistency.ts", "dist/consistency.js"],
  ["server/_core/deliveryGate.ts", "dist/deliveryGate.js"],
  // agentTools is the **evidence source** for the tool-calling agent: every
  // fact the agent states comes back through one of these tools, resolved
  // against the source PDFs. It gets its own module so _test_agent_tools.mjs
  // can drive it with known answers (a tool that returns the wrong page is
  // worse than a tool that returns nothing — the agent has no way to tell).
  ["server/reports/agentTools.ts", "dist/agentTools.js"],
  ["server/reports/agentLoop.ts", "dist/agentLoop.js"],
  ["server/reports/agentPrompt.ts", "dist/agentPrompt.js"],
  // changeLedger 是「变化总清单」的唯一实现 ——
  // 报告渲染它，闸门重算它。两边用同一份代码，才对得上账。
  ["server/reports/changeLedger.ts", "dist/changeLedger.js"],
  // specAgent 是「取值规格提议 agent」：候选层 + 模型选择层 + 校验层。
  // 单独成模块，是为了让它的校验层能被已知答案用例直接驱动 ——
  // 校验层是这一层唯一有资格说「对」的地方。
  ["server/reports/specAgent.ts", "dist/specAgent.js"],
  // export.ts 的 renderWordHtml 是 Word 导出的实现。它必须能扛住
  // 「只有 content、没有 changes/parameters/evidence」的负载 ——
  // 以前会崩在 `.map` 上，表现为一个裸的 500 HTML 页。
  // 单独成模块，好让闸门用半个负载直接驱动它。
  ["server/reports/export.ts", "dist/export.js"],
];

const SHARED = {
  platform: "node",
  target: "node22",
  packages: "external",
  bundle: true,
  format: "esm",
  logLevel: "warning",
};

const sha256 = (relPath) =>
  createHash("sha256").update(readFileSync(resolve(ROOT, relPath))).digest("hex");

mkdirSync(resolve(ROOT, "dist"), { recursive: true });

const sources = {};
for (const [entry, outfile] of ENTRIES) {
  await build({ ...SHARED, entryPoints: [resolve(ROOT, entry)], outfile: resolve(ROOT, outfile) });
  sources[entry] = sha256(entry);
  console.log(`[build-libs] ${entry} → ${outfile}`);
}

// closureLedger is imported by no script today; build it anyway so the set does
// not silently drift away from the module list again.
sources["vite.config.ts"] = sha256("vite.config.ts");

// deliveryGate is bundled into dist/index.js and decides whether a PDF is
// allowed to reach a client. Editing it without rebuilding would ship stale
// gating, so track it here — the manifest check in verify.mjs compares hashes.
sources["server/_core/deliveryGate.ts"] = sha256("server/_core/deliveryGate.ts");

writeFileSync(
  resolve(ROOT, "dist/.build-manifest.json"),
  JSON.stringify({ builtAt: new Date().toISOString(), sources }, null, 2) + "\n",
  "utf-8",
);

console.log(`[build-libs] wrote dist/.build-manifest.json (${Object.keys(sources).length} sources tracked)`);