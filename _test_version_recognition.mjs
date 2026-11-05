/**
 * 「按内容认版本」的**已知答案**用例。
 *
 * ## 为什么必须有这张用例
 *
 * 项目里认版本有**三套实现**（sidecar 按文件名、clause_split 按内容标记、
 * matrix 按内容相似度）。网站那条路原先用的是**按文件名**那套 ——
 * 于是用户把文件改了名，整个流程在最后一步报 400「文件名不匹配」，
 * 而**文件内容完全没问题**。换一套标准时这一处也要改，
 * 而它**本可以不用改**（相似度那套不需要为新标准写任何声明）。
 *
 * 所以判据必须是**只看内容**。这张用例把这句话变成可执行断言：
 *
 *   ① sha256 判据：语料里每一版，逐字节认得出；
 *   ② **改名不改判**：把同一份字节写成一个毫无意义的名字，认出的版本不变；
 *   ③ 内容判据（同一份）：MuPDF 文本对 MuPDF 文本 —— 认得出；
 *   ④ 内容判据（另一个副本）：排版被改过的同一份 —— 还是认得出；
 *   ⑤ **不许瞎猜**：不相干的文件必须认不出（而不是硬认成最像的那个）；
 *   ⑥ 两版难分时**不认**（宁可空着，不可错着）。
 *
 * 运行：node _test_version_recognition.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { recognizeBySha256, recognizeByReferences } from "./dist/versionRecognize.js";
import { extractPdfTextServer } from "./dist/pdfExtract.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

const ROOT = process.cwd();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// ── 语料 ─────────────────────────────────────────────────────────
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "mineru-v4-data.json"), "utf-8"));
const versions = Object.keys(corpus);
console.log(`语料版本：${versions.join(" / ")}\n`);

if (versions.length < 2) {
  console.error(`  ✗ 语料里只有 ${versions.length} 版，本用例至少要两版才能验「认谁」`);
  process.exit(1);
}

/** 语料每一版的源 PDF（活语料，跟仓库走）。 */
const sources = new Map();
for (const [ver, doc] of Object.entries(corpus)) {
  const sha16 = String(doc?.sourceSha256 ?? "").slice(0, 16);
  const p = path.join(ROOT, "uploaded-docs", `${sha16}.pdf`);
  if (!sha16 || !fs.existsSync(p)) {
    console.error(`  ✗ 语料 ${ver} 版找不到源 PDF（uploaded-docs/${sha16}.pdf）`);
    process.exit(1);
  }
  sources.set(ver, { path: p, bytes: fs.readFileSync(p) });
}

// ── ① sha256 判据 ───────────────────────────────────────────────
console.log("① sha256 判据（逐字节相同）：");
for (const [ver, { bytes }] of sources) {
  const g = recognizeBySha256(sha256(bytes), corpus);
  ok(g.label === ver, `${ver} 版认成 ${String(g.label).padEnd(4)}（判据 ${g.source}）`);
}

// ── ② 改名不改判 ───────────────────────────────────────────────
// 把同一份字节写成一个「文件名里没有任何标准信息」的名字，再认一次。
// 名字是唯一会变的量，答案必须不变。
console.log("\n② 改了名字以后，认出的版本不变：");
const tmpDir = path.join(ROOT, "tmp", "_recognize_rename_test");
fs.mkdirSync(tmpDir, { recursive: true });
for (const [ver, { bytes }] of sources) {
  const renamed = path.join(tmpDir, "无意义名字.pdf");
  fs.writeFileSync(renamed, bytes);
  const back = fs.readFileSync(renamed);
  const g = recognizeBySha256(sha256(back), corpus);
  ok(g.label === ver, `${ver} 版 → 无意义名字.pdf → 仍认成 ${String(g.label).padEnd(4)}`);
  fs.unlinkSync(renamed);
}
fs.rmdirSync(tmpDir);

// ── ③④ 内容判据 ───────────────────────────────────────────────
// 参考件 = 语料各版的源 PDF，用 **MuPDF** 取文本 —— 与上传文件**同一种表示**。
console.log("\n③ 内容判据（同一份，MuPDF 对 MuPDF）：");
const refs = [];
const texts = new Map();
for (const [ver, { bytes }] of sources) {
  const r = await extractPdfTextServer(bytes);
  const t = r?.fullText ?? "";
  texts.set(ver, t);
  refs.push({ label: ver, text: t });
}
for (const [ver, t] of texts) {
  const g = recognizeByReferences(t, refs);
  ok(g.label === ver, `${ver} 版认成 ${String(g.label).padEnd(4)}（相似度 ${g.score.toFixed(3)}）`);
}

console.log("\n④ 内容判据（另一个副本：排版被改过）：");
// 换一个副本 = 重新排版过的同一份。空白与换行会被改，
// 但**字词**不变 —— 认版本该认的是这个。
for (const [ver, t] of texts) {
  const reflowed = t.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  const g = recognizeByReferences(reflowed, refs);
  ok(g.label === ver, `${ver} 版（重排）认成 ${String(g.label).padEnd(4)}（相似度 ${g.score.toFixed(3)}）`);
}

// ── ⑤ 不许瞎猜 ─────────────────────────────────────────────────
console.log("\n⑤ 不相干的文件必须认不出：");
const foreign = [
  ["欧法规样例", "Regulation No 148 Uniform provisions concerning the approval of vehicles for the construction of the comprehensive vision front lighting systems. Installation requirements and photometric and other performance characteristics."],
  ["中文无关文本", "本文件为一份与汽车灯具无关的说明材料，内容涉及文件归档、编号规则、版本管理与责任分工，不包含任何法规条款、限值或试验方法。"],
];
for (const [name, text] of foreign) {
  const g = recognizeByReferences(text, refs);
  ok(g.label === null, `${name} → 认成 ${String(g.label)}（应为 null，理由：${g.reason}）`);
}

// ── ⑥ 两版难分时不认 ───────────────────────────────────────────
console.log("\n⑥ 两版难分时不认（宁可空着，不可错着）：");
const [v1, v2] = versions;
const t1 = texts.get(v1) ?? "";
const t2 = texts.get(v2) ?? "";
if (t1 && t2) {
  const half = (s) => s.slice(0, Math.floor(s.length / 2));
  const mixed = `${half(t1)}\n${half(t2)}`;
  const g = recognizeByReferences(mixed, refs);
  ok(
    g.label === null || g.reason.includes("难分"),
    `两版各半的混合文本 → ${String(g.label)}，理由「${g.reason}」`,
  );
}

// ── 结构保证：判据里没有文件名这回事 ───────────────────────────
console.log("\n⑦ 判据的入参里没有文件名（结构上不可能靠名字认）：");
const src = fs.readFileSync(path.join(ROOT, "server", "reports", "versionRecognize.ts"), "utf-8");
const sigs = [
  ...src.matchAll(/export function (recognize\w+)\(([^)]*)\)/g),
];
ok(sigs.length >= 2, `找到 ${sigs.length} 个认版本函数的签名`);
for (const [, name, params] of sigs) {
  const bad = params
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /name|path|file/i.test(p));
  ok(bad.length === 0, `${name}(${params.replace(/\s+/g, " ").trim()}) 的入参里没有文件名/路径`);
}
ok(!/from\s+["']node:(fs|path)["']/.test(src), "判据模块没有引入 fs/path");

console.log(
  failures === 0
    ? "\n认版本用例全过：改名不改判、不相干的不瞎猜、两版难分不认。"
    : `\n${failures} 条认版本用例没过。`,
);
process.exit(failures === 0 ? 0 : 1);
