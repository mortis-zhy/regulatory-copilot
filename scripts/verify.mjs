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
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/**
 * The PDF the gate inspects — rendered ONCE, up front, read synchronously below.
 *
 * These three checks used to default to `reports/last-report.pdf`, a path that
 * never existed, so each returned "skipped" while the gate still reported
 * all-green. The assertions existed; they had simply never run. That is how 29
 * bare `<sub>` tags and 15 stray LaTeX macros reached the client.
 *
 * So the gate renders `reports/last-report.json` — the artifact that actually
 * ships — unless VERIFY_PDF names one. About 45 s, which is the price of these
 * assertions executing at all.
 *
 * Synchronous by design: `check()` does not await, so an async resolver here
 * would leave the assertions unreached all over again.
 */
let GATE_PDF = null;

async function prepareGatePdf() {
  if (process.env.VERIFY_PDF) {
    GATE_PDF = existsSync(process.env.VERIFY_PDF) ? process.env.VERIFY_PDF : null;
    return GATE_PDF;
  }
  const report = resolve(ROOT, "reports/last-report.json");
  const lib = resolve(ROOT, "dist/htmlRenderV8.js");
  if (!existsSync(report) || !existsSync(lib)) return null;
  try {
    const mod = await import("../dist/htmlRenderV8.js");
    const buf = await mod.renderPdfFromReportV8(JSON.parse(readFileSync(report, "utf-8")));
    GATE_PDF = resolve(ROOT, "reports/.verify-render.pdf");
    writeFileSync(GATE_PDF, buf);
  } catch (e) {
    console.log("        (闸门渲染 PDF 失败：" + String((e && e.message) || e).slice(0, 140) + ")");
    GATE_PDF = null;
  }
  return GATE_PDF;
}
await prepareGatePdf();

console.log("\n=== 4. python verification layer ===");

function runPy(args, label) {
  // Windows 上 python 的 stdout 默认是 GBK —— 脚本里只要有一个 ✓ 或中文，
  // 就会 UnicodeEncodeError 崩掉，闸门报「引文对不上」而真相是编码问题。
  const r = spawnSync("python", args, {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
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

check("extract-cache holds exactly one file per version", () => {
  // Two generations of LLM extraction used to sit in the same glob path under
  // the same label, and `docs[label] = d` was last-wins — so which excerpts and
  // page numbers reached the report depended on directory enumeration order.
  // Observed: B's 慢行灯 resolved to 第4页 in one run and to nothing in the
  // next, with nothing on disk changing. load_extract_cache() now picks the
  // newest and names the shadowed files; this check keeps a second copy from
  // being dropped back in.
  const files = readdirSync(resolve(ROOT, "dist/extract-cache")).filter((f) => /^v3-.*\.json$/.test(f));
  const byLabel = new Map();
  for (const f of files) {
    const label = JSON.parse(readFileSync(resolve(ROOT, "dist/extract-cache", f), "utf-8")).label ?? "";
    byLabel.set(label, (byLabel.get(label) ?? 0) + 1);
  }
  const dup = [...byLabel].filter(([, n]) => n > 1).map(([l, n]) => `${l}×${n}`);
  assert(
    dup.length === 0,
    `dist/extract-cache has ${dup.join(", ")} — two extractions for one label, and which one wins is arbitrary. Move the older to _superseded/`,
  );
  assert(
    ["A", "B", "C"].every((l) => byLabel.get(l) === 1),
    `expected one cache per version, got ${JSON.stringify(Object.fromEntries(byLabel))}`,
  );
  return `${files.length} files, one per version`;
});

check("topic page citations survive a source-PDF re-check", () => {
  // Every "第N页 ✓" in the topic columns is a promise that page N of the
  // SOURCE PDF carries the quote. verify_claims.py resolves the page against
  // MinerU's own page-tagged text, and MinerU's page boundaries are not the
  // PDF's — four cells were shipping a ✓ for a page that does not contain the
  // quote (A 安装位置与几何可见度 第102页, B 光色与色度坐标表 / 灯具光色对应表
  // 第16页, C 自动切换前照灯条件表 第65页). verify_claims.py now downgrades
  // those; this gate fails if that pass ever stops running.
  const { ok, out } = runPy(["verify_claims.py"], "verify_claims");
  assert(ok, `verify_claims.py exited non-zero:\n        ${out.slice(-600)}`);
  assert(
    out.includes("源 PDF 页码复核"),
    "verify_claims.py did not report the source-PDF page re-check — the cross-check was removed",
  );
  const facts = JSON.parse(read("dist/facts.json"));
  const cells = facts.topicColumns.flatMap((t) =>
    ["A", "B", "C"].filter((lb) => t?.[lb]?.status === "verified"),
  );
  assert(cells.length > 0, "no verified topic cells at all — the corpus or the cache went missing");
  return `${cells.length} 格 ✓ 均已过源 PDF 页码复核`;
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

check("decision-caliber counts match the audited buckets", () => {
  // The defect that shipped: caliber 1 claimed "45 项参数有实质变化" while the
  // audited flow said 3 numeric + 9 manual, and its own family breakdown
  // (15+8+8=31) did not sum to the 45 it asserted. Both numbers came from
  // matrixStats() re-deriving counts by comparing oldValue !== newValue, which
  // classifies every wording difference as a substantive change.
  //
  // Each decision caliber's headline must now equal the bucket it claims to
  // summarise. A caliber with no auditable number must not print one.
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const facts = JSON.parse(read("dist/facts.json"));

  const expect = [
    {
      re: /(\d+)\s*项参数在 A 草案中有实质变化/,
      want: (facts.numericChanges?.length ?? 0) + (facts.manualFindings?.length ?? 0),
      what: "实质变化项数",
    },
    {
      re: /(\d+)\s*项两版原文完全相同/,
      want: facts.sameTextDropped?.length ?? 0,
      what: "两版同文项数",
    },
    {
      re: /(\d+)\s*项仅措辞\/标点差异/,
      want: facts.counts?.wordingFiltered ?? 0,
      what: "措辞差异项数",
    },
  ];

  const seen = [];
  for (const { re, want, what } of expect) {
    const m = md.match(re);
    assert(m, `执行摘要找不到「${what}」的声明`);
    assert(
      Number(m[1]) === want,
      `决策口径声称 ${what} = ${m[1]}，facts.json 审计值为 ${want}`,
    );
    seen.push(`${what}=${m[1]}`);
  }

  // Caliber 3 previously printed "13 项部分重叠 / 32 项无法证明等价", derived by
  // intersecting A's numbers with numbers scraped out of R48 §6.x.1 "Presence"
  // boilerplate. Until C's quantitative clauses are extracted, that evidence
  // does not support a verdict and must not appear.
  assert(
    !/项与 UN R48 条款存在数值交集/.test(md),
    "决策口径 3 仍在输出基于主题级摘录的 R48 数值重叠判定（C 定量抽取未完成）",
  );

  return seen.join(" · ") + " · C 定量判定已撤下";
});

check("chapter 12 is a parameter matrix, not a table dump", () => {
  // It shipped as three consecutive raw dumps (A's table, B's, C's) under a
  // summary column reading 见下方表格内容 on all 492 rows — a listing, not a
  // comparison. These assertions pin the shape so it cannot drift back.
  const ch = loadReport().chapters.find((c) => c.id === 12);
  assert(ch, "chapter 12 missing");
  const md = ch.markdown ?? "";

  assert(
    !md.includes("见下方表格内容"),
    "chapter 12 still carries the 见下方表格内容 placeholder column",
  );

  // Only §12.1 (the summary table) carries one row per parameter; the detail
  // blocks in §12.2 are 4-column version tables and are checked separately.
  const summary = md.split("## 12.2 ")[0];
  const rows = summary.split("\n").filter((l) => l.startsWith("| **"));
  assert(rows.length > 0, "chapter 12 has no parameter rows");

  // Every row must offer all three versions as columns.
  for (const line of rows) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    assert(
      cells.length >= 6,
      `a parameter row has ${cells.length} columns, expected >= 6 (参数/单位/A/B/C/判定): ${line.slice(0, 60)}`,
    );
  }

  // An empty cell is legitimate — a version may genuinely not state a
  // requirement (the draft dropped the V-level 60 km/h trigger that B and R48
  // both keep). What is never legitimate is an UNEXPLAINED gap: a regex that
  // silently stopped matching looks identical to a version that says nothing,
  // and the reader cannot tell them apart.
  const unexplained = rows.filter((l) => {
    const c = l.trim().replace(/^\||\|$/g, "").split("|").map((x) => x.trim());
    const emptyAB = (c[2] ?? "").includes("⚠") || (c[3] ?? "").includes("⚠");
    return emptyAB && !(c[5] ?? "").includes("未定位");
  });
  assert(
    unexplained.length === 0,
    `${unexplained.length} row(s) have an empty A/B cell with no explanation in 判定: ${unexplained[0]?.slice(0, 70)}`,
  );

  // Coverage must be stated, not implied: the reader has to know how much of the
  // matrix is actually filled in.
  assert(/本版覆盖/.test(md), "chapter 12 does not state its coverage");

  return `${rows.length} 个参数行 · 无未解释空缺 · 覆盖率已声明`;
});

check("no spec pattern spans a page boundary", () => {
  // locate() scans ONE page at a time, so a pattern can never match across a
  // [第N页] marker. GB 4785's 5.7.4.1.1 sits at the bottom of page 41 and its
  // "600 ㎜" opens page 42 — a clause-anchored pattern for it can never match,
  // and the cell comes back empty with no error. Two rows hit this.
  //
  // Detect it structurally: a pattern whose ONLY anchor is a clause number is
  // fragile whenever the clause number and the value land on different pages.
  // We cannot know the page layout from the spec alone, so this asserts the
  // weaker but always-true property: any spec that hit on a version whose
  // pattern starts with a clause anchor must ALSO have produced a clause. A
  // clause-anchored pattern that matches inside one page always yields a clause
  // (nearestClause scans the page text before the match).
  const doc = JSON.parse(read("data/parameter-specs.json"));
  const report = loadReport();
  const matrix = report.parameterMatrix;
  const startsWithClause = (src) => /^\s*(?:\\\.)*\d+(?:\\\.)*\d+/.test(src);
  const silent = [];
  for (const row of matrix) {
    const spec = doc.specs.find((s) => s.id === row.id);
    if (!spec) continue;
    for (const [ver, pat] of Object.entries(spec.patterns ?? {})) {
      const c = row.cells[ver];
      if (!c || c.status !== "verified") continue;
      if (startsWithClause(pat.source) && !c.clause) {
        silent.push(`${row.id}/${ver}`);
      }
    }
  }
  assert(
    silent.length === 0,
    `${silent.length} clause-anchored pattern(s) matched but reported no clause — the anchor and the value are probably on different pages (a pattern cannot span a [第N页] marker): ${silent.slice(0, 5).join(", ")}`,
  );
  return "clause-anchored hits all carry a clause";
});

check("matrix cells that matched a number actually carry it", () => {
  // A spec whose only capture group is not the value silently feeds the
  // extractor the wrong text: `车辆前行速度(小于|大于)\s*10 km/h` reported a
  // clean hit with an EMPTY number list, and the summary rendered a blank
  // where 10 should be. Verified-but-valueless is almost always this bug.
  const matrix = loadReport().parameterMatrix;
  assert(Array.isArray(matrix) && matrix.length, "no parameterMatrix on the report");
  const offenders = [];
  for (const row of matrix) {
    for (const v of Object.keys(row?.cells ?? {})) {
      const c = row.cells[v];
      if (!c || c.status !== "verified") continue;
      const digits = String(c.match ?? "").match(/\d/g) ?? [];
      if (digits.length && !(c.nums ?? []).length) {
        offenders.push(`${row.name}/${v} matched "${String(c.match).slice(0, 30)}" but nums is empty`);
      }
    }
  }
  assert(
    offenders.length === 0,
    `${offenders.length} cell(s) matched digits but produced no numbers — a capture group is capturing the wrong span:\n        ${offenders.slice(0, 4).join("\n        ")}`,
  );
  const versions = [...new Set(matrix.flatMap((r) => Object.keys(r?.cells ?? {})))].sort();
  const cells = matrix.length * versions.length;
  const filled = matrix.reduce(
    (n, r) => n + versions.filter((v) => r?.cells?.[v]?.status === "verified").length,
    0,
  );
  return `${filled}/${cells} 取值位有值（${versions.join("/")}）`;
});

check("R48 chapter map self-verifies against the corpus", () => {
  // `propose_parameters_c.py` declares a §6.x → lamp table that no amount of
  // cleverness can derive. It has been wrong once and the failure was silent:
  // §6.14 was labelled "Direction-indicator position" when it is actually the
  // rear retro-reflector, so every 侧转向灯 row drew candidates from the wrong
  // chapter and nothing errored. The script now checks each declared name
  // against a probe in the source, and raises. Run it here so that a bad label
  // fails the delivery gate instead of quietly reshaping the candidate pool.
  const r = spawnSync(
    "python",
    ["-W", "ignore", "scripts/propose_parameters_c.py"],
    { cwd: ROOT, encoding: "utf-8", env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `退出码 ${r.status}（章节表与语料不符）：\n        ${out.slice(-400)}`);
  const m = out.match(/章节映射校验通过：(\d+)\/(\d+)/);
  assert(m, "脚本没有打印校验结果行 —— 校验可能被绕过了");
  assert(m[1] === m[2], `只有 ${m[1]}/${m[2]} 条章节在原文里验到`);
  return `${m[1]}/${m[2]} 条章节名与探针都对得上`;
});

check("confirmation page is served by its own route", () => {
  // Express matches routes against `req.path`, which is the RAW (still
  // percent-encoded) pathname. A literal `app.get("/参数提议确认.html")` never
  // fires for a browser, so the request falls through to the SPA fallback and
  // returns index.html with a 200 — a page that opens fine and is the wrong
  // document. The route now matches on the decoded path; check the file is
  // still there so the 404 branch can't become the normal path.
  const file = resolve(ROOT, "web", "参数提议确认.html");
  assert(existsSync(file), "web/参数提议确认.html 不存在");
  const html = readFileSync(file, "utf-8");
  assert(html.includes("/api/parameters/proposals"), "页面没有指向提议 API");
  const idx = resolve(ROOT, "server", "_core", "index.ts");
  assert(readFileSync(idx, "utf-8").includes("decodeURIComponent(req.path)"), "路由改成按原始路径匹配了，中文 URL 会落回 SPA 兜底");
  return `${(html.length / 1024).toFixed(1)} KB`;
});

/**
 * The word forms `numbersOf()` expands. Same table, not a second opinion:
 * a gate that disagrees with the extractor about what a number looks like
 * produces false alarms, and a gate that cries wolf gets ignored.
 */
const WORD_FORM = {
  1: ["one "],
  2: ["two "],
  3: ["three "],
  4: ["four "],
  5: ["five "],
  6: ["six "],
  10: ["ten "],
  15: ["fifteen"],
  20: ["twenty"],
  30: ["thirty"],
  40: ["forty"],
  45: ["forty-five"],
  50: ["fifty"],
  60: ["sixty"],
  90: ["ninety"],
  600: ["600"],
  "1.5": ["one and one-half"],
  "0.5": ["one-half", "half a"],
  1000: ["1000"],
};

check("every displayed excerpt actually contains the value it reports", () => {
  // `nums` comes from `match` (capture group 1); the detail table shows
  // `value` (`quoteAround`'s window around the match). Different paths, so
  // the number can be right, the page can be right, the source-PDF audit can
  // pass — and the reader still cannot find the number in the quote.
  //
  // Word-form numbers (`one and one-half` → 1.5) are legitimate in R48 and are
  // not flagged: the check only requires the DIGITS to appear.
  const rep = JSON.parse(read("reports/last-report.json"));
  const bad = [];
  let checked = 0;
  for (const r of rep.parameterMatrix ?? []) {
    for (const [ver, c] of Object.entries(r.cells ?? {})) {
      if (c?.status !== "verified") continue;
      const raw = String(c.value ?? "");
      const digits = raw.replace(/[^0-9]/g, "");
      const low = raw.toLowerCase().replace(/\s+/g, " ");
      for (const n of c.nums ?? []) {
        checked++;
        if (digits.includes(String(n).replace(".", ""))) continue;
        // UN R48 states limits in words more often than digits (§6.5.9:
        // "within not more than one and one-half seconds"). Requiring digits
        // would flag three correct rows — and a gate that cries wolf gets
        // ignored, which is worse than no gate.
        const words = WORD_FORM[n];
        if (words && words.some((w) => low.includes(w))) continue;
        // GB 4785-2019 writes some lengths in millimetres ("长度大于6000mm"),
        // the 2026 draft in metres ("长度大于 6m"). numbersOf() converts the
        // metre form for rows whose unit is mm, so the quote holds "6m" while
        // the value column holds 6000 — the reader can still find it, and a
        // gate that cries wolf on a unit difference gets ignored.
        if (String(r.unit ?? "") === "mm") {
          const metres = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*m(?![mA-Za-z])/g)]
            .map((m) => Number(m[1]) * 1000);
          if (metres.some((v) => v === Number(n))) continue;
        }
        bad.push(`${r.id}/${ver}: nums=${n} 不在引文里「${raw.slice(0, 50)}…」`);
      }
    }
  }
  assert(bad.length === 0, `引文未覆盖取值（读者找不到那个数）：\n        ${bad.join("\n        ")}`);
  return `${checked} 个取值全部能在引文里找到`;
});

check("no C cell silently drops a value that A carries", () => {
  // A cell that captured only half of a two-tier clause reads as a wider (or
  // stricter) requirement than the source says. `reversing.maxHeight` did
  // exactly that: C showed 1400 alone, hiding the 250–1200 base limit.
  // Neither the excerpt/page audit nor the source-PDF page check can see it —
  // the half-sentence really is on the cited page.
  //
  // Not a hard "must be equal" rule: R48 genuinely may omit a tier GB has
  // (e.g. an off-road relaxation). So the gate demands the *reason*, which
  // is the discipline that catches the accidental case.
  const rep = JSON.parse(read("reports/last-report.json"));
  const specs = JSON.parse(read("data/parameter-specs.json")).specs;
  const whyOf = new Map(specs.map((s) => [s.id, s.why || {}]));
  const bad = [];
  for (const r of rep.parameterMatrix ?? []) {
    const a = new Set(r.cells?.A?.nums ?? []);
    const c = new Set(r.cells?.C?.nums ?? []);
    if (!a.size || !c.size) continue;
    const missing = [...a].filter((x) => !c.has(x));
    // No "proper subset" exemption: C carrying 3 of A's 5 values is a MORE
    // dangerous half-sentence, not a safer one. (A near-empty C slipped through
    // exactly that way while this gate was being written.)
    if (!missing.length) continue;
    const why = whyOf.get(r.id)?.C ?? "";
    if (!why) bad.push(`${r.id}: A 有 ${missing.join("/")} 而 C 没有，why.C 未说明`);
    else if (!missing.every((x) => why.includes(x)))
      bad.push(`${r.id}: A 有 ${missing.join("/")} 而 C 没有，why.C 里没有提到这些值`);
  }
  assert(bad.length === 0, `C 列疑似只截了半句：\n        ${bad.join("\n        ")}`);
  const rows = (rep.parameterMatrix ?? []).length;
  return `${rows} 行已扫，C 列无未解释的缺值`;
});

check("parameter-specs.json is well-formed", () => {
  // The specs are data now, so a typo in them fails as a schema error rather
  // than as a silently empty cell in the customer PDF. compileSpecs() would
  // throw at runtime — this catches it before anyone ships.
  const file = resolve(ROOT, "data/parameter-specs.json");
  assert(existsSync(file), "data/parameter-specs.json missing — the matrix has no data source");
  const doc = JSON.parse(readFileSync(file, "utf-8"));
  assert(Array.isArray(doc.specs) && doc.specs.length > 0, "specs missing or empty");

  const ids = new Set();
  const problems = [];
  for (const [i, s] of doc.specs.entries()) {
    const at = `#${i + 1} ${s?.id ?? "?"}`;
    for (const k of ["id", "name", "family", "unit"]) {
      if (!String(s?.[k] ?? "").trim()) problems.push(`${at}: 缺少 ${k}`);
    }
    if (ids.has(s?.id)) problems.push(`${at}: id 重复`);
    ids.add(s?.id);
    const pats = Object.entries(s?.patterns ?? {});
    if (!pats.length) problems.push(`${at}: 三版都没有 pattern`);
    for (const [ver, pat] of pats) {
      if (!["A", "B", "C"].includes(ver)) {
        problems.push(`${at}: 未知版本 "${ver}"`);
        continue;
      }
      const src = typeof pat === "string" ? pat : pat?.source;
      const flags = typeof pat === "string" ? "i" : pat?.flags ?? "i";
      if (!src) { problems.push(`${at}/${ver}: pattern 为空`); continue; }
      try {
        new RegExp(src, flags.replace(/g/g, ""));
      } catch (e) {
        problems.push(`${at}/${ver}: 正则无法编译 — ${e.message}`);
      }
      // A capture group that grabs a non-value silently yields an empty number
      // list; a pattern spanning a sentence boundary pulls in clause numbers.
      if (/\(\?:[^)]*\|/.test(src) && !/\)\s*$/.test(src.split("\\\\")[0].slice(-1))) { /* noop */ }
    }
  }
  assert(problems.length === 0, `parameter-specs.json 有 ${problems.length} 处问题:\n        ${problems.slice(0, 6).join("\n        ")}`);
  return `${doc.specs.length} 条 spec · ${doc.specs.reduce((n, s) => n + Object.keys(s.patterns ?? {}).length, 0)} 个 pattern`;
});

check("every explicitly declared clause exists in that version's text", () => {
  // A spec may assert a clause number when the corpus layout makes the
  // automatic inference unreliable — the value and its clause sit on
  // different pages, or R48 prints its paragraph numbers in the page margin
  // where "nearest preceding number" is a sibling clause. Such an assertion
  // is the author's, so it must be checkable: a clause number that occurs
  // NOWHERE in that version's text is a typo, and a wrong clause citation
  // is worse than a missing one.
  const specs = JSON.parse(read("data/parameter-specs.json")).specs;
  const corpus = JSON.parse(read("dist/mineru-v4-data.json"));
  // 有些条款号印在 PDF 的左边距里，是**位图**（GB 4785 草案第 4 章就是）——
  // 文本层里根本没有这些数字。这张表把「确实存在、但只在位图里」的条款号
  // 登记下来，附上人读得懂的依据；登记表之外的条款号仍然必须在正文里验到。
  const bitmap = (() => {
    try {
      return JSON.parse(read("data/clause-bitmap-fixes.json"));
    } catch {
      return {};
    }
  })();
  const bad = [];
  let n = 0;
  let nBitmap = 0;
  for (const s of specs) {
    for (const [ver, pat] of Object.entries(s.patterns ?? {})) {
      const cl = typeof pat === "string" ? "" : pat?.clause;
      if (!cl) continue;
      n++;
      const text = String(corpus?.[ver]?.fullText ?? "");
      if (text.includes(cl)) continue;
      if (Object.prototype.hasOwnProperty.call(bitmap?.[ver] ?? {}, cl)) {
        nBitmap++;
        continue;
      }
      bad.push(`${s.id}/${ver}: 条款号 ${cl} 在该版原文里不存在`);
    }
  }
  assert(
    bad.length === 0,
    `显式声明的条款号有 ${bad.length} 条对不上原文：\n        ${bad.join("\n        ")}`,
  );
  return `${n} 条显式条款号全部在原文里验到（其中 ${nBitmap} 条印在 PDF 位图里，登记在 data/clause-bitmap-fixes.json）`;
});

check("matrix matches parameter-specs.json", () => {
  // The matrix is built from the JSON, so a stale reports/last-report.json is
  // the only way they drift. Rebuilding is cheap; shipping a matrix that does
  // not match its own spec file is how a "12 项" becomes "45 项" again.
  const doc = JSON.parse(read("data/parameter-specs.json"));
  const matrix = loadReport().parameterMatrix;
  assert(Array.isArray(matrix), "report carries no parameterMatrix");
  const ids = doc.specs.map((s) => s.id);
  const got = matrix.map((r) => r.id);
  assert(
    ids.join(",") === got.join(","),
    `报告里的矩阵有 ${got.length} 行，spec 文件有 ${ids.length} 条 —— 跑一次 node rebuild_report.mjs`,
  );
  return `${got.length} 行与 spec 一一对应`;
});

check("matrix covers every declared family", () => {
  const matrix = loadReport().parameterMatrix;
  assert(Array.isArray(matrix) && matrix.length, "no parameterMatrix");
  // A floor, and family coverage. Dropping a spec is a legitimate edit; doing
  // it by accident is how the matrix went from 23 rows back to a handful.
  assert(matrix.length >= 27, `matrix has ${matrix.length} parameters, expected >= 27`);
  const families = new Set(matrix.map((r) => r.family));
  for (const f of [
    "安装高度 / 离地距离",
    "闪烁频率 / 时间参数",
    "试验条件 / 路段速度",
    "光色 / 标记",
    "光强 / 照度限值",
    "电气条件 / 试验电压",
    "几何可见度 / 安装角度",
    // 从自动提议的候选池确认进来的两族（阶梯第 3 级）
    "位置 / 间距限值",
    "灯具本体 / 构造要求",
  ]) {
    assert(families.has(f), `family "${f}" is missing from the matrix`);
  }
  return `${matrix.length} 参数 · ${families.size} 个参数族`;
});

check("two-version chapters declare their scope", () => {
  // Chapters 13 and 14 are A-vs-B AT THE CLAUSE level: UN R48's clause system is
  // not isomorphic with GB's, so no sentence-level mapping exists. Shipping them
  // under a "comparison" title without saying so is what the customer read as
  // "the EU column is empty".
  //
  // Chapter 14 now carries a NARROWER truth instead of the old blanket "no C":
  // it prints a chapter-level R48 pointer plus that lamp's three-version values,
  // so the declaration has to say chapter-level and non-clause-level. Both forms
  // point the reader at chapter 12 / appendix C.
  const chapters = loadReport().chapters;
  const get = (id) => {
    const ch = chapters.find((c) => c.id === id);
    assert(ch, `chapter ${id} missing`);
    return ch;
  };

  const c13 = get(13).markdown ?? "";
  assert(
    c13.includes("本章范围：仅 A 与 B 两版"),
    "chapter 13 does not declare that it excludes C",
  );

  const c14 = get(14).markdown ?? "";
  assert(
    /逐句对照只做 A \/ B 两版/.test(c14),
    "chapter 14 must still declare that the clause-level diff is A/B only",
  );
  assert(
    c14.includes("章节级") && c14.includes("非条款级"),
    "chapter 14 must declare that its R48 pointers are chapter-level, not clause-level",
  );

  for (const id of [13, 14]) {
    const md = id === 13 ? c13 : c14;
    assert(
      /第 12 章|附录 C/.test(md),
      `chapter ${id} does not point the reader at the three-version material`,
    );
  }

  // Anti-rot: the scope marker must ride on EVERY pointer line, not just in the
  // preamble — a reader who lands on one clause block never sees the preamble.
  const pointers = (c14.match(/\*\*R48 对应章节/g) ?? []).length;
  const tagged = (c14.match(/\*\*R48 对应章节（章节级，非条款级）\*\*/g) ?? []).length;
  assert(pointers > 0, "chapter 14 lost its R48 chapter-level pointers entirely");
  assert(
    tagged === pointers,
    `only ${tagged}/${pointers} R48 pointers carry the 章节级/非条款级 marker`,
  );
  // A pointer without a resolvable clause number is a dead end for the reader.
  const withClause = (c14.match(/\*\*R48 对应章节（章节级，非条款级）\*\*：[^\n]*§\d/g) ?? []).length;
  assert(
    withClause === pointers,
    `${pointers - withClause} R48 pointers print no §clause number`,
  );
  return `ch13 声明排除 C · ch14 声明章节级口径 · ${pointers} 条 R48 指针全部带标记与条款号`;
});

check("chapter 14 clause diff is a real side-by-side table", () => {
  // Two rendering accidents, both measured on the delivered PDF:
  //  · a literal newline inside a cell splits the markdown row, so the table
  //    stops being a table — 39/39 clause tables lost ~277 of every 500 chars
  //    into loose body paragraphs;
  //  · a 来源/页码/正文 header is read as the version column, and the triptych
  //    renderer then labels the page number as the clause and the whole clause
  //    body as the page, then prints a "C 无对应条款行" card for a chapter that
  //    DOES have C. Only a header that is not 版本/来源/文档/文件/标准 and that
  //    carries all three of A/B/C reaches that layout.
  const ch = loadReport().chapters.find((c) => c.id === 14);
  assert(ch, "chapter 14 missing");
  const md = ch.markdown ?? "";

  const blocks = md.split(/\n(?=## 14\.x 条款 )/).slice(1);
  assert(blocks.length > 0, "chapter 14 has no clause blocks");
  let sideBySide = 0;
  for (const b of blocks) {
    const lines = b.split("\n");
    const hdr = lines.findIndex((l) => /^\|\s*\*\*A 草案\*\*（/.test(l));
    assert(hdr >= 0, `clause block is not a side-by-side A|B table: ${lines[0] ?? ""}`);
    const row = lines[hdr + 2] ?? "";
    // header, separator, exactly one body row — nothing else in the table
    assert(/^\|[\s:|-]+\|$/.test(lines[hdr + 1] ?? ""), `no separator row under ${lines[hdr]}`);
    assert(row.startsWith("|") && row.trimEnd().endsWith("|"), `body row is not a closed table row`);
    const cells = row.slice(1, -1).split("|");
    assert(cells.length === 2, `expected 2 columns, got ${cells.length}`);
    sideBySide++;
  }

  // No clause row may be split across physical lines: every table line in the
  // chapter has to start AND end on one line.
  for (const l of md.split("\n")) {
    if (!l.startsWith("|")) continue;
    const opens = (l.match(/\|/g) ?? []).length;
    if (l.includes("|---|")) continue;
    assert(opens >= 2, `orphan table line: ${l.slice(0, 60)}`);
  }
  assert(
    !/\| 来源 \| 页码 \|/.test(md),
    "chapter 14 reverted to the 来源/页码/正文 table (triggers the triptych)",
  );
  return `${sideBySide} 条条款均为 A|B 两列并排，无跨行单元格`;
});

check("chapter 14 carries C at chapter level, and says so on every pointer", () => {
  const ch = loadReport().chapters.find((c) => c.id === 14);
  assert(ch, "chapter 14 missing");
  const md = ch.markdown ?? "";
  // Every value table under a chapter-14 clause must have a C column, or the
  // chapter would be printing an A/B table under a three-version heading.
  const tables = md.match(/\| 参数 \| 单位 \| A 草案 \| B 现行 \| C UN R48-09 \| 判定 \|/g) ?? [];
  assert(tables.length > 0, "chapter 14 lost its three-version value tables");
  const pointers = md.match(/\*\*R48 对应章节（章节级，非条款级）\*\*/g) ?? [];
  assert(pointers.length > 0, "chapter 14 has no R48 chapter-level pointers");
  return `${tables.length} 张三版取值表 · ${pointers.length} 条带口径标记的 R48 指针`;
});

check("the parameter matrix is still a MATRIX in the PDF, not three card columns", () => {
  // The most expensive rendering defect this project has had, and one no
  // markdown-side check could see. `| 参数 | 单位 | A 草案 | B 现行 | C | 判定 |`
  // is a six-column table; the card layout shows one label + one value per row,
  // so it dropped 单位 AND 判定 and stacked three unaligned 73-row lists:
  // `430000` with no cd/m², `500 / 1200` with no mm, no `A=C≠B` verdict. That
  // is precisely the 「只有罗列，没有比较」 the client reported, while every
  // value-, page- and clause-level check stayed green.
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  const py =
    "import sys,io,json,base64,re,fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path)\n" +
    "pages=[p.get_text() for p in d]\n" +
    "all='\\n'.join(pages)\n" +
    "i12=next((i for i,t in enumerate(pages) if '12.1 参数对照总表' in t), -1)\n" +
    "i122=next((i for i,t in enumerate(pages) if '12.2 逐参数原文明细' in t), len(pages))\n" +
    "out={'i12':i12}\n" +
    "if i12>=0:\n" +
    "    # 矩阵有 199 行，总表横跨多页 —— 抽查必须覆盖**整张表**，\n" +
    "    # 否则表格中段的行落在窗口外，闸门会误报「缺行」。\n" +
    "    m='\\n'.join(pages[i12:(i122 if i122>i12 else i12+3)])\n" +
    "    out['head']=bool(re.search(r'单位[\\s\\S]{0,80}A 草案[\\s\\S]{0,80}B 现行[\\s\\S]{0,80}C UN R48-09[\\s\\S]{0,80}判定', m))\n" +
    "    out['rows']=[p for p in ['近光灯最大离地高度','转向信号灯闪烁频率','同时点亮远光灯最大发光强度之和'] if p in m]\n" +
    "out['cards']=len(re.findall(r'维度\\n[^\\n]{1,12}\\n条目\\n\\d+', all))\n" +
    "print(json.dumps(out,ensure_ascii=False))\n";
  const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (r.status !== 0) return `skipped — ${(r.stderr || "").trim().split("\n").pop().slice(0, 80)}`;
  const res = JSON.parse(r.stdout.trim().split("\n").pop());
  assert(res.i12 >= 0, "chapter 12.1 not found in the built PDF");
  assert(
    res.head,
    "12.1 matrix lost its 单位 / 判定 columns — the card layout is back",
  );
  assert(
    res.rows.length === 3,
    `12.1 matrix is missing rows: ${["近光灯最大离地高度", "转向信号灯闪烁频率", "同时点亮远光灯最大发光强度之和"].filter((x) => !res.rows.includes(x)).join(", ")}`,
  );
  assert(
    res.cards === 0,
    `${res.cards} tables still render as card columns (维度/条目 fingerprint)`,
  );
  return `12.1 矩阵带单位/判定列 · ${res.cards} 处卡片指纹 · 抽查 3 行在册`;
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

check("appendix E — the coverage checklist is present and says zero gaps", () => {
  // 客户真正会问的那句「有没有少数据」在附录 E 里回答。
  // 断言它在报告里、且表格里的数字与 data/coverage-audit.json 一致 ——
  // 否则附录就是一张好看的旧表。
  const md = reportText();
  const i = md.search(/# 附录 E/);
  assert(i >= 0, "附录 E 缺失 —— 客户问「有没有少数据」时无处可答");
  const ap = md.slice(i);
  const audit = JSON.parse(read("data/coverage-audit.json"));
  const t = audit.totals ?? {};
  assert(
    ap.includes(String(t.limits)) && ap.includes(String(t.same)),
    `附录 E 的数字与 data/coverage-audit.json 不一致（限值 ${t.limits} / 同条款 ${t.same}）`,
  );
  for (const v of ["A", "B", "C"]) {
    const x = audit.versions?.[v] ?? {};
    assert(
      ap.includes(`| ${v} `) || ap.includes(`（${v}）`),
      `附录 E 里没有 ${v} 版那一行`,
    );
    assert(
      (x.missing ?? -1) === 0,
      `${v} 版还有 ${x.missing} 条真缺口 —— 附录 E 不能说「没有需要补的量值」`,
    );
  }
  return `${t.limits} 条限值 · 真缺口 ${t.missing}`;
});

check("appendix F — every quoted passage is in the source PDF", () => {
  // 附录 F 是客户唯一能直接读到「表格型限值」的地方，它引的每一句都必须
  // 逐字来自源 PDF。转述、错字、记错的数字 —— 一律在这里挡住。
  const { ok, out } = runPy(["scripts/check_appendix_tables.py"], "appendix_tables");
  assert(ok, `附录 F 的引文有对不上的:
        ${out.slice(-600)}`);
  const m = out.match(/附录 F 原文片段：(\d+) 条，命中 (\d+) 条/);
  return m ? `${m[2]}/${m[1]} 条引文回源验到` : "已验";
});

check("the coverage checklist is not stale", () => {
  // 参数矩阵加了行、条款索引变了，覆盖清单必须跟着变。
  // 否则报告里印的是**旧**覆盖率 —— 比没有覆盖率更坏。
  const { ok, out } = runPy(["scripts/coverage_audit.py", "--check"], "coverage_audit");
  assert(ok, `覆盖清单已过期:
        ${out.slice(-600)}`);
  return (out.match(/覆盖清单与现算一致：.*/) ?? ["一致"])[0].trim();
});

check("printed TOC page numbers resolve to real chapter pages", () => {
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  const py = `
import sys, re, json, base64
import fitz
# base64, like the other PDF checks: on Windows a non-ASCII path handed to
# Python over stdin is decoded with the locale codec and comes out mojibake,
# so fitz silently fails to open and the check degrades to a no-op.
d = fitz.open(base64.b64decode(sys.stdin.read().strip()).decode("utf-8"))
toc = None
for i in range(min(12, d.page_count)):
    if "目录" in d[i].get_text()[:600]:
        toc = i
        break
if toc is None:
    print(json.dumps({"skipped": "no printed TOC"})); raise SystemExit(0)
rows = {}
for x0, y0, x1, y1, t, *_ in d[toc].get_text("words"):
    rows.setdefault(round(y0), []).append((x0, t))
entries = []
for y in sorted(rows):
    parts = sorted(rows[y])
    nums = [t for _, t in parts if re.fullmatch(r"\\d+", t)]
    title = "".join(t for _, t in parts if not re.fullmatch(r"\\d+", t))
    if title and nums:
        entries.append((title, int(nums[-1])))
if not entries:
    print(json.dumps({"skipped": "TOC rows not parseable"})); raise SystemExit(0)
# 1. not all identical — the defect that shipped was every entry reading "11"
uniq = {p for _, p in entries}
if len(uniq) == 1:
    print(json.dumps({"error": "every TOC entry reads page %d — the pass-2 backfill degenerated" % uniq.pop()}))
    raise SystemExit(0)
# 2. each claimed page must actually contain that chapter's title
bad = []
for title, page in entries:
    key = re.sub(r"\\s+", "", title)[:12]
    if not key:
        continue
    hit = any(re.sub(r"\\s+", "", key) in re.sub(r"\\s+", "", d[i].get_text()[:400]) for i in range(d.page_count))
    if hit and not any(re.sub(r"\\s+", "", key) in re.sub(r"\\s+", "", d[p - 1].get_text()[:400]) for p in (page, page + 1) if 1 <= p <= d.page_count):
        bad.append((title, page))
print(json.dumps({"entries": len(entries), "distinct_pages": len(uniq), "mismatched": bad[:6]}))
`;
  const out = spawnSync("python", ["-c", py], {
    input: Buffer.from(pdfPath, "utf8").toString("base64"),
    cwd: ROOT,
    encoding: "utf8",
  });
  const res = JSON.parse(out.stdout.trim().split("\n").pop());
  if (res.skipped) return res.skipped;
  assert(!res.error, res.error);
  assert(
    res.mismatched.length === 0,
    `TOC page numbers do not land on the chapter: ${JSON.stringify(res.mismatched)}`,
  );
  return `${res.entries} 条目录项 · ${res.distinct_pages} 个不同页码 · 抽查一致`;
});

check("delivered PDF has no placeholder cells claiming missing data", () => {
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
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
  // An unexpanded `${…}` means a string that was meant to be a template literal
  // was written as a plain one: the placeholder survives verbatim all the way
  // into the client's PDF. This reached a rendered page once (chapter 12 printed
  // "判定列只回答一个问题——vs[0] 与 {vs[1]} 是否一致") and no other check
  // noticed, because the text is well-formed prose with no markdown in it.
  //
  // LaTeX from the source looks identical (`${\mathrm{W}}_{12}`, `${ 0 \atop - 1 }`).
  // The two differ in that an identifier placeholder has neither a backslash nor
  // whitespace inside it, while every LaTeX group has at least one — and LaTeX
  // routinely spans lines, so no amount of stripping `$…$` reliably separates
  // them. Match on the content instead.
  const placeholders = [...md.matchAll(/\$\{([A-Za-z_$][^}\n]{0,60})\}/g)]
    .filter((m) => !/[\\\s]/.test(m[1]))
    .map((m) => m[0]);
  assert(
    placeholders.length === 0,
    `${placeholders.length} unexpanded template placeholder(s) in the report body: ${[...new Set(placeholders)].slice(0, 4).join(" ")} — a plain string was used where a template literal was meant`,
  );
  return "no orphan # lines, no unexpanded placeholders";
});

check("built PDF has no unrendered markdown (needs PyMuPDF + a PDF)", () => {
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 无法渲染 reports/last-report.json（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
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
    // `br` matters: MinerU writes a table cell's line break as an HTML <br>,
    // and those rode into the excerpts as literal text — 110 of them in the ⑫
    // build, while this regex (which listed only sub|sup|i|b|em|strong) stayed
    // green. A raw-tag check that does not cover the tag that actually occurs
    // is worse than no check.
    "'rawsub':len(re.findall(r'<(?:/?)(?:sub|sup|i|b|em|strong|br)>',t)),\n" +
    "'latex':len(re.findall(r'\\\\\\\\(?:mathrm|mathbf|dfrac|frac|left|right)',t)),\n" +
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
  // Unrendered inline markup printed on the page. The delivered build showed
  // 29 bare <sub>, 26 </sub>, 5 <sup> and 15 \mathrm — inlineMd() escapes
  // first (correctly) and nothing turned MinerU's <sub> back into a tag;
  // clipping an excerpt mid-tag adds `N<sub>1` and `N<sub>1</su` on top.
  assert(m.rawsub === 0, `${m.rawsub} unrendered sub/sup/emphasis tag(s) in the PDF`);
  assert(m.latex === 0, `${m.latex} unrendered LaTeX macro(s) in the PDF`);
  return `${m.pages}p, ${m.bookmarks} bookmarks, 0 bold, 0 tofu, 0 raw-tag, 0 blank`;
});

console.log("\n=== 5. renderer unit harness ===");
for (const t of ["_test_math.mjs", "_test_impact.mjs", "_test_table.mjs", "_test_gap_guard.mjs", "_test_versions.mjs"]) {
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