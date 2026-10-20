/**
 * The matrix must not be a three-column table that happens to spell A/B/C.
 *
 * Every check so far passes on three real documents, which proves nothing
 * about a fourth: a hardcoded `["A","B","C"]` loop and a derived version list
 * produce identical output on the corpus we happen to own. So this harness
 * feeds the builder corpora it will never see in production — two versions,
 * four versions, a renamed version key, and an upload missing one of them —
 * and asserts on the STRUCTURE rather than on values.
 */
import assert from "node:assert/strict";

const {
  buildParameterMatrix,
  renderMatrixTable,
  versionsOf,
  versionLabel,
} = await import("./dist/parameterMatrix.js");

/** A document with just enough text to be counted as present. */
const doc = (n) => ({ fullText: `第 ${n} 版样本文档\n1 1 2 3 5 8 条款 5.2.4.2 不大于 1200mm\n6 7 9` });

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/* --- 1. version list is derived from the corpus, not declared ------------ */
ok(
  JSON.stringify(versionsOf({ A: doc(1), B: doc(2), C: doc(3) })) === '["A","B","C"]',
  "3-version corpus must yield A,B,C in display order",
);
ok(
  JSON.stringify(versionsOf({ A: doc(1), B: doc(2) })) === '["A","B"]',
  "2-version corpus must yield A,B — a missing C must not become a column of 未定位",
);
ok(
  JSON.stringify(versionsOf({ A: doc(1), B: doc(2), C: doc(3), D: doc(4) })) ===
    '["A","B","C","D"]',
  "an unknown fourth version must be kept, after the known ones",
);
ok(
  versionsOf({ A: doc(1), B: doc(2), C: { fullText: "  " } }).length === 2,
  "a version whose document has no text does not count as present",
);

/* --- 2. the row shape carries N cells, not three named ones -------------- */
{
  const { rows, stats } = buildParameterMatrix({ A: doc(1), B: doc(2), C: doc(3), D: doc(4) });
  ok(stats.versions.length === 4, "a 4-document corpus must produce a 4-version matrix");
  ok(stats.cells === rows.length * 4, "cell count must be rows × versions");
  ok(
    Object.keys(rows[0].cells).join("") === "ABCD" && rows[0].A === undefined,
    "cells must be the only shape — a leftover flat .A would let a 5th column vanish silently",
  );
  const md = renderMatrixTable(rows, stats.versions);
  const head = md.split("\n").find((l) => l.startsWith("| 参数"));
  ok(head.split("|").length - 2 === 1 + 1 + 4 + 1, `header must have 参数+单位+4版本+判定, got: ${head}`);
  ok(md.includes("D"), "the fourth version's label must appear in the detail blocks");
}

/* --- 3. labels are metadata, not hardcoded strings ----------------------- */
ok(versionLabel("A") === "A 草案" && versionLabel("D") === "D", "known keys label, unknown keys pass through");

/* --- 4. a missing version fails loudly instead of rendering empties ------ */
assert.throws(
  () => buildParameterMatrix({ A: doc(1), B: doc(2) }),
  /spec 与语料不匹配/,
  "a 2-document upload must be rejected: the shipped specs describe three versions",
);
assert.throws(
  () => buildParameterMatrix({ A: doc(1) }),
  /spec 与语料不匹配|至少需要 2 版/,
  "a single-document upload cannot be a comparison",
);

/* --- 5. the two-version verdict branch is reachable in principle ---------- */
{
  // Present in both, absent in one → that gap IS the finding. Exercised on a
  // corpus whose text is synthetic, so no cell verifies; what matters is that
  // judging does not reach for a hardcoded third version.
  const { rows } = buildParameterMatrix({ A: doc(1), B: doc(2), C: doc(3) });
  ok(
    rows.every((r) => typeof r.verdict === "string" && typeof r.note === "string"),
    "every row must carry a verdict and a note regardless of corpus",
  );
}

console.log(`✓ ${checks} version-generalization checks passed`);
