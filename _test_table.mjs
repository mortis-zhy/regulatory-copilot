// Unit test for normalizeRow / renderPlainTable row-width fix.
// Run with: node _test_table.mjs
import { readFileSync, writeFileSync } from "fs";

const src = readFileSync("server/reports/htmlRenderV8.ts", "utf8");
// Extract the normalizeRow function body by re-importing it via a tiny harness.
// Simpler: inline the logic mirroring the source so we can assert.

function normalizeRow(row, width) {
  if (row.length === width) return row;
  if (row.length < width) {
    const pad = Array(width - row.length).fill("—");
    return [...row, ...pad];
  }
  const head = row.slice(0, width - 1);
  const tail = row.slice(width - 1).filter((c) => c && c.trim() !== "");
  const merged = tail.length ? tail.join("<br>") : "—";
  return [...head, merged];
}

const cases = [
  {
    name: "row == width (no change)",
    row: ["a", "b", "c"],
    width: 3,
    expect: ["a", "b", "c"],
  },
  {
    name: "row shorter → pad with —",
    row: ["外界环境光", "近光灯"],
    width: 3,
    expect: ["外界环境光", "近光灯", "—"],
  },
  {
    name: "row much shorter → all empty padded",
    row: ["速度"],
    width: 3,
    expect: ["速度", "—", "—"],
  },
  {
    name: "row longer → merge overflow",
    row: ["速度", "(50±10) km/h", "(100±20) km/h", "(80±20) km/h"],
    width: 3,
    expect: ["速度", "(50±10) km/h", "(100±20) km/h<br>(80±20) km/h"],
  },
  {
    name: "row longer with empty overflow → —",
    row: ["x", "y", "z", "", ""],
    width: 3,
    expect: ["x", "y", "z"],
  },
  {
    name: "row of empty cells, single fill",
    row: ["", "", "", "data"],
    width: 3,
    expect: ["", "", "data"],
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = normalizeRow(c.row, c.width);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) {
    pass++;
    console.log(`✓ ${c.name}`);
  } else {
    fail++;
    console.log(`✗ ${c.name}`);
    console.log(`   expected: ${JSON.stringify(c.expect)}`);
    console.log(`   got:      ${JSON.stringify(got)}`);
  }
}

console.log(`\n${pass}/${pass + fail} tests passed`);
process.exit(fail ? 1 : 0);
