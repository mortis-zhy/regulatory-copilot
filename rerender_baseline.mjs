/**
 * rerender_baseline.mjs — 用修好的台账重渲染基线报告。
 * 验证：勘误数 4 → 9、账目对账框出现。
 */
import fs from "node:fs";
import path from "node:path";
import { renderPdfFromReportV8 } from "./dist/htmlRenderV8.js";
import { buildLedger, ledgerToCounts } from "./dist/closureLedger.js";

const ROOT = path.resolve("..");
const report = JSON.parse(
  fs.readFileSync(path.join(ROOT, "baseline/last-report_V8.6_calibrated.json"), "utf8"),
);

const md = report.chapters.map((c) => c.markdown || "").join("\n");
const L = buildLedger(md);
console.log("[ledger] counts:", JSON.stringify(ledgerToCounts(L)));
console.log("[ledger] discrepancies:");
L.discrepancies.forEach((d) => console.log("   !", d));

console.log("\n[pdf] rendering…");
const pdf = await renderPdfFromReportV8(report);
fs.writeFileSync(path.join(ROOT, "GB4785_修复台账版.pdf"), pdf);
console.log(`[pdf] written: ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
