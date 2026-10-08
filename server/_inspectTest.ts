import fs from "node:fs";
import path from "node:path";
import { extractPdfTextServer } from "./ingestion/pdfExtract";
import { parseAllTables, extractCanonicalIndicators, pairIndicatorsById } from "./ingestion/tableParser";

const ROOT = process.env.COMPARE_AGENT_ROOT
  ? path.resolve(process.env.COMPARE_AGENT_ROOT)
  : path.resolve(import.meta.dirname, "..", "..");
const PDF_A = `${ROOT}/2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf`;
const PDF_B = `${ROOT}/GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf`;

async function main() {
  for (const [name, path] of [["A", PDF_A], ["B", PDF_B]] as const) {
    const bytes = fs.readFileSync(path);
    const r = await extractPdfTextServer(bytes);
    const tables = parseAllTables(r.fullText);
    console.log(`\n=== ${name} ===`);
    console.log(`chars: ${r.fullText.length}, pipes: ${(r.fullText.match(/\|/g) || []).length}, tables: ${tables.length}`);
    for (const t of tables.slice(0, 15)) {
      console.log(`  [${t.pageHint}] ${(t.title || "(no title)").slice(0, 40)} — ${t.rows.length}r x ${t.header.length}c`);
    }
  }
  // Now extract canonical indicators
  const rA = await extractPdfTextServer(fs.readFileSync(PDF_A));
  const rB = await extractPdfTextServer(fs.readFileSync(PDF_B));
  const tablesA = parseAllTables(rA.fullText);
  const tablesB = parseAllTables(rB.fullText);
  const indsA = extractCanonicalIndicators(tablesA);
  const indsB = extractCanonicalIndicators(tablesB);
  console.log(`\n=== Canonical Indicators ===`);
  console.log(`A extracted: ${indsA.length}`);
  for (const i of indsA) console.log(`  ${i.id.padEnd(28)} = ${i.value}${i.unit} [${i.page}]`);
  console.log(`B extracted: ${indsB.length}`);
  for (const i of indsB) console.log(`  ${i.id.padEnd(28)} = ${i.value}${i.unit} [${i.page}]`);
  console.log(`\nPaired:`);
  const pairs = pairIndicatorsById(indsA, indsB);
  for (const p of pairs) {
    const a = p.a ? `${p.a.value}${p.unit}` : "(missing)";
    const b = p.b ? `${p.b.value}${p.unit}` : "(missing)";
    console.log(`  ${p.id.padEnd(28)} | B: ${b.padEnd(20)} | A: ${a}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });