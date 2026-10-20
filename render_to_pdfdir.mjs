/**
 * Render reports/last-report.json → PDF directly via renderPdfFromReportV8,
 * and write it to the outer workbench's PDF对比 folder as the CURRENT deliverable.
 *
 * The output name is fixed, not dated. It used to be
 * `⑥_网站最新生成_最新版_<date>.pdf`, which meant every render dropped another
 * PDF into the delivery folder — six accumulated before anyone noticed, none of
 * them distinguishable at a glance. Render overwrites one file; to keep a
 * previous version, copy it aside first (that is what the ⑥/⑦ pair in
 * PDF对比\README.md is).
 */
import fs from "node:fs";
import path from "node:path";
import { renderPdfFromReportV8 } from "./dist/htmlRenderV8.js";

const ROOT = path.resolve(".."); // outer workbench
const OUTDIR = path.join(ROOT, "PDF对比");
const OUT_NAME = "⑪_C列补全_最新版.pdf";  // 交付时另存为 ⑩_三版可比_128页_<日期>.pdf

const report = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
console.log(`[render] ${report.outline.title}`);
console.log(`[render] generator=${report.generator ?? "?"}, chapters=${report.chapters.length}, appendices=${(report.appendices || []).length}`);
console.log(`[render] parameterMatrix=${(report.parameterMatrix || []).length} 参数`);
for (const a of report.appendices || []) {
  const n = (a.markdown || "").replace(/[#*>\-\[\]()\s]/g, "").length;
  console.log(`[render]   appendix ${a.id}: ${n} real chars${n < 200 ? " ← THIN" : ""}`);
}

const t0 = Date.now();
const pdf = await renderPdfFromReportV8(report);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

fs.mkdirSync(OUTDIR, { recursive: true });
const outPath = path.join(OUTDIR, OUT_NAME);
fs.writeFileSync(outPath, pdf);
console.log(`\n[render] ✅ ${outPath}`);
console.log(`[render] ${(pdf.length / 1024 / 1024).toFixed(2)} MB, ${secs}s`);
