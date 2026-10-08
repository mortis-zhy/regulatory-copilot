/**
 * Test the table parser against the 3 real PDFs.
 * Bundle: npx esbuild server/_tableTest.ts --platform=node --packages=external --bundle --format=esm --outfile=dist/table-test.mjs
 * Run:    node dist/table-test.mjs
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { extractPdfTextServer } from "./ingestion/pdfExtract";
import { parseAllTables, extractCanonicalIndicators, pairIndicatorsById } from "./ingestion/tableParser";

const ROOT = process.env.COMPARE_AGENT_ROOT
  ? path.resolve(process.env.COMPARE_AGENT_ROOT)
  : path.resolve(import.meta.dirname, "..", "..");
const PDFS: Array<{ label: string; path: string }> = [
  { label: "A", path: `${ROOT}/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf` },
  { label: "B", path: `${ROOT}/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf` },
];

async function getText(p: { label: string; path: string }): Promise<string> {
  const cacheFile = `${ROOT}/comparison_agent-main/.text-cache/${p.label}.txt`;
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, "utf-8");
  const bytes = fs.readFileSync(p.path);
  const result = await extractPdfTextServer(bytes);
  fs.mkdirSync(`${ROOT}/comparison_agent-main/.text-cache`, { recursive: true });
  fs.writeFileSync(cacheFile, result.fullText, "utf-8");
  return result.fullText;
}

async function main() {
  const texts: Record<string, string> = {};
  for (const p of PDFS) texts[p.label] = await getText(p);

  const tablesA = parseAllTables(texts.A);
  const tablesB = parseAllTables(texts.B);
  console.log(`Tables found: A=${tablesA.length} B=${tablesB.length}`);
  console.log(`\nA table titles (first 25):`);
  for (const t of tablesA.slice(0, 25)) console.log(`  [${t.pageHint}] ${t.title || "(no title)"} — ${t.rows.length}r x ${t.header.length}c`);

  const indsA = extractCanonicalIndicators(tablesA);
  const indsB = extractCanonicalIndicators(tablesB);
  console.log(`\n=== Canonical indicators ===`);
  console.log(`A extracted: ${indsA.length}`);
  for (const i of indsA) console.log(`  ${i.id.padEnd(28)} = ${i.value}${i.unit} [${i.page}]`);
  console.log(`\nB extracted: ${indsB.length}`);
  for (const i of indsB) console.log(`  ${i.id.padEnd(28)} = ${i.value}${i.unit} [${i.page}]`);

  console.log(`\n=== Paired ===`);
  const pairs = pairIndicatorsById(indsA, indsB);
  for (const p of pairs) {
    const av = p.a ? `${p.a.value}${p.unit} [${p.a.page}]` : "(missing)";
    const bv = p.b ? `${p.b.value}${p.unit} [${p.b.page}]` : "(missing)";
    console.log(`  ${p.id.padEnd(28)} | B: ${bv.padEnd(30)} | A: ${av}`);
  }
}
main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});