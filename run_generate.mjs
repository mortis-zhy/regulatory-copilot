/**
 * run_generate.mjs — 单进程直调生成管线（不经 HTTP）。
 *
 * 为什么不用服务器：后台服务会随会话中断被清理，15-20 分钟的生成跑不完整。
 * 直接 import dist/reportGenerator.js，让一个进程从生成跑到出 PDF。
 *
 * 用法: node run_generate.mjs
 * 产物: ../generated-report.json + ../GB4785_新生成.pdf + 控制台质量报告
 */
import fs from "node:fs";
import path from "node:path";
import { generateReport } from "./dist/reportGenerator.js";
import { renderPdfFromReportV8 } from "./dist/htmlRenderV8.js";
import { buildTrustBundle } from "./dist/trustChecks.js";

const ROOT = path.resolve("..");
const payload = JSON.parse(fs.readFileSync(path.join(ROOT, "generate_payload.json"), "utf8"));
const docs = payload.documents.map((d) => ({
  label: d.label,
  fileName: d.fileName,
  text: d.text,
}));

// regex 提取层：走真实的 regexExtract（与服务端一致），失败则退化为空对象
let regexJson = "{}";
try {
  const re = await import("./dist/regexExtractProbe.js").catch(() => null);
  if (re?.buildRegexJson) {
    regexJson = re.buildRegexJson(docs);
    console.log("[regex] built, length:", regexJson.length);
  }
} catch {
  console.log("[regex] unavailable, using empty object");
}

console.log("[gen] starting…");
const t0 = Date.now();

// 串行节流：13 章并发会让 MiniMax 把速率限制报成 402 insufficient_balance。
// 实测：单条调用 HTTP 200，13 并发全部 402。串行 + 间隔可稳定通过。
const CHAPTER_GAP_MS = Number(process.env.GEN_GAP_MS ?? 9000);

const chapters = [];
const appendices = [];
let outline = null;
let errors = [];

for await (const ev of generateReport(docs, regexJson)) {
  switch (ev.type) {
    case "outline":
      outline = ev.outline;
      console.log(`[gen] outline: ${ev.outline.chapters.length} chapters`);
      break;
    case "chapter_start":
      console.log(`[gen] → ch${ev.id} ${ev.title} (${ev.index + 1}/${ev.total})`);
      break;
    case "chapter_done":
      chapters.push({ id: ev.id, title: ev.title, markdown: ev.markdown });
      if (/本章生成失败|MiniMax request failed/.test(ev.markdown ?? "")) {
        errors.push(ev.title);
        console.log(`[gen] ✗ ch${ev.id} FAILED`);
      } else {
        console.log(`[gen] ✓ ch${ev.id} ${(ev.markdown ?? "").length} chars`);
      }
      break;
    case "appendix_done":
      appendices.push({ id: ev.id, title: ev.title, markdown: ev.markdown });
      console.log(`[gen] appendix ${ev.id} (${(ev.markdown ?? "").length} chars)`);
      break;
    case "error":
      console.log(`[gen] ERROR: ${ev.message.slice(0, 120)}`);
      break;
  }
}

const mins = ((Date.now() - t0) / 60000).toFixed(1);
const report = {
  outline,
  chapters,
  appendices,
  sourceDocuments: docs.map((d) => ({ label: d.label, name: d.fileName, meta: "" })),
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(path.join(ROOT, "generated-report.json"), JSON.stringify(report), "utf-8");
console.log(`\n[gen] done in ${mins} min`);
console.log(`[gen] chapters: ${chapters.length} | appendices: ${appendices.length}`);
if (errors.length) console.log(`[gen] FAILED chapters (${errors.length}): ${errors.join(", ")}`);

// 质量门禁
const trust = buildTrustBundle(chapters);
console.log(`\n[quality] integrity = ${trust.integrity.level}`);
for (const c of trust.integrity.checks) {
  console.log(`  [${c.status}] ${c.label} — ${c.detail.slice(0, 70)}`);
}
console.log(`[quality] closure: ${JSON.stringify(trust.dashboard ?? trust.counts)}`);

// 出 PDF
if (trust.integrity.level !== "blocked") {
  console.log("\n[pdf] rendering…");
  const pdf = await renderPdfFromReportV8(report);
  fs.writeFileSync(path.join(ROOT, "GB4785_新生成.pdf"), pdf);
  console.log(`[pdf] written: ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
} else {
  console.log("\n[pdf] SKIPPED — integrity gate blocked (this is the gate working)");
}
