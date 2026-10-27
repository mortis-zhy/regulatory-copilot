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
// The closure ledger is the single authority for "how many changes does this
// report claim". Import it from the built dist so the gate compares the PDF
// against the SAME code path the renderer used (never a re-implementation).
import { extractAuthoritativeChanges, buildLedger } from "../dist/closureLedger.js";

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

console.log("\n=== 3b. agent 取证循环的不变量 ===");

check("agent 循环一定会以回答收尾（收口轮撤掉工具）", () => {
  const src = read("server/reports/agentLoop.ts");
  // 收口轮：**不传 tools**（不是 tool_choice:"none"）——
  // MiniMax 对 tool_choice:"none" 的处理是把工具调用写成正文里的文本标记，
  // 用户看到的是一堆 XML 而不是答案。撤掉 tools 才是真的不给它调用的机会。
  assert(
    /callWithTools\(convo,\s*\[\]/.test(src),
    "agentLoop.ts 必须有一轮「不传工具」的收口调用 —— " +
      "否则模型可能一轮轮查下去、把轮数耗光却一句话不说",
  );
  assert(
    /maxTokens:\s*16384/.test(src),
    "收口轮的 token 上限要放大 —— MiniMax-M3 先输出一大段思维链，" +
      "上限不够会把答案截断，而「答案被截断」看起来和「查不到」一模一样",
  );
  assert(
    /parseNativeToolCalls/.test(src) && /stripToolMarkup/.test(src),
    "必须处理 MiniMax 把工具调用写进正文的那种形态，否则这一轮白跑",
  );
  return "收口轮撤掉工具 + 解析正文里的工具调用";
});

check("连续查不到时强制收口（注入「如实说未找到」指令）", () => {
  const src = read("server/reports/agentLoop.ts");
  assert(
    /failRounds\s*>=\s*2/.test(src),
    "agentLoop.ts 必须在连续整轮失败后收口",
  );
  assert(
    /未找到/.test(src) && /编造页码/.test(src),
    "收口指令必须明确要求「如实说未找到」且「不得编造页码」",
  );
  return "failRounds>=2 → 收口";
});

check("find_quote 带关键词回源（不命中时能一步确认「原文里没有」）", () => {
  const src = read("server/reports/agentTools.ts");
  assert(
    /keywordsOf/.test(src) && /keywords/.test(src),
    "agentTools.ts 的 find_quote 必须做关键词级回源 —— " +
      "否则 agent 只能反复改写引文碰运气，把取证轮数耗光还没结论",
  );
  return "find_quote 关键词回源";
});

check("agent 的 messages 数组里不能有裸字符串", () => {
  // MiniMax 的 OpenAI 兼容层对 messages 的元素类型要求很严：
  // 塞一个裸字符串进去，它会回 400（"Mismatch type custom.OaiMessage with value string"），
  // 而这个 400 只在**下一轮**才出现 —— 表现为「agent 突然不说话了」，
  // 排查起来极难想到是上一轮 push 坏了。
  const src = read("server/reports/agentLoop.ts");
  const pushes = [...src.matchAll(/convo\.push\(\s*([^\n]{0,60})/g)].map((m) => m[1].trim());
  assert(pushes.length >= 3, `预期至少 3 处 convo.push，实际 ${pushes.length}`);
  const bare = pushes.filter((p) => !p.startsWith("{"));
  assert(
    bare.length === 0,
    `convo.push 里有裸值（必须是 {role, content} 对象）：${bare.join(" | ")}`,
  );
  return `${pushes.length} 处 push，全是消息对象`;
});

check("agent 工具全部只读（没有写盘/删文件的入口）", () => {
  const src = read("server/reports/agentTools.ts");
  const names = [...src.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  assert(names.length >= 7, `期望至少 7 个工具，实际 ${names.length}`);
  for (const bad of ["write_file", "delete_file", "run_command", "exec", "shell"]) {
    assert(!names.includes(bad), `agent 工具里出现了写操作：${bad}`);
  }
  assert(!/fs\.(writeFile|unlink|rm|rename)/.test(src), "agentTools.ts 不许写盘");
  return `${names.length} 个工具，全部只读`;
});

check("条款索引与 python 现算一致（agent 的条款证据不会脱节）", () => {
  const r = spawnSync("python", ["scripts/export_clause_index.py", "--check"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `条款索引已过期：\n        ${out.slice(-300)}`);
  return out.trim().split("\n").slice(-1)[0].slice(0, 70);
});

console.log("\n=== 4. python verification layer ===");
check("GB4785 表 11.6 的 9 条指标回源核验（直接读源 PDF，绕开 MinerU）", () => {
  const r = spawnSync("python", ["scripts/verify_indicators.py"], { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `9 条指标回源核验失败：\n        ${out.slice(-600)}`);
  return out.trim().split("\n")[0].slice(0, 60);
});

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
  // 差值候选的**裁定后**分布（11.3.3 逐行判定的那一份）。
  // 第 2 条决策口径以前用的是**抽取流量**分桶（sameText 9 / wording 30），
  // 那些桶回答的是「抽取时看着像不像差异」，不是「有没有工程含义」——
  // 牌照灯数量、醒目标志光色、DRL×A2 互斥三行都落在措辞桶里，
  // 回原文核过却是真变化。按流量桶下结论，就会把三条真变化说成「无工程含义」。
  const vd = facts.diffVerdicts ?? {};
  const vc = (k) =>
    Object.values(vd).filter((v) => (v?.verdict ?? "") === k).length;

  // 第 1 条决策口径报的是**统一清单**（§11.0 变化总清单）的条数 ——
  // 四套来源（数值级 / 人工补录 / 差值裁定 / 参数矩阵）合并去重后只有**一个**
  // 数。以前这里报的是「数值级 + 人工补录」两个来源的和（14），与清单的
  // 17 对不上 —— 读者无从知道差的那几条从哪来。
  const ch11 = loadReport().chapters.find((c) => c.id === 11);
  const md11 = ch11?.markdown ?? "";
  const i110 = md11.indexOf("## 11.0");
  assert(i110 > 0, "第 11 章里没有 §11.0 变化总清单");
  const j111 = md11.indexOf("### 11.1", i110);
  const ledgerRows = md11
    .slice(i110, j111 > 0 ? j111 : undefined)
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| # ") && !l.startsWith("|---")).length;

  const expect = [
    {
      re: /\*\*(\d+)\s*条\*\*实质变化/,
      want: ledgerRows,
      what: "实质变化项数",
    },
    {
      re: /(\d+)\s*项为实质变化/,
      want: vc("有变化"),
      what: "差值候选中的实质变化项数",
    },
    {
      re: /两版原文完全相同\s*(\d+)\s*项/,
      want: vc("两版同文（已回原文核验）") + vc("两版同文（勘误）"),
      what: "两版同文项数",
    },
    {
      re: /数值与限值口径相同\s*(\d+)\s*项/,
      want: vc("数值与口径相同（非数值变化）"),
      what: "数值口径相同项数",
    },
    {
      re: /(\d+)\s*项仍待人工裁定/,
      want: vc("表述差异（未做数值核验）"),
      what: "仍待裁定项数",
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

  // 抽取流量口径的那一句也必须对得上，并且**账目闭环**。
  // （两个口径都在摘要里出现：一个是抽取分桶，一个是裁定结果 —— 读者要能对上账。）
  const flow = md.match(
    /抽取流量口径\*\*（尚未逐条裁定）：(\d+) 条入 11\.3、(\d+) 条引用编号变化单列 11\.3\.2、\*\*(\d+) 条同文勘误[^）]*）、(\d+) 条表述差异 \+ (\d+) 条非变化项过滤/,
  );
  assert(flow, "执行摘要找不到「抽取流量口径」的候选去向声明");
  const c = facts.counts ?? {};
  const flowWant = [
    [Number(flow[1]), c.numeric, "数值变化"],
    [Number(flow[2]), c.renumbered, "引用编号变化"],
    [Number(flow[3]), c.sameText ?? c.sameTextDropped, "同文勘误"],
    [Number(flow[4]), c.wordingFiltered, "表述差异"],
    [Number(flow[5]), c.ruleDropped, "非变化项过滤"],
  ];
  for (const [got, want, what] of flowWant) {
    assert(
      got === want,
      `执行摘要的抽取流量口径声称 ${what} = ${got}，facts.json 审计值为 ${want}`,
    );
  }
  const flowSum = flowWant.reduce((a, [g]) => a + g, 0);
  assert(
    flowSum === (c.candidates ?? 0),
    `抽取流量口径五项相加 ${flowSum} ≠ 候选 ${c.candidates} —— 账目不闭环`,
  );

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

check("11.4 的 9 条指标判定与回源核验一致（报告不得与已核实事实脱节）", () => {
  const ch = loadReport().chapters.find((c) => c.id === 11);
  const md = ch?.markdown ?? "";
  const i = md.indexOf("### 11.4");
  const j = md.indexOf("### 11.5", i);
  const sec = md.slice(i, j > 0 ? j : undefined);
  assert(sec.length > 0, "第 11 章里没有 11.4 节");
  // 4 条在原文找到：ESS 频率 / DRL 可见度角度 / 侧标志灯间距（两版相同）+ DRL 减光 140cd（单边）
  assert(
    /9 条中 4 条在原文找到/.test(sec),
    "11.4 的核验结论应为「9 条中 4 条在原文找到」—— 实际：" +
      (sec.match(/9 条中 \d+ 条在原文找到/)?.[0] ?? "（没找到这句）"),
  );
  // DRL 可见度角度：两版都是 20°，**不是** [未找到]
  const visRow = sec.split("\n").find((l) => l.includes("DRL 可见度角度") && l.includes("|"));
  assert(!!visRow, "11.4 表里没有 DRL 可见度角度这一行");
  assert(
    /\[保留\]/.test(visRow) && /20/.test(visRow),
    `DRL 可见度角度应为 [保留] 两版相同 20°，实际行：${visRow.slice(0, 120)}`,
  );
  // 每个 [未找到] 都要附「查过哪里」的依据 —— 否则分不清「没有」和「没查对」
  const missing = sec.split("\n").filter((l) => l.includes("[未找到]") && l.startsWith("|"));
  assert(missing.length === 5, `应有 5 条 [未找到]，实际 ${missing.length}`);
  assert(
    /逐条查证依据/.test(sec),
    "11.4 缺「逐条查证依据」—— 没有它，「未找到」分不清是没查对还是确实没有",
  );
  return `4 找到 / 5 未找到（均附查证依据）`;
});

check("附录 D 的条款号都能在源 PDF 里查到（客户拿着这个号翻得到）", () => {
  const idx = JSON.parse(read("data/clause-index.json"));
  const known = new Set(Object.keys(idx._clauses?.C ?? {}));
  const app = loadReport().appendices?.find((a) =>
    (a.title ?? "").includes("R48 §6 量化条款全量清单"),
  );
  assert(!!app, "报告里没有附录 D（R48 §6 量化条款全量清单）");
  const md = app.markdown ?? "";
  const i = md.indexOf("## D.3");
  assert(i > 0, "附录 D 里没有 D.3 全量清单");
  const rows = md
    .slice(i)
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| R48 条款") && !l.startsWith("|---"));
  assert(rows.length > 100, `D.3 只有 ${rows.length} 行，清单疑似空了`);
  const bad = [];
  for (const r of rows) {
    const cells = r.split("|").map((c) => c.trim());
    const clause = cells[1] ?? "";
    if (!clause || clause === "—") continue;
    if (!known.has(clause.replace(/[.。\s]+$/, ""))) bad.push(clause);
    // 条款号不是 §6 的行不许被标成「已入矩阵」——
    // 旧实现里 `chapterOf("13")` 与「没有 C 列条款号」的矩阵行两边都是 "",
    // 于是脚注行被误判成 ✅（还挂到了完全不相干的参数上）。
    if (!/^6\./.test(clause) && (cells[6] ?? "").includes("✅")) {
      bad.push(`${clause}（被误标为已入矩阵）`);
    }
  }
  assert(
    bad.length === 0,
    `附录 D 有 ${bad.length} 行条款号在源 PDF 里查不到：${[...new Set(bad)].join(", ")}`,
  );
  return `${rows.length} 行条款号全部可在源 PDF 查到`;
});

check("矩阵里每一个空格子都归了类，且没有「不知道」的格子", () => {
  // 客户抱怨「数值有提取错误或空缺」—— 查下来是**呈现**问题：
  // 144 个空格全部是「已核过该版确实无此规定」（absent 声明 + 依据），
  // 但 12.1 总表曾把它们一律渲染成「未命中」，读起来像「抽取失败」。
  // 这道闸门锁住两件事：
  //   ① 每个空格都必须有明确归类（not-specified / no-pattern / no-match）
  //   ② 「未建规则」「未命中」这类**取数失败**必须是 0 —— 有的话就是真 bug
  const rows = loadReport().parameterMatrix ?? [];
  assert(rows.length > 100, `矩阵只有 ${rows.length} 行`);
  const counts = { "not-specified": 0, "no-pattern": 0, "no-match": 0, unclassified: 0 };
  for (const r of rows) {
    for (const v of Object.keys(r.cells ?? {})) {
      const c = r.cells[v];
      if (c?.status === "verified") continue;
      const k = c?.miss ?? "unclassified";
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  assert(
    counts.unclassified === 0,
    `有 ${counts.unclassified} 个空格没有归类（miss 字段缺失）—— 读者无从判断是「确实没有」还是「没抽到」`,
  );
  assert(
    counts["no-pattern"] === 0 && counts["no-match"] === 0,
    `有 ${counts["no-pattern"] + counts["no-match"]} 个格子是**取数失败**（未建规则/规则未命中）` +
      `—— 这不是「该版无此规定」，是本报告的缺口，必须修`,
  );
  // 呈现层：总表里不能把「已核过」显示成「未命中」
  const ch = loadReport().chapters.find((c) => c.id === 12);
  const md = ch?.markdown ?? "";
  assert(
    !/\| 未命中 \|/.test(md),
    "12.1 总表里出现了「未命中」—— 已核过「该版无此规定」的格子不得显示成取数失败",
  );
  assert(
    /无此规定（已核）/.test(md),
    "12.1 总表里没有「无此规定（已核）」标记",
  );
  assert(
    /12\.3 缺一版取值的参数/.test(md) && !/12\.3 定位失败的参数/.test(md),
    "12.3 的标题还是「定位失败的参数」—— 那些格子全部是「已核过确实没有」，不是定位失败",
  );
  return `${counts["not-specified"]} 格已核无规定 / 取数失败 0 格`;
});

check("报告各处报的变化条数一致（只有一份权威清单）", () => {
  // 客户说「这版和之前差别不大」—— 很大一部分是**对不上账**：
  // 执行摘要说 14、§11.3.3 说 6、第 12 章矩阵 changed 是 9、§11.3.1 是 11。
  // 四个数都不是错的，但读者无从知道它们的关系。
  // 现在 §11.0 是唯一一份权威清单，执行摘要只报它的条数。
  const rep = loadReport();
  const ch11 = rep.chapters.find((c) => c.id === 11);
  const md = ch11?.markdown ?? "";
  const i = md.indexOf("## 11.0");
  assert(i > 0, "第 11 章里没有 §11.0 变化总清单");
  const sec = md.slice(i, md.indexOf("### 11.1", i) > 0 ? md.indexOf("### 11.1", i) : undefined);

  // 表里的行数（表格行，排除表头与分隔行）
  const rows = sec
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| # ") && !l.startsWith("|---"));
  const n = rows.length;
  assert(n > 0, "§11.0 的清单里没有数据行");

  // 清单自己声明的条数
  const declared = Number(sec.match(/共\s*(\d+)\s*条/)?.[1] ?? -1);
  assert(declared === n, `§11.0 声明「共 ${declared} 条」，表里却有 ${n} 行`);

  // 执行摘要报的数字必须等于清单行数
  const execMd = rep.chapters.find((c) => c.id === 0)?.markdown ?? "";
  const execN = Number(execMd.match(/\*\*(\d+)\s*条\*\*实质变化/)?.[1] ?? -1);
  assert(
    execN === n,
    `执行摘要说 ${execN} 条实质变化，§11.0 清单里是 ${n} 条 —— 两处对不上账`,
  );

  // §11.3 / 11.3.1 / 11.3.3 / 第12章 各自的条数必须能在清单的来源分解里对上
  const bd = execMd.match(/共\s*(\d+)\s*条原始条目/)?.[1];
  assert(!!bd, "执行摘要没有说明「原始条目共几条」，读者对不上账");
  return `全报告只报 ${n} 条（原始 ${bd} 条去重后）`;
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

  // §12.0 决策视图 + §12.1 分组总表 里有参数行；§12.2 起是逐参数明细块
  // （4 列版本表，单独检查）。
  //
  // **必须按表分类**：§12.0 的「分组速览」表是 4 列的统计表
  // （组 / 条数 / 含义 / 要做什么），它不是参数行。把全章的 `| **` 行
  // 一律当参数行验，就会报「4 列，期望 >= 6」这种**假警** ——
  // 闸门一旦开始喊狼来了，就没人再听它的。
  const tables = [];
  let cur = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("|")) {
      if (!cur) {
        cur = { header: null, rows: [] };
        tables.push(cur);
      }
      if (cur.header === null) cur.header = line;
      else if (!/^\|[\s:|-]+\|$/.test(line.trim())) cur.rows.push(line);
    } else {
      cur = null;
    }
  }
  const paramTables = tables.filter(
    (t) => /参数/.test(t.header ?? "") && /判定/.test(t.header ?? ""),
  );
  const rows = paramTables.flatMap((t) => t.rows);
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

  // **分组不能丢行**：四个子组的行数之和必须等于矩阵的行数。
  // 以前 305 行平铺，没有分组；现在分成「有变化 / 只有一版有 / 缺一版 / 三版一致」，
  // 一旦分组逻辑有漏，参数就会**静默消失** —— 比显示错更糟。
  const matrix = loadReport().parameterMatrix ?? [];
  const groupCounts = {
    changed: (md.match(/### 12\.1\.1 有变化（(\d+) 条）/) ?? [])[1],
    single: (md.match(/### 12\.1\.2 只有一版有规定（(\d+) 条）/) ?? [])[1],
    incomplete: (md.match(/### 12\.1\.3 缺一版取值（(\d+) 条）/) ?? [])[1],
    same: (md.match(/### 12\.1\.4 三版一致（(\d+) 条）/) ?? [])[1],
  };
  for (const [k, v] of Object.entries(groupCounts)) {
    assert(!!v, `第 12 章缺 ${k} 组的小标题 —— 分组结构不完整`);
  }
  const sumGroups = Object.values(groupCounts).reduce((a, b) => Number(a) + Number(b), 0);
  assert(
    sumGroups === matrix.length,
    `四个分组的行数之和 ${sumGroups} ≠ 矩阵行数 ${matrix.length} —— 有参数被漏掉了`,
  );
  // 「三版一致」那一组必须能数出矩阵里 verdict=same 的行数
  const sameInMatrix = matrix.filter((m) => m.verdict === "same").length;
  assert(
    Number(groupCounts.same) === sameInMatrix,
    `「三版一致」组写了 ${groupCounts.same} 条，矩阵里实际 ${sameInMatrix} 条`,
  );

  // 「三版一致」的逐条明细挪到附录 G —— 一个都不能少
  const appG = loadReport().appendices?.find((a) => a.id === "G");
  assert(!!appG, "报告里没有附录 G（三版一致参数逐条明细）");
  const gBlocks = (appG.markdown ?? "").split("\n").filter((l) => l.startsWith("#### "));
  assert(
    gBlocks.length === sameInMatrix,
    `附录 G 有 ${gBlocks.length} 个明细块，「三版一致」的行有 ${sameInMatrix} 条 —— 对不上`,
  );

  // **§12.0 的分组速览表必须与 §12.1.x 的小标题对得上** ——
  // 两处各写一遍条数，不交叉校验就等于有两个真相来源。
  const groupTable = tables.find((t) => /^\|\s*组\s*\|/.test(t.header ?? ""));
  assert(!!groupTable, "第 12 章没有「分组速览」表（§12.0 决策视图）");
  const groupTableCounts = groupTable.rows.map((l) =>
    Number(l.trim().replace(/^\||\|$/g, "").split("|")[1]?.trim() ?? NaN),
  );
  const headingCounts = [
    Number(groupCounts.changed),
    Number(groupCounts.single),
    Number(groupCounts.incomplete),
    Number(groupCounts.same),
  ];
  assert(
    JSON.stringify(groupTableCounts) === JSON.stringify(headingCounts),
    `§12.0 速览表的条数 ${groupTableCounts.join("/")} 与 §12.1.x 小标题的 ${headingCounts.join("/")} 对不上`,
  );

  return `${rows.length} 个参数行 · 四组合计 ${sumGroups} = 矩阵 ${matrix.length} · 附录 G 明细 ${gBlocks.length} 块 · 速览表与分组标题一致`;
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
  // Chapter 13 is still A-vs-B only: UN R48's clause system is not isomorphic
  // with GB's, so no sentence-level mapping exists there, and the chapter has
  // to say so.
  //
  // Chapter 14 is no longer A/B-only. The client read the old A/B-only table as
  // 「仅有两版国标，无欧标」, so chapter 14 now carries a REAL third column:
  // the corresponding UN R48-09 chapter's clause number, page and original
  // text, taken from the verified GB-chapter → R48-chapter map
  // (data/r48-chapters.json). What it must still declare is the LIMITS of
  // that column: it is chapter-level (not clause-level), and the clause-level
  // truth lives in chapter 12.
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
  assert(
    /第 12 章|附录 C/.test(c13),
    "chapter 13 does not point the reader at the three-version material",
  );

  const c14 = get(14).markdown ?? "";
  // The declaration has to name the third column and its caliber.
  assert(
    c14.includes("C 列是欧标原文"),
    "chapter 14 must declare that its third column is real UN R48 text",
  );
  assert(
    c14.includes("章节级") && c14.includes("非条款级"),
    "chapter 14 must declare that its R48 pointers are chapter-level, not clause-level",
  );
  assert(
    /第 12 章/.test(c14),
    "chapter 14 does not point the reader at the clause-level three-version material",
  );
  // And it must say what happens where R48 genuinely has no counterpart,
  // rather than leaving the reader to guess whether the cell was forgotten.
  assert(
    c14.includes("无对应章"),
    "chapter 14 must say what it prints where UN R48 has no corresponding chapter",
  );

  // Anti-rot: the scope marker must ride on EVERY pointer line, not just in the
  // preamble — a reader who lands on one clause block never sees the preamble.
  const pointers = (c14.match(/\*\*R48 对应章节/g) ?? []).length;
  const tagged = (c14.match(/\*\*R48 对应章节（章节级，非条款级）\*\*/g) ?? []).length;
  assert(pointers > 0, "chapter 14 lost its R48 chapter-level pointers entirely");
  assert(
    tagged === pointers,
    `only ${tagged}/${pointers} R48 pointers carry the 章节级/非条款级 marker`,
  );
  // A pointer that CLAIMS a counterpart must name a clause number; a pointer
  // that says there is none must say WHY. Both are dead ends otherwise.
  const pointerLines = c14
    .split("\n")
    .filter((l) => l.includes("**R48 对应章节（章节级，非条款级）**"));
  assert(
    pointerLines.length === pointers,
    `抽出 ${pointerLines.length} 条指针行，章里数到 ${pointers} 条`,
  );
  for (const l of pointerLines) {
    if (l.includes("→")) {
      assert(
        /→[^§]*§\d/.test(l),
        `R48 指针声称有对应章却没有条款号：${l.slice(0, 80)}`,
      );
    } else {
      assert(
        /无对应章 —— \S/.test(l),
        `R48 指针说「无对应章」却没有给理由：${l.slice(0, 80)}`,
      );
    }
  }
  return `ch13 声明排除 C · ch14 声明 C 列是欧标原文且为章节级 · ${pointers} 条 R48 指针全部带标记（有的给条款号、有的给理由）`;
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
  //
  // **三列，不是两列**：C 列是 UN R48-09 对应章的条款号 + 页码 + 原文摘录。
  // 两列的 A|B 表正是客户说的「仅有两版国标，无欧标」。
  const ch = loadReport().chapters.find((c) => c.id === 14);
  assert(ch, "chapter 14 missing");
  const md = ch.markdown ?? "";

  const blocks = md.split(/\n(?=## 14\.x 条款 )/).slice(1);
  assert(blocks.length > 0, "chapter 14 has no clause blocks");
  let sideBySide = 0;
  for (const b of blocks) {
    const lines = b.split("\n");
    const hdr = lines.findIndex((l) => /^\|\s*\*\*A 草案\*\*（/.test(l));
    assert(hdr >= 0, `clause block is not a side-by-side A|B|C table: ${lines[0] ?? ""}`);
    const row = lines[hdr + 2] ?? "";
    // header, separator, exactly one body row — nothing else in the table
    assert(/^\|[\s:|-]+\|$/.test(lines[hdr + 1] ?? ""), `no separator row under ${lines[hdr]}`);
    assert(row.startsWith("|") && row.trimEnd().endsWith("|"), `body row is not a closed table row`);
    const cells = row.slice(1, -1).split("|");
    assert(cells.length === 3, `expected 3 columns (A|B|C), got ${cells.length}`);
    // The third column must carry something: either the R48 clause (§6.x) or an
    // explicit statement that R48 has no counterpart. An empty cell is neither.
    const c = cells[2].trim();
    assert(c.length > 0, `the C column is empty in: ${lines[0] ?? ""}`);
    assert(
      /§[\d.]+/.test(c) || /无对应章/.test(c),
      `the C column states neither an R48 clause nor why there is none: ${c.slice(0, 60)}`,
    );
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
  return `${sideBySide} 条条款均为 A|B|C 三列并排，无跨行单元格`;
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

check("agent 的取值提议全部过了抽取器语义的校验", () => {
  // agent 产出的正则要能被采纳，必须先过**抽取器同一套语义**的校验
  // （逐页扫描 · 第一页命中 · 只读第 1 个捕获组 · 落在对的章）。
  // 这条闸门保证「采纳页面上摆出来的东西」不会有一半是坏的。
  const p = resolve(ROOT, "data/parameter-specs-agent.json");
  if (!existsSync(p)) {
    return "还没有 agent 提议（跑 node scripts/run_spec_agent.mjs 生成）—— 本次跳过";
  }
  const doc = JSON.parse(readFileSync(p, "utf-8"));
  const rows = doc.rows ?? [];
  const script = `
import fs from "node:fs";
import { deviceChapterPrefixes, validateProposal } from "./dist/specAgent.js";
const specs = JSON.parse(fs.readFileSync("data/parameter-specs.json", "utf8")).specs;
const corpus = JSON.parse(fs.readFileSync("dist/mineru-v4-data.json", "utf8"));
const doc = JSON.parse(fs.readFileSync("data/parameter-specs-agent.json", "utf8"));
const bad = [];
let checked = 0;
for (const r of doc.rows ?? []) {
  if (!r.source) continue;          // absent / 出错的，没有正则可验
  checked++;
  const prefixes = deviceChapterPrefixes(specs, r.device, r.version);
  if (!prefixes.length) { bad.push(r.id + "@" + r.version + "：章号推不出来，没法验"); continue; }
  const v = validateProposal(
    { id: r.id, version: r.version, device: r.device, name: r.name, source: r.source, flags: r.flags },
    corpus[r.version], prefixes, { unit: r.unit });
  if (!v.ok) bad.push(r.id + "@" + r.version + "：" + v.reason);
  else if (r.validation && r.validation.ok === false) bad.push(r.id + "@" + r.version + "：落盘时已标为不过");
}
console.log(JSON.stringify({ checked, bad }));
`;
  const r = spawnSync("node", ["--input-type=module", "-e", script], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  assert(r.status === 0, `校验 agent 提议的片段跑不起来：${(r.stderr || "").slice(-400)}`);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert(
    out.bad.length === 0,
    `${out.bad.length} 条 agent 提议没过抽取器语义的校验（不能采纳）：\n        ${out.bad
      .slice(0, 5)
      .join("\n        ")}`,
  );
  return `${out.checked} 条带正则的提议全部通过校验`;
});

check("chapter 14's C column matches the verified GB→R48 chapter map", () => {
  // The client read the old two-column table as 「仅有两版国标，无欧标」. The
  // third column now carries UN R48-09's corresponding chapter — clause
  // number, page and original text — from data/r48-chapters.json, which
  // scripts/build_r48_chapters.py builds by checking every mapping back
  // against the R48 corpus.
  //
  // Two failure modes this has to catch, and both shipped:
  //  · **指错** — 「后位灯」 pointed at §6.9.4.1, the FRONT position lamp's
  //    clause; the four retro-reflectors all pointed at §6.14.
  //  · **漏指** — R48's §6.11 rear fog lamp / §6.12 parking lamp / §6.18
  //    side-marker / §6.20 cornering lamp / §6.21 conspicuity markings /
  //    §6.22 AFS / §6.23 emergency stop signal were printed as
  //    「无同构章节」.
  const map = JSON.parse(read("data/r48-chapters.json"));
  const mapEntries = map?.map ?? {};
  const gbOnly = map?.gbOnly ?? {};
  assert(
    Object.keys(mapEntries).length >= 20,
    `the GB→R48 chapter map only has ${Object.keys(mapEntries).length} entries`,
  );

  // The map must still match the corpus — a stale map is a wrong map.
  const res = runPy(["scripts/build_r48_chapters.py", "--check"]);
  assert(
    res.ok,
    `data/r48-chapters.json is stale or contradicts the R48 corpus:\n        ${res.out
      .trim()
      .split("\n")
      .slice(-6)
      .join("\n        ")}`,
  );

  const ch = loadReport().chapters.find((c) => c.id === 14);
  assert(ch, "chapter 14 missing");
  const md = ch.markdown ?? "";
  const blocks = md.split(/\n(?=## 14\.x 条款 )/).slice(1);

  // B-side chapter number → the C cell it printed.
  // A-only chapters have no B-side number (`— ↔ A 7（A 独有）`) — the whole
  // clause string is the key there, exactly as the renderer derives it.
  const cCellOf = new Map();
  for (const b of blocks) {
    const lines = b.split("\n");
    const m = lines[0].match(/^## 14\.x 条款 (.+?) — /);
    if (!m) continue;
    const full = m[1].trim();
    const bSide = full.split("↔")[0].trim();
    const key = /^\d/.test(bSide) ? bSide : full;
    const hdr = lines.findIndex((l) => /^\|\s*\*\*A 草案\*\*（/.test(l));
    if (hdr < 0) continue;
    const cells = (lines[hdr + 2] ?? "").slice(1, -1).split("|");
    cCellOf.set(key, (cells[2] ?? "").trim());
  }

  for (const [gb, e] of Object.entries(mapEntries)) {
    const c = cCellOf.get(gb);
    assert(!!c, `chapter 14 has no block for GB ${gb}（${e.gbName}）`);
    assert(
      c.startsWith(`§${e.r48}`),
      `GB ${gb}（${e.gbName}）的 C 列写的是「${c.slice(0, 40)}」，` +
        `但对应表说它应是 §${e.r48}（${e.r48Name}）—— 指错装置了`,
    );
    // A chapter number without a page is not checkable by the reader.
    assert(
      /§[\d.]+（第\d+页）/.test(c),
      `GB ${gb}（${e.gbName}）的 C 列没有页码：${c.slice(0, 50)}`,
    );
    // …and it has to be R48's own words, not a placeholder.
    assert(
      c.length > 60,
      `GB ${gb}（${e.gbName}）的 C 列没有原文摘录（只有 ${c.length} 字）`,
    );
  }

  for (const [gb, why] of Object.entries(gbOnly)) {
    const c = cCellOf.get(gb);
    assert(!!c, `chapter 14 has no block for GB ${gb}`);
    assert(
      /无对应章/.test(c),
      `GB ${gb} 在对应表里登记为「R48 无对应章」（${String(why).slice(0, 30)}…），` +
        `但报告的 C 列写的是「${c.slice(0, 40)}」—— 两处对不上`,
    );
  }

  const real = [...cCellOf.values()].filter((c) => /§[\d.]+（第\d+页）/.test(c)).length;
  return `${Object.keys(mapEntries).length} 条对应全部逐章对上（${real} 条有 R48 原文）+ ${Object.keys(gbOnly).length} 条 GB 独有已写明理由`;
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

check("覆盖审计没有真漏，也没有别装置顶替", () => {
  // 这是「数据完整」最硬的一条：**三版原文里每一个带单位的标量限值，
  // 都能在参数矩阵里找到一条真的覆盖它的行**。
  //
  // 「真漏」= 矩阵里根本没有对应行（读者拿不到这个数）。
  // 「别装置顶替」= 矩阵里有同值的行，但属于**别的装置**（读者会拿到一个
  //   数值相等但口径不同的答案 —— 比空着更坏）。
  //
  // 2026-10-24 之前这条是 20 个「别装置顶替」+ 2 个「真漏」，
  // 根因是条款切分器把 A 草案 5.20（无编号小节）之后的条款整段丢了，
  // 于是 A 的 ADS 标志灯 / 慢行灯 / 倒车灯在覆盖审计里**根本不存在**。
  const { ok, out } = runPy(["scripts/coverage_audit.py"], "coverage_audit");
  assert(ok, `coverage_audit.py 跑不起来：\n        ${out.slice(-600)}`);
  const lines = out.split("\n").filter((l) => /同条款覆盖/.test(l));
  assert(lines.length >= 3, `覆盖审计没有输出三版统计：\n        ${out.slice(-400)}`);
  const bad = [];
  for (const l of lines) {
    const ver = (l.match(/【(.+?)版】/) ?? [])[1] ?? "?";
    const other = Number((l.match(/\*\*别装置顶替 (\d+)\*\*/) ?? [])[1] ?? "0");
    const miss = Number((l.match(/\*\*真漏 (\d+)\*\*/) ?? [])[1] ?? "0");
    if (other || miss) bad.push(`${ver}: 别装置顶替 ${other} · 真漏 ${miss}`);
  }
  assert(
    bad.length === 0,
    `覆盖审计有未被真正覆盖的限值 —— ${bad.join("；")}\n` +
      "        （要么矩阵缺行，要么 data/table-clauses.json 里的「不是限值」登记被漏了）",
  );
  const total = (out.match(/三版合计：.*/) ?? [""])[0];
  return total.replace("三版合计：", "") || "三版 真漏 0 · 别装置顶替 0";
});

check("A 草案的条款索引没有被「无编号小节」截断", () => {
  // A 的 5.20「醒目标志」是**无编号小节**（正文里没有 5.20.x 子条款），
  // 于是条款序列从 5.19.x 直接跳到 5.21.x。
  // 条款切分器的「节推进必须 +1」曾经把这之后的条款整段丢掉 ——
  // 倒车灯(5.21.x)、慢行灯(5.22.x)、牵引杆挂车标志灯(5.23.x)、
  // **ADS 标志灯(5.24.x)** 共 71 条条款在索引里消失，
  // 而索引是**要求台账与覆盖审计的唯一输入**：
  // 「445 条要求条款全部有处置、真缺口 0」当时是在**一个缺了 4 个装置的集合**上说的。
  const idx = JSON.parse(read("data/clause-index.json"));
  const A = idx._clauses?.A ?? {};
  const need = [
    ["5.21", "倒车灯"],
    ["5.22", "慢行灯"],
    ["5.23", "牵引杆挂车标志灯"],
    ["5.24", "ADS 标志灯"],
  ];
  const missing = [];
  for (const [pre, name] of need) {
    const n = Object.keys(A).filter((k) => k === pre || k.startsWith(pre + ".")).length;
    if (n < 8) missing.push(`${name}(${pre}.x) ${n} 条`);
  }
  assert(
    missing.length === 0,
    `A 的条款索引缺这些装置：${missing.join("、")} —— 条款切分器又把无编号小节后的条款吞掉了`,
  );
  return need.map(([p, n]) => `${n} ${p}.x`).join(" · ");
});

check("appendix H — every quoted A/B passage is in the source PDF", () => {
  // 附录 H 是客户第一句抱怨（「仍然只有法规中，有具体数值的内容的比较」）的
  // 直接答复 —— 条款级的定性并排对照。**它引的每一句都必须来自原文**。
  //
  // 这条闸门抓到过一个真问题：清洗正文时把 PDF 拆行造成的
  // 「宽度大于2.\\n10m」当成了条款号碎片删掉，**2.10m 变成 10m** ——
  // 宽度门槛差一个数量级，而它会原样印在客户手里。
  const { ok, out } = runPy(["scripts/check_qualitative_diff.py"], "check_qualitative_diff");
  assert(ok, `附录 H 的引文有对不上的：\n        ${out.slice(-600)}`);
  return out.match(/命中 \d+ 条/)?.[0] ?? "ok";
});

check("appendix H — the row count equals the data it is built from", () => {
  const app = loadReport().appendices?.find((a) => a.id === "H");
  assert(!!app, "报告里没有附录 H（A/B 定性条款并排对照）");
  const md = app.markdown ?? "";
  const data = JSON.parse(read("data/qualitative-diff.json"));
  const s = data.summary ?? {};
  const diffRows = (md.match(/^\| B \d+(\.\d+)* \/ A /gm) ?? []).length;
  assert(
    diffRows === (s.differentText ?? 0),
    `附录 H.2 列了 ${diffRows} 行，数据里是 ${s.differentText ?? 0} 条「文字不同」`,
  );
  assert(
    md.includes(`可并排 **${s.comparable}**`),
    `附录 H.1 汇总里的「可并排」数与数据不符（应为 ${s.comparable}）`,
  );
  assert(
    md.includes(`## H.3 归一化后同文的条款（${s.sameText} 条）`),
    `附录 H.3 的条数与数据不符（应为 ${s.sameText}）`,
  );
  return `H.2 ${diffRows} 行 · 同文 ${s.sameText} · 不可并排 ${s.notComparable}`;
});

check("§11.4 网传指标不计入待复核桶（已裁定的不是待办）", () => {
  // 台账的 candidate（⚠ 待复核）桶收的是「⚠未找到 / 未核验」的行。
  // **§11.4 的 9 条网传指标也带 ⚠**，但那里的 ⚠ 是
  // 「GB4785 声称值与原文不一致」—— 那一行行的**结论已经给了**
  // （3 条两版相同 [保留] · 1 条仅一版提到 [单边] · 5 条查过原文确实没有），
  // 逐条依据写在表下。
  //
  // 算进去的后果：仪表盘说「10 条 (15%) 仍处于待复核状态」，
  // 而 §11.4 的结论说「9 条中 4 条在原文找到、5 条未找到」，
  // 执行摘要说「0 项仍待人工裁定」—— **同一份报告里三个数打架**。
  // 这正是客户说的「两个数」。
  const md = reportText();
  const L = buildLedger(md);
  const rumors = [
    "DRL 转向冲突时减光后最大光强", "ESS 紧急制动信号闪烁频率", "ESS 光度",
    "DRL 可见度角度", "侧标志灯间距", "LED 寿命", "光通维持率",
    "预热点灯时间", "AFS 切换时间",
  ];
  // ① 那 9 行确实在报告里，且都带「核验状态」列（说明已逐条裁定）
  const missing = rumors.filter((r) => !md.includes(`| ${r} |`));
  assert(missing.length === 0, `§11.4 的网传指标行不见了：${missing.join("、")}`);
  assert(
    /核验状态/.test(md),
    "报告里找不到「核验状态」列 —— §11.4 的逐条裁定表不见了",
  );
  // ② 任何一条都**不许**出现在待复核桶里
  const cands = L.entries.filter((e) => e.category === "candidate");
  const wrongly = cands.filter((c) => rumors.some((r) => String(c.topic ?? "").includes(r)));
  assert(
    wrongly.length === 0,
    `已裁定的网传指标被算进了待复核桶：${wrongly.map((c) => c.topic).join("、")} —— ` +
      "§11.4 的 ⚠ 表示「声称值与原文不一致」，不是「待复核」",
  );
  return `9 条网传指标已逐条裁定 · 待复核桶剩 ${cands.length} 条`;
});

check("every reported value is in the clause it cites", () => {
  // 不变式：矩阵报出的取值必须就在**它引用的那条条款**里（含祖先/后代条款）。
  // 这是「值对、条款错」那一类错的克星 —— 引用 4.25 却报 5°、引用 6.14.4.1
  // 却报 1500mm，都会被这里挡住。
  //
  // 命中分两档：**强命中**（带单位、按基准量纲换算后相等）与**弱命中**
  // （原文里只有裸数字，单位在表头或用「参考值」定义）。弱命中不算失败，
  // 但数量会报出来，人可以看一眼。
  const { ok, out } = runPy(["scripts/clause_value_check.py"], "clause_value_check");
  assert(ok, `有取值不在它引用的条款里:
        ${out.slice(-900)}`);
  const m = out.match(/检查了 (\d+) 个取值格（强命中 (\d+) · 弱命中 (\d+)）/);
  assert(m, `clause_value_check 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 个取值格逐条回条款验到（强 ${m[2]} · 弱 ${m[3]}）`;
});

check("the chapters whose clause numbers are bitmaps are still scanned", () => {
  // GB 4785 草案第 4 章的条款号印在 PDF 左边距、是位图，文本层取不到 ——
  // 按条款扫描会**整章扫不到**，等于这一章隐形（电压、前视红光、可变光强、
  // 可藏灯、光色…）。这张登记表把这类章节列出来，覆盖审计按页区间扫它们。
  const bc = JSON.parse(read("data/bitmap-chapters.json"));
  const entries = [];
  for (const [ver, chs] of Object.entries(bc)) {
    if (ver.startsWith("_")) continue;
    for (const [ch, meta] of Object.entries(chs)) {
      entries.push(`${ver} 第${ch}章（第 ${meta.pages?.[0]}–${meta.pages?.[meta.pages.length - 1]} 页）`);
    }
  }
  assert(entries.length > 0, "data/bitmap-chapters.json 是空的 —— 位图章节没人扫");
  // 每一章都必须真的被审计到：覆盖清单里 limits 不能比登记表少
  const audit = JSON.parse(read("data/coverage-audit.json"));
  const limits = Object.values(audit.versions ?? {}).reduce((n, v) => n + (v.limits ?? 0), 0);
  assert(limits > 0, "覆盖清单里一条限值都没有");
  return `${entries.length} 个位图章节在扫：${entries.join("、")}`;
});

check("every cited clause can actually reach the value", () => {
  // 不变式：矩阵引用的条款，必须**管得着**取值所在的那一页。
  //
  // 「值对、条款错」里最阴的一种是**交叉引用吃掉了条款号**：
  //   A §5.19.7.5「……后位灯和 4.11 规定的其他灯具允许熄灭……」
  //                              ^^^^^ 4.11 是电路连接那条，不是本条
  // 引用被就近推断带成 4.11（位图章节，索引里根本没有这一条），
  // 而「取值在它引用的条款里」那一关对位图章节只能退回整章当背景的
  // **弱命中** → 照样放行。于是页对、值对、条款错，读者按 4.11 翻过去
  // 找不到那句话。
  //
  // 这一关用**页码**当独立证据：条款在索引里 → 比它管的页区间；
  // 条款属于位图章节 → 取值必须落在该章的页区间里。
  const { ok, out } = runPy(["scripts/clause_page_check.py"], "clause_page_check");
  assert(ok, `引用的条款管不到取值所在的那一页:\n        ${out.slice(-900)}`);
  const m = out.match(/核了 (\d+) 个取值格/);
  assert(m, `clause_page_check 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 个取值格的条款号与页码互相对得上`;
});

check("every matrix cell's page carries the quote it shows", () => {
  // 矩阵的页码来自 MinerU 的分页标记；**主题列**早就做过「源 PDF 页码复核」
  // （verify_claims.py 的那一遍，四个格因此被降级），**矩阵这一路没做过**。
  // 拿引文本身当证据回源 PDF 找：引文不在它自己报的页上，就是一条错信息。
  const { ok, out } = runPy(["scripts/matrix_page_check.py"], "matrix_page_check");
  assert(ok, `矩阵报的页上找不到它自己的引文:\n        ${out.slice(-900)}`);
  const m = out.match(/核了 (\d+) 个取值格/);
  assert(m, `matrix_page_check 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 个取值格的引文回源 PDF 验到，页码全对`;
});

check("every empty matrix cell says why it is empty", () => {
  // 「宁可空着，不可错着」还有另一半：**空着也要说清为什么空**。
  // 一个既没有取值、也没有说明的格子，读者分不清是「该版确实没这条」
  // 还是「抽不出来」—— 前者是法规结论，后者是数据缺陷。
  //
  // 之前全矩阵 301 行里只有一格属于后者（GB 4785-2019 的
  // 「昼间行驶灯点亮时后位灯允许熄灭的环境照度阈值」）：
  // 2019 版确实没这条（它 5.2.7.6b) 要求后位灯**必须**点亮），
  // 但矩阵里既没值也没写原因 —— 读者会以为漏抽了。
  const spec = JSON.parse(read("data/parameter-specs.json"));
  const byId = new Map((spec.specs ?? []).map((s) => [s.id, s]));
  const rep = JSON.parse(read("reports/last-report.json"));
  const bad = [];
  let empty = 0;
  for (const r of rep.parameterMatrix ?? []) {
    const s = byId.get(r.id);
    for (const ver of ["A", "B", "C"]) {
      const c = r.cells?.[ver];
      if (c?.status === "verified") continue;
      empty++;
      const note = (s?.absent ?? {})[ver];
      if (!String(note ?? "").trim()) {
        bad.push(`${r.id}/${ver}（status=${c?.status ?? "none"}, miss=${c?.miss ?? "-"}）`);
      }
    }
  }
  assert(
    bad.length === 0,
    `这些格子既没有取值、也没有说明为什么没有（读者分不清「该版无此规定」和「抽不出来」）:\n        ${bad.join("\n        ")}`,
  );
  return `${empty} 个空格全部写明了原因`;
});

check("the clause index has no holes and no abnormally long clauses", () => {
  // 条款切分器的碎片拼接一旦被**正文行**打断，后面的真条款会被拼成
  // 「23.4.10」这种不存在的条款号，于是**整条丢掉**：
  // B（GB 4785-2019）第 4 章的 4.10–4.31 曾经整段没进索引，
  // 而 4.9 又被登记为「不在范围」——**一般要求整章对覆盖审计隐形**，
  // 电压、货车透光面、移动部件 0.15% / 遮挡 50%、可藏灯、光色…一条都没被清点过。
  //
  // 两条信号：条款号**有洞**（标准自己编的号不跳号）、条款正文**异常长**
  // （被吞掉的条款会挂在上一条身上）。附录/术语章/配光表天然长，
  // 登记在 data/clause-gap-allowlist.json 里，写明理由。
  const { ok, out } = runPy(["scripts/clause_gap_check.py"], "clause_gap_check");
  assert(ok, `条款索引有洞或异常长的条款:\n        ${out.slice(-900)}`);
  return out.split("\n")[0];
});

check("every chapter-11 diff value is backed by the source text", () => {
  // 第 11 章的 45 条差值是全报告唯一**没有回原文验过**的取值来源
  // （第 12 章有 clause_value_check.py 守着）。逐条回原文核下来，
  // 事故是系统性的，不是个案：
  //   · 近光灯·弯道照明曲率半径的 A 值被抄成「不大于500mm」——
  //     原文三版都是「不大于 500m」，差 1000 倍，这一行还被标成「有变化」；
  //   · 自动切换前照灯近光条件（A 附录C 表C.1 / B 附录H 表H.1 两表逐格相同）
  //     被错配成「近光灯状态：开启 → 不大于2s」这种不成对的假变化；
  //   · 单位被重复写了两遍（「（4.0±1.0）HzHz」「不得超过3ss」）。
  // 更正见 data/diff-corrections.json，清洗见 scripts/diff_corrections.py。
  const { ok, out } = runPy(["scripts/diff_value_check.py"], "diff_value_check");
  assert(ok, `第 11 章的差值取值站不住:\n        ${out.slice(-900)}`);
  const m = out.match(/差值表复核：(\d+) 条差值，(\d+) 条人工更正/);
  assert(m, `diff_value_check 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 条差值回原文复核通过（其中 ${m[2]} 条人工更正）`;
});

check("the shipped report carries no known-wrong diff value and no false change count", () => {
  // 报告层再兜一层底：已知错值不许出现在交付件里，矩阵小结的「实质变化」
  // 条数必须等于核验过的条数（过去那张 45 行的表用「两个取值当字符串一比」
  // 判变化，写着「45 项参数中 45 项有实质变化」—— 45 行里 42 行是假的）。
  const rep = JSON.parse(read("reports/last-report.json"));
  const md = (rep.chapters ?? []).map((c) => c.markdown ?? "").join("\n");
  const bad = [];
  // 只看**表格行**里有没有这个错值 —— 正文里引用它来解释「改了什么」是应该的
  const wrongCell = md
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && l.includes("不大于500mm"));
  if (wrongCell.length) {
    bad.push(
      `表格里还有 ${wrongCell.length} 处「不大于500mm」—— 原文三版都是「不大于 500m」:` +
        wrongCell.slice(0, 3).map((l) => "\n        " + l.slice(0, 160)).join(""),
    );
  }
  if (/\d+ 项参数中 \*\*\d+ 项有实质变化\*\*/.test(md)) {
    bad.push("矩阵小结仍用旧口径宣称「N 项参数中 N 项有实质变化」");
  }
  const facts = JSON.parse(read("dist/facts.json"));
  const verdicts = Object.values(facts.diffVerdicts ?? {});
  const realChanges = verdicts.filter((v) => String(v.verdict ?? "").startsWith("有变化")).length;
  const m = md.match(/(\d+) 项差值候选中 \*\*(\d+) 项为实质变化\*\*/);
  assert(m, "矩阵小结没有给出「差值候选 / 实质变化」的条数");
  assert(
    Number(m[2]) === realChanges,
    `矩阵小结说 ${m[2]} 项实质变化，核验结果是 ${realChanges} 项 —— 数字对不上`,
  );
  const pending = verdicts.filter((v) => v.verdict === "待核实").length;
  assert(pending === 0, `还有 ${pending} 行判不出来（待核实）—— 宁可空着，也要把结论留给原文`);
  assert(bad.length === 0, bad.join("\n        "));
  return `${verdicts.length} 行差值全部有判定，实质变化 ${realChanges} 项`;
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
    # 交付件没有印在纸上的目录页（导航靠 PDF 书签）——
    # 那就查书签：客户端真正用来跳转的东西。
    toc_entries = []
    for lvl, title, page in (d.get_toc() or []):
        t = re.sub(r"^[0-9]+[.\s]*", "", str(title)).strip()
        toc_entries.append((t, int(page)))
    if not toc_entries:
        print(json.dumps({"skipped": "no printed TOC and no bookmarks"})); raise SystemExit(0)
    bad_bm = []
    for title, page in toc_entries:
        key = re.sub(r"\s+", "", title)[:10]
        if not key or page < 1 or page > d.page_count:
            continue
        hit = any(re.sub(r"\s+", "", key) in re.sub(r"\s+", "", d[i].get_text()[:400]) for i in range(d.page_count))
        if hit and not any(re.sub(r"\s+", "", key) in re.sub(r"\s+", "", d[p - 1].get_text()[:400]) for p in (page, page + 1) if 1 <= p <= d.page_count):
            bad_bm.append((title, page))
    uniq_bm = {p for _, p in toc_entries}
    if len(uniq_bm) == 1:
        print(json.dumps({"error": "every bookmark reads page %d — the pass-2 backfill degenerated" % uniq_bm.pop()}))
        raise SystemExit(0)
    print(json.dumps({"bookmarks": len(toc_entries), "distinct_pages": len(uniq_bm), "mismatched": bad_bm[:6]}))
    raise SystemExit(0)
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
  if (res.bookmarks !== undefined) {
    return `${res.bookmarks} 条书签 · ${res.distinct_pages} 个不同页码 · 每条都落在对应章节`;
  }
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

check("the closure dashboard counts the same changes the summary does", () => {
  // PDF 第 3 页的「候选差异闭环统计」与执行摘要的「实质变化项数」说的是同一批事实。
  // §11.3.1 人工核验补录以前没进台账 → 第 3 页只数到 3 条「已双源核验」，
  // 而执行摘要说 14 项 —— 同一份报告里两个数。这条闸门把它们绑在一起。
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 无法渲染 reports/last-report.json（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
    const py =
    "import sys,io,json,base64,fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path)\n" +
    "lines=[]\n" +
    "for pg in d: lines.extend(pg.get_text().splitlines())\n" +
    "def grab(label):\n" +
    "    for i,ln in enumerate(lines):\n" +
    "        if label in ln:\n" +
    "            for j in range(i+1, min(i+4, len(lines))):\n" +
    "                v=lines[j].strip()\n" +
    "                if v.isdigit(): return int(v)\n" +
    "    return None\n" +
    "print(json.dumps({'confirmed':grab('已双源核验'),'manual':grab('人工核验补录')}))";
const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf-8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert(
    r.status === 0,
    `闭环统计闸门的取数片段跑不起来（不能"跳过"—— 跳过的闸门等于没有闸门）：${(r.stderr || "").trim().split("\n").pop().slice(0, 200)}`,
  );
  const m = JSON.parse(r.stdout.trim().split("\n").pop());
  const facts = JSON.parse(read("dist/facts.json"));
  assert(m.confirmed !== null, "PDF 里找不到闭环统计的「已双源核验」一行");
  assert(m.manual !== null, "PDF 里找不到闭环统计的「人工核验补录」一行");
  assert(
    m.confirmed === (facts.numericChanges?.length ?? 0),
    `闭环统计说「已双源核验 ${m.confirmed} 条」，facts.json 里数值变化是 ${facts.numericChanges?.length ?? 0} 条`,
  );
  assert(
    m.manual === (facts.manualFindings?.length ?? 0),
    `闭环统计说「人工核验补录 ${m.manual} 条」，facts.json 里人工补录是 ${facts.manualFindings?.length ?? 0} 条`,
  );
  const total = m.confirmed + m.manual;
  assert(
    total === (facts.numericChanges?.length ?? 0) + (facts.manualFindings?.length ?? 0),
    `闭环统计的已核验 + 人工补录 = ${total}，与执行摘要的实质变化数对不上`,
  );
  return `已核验 ${m.confirmed} + 人工补录 ${m.manual} = ${total}，与执行摘要一致`;
});

// ---------------------------------------------------------------------------
// 2026-10-24 交付件㉖ 终审三处缺陷的防再犯闸
//
// 交付前我逐页读了㉖ 号 PDF，发现三处客户一眼能看见的自相矛盾：
//   ① 第 3 页仪表盘还写着「14 项参数在 A 草案中有实质变化」，而第 20 页
//      §11.0 变化总清单已经是 17 条 —— 同一份报告两个数。
//   ② 「⚠ 测量基准提示」整段说明在全文 **33 张表**前面各印一遍（33×300 字），
//      翻报告的客户只会得出「到处都是不确定」。
//   ③ 第 10 章有一张空表印着「条款 0 页码 — 未检索到对应标题」，
//      而该标题在 C 版里其实存在（措辞是英文）。
//
// 三处都修了，但**修了不加闸**就会在下一次改动里回来。三条闸门分别把
// 「总数只有一个来源」「整段只出现一次」「空表不许印成缺失」钉死。
// ---------------------------------------------------------------------------

let _gatePdfText = null;
/** Full text of the gate PDF, whitespace-normalised, cached. */
function gatePdfFlat() {
  if (!GATE_PDF) return null;
  if (_gatePdfText !== null) return _gatePdfText;
  const py =
    "import sys,io,json,base64,fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path); t='\\n'.join(p.get_text() for p in d)\n" +
    "t=''.join(t.split())\n" +
    "print(json.dumps({'t':t},ensure_ascii=False))";
  const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf-8",
    input: Buffer.from(GATE_PDF, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert(
    r.status === 0,
    `取 PDF 全文失败（不能"跳过"—— 跳过的闸门等于没有闸门）：${(r.stderr || "").trim().split("\n").pop().slice(0, 200)}`,
  );
  _gatePdfText = JSON.parse(r.stdout.trim().split("\n").pop()).t;
  return _gatePdfText;
}

check("the closure dashboard's change total is §11.0's number, not a second opinion", () => {
  // ① 第 3 页 vs 第 20 页：两个数必须同源。
  // 旧文案是「与执行摘要第 1 条『14 项参数在 A 草案中有实质变化』是同一批事实」——
  // 执行摘要改成 17 条之后，这句话留在那儿说谎。
  const flat = gatePdfFlat();
  if (flat === null) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  assert(
    !flat.includes("项参数在A草案中有实质变化"),
    "PDF 里还留着旧断言「…项参数在 A 草案中有实质变化」—— 它与 §11.0 的权威数会打架",
  );
  const rep = loadReport();
  const auth = extractAuthoritativeChanges(rep.chapters);
  assert(auth, "报告里找不到「## 11.0 变化总清单」");
  assert(auth.total > 0, "§11.0 变化总清单解析出 0 行 —— 提取器坏了，不是报告为空");
  const m = flat.match(/是§11\.0变化总清单(\d+)条里的(\d+)条/);
  assert(
    m,
    "PDF 仪表盘里找不到「是 §11.0 变化总清单 N 条里的 M 条」这句对账（全文扁平化后匹配）",
  );
  const only = flat.match(/另外(\d+)条只出现在第12章参数矩阵里/);
  assert(only, "PDF 仪表盘里找不到「另外 N 条只出现在第 12 章参数矩阵里」");
  assert(
    Number(m[1]) === auth.total,
    `仪表盘说 §11.0 是 ${m[1]} 条，报告里数出来是 ${auth.total} 条`,
  );
  assert(
    Number(m[2]) === auth.withEarly,
    `仪表盘说其中 ${m[2]} 条来自 §11.3/§11.3.1，报告里数出来是 ${auth.withEarly} 条`,
  );
  assert(
    Number(only[1]) === auth.onlyMatrix,
    `仪表盘说 ${only[1]} 条只来自第 12 章矩阵，报告里数出来是 ${auth.onlyMatrix} 条`,
  );
  return `仪表盘 ${m[1]} 条 = §11.0 的 ${auth.total} 条（${m[2]} 条来自 §11.3/§11.3.1，${only[1]} 条只来自矩阵）`;
});

check("the 测量基准 explanation appears once, with pointers in the tables", () => {
  // ② 整段说明只在前言的术语对照里印一次；表里只给一行指针。
  const flat = gatePdfFlat();
  if (flat === null) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  const oldBlock = (flat.match(/测量基准提示/g) ?? []).length;
  assert(
    oldBlock === 0,
    `「⚠ 测量基准提示」整段说明仍出现 ${oldBlock} 次 —— 它是前言那一份的复制粘贴`,
  );
  const full = (flat.match(/不可直接等价对标/g) ?? []).length;
  assert(
    full === 1,
    `完整说明「…不可直接等价对标」出现 ${full} 次 —— 应恰好 1 次（前言术语对照）`,
  );
  const pointers = (flat.match(/不是同一个测量面/g) ?? []).length;
  assert(pointers > 0, "表里连一行指针都没有 —— 术语警告被整段删掉了");
  return `整段 ${full} 次 · 指针 ${pointers} 次`;
});

check("no chapter prints an empty clause table as 'not found'", () => {
  // ③ 「条款 0 页码 — 未检索到对应标题」是**渲染缺陷**，不是数据缺失：
  // 那张表的三版都有条款，措辞不同而已（英文 vs 中文），所以之前空了一格。
  const flat = gatePdfFlat();
  if (flat === null) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  const bad = (flat.match(/未检索到对应标题/g) ?? []).length;
  assert(
    bad === 0,
    `PDF 里出现 ${bad} 次「未检索到对应标题」—— 那是把"措辞不同"印成了"没找到"`,
  );
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  assert(!md.includes("未检索到对应标题"), "报告正文里还留着「未检索到对应标题」");
  return "没有把措辞差异印成缺失";
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
    "'empty':[i+1 for i,pg in enumerate(d) if not pg.get_text().strip()],\n" +
    // 最小字号：版式炸掉的第二个症状（栅格列数错 → 文字被压到不可读）
    "'minfs':min([round(s['size'],2) for pg in d for b in pg.get_text('dict')['blocks']\n" +
    "           for l in b.get('lines',[]) for s in l.get('spans',[])\n" +
    "           if s.get('text','').strip()] or [99]),\n" +
    "'maxfs':max([round(s['size'],2) for pg in d for b in pg.get_text('dict')['blocks']\n" +
    "           for l in b.get('lines',[]) for s in l.get('spans',[])\n" +
    "           if s.get('text','').strip()] or [0]),\n" +
    "'pages':d.page_count}))\n";
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
  // 字号下限：栅格列数写错时（--trip-cols 传了字符串长度），
  // 文字被压进 0.16mm 宽的列里 —— 客户拿到的是一页页读不了的字。
  assert(
    m.minfs >= 4.5,
    `PDF 里出现了 ${m.minfs}pt 的字（小于 4.5pt）—— 版式炸了（栅格列数 / 缩放）`,
  );
  return `${m.pages}p, ${m.bookmarks} bookmarks, 0 bold, 0 tofu, 0 raw-tag, 0 blank, 字号 ${m.minfs}–${m.maxfs}pt`;
});

check("the delivered page count matches the recorded baseline", () => {
  // 交付件的文件名里就写着页数（「㉓_…_216页_…」）—— **页数是交付契约的一部分**。
  // 这一轮就漏过一次：卡片栅格的列数误传成字符串长度（1154 而不是 3），
  // 全文从 216 页变成 690 页，而**闸门一道都没红**（内容还是全的，
  // 只是每行只剩一个字）。
  // 基线记在 reports/page-count.json；页数变动超过 8% 必须**有意识地**改基线。
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）";
  const basePath = resolve(ROOT, "reports/page-count.json");
  assert(existsSync(basePath), "reports/page-count.json 不存在 —— 没法对照页数基线");
  const base = JSON.parse(readFileSync(basePath, "utf-8"));
  const r = spawnSync(
    "python",
    [
      "-c",
      "import sys,base64,fitz,json;d=fitz.open(base64.b64decode(sys.stdin.read().strip()).decode('utf-8'));print(d.page_count)",
    ],
    { cwd: ROOT, encoding: "utf-8", input: Buffer.from(pdfPath, "utf-8").toString("base64") },
  );
  if (r.status !== 0) return "skipped — PyMuPDF 打不开闸门渲染的 PDF";
  const pages = Number((r.stdout || "").trim().split("\n").pop());
  const drift = Math.abs(pages - base.pages) / Math.max(1, base.pages);
  assert(
    drift <= 0.08,
    `版式变了：${base.pages} 页 → ${pages} 页（${(drift * 100).toFixed(0)}%）。` +
      `版式改动是有意的就更新 reports/page-count.json（当前记着 ${base.pages} 页）`,
  );
  return `${pages} 页（基线 ${base.pages}，漂移 ${(drift * 100).toFixed(1)}%）`;
});

check("every requirement clause has a disposition", () => {
  // 「真缺口 0」过去只对**可量化**的那一半成立：445 条要求条款里
  // 290 条**无数值**（「紧急制动信号应自动开启与关闭」「应独立于其他灯具工作」）
  // 根本不参与限值统计 —— 不参与，就既没被证明在，也没被证明缺。
  // 现在每一条要求条款都要有处置，四档合计必须等于总数。
  const { ok, out } = runPy(["scripts/requirement_ledger.py"], "requirement_ledger");
  assert(ok, `有要求条款没有处置（未登记理由）:\n        ${out.slice(-900)}`);
  const m = out.match(
    /合计：要求条款 (\d+) · 已覆盖 (\d+) · 附录逐条 (\d+) · 已引原文 (\d+) · 同章别处 (\d+) · 不适用 (\d+) · 真缺口 (\d+)/,
  );
  assert(m, `requirement_ledger 没有给出统计行:\n        ${out.slice(-400)}`);
  const [req, cov, listed, quoted, weak, na, gaps] = m.slice(1).map(Number);
  assert(
    req === cov + listed + quoted + weak + na + gaps,
    `六档合计 ${cov + listed + quoted + weak + na + gaps} ≠ 要求条款 ${req} —— 账目不闭合`,
  );
  assert(gaps === 0, `还有 ${gaps} 条要求条款报告里一条都没说（应逐条列出原文）`);
  // 「同章别处」= 弱覆盖。59 条真弱覆盖已逐条登记进 E.5.1，
  // 这一档必须降到 0 —— 剩下任何一条都是「报告没讲、也没列出原文」的真缺口。
  assert(
    weak === 0,
    `还有 ${weak} 条要求条款既没被引用、原文也不在报告里、也没登记进 E.5.1 —— ` +
      "这些是真缺口，必须逐条列出原文与页码",
  );
  // 「附录逐条」的那些必须逐条登记了理由。
  //
  // 用 `<=` 而不是 `===`：登记在 `requirement-gaps.json` 里的条款，
  // 一旦它的**编号出现在报告里**（第 12 章矩阵、附录 G 的明细、章内引文），
  // 台账就把它改判成「已覆盖」—— 它已经被报告讲了，不必再靠 E.5.1 兜底。
  // 反过来（`listed > registered`）才是问题：有条款被列进了 E.5.1 却没有理由。
  const gapsFile = JSON.parse(read("data/requirement-gaps.json"));
  const registered = (gapsFile.gaps ?? []).filter((g) => String(g.reason ?? "").trim()).length;
  assert(
    listed <= registered,
    `「附录逐条」${listed} 条，比登记了理由的 ${registered} 条还多 —— 有条款被列进 E.5.1 却没有理由`,
  );
  return `${req} 条要求条款全部有处置（已覆盖 ${cov} · 附录逐条 ${listed} · 已引原文 ${quoted} · 同章别处 ${weak} · 不适用 ${na} · 真缺口 ${gaps}）`;
});

check("every clause claimed as '已引原文' really is in the delivered report", () => {
  // 台账有一档「已引原文」：说这一条的原文**在报告里**（随长摘录带入），
  // 只是报告没按它的编号索引。这是个**对客户的承诺** —— 客户按号回查要能查到。
  //
  // 复核逻辑**只有一份实现**（scripts/requirement_ledger.py --verify-quoted）：
  // 以前这道闸门用 JS 重写了一遍归一化，标点处理与 python 不一致，
  // 11 条「已引原文」在闸门里搜不到 —— 是**闸门自己的 bug**。
  // 一个只会误报的检查比没有检查更糟：读者会学会忽略整块面板。
  const { ok, out } = runPy(["scripts/requirement_ledger.py", "--verify-quoted"], "verify_quoted");
  assert(ok, `「已引原文」复核不通过:\n        ${out.slice(-900)}`);
  const m = out.match(/(\d+) 条逐条回报告搜过 · (\d+) 条搜不到/);
  assert(m, `requirement_ledger --verify-quoted 没有给出统计行:\n        ${out.slice(-400)}`);
  assert(Number(m[2]) === 0, `有 ${m[2]} 条「已引原文」在报告里搜不到`);
  return `${m[1]} 条「已引原文」逐条在交付件里搜到（≥24 字连续命中）`;
});

check("every requirement listed in the appendix is actually in the delivered report", () => {
  // 台账说「这 23 条在附录 E.5.1 逐条列出了原文」—— 报告里就得真的有。
  // 台账说谎而报告不知情，比没有台账更坏。
  const ledger = JSON.parse(read("data/requirement-ledger.json"));
  const listed = (ledger.rows ?? []).filter((r) => r.disposition === "附录逐条");
  const rep = JSON.parse(read("reports/last-report.json"));
  const md = (rep.appendices ?? []).map((a) => a.markdown ?? "").join("\n");
  const missing = [];
  for (const r of listed) {
    const key = `| ${r.clause} |`;
    if (!md.includes(`| ${r.clause} |`)) {
      missing.push(`${r.version} §${r.clause}`);
    }
  }
  assert(
    missing.length === 0,
    `台账标成「附录逐条」的 ${missing.length} 条在交付件里找不到:\n        ${missing.join("\n        ")}`,
  );
  return `${listed.length} 条定性要求在附录 E.5.1 逐条列出（条款号 + 原文 + 页码）`;
});

check("the requirement ledger is not stale", () => {
  // 矩阵加了行、条款索引变了、登记改了，台账必须跟着重算 ——
  // 否则附录 E.5 印着的是旧数。
  const { ok, out } = runPy(["scripts/requirement_ledger.py", "--check"], "requirement_ledger_check");
  assert(ok, `要求台账已过期:\n        ${out.slice(-600)}`);
  return (out.match(/要求台账与现算一致：.*/) ?? ["一致"])[0].trim();
});

check("the completeness layer is version-agnostic", () => {
  // **完整性保证本身不许写死版本键。**
  // 覆盖审计 / 条款索引 / 核验层如果写着 ("A", "B", "C")，
  // 换一套标准时它的条款一条都不会进账 —— 而报告照样写「真缺口 0」。
  // 这与 ⑲ 的事故同构：⑲ 是 A 第 4 章的位图条款号让整章隐形，
  // 这次是版本键写死。**「看不见」伪装成「没有缺口」**，是同一个错。
  const files = ["scripts/coverage_audit.py", "scripts/clause_split.py", "verify_claims.py"];
  const hits = [];
  for (const f of files) {
    const src = read(f);
    if (/\(\s*["']A["']\s*,\s*["']B["']\s*,\s*["']C["']\s*\)/.test(src)) hits.push(`${f}（版本元组写死）`);
    if (/labels\s*=\s*\[\s*["']A["']\s*,\s*["']B["']\s*,\s*["']C["']/.test(src)) hits.push(`${f}（labels 写死）`);
  }
  assert(
    hits.length === 0,
    `这些文件把版本清单写死了，换一套标准时它们的要求不会进账:\n        ${hits.join("\n        ")}`,
  );
  // 认不出来的 PDF 必须被报出来，不能静默丢弃
  const cs = read("scripts/clause_split.py");
  assert(
    cs.includes("UNMATCHED_DOCS"),
    "scripts/clause_split.py 没有报出「认不出版本的 PDF」—— 它的要求会静默地不进覆盖审计",
  );
  return "版本清单从语料推导；认不出来的 PDF 会大声报";
});

check("the renderer derives its version list from the corpus", () => {
  // 渲染层曾经把版本写死成 A/B/C：横向对照表只认三列（多一版就整张退回
  // 普通表格）、卡片栅格是 repeat(3, 1fr)、DOC_META 只有三项
  // （未知版本 → undefined → 卡片崩）。
  const src = read("server/reports/htmlRenderV8.ts");
  const fn = src.match(/export async function renderPdfFromReportV8[\s\S]*?\n}/);
  assert(fn, "renderPdfFromReportV8 not found");
  assert(
    fn[0].includes("setActiveVersions("),
    "渲染入口没有把语料的版本清单传进去 —— 换一套标准时对照表会悄悄丢掉新版本",
  );
  assert(
    src.includes("repeat(var(--trip-cols"),
    "卡片栅格仍然写死三列 —— 第四版会被挤成三列",
  );
  return "渲染层的版本列数跟着语料走";
});

check("the diff value cleaner never changes a number", () => {
  // 清洗器改的是**报告里的数字**。它一旦判错，「1s~1.5s」会被改成
  // 「1s~1.5」（数值被改小），而这种错**不会报错** —— 只会安静地
  // 改掉法规结论。所以清洗规则必须有已知答案的用例。
  const { ok, out } = runPy(["scripts/test_diff_corrections.py"], "test_diff_corrections");
  assert(ok, `差值清洗自测没过:\n        ${out.slice(-900)}`);
  const m = out.match(/(\d+) 条用例/);
  assert(m, `test_diff_corrections 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 条用例：数字一个没动、重复单位都清掉了、区间写法没被误伤`;
});

check("the diff evidence model rejects corrections the source does not support", () => {
  // 取证模型（数字 → 逐字 → 锚点）守的是第 11 章的取值。
  // 只测「好的更正能过」是不够的 —— 一个从不报错的检查器等于没有检查器
  // （这正是 ㉒ 一致性自查页 53 项误报的教训）。所以这里必须**逐条挡住**
  // 已知答案的反例：改一个词的定性取值、抄错的单位、指错的条款与页码。
  const { ok, out } = runPy(["scripts/test_diff_evidence.py"], "test_diff_evidence");
  assert(ok, `取证模型自测没过:\n        ${out.slice(-900)}`);
  const m = out.match(/(\d+) 条反例 \+ (\d+) 条正例/);
  assert(m, `test_diff_evidence 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 条反例全被挡住、${m[2]} 条正例全被放行`;
});

check("every manual finding is named in the executive summary", () => {
  // 执行摘要里「人工对照补录」那一串以前是**手写的**：
  // 新增一条 manual finding，摘要照旧只列九条 —— 而那句话正是
  // 报告的头号结论（几项参数有实质变化）。漏一条 = 少数据，且没人会发现。
  // 现在清单由每条 finding 的 brief 生成，闸门只查「brief 在不在、列没列」。
  const mf = JSON.parse(read("data/manual-findings.json"));
  const noBrief = mf.findings.filter((f) => !String(f.brief ?? "").trim());
  assert(
    noBrief.length === 0,
    `manual findings without a brief: ${noBrief.map((f) => `${f.topic}·${f.name}`).join(", ")}`,
  );
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const notListed = mf.findings.filter((f) => !md.includes(String(f.brief).trim()));
  assert(
    notListed.length === 0,
    `manual findings missing from the report: ${notListed.map((f) => f.brief).join(", ")}`,
  );
  return `${mf.findings.length} findings, each named in the summary`;
});

console.log("\n=== 5. renderer unit harness ===");
for (const t of [
  "_test_math.mjs",
  "_test_impact.mjs",
  "_test_table.mjs",
  "_test_gap_guard.mjs",
  "_test_versions.mjs",
  // 一致性自查器的**合成用例**（它的 53 项误报只有这样才抓得住）
  "_test_consistency.mjs",
  // 泛化用例：两版 / 四版 / 改名的版本键
  "_test_gen.mjs",
  // 取证工具的回归用例：**不调模型**（用已知答案断言具体页码），
  // 但它是 agent 唯一的证据来源 —— 工具回源错了，agent 就会把错的东西当事实讲出去
  "_test_agent_tools.mjs",
  // 变化清单的已知答案用例（classify 是本轮新增的判定）
  "_test_change_ledger.mjs",
  // 取值规格提议 agent 的**确定性**用例：候选层 / 校验层 / 解析层。
  // **不调模型**（假模型）—— 真模型的泛化率由
  // scripts/run_spec_agent_regression.mjs 单独测，记账在
  // reports/spec-agent-baseline.json。
  "_test_spec_agent.mjs",
]) {
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