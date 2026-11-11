/**
 * **渲染失败路径**的用例（同事 issue #4 的三条 ✓）。
 *
 * > 「代码仍会在页面加载超时后继续渲染，并忽略字体加载异常；
 *   我还模拟了 Python 不可用，PDF 检查返回 skipped 后未抛错。」
 *
 * ## 为什么这道用例重要
 *
 * 原来的闸门**只测正常路径** ✓ —— 这三条**一条都没测** ✗，
 * 于是闸门绿着，而失败处理是坏的 ✗。
 *
 * 这三条现在**各自真的会失败** ✓ —— 不是靠代码评审说「改了」✓，
 * 是**跑一遍就知道** ✓：
 *
 * | # | 怎么制造这个失败 | 必须发生什么 |
 * |---|---|---|
 * | ① | 把加载超时压到 **1ms**（`V8_RENDER_TIMEOUT_MS`）✓ | 渲染**抛** `RenderFailedError` ✓ —— 不产出 PDF ✓ |
 * | ② | 造一份**字体必然加载失败**的 HTML ✓ | 版面探测**抛**并点名是哪个字体 ✓ |
 * | ③ | 把自检脚本路径指向**不存在的文件** ✓ | 自检**抛** `pdf_gate_failed` ✓ —— 「没跑成」不算「通过」✓ |
 *
 * 跑法：`node _test_render_failure_paths.mjs`
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

// ==========================================================================
// ① 页面加载超时 → 渲染必须**抛**（不产出 PDF）
// ==========================================================================
const { renderPdfFromReportV8 } = await import("./dist/htmlRenderV8.js");

// 一份**最小**的报告 —— 渲染只需要把它排成版 ✓（不查语料 ✓）
const tinyReport = {
  outline: { title: "超时用例", chapters: [{ id: 1, title: "第 1 章" }], appendices: [] },
  chapters: [{ id: 1, title: "第 1 章", markdown: "# 第 1 章\n\n一句话。\n" }],
  appendices: [],
  parameterMatrix: [],
  parameterMatrixStats: {},
  sourceDocuments: [],
};

process.env.V8_RENDER_TIMEOUT_MS = "1";
let timeoutErr = null;
try {
  await renderPdfFromReportV8(tinyReport);
} catch (e) {
  timeoutErr = e;
} finally {
  delete process.env.V8_RENDER_TIMEOUT_MS;
}
ok(
  timeoutErr && timeoutErr.code === "render_failed",
  `加载超时没有抛 RenderFailedError（拿到的是 ${timeoutErr?.code ?? "没有错误"}）—— ` +
    "超时意味着版面可能只排了一半，不该产出 PDF",
);
ok(
  /超时/.test(String(timeoutErr?.message ?? "")),
  "超时错误里没说清是超时 —— 运维看到「渲染失败」不知道该查什么",
);

// ==========================================================================
// ② 字体加载失败 → 必须**抛**（点名是哪个字体）
// ==========================================================================
const { auditHtmlLayout } = await import("./dist/htmlRenderV8.js");
// 一个**必然加载失败**的字体：base64 是垃圾 ✓
const brokenFontHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "BrokenProbe"; src: url("data:font/ttf;base64,AAAAAAAA"); }
body { font-family: "BrokenProbe", sans-serif; }
</style></head><body><p>字体探测</p></body></html>`;
let fontErr = null;
try {
  await auditHtmlLayout(brokenFontHtml);
} catch (e) {
  fontErr = e;
}
ok(
  fontErr && /字体加载失败/.test(String(fontErr?.message ?? "")),
  `字体加载失败没有被点名（拿到的是 ${fontErr?.message ?? "没有错误"}）—— ` +
    "字体没加载出来，纸面上是豆腐块（□），不能当没事",
);

// ==========================================================================
// ③ PDF 自检**没跑成** → 必须**抛**（不是「通过」）
// ==========================================================================
const { assertPdfGates } = await import("./dist/pdfGates.js");
let gateErr = null;
try {
  assertPdfGates(Buffer.from("%PDF-1.4 fake"), { scriptPath: "no-such-script.py" });
} catch (e) {
  gateErr = e;
}
ok(
  gateErr && gateErr.code === "pdf_gate_failed",
  `PDF 自检「没跑成」时没有拦住（拿到的是 ${gateErr?.code ?? "没有错误"}）—— ` +
    "「没跑成」被当成了「通过」，而它**什么都没查**",
);
ok(
  /没跑成/.test(String(gateErr?.message ?? "")),
  "错误信息里没说清「没跑成」—— 运维会以为是 PDF 本身有问题",
);

console.log(`✓ 渲染失败路径用例全过（${n} 条断言）`);
