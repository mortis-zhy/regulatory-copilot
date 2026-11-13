/**
 * `compare_pdfs.py` 的**稳定性** —— 它不许随机崩。
 *
 * ## 起因（2026-11-13）
 *
 * 交付件重出成 326 页之后，「交付件与报告对不上」那道闸门**随机变红** ✗：
 * 报的是「compare_pdfs.py 没给出 JSON」✗。
 *
 * 查下来：**不是内容不一样** ✗（逐页比对明明 0 处不同 ✓），
 * 而是**进程崩了** ✗ —— Windows 的 access violation（0xC0000005 ✗），
 * 崩在 `pymupdf.close()` 里 ✗。
 *
 * 真正的原因是**同时打开两份 MuPDF 文档** ✗ ⇒ 关其中一份时另一份的共享状态被踩了 ✗。
 * 单份文档的 open → 抽 → close 是稳的 ✓（实测 4/4 ✓）⇒ 改成**一份一份地读** ✓。
 *
 * ## 为什么要有这个用例
 *
 * 这个 bug 的可怕之处是**它看起来像内容问题** ✗ —— 而内容真的一样 ✓。
 * 谁要是没查到底，就会去「重出交付件」✗（没用 ✗）、去「改比较逻辑」✗（更没用 ✗），
 * 最后可能把一道**红是偶发**的闸门调松 ✗。
 *
 * 所以：**把它钉住** ✓ —— 连续跑 N 次，每一次都必须给出 JSON 且退出码为 0 ✓。
 * 一次崩 ⇒ 红 ✓。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 这个用例在**仓库根** ⇒ ROOT 就是它自己所在的目录 ✓
// （写 `".."` 会指到**外层仓库** ✗ —— 那样路径全错 ✗）
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const N = 6;

let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : " —— " + detail}`);
  if (!cond) failed++;
};

console.log("\n[test-compare-pdfs] 比较脚本不许随机崩");

// 拿两份**真实**的 PDF 当输入：闸门渲染的那份 + 交付件 ✓
const gatePdf = path.join(ROOT, "reports", ".verify-render.pdf");
const delivered = path.join(ROOT, "delivery", "PDF对比", "⑪_C列补全_最新版.pdf");
if (!fs.existsSync(gatePdf) || !fs.existsSync(delivered)) {
  console.log("  △ 跳过：闸门渲染的 PDF 或交付件不在（先跑一次 npm run verify）");
  process.exit(0);
}

const input = JSON.stringify({ a: gatePdf, b: delivered });
let crashes = 0;
let badJson = 0;
for (let i = 0; i < N; i++) {
  const r = spawnSync("python", [path.join(ROOT, "scripts", "compare_pdfs.py")], {
    cwd: ROOT,
    input,
    encoding: "utf-8",
    timeout: 180_000,
  });
  if (r.status !== 0) {
    crashes++;
    console.log(`    第 ${i + 1} 次：退出码 ${r.status}（崩溃）`);
    continue;
  }
  let out = null;
  try {
    out = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch {
    badJson++;
    console.log(`    第 ${i + 1} 次：输出不是 JSON —— ${(r.stdout || "").slice(0, 80)}`);
    continue;
  }
  if (out.error) {
    badJson++;
    console.log(`    第 ${i + 1} 次：脚本报错 —— ${out.error}`);
  }
}
check(`${N} 次连续运行都不崩`, crashes === 0, `崩了 ${crashes} 次`);
check("每一次都给出可解析的 JSON", badJson === 0, `${badJson} 次不合格`);

// 顺带确认它**真的**在比内容（不是空转 ✓）
const one = spawnSync("python", [path.join(ROOT, "scripts", "compare_pdfs.py")], {
  cwd: ROOT,
  input,
  encoding: "utf-8",
  timeout: 180_000,
});
let parsed = null;
try {
  parsed = JSON.parse((one.stdout || "").trim().split("\n").pop());
} catch {
  /* 上面已经查过了 */
}
check("输出里有页数与差异数", !!parsed && typeof parsed.pagesA === "number" && typeof parsed.diffCount === "number",
  parsed ? JSON.stringify(parsed).slice(0, 120) : "没拿到输出");

if (failed) {
  console.error(`\n[test-compare-pdfs] ${failed} 条没过 ✗\n`);
  process.exit(1);
}
console.log("\n[test-compare-pdfs] 全部通过 ✓\n");
