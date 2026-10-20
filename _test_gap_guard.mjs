/**
 * _test_gap_guard.mjs — 验证 surfaceDataGapGuard 在实际 ch10 上触发。
 * 直接调 buildHtml，不走 Playwright。
 */
import fs from "node:fs";
import path from "node:path";
import { buildHtml } from "./dist/htmlRenderV8.js";
import { extractTypedTables } from "./dist/typedTables.js";

const ROOT = path.resolve("..");
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "generated-report.json"), "utf8"));

// 跑一次 extractTypedTables（与 buildHtml 内部调用一致）
const typed = extractTypedTables(report.chapters, (i) => report.chapters[i]?.title ?? "");
console.log("[typed] tables:", typed.tables.length);

// 准备表覆盖映射 — 只关心 ch10
// buildHtml 签名是 buildHtml(report, fonts, opts)，需要 fonts
// 但 buildHtml 内部还会走整个流程；先看 buildHtml 是否能跳过 PDF 渲染
// 这里我们直接调 buildHtml 并拿到 html

// 直接构造 report-like 对象，但只保留 ch10
const fakeFonts = [
  { family: "NotoSansSC", weight: 400, format: "truetype", dataUri: "data:font/ttf;base64," },
  { family: "NotoSansSC", weight: 700, format: "truetype", dataUri: "data:font/ttf;base64," },
  { family: "NotoSerifSC", weight: 400, format: "collection", dataUri: "data:font/ttc;base64," },
];
const ch10Only = {
  ...report,
  chapters: [report.chapters[10]],
  appendices: [],
};

const html = await buildHtml(ch10Only, fakeFonts, { withAnchors: false });

// 统计 gap-guard
const guardCount = (html.match(/class="gap-guard"/g) ?? []).length;
console.log(`\n[ch10] gap-guard count: ${guardCount}`);

// 抓出 guard 的内容
const guardMatches = html.match(/<aside class="gap-guard">[\s\S]*?<\/aside>/g) ?? [];
for (let i = 0; i < guardMatches.length; i++) {
  const text = guardMatches[i].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  console.log(`\n--- gap-guard #${i + 1} (${text.length}ch) ---`);
  console.log(text.slice(0, 400));
}
