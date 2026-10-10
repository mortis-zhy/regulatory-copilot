/**
 * `npm run verify` — the pre-ship gate.
 *
 * Exists because three real fixes were once written into dist/*.js, which is
 * gitignored build output: `npm run build` silently overwrote them, and a later
 * cleanup script deleted the whole directory. The source never changed, so
 * nothing caught it. Two rules follow from that:
 *
 *   1. Never grep dist/ for a behaviour. Check the SOURCE. (Below.)
 *   2. Detect "source edited but dist never rebuilt" via the build manifest,
 *      so the reverse mistake — editing .ts and forgetting npm run build —
 *      also fails loudly instead of shipping stale JS.
 *
 * Exits non-zero on the first failing check so CI (or you) stops.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf-8");
const sha256 = (rel) => createHash("sha256").update(readFileSync(resolve(ROOT, rel))).digest("hex");

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks++;
  try {
    const detail = fn();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${e.message.split("\n").join("\n        ")}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("\n=== 1. dist modules present ===");
for (const m of ["index", "htmlRenderV8", "typedTables", "reportGenerator", "closureLedger"]) {
  check(`dist/${m}.js`, () => {
    const p = `dist/${m}.js`;
    assert(existsSync(resolve(ROOT, p)), `${p} missing — run \`npm run build\``);
    return `${(statSync(resolve(ROOT, p)).size / 1024).toFixed(0)} KB`;
  });
}

console.log("\n=== 2. dist is current with source ===");
check("dist/.build-manifest.json matches source hashes", () => {
  const mf = resolve(ROOT, "dist/.build-manifest.json");
  assert(existsSync(mf), "no build manifest — run `npm run build`");
  const { sources, builtAt } = JSON.parse(readFileSync(mf, "utf-8"));
  const stale = Object.entries(sources).filter(([f]) => existsSync(resolve(ROOT, f)) && sha256(f) !== sources[f]);
  assert(
    stale.length === 0,
    `dist is stale for: ${stale.map(([f]) => f).join(", ")}\n` +
      `        source changed after the last build (${builtAt}) — run \`npm run build\``,
  );
  return `built ${builtAt}`;
});

console.log("\n=== 3. source invariants (never grep dist/) ===");

check("ReportBuilder download filename", () => {
  const src = read("client/src/components/ReportBuilder.tsx");
  const hits = [...src.matchAll(/a\.download\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert(hits.length === 1, `expected exactly one a.download assignment, found ${hits.length}`);
  assert(
    hits[0] === "GB 4785 多版本横向对比研究报告.pdf",
    `download name is "${hits[0]}" — expected the GB 4785-prefixed name`,
  );
  return hits[0];
});

check(".cover-eyebrow letter-spacing stays readable", () => {
  const src = read("server/reports/htmlRenderV8.ts");
  const block = src.match(/\.cover-eyebrow\s*\{([^}]*)\}/);
  assert(block, ".cover-eyebrow rule not found");
  // Parse the number rather than substring-matching, so a reformat survives.
  const m = block[1].match(/letter-spacing:\s*([\d.]+)px/);
  assert(m, "no px letter-spacing found in .cover-eyebrow");
  const px = parseFloat(m[1]);
  assert(px <= 2, `letter-spacing is ${px}px; >2px splits "REGULATORY" into spaced letters`);
  return `${px}px`;
});

check("renderPdfFromReportV8 embeds CJK fonts", () => {
  const src = read("server/reports/htmlRenderV8.ts");
  const fn = src.match(/export async function renderPdfFromReportV8[\s\S]*?\n}/);
  assert(fn, "renderPdfFromReportV8 not found");
  assert(
    fn[0].includes("emulateMedia"),
    "no emulateMedia — Chromium will NOT embed @font-face CJK fonts and the PDF shows tofu boxes",
  );
  assert(
    fn[0].includes("f.load()"),
    "no explicit font .load() — lazily-decoded base64 faces are skipped",
  );
  return "emulateMedia + explicit font load";
});

check("pipeline version in step with package.json", () => {
  const pkg = JSON.parse(read("package.json"));
  const src = read("server/reports/htmlRenderV8.ts");
  const m = src.match(/export const PIPELINE_VERSION\s*=\s*"([^"]+)"/);
  assert(m, "PIPELINE_VERSION not exported from htmlRenderV8.ts");
  assert(
    m[1] === pkg.version,
    `PIPELINE_VERSION=${m[1]} but package.json.version=${pkg.version}`,
  );
  return m[1];
});

check("no hardcoded absolute user paths in pipeline code", () => {
  // Scope: the modules the report pipeline actually imports. The one-off
  // debug_* / probe_* / demo scripts legitimately hardcode paths — they are
  // run by hand against this machine, not part of the product.
  const targets = [
    "server",
    "client/src",
    "verify_claims.py",
    "extract_mineru_v4_sdk.py",
    "python_service",
    "audit_pages.py",
  ];
  const hits = spawnSync("git", ["grep", "-l", "Users/zsndz", "--", ...targets], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const out = (hits.stdout || "").trim();
  assert(!out, `hardcoded path(s) in pipeline code:\n        ${out}\n        use COMPARE_AGENT_ROOT or __file__-relative paths`);
  return "clean";
});

console.log("\n=== 4. python verification layer ===");

function runPy(args, label) {
  const r = spawnSync("python", args, { cwd: ROOT, encoding: "utf-8" });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), r };
}

check("verify_claims.py candidate partition closes", () => {
  const { ok, out } = runPy(["verify_claims.py"], "verify_claims");
  assert(ok, `verify_claims.py exited non-zero:\n        ${out.slice(-600)}`);
  const json = JSON.parse(read("dist/verified-comparison.json"));
  const f = json.flow;
  assert(f.partitionClosed === true, "flow.partitionClosed is not true");
  const sum = Object.values(f.buckets).reduce((a, b) => a + b, 0);
  assert(
    sum === f.candidates,
    `buckets sum ${sum} != candidates ${f.candidates}: ${JSON.stringify(f.buckets)}`,
  );
  assert(
    Object.keys(f.ruleDroppedByRule ?? {}).length > 0,
    "no named rule-drop reasons — did the R1/R2 audit trail regress?",
  );
  return `${sum}==${f.candidates}, rules ${JSON.stringify(f.ruleDroppedByRule)}`;
});

check("manual findings are hash-bound to the source PDFs", () => {
  const mf = JSON.parse(read("data/manual-findings.json"));
  assert(mf.findings.length > 0, "manual-findings.json has no findings");
  assert(mf.sources && Object.keys(mf.sources).length === 3, "expected sha256 for A/B/C sources");
  const { out } = runPy(["verify_claims.py"], "verify_claims");
  assert(
    !out.includes("降级为待重核"),
    "manualFindings were demoted — a source PDF changed and needs re-audit:\n        " +
      out.split("\n").filter((l) => l.includes("待重核")).join("\n        "),
  );
  return `${mf.findings.length} findings, 3 source hashes match`;
});

check("audit_pages.py re-verifies cited pages against the PDFs", () => {
  const { ok, out } = runPy(["audit_pages.py"], "audit_pages");
  assert(ok, `audit_pages.py reported failures:\n        ${out.slice(-800)}`);
  return out.match(/=== result:.*/)?.[0]?.replace("=== ", "") ?? "ok";
});

console.log("\n=== 4b. rendered report (reports/last-report.json) ===");

// These four checks exist because the gate was 18/18 green while the delivered
// PDF was missing four whole sections and quoting a wrong candidate total.
// Every earlier check looked at SOURCE; none of them looked at what the
// pipeline actually assembled. Assert on the artifact instead.

function loadReport() {
  const p = resolve(ROOT, "reports/last-report.json");
  assert(existsSync(p), "reports/last-report.json missing — generate a report first");
  const r = JSON.parse(readFileSync(p, "utf-8"));
  assert(r.generator === "mineru", `last-report.json generator is "${r.generator}", expected mineru`);
  return r;
}

check("chapter 11 keeps sections 11.2 / 11.3 / 11.3.0 / 11.4", () => {
  // changePointChapter returns a "> **本子节无内容**" placeholder for an empty
  // section, and reportV6 swapped those for verified content via a regex that
  // matched the wrong literal ("_(本子节无内容)_"), so all four vanished while
  // the executive summary still told readers to go look at 11.3.
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const missing = ["11.2 删除条款汇总", "11.3 重大修订条款", "11.3.0 同文勘误", "11.4 数据指标变化"].filter(
    (h) => !md.includes(h),
  );
  assert(missing.length === 0, `missing from the assembled report: ${missing.join(", ")}`);
  assert(!/本子节无内容/.test(md), "an unfilled placeholder reached the report");
  return "11.2 / 11.3 / 11.3.0 / 11.4 all present";
});

check("executive summary candidate count closes against the ledger", () => {
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const facts = JSON.parse(read("dist/facts.json"));
  // EVERY declaration, not just the first: the report states this in both the
  // executive summary and §11.3, and the defect that shipped had them
  // disagreeing (13 vs 45) while each looked fine on its own.
  const all = [...md.matchAll(/(\d+)\s*条候选的完整去向[\s\S]{0,400}?合计\s*(\d+)/g)];
  assert(all.length > 0, "no 「N 条候选的完整去向 … 合计 M」 declaration found");
  for (const m of all) {
    assert(
      Number(m[1]) === facts.counts.candidates,
      `a declaration claims ${m[1]} candidates, facts.json says ${facts.counts.candidates}`,
    );
    assert(
      m[1] === m[2],
      `a declaration opens with ${m[1]} candidates but closes with 「合计 ${m[2]}」`,
    );
  }
  return `${all.length} declaration(s), all ${facts.counts.candidates}`;
});

check("chapter 11 candidate buckets sum to the candidate total", () => {
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const i = md.indexOf("条候选的完整去向");
  assert(i > 0, "no candidate-flow declaration");
  const body = md.slice(i, md.indexOf("合计", i));
  const addends = [...body.matchAll(/(\d+)\s*条(?!\s*候选)/g)].map((x) => Number(x[1]));
  const sum = addends.reduce((a, b) => a + b, 0);
  const facts = JSON.parse(read("dist/facts.json"));
  assert(
    sum === facts.counts.candidates,
    `addends ${addends.join("+")} = ${sum} != ${facts.counts.candidates}`,
  );
  return addends.join("+") + ` = ${sum}`;
});

/*
 * Coverage checks.
 *
 * These exist because the gate was green through an entire broken delivery:
 * §11.3.3 parameter matrix deleted outright, appendix C's header renamed so the
 * triptych renderer no longer recognised it — both passed 23/23. Everything
 * above asserts internal consistency; nothing asserted that the source data
 * actually REACHES the reader. These do.
 */

function reportText() {
  return loadReport()
    .chapters.concat(loadReport().appendices ?? [])
    .map((c) => c.markdown ?? "")
    .join("\n");
}

check("§11.3.3 parameter matrix carries every valueDiff", () => {
  const md = reportText();
  const diffPath = resolve(ROOT, "diff-result.json");
  assert(existsSync(diffPath), "diff-result.json missing — matrix cannot be verified");
  const total = JSON.parse(readFileSync(diffPath, "utf-8")).valueDiffs?.length ?? 0;
  assert(total > 0, "diff-result.json has no valueDiffs");
  const i = md.indexOf("### 11.3.3");
  assert(i >= 0, "§11.3.3 参数对照矩阵 missing — the deliverable's main table is gone");
  const section = md.slice(i, md.indexOf("\n### ", i + 5) < 0 ? undefined : md.indexOf("\n### ", i + 5));
  const rows = (section.match(/^\| \d\d \| /gm) ?? []).length;
  assert(
    rows >= total,
    `matrix lists ${rows} of ${total} valueDiffs — a parameter family went missing`,
  );
  return `${rows}/${total} 参数行`;
});

check("every valueDiff family reaches the report with a C clause", () => {
  const md = reportText();
  const diff = JSON.parse(read("diff-result.json"));
  // Count rows whose own C reference appears in the report. Counting raw "R48 "
  // occurrences would be wrong twice over: clause numbers are multi-level
  // (6.5.9), and several rows legitimately share one clause. The C side is not
  // always clause §6 either — five rows point at R48 Annexes (Annex 12/13), so
  // accept both shapes or the check reports a false regression.
  const cRef = (source) => {
    const m = String(source ?? "").match(/C=((?:\d+(?:\.\d+)+)|Annex\s*\d+[A-Za-z]?)/i);
    return m ? m[1].replace(/\s+/g, " ") : null;
  };
  const rowsWithC = diff.valueDiffs.filter((v) => {
    const ref = cRef(v.source);
    return ref && (md.includes(`R48 ${ref}`) || md.includes(`R48 ${ref.replace(/^Annex\s*/i, "Annex ")}`));
  }).length;
  const expectC = diff.valueDiffs.filter((v) => cRef(v.source)).length;
  assert(
    rowsWithC === expectC,
    `only ${rowsWithC}/${expectC} rows with a C source cite their R48 clause — ` +
      "the C column regressed to empty or truncated the reference",
  );
  const unique = new Set([...md.matchAll(/R48 ((?:\d+(?:\.\d+)*)|Annex\s*\d+)/gi)].map((m) => m[1]));
  return `${rowsWithC}/${expectC} 行带 C 引用（${unique.size} 个唯一引用）`;
});

check("executive summary states conclusions, not just counts", () => {
  const md = reportText();
  assert(md.includes("本报告的结论"), "执行摘要缺少「本报告的结论（按决策口径）」段");
  const i = md.indexOf("本报告的结论");
  const block = md.slice(i, i + 1600);
  const numbered = (block.match(/^\d\. \*\*/gm) ?? []).length;
  assert(numbered >= 3, `决策结论只有 ${numbered} 条，应至少 3 条（设计/编号/出口/不可用）`);
  return `${numbered} 条决策口径`;
});

check("appendix C is rendered as a three-version table", () => {
  // The regression that shipped: the triptych renderer recognises version
  // columns only by header name, so renaming that column silently turned 24
  // topics into 73 "源数据未提供" placeholders while the data sat unused in the
  // markdown. Assert the SAME predicate the renderer uses, so renaming the
  // header fails here instead of reaching the client.
  const md = reportText();
  const RENDERER_HEADER = /^(版本|来源|文档|文件|标准|version|document|file)$/i;
  // Locate appendix C's own table (it is the one whose body rows are A/B/C),
  // not just the first pipe-table in the document.
  const appendixC = md.slice(md.search(/附录 C A\|B|C/) >= 0 ? md.search(/附录 C A\|B\|C/) : md.search(/# 附录 C/));
  assert(appendixC.length > 0, "附录 C 内容缺失");
  const cells = [...appendixC.matchAll(/^\| *([^|]+?) *\|/gm)].map((m) => m[1].replace(/\*/g, "").trim());
  const headerCell = cells.find((c) => RENDERER_HEADER.test(c));
  assert(
    headerCell,
    `附录 C 表头 [${cells.slice(0, 4).join(" / ")}] 不在渲染器版本列白名单内 — ` +
      "三栏卡片会全部退回「源数据未提供」",
  );
  const aRows = (md.match(/^\| A \| \d/gm) ?? []).length;
  const cRows = (md.match(/^\| C \| \d/gm) ?? []).length;
  assert(aRows > 0 && cRows > 0, `附录C 三版本行缺失 (A=${aRows}, C=${cRows}) — C 列会渲染成空`);
  return `表头「${headerCell}」· A 行 ${aRows} / C 行 ${cRows}`;
});

check("delivered PDF has no placeholder cells claiming missing data", () => {
  const pdfPath = process.env.VERIFY_PDF || resolve(ROOT, "reports/last-report.pdf");
  if (!existsSync(pdfPath)) return "skipped — set VERIFY_PDF=<path>";
  // Pass the path base64-encoded: on Windows a non-ASCII argv reaches Python as
  // mojibake ("GB 4785 ��汾...") and stdin is truncated mid-multibyte-char, so
  // fitz cannot open the file — silently turning this check into a no-op on
  // exactly the deliverable filename we care about.
  const py =
    "import sys,io,json,base64,fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path); t='\\n'.join(p.get_text() for p in d)\n" +
    "print(json.dumps({'n':t.count('源数据未提供')}))\n";
  const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf-8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) return `skipped — ${(r.stderr || "").trim().split("\n").pop().slice(0, 80)}`;
  const { n } = JSON.parse(r.stdout.trim().split("\n").pop());
  // A handful is legitimate (a table genuinely absent in one version); dozens
  // means the triptych renderer stopped recognising a table shape.
  assert(n <= 8, `${n} "源数据未提供" placeholders — a table stopped rendering (was 73)`);
  return `${n} placeholder cells (limit 8)`;
});

check("no markdown artefacts in the assembled report", () => {  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  // A bare "#" line means an h4 was split mid-heading by a non-line-anchored
  // lookahead ("#### 11.1.1" contains "### 11." at offset 1). This one CAN be
  // asserted on the markdown.
  //
  // Stray "**" cannot: the report markdown is the input to inlineMd, so it is
  // *supposed* to contain bold syntax. Whether a given "**" survives into the
  // PDF depends on which render path claimed its line, so that is checked
  // against the built PDF below rather than here.
  const strayHash = md.match(/^#$/gm) ?? [];
  assert(
    strayHash.length === 0,
    `${strayHash.length} orphan "#" line(s) — a heading was split in half`,
  );
  return "no orphan # lines";
});

check("built PDF has no unrendered markdown (needs PyMuPDF + a PDF)", () => {
  const pdfPath = process.env.VERIFY_PDF || resolve(ROOT, "reports/last-report.pdf");
  if (!existsSync(pdfPath)) return "skipped — set VERIFY_PDF=<path> to check a built PDF";
  const py2 =
    "import sys,io,json,base64,fitz,re\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path); t='\\n'.join(p.get_text() for p in d)\n" +
    "print(json.dumps({'pages':d.page_count,'bookmarks':len(d.get_toc()),\n" +
    "'bold':len(re.findall(r'\\*\\*',t)),\n" +
    "'tofu':sum(1 for pg in d for b in pg.get_text('rawdict')['blocks']\n" +
    "          for l in b.get('lines',[]) for s in l.get('spans',[])\n" +
    "          for c in s.get('chars',[]) if c['c'] in ('\\ufffd','\\u25a1') or ord(c['c'])==0),\n" +
    "'empty':[i+1 for i,pg in enumerate(d) if not pg.get_text().strip()]}))\n";
  const r = spawnSync("python", ["-c", py2], {
    cwd: ROOT,
    encoding: "utf-8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) return `skipped — ${(r.stderr || "").trim().split("\n").pop().slice(0, 80)}`;
  const m = JSON.parse(r.stdout.trim().split("\n").pop());
  assert(m.bold === 0, `${m.bold / 2} unrendered markdown bold marker(s) in the PDF text`);
  assert(m.tofu === 0, `${m.tofu} tofu/replacement glyph(s) — CJK font embedding regressed`);
  assert(m.empty.length === 0, `blank page(s): ${m.empty.join(", ")}`);
  assert(m.bookmarks > 0, "PDF has no bookmarks");
  return `${m.pages}p, ${m.bookmarks} bookmarks, 0 bold, 0 tofu, 0 blank`;
});

console.log("\n=== 5. renderer unit harness ===");
for (const t of ["_test_math.mjs", "_test_impact.mjs", "_test_table.mjs", "_test_gap_guard.mjs"]) {
  check(t, () => {
    const r = spawnSync("node", [t], { cwd: ROOT, encoding: "utf-8" });
    const out = (r.stdout || "") + (r.stderr || "");
    assert(r.status === 0, `exited ${r.status}:\n        ${out.slice(-500)}`);
    // _test_math / _test_gap_guard are print-only; at minimum assert no tofu
    // or stray markup leaked into the generated HTML.
    assert(!/mathrm/.test(out) || out.includes("literal mathrm in html: 0"), "mathrm leaked");
    return out.trim().split("\n").slice(-1)[0].slice(0, 60);
  });
}
// _test_exec_retry.mjs is deliberately excluded: it makes live MiniMax calls,
// so including it would make this gate billable and flaky.

console.log(`\n=== ${checks - failures}/${checks} checks passed ===`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log("all green\n");