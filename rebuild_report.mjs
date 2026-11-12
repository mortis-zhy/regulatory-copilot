/**
 * Rebuild reports/last-report.json from the persisted MinerU data + facts,
 * WITHOUT rendering a PDF.
 *
 * The PDF render (pass-1 + pass-2 Chromium setContent on ~100 MB of HTML) is
 * what burns 600 s and gets killed — see HANDOVER §7.2. This entry point stops
 * at the report JSON so the Markdown can be inspected and diffed cheaply.
 *
 *   node rebuild_report.mjs            # write reports/last-report.json
 *   node rebuild_report.mjs --dry      # build, print stats, write nothing
 */
import fs from "node:fs";
import path from "node:path";
import { buildMinerUReport } from "./dist/reportV6.js";
import { attachFigureGallery } from "./dist/figureGallery.js";

const ROOT = process.cwd();
const DATA = path.join(ROOT, "dist", "mineru-v4-data.json");
const FACTS = path.join(ROOT, "dist", "facts.json");
const VERIFIED = path.join(ROOT, "dist", "verified-comparison.json");
const OUT = path.join(ROOT, "reports", "last-report.json");

const dry = process.argv.includes("--dry");

if (!fs.existsSync(DATA)) throw new Error(`MinerU data not found: ${DATA}`);
const factsFile = fs.existsSync(FACTS) ? FACTS : VERIFIED;
console.log(`[rebuild] data     = ${path.basename(DATA)}`);
console.log(`[rebuild] facts    = ${path.basename(factsFile)}`);

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
const verified = JSON.parse(fs.readFileSync(factsFile, "utf8"));

// 图版 —— 从**源 PDF** 抽位图（附录 B.2）。
// 交付件此前**一张图都没有**（实测 279 页 · 图对象 0 个），
// 而源 PDF 里的图带着限值本身（B 版 p30 的 80°/45° 可见角布局图）。
// 抽图按内容认版本（sha256）⇒ 换一套标准时同一段代码照样能用 ✓。
const galleries = attachFigureGallery(data);
console.log(
  `[rebuild] 图版：${Object.entries(galleries)
    .map(([k, g]) => `${k} ${g.total} 张`)
    .join(" · ")}`,
);

const { report } = await buildMinerUReport(data, verified);
report.generator = "mineru";

const exec = report.chapters.find((c) => c.id === 0)?.markdown ?? "";
console.log("\n===== 执行摘要 · 决策口径 =====");
const block = exec.split("## 本报告的结论（按决策口径）")[1]?.split("\n---")[0] ?? "";
console.log(block.trim());

const bytes = Buffer.byteLength(JSON.stringify(report), "utf8");
console.log(`\n[rebuild] chapters=${report.chapters.length} appendices=${report.appendices.length} bytes=${bytes}`);

if (dry) {
  console.log("[rebuild] dry-run, nothing written");
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report));
  console.log(`[rebuild] ✅ ${OUT}`);
}