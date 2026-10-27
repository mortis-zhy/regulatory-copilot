/**
 * Word 导出的回归用例 —— 已知答案，不调模型。
 *
 * 起因：`POST /api/agent/report/word` 在收到**只有 content、没有
 * changes / parameters / evidence** 的负载时崩在 `report.changes.map` 上，
 * express 的默认错误处理吐一个**裸的 500 HTML 页**。
 *
 * 浏览器一直传全三个数组，所以按钮是好的 —— 崩的是**公开 API**。
 * 但公开 API 崩成 500 HTML，等于告诉调用方「你传的东西有毛病」，
 * 而实际上只是少传了三个可选数组。
 *
 * 这里断言：缺数组 = 空表，不是崩溃。
 */
import { renderWordHtml } from "./dist/export.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 1. 只有 content —— 以前崩在这里
check("content-only payload renders without throwing", () => {
  const html = renderWordHtml({
    title: "自检",
    content: "GB 4785 三版对照 —— 只有正文。",
  });
  assert(html.includes("只有正文"), "正文没渲染出来");
  assert(html.includes("<html"), "不是一份 HTML 文档");
});

// 2. 三个数组全缺
check("payload with no lists at all still renders", () => {
  const html = renderWordHtml({ title: "自检" });
  assert(html.includes("<html"), "不是一份 HTML 文档");
  assert(html.includes("变化点总表"), "章节骨架丢了");
});

// 3. 数组齐的时候，三个表都要有行
check("full payload renders all three tables", () => {
  const html = renderWordHtml({
    title: "自检",
    content: "正文",
    changes: [{ id: "chg01", title: "转向信号灯首次熄灭时间", type: "变化", severity: "中", oldText: "1.5s", newText: "1.0s", impact: "需更新试验", source: "A 5.6.3.4 / B 5.4.3.4" }],
    parameters: [{ name: "倒车灯最大离地高度", oldValue: "1400", newValue: "1400", unit: "mm", impact: "无", source: "第 30 页" }],
    evidence: [{ title: "GB 4785-2019", source: "标准正文", url: "https://example.invalid/gb4785", retrievedAt: "2026-10-27" }],
  });
  assert(html.includes("chg01"), "变化点表没行");
  assert(html.includes("倒车灯最大离地高度"), "参数表没行");
  assert(html.includes("GB 4785-2019"), "证据表没行");
  assert(html.includes("https://example.invalid/gb4785"), "证据链接丢了");
});

// 4. 缺字段不许崩（undefined 以前会打穿 escapeHtml）
check("missing fields inside list items do not crash", () => {
  const html = renderWordHtml({
    title: "自检",
    changes: [{ id: "x" }],
    parameters: [{ name: "p" }],
    evidence: [{ title: "e" }],
    sourceDocuments: [{ name: "A" }],
  });
  assert(html.includes("<html"), "不是一份 HTML 文档");
});

// 5. 还是要转义 —— 别把用户的原文当 HTML 执行
check("HTML in the payload is escaped", () => {
  const html = renderWordHtml({
    title: "<script>alert(1)</script>",
    content: "<img src=x onerror=alert(1)>",
  });
  assert(!html.includes("<script>alert(1)</script>"), "title 没转义");
  assert(!html.includes("<img src=x onerror"), "content 没转义");
  assert(html.includes("&lt;script&gt;"), "title 转义后不见了");
});

const total = 5;
if (failures.length) {
  console.error(`✗ ${failures.length}/${total} failed`);
  for (const f of failures) console.error("  " + f);
  process.exit(1);
}
console.log(`✓ ${passed}/${total} word-export checks passed`);
