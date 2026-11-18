// 生成**多模态对比**（表 / 图 / 公式）—— 写 reports/multimodal.json + reports/multimodal.md
//
// 需要先跑：python scripts/hash_figures.py（算图的 pHash ✓）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mm = await import(pathToFileURL(path.join(ROOT, "dist", "multimodal.js")).href);

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "mineru-v4-data.json"), "utf8"));
const hashes = JSON.parse(fs.readFileSync(path.join(ROOT, "reports", "figure-hashes.json"), "utf8"));
// 图内文字 OCR —— **可选** ✓（没有就不比图内数值，明确写「未比」✓，不假装「相同」✗）
const ocrPath = path.join(ROOT, "reports", "figure-ocr.json");
const ocr = fs.existsSync(ocrPath) ? JSON.parse(fs.readFileSync(ocrPath, "utf8")).images ?? null : null;
const report = JSON.parse(fs.readFileSync(path.join(ROOT, "reports", "last-report.json"), "utf8"));

// 图版 —— **现算** ✓（与报告生成走**同一份实现** ✓，
// 不读 `data[v].figureGallery` ✗ —— 那是构建时的内存产物 ✓，没落进 JSON ✗）。
const { attachFigureGallery } = await import(
  pathToFileURL(path.join(ROOT, "dist", "figureGallery.js")).href
);
const galleries = attachFigureGallery(data);

const versions = Object.keys(galleries).sort();
if (versions.length < 2) {
  console.error("[multimodal] 需要至少两版有图版；现有：", versions);
  process.exit(1);
}

const inv = {};
for (const v of versions) inv[v] = mm.buildInventory(v, data[v], hashes, galleries[v], ocr);

const diffs = [];
for (let i = 0; i < versions.length; i++) {
  for (let j = i + 1; j < versions.length; j++) {
    diffs.push(mm.diffVersions(inv[versions[i]], inv[versions[j]]));
  }
}

const md = [];
md.push("# 多模态对比（表 / 图 / 公式）", "");
md.push(
  "> 只比**素材在不在、像不像** —— 不判语义。图的 pHash 对「图上改一个数」几乎不动，",
  "> 所以**图像近似 ≠ 两版一致**；串行的表（抽取坏了）**不参与比对**。",
  "",
);
for (const v of versions) {
  const x = inv[v];
  md.push(
    `**${v}**：图 ${x.figures.length}（可算指纹 ${x.figures.filter((f) => f.phash).length}）· ` +
      `表 ${x.tables.length}（串行 ${x.tables.filter((t) => t.scrambled).length}）· 公式 ${x.equations.length}`,
  );
}
md.push("");
for (const d of diffs) md.push(mm.renderVersionDiff(d));

fs.writeFileSync(path.join(ROOT, "reports", "multimodal.md"), md.join("\n"));
fs.writeFileSync(
  path.join(ROOT, "reports", "multimodal.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), inventory: inv, diffs }, null, 1),
);
console.log(`[multimodal] ${versions.join(" / ")} · ${diffs.length} 组对比`);
for (const d of diffs) {
  console.log(
    `  ${d.a}↔${d.b}：图近似 ${d.figures.paired.length} · 仅${d.a} ${d.figures.onlyInA.length} · 仅${d.b} ${d.figures.onlyInB.length} · ` +
      `表配对 ${d.tables.paired.length} · 公式同 ${d.equations.identical.length}`,
  );
}
