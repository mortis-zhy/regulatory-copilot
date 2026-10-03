/**
 * rerender_new.mjs — 用修复后的渲染器重新渲染新生成��报告。
 * 验证横向三列表是否被正确识别为 triptych。
 */
import fs from "node:fs";
import path from "node:path";
import { renderPdfFromReportV8 } from "./dist/htmlRenderV8.js";
import { extractTypedTables } from "./dist/typedTables.js";
import { buildTrustBundle } from "./dist/trustChecks.js";

const ROOT = path.resolve("..");
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "generated-report.json"), "utf8"));

// 分类统计
const typed = extractTypedTables(report.chapters, (i) => report.chapters[i]?.title ?? "");
console.log("[typed] tables:", typed.tables.length,
            "| triptych:", typed.stats.triptych_tables,
            "| plain:", typed.stats.plain_tables);
const horiz = typed.tables.filter((t) => t.horizontalCols).length;
console.log("[typed] horizontal triptych:", horiz);

// 完整性
const trust = buildTrustBundle(report.chapters);
console.log("\n[trust] integrity:", trust.integrity.level);
for (const c of trust.integrity.checks) {
  console.log(`  [${c.status}] ${c.label} — ${c.detail.slice(0, 72)}`);
}

// 渲染
console.log("\n[pdf] rendering…");
const pdf = await renderPdfFromReportV8(report);
fs.writeFileSync(path.join(ROOT, "GB4785_新生成_v2.pdf"), pdf);
console.log(`[pdf] written: ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
