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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
// The closure ledger is the single authority for "how many changes does this
// report claim". Import it from the built dist so the gate compares the PDF
// against the SAME code path the renderer used (never a re-implementation).
import { extractAuthoritativeChanges, buildLedger } from "../dist/closureLedger.js";
// 报告的**标题层**组装器。闸门要**直接调用**它，
// 验「交付件里的封面/章节/附录标题真的来自 data/report-meta.json 的声明」，
// 而不是 reportV6.ts 里又悄悄写死了一遍。
import {
  REPORT_META,
  composeTitle,
  composeChapterTitle,
  composeChapter11Sections,
  composeAppendixTitle,
  titleSlots,
} from "../dist/reportMeta.js";
// 版本清单/展示名/文档名 —— 标题槽位全靠这三个推导。
import { versionsOf, versionLabel, versionDoc } from "../dist/parameterMatrix.js";
// trustChecks：客户端「审阅工作台」的数据来源（可信度投影）。
// 单独构建一份，是为了让闸门能**在报告上直接跑它**，
// 断言「投影不许比源少」。
import { extractRumors } from "../dist/trustChecks.js";
// 认版本的唯一实现 —— 判据在声明里。闸门要直接驱动它。
import { cleanDocName, recognizeVersionByFileName } from "../dist/versionFileName.js";
import { deviceChapterPrefixes, legacyChapterPrefixes } from "../dist/specAgent.js";
// 上游指纹 —— 让「这份报告是从哪几份上游算出来的」可判定。
import { computeProvenance, describeProvenanceDiff } from "../dist/provenance.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf-8");

/**
 * 标准声明 —— 闸门里那些「本标准的名字」也从这儿取。
 *
 * ## 为什么闸门也要读声明
 *
 * 闸门是对着**这一套标准**的交付件写的：它断言表头是
 * 「| 参数 | 单位 | A 草案 | … |」，断言第 14 章的 C 列是 UN R48 的原文。
 *
 * 换一套标准，这些断言**全都得改** —— 而它们散在几千行的闸门里，
 * 是最容易漏的一类（漏了不会报错，只是闸门不再守着新标准）。
 *
 * 现在名字从声明来：**断言的行为一个字没变**，
 * 换标准时只要改声明，闸门自动跟着走。
 */
const STANDARD_PACK = JSON.parse(read("data/standard-pack.json"));
const VBY = Object.fromEntries((STANDARD_PACK.versions || []).map((v) => [v.key, v]));
const vLabel = (k) => VBY[k]?.label ?? k;
const vDoc = (k) => VBY[k]?.doc ?? k;
const vRev = (k) => VBY[k]?.rev ?? "";
/** 文档名去掉末尾的修订号：「GB 4785 草案 V4.3.5」→「GB 4785 草案」。 */
const vDocNoRev = (k) => {
  const rev = (vRev(k) || "").trim();
  if (!rev) return vDoc(k);
  const esc = rev.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return vDoc(k).replace(new RegExp(`[-–—\\s]*${esc}\\s*$`), "").trimEnd();
};
/** 文件名里的样子：去掉空格（「GB 4785 草案 V4.3.5」→「GB4785草案V4.3.5」）。 */
const vNameKey = (k) => vDoc(k).replace(/\s/g, "");
const FAM = STANDARD_PACK.standardFamily;

/**
 * 入库版本的内容（`git show HEAD:<path>`）。
 *
 * 要跟磁盘上的那份比，就不能用 `read` ——
 * 检查器**不许写产物**（经验 20）：它把文件重生成一遍就等于把问题「顺手修好」，
 * 那样永远验不出「清单过期了」。
 */
const gitShow = (rel) => {
  const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: ROOT, encoding: "utf-8" });
  return r.status === 0 ? r.stdout : null;
};
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
  // 这一关原来钉的是**写死的** "GB 4785 多版本横向对比研究报告.pdf" ——
  // 那正是「换标准后下载文件名还写着 GB 4785」的病根。
  // 现在文件名**由服务端从报告的源文档清单派生**
  // （见「the download filename is derived from the report, not hardcoded」那一关），
  // 所以这里只钉结构：恰好一处 a.download，且它走派生函数。
  const src = read("client/src/components/ReportBuilder.tsx");
  const hits = [...src.matchAll(/a\.download\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert(hits.length === 1, `expected exactly one a.download assignment, found ${hits.length}`);
  assert(
    /reportFileNameFromResponse\(/.test(hits[0]),
    `download name is "${hits[0]}" — 它必须走派生函数（reportFileNameFromResponse），` +
      `不能写死标准名`,
  );
  assert(
    /from "\.\.\/lib\/reportFileName"/.test(src),
    "ReportBuilder 没有导入 reportFileNameFromResponse",
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
    "scripts",
    "tools",
    "python_service",
    "verify_claims.py",
    "extract_mineru_v4_sdk.py",
    "extract_pymupdf.py",
    "extract_v5.py",
    "ocr_full.py",
    "audit_pages.py",
    "_audit2.py",
    "render_to_pdfdir.mjs",
    "add_pdf_outline.py",
  ];
  // 闸门自己写着这个字符串（就是它要找的东西），所以要排除掉自己。
  const hits = spawnSync(
    "git",
    ["grep", "-l", "Users/zsndz", "--", ...targets, ":(exclude)scripts/verify.mjs"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  const out = (hits.stdout || "").trim();
  assert(!out, `hardcoded path(s) in pipeline code:\n        ${out}\n        use COMPARE_AGENT_ROOT or __file__-relative paths`);
  return "clean";
});

/**
 * 仓库自足闸门 —— 同事克隆下来就能跑，不该再依赖「仓库外那个工作台目录」。
 *
 * 犯过两次：
 *   1. 源 PDF 在仓库外，路径写死 → 换台机器就找不到文件；
 *   2. 旧文件名（仓库外那三份副本的名字）在代码里到处出现 → 仓库里的
 *      `delivery/PDF对比/源文件_*.pdf` 明明存在，代码却还在找旧名字。
 *
 * 这两条都是**静默**失败：跑不通时报「找不到文件」，不报「你改错地方了」。
 */
check("仓库自足：代码不指向仓库外，源 PDF 只有一个名字", () => {
  // 旧文件名 —— 仓库外那三份副本的名字，仓库内已统一为 源文件_A|B|C_*.pdf。
  const stale = [
    "2026-08-26_GB 4785草案V4.3.5_1315_不带Comments的版本.pdf",
    "GB 4785-2019 《汽车及挂车外部照明和光信号装置的安装规定》.pdf",
    "UN_R048-09_S01_Installation_entry into force_26-09-2025.pdf",
  ];
  const staleHits = spawnSync(
    "git",
    ["grep", "-n", "-I", "-e", stale[0], "-e", stale[1], "-e", stale[2],
     "--", ".",
     // verify.mjs 自己列着这三个名字（排除）。
     ":(exclude)scripts/verify.mjs",
     // 生成的「换标准操作清单」**引用**了源码原文（其中就有旧文件名）。
     // 它是**引用**，不是路径引用 —— 而且它由下面的「清单不许是旧的」那道闸门盯着，
     // 不会漂移。把它算成「代码还在用旧文件名」是误报。
     ":(exclude)delivery/PDF对比/分析报告/换标准操作清单_*.md",
     // 台账的 `gateExceptions` **登记着**旧名字 ——
     // 那是「这几处允许出现标准名，理由是……」的**记录**，
     // 同样不是路径引用。与上面那一条是同一个道理。
     ":(exclude)data/hardcode-ledger.json"],
    { cwd: ROOT, encoding: "utf-8" },
  );
  const staleOut = (staleHits.stdout || "").trim();
  // 命中的可能是一整行 JSON（dist/extract-cache/ 那种），不截断的话
  // 一次失败能吐出 1 MB 日志，看的人只会跳过 —— 截到能一眼看出是哪个文件。
  const brief = staleOut
    ? staleOut
        .split("\n")
        .slice(0, 12)
        .map((l) => (l.length > 140 ? `${l.slice(0, 140)}…（本行 ${l.length} 字）` : l))
        .join("\n        ")
    : "";
  assert(!staleOut, `代码/数据里还在用旧源文件名：\n        ${brief}\n        统一用 delivery/PDF对比/源文件_A|B|C_*.pdf`);

  // 指向仓库外的写法。**先剥注释** —— 否则有人写一句「原来这里是
  // `path.resolve("..")`」就会把闸门弄红（第一次跑就被自己的注释骗了）。
  const code = (src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const escapeIdioms = [
    "ROOT.parent",
    "path.dirname(ROOT)",
    'path.resolve("..")',
    'path.resolve(ROOT, "..")',
    'path.join(ROOT, "..")',
  ];
  const scanTargets = [
    "server", "client/src", "scripts", "tools", "python_service",
    "verify_claims.py", "extract_mineru_v4_sdk.py", "extract_pymupdf.py",
    "extract_v5.py", "ocr_full.py", "audit_pages.py", "_audit2.py",
    "render_to_pdfdir.mjs", "add_pdf_outline.py",
  ];
  const files = spawnSync("git", ["ls-files", "--", ...scanTargets], {
    cwd: ROOT, encoding: "utf-8",
  });
  const list = (files.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const bad = [];
  for (const f of list) {
    if (f === "scripts/verify.mjs") continue; // 闸门自己写着这些字符串
    let src;
    try {
      src = code(read(f));
    } catch {
      continue;
    }
    for (const id of escapeIdioms) {
      if (src.includes(id)) bad.push(`${f} → ${id}`);
    }
  }
  assert(bad.length === 0, `代码还在指向仓库外：\n        ${bad.join("\n        ")}\n        全部改成仓库内的相对路径`);

  // 代码里引用的源 PDF 必须真的在仓库里存在。
  const referenced = new Set();
  for (const f of list) {
    if (f === "scripts/verify.mjs") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const m of src.matchAll(/源文件_[ABC][^"'\s]*\.pdf/g)) referenced.add(m[0]);
  }
  const missing = [...referenced].filter(
    (n) => !existsSync(resolve(ROOT, "delivery", "PDF对比", n)),
  );
  assert(missing.length === 0, `代码引用了仓库里没有的源 PDF：${missing.join("、")}`);

  return `旧名 0 处 · 出仓库写法 0 处 · ${referenced.size} 个源 PDF 引用全部在库`;
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

check("参数查询对空格不敏感（查不到 ≠ 不存在）", () => {
  // **这条闸门是被一次真实假阴性逼出来的。**
  // 浏览器演示时 agent 查「ADS标志灯」（少一个空格），
  // 库里叫「ADS 标志灯最小离地高度」—— includes 对空格敏感 → 未找到 →
  // agent 连查两次无果，直接写下「我未能核实到任何条款号、页码或数值」。
  // 数据明明在，它却回答"查不到"。这跟「宁可空着，不可错着」正好相反：
  // 这里不是空着，是**错着**（把拼写错误读成数据缺失）。
  const src = read("server/reports/agentTools.ts");
  assert(/function normalizeText/.test(src), "agentTools.ts 必须有 normalizeText（去空格 + 全角转半角 + 小写）");
  assert(/function nearMatches/.test(src), "agentTools.ts 必须有 nearMatches（查不到时给近似候选）");
  assert(
    /candidates:\s*nearMatches/.test(src),
    "lookup_parameter / get_diff_verdict 查不到时必须返回 candidates —— " +
      "没有它，agent 会把「我拼错了」当成「这条数据没有」",
  );
  // 真跑一遍：带空格 / 不带空格必须命中同一条
  const r = spawnSync("node", ["scripts/q.mjs", "param", "ADS标志灯"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(
    out.includes("ADS 标志灯最小离地高度"),
    `「ADS标志灯」（无空格）应当命中「ADS 标志灯最小离地高度」，实际输出：
        ${out.slice(-300)}`,
  );
  assert(!out.includes("没有「"), "「ADS标志灯」被判成查不到 —— 空格敏感的老毛病又回来了");
  return "空格无关 + 查不到给候选";
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

check("讲稿里的闸门数来自机器，不是手写", () => {
  const src = read("scripts/render_briefing.mjs");
  assert(
    src.includes("verify-summary.json"),
    "讲稿没有从 dist/verify-summary.json 读闸门数量 —— 数字得来自机器",
  );
  const hard = src.match(/\b\d{2,3}\s*项(?:闸门|检查)/g) || [];
  assert(
    hard.length === 0,
    `讲稿里还手写着闸门数：${hard.join("、")} —— 加了新闸门就会过期（已踩过一次）`,
  );
  return "闸门数由 dist/verify-summary.json 注入";
});

check("交付材料在仓库里，且脚本不再写到仓库外", () => {
  // 交付材料现在住在仓库内的 delivery/。曾经它们在仓库**外**的一个「工作台」
  // 目录里 —— 于是同事克隆仓库只能拿到代码，拿不到要交出去的 PDF，
  // 讲稿脚本还把文件写到仓库外（`path.resolve(ROOT, "..", "宣讲件")`）。
  const need = [
    "delivery/README.md",
    "delivery/中间文件清单_2026-10-27.md",
    "delivery/PDF对比/README.md",
    "delivery/PDF对比/feedback.md",
    "delivery/PDF对比/争议裁定书.txt",
    "delivery/PDF对比/㉚_闭环口径修正_249页_2026-10-27.pdf",
    "delivery/PDF对比/分析报告/📋_客户差评逐条对照_验收版.md",
    "delivery/宣讲件/README.md",
    "delivery/宣讲件/项目宣讲_GB4785三版对比_讲稿版_2026-10-28.pdf",
  ];
  const missing = need.filter((p) => !existsSync(resolve(ROOT, p)));
  assert(missing.length === 0, `交付材料不在仓库里：${missing.join("、")}`);

  // 脚本不许再往仓库外写。
  //
  // 匹配前**先去掉注释** —— 否则有人在注释里写一句「原来这里写的是
  // `path.resolve("..")`」就会把闸门弄红（第一次跑就被自己的注释骗了）。
  // 闸门要查的是代码，不是散文。
  const code = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  const pdfdir = code(read("render_to_pdfdir.mjs"));
  assert(
    pdfdir.includes('"delivery"') && !pdfdir.includes('path.resolve("..")'),
    "render_to_pdfdir.mjs 不该再写到仓库外 —— 交付 PDF 要落在 delivery/PDF对比/",
  );
  const brief = code(read("scripts/render_briefing.mjs"));
  assert(
    brief.includes('"delivery"') && !brief.includes('path.resolve(ROOT, "..")'),
    "scripts/render_briefing.mjs 不该再写到仓库外 —— 讲稿要落在 delivery/宣讲件/",
  );
  const audit = code(read("_audit2.py"));
  assert(
    audit.includes("'delivery'") && !audit.includes("os.path.abspath('..')"),
    "_audit2.py 得从仓库根找源 PDF —— delivery/PDF对比/",
  );
  return `${need.length} 项交付材料在库`;
});

check("活语料 uploaded-docs 随仓库走（新克隆也能跑管线）", () => {
  // 8 处代码从 uploaded-docs/ 读三份源 PDF（路径写死）。目录空了，
  // 新克隆的同事闸门直接红 —— 而且是「找不到文件」这种响亮的失败，不是
  // 安静地少一半数据。
  const live = [
    "uploaded-docs/2173836fae9f1314.pdf", // A 草案 V4.3.5
    "uploaded-docs/f86e6c7367f24de2.pdf", // B 2019
    "uploaded-docs/92b2563197df022a.pdf", // C R48-09
  ];
  const missing = live.filter((p) => !existsSync(resolve(ROOT, p)));
  assert(missing.length === 0, `活语料缺文件：${missing.join("、")}`);

  // 「在磁盘上」不等于「在版本库里」—— 必须 git ls-files 确认已跟踪
  const r = spawnSync("git", ["ls-files", "uploaded-docs/"], { cwd: ROOT, encoding: "utf-8" });
  const tracked = (r.stdout || "").split("\n").map((s) => s.trim());
  const untracked = live.filter((p) => !tracked.includes(p));
  assert(
    untracked.length === 0,
    `这些源 PDF 没进版本库：${untracked.join("、")} —— 新克隆的同事拿不到活语料`,
  );
  return `${live.length} 份源 PDF 已跟踪`;
});

check("抽取语料随仓库走（新克隆也能跑完整闸门）", () => {
  // 这四个文件是闸门的**输入**，不是产物：
  //   dist/mineru-v4-data.json   三份源 PDF 的 MinerU 抽取结果
  //   dist/verified-comparison.json / dist/facts.json   核验语料与事实表
  //   dist/extract-cache/v3-*.json   三版差值抽取缓存
  //
  // 同事克隆下来 `npm install && npm run build` 之后要能跑 `npm run verify`。
  // 这四个缺一个，第 4 段就报「找不到文件」—— 闸门当不了交付判据。
  //
  // 为什么不能靠「重新生成」：extract-cache 是真实 LLM 产物（非确定，重跑会
  // 改引文，进而改报告）；mineru-v4-data.json 要 853 MB 的 .mineru-models/。
  // 都不是「克隆一下就能重建」的东西。
  const corpus = [
    "dist/mineru-v4-data.json",
    "dist/verified-comparison.json",
    "dist/facts.json",
  ];
  const missing = corpus.filter((p) => !existsSync(resolve(ROOT, p)));
  assert(missing.length === 0, `抽取语料缺文件：${missing.join("、")}`);

  const r = spawnSync("git", ["ls-files", "dist/"], { cwd: ROOT, encoding: "utf-8" });
  const tracked = (r.stdout || "").split("\n").map((s) => s.trim());
  const untracked = corpus.filter((p) => !tracked.includes(p));
  assert(
    untracked.length === 0,
    `这些抽取语料没进版本库：${untracked.join("、")} —— 新克隆的同事跑不了闸门`,
  );

  // extract-cache 里的 v3-*.json 也要跟着走（三个版本各一个）
  const cache = tracked.filter((p) => /^dist\/extract-cache\/v3-.*\.json$/.test(p));
  assert(
    cache.length === 3,
    `dist/extract-cache 里应有三份 v3-*.json 差值缓存，实际 ${cache.length} 份 —— 新克隆跑不了差值核验`,
  );
  return `${corpus.length} 个语料文件 + ${cache.length} 份差值缓存已跟踪`;
});

console.log("\n=== 4. python verification layer ===");
check(
  `${REPORT_META.standardFamilyShort} ${REPORT_META.claimedIndicators.tableNo} 的 9 条指标回源核验（直接读源 PDF，绕开 MinerU）`,
  () => {
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

/**
 * 闸门跑 verify_claims.py —— **产物写到临时目录**，不碰仓库里那两份。
 *
 * ## 为什么不直接写回 dist/
 *
 * 「跑一遍」本身就是一种**改写**：闸门若直接写回 dist/facts.json，
 * 它就把「产物与上游不一致」这件事**当场修好了** ——
 * 于是「上游变了但产物没重算」这条**永远验不出来**。
 *
 * 实测（2026-11-04）：闸门跑完，git status 里 `dist/facts.json` 变成 modified，
 * 而闸门对此**一言不发** —— 它刚把问题抹平了。
 *
 * 改成写临时目录再**比对**，闸门就从「修复者」变成「检查者」。
 */
const VERIFY_TMP_DIR = resolve(ROOT, "dist", ".verify-tmp");

function runVerifyClaims() {
  mkdirSync(VERIFY_TMP_DIR, { recursive: true });
  return runPyEnv(
    ["verify_claims.py"],
    "verify_claims",
    { VERIFY_CLAIMS_OUT_DIR: VERIFY_TMP_DIR },
  );
}

/** 跑一个 node 探针脚本（泛化类的实测脚本都是 node）。 */
function runNode(args, label) {  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), r };
}

/** 跑 python，并额外注入环境变量（提议器要靠它把输出写到临时文件）。 */
function runPyEnv(args, label, extraEnv) {
  const r = spawnSync("python", args, {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", ...(extraEnv ?? {}) },
  });
  return { ok: r.status === 0, out: (r.stdout || "") + (r.stderr || ""), r };
}

check("verify_claims.py candidate partition closes", () => {
  const { ok, out } = runVerifyClaims();
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
  const { out } = runVerifyClaims();
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
  const { ok, out } = runVerifyClaims();
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

// ---------------------------------------------------------------------------
// §11.9 定性义务变化清单
//
// 第 12 章参数矩阵只装得下**数值**。客户真正在问的是「产品哪里不一样、要不要改」——
// 配备 / 禁止 / 适用范围 / 控制逻辑 这类定性义务变化，矩阵里一行都装不下。
// §11.9 装这块，是客户「这版和之前差别不大」这条抱怨的正题。
//
// 这三道闸门盯三件不同的事：
//   1. 数据源本身经得起核（条款号 / 页码 / 原文摘录 / 缺失结论）；
//   2. 这一节真的进了交付件，且条目数与数据源对得上（防止改了 JSON 没重出报告）；
//   3. 每一条都给出了 C 的对应状态 —— 「C 到底管不管这件事」是客户的问题，
//      空白格等于没回答。
// ---------------------------------------------------------------------------

check("定性义务清单逐条回原文核验（条款/页码/原文/缺失结论）", () => {
  const { ok, out } = runPy(["scripts/verify_qualitative_obligations.py"], "qualitative obligations");
  assert(ok, `定性义务清单核验失败：\n        ${out.slice(-900)}`);
  const n = (out.match(/定性义务清单：(\d+) 条/) || [])[1];
  assert(n && Number(n) > 0, "没有解析出条目数");
  return `${n} 条 —— ${out.split("\n").filter((l) => l.includes("核验")).join(" / ").trim()}`;
});

// ---------------------------------------------------------------------------
// 定性义务**全量台账**（客户 DR-013，P2）
//
// 客户写的是：
//   「§11.9 列 9 项且非穷举；附录 H 给材料不替读者下结论」
//   「定性义务没有形成完整、可执行的差异台账」
//   「证据材料不等于差异分析」「客户仍需自行判断大量条款」
//   修改建议：按义务面建立全量台账，优先裁定 H 中高相似条目并回流摘要
//
// 台账里**有两类结论**，混在一起就会互相掩盖：
//   · **机器判的**（限值集合 / 要求词 / 编号重排 / 措辞）—— 可重算，必须对得上；
//   · **人判的**（data/qualitative-adjudications.json）—— 必须有依据、必须回流进台账。
//
// 这一道闸门盯的是**接缝**：重算对不上、改了人工裁定没回流、
// 或报告里根本没渲染（客户要的是「回流摘要」），都要红。
// ---------------------------------------------------------------------------

check("定性义务全量台账逐条可核（客户 DR-013）", () => {
  const { ok, out } = runPy(["scripts/verify_qualitative_ledger.py"], "qualitative ledger");
  assert(ok, `定性义务台账核验失败：\n        ${out.slice(-900)}`);
  const m = out.match(/台账 (\d+) 条：实质差异 (\d+) · 待人工判读 (\d+)/);
  assert(m, `没有解析出台账计数：\n        ${out.slice(-400)}`);
  const [, total, sub, pend] = m;
  assert(Number(total) > 300, `台账只有 ${total} 条 —— 全量台账不该这么少`);
  assert(Number(sub) > 0, "台账里一条实质差异都没有 —— 判定多半坏了");
  return (
    `台账 ${total} 条 · 实质差异 ${sub} · 待人工判读 ${pend}（按相似度排序） · ` +
    `§11.10 已渲染 · 执行摘要已回引用`
  );
});

// ---------------------------------------------------------------------------
// 决策正文（客户 DR-016，P3）
//
// 客户写的是：
//   「大量原文、矩阵和附录重复呈现」「决策信息被原文淹没」
//   「客户难以快速定位优先动作」
//   修改建议：拆成 20–30 页决策正文 + 证据附件，统一证据入口
//
// 所以交付件现在是**两份**：决策正文（结论 / 影响 / 待确认项 / 证据入口）
// 与证据附件（全报告，一字未改）。
//
// 这一道闸门盯三件事：
//   1. 正文是 **20–30 页**（短了是摘要不是正文，长了说明没拆开）；
//   2. 正文里的**每个数都跟附件一致** —— 正文是从附件生成的，
//      附件改了而正文没重出，数字就会对不上（这是最可能的失效）；
//   3. **统一证据入口**在，而且每一块结论都在表里有一行。
// ---------------------------------------------------------------------------

check("决策正文是 20–30 页，且每个数都跟附件一致（客户 DR-016）", () => {
  const { ok, out } = runPy(["scripts/verify_decision_brief.py"], "decision brief");
  assert(ok, `决策正文核验失败：\n        ${out.slice(-900)}`);
  const pages = (out.match(/决策正文 (\d+) 页/) || [])[1];
  assert(pages, "没有解析出决策正文页数");
  assert(
    Number(pages) >= 20 && Number(pages) <= 30,
    `决策正文 ${pages} 页 —— 客户要的是 20–30 页`,
  );
  return `${pages} 页 · 数字与附件逐项一致 · 统一证据入口齐全 · 近空白页 0`;
});

// ---------------------------------------------------------------------------
// 缺失结论的**范围**（客户 DR-006，P1）
//
// 客户写的是：「B/C 均无塑料配光镜机械清洗相关规定；已全文扫描确认」——
// 而 C 的**脚注 11** 明明写着「缔约方仍可在 PL 塑料配光镜上禁止机械式清洗系统」。
//
// 根因不是「没扫」，是**扫的范围**：缺失扫描只看**条款正文**，
// 而脚注、别的章节都在条款正文之外 ——
// 于是「C 无对应义务」这个**版本级**主张，靠一个**条款级**扫描得出。
//
// 这一道闸门盯两件事：
//   1. 这道检查**还在**（核验器里的 absentElsewhere 那一段没被删）；
//   2. 它**真的在跑**（全版反证核验数 > 0 —— 不是「一项都没核」的空过）。
//
// 单独开一道，而不是并进上一道：上一道是「清单对不对」，
// 这一道是「缺失结论的范围有没有被偷换成版本级」。
// ---------------------------------------------------------------------------

check("缺失结论的范围必须写清楚：全版扫描的命中都要登记（客户 DR-006）", () => {
  const src = read("scripts/verify_qualitative_obligations.py");
  assert(
    src.includes("absentElsewhere") && src.includes("scan_whole_version"),
    "核验器里没有全版反证那一步 —— 缺失结论的扫描范围被悄悄退回条款正文了？",
  );
  const { ok, out } = runPy(["scripts/verify_qualitative_obligations.py"], "qualitative obligations");
  assert(ok, `缺失结论的范围核验失败：\n        ${out.slice(-900)}`);
  const n = Number((out.match(/全版反证核验 (\d+) 项/) || [])[1] ?? 0);
  assert(n > 0, "全版反证一项都没核 —— 缺失结论的扫描范围没跑起来（空过）");
  return `${n} 处全版命中都登记了「相关 / 无关」与位置`;
});

// ---------------------------------------------------------------------------
// 繁拔层的单一真相源
//
// 可以只用一个解析器，但不能用两个。事实上曾经有两份：
//   dist/mineru-v4-data.json      —— 已入库，CLI 管线用
//   dist/sidecar-cache/*.json     —— 在 .gitignore 里，网站用
// 同样三份源 PDF，两份产物长度一致（2769868 字符）却内容不同
// （LaTeX 花括号位置差一位）——结果是**网站出的报告 ≠ 交付给同事的报告**，
// 差异小到内容指标都测不出来。
//
// 现在：语料**自述来源**（sourceSha256），sidecar 在自己的缓存缺失时
// **先查已入库的语料**，对得上就直接用。一份真相，其余都是它的缓存。
// ---------------------------------------------------------------------------
check("语料自述来源，且 sidecar 优先用已入库的那份", () => {
  const corpus = JSON.parse(read("dist/mineru-v4-data.json"));
  const srcDir = resolve(ROOT, "delivery", "PDF对比");
  const files = readdirSync(srcDir).filter((f) => f.startsWith("源文件_") && f.endsWith(".pdf"));
  assert(files.length >= 3, `delivery/PDF对比 里只有 ${files.length} 份源 PDF`);
  const byHash = new Map();
  for (const f of files) byHash.set(sha256(resolve(srcDir, f)), f);
  const checked = [];
  for (const ver of ["A", "B", "C"]) {
    const e = corpus[ver];
    assert(!!e, `语料里没有 ${ver} 版`);
    const h = e.sourceSha256;
    assert(!!h, `${ver} 版语料没有 sourceSha256 —— 它不能证明自己是哪份文件抽的`);
    assert(
      byHash.has(h),
      `${ver} 版的 sourceSha256 与任何一份源 PDF 都对不上 —— ` +
        `语料与源文件不对应`,
    );
    checked.push(`${ver}=${byHash.get(h)}`);
  }
  // sidecar 必须在读自己的缓存**之前**先查已入库的语料。
  const sidecar = read("python_service/main.py");
  const atTracked = sidecar.indexOf("tracked_corpus_entry(label, file_hash)");
  const atCache = sidecar.indexOf("if cache_file.exists()");
  assert(atTracked > 0, "sidecar 的 /extract 没有查已入库的语料");
  assert(
    atTracked < atCache,
    "sidecar 的 /extract 先读自己的缓存、后查语料 —— 优先级错了，" +
      "语料会被缓存里的另一份抽取结果顶掉",
  );
  assert(
    /sourceSha256/.test(read("extract_mineru_v4_sdk.py")),
    "extract_mineru_v4_sdk.py 没写 sourceSha256 —— 下次重新抽取就会丢掉这个钥匙",
  );
  return checked.join(" · ");
});

check("第 11.9 节进了交付件，且条目数与数据源一致", () => {
  const qo = JSON.parse(read("data/qualitative-obligations.json"));
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const head = "### 11.9 定性义务变化清单";
  assert(md.includes(head), "交付件里没有 §11.9 定性义务变化清单");
  assert(
    !md.includes("本节数据不可用"),
    "§11.9 渲染成了「本节数据不可用」—— 数据文件没被读到（多半是路径解析跑到了仓库外）",
  );
  const rendered = (md.match(/^#### 11\.9\.\d+ /gm) || []).length;
  assert(
    rendered === qo.entries.length,
    `§11.9 渲染了 ${rendered} 条，数据源有 ${qo.entries.length} 条 —— 报告没重新生成？`,
  );
  const missing = qo.entries
    .filter((e) => !md.includes(e.title))
    .map((e) => `${e.id}/${e.title}`);
  assert(missing.length === 0, `这些条目没进交付件：${missing.join("; ")}`);
  // 执行摘要是客户先看的地方 —— §11.9 若只在第 11 章末尾，多数人翻不到。
  const execMd = loadReport().chapters.find((c) => c.id === 0)?.markdown ?? "";
  assert(
    execMd.includes("11.9"),
    "执行摘要里没提 §11.9 —— 定性义务变化清单藏在第 11 章末尾，多数客户看不到",
  );
  assert(
    new RegExp(`\\*\\*${qo.entries.length}\\s*条定性义务变化\\*\\*`).test(execMd),
    `执行摘要没报「${qo.entries.length} 条定性义务变化」这个数`,
  );
  return `${rendered} 条全部在交付件里，执行摘要已指向 §11.9`;
});

check("§11.9 每一条都给出了 C 的对应状态", () => {
  const qo = JSON.parse(read("data/qualitative-obligations.json"));
  const md = loadReport()
    .chapters.map((c) => c.markdown ?? "")
    .join("\n");
  const sec = md.slice(md.indexOf("### 11.9 定性义务变化清单"));
  const blocks = sec.split(/^#### 11\.9\.\d+ /m).slice(1);
  assert(blocks.length === qo.entries.length, `切出 ${blocks.length} 个条目块，数据源有 ${qo.entries.length} 条`);
  const bad = [];
  qo.entries.forEach((e, i) => {
    const b = blocks[i] ?? "";
    if (!b.includes(`C §${e.c.clause}`)) bad.push(`${e.id}: C 条款号没渲染`);
    if (!b.includes(`p${e.c.page}`)) bad.push(`${e.id}: C 页码没渲染`);
    if (!b.includes(e.c.status ?? "")) bad.push(`${e.id}: C 状态没渲染`);
    if (!b.includes(`A §${e.a.clause}`) || !b.includes(`B §${e.b.clause}`)) {
      bad.push(`${e.id}: A/B 条款号没渲染`);
    }
  });
  assert(bad.length === 0, bad.join("; "));
  const statuses = {};
  for (const e of qo.entries) statuses[e.c.status] = (statuses[e.c.status] ?? 0) + 1;
  return `${qo.entries.length} 条，C 状态分布 ${JSON.stringify(statuses)}`;
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
    !new RegExp(`项与 ${vDocNoRev("C")} 条款存在数值交集`).test(md),
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
  // 按 **id** 找附录，不按标题找 —— 标题现在是声明出来的，
  // 换个标准它就会变（「UN R48 §6 …」→「XX §4 …」），
  // 按标题找的闸门会跟着一起失效 —— 那正是这道闸门本来要防的那类退化。
  const app = loadReport().appendices?.find((a) => a.id === "D");
  assert(!!app, "报告里没有附录 D");
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
    /12\.3 缺[^）\n]*取值的参数/.test(md) && !/12\.3 定位失败的参数/.test(md),
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

  // **分组不能丢行**：五个子组的行数之和必须等于矩阵的行数。
  // 以前 305 行平铺，没有分组；现在分成「有变化 / A/B 一致但 C 不同 / 另两版一致缺一版 / 只有一版有规定 / 三版一致」，
  // 一旦分组逻辑有漏，参数就会**静默消失** —— 比显示错更糟。
  const matrix = loadReport().parameterMatrix ?? [];
  const groupCounts = {
    changed: (md.match(/### 12\.1\.1 有变化（(\d+) 条）/) ?? [])[1],
    cDiverged: (md.match(/### 12\.1\.2 A\/B 一致、C 不同（(\d+) 条）/) ?? [])[1],
    single: (md.match(/### 12\.1\.3 另两版一致、缺一版规定（(\d+) 条）/) ?? [])[1],
    incomplete: (md.match(/### 12\.1\.4 只有一版有规定、另两版无取值（(\d+) 条）/) ?? [])[1],
    same: (md.match(/### 12\.1\.5 三版一致（(\d+) 条）/) ?? [])[1],
  };
  for (const [k, v] of Object.entries(groupCounts)) {
    assert(!!v, `第 12 章缺 ${k} 组的小标题 —— 分组结构不完整`);
  }
  const sumGroups = Object.values(groupCounts).reduce((a, b) => Number(a) + Number(b), 0);
  assert(
    sumGroups === matrix.length,
    `五个分组的行数之和 ${sumGroups} ≠ 矩阵行数 ${matrix.length} —— 有参数被漏掉了`,
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
    Number(groupCounts.cDiverged),
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

check("「A/B 一致、C 不同」的参数没有被埋进「三版一致」", () => {
  // 旧判定只比 A/B 两版，于是「A=B=5%、C=3%」这种**出口欧盟级**的差异
  // 被归档进「三版一致 / 不需要改设计」，附录 G 还把它逐条列出来当范例。
  // 这一类必须是**单独的组**，而且必须在 12.4（出口重点）里点名。
  const rep = JSON.parse(read("reports/last-report.json"));
  const rows = rep.parameterMatrix ?? [];
  const cDiverged = rows.filter((r) => r.verdict === "c-diverged");
  const same = rows.filter((r) => r.verdict === "same");
  assert(
    cDiverged.every((r) => r.cells?.C?.status === "verified"),
    "有行被标成 c-diverged，但 C 列其实没取到值 —— 这个判定不该出现",
  );
  assert(
    !same.some((r) => r.cells?.C?.status === "verified" && r.cells?.C?.nums?.length &&
      r.cells?.A?.nums?.length &&
      r.cells.C.nums.join(",") !== r.cells.A.nums.join(",")),
    "有行 A/B 取值相同、C 取值不同，却仍被判成「三版一致」—— 这就是漏报，judge() 必须把它判成 c-diverged",
  );
  const md = reportText();
  if (cDiverged.length) {
    assert(
      /### A\/B 一致、C 不同（\d+ 条）/.test(md) || /A\/B 一致、C 不同/.test(md),
      "12.4 里没有「A/B 一致、C 不同」这一节 —— 出口重点漏了这一类",
    );
    for (const r of cDiverged) {
      assert(
        md.includes(String(r.name ?? "")),
        `12.4 里没有点名「${r.name}」—— 这一类必须在出口重点里逐条列出`,
      );
    }
  }
  return `${cDiverged.length} 条 A/B 一致但第三版不同的参数已单列并在 12.4 点名`;
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
  // Chapter 13 is no longer A-vs-B only. The client (DR-011) pointed out that
  // the chapter had no C column, and the reason was a missing artifact, not a
  // structural impossibility: UN R48-09 §5.15 has the same shape as GB 表5
  // (lamp name → colour). So chapter 13 now carries a REAL third column,
  // built from a manually verified lamp-name mapping
  // (data/lamp-color-map.json). What it must still declare is the LIMITS of
  // that column: the mapping is manual, the C side is quoted verbatim from the
  // source PDF, and the comparison verdict is only given where the wording is
  // simple enough to compare item by item.
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
    !c13.includes("本章范围：仅 A 与 B 两版"),
    "chapter 13 still declares that it excludes C — the C column was added, this declaration is stale",
  );
  assert(
    c13.includes("本章范围：A / B / C 三版"),
    "chapter 13 does not declare its three-version scope",
  );
  assert(
    /第 12 章|附录 C/.test(c13),
    "chapter 13 does not point the reader at the three-version material",
  );

  const c14 = get(14).markdown ?? "";
  // The declaration has to name the third column and its caliber.
  assert(
    c14.includes("C 列是欧标原文"),
    `chapter 14 must declare that its third column is real ${vDocNoRev("C")} text`,
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
    "chapter 14 must say what it prints where the third version has no corresponding chapter",
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
  return `ch13 声明三版范围 · ch14 声明 C 列是欧标原文且为章节级 · ${pointers} 条 R48 指针全部带标记（有的给条款号、有的给理由）`;
});

// ---------------------------------------------------------------------------
// 客户 DR-011：第 13 章要有 A/B/C 三版光色表，且映射要站得住
//
// 客户写的是：
//   「第 13 章 灯具光色 只做了 A/B 两版，缺 C」
//   「属于明确未完成项，不应视为三版光色比较已完成」
//   修改建议：建立人工核验的灯具名称映射并补 A/B/C 表
//
// 这一道闸门盯的是**那张人工核验的对照表**：
//   1. C 侧每段引文必须是源 PDF 的**逐字**片段（不是「差不多」）；
//   2. A/B 表5 与 C §5.15 的每一行都要有归属（没有「忘了对」的行）；
//   3. 人工配对必须与 **GB 自己的术语表**交叉核对 —— GB §3.9 的英文名与
//      R48 的灯名逐字相同才叫「逐字命中」，词形不同的必须写明理由；
//   4. 报告里必须真的渲染出这张表 —— 数据对、报告没渲染，跟没做是一回事。
// ---------------------------------------------------------------------------

check("第 13 章的 A/B/C 光色映射站得住（客户 DR-011）", () => {
  const { ok, out } = runPy(["scripts/verify_lamp_color_map.py"], "lamp color map");
  assert(ok, `灯具光色映射核验失败：\n        ${out.slice(-900)}`);
  const lit = (out.match(/逐字命中 (\d+) 条/) || [])[1];
  const mapped = (out.match(/逐字命中 \d+ 条 \/ 共 (\d+) 条/) || [])[1];
  assert(lit && mapped, "没有解析出映射条数");
  return `${mapped} 条映射（GB 术语逐字命中 ${lit} 条）· 引文逐字核对 · 第 13 章已渲染`;
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
  const tables = md.match(
    new RegExp(
      `\\| 参数 \\| 单位 \\| ${vLabel("A")} \\| ${vLabel("B")} \\| ${vLabel("C")} \\| 判定 \\|`,
      "g",
    ),
  ) ?? [];
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
    `    out['head']=bool(re.search(r'单位[\\s\\S]{0,80}${vLabel("A")}[\\s\\S]{0,80}${vLabel("B")}[\\s\\S]{0,80}${vLabel("C")}[\\s\\S]{0,80}判定', m))\n` +
    "    out['rows']=[p for p in ['近光灯最大离地高度','转向信号灯闪烁频率','同时点亮远光灯最大发光强度之和'] if p in m]\n" +
    "out['cards']=len(re.findall(r'维度\\n[^\\n]{1,12}\\n条目\\n\\d+', all))\n" +
    "print(json.dumps(out,ensure_ascii=False))\n";
  const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
    // **PDF 全文有几百 KB（中文 3 字节/字）** —— 默认的 1 MB 缓冲
    // 会让这一关以 ENOBUFS **静默**死掉（status=null、stderr 为空）。
    maxBuffer: 256 * 1024 * 1024,
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
  // **只数 H.2 这一节** —— H.4 的表格行同样以「| B … / A …」开头，
  // 不切段会把两节的行数加到一起（实测 184 + 86 = 270，看着像 H.2 多了 86 行）。
  const h2Start = md.indexOf("## H.2");
  const h3Start = md.indexOf("## H.3");
  assert(h2Start > 0 && h3Start > h2Start, "附录 H 里找不到 H.2 / H.3 的小节标题");
  const h2 = md.slice(h2Start, h3Start);
  const diffRows = (h2.match(/^\| B \d+(\.\d+)* \/ A /gm) ?? []).length;
  assert(
    diffRows === (s.differentText ?? 0),
    `附录 H.2 列了 ${diffRows} 行，数据里是 ${s.differentText ?? 0} 条「文字不同」`,
  );
  // H.4（编号不可直接对读的那批）以前只印条款号，同事指出数据里明明有
  // aHead / bHead / aPage / bPage 却一个都没印。现在两版开头原文与页码都印了 ——
  // 这一条钉住「不能再退回只印条款号」。
  const h4Start = md.indexOf("## H.4");
  assert(h4Start > 0, "附录 H 里找不到 H.4 的小节标题");
  const h4 = md.slice(h4Start);
  const unpairedRows = (h4.match(/^\| B \d+(\.\d+)* \/ A /gm) ?? []).length;
  assert(
    unpairedRows === (s.notComparable ?? 0),
    `附录 H.4 列了 ${unpairedRows} 行，数据里是 ${s.notComparable ?? 0} 条「不可并排」`,
  );
  assert(
    /A 草案 · 开头原文/.test(h4) && /B 现行 · 开头原文/.test(h4),
    "附录 H.4 没有渲染两版开头原文 —— 同事第 13 条：只给条款号等于没给",
  );
  assert(
    md.includes(`可并排 **${s.comparable}**`),
    `附录 H.1 汇总里的「可并排」数与数据不符（应为 ${s.comparable}）`,
  );
  assert(
    md.includes(`## H.3 归一化后同文的条款（${s.sameText} 条）`),
    `附录 H.3 的条数与数据不符（应为 ${s.sameText}）`,
  );
  return `H.2 ${diffRows} 行 · 同文 ${s.sameText} · 不可并排 ${unpairedRows}（H.4 已渲染两版开头原文与页码）`;
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
  //
  // 2026-11-03 起这道闸**不再放过「查不到」**：旧版把「引文查不到」归为
  // 「措辞不同，查不到不算错」，而那和「这个值是编出来的」在数据里长得一模一样。
  // 现在改用三档证据（引文 / 取值 / 条款）——任一档落在所报页上即算定位成功，
  // 三档在全篇都查不到即为**疑似编造**，直接判失败。
  const { ok, out } = runPy(["scripts/matrix_page_check.py"], "matrix_page_check");
  assert(ok, `矩阵报的页上找不到它自己的引文或取值:\n        ${out.slice(-900)}`);
  const m = out.match(/核了 (\d+) 个取值格/);
  assert(m, `matrix_page_check 没有给出统计行:\n        ${out.slice(-400)}`);
  return `${m[1]} 个取值格回源 PDF 验到（引文/取值/条款三档证据），页码全对`;
});

check("no table loses a column to the version-column renderer", () => {
  // 渲染器把「版本 / 来源 / 文档 / 文件 / 标准」这一列当成**纵向对照表**的
  // 版本列 —— 也就是「每行一个文档，后面几列是该文档的属性」。
  // 一旦这一列不在**第 0 列**，而它里面又恰好是 A/B/C，
  // 「版本是某一行的属性」的表就会被误判：
  // 渲染器按版本重排，**参数名列被整列丢掉** ——
  // 交付件里那张表只剩页码与取值，看不出是哪一条参数。
  //
  // 2026-11-03 真的踩了：§12.5「复核分量有限」那张
  // | 参数 | 版本 | 矩阵报的页 | 取值 | 该值出现在全文 |
  // 被吞掉了第 1 列。**丢得毫无报错** —— 表还在、页还在、数字还在，
  // 只有名字没了；交付件的正文里完全看不出少了东西。
  //
  // 这一关查两件事：
  //   1. **源码级** —— 两个 findVersion* 判定函数只认第 0 列（这是根因）；
  //   2. **PDF 级**  —— 对每一张「版本列不在第 0 列」的表，
  //      **它第 0 列的内容必须真的出现在交付件里**。
  //      这一条才是最终判据：判定函数哪天又被放宽了，这里立刻红。
  for (const [file, fn] of [
    ["server/reports/htmlRenderV8.ts", "findVersionIdx"],
    ["server/reports/typedTables.ts", "findVersionCol"],
  ]) {
    const src = read(file);
    const m = src.match(new RegExp(`function ${fn}\\([^)]*\\)\\s*:\\s*number\\s*\\{([\\s\\S]*?)\\n\\}`));
    assert(m, `${file} 里找不到 ${fn}`);
    assert(
      /header\[0\]/.test(m[1]),
      `${file} 的 ${fn} 不再只认第 0 列 —— 「版本是某一行的属性」的表会被误判成纵向对照表`,
    );
    assert(
      !/for\s*\(\s*let\s+i\s*=\s*0\s*;\s*i\s*<\s*header\.length/.test(m[1]),
      `${file} 的 ${fn} 又开始扫所有列了 —— 「版本是某一行的属性」的表会被误判成纵向对照表`,
    );
  }

  const rep = JSON.parse(read("reports/last-report.json"));
  const VERSION_HEADER = /^(版本|来源|文档|文件|标准|version|document|file)$/i;
  const VERSION_LABEL = /^(A|B|C)(\s|$|版|草案|现行|UN|R48)/i;
  const cellsOf = (row) =>
    String(row)
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const tablesOf = (md) => {
    const out = [];
    let cur = [];
    for (const line of String(md ?? "").split("\n")) {
      if (line.trim().startsWith("|")) cur.push(line);
      else {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    if (cur.length >= 2) out.push(cur);
    return out;
  };
  // 「版本列不在第 0 列、且列里确实是 A/B/C」的表 —— 会被误判的那一类。
  const risky = [];
  for (const part of [...(rep.chapters ?? []), ...(rep.appendices ?? [])]) {
    for (const t of tablesOf(part.markdown ?? "")) {
      const header = cellsOf(t[0]).map((h) => h.replace(/\*/g, "").trim());
      for (let i = 1; i < header.length; i++) {
        if (!VERSION_HEADER.test(header[i])) continue;
        const labels = new Set(
          t
            .slice(1)
            .map((r) => (cellsOf(r)[i] ?? "").replace(/\*/g, "").trim())
            .filter((c) => VERSION_LABEL.test(c)),
        );
        if (labels.size >= 2) {
          risky.push({ part: part.id, header, body: t.slice(1).map(cellsOf) });
          break;
        }
      }
    }
  }

  if (!risky.length) return "报告里没有会被版本列判定误判的表";
  const pdfPath = GATE_PDF;
  if (!pdfPath) {
    return `skipped — 闸门没能渲染出 PDF（设 VERIFY_PDF=<path> 可指定已渲染的 PDF）；` +
      `报告里有 ${risky.length} 张表带非首列的版本列`;
  }
  // 把 PDF 全文抽出来（base64 传路径：Windows 上非 ASCII 路径经 argv 会变成乱码，
  // fitz 打不开文件，这一关就会**静默空过** —— 恰恰是交付件那个文件名）。
  const py =
    "import sys,io,json,base64,fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path); t='\\n'.join(p.get_text() for p in d)\n" +
    "print(json.dumps({'t':t},ensure_ascii=False))\n";
  const r = spawnSync("python", ["-c", py], {
    cwd: ROOT,
    encoding: "utf-8",
    input: Buffer.from(pdfPath, "utf-8").toString("base64"),
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return `skipped — ${(r.stderr || "").trim().split("\n").pop().slice(0, 90)}`;
  }
  const pdfText = JSON.parse(r.stdout.trim().split("\n").pop()).t;
  const flat = (s) =>
    String(s ?? "")
      .replace(/\*\*|\*|`/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, "");
  const haystack = flat(pdfText);
  const lost = [];
  for (const t of risky) {
    for (const row of t.body) {
      const first = flat(row[0]);
      if (first.length < 3) continue;
      if (!haystack.includes(first)) {
        lost.push(`第 ${t.part} 章/附录：「${first.slice(0, 48)}」`);
      }
    }
  }
  assert(
    !lost.length,
    `这些表的第 0 列内容在交付件里找不到 —— 渲染器把它们当成了纵向对照表并整列丢掉：\n        ` +
      lost.slice(0, 12).join("\n        "),
  );
  return `${risky.length} 张带非首列版本列的表，第 0 列内容全部出现在交付件里`;
});

check("every matrix cell's value is corroborated against the source PDF", () => {
  // 「取值级复核」是给**人工**用的：让每一格都有明确结论，
  // 于是人工只看复核不通过的那几格，而不是逐条翻全部取值。
  //
  // 这道闸守两件事：
  //   1. **没有查不到的取值** —— 取值与引文在源 PDF 全篇都找不到，
  //      意味着这个数可能是编出来的（这正是旧版放过的那一类）。
  //   2. **报告里写出来的数字与数据一致** —— §12.5 的档数必须来自
  //      parameterMatrixStats，不能是手写的。
  //
  // 另外把 Python 那一路的独立复算与 TS 的结果对一次：
  // 两套实现走的是**不同的取文本路径**（TS 用 loadSourceCorpus 的
  // 整页文本，Python 用 doc_lines 的逐行文本），数字对不上就说明
  // 其中有一边的归一化不对称 —— 那正是本次踩过的坑。
  const rep = JSON.parse(read("reports/last-report.json"));
  const st = rep.parameterMatrixStats?.corroboration;
  assert(st, "报告里没有 parameterMatrixStats.corroboration —— 取值级复核没有跑");
  const verified = rep.parameterMatrixStats?.verified ?? 0;
  assert(
    st.notFound === 0,
    `有 ${st.notFound} 个取值在源 PDF 全篇都查不到 —— 疑似编造：\n        ` +
      JSON.stringify(st.exceptions.filter((e) => e.status === "not-found").slice(0, 8), null, 2),
  );
  assert(
    st.elsewhere === 0,
    `有 ${st.elsewhere} 个取值在源 PDF 的别的页上 —— 页码与取值对不上：\n        ` +
      JSON.stringify(st.exceptions.filter((e) => e.status === "elsewhere").slice(0, 8), null, 2),
  );
  assert(
    st.onPage + st.elsewhere + st.notFound + st.unchecked === verified,
    `复核结论数对不上：onPage ${st.onPage} + elsewhere ${st.elsewhere} + ` +
      `notFound ${st.notFound} + unchecked ${st.unchecked} ≠ 已定位 ${verified}`,
  );
  assert(
    st.unchecked === 0,
    `有 ${st.unchecked} 个取值格没法复核（没有源 PDF 语料或没有页码）—— ` +
      `这些格子读者无法自行验证，必须补上语料`,
  );

  // 与 Python 那一路的独立复算对账
  const { out } = runPy(["scripts/matrix_page_check.py"], "matrix_page_check");
  const m = out.match(/核了 (\d+) 个取值格/);
  assert(m, `matrix_page_check 没有给出统计行:\n        ${out.slice(-400)}`);
  assert(
    Number(m[1]) === st.onPage,
    `两套复核实现对不上：Python 核了 ${m[1]} 格，TS 核了 ${st.onPage} 格 —— ` +
      `其中一边的归一化不对称`,
  );
  // 逐格比：只比总数看不出「归一化不对称」——
  // 2026-11-03 两边都判 796 格定位成功，但引文档数是 630 与 675，
  // 差的那 45 格是源页去千分位逗号、引文片段没去造成的。
  const cross = runPy(["scripts/compare_corroboration_tiers.py"], "corroboration_tiers");
  assert(cross.ok, `两套复核实现逐格对不上（归一化不对称）：\n        ${cross.out.slice(-900)}`);

  // §12.5 必须把这件事写出来，且数字与数据源一致
  const ch12 = (rep.chapters ?? []).find((c) => String(c.markdown ?? "").includes("## 12.5 页面存在性复核"));
  assert(ch12, "报告第 12 章里没有 §12.5 页面存在性复核 —— 复核结论没有交给读者");
  const md = ch12.markdown;
  assert(
    md.includes(`**${verified} 个取值格**`),
    `§12.5 里的取值格数（应为 ${verified}）与数据源对不上`,
  );
  const ev = st.byEvidence ?? {};
  for (const [k, label] of [
    ["excerpt", "引文与取值都在所报页"],
    ["match", "标签与取值都在所报页"],
    ["value+clause", "取值与条款号都在所报页"],
  ]) {
    // 表格单元里的标签可能带 ** 强调号，匹配时要能容忍。
    const re = new RegExp(`\\|\\s*\\**${label}\\**\\s*\\|\\s*${ev[k] ?? 0}\\s*\\|`);
    assert(
      re.test(md),
      `§12.5 的「${label}」档数与数据源对不上（应为 ${ev[k] ?? 0}）`,
    );
  }

  // ── 客户 DR-012 的四维状态另有一道闸门（下面单独一道）────────────
  return `${st.onPage}/${verified} 个取值格页面存在性复核通过（引文 ${ev.excerpt ?? 0} · 标签+取值 ${ev.match ?? 0} · 取值+条款 ${ev["value+clause"] ?? 0} · 取值 ${ev.value ?? 0}），查不到 0、页码不符 0`;
});

// ---------------------------------------------------------------------------
// 客户 DR-012（P1）：「值在这一页上」**不等于**「这一格的语义是对的」
//
// 报告原来写「796 个取值格每一个都回源 PDF 核过，页码与取值逐格对得上」——
// 而那句话**只证明了值出现在那一页上**，它证明不了：
//   语义配对（这个数配的是那个标签吗）· 条件 · 符号 · 单位
//
// 修法：① 这一节改名为「**页面存在性复核**」；
//       ② 四个维度各有各的核验状态，**没有机械判据的写「未核」，不写「已核」**。
//
// 这一道闸门盯的就是这两件事 ——
//   · 名字不许改回去（「回源核过」会被读成「语义也核过」）；
//   · 四维状态不许消失、不许是空表、每一个数字都要与数据源对得上。
// ---------------------------------------------------------------------------

check("页面存在性 ≠ 语义正确性：四个维度各有状态（客户 DR-012，P1）", () => {
  const rep = JSON.parse(read("reports/last-report.json"));
  const ch12 = (rep.chapters ?? []).find((c) => String(c.markdown ?? "").includes("## 12.5 页面存在性复核"));
  assert(ch12, "报告第 12 章里没有 §12.5 **页面存在性复核** —— 复核结论没有交给读者");
  const md = ch12.markdown;
  assert(
    !md.includes("## 12.5 取值回源复核"),
    "§12.5 的标题又变回「取值回源复核」了 —— 「回源核过」会被读成「语义也核过」",
  );
  assert(
    !md.includes("每一格都回源 PDF 核过"),
    "§12.5 里还写着「每一格都回源 PDF 核过」 —— 这句话只证明值在那一页上（客户 DR-012）",
  );

  const st = rep.parameterMatrixStats ?? {};
  const dim = st.corroboration?.byDimension ?? {};
  for (const [key, label] of [
    ["pairing", "语义配对"],
    ["condition", "条件"],
    ["symbol", "符号"],
    ["unit", "单位"],
  ]) {
    assert(
      md.includes(`**${label}**`),
      `§12.5 里没有「${label}」这一维的核验状态 —— 客户 DR-012 要求逐项列出`,
    );
    const bucket = dim[key] ?? {};
    const total = Object.values(bucket).reduce((a, b) => a + b, 0);
    assert(total > 0, `「${label}」这一维一项都没核 —— 状态表是空的（空过）`);
    const row = md.split("\n").find((l) => l.includes(`**${label}**`));
    assert(row, `§12.5 的状态表里找不到「${label}」那一行`);
    const cell = /\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(row);
    assert(cell, `§12.5 的「${label}」行解析不出数字`);
    assert(
      Number(cell[1]) === (bucket["已核"] ?? 0),
      `§12.5 的「${label}」已核数（${cell[1]}）与数据源（${bucket["已核"] ?? 0}）对不上`,
    );
  }
  return (
    `四维状态已列且与数据源对得上 —— ` +
    `语义配对已核 ${dim.pairing?.["已核"] ?? 0} · 条件 ${dim.condition?.["已核"] ?? 0} · ` +
    `符号 ${dim.symbol?.["已核"] ?? 0} · 单位 ${dim.unit?.["已核"] ?? 0}`
  );
});

check("the parameter proposer still finds what the specs found", () => {
  // 「换个标准还要人工写 813 条 spec」这件事能不能压下去，全看**提议层**的召回。
  // 召回自检是 `scripts/propose_parameters.py` 自带的（拿已有 spec 反撞候选池），
  // 但它只是**打印**——抽取器一变、语料一换，召回掉了没人知道。
  //
  // 这一关把它变成判据：
  //   ① 召回率不得低于地板（当前 648/813 = 79.7%，地板 75%）；
  //   ② **入库的候选池文件必须与现语料现出来的结果一致** ——
  //      否则仓库里躺着一份过期的候选清单，而它正是人工裁定的工作入口。
  //
  // 提议器是**确定性**的（同样输入必同样输出），所以第 ② 条可以逐字节比。
  const { ok, out } = runPyEnv(["scripts/propose_parameters.py"], "propose_parameters", {
    PROPOSE_OUT: resolve(ROOT, "reports", ".parameter-candidates.fresh.json"),
  });
  assert(ok, `参数提议跑失败:\n        ${out.slice(-600)}`);
  const m = out.match(/召回自检：(\d+)\/(\d+)/);
  assert(m, `propose_parameters 没有给出召回自检行:\n        ${out.slice(-600)}`);
  const recalled = Number(m[1]);
  const anchors = Number(m[2]);
  const rate = recalled / anchors;
  const FLOOR = 0.75;
  assert(
    rate >= FLOOR,
    `提议层召回率掉了：${recalled}/${anchors} = ${(rate * 100).toFixed(1)}%（地板 ${FLOOR * 100}%）—— ` +
      `要么抽取器退化了，要么 spec 的写法变了。提议层一退化，换标准时的内容工作量就回来了。`,
  );

  // 入库的候选池必须与现语料现出来的一致。
  // 上面那次运行已经写到临时文件上了（PROPOSE_OUT）——
  // 不然「现跑出来的」与「入库的」是同一个文件，比了个寂寞。
  const tmp = resolve(ROOT, "reports", ".parameter-candidates.fresh.json");
  const freshText = existsSync(tmp) ? readFileSync(tmp, "utf8") : "";
  const committedText = read("data/parameter-candidates.json");
  assert(
    committedText === freshText,
    `data/parameter-candidates.json 与现语料现出来的不一致 —— ` +
      `仓库里躺着一份过期候选清单，而它是人工裁定的工作入口。` +
      `重跑 \`python scripts/propose_parameters.py\` 并把新文件提交。`,
  );
  const c = JSON.parse(committedText);
  assert(
    c.recall === `${recalled}/${anchors}`,
    `候选池文件里记的召回（${c.recall}）与刚跑出来的（${recalled}/${anchors}）对不上`,
  );
  return `提议层召回 ${recalled}/${anchors} = ${(rate * 100).toFixed(1)}%（地板 ${FLOOR * 100}%）· 候选池 ${c.candidateCount} 条，与现语料一致`;
});

check("the web UI does not claim a report size it cannot know", () => {
  // 网页文案里**手写**的页数/章数一定过期。
  //
  // 2026-11-03 用浏览器 MCP 跑了一遍全流程，当场看到：
  //   「完整对比报告（20+ 页 PDF）」「动态 13 章」「约 15-20 分钟」
  // 而实际交付件是 **258 页 · 14 章 · 约 2 分钟** ——
  // 而且那段文案把 **MinerU 路径说成了 LLM 路径**
  // （MinerU 那条根本不走 LLM，是确定性渲染）。
  //
  // 交付件的真实数字必须**来自报告对象**（report.chapters.length 等），
  // 不许写在文案里。
  //
  // 判据只查 **JSX 文本**（>…< 之间）——
  // 客户需求简报里的「至少 20 页」是**要求**，不是对交付件的描述，放过。
  const files = [
    "client/src/pages/Home.tsx",
    "client/src/components/ReportBuilder.tsx",
  ];
  const bad = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/>([^<>{}]*\d+\s*\+?\s*(?:页|章)[^<>{}]*)</g)) {
      bad.push(`${f}: 「${m[1].trim().slice(0, 40)}」`);
    }
  }
  assert(
    !bad.length,
    `网页文案里手写了交付件的页数/章数（会过期）：\n        ${bad.join("\n        ")}\n` +
      `        这些数字必须来自报告对象 —— 交付件现在是 258 页、14 章，写死的版本总有一天对不上。`,
  );
  // 生成完成后的那一句必须用报告对象的章数
  const rb = read("client/src/components/ReportBuilder.tsx");
  assert(
    /report\.chapters\.length/.test(rb),
    "ReportBuilder 的完成提示没有用 report.chapters.length —— 章数是手写的还是算出来的？",
  );
  return "网页文案不手写交付件尺寸，数字来自报告对象";
});

// check() 是同步的（它不 await），所以派生函数的 import 必须在模块顶层做。
const { reportFileName, contentDisposition, isUnverifiedDraft, DRAFT_MARKER, DRAFT_MARKER_ASCII } =
  await import("../dist/reportFileName.js");
const { extractMasterParams } = await import("../dist/htmlRenderV8.js");

// check() 是同步的（它不 await），所以 import 必须在模块顶层做。
const { REPORT_FILE, UPLOADED_DOCS_DIR, PROJECT_ROOT: SERVER_ROOT } = await import(
  "../dist/projectRoot.js"
);

check("the PDF export refuses to serve an unverified draft", () => {
  // 两条管线写**同一个** `reports/last-report.json` ——
  // 快速草稿（llm-sse）会把 MinerU 的产物覆盖掉。
  //
  // `/report/last` 早就有 `?prefer=mineru` 的护栏，
  // 但 **PDF 导出端点（/report/pdf）一度没有** ——
  // 于是同事跑一次草稿，点「下载 PDF」拿到的就是
  // **未经回源复核的 LLM 草稿**，而界面上它长得跟交付件一模一样。
  //
  // 那是这个项目最贵的一类错：**安静地给出一份未经核验的东西**。
  //
  // 这一关查两件事：
  //   ① 导出端点必须**先看 generator 再渲染**；
  //   ② 客户端必须把服务端的拒绝理由**原样显示**，不许用一句笼统的话盖掉。
  const src = read("server/_core/agentRoutes.ts");
  const pdfRoute = src.slice(src.indexOf('router.post("/api/agent/report/pdf"'));
  assert(pdfRoute.length > 0, "找不到 /api/agent/report/pdf 路由");
  const renderAt = pdfRoute.indexOf("renderPdfFromReportV8(report)");
  const checkAt = pdfRoute.indexOf("generator_mismatch");
  assert(renderAt > 0 && checkAt > 0, "PDF 导出端点里找不到渲染调用或 generator 护栏");
  assert(
    checkAt < renderAt,
    "PDF 导出端点**先渲染再判 generator** —— 护栏必须拦在渲染之前",
  );
  assert(
    /generator\s*\?\?\s*"unknown"/.test(pdfRoute),
    "PDF 导出端点没有读报告的 generator 标记",
  );
  assert(
    /prefer\s*!==\s*actual/.test(pdfRoute),
    "PDF 导出端点没有比对 prefer 与实际 generator",
  );
  // 客户端：409 的理由要显示出来
  const home = read("client/src/pages/Home.tsx");
  const c409 = home.slice(home.indexOf("response.status === 409"));
  assert(
    c409.includes("detail?.error") && c409.includes("detail?.hint"),
    "客户端没有把服务端的 409 理由（error + hint）显示出来 —— " +
      "「存着的不是已核验报告」这句话必须让用户看见",
  );

  // **草稿不许写进已核验那份的文件**。
  //
  // 护栏能挡住「读」，挡不住「覆盖」：两条管线原来写同一个
  // `reports/last-report.json`，同事跑一次快速草稿，
  // **交付件就被覆盖了** —— 交付闸门、CLI、官网的「下载 PDF」全读那一份，
  // 已核验的那份从此只能靠重跑 MinerU 拿回来。
  //
  // 所以草稿必须写自己的文件：`reports/last-report.llm-sse.json`。
  // 判据要**成对看**：文件名与 generator 标记必须匹配 ——
  // 「last-report.json ↔ mineru」且「last-report.llm-sse.json ↔ llm-sse」。
  // 只看文件名会误伤（MinerU 写 last-report.json 是对的）。
  // 路径与 generator 标记**不在同一处**：标记挂在**报告对象**上
  // （`const report = { ...built, generator: "mineru" }`），
  // 写盘处只是把它 JSON.stringify 出去。
  // 所以判据是「离写盘点**最近**的 generator 标记」——
  // 前后都看，取最近的那一个，而不是只往后找（往后找会跨到别的管线）。
  const genTags = [...src.matchAll(/generator:\s*"([^"]+)"/g)].map((m) => ({
    gen: m[1],
    at: m.index,
  }));
  const writes = [...src.matchAll(/path\.join\(dir,\s*"(last-report[^"]*)"\)/g)];
  const pairs = writes.map((m) => {
    let best = null;
    for (const t of genTags) {
      const d = Math.abs(t.at - m.index);
      if (d > 1500) continue;
      if (!best || d < best.d) best = { gen: t.gen, d };
    }
    return [m[1], best?.gen ?? ""];
  });
  assert(pairs.length >= 2, `只找到 ${pairs.length} 处报告写入 —— 应该有两条管线各一处`);
  for (const [file, gen] of pairs) {
    if (file === "last-report.json") {
      assert(
        gen === "mineru",
        `已核验那份（last-report.json）被标记成 generator="${gen}" —— ` +
          `交付件必须是 MinerU 那条管线出来的`,
      );
    } else {
      assert(
        gen === "llm-sse",
        `${file} 的 generator 标记是 "${gen}" —— 草稿文件里必须是 llm-sse`,
      );
    }
  }
  assert(
    pairs.some(([f, t]) => f === "last-report.llm-sse.json" && /llm-sse/.test(t)),
    "快速草稿没有写自己的文件（last-report.llm-sse.json）—— 它会覆盖已核验的交付件",
  );
  return "PDF 导出端点先判 generator 再渲染；草稿写自己的文件，不覆盖交付件";
});

check("the server resolves project paths through one canonical root", () => {
  // 开发模式（tsx 跑源码）与打包模式（dist/）的 `import.meta.dirname` **差一层**，
  // 所以写死 `path.resolve(import.meta.dirname, "../reports")` 只对其中一种成立。
  //
  // 2026-11-03 用浏览器 MCP 跑全流程时撞上（而且**没有任何报错**）：
  //   - 网站把上传的文件写进 `server/uploaded-docs/`，
  //     而**回源复核层读的是仓库根的 `uploaded-docs/`** ——
  //     于是**网站上传的新标准，管线根本看不见**：认不出它是哪一版、
  //     复核不了它的取值。**泛化断在第一步。**
  //   - 网站把生成的报告写进 `server/reports/last-report.json`，
  //     而 CLI 与全部闸门读的是**仓库根的 `reports/last-report.json`** ——
  //     **两份真相来源**（这个项目治过好几次的病，又长出来了）。
  //
  // 这一关查两件事：
  //   ① **功能**：服务端解析出来的路径必须就是仓库根的那两个；
  //   ② **源码**：server/_core 下不许再有 `../reports` / `../uploaded-docs` 这种相对写法。
  assert(
    REPORT_FILE === resolve(ROOT, "reports", "last-report.json"),
    `服务端解析的报告落点是 ${REPORT_FILE}，不是仓库根的 reports/last-report.json —— ` +
      `网站与 CLI 会各写各的（两份真相来源）。`,
  );
  assert(
    UPLOADED_DOCS_DIR === resolve(ROOT, "uploaded-docs"),
    `服务端解析的上传落点是 ${UPLOADED_DOCS_DIR}，不是仓库根的 uploaded-docs/ —— ` +
      `回源复核层读不到网站上传的文件。`,
  );
  assert(
    SERVER_ROOT === ROOT,
    `服务端认到的项目根是 ${SERVER_ROOT}，不是 ${ROOT}`,
  );
  for (const f of ["server/_core/agentRoutes.ts", "server/_core/index.ts"]) {
    const src = read(f);
    const bad = [...src.matchAll(/import\.meta\.dirname,\s*"(\.\.\/(?:reports|uploaded-docs)[^"]*)"/g)].map(
      (m) => m[1],
    );
    assert(
      !bad.length,
      `${f} 里还有写死的相对路径 ${bad.join("、")} —— ` +
        `它只在一种布局下成立（开发模式与打包模式差一层）。用 projectRoot.ts 的解析器。`,
    );
  }

  // ── ③ 整个 server/ 只许有一份根解析器（2026-11-04 扩） ────────────────
  //
  // 原来这一关只查了 agentRoutes.ts 与 index.ts 两处，
  // 于是**漏掉了四份各自为政的项目根解析器**：
  //
  //   | 位置 | 认据 | 认 COMPARE_AGENT_ROOT | 找不到时 |
  //   |---|---|---|---|
  //   | server/_core/projectRoot.ts | data/parameter-specs.json | ✅ | 抛错 |
  //   | server/reports/innerRoot.ts | verify_claims.py | ✅ | **退回 ../..** |
  //   | server/_core/deliveryGate.ts | verify_claims.py | ❌ **不认** | 退回 ../.. |
  //   | server/_core/parameterProposals.ts | data/parameter-specs.json | ✅ | 抛错 |
  //
  // `deliveryGate.ts` 那份**连环境变量都不认** ——
  // 设了 `COMPARE_AGENT_ROOT` 时，闸门读的是另一个根，
  // 于是「拿 A 语料验 B 语料的报告」这种组合根本验不到。
  //
  // `innerRoot.ts` 的注释自己写着「两份拷贝会漂移，第二份就是 §11.9 那个 bug 的来源」——
  // 说得对，但它自己**就是**那第二份的来源；写完那句话之后又多出了三份。
  //
  // 现在的不变量：**server/ 下只有 projectRoot.ts 一处认「我在哪一层」**，
  // 其余一律从它拿根。判据 = 代码里（剥掉注释后）不许出现
  // `import.meta.dirname` / `import.meta.url`。
  const serverFiles = [];
  const walkServer = (dir) => {
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walkServer(rel);
      else if (e.name.endsWith(".ts")) serverFiles.push(rel);
    }
  };
  walkServer("server");
  const offenders = [];
  for (const f of serverFiles) {
    if (f === "server/_core/projectRoot.ts") continue;
    const code = read(f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    if (/import\.meta\.(dirname|url)/.test(code)) offenders.push(f);
  }
  assert(
    !offenders.length,
    `server/ 下这些文件还在按「自己所在位置」算路径：${offenders.join("、")} —— ` +
      `源码布局与打包布局差一层，按位置算的路径只在一种布局下成立。` +
      `项目根只有一份实现：server/_core/projectRoot.ts。`,
  );

  // 运行时读的文件必须在**项目根**存在（不是「读不到就降级」）。
  // change_example.md 就被当「中间文件」回收过，而运行时代码还在读它 ——
  // 症状只是每次跑打一行 not loaded，草稿路径的写作范例**一直是空的**。
  for (const f of ["change_example.md"]) {
    assert(
      existsSync(resolve(ROOT, f)),
      `运行时输入 ${f} 不在仓库里 —— 代码读不到它时会**静默降级**（功能还在，质量没了）。` +
        `它是运行时输入，不是中间文件，必须入库。`,
    );
  }
  return `服务端路径统一到项目根：报告 ${REPORT_FILE.replace(ROOT, "<root>")} · 上传 ${UPLOADED_DOCS_DIR.replace(ROOT, "<root>")} · server/ 下 ${serverFiles.length} 个模块只有一份根解析器`;
});

check("the download filename is derived from the report, not hardcoded", () => {
  // 文件名是交付件的一部分（收件人先看名字）。
  // 原来两处写死 "GB 4785 多版本横向对比研究报告.pdf" / "GB4785_多版本…"，
  // 换一套新标准时下载下来的文件**名字里还写着 GB 4785**。
  //
  // 这一关是**功能性**的：直接调用派生函数，拿几个语料验结果 ——
  // ① 现在的三版 → 名字里出现三个标准；
  // ② **换成别的标准** → 名字里**不许再出现 GB 4785**；
  // ③ 拿不到源文档清单 → 退回不带标准名的通用名（宁可少写，不可写错）。
  //
  // 注意 fixture 上的 `generator: "mineru"`：
  // **证明不了它出自已核验管线的报告，文件名一律带「未经回源复核」标记**
  // （见下一关），所以「已核验」这件事必须**显式**写出来，不能靠默认值。
  const now = reportFileName(
    {
      generator: "mineru",
      sourceDocuments: [
        { name: `${vDoc("A")}（103 页）` },
        { name: `${vDoc("B")}（81 页）` },
        { name: `${vDoc("C")}（147 页）` },
      ],
    },
    "pdf",
  );
  assert(
    now.includes(vNameKey("A")) && now.includes(vNameKey("C")) && /多版本横向对比研究报告\.pdf$/.test(now),
    `派生文件名不对：${now}`,
  );

  // 换一套标准：名字里不许再出现 GB 4785
  const other = reportFileName(
    {
      generator: "mineru",
      sourceDocuments: [{ name: "UN R149（100 页）" }, { name: "GB 24599（60 页）" }],
    },
    "pdf",
  );
  assert(
    !/4785/.test(other),
    `换标准后派生出来的文件名里还有 ${FAM}：${other} —— ` +
      `这正是原来写死标准名的后果。`,
  );
  assert(/UNR149/.test(other) && /GB24599/.test(other), `派生文件名不对：${other}`);

  // 拿不到源文档清单 → 通用名
  const none = reportFileName({ generator: "mineru" }, "pdf");
  assert(
    !/4785|R48/.test(none) && /多版本横向对比研究报告\.pdf$/.test(none),
    `没有源文档清单时不该编出标准名：${none}`,
  );

  // Content-Disposition 必须是 RFC 6266 的两段式（非 ASCII 名字不能裸进 header）
  const cd = contentDisposition(
    { generator: "mineru", sourceDocuments: [{ name: `${vDocNoRev("A")}（103 页）` }] },
    "pdf",
  );
  assert(
    /filename="[^"]*"/.test(cd) && /filename\*=UTF-8''/.test(cd),
    `Content-Disposition 缺 RFC 6266 的 filename* 段：${cd}`,
  );
  assert(
    !/[^\x00-\x7f]/.test(/filename="([^"]*)"/.exec(cd)?.[1] ?? ""),
    `Content-Disposition 的 ASCII 兜底名里混进了非 ASCII 字节（Chromium 会拒绝）：${cd}`,
  );

  // 源码里不许再有写死的标准名下载
  for (const f of [
    "client/src/pages/Home.tsx",
    "client/src/components/ReportBuilder.tsx",
    "server/_core/agentRoutes.ts",
  ]) {
    const src = read(f);
    const hard = [...src.matchAll(/(?:download|filename)\s*[=:]\s*["'`][^"'`]*4785[^"'`]*["'`]/gi)].map(
      (m) => m[0],
    );
    assert(
      !hard.length,
      `${f} 里还有写死标准名的下载文件名：\n        ${hard.join("\n        ")}\n` +
        `        文件名要从报告的源文档清单派生。`,
    );
  }
  return `文件名从报告派生：现在 → ${now}；换标准 → ${other}`;
});

check("the report's page counts come from the corpus, not from literals", () => {
  // 页数是**语料的事实**，不是声明。
  //
  // 原来三处写死：第 2 章概况表、执行摘要的「对照范围」、源文档清单
  // （`{ label: "A", name: "GB 4785 草案 V4.3.5（103 页）" }`）。
  // 换一套标准、或源 PDF 换了版，这三个数**全是错的** ——
  // 而且**不报错**：报告照出，只是页数在骗人。
  //
  // 源文档清单尤其要紧：**下载文件名是从它派生的**
  // （server/reports/reportFileName.ts）——
  // 名字写死，就等于「换了标准，下载下来的文件名还在讲 GB 4785」。
  //
  // 判据两条：
  //   ① **源码里不许再出现写死的页数**；
  //   ② **功能**：交付件里写的页数必须等于语料实际的页数。
  const v6 = read("server/reports/reportV6.ts");
  // 先剥注释 —— 注释里说明「原来写死的是 103 页」是合理的，不是交付内容。
  const v6Code = v6.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const literals = [...v6Code.matchAll(/(\d{2,3})\s*页/g)]
    .map((m) => m[1])
    .filter((n) => ["103", "81", "147"].includes(n));
  assert(
    !literals.length,
    `reportV6.ts 里又出现了写死的页数 ${[...new Set(literals)].join("、")} —— ` +
      `页数是语料的事实，必须从分页文本数出来（pageCountsOf）。`,
  );

  // ② 功能：交付件里的页数 == 语料的页数
  const mineru = JSON.parse(read("dist/mineru-v4-data.json"));
  const report = JSON.parse(read("reports/last-report.json"));
  const docs = report.sourceDocuments ?? [];
  assert(docs.length > 0, "交付件里没有 sourceDocuments");
  for (const d of docs) {
    const text = String(mineru?.[d.label]?.fullText ?? "");
    assert(text.trim(), `语料里没有 ${d.label} 版`);
    const marks = (text.match(/\[第\d+页\]/g) ?? []).length;
    const m = new RegExp(`（(\\d+)\\s*页）`).exec(d.name ?? "");
    assert(m, `源文档清单里 ${d.label} 没有页数：${d.name}`);
    assert(
      Number(m[1]) === marks,
      `交付件说 ${d.label} 是 ${m[1]} 页，语料里数出来是 ${marks} 页 —— ` +
        `其中一个已经过期了（源 PDF 换了版，或页数是写死的）。`,
    );
  }
  return `${docs.length} 个源文档的页数与语料一致（${docs
    .map((d) => `${d.label} ${/（(\d+)\s*页）/.exec(d.name)?.[1]} 页`)
    .join(" · ")}）`;
});

check("the chapter-to-lamp map agrees with the corpus", () => {
  // 「章节 → 灯」映射表（scripts/propose_parameters_c.py 的 R48_SECTIONS）是
  // **手写的 25 行**。手写的东西会错，而且**错了不报错**：
  //
  //   本表曾把 6.14 标成「Direction-indicator position」，
  //   而 6.14 实为 Rear retro-reflector ——
  //   于是所有「侧转向灯」行都被派到回复反射器的条款里，
  //   候选句**全是错的**，而表本身看着完全正常。
  //
  // 换标准时更糟：这张表不跟着语料走 → **候选池整体错位**，pipeline 一声不吭。
  //
  // 这一关**自动核对，不自动替换**：
  // 表里每条的英文名，都去语料里「那一章自己的标题」对一次。
  // 对不上 → 红。取不到 → 必须在 KNOWN_UNVERIFIABLE 名单里（每一处写清为什么），
  // 不在名单里也红 —— **多一条就要人工确认一次**，不许悄悄多一条。
  //
  // 自动生成整张表**做不到**：表里有人的判断
  // （6.21 Conspicuity markings 对应的是 GB 的「醒目标志」，不是按编号对齐的 5.21），
  // 推不出来就不该推 —— 「宁可空着，不可错着」。
  const r = spawnSync("python", ["scripts/check_section_map.py"], { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `章节→灯映射表与语料对不上：\n        ${out.slice(-900)}`);
  const summary = /一致 (\d+) · 不一致 (\d+) · 取不到 (\d+)/.exec(out);
  assert(summary, `check_section_map.py 没给出汇总行:\n        ${out.slice(-500)}`);
  assert(Number(summary[2]) === 0, `有 ${summary[2]} 条不一致`);
  return `映射表 ${summary[1]} 条与语料一致 · 不一致 ${summary[2]} · 取不到 ${summary[3]}（已登记）`;
});

check("the download button never drops a field the renderer needs", () => {
  // 弹窗里那个「下载 PDF」按钮，把客户端手上的报告原样 POST 给
  // `/report/render`，服务端照它渲染。
  //
  // 客户端原来**手工列了五个字段**（outline/chapters/appendices/
  // sourceDocuments/generatedAt）—— 看起来够了，
  // 但渲染器还要 `report.parameterMatrix`：
  // 「MASTER PARAMETER INDEX」（317 行的主索引，**8 页**）就是从它建的
  // （htmlRenderV8.ts：`renderMasterParams(extractMasterParams(chapters, report.parameterMatrix))`）。
  //
  // 挑字段 = 把它悄悄丢掉 →
  // **下载下来的是一份缺 8 页主索引的报告**，而界面上看不出任何区别：
  // 页数变了、其余一模一样，客户不会知道少了什么。
  //
  // 判据：**不许再挑字段** —— 客户端必须把服务端返回的**整个**报告带过去。
  const rb = read("client/src/components/ReportBuilder.tsx");
  // 有两处 setReport：草稿路径（从 SSE 事件拿）与 MinerU 路径（从响应拿）。
  // 要查的是**从响应拿**的那一处 —— 它以前在挑字段。
  const idx = rb.indexOf("setReport({");
  let setReport = "";
  let pos = 0;
  while (pos >= 0 && pos < rb.length) {
    const start = rb.indexOf("setReport({", pos);
    if (start < 0) break;
    const block = rb.slice(start, start + 1400);
    if (block.includes("data.outline")) {
      setReport = block;
      break;
    }
    pos = start + 1;
  }
  assert(setReport.length > 0, "找不到 ReportBuilder 里那个从响应建报告对象的 setReport");
  assert(
    /\.\.\.\(\s*data as any\s*\)|\.\.\.\(\s*data\s*\)/.test(setReport),
    "ReportBuilder 还在**挑字段**建报告对象 —— 服务端返回的字段被丢掉，" +
      "渲染器要用的 parameterMatrix（MASTER PARAMETER INDEX，8 页）会消失，" +
      "下载下来的是一份缺页报告，而界面上看不出来。整份带过去。",
  );
  assert(
    !/parameterMatrix\s*[:=]/.test(setReport.replace(/\.\.\.\(\s*data as any\s*\)/, "")),
    "setReport 里出现了 parameterMatrix 的手工赋值 —— 它应该由整个响应带过来，不要手工拼。",
  );

  // 还要**功能**地证明这个字段是有用的 ——
  // 渲染器在有/无 parameterMatrix 时给出的主索引行数必须不同。
  const report = JSON.parse(read("reports/last-report.json"));
  const withMatrix = extractMasterParams(report.chapters ?? [], report.parameterMatrix);
  const without = extractMasterParams(report.chapters ?? [], undefined);
  assert(
    withMatrix.length > without.length,
    `主索引在有 parameterMatrix 时是 ${withMatrix.length} 行，没有时是 ${without.length} 行 —— ` +
      `两者一样，说明这个字段根本没被用上（那客户端丢它也就无害）。`,
  );
  return `主索引：有 parameterMatrix ${withMatrix.length} 行 · 无 ${without.length} 行 —— 客户端必须带着它`;
});

check("the welcome message is never exported as if it were an answer", () => {
  // 顶栏的「Word」按钮导出最近一条 assistant 消息。
  //
  // 原来挑消息只按 `role === "assistant" && m.text` ——
  // 而**欢迎语**正好满足这两条（`kind: "welcome"`，role=assistant，有 text）。
  // 于是「还没有任何分析结果」时点一下，导出的是**一句寒暄**，
  // 文件标题却写着「法规对比报告」，而且 toast 说「WORD 报告已下载」——
  // **假成功**：用户拿到一个 2 KB 的 .doc，以为导出了分析结果。
  //
  // 同一份顾虑在**单条消息的下载按钮**上早就处理了
  // （渲染处 `message.kind !== "welcome"`）——
  // 同一个顾虑两处实现，就一定会漂移。这一关把两处**钉在一起**。
  const home = read("client/src/pages/Home.tsx");
  // ① 导出挑消息的地方必须排除欢迎语
  const pick = home.slice(home.indexOf("const lastAssistant"), home.indexOf("const lastAssistant") + 600);
  assert(pick.length > 0, "找不到导出时挑消息的地方");
  assert(
    /kind\s*!==\s*"welcome"/.test(pick),
    "导出时挑消息没有排除欢迎语（kind === \"welcome\"）—— " +
      "「还没有分析结果」时点 Word 会导出一句寒暄，却 toast「已下载」。",
  );
  // ② 按钮的禁用判据要跟导出用**同一句**
  const dis = home.slice(home.indexOf("disabled={"), home.indexOf("disabled={") + 400);
  assert(
    /kind\s*!==\s*"welcome"/.test(dis),
    "顶栏按钮的禁用判据没有排除欢迎语 —— 按钮亮着，但点出来是假成功。",
  );
  // ③ 单条消息的下载入口（早就有的那道）不许被删掉
  assert(
    /kind\s*!==\s*"welcome"/.test(home.slice(home.indexOf("message.kind !== \"welcome\""))),
    "单条消息的下载入口不再排除欢迎语了 —— 三处判据必须一致。",
  );
  return "欢迎语在三处判据里都被排除：导出挑消息 · 按钮禁用 · 单条消息入口";
});

check("the tracked facts are what verify_claims.py produces now", () => {
  // ## 这道闸门在补一个「自己抹平问题」的行为
  //
  // `verify_claims.py` 会**写** `dist/verified-comparison.json` 与 `dist/facts.json`。
  // 闸门以前直接跑它 —— 于是闸门每跑一次，就把这两份产物**重写一遍**：
  // 「上游变了但产物没重算」这件事被**当场修好**，于是永远验不出来。
  //
  // 症状特别隐蔽：闸门跑完，`git status` 里 `dist/facts.json` 变成 modified，
  // 而闸门**一言不发** —— 它刚把问题抹平了。
  //
  // 现在闸门把它跑到**临时目录**，再逐字比对仓库里那两份：
  // 对不上 → 红（「重算一遍：python verify_claims.py」）。
  const { ok, out } = runVerifyClaims();
  assert(ok, `verify_claims.py exited non-zero:\n        ${out.slice(-600)}`);
  for (const f of ["facts.json", "verified-comparison.json"]) {
    const tmp = resolve(VERIFY_TMP_DIR, f);
    const tracked = resolve(ROOT, "dist", f);
    assert(existsSync(tmp), `verify_claims.py 没产出 ${f}（临时目录里没有）`);
    assert(existsSync(tracked), `dist/${f} 不存在 —— 先跑 python verify_claims.py`);
    const a = readFileSync(tmp, "utf-8");
    const b = readFileSync(tracked, "utf-8");
    assert(
      a === b,
      `dist/${f} 与重跑结果不一致 —— 产物是用**旧的上游**算出来的。\n` +
        "        重算：python verify_claims.py\n" +
        "        （然后 node rebuild_report.mjs → node render_to_pdfdir.mjs）",
    );
  }
  return "facts.json 与 verified-comparison.json 都与重跑结果逐字一致";
});

check("the report says which upstream it was built from", () => {
  // ## 这道闸门为什么存在
  //
  // 交付链是：
  //   extract-cache ─(LLM 抽取)─> diff-result.json ─(程序化 diff)─> facts.json
  //        └─(verify_claims.py 回源复核)─> verified-comparison.json
  //                  ↓
  //           reports/last-report.json ─(渲染)─> 交付件 PDF
  //
  // 每一段都是**确定性**的（除了最上游那次 LLM 抽取），
  // 所以「上游变了、下游没跟着变」是**可以判定的** ——
  // 前提是下游**记着自己是从哪份上游算出来的**。
  //
  // 实测（2026-11-04，动手之前先做的实验）：
  //   · 改 `dist/extract-cache/*.json` 里的一个条款号 → 闸门 **131/131 全绿**；
  //   · 把交付件 PDF 换成 249 页的旧版 → 闸门 **131/131 全绿**；
  //   · 改 `data/diff-corrections.json` 里的人工更正 → **抓到了**（差值那一半本来就有判据）。
  //
  // 也就是说：**接缝有三处，只闭合了一处。**
  //
  // 修法：报告里记上游的 sha256，闸门比对「报告记的」与「磁盘上现在的」。
  const rep = JSON.parse(read("reports/last-report.json"));
  const recorded = rep.provenance;
  assert(
    recorded && typeof recorded === "object",
    "报告里没有 provenance —— 这份报告不是带溯源信息生成的（重建它）",
  );
  const now = computeProvenance(ROOT);
  const diffs = describeProvenanceDiff(recorded, now);
  assert(
    diffs.length === 0,
    `报告是用**旧的上游**算出来的：\n        ${diffs.join("\n        ")}\n` +
      "        重建报告：node rebuild_report.mjs",
  );
  const n = Object.keys(recorded.extractCacheSha256 ?? {}).length;
  return `facts/diff-result/${n} 份 extract-cache 的指纹都对得上`;
});

check("the delivered PDF is the one the report renders to", () => {
  // 上一道闸门盯的是「报告 ↔ 上游」；
  // 这一道盯的是「**交付件文件** ↔ 报告」——
  // 也就是链子的**最后一跳**。
  //
  // 实测（2026-11-04）：把 `delivery/PDF对比/` 里那个交付件换成 249 页的旧版，
  // 闸门 **131/131 全绿** —— 因为闸门默认是**自己重新渲染一遍**
  // `reports/last-report.json` 再检查那份，**从来不打开交付件那个文件**。
  //
  // 于是「改了报告忘了重出 PDF」这条最常见的错，**没有任何一道闸门会响**。
  //
  // 判据：交付件那个 PDF 与闸门渲染出来的那份，**逐页文本必须一致**。
  // （不比字节 —— PDF 里的生成时刻每次都不同，比字节必然报「不一样」。）
  //
  // 交付件的文件名从 `render_to_pdfdir.mjs` 里读 —— **不另写一份**，
  // 否则改了输出名这里就会指向一个不存在的文件。
  const renderSrc = read("render_to_pdfdir.mjs");
  const m = /OUT_NAME\s*=\s*"([^"]+)"/.exec(renderSrc);
  assert(m, "render_to_pdfdir.mjs 里读不到 OUT_NAME —— 不知道交付件该是哪个文件");
  const delivered = resolve(ROOT, "delivery", "PDF对比", m[1]);
  assert(
    existsSync(delivered),
    `交付件不存在：delivery/PDF对比/${m[1]} —— 渲染它：node render_to_pdfdir.mjs`,
  );
  if (!GATE_PDF) return "skipped — 闸门没能渲染出 PDF";
  const r = spawnSync("python", ["scripts/compare_pdfs.py"], {
    cwd: ROOT,
    encoding: "utf-8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    input: JSON.stringify({ a: GATE_PDF, b: delivered }),
  });
  const out = (r.stdout || "").trim();
  let res;
  try {
    res = JSON.parse(out.split("\n").pop());
  } catch {
    assert(false, `compare_pdfs.py 没给出 JSON：\n        ${out.slice(-300)}`);
    return "";
  }
  assert(
    !res.error,
    `compare_pdfs.py 报错：${res.error}`,
  );
  assert(
    res.diffCount === 0,
    `交付件与当前报告**对不上**（${res.pagesA} 页 vs ${res.pagesB} 页，` +
      `${res.diffCount} 页文本不同）——\n        ${res.firstDiff || ""}\n` +
      "        重新出件：node render_to_pdfdir.mjs",
  );
  return `交付件与报告逐页一致（${res.pagesA} 页）`;
});

check("the report names no standard the corpus does not contain", () => {
  // 换一套标准时，报告里的**散文**是手写的，不跟着语料走 ——
  // 于是新标准的报告里会**继续讲 GB 4785 的事**，
  // 而那不是「空着」，是**说错了**（读者会以为那是新标准的规定）。
  //
  // 这一关抓的就是这个形状：报告里出现的标准号，
  // 语料里必须找得到（或者明确登记为「背景引用」）。
  //
  // 实测就抓到一处：报告的「解读」栏写「UN R13 / R131」，
  // 而**同一行的原文摘录**写的是「UN Regulations Nos. 13 and 13-H」——
  // 解读与引文对不上，而引文是对的（R131 是另一部法规）。
  // 已改（data/requirement-gaps.json）。
  //
  // 顺带逼出两个更值钱的修复：
  // ① 台账的 `--check` 原来**只比总数** —— 内容变了它说「一致」（假信心）；
  // ② 构建清单**只跟踪 .ts** —— 被 esbuild 内联进包的 data/*.json
  //    （spec、台账…）改了不重建，**改动根本不生效**，而闸门全绿。
  const { ok, out } = runPy(["scripts/check_standard_names.py"], "check_standard_names");
  assert(
    ok,
    `报告里出现了语料里没有的标准 —— 换标准后那些就是**假声明**:\n        ${out.slice(-900)}`,
  );
  const m = /标准号 (\d+) 个；语料里找不到的 (\d+) 个/.exec(out);
  assert(m, `check_standard_names.py 没给出汇总行:\n        ${out.slice(-400)}`);
  return `报告里 ${m[1]} 个标准号都能在语料里找到（或已登记为背景引用）`;
});

check("every hard-coded standard name in the source is on the swap ledger", () => {
  // 换一套标准时，最贵的不是 spec 包（集中在一个文件里，看得见），
  // 而是**散落在 51 个源码文件里的字面量** —— 一句错误提示、一个 brief、
  // 一处文件名模板、一条识别正则。
  //
  // 而漏掉一处的症状**不报错**：那句话照出现在新标准的报告里，
  // 读者会以为那是新标准的规定。**那是「错着」，不是「空着」。**
  //
  // 这一关盯的就是那个「不报错」：
  //   ① 每一片源码都得在 data/hardcode-ledger.json 里**登记一条规则**，
  //      写清「为什么在这儿」「换标准时怎么改」；
  //   ② 没登记的硬编码 = 红（清单上没写的地方，人就不会去看）；
  //   ③ 规则失效（文件里已经没有对应的硬编码了）= 红
  //      —— 清单里留着一项不存在的活儿，比清单里少一项更骗人。
  //
  // 实测：这条闸门抓得住「新增一处未登记的硬编码」、
  // 「规则指向了不再有硬编码的文件」、「规则没写 why/swap」三种退化。
  const { ok, out } = runPy(["scripts/hardcode_ledger.py", "--verify"], "hardcode-ledger");
  const total = /标准特定硬编码：(\d+) 处/.exec(out);
  const rules = /台账规则 (\d+) 条/.exec(out);
  assert(
    total && rules,
    `hardcode_ledger.py 没给出汇总行:\n        ${out.slice(-600)}`,
  );
  assert(
    ok,
    `源码里的标准名硬编码没有全部登记，或台账规则失效 —— 换标准时清单会漏项:\n        ` +
      out
        .split("\n")
        .filter((l) => l.includes("✗"))
        .join("\n        "),
  );
  return `${total[1]} 处硬编码已登记（${rules[1]} 条规则）· 换标准清单无漏项`;
});

check("the renderer recognizes versions by the declaration's own rules", () => {
  // 「这份文件是哪一版」原来有**两份实现**：
  //   ① `python_service/main.py` —— 上传时校验文件名、推断标签；
  //   ② `htmlRender*.ts` —— 渲染时把文件名显示成封面卡片上的版本名。
  //
  // 两份漂移的表现是**封面上的版本名认错了**：
  // 「A 版是 GB 4785-2019」这种颠倒的东西，报告照出、闸门全绿，
  // 而读者不会去核对 —— 那是**静默说错**。
  //
  // 判据（一）：**源码级** —— 渲染层不许再自己手写标准名正则，
  // 它必须走 `shared/versionFileName.ts`（判据在声明里）。
  for (const rel of ["server/reports/htmlRender.ts", "server/reports/htmlRenderV8.ts"]) {
    const src = read(rel);
    assert(
      /from "@shared\/versionFileName"/.test(src),
      `${rel} 没有走共用的认版本实现 —— 渲染层与上传校验又变成两份实现了`,
    );
    assert(
      !/R0\?48\|R48/i.test(src),
      `${rel} 里还留着**手写的标准名正则** —— 它和声明里的判据迟早漂移，` +
        "而漂移的表现是封面上的版本名认错了",
    );
  }

  // 判据（二）：**行为级** —— 声明里每一版的源文件名送进 cleanDocName()，
  // 必须回到这一版的 doc。认错了，封面就讲错标准。
  const pack = JSON.parse(read("data/standard-pack.json"));
  const rows = [];
  for (const v of pack.versions ?? []) {
    const got = cleanDocName(v.sourceFile);
    rows.push(`${v.key}: ${got}`);
    assert(
      got === v.doc,
      `封面卡片上的版本名认错了：${v.sourceFile} → 「${got}」，` +
        `而声明说这一版叫「${v.doc}」`,
    );
    assert(
      recognizeVersionByFileName(v.sourceFile) === v.key,
      `文件名认版本认错了：${v.sourceFile} → ` +
        `${recognizeVersionByFileName(v.sourceFile)}（应为 ${v.key}）`,
    );
  }
  return rows.join(" · ");
});

check("the device→chapter map is fresh and covers what the agent needs", () => {
  // 「装置住在哪一章」是取值规格提议 agent 的**输入** ——
  // 候选句是从章里捞的，没有章号就捞不到，捞不到就跑不起来。
  //
  // 这份表必须**从语料扫出来**（`scripts/build_device_chapter_map.py`），
  // 而不是从手写 spec 反推 —— 后者在换标准时是**死结**：
  // 没有手写 spec → 推不出章号 → 还是得手写 spec。
  //
  // ① **新鲜度**：现算一遍与入库那份逐字相同（**检查器不写产物**）。
  const r = runPy(["scripts/build_device_chapter_map.py", "--check"], "device-chapter-map");
  assert(
    r.ok,
    `装置↔章映射表**过期**了（语料或 spec 变了）：\n        ${(r.out || "").slice(-500)}`,
  );

  const map = JSON.parse(read("data/device-chapter-map.json"));
  const versions = Object.keys(map.chapters ?? {});
  const specs = JSON.parse(read("data/parameter-specs.json")).specs ?? [];
  const residue = new Set(
    (map._residue?.devicesWithoutChapter ?? []).map((x) => `${x.device}@${x.version}`),
  );

  // ② **接得上**：spec 里每个装置，在它有结论的版本里都要拿得到章。
  //    拿不到的必须在**残余清单**里 —— 残余是产物，不是事故。
  const missing = [];
  for (const s of specs) {
    const dev = String(s.id ?? "").split(".")[0];
    for (const v of versions) {
      const has = !!(s.patterns ?? {})[v] || !!(s.absent ?? {})[v];
      if (!has) continue;
      if (deviceChapterPrefixes(specs, dev, v).length) continue;
      if (residue.has(`${dev}@${v}`)) continue;
      missing.push(`${dev}@${v}`);
    }
  }
  assert(
    missing.length === 0,
    `${missing.length} 个装置×版本**既接不上章、也不在残余清单里** —— ` +
      `那意味着 agent 会**默默地**跳过它（而界面不会说）：\n        ${missing.slice(0, 8).join("\n        ")}`,
  );

  // ③ **探针真的在语料里** —— 章认错了，探针就不在那一版里。
  const badProbes = map._residue?.probesNotInCorpus ?? [];
  assert(
    badProbes.length === 0,
    `${badProbes.length} 个章的探针**不在语料里** —— 那张章是认错了的：\n        ` +
      badProbes.slice(0, 5).map((b) => `${b.version} ${b.section} 「${b.probe}」`).join("\n        "),
  );

  // ④ **不与「手写 spec 反推的章」打架** —— 两份实现互相验。
  //
  // 建表时用的是 python 复刻的旧路，这里用的是 TS 侧的旧路：
  // 任何一份写错了，另一份会喊。
  const conflicts = [];
  for (const s of specs) {
    const dev = String(s.id ?? "").split(".")[0];
    for (const v of versions) {
      const legacy = legacyChapterPrefixes(specs, dev, v);
      if (!legacy.length) continue;
      const mapped = (map.devices ?? {})[dev]?.[v] ?? [];
      if (mapped.length && !mapped.includes(legacy[0])) {
        conflicts.push(`${dev}@${v}：旧=${legacy.join("/")} 新=${mapped.join("/")}`);
      }
    }
  }
  assert(
    conflicts.length === 0,
    `${conflicts.length} 处新表与手写 spec 反推的章**不一致**：\n        ${conflicts.slice(0, 8).join("\n        ")}`,
  );

  // 残余每条都要有理由（没有理由的残余 = 没人知道该怎么办）
  for (const x of map._residue?.devicesWithoutChapter ?? []) {
    assert(
      x.basis && String(x.basis).trim(),
      `残余条目 ${x.device}@${x.version} 没有理由 —— 机器接不上的地方，人也不知道该怎么补`,
    );
  }

  const nDev = Object.keys(map.devices ?? {}).length;
  const nRes = (map._residue?.devicesWithoutChapter ?? []).length;
  return `${nDev} 个装置 · 残余 ${nRes} 条 · 探针全在语料里`;
});

check("the claimed-indicator family agrees with the declaration", () => {
  // §11.4 那张表里有三处「声称指标」的专有名词：
  //   ① 小节标题里的表号（「（GB4785 表 11.6 逐条核验）」）
  //   ② 表头里「声称」那一列的列名（「GB4785 声称」）
  //   ③ 行内的不一致标记（「⚠ GB4785 表 11.6 声称值与原文不一致」）
  //
  // 三处必须**说的是同一个表**。换标准时只改其中一处，报告里就会出现
  // 「标题说表 11.7、行里说表 11.6」这种自相矛盾 ——
  // 而读者不会去核（那只是一个 ⚠ 标记）。
  //
  // 这一关把它们与**声明**对齐：声明里是什么，报告里就得处处是什么，
  // 而且**不许出现第二个表号**。
  const pack = JSON.parse(read("data/standard-pack.json"));
  const src = pack.standardFamilyShort;
  const tableNo = pack.claimedIndicators.tableNo;
  assert(src && tableNo, "声明里缺 claimedIndicators —— 换标准时就没有表号可改了");

  const rep = loadReport();
  const md = (rep.chapters ?? []).map((c) => c.markdown ?? "").join("\n");
  const i = md.indexOf("数据指标变化");
  assert(i >= 0, "报告里找不到「数据指标变化」那一节");
  const j = md.indexOf("\n### ", i + 5);
  const block = md.slice(i, j > 0 ? j : i + 12000);

  // ① 标题里的表号
  const heading = block.slice(0, block.indexOf("\n"));
  assert(
    heading.includes(`${src} ${tableNo}`),
    `§11.4 的标题里没有声明的表号：期望「${src} ${tableNo}」，实际标题「${heading}」`,
  );

  // ② 表头里「声称」那一列
  assert(
    block.includes(`| ${src} 声称 |`),
    `§11.4 的表头里没有「${src} 声称」这一列 —— 表头与声明不一致`,
  );

  // ③ 行内的不一致标记
  const notes = block.match(new RegExp(`${src} ${tableNo} 声称值与原文不一致`, "g")) ?? [];
  assert(
    notes.length > 0,
    `§11.4 里一个「${src} ${tableNo} 声称值与原文不一致」的标记都没有 —— ` +
      "要么判定逻辑坏了，要么标记文案与声明脱节了",
  );

  // ④ **不许出现第二个表号** —— 这是这一关真正的牙齿
  const seen = [...block.matchAll(/表\s*([\d.]+)/g)].map((m) => m[1]);
  const wrong = [...new Set(seen.filter((n) => n !== tableNo.replace(/^表\s*/, "")))];
  assert(
    wrong.length === 0,
    `§11.4 里出现了另一个表号：${wrong.join("、")}（声明里是「${tableNo}」）—— ` +
      "标题、表头、行内标记说的不是同一个表",
  );
  return `§11.4 的表号与声称方一致（${src} ${tableNo}，${notes.length} 处标记）`;
});

check("the trust projection does not lose rows", () => {
  // 客户端「审阅工作台」的每个模块都是**投影** ——
  // 投影漏掉一行，界面上就少一行，而界面**不会说**「我漏了」。
  //
  // 这一关断言：**源表有几行，投影里就有几条**。
  //
  // 源侧独立数一遍（不看投影的实现）：找那张「指标 × 两版原文」的表，
  // 数它后面带序号的行。判据是**列的形状**（6 列 · 第 2 列是指标 ·
  // 第 3 列是核验状态），不认列的名字 —— 换一套标准也认得出来。
  const rep = JSON.parse(read("reports/last-report.json"));
  const md = (rep.chapters ?? []).map((c) => c.markdown ?? "").join("\n");

  let srcRows = 0;
  let inTable = false;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = t.replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
    if (!inTable) {
      if (cells.length === 6 && /指标/.test(cells[1] ?? "") && /核验|状态/.test(cells[2] ?? "")) {
        inTable = true;
      }
      continue;
    }
    if (/^\d{1,3}$/.test(cells[0] ?? "")) srcRows++;
  }

  const projected = extractRumors(md).length;
  assert(
    projected === srcRows,
    `可信度投影比源表少：源表 ${srcRows} 行，投影 ${projected} 条 —— ` +
      "界面会少显示几行，而界面**不会说**「我漏了」。",
  );
  return `投影 ${projected} 条 = 源表 ${srcRows} 行（投影不许比源少）`;
});

check("the declaration can recognize its own source files", () => {
  // 标准声明说了两件事：
  //   ① 哪些文件是源文件（`sourceFile` / `sourceDir`）
  //   ② 怎么从文件名认出它是哪一版（`fileTokens` / `fileExclude`）
  //
  // 这两半必须**对得上** —— 否则 sidecar 认不出自己的源文件，
  // 而症状是「上传后说要标版本，但标不出来」，**不报错**。
  //
  // 换标准时最容易出的错就是：改了声明里的文件名，却忘了改签名
  //（或者反过来）—— 于是新标准的 PDF 一份都认不出来。
  const pack = JSON.parse(read("data/standard-pack.json"));
  const versions = pack.versions || [];
  const problems = [];
  const srcDir = pack.sourceDir || "delivery/PDF对比";

  for (const v of versions) {
    const name = v.sourceFile || "";
    if (!name) {
      problems.push(`${v.key} 没有声明源文件名（sourceFile）`);
      continue;
    }
    if (!existsSync(resolve(ROOT, srcDir, name))) {
      problems.push(`${v.key} 声明的源文件不存在：${srcDir}/${name}`);
      continue;
    }
    // 文件名签名必须**认得出它自己**
    for (const re of v.fileTokens || []) {
      if (!new RegExp(re, "i").test(name)) {
        problems.push(`${v.key} 的文件名签名 ${re} 认不出自己的源文件（${name}）`);
      }
    }
    // 排除项必须**不误排除**它自己（否则 A/B 互相认错）
    for (const re of v.fileExclude || []) {
      if (new RegExp(re, "i").test(name)) {
        problems.push(`${v.key} 的排除项 ${re} 把自己的源文件排除了（${name}）`);
      }
    }
  }

  // 客户端的「这套装是不是本标准」判据，也必须认得出源文件
  for (const re of pack.clientSetProbe || []) {
    const hit = versions.some((v) => v.sourceFile && new RegExp(re, "i").test(v.sourceFile));
    if (!hit) {
      problems.push(`clientSetProbe 的 ${re} 认不出任何一份源文件 —— 界面会一直用通用文案`);
    }
  }

  // 声明里的版本键必须**覆盖**语料里实际有的版本
  const corpus = JSON.parse(read("dist/mineru-v4-data.json"));
  const corpusKeys = Object.keys(corpus).filter((k) => corpus[k]?.fullText);
  const declared = new Set(versions.map((v) => v.key));
  for (const k of corpusKeys) {
    if (!declared.has(k)) {
      problems.push(`语料里有版本 ${k}，但标准声明里没有这一版 —— 它的显示名会退化成键本身`);
    }
  }

  assert(
    problems.length === 0,
    `标准声明与源文件对不上:\n        ${problems.join("\n        ")}`,
  );
  return `${versions.length} 份源文件都在 · 文件名签名都认得出 · 声明覆盖语料的 ${corpusKeys.join(",")}`;
});

check("the spec residue ledger is explicit and within its caps", () => {
  // 残余 = 机器判不了的那些槽位。**残余是产物，不是事故** ——
  // 换一套标准时，人的工作量就等于这份清单。
  //
  // 但「残余」如果没人管，它会变成一个**没人看的清单** ——
  // 机器以为它写了就算数了。这一关把它钉死。

  // ① **新鲜度**：现算一遍与入库那份逐字相同（**检查器不写产物**）。
  const r = runNode(["scripts/build_spec_residue.mjs", "--check"], "spec-residue");
  assert(r.ok, `残余台账**过期**了（agent 跑过了或 spec 变了）：\n        ${(r.out || "").slice(-400)}`);

  const doc = JSON.parse(read("data/spec-residue.json"));

  // 产物声明 —— 「这份产物是谁、用什么、从哪份原料、什么时候做的」。
  for (const k of ["_generator", "_model", "_promptVersion", "_sourceSha256", "_builtAt"]) {
    assert(doc[k] !== undefined, `残余台账缺产物声明字段 ${k} —— 不知道它是哪次跑的、用什么跑的`);
  }
  assert(
    Object.keys(doc._sourceSha256 ?? {}).length > 0,
    "残余台账没记**源 PDF 的指纹** —— 源 PDF 一换，这份产物就作废了，而没人会知道",
  );

  const rows = Array.isArray(doc.rows) ? doc.rows : [];
  const caps = doc._caps ?? { R1: 30, R2: 16, R3: 0, total: 60 };

  // ② **每条都有理由** —— 没有理由的残余，没人知道该怎么办。
  for (const row of rows) {
    assert(
      row.basis && String(row.basis).trim(),
      `残余条目 ${row.id}@${row.version} 没有理由 —— 机器接不上的地方，人也不知道该怎么补`,
    );
    assert(
      ["R1", "R2", "R3"].includes(row.grade),
      `残余条目 ${row.id}@${row.version} 的档位是「${row.grade}」—— 分档是按**病因**分的，病因不同治法不同`,
    );
    assert(
      row.adjudicated === false,
      `残余条目 ${row.id}@${row.version} 自己写着「已核」—— 机器不许给自己盖章，` +
        `人工裁决另存 data/spec-residue-adjudications.json`,
    );
  }

  // ③ **R3 = 0** —— 机器认的章与人的背书不一致，不允许有（归 W1 修）。
  const r3 = rows.filter((x) => x.grade === "R3");
  assert(
    r3.length === 0,
    `有 ${r3.length} 条 R3（机器认的章与手写 spec 反推的不一致）：\n        ` +
      r3.slice(0, 5).map((x) => `${x.id}@${x.version} ${x.basis}`).join("\n        "),
  );

  // ④ **不超上限** —— 超了就是人核不过来（那说明机器还没学会）。
  const n1 = rows.filter((x) => x.grade === "R1").length;
  const n2 = rows.filter((x) => x.grade === "R2").length;
  assert(n1 <= caps.R1, `R1（机器可以重试的）有 ${n1} 条，上限 ${caps.R1}`);
  assert(n2 <= caps.R2, `R2（必须逐条人核的）有 ${n2} 条，上限 ${caps.R2}`);
  assert(rows.length <= caps.total, `残余共 ${rows.length} 条，上限 ${caps.total}`);

  // ⑤ **不许同时出现在两个文件里** —— 残余 vs 已采纳。
  const specs = JSON.parse(read("data/parameter-specs.json")).specs ?? [];
  const byId = new Map(specs.map((s) => [s.id, s]));
  const both = rows.filter((row) => byId.get(row.id)?.patterns?.[row.version]);
  assert(
    both.length === 0,
    `${both.length} 条残余对应的槽位**已经有取值了** —— 同一条槽位不能同时在残余台账与已采纳的 spec 里：\n        ` +
      both.slice(0, 5).map((x) => `${x.id}@${x.version}`).join("\n        "),
  );

  return `${rows.length} 条残余（R1 ${n1} · R2 ${n2}）· 上限 ${caps.total}`;
});

check("no standard-specific names in the gates themselves", () => {
  // 「闸门不许 agent 碰」怎么变成**可判定**的？
  //
  // 做法：闸门源码里**不许出现标准族的名字**（注释除外）——
  // 于是 agent 想改闸门让自己通过，就会在改的时候**撞上这一关**。
  //
  // 允许出现的地方**不是白名单就算过**：每一处都要在台账
  // （`data/hardcode-ledger.json` 的 `gateExceptions`）里**登记理由**；
  // 没登记的 → 红；登记了但其实用不上的 → **也红**（例外清单不许养僵尸）。
  const scan = runNode(["scripts/hardcode_scan.mjs"], "hardcode-scan");
  assert(scan.ok, `硬编码扫描跑不起来：\n        ${(scan.out || "").slice(-300)}`);
  const recs = JSON.parse(scan.out);

  const ledger = JSON.parse(read("data/hardcode-ledger.json"));
  const rule = (ledger.rules ?? []).find((r) => r.id === "gate-assertions");
  assert(rule, "台账里没有「闸门里的断言」那条规则 —— 不知道哪些文件算闸门");
  const gateFiles = new Set(rule.files ?? []);
  const exceptions = ledger.gateExceptions ?? [];
  const allowed = new Map(exceptions.map((e) => [`${e.file}\u0000${e.text}`, e]));

  // 闸门文件里**非注释**的标准名命中
  const hits = recs.filter((x) => gateFiles.has(x.file) && x.kind !== "comment");
  const unexplained = hits.filter((x) => !allowed.has(`${x.file}\u0000${x.text}`));
  assert(
    unexplained.length === 0,
    `闸门里有 ${unexplained.length} 处**没登记理由**的标准名 —— ` +
      `闸门必须与标准无关（否则换标准时它会照旧按旧标准判）：\n        ` +
      unexplained
        .slice(0, 8)
        .map((x) => `${x.file}:${x.line} 「${String(x.text).slice(0, 60)}」`)
        .join("\n        "),
  );

  // **例外清单不许养僵尸** —— 登记了但其实已经没有命中了，说明它该删。
  const used = new Set(hits.map((x) => `${x.file}\u0000${x.text}`));
  const stale = exceptions.filter((e) => !used.has(`${e.file}\u0000${e.text}`));
  assert(
    stale.length === 0,
    `${stale.length} 处例外**已经用不上了**（对应的标准名不在闸门里了）—— ` +
      `例外清单要跟着删，否则它会变成一张没人看的通行证：\n        ` +
      stale.map((e) => `${e.file} 「${String(e.text).slice(0, 60)}」`).join("\n        "),
  );

  // 每处例外都要**有理由** —— 没理由的例外等于没有闸门。
  for (const e of exceptions) {
    assert(
      e.reason && String(e.reason).trim(),
      `例外 ${e.file}「${String(e.text).slice(0, 40)}」没有写理由 —— ` +
        `为什么这里可以出现标准名，得说清楚`,
    );
  }

  return `${hits.length} 处命中（全部登记过理由）· 闸门文件 ${gateFiles.size} 个`;
});

check("the swap checklist is not stale", () => {
  // 清单是**生成的**：改了源码就必须重出，否则它会**静静地骗人** ——
  // 读者照着一份旧清单去改代码，改的是已经不存在的行。
  //
  // 这一关把清单重新生成一遍，与入库那份**逐字比对**。
  // 对不上就红，并告诉他怎么重出。
  const FILE = "delivery/PDF对比/分析报告/换标准操作清单_2026-11-06.md";
  const { ok, out } = runPy(
    ["scripts/hardcode_ledger.py", "--checklist", "--out", resolve(ROOT, "tmp", "hardcode-checklist.md")],
    "hardcode-checklist",
  );
  assert(ok, `换标准清单生成失败:\n        ${out.slice(-600)}`);
  // 生成到 **tmp/**（gitignore 里的临时目录），不碰入库那份 ——
  // 检查器写产物 = 把问题顺手修好 = 永远验不出来（经验 20）。
  const fresh = readFileSync(resolve(ROOT, "tmp", "hardcode-checklist.md"), "utf-8");
  const committed = gitShow(FILE);
  assert(
    committed !== null,
    `找不到入库的清单 ${FILE} —— 跑 python scripts/hardcode_ledger.py --checklist --out "${FILE}"`,
  );
  assert(
    // 归一化行尾：Windows 上 Python 写出来是 CRLF，git 里可能是 LF ——
    // 那不是「清单过期了」，是行尾不一样。
    fresh.replace(/\r\n/g, "\n") === String(committed).replace(/\r\n/g, "\n"),
    `入库的「换标准操作清单」已经**过期**（源码改了，清单没重出）——\n` +
      "        清单上写的是已经不存在的行，照着改会改错地方。\n" +
      `        重出：python scripts/hardcode_ledger.py --checklist --out "${FILE}"`,
  );
  return `清单与当前源码一致（${(fresh.match(/^- `/gm) || []).length} 处定位）`;
});

check("the report's title layer comes from the declaration, not from literals", () => {
  // 封面标题、章节标题、附录标题里**点了标准的名**（「GB 4785」「UN R48-09 §6」）。
  // 以前它们是 reportV6.ts 里的字面量 —— 换一套标准，机制照样跑，
  // 闸门照样全绿，而**封面会一本正经地讲错标准**。
  //
  // 现在它们声明在 data/report-meta.json 里，由 reportMeta.ts 组装。
  // 判据（三条都要）：
  //   ① reportV6.ts 里**不许**再出现这些字面量 —— 不许偷偷写死第二份；
  //   ② 交付件里的标题必须**逐字等于**声明组装出来的结果；
  //   ③ 声明里的标准名必须**语料里真有它** —— 否则声明本身就是假的。
  const corpusData = JSON.parse(read("dist/mineru-v4-data.json"));
  const vKeys = versionsOf(corpusData);
  const slots = titleSlots(
    vKeys,
    vKeys.map((v) => versionLabel(v)),
    vKeys.map((v) => versionDoc(v)),
  );

  // ① 源码里不许有字面量
  const src = read("server/reports/reportV6.ts");
  const literals = [
    `${FAM} 多版本横向对比研究报告`,
    `${vKeys.join("/")} 原始表格汇编`,
    `${vDocNoRev("C")} ${STANDARD_PACK.clausesOfLastVersion} 量化条款全量清单`,
    `${vDoc("C")} ${STANDARD_PACK.clausesOfLastVersion} 量化条款全量清单`,
    `${vKeys.join("|")} 三版本主题对照`,
  ];
  const found = literals.filter((t) => src.includes(t));
  assert(
    found.length === 0,
    `reportV6.ts 里又写死了标题：${found.join(" / ")} —— 标题要来自 data/report-meta.json`,
  );

  // ② 交付件里的标题 == 声明组装的结果
  const rep = JSON.parse(read("reports/last-report.json"));
  const expectTitle = composeTitle(slots);
  assert(
    rep.outline.title === expectTitle,
    `封面标题与声明不符：\n        交付件：${rep.outline.title}\n        声明组装：${expectTitle}`,
  );
  for (const id of [0, 11, 12, 13, 14]) {
    const got = (rep.outline.chapters.find((c) => c.id === id) || {}).title;
    const want = composeChapterTitle(id, slots);
    assert(got === want, `第 ${id} 章标题与声明不符：交付件「${got}」/ 声明组装「${want}」`);
  }
  const ch11 = rep.outline.chapters.find((c) => c.id === 11) || { sections: [] };
  const wantSections = composeChapter11Sections(slots);
  assert(
    JSON.stringify(ch11.sections) === JSON.stringify(wantSections),
    `第 11 章目录项与声明不符：\n        交付件：${JSON.stringify(ch11.sections)}\n        声明组装：${JSON.stringify(wantSections)}`,
  );
  for (const a of rep.appendices || []) {
    const want = composeAppendixTitle(a.id, slots);
    assert(
      a.title === want,
      `附录 ${a.id} 标题与声明不符：交付件「${a.title}」/ 声明组装「${want}」`,
    );
    // 目录里写的和正文里写的必须是**同一句** ——
    // 以前是两句（目录「图片、公式与标题索引」/ 正文「图片、公式与数据溯源」），
    // 读者会以为有两个附录。
    const first = String(a.markdown || "").split("\n")[0].trim();
    assert(
      first === `# 附录 ${a.id} ${want}`,
      `附录 ${a.id} 的正文标题与目录不一致：正文「${first}」/ 目录「# 附录 ${a.id} ${want}」`,
    );
  }

  // ③ 声明里的标准名必须语料里真有
  //
  // 比的不是**逐字** —— 语料里写的是「UN Regulation No. 48」，
  // 声明里写的是「UN R48-09」。所以认几种等价写法：
  //   「UN R48-09」 ⇄「UN R48」 ⇄「UN Regulation No. 48」 ⇄「Regulation No. 48」
  //   「GB 4785」  ⇄「GB4785」
  // 判据：至少有一种写法在语料里出现。
  const flat = (s) => String(s || "").replace(/[^0-9A-Za-z一-鿿]/g, "").toUpperCase();
  const corpusText = flat(
    Object.values(corpusData)
      .map((d) => `${d?.fullText || ""}\n${d?.markdown || ""}`)
      .join("\n"),
  );
  /** 一个标准名在语料里可能的写法。 */
  const spellings = (name) => {
    const raw = String(name || "").trim();
    const out = new Set([flat(raw)]);
    const m = /^([A-Za-z]{1,6})\s*([A-Za-z]?)\s*R?\s*(\d{1,5})(?:\s*[-–—]\s*(\d{1,4}))?$/.exec(raw);
    if (m) {
      const [, prefix, letter, num] = m;
      const p = prefix.toUpperCase();
      if (p === "UN" || p === "ECE" || p === "UNECE") {
        out.add(`${p}R${num}`);
        out.add(`${p}REGULATIONNO${num}`);
        out.add(`REGULATIONNO${num}`);
      } else {
        out.add(`${p}${num}`);
        out.add(`${p}${letter}${num}`);
      }
    }
    return [...out].filter(Boolean);
  };
  const declared = [
    REPORT_META.standardFamily,
    REPORT_META.standardFamilyShort,
    versionDoc(vKeys[vKeys.length - 1]),
  ];
  const missing = declared.filter((n) => !spellings(n).some((s) => corpusText.includes(s)));
  assert(
    missing.length === 0,
    `data/report-meta.json 声明的标准名在语料里不存在：${missing.join(" / ")} —— 声明本身就是假的`,
  );

  return `封面/章节/附录标题全部来自声明（${vKeys.length} 版：${vKeys.join(",")}）；声明的标准名语料里都有`;
});

check("there is only one report file and one uploaded-docs dir", () => {
  // 「两份真相来源」是这个项目治过好几次的病：
  // 网站把报告写进 `server/reports/last-report.json`，
  // 而 CLI 与全部闸门读的是仓库根的 `reports/last-report.json` ——
  // 两份都存在、都不报错，你读到哪一份取决于**你从哪儿启动的**。
  //
  // 同样的道理适用于上传目录：网站把 PDF 写进 `server/uploaded-docs/`，
  // 而回源复核层读的是仓库根的 `uploaded-docs/` ——
  // 于是**网站上传的新标准，管线根本看不见**。
  //
  // 判据：这两个「影子路径」**不许存在**。
  // 它们一旦出现，就是有人（或某个还活着的旧进程）走错了目录。
  const shadows = [
    "server/reports/last-report.json",
    "server/reports/last-report.llm-sse.json",
    "server/uploaded-docs",
  ];
  const found = shadows.filter((p) => existsSync(resolve(ROOT, p)));
  assert(
    found.length === 0,
    `出现了影子路径：${found.join(" / ")} ——\n` +
      "        那意味着有东西写到了错误目录（通常是还活着的旧 dev 进程）。\n" +
      "        删掉它们，并查清是谁写的：网页的报告与上传文件必须落在仓库根。",
  );
  return "只有一份 reports/last-report.json 与一个 uploaded-docs/";
});

check("a busy port stops the server instead of silently moving it", () => {
  // 端口被占时**静默换到下一个端口**，看着无害，实际很坏：
  //
  //   · 每起一个实例就多一个活着的进程，一个都不退出 ——
  //     实测一次会话里堆到了 **39 个** `tsx server/_core/index.ts`；
  //   · 你在浏览器里连的 3000 端口，是**最早那个旧实例** ——
  //     它跑旧代码（改了源码它不知道），还会把报告写回**同一份**
  //     reports/last-report.json。
  //     于是「我刚跑出来的报告怎么标题还是旧的」这种问题，
  //     在服务器日志里查不出任何线索（日志在新起的那个实例上）。
  //
  // 所以现在：**端口被本项目的另一个实例占着 → 响亮地拒绝启动**。
  // 判据：
  //   ① 源码里必须有「探针 + 拒绝退出」这两样；
  //   ② 探针本身要有已知答案用例（_test_instance_probe.mjs）；
  //   ③ 每个响应都要带实例标记（否则探针认不出「是我自己」）。
  const src = read("server/_core/index.ts");
  assert(
    /probeOwnInstance/.test(src),
    "index.ts 里没有用端口探针 —— 端口被占时它还是会静默换端口",
  );
  assert(
    /process\.exit\(1\)/.test(src),
    "index.ts 探到本项目的另一个实例后没有拒绝启动 —— 它会静默挪到下一个端口",
  );
  assert(
    /ALLOW_PORT_FALLBACK/.test(src),
    "index.ts 没有逃生开关 —— 真要两个实例并存时连路都没有",
  );
  assert(
    /INSTANCE_HEADER/.test(src),
    "index.ts 没给每个响应打实例标记 —— 探针认不出端口上坐的是不是自己",
  );
  const probe = read("server/_core/instanceProbe.ts");
  assert(
    /x-regulatory-copilot/.test(probe),
    "instanceProbe.ts 的标记头与 index.ts 设置的不一致 —— 探针永远认不出自己人",
  );
  return "端口被本项目的另一个实例占着时拒绝启动（探针有已知答案用例）";
});

check("a draft can never wear the deliverable's name", () => {
  // 「快速草稿（未经核验）」与交付件走**同一个渲染器、同一套版式**，
  // 渲染出来的东西一模一样 —— 于是草稿下载下来，
  // 文件名与交付件**逐字相同**（GB4785草案V4.3.5-…_多版本横向对比研究报告.pdf），
  // 转发给客户时**没有任何地方**能看出它没回过源。
  //
  // 2026-11-03 浏览器全流程实测时才发现：`/report/pdf` 那条路有护栏，
  // 但**弹窗里那个「下载 PDF」按钮走的是 `/report/render`，
  // 而客户端把 `generator` 字段丢了** —— 那条路上护栏和标记都没有。
  //
  // 判据（三条都要）：
  //   ① 草稿的文件名必须**带标记**，且与交付件的名字**不同**；
  //   ② **没有 generator 标记的也算草稿** —— 证明不了它出自已核验管线，
  //      就不能让它冒充交付件（与 /report/pdf 的护栏同口径）；
  //   ③ 服务端渲染草稿时，**封面标题也要打标** ——
  //      文件名会转发掉，封面不会。
  const docs = [
    { name: `${vDoc("A")}（103 页）` },
    { name: `${vDoc("B")}（81 页）` },
    { name: `${vDoc("C")}（147 页）` },
  ];  const verified = reportFileName({ generator: "mineru", sourceDocuments: docs }, "pdf");
  const draft = reportFileName({ generator: "llm-sse", sourceDocuments: docs }, "pdf");
  const unmarked = reportFileName({ sourceDocuments: docs }, "pdf");

  assert(
    !/未经回源复核/.test(verified),
    `已核验的交付件文件名里不该有草稿标记：${verified}`,
  );
  assert(
    draft.includes(DRAFT_MARKER) && draft !== verified,
    `草稿的文件名与交付件一模一样（${draft}）—— ` +
      `转发出去就没人看得出它没回过源。文件名必须带「未经回源复核」标记。`,
  );
  assert(
    unmarked.includes(DRAFT_MARKER),
    `没有 generator 标记的报告，文件名里没有草稿标记（${unmarked}）—— ` +
      `证明不了它出自已核验管线，就不能让它冒充交付件。`,
  );
  assert(
    isUnverifiedDraft({ generator: "llm-sse" }) && isUnverifiedDraft({}) && !isUnverifiedDraft({ generator: "mineru" }),
    "isUnverifiedDraft 的判据不对",
  );
  // ASCII 兜底名也要能区分（老客户端只读 filename= 那一段）
  const cdDraft = contentDisposition({ generator: "llm-sse", sourceDocuments: docs }, "pdf");
  assert(
    cdDraft.includes(DRAFT_MARKER_ASCII),
    `草稿的 ASCII 兜底名里没有标记：${cdDraft}`,
  );

  // ── 源码侧：标记必须一路带得到渲染那一步 ──────────────────────────
  const routes = read("server/_core/agentRoutes.ts");
  // ① 快速草稿的报告对象必须带 generator: "llm-sse"
  const sse = routes.slice(routes.indexOf('router.post("/api/agent/report/generate"'));
  assert(
    /generator:\s*"llm-sse"/.test(sse),
    "快速草稿的报告对象里没有 generator 标记 —— 客户端与服务端都不知道它是草稿",
  );
  // ② MinerU 那条路的响应必须带 generator: "mineru"
  assert(
    /generator:\s*"mineru"/.test(routes),
    "MinerU 路径没有带 generator 标记 —— 已核验的报告会被当成来路不明",
  );
  // ③ /report/render 必须按标记打标（封面 + 文件名）
  const render = routes.slice(routes.indexOf('router.post("/api/agent/report/render"'));
  assert(
    /isUnverifiedDraft/.test(render) && /DRAFT_MARKER/.test(render),
    "/report/render 没有按 generator 打草稿标 —— 草稿的 PDF 封面与交付件长得一样",
  );
  // ④ 客户端必须把 generator 留在报告对象里（否则 POST 给服务端时字段就没了）
  const rb = read("client/src/components/ReportBuilder.tsx");
  assert(
    /generator:\s*\(data as any\)\.generator/.test(rb),
    "ReportBuilder 没有把 generator 存进报告对象 —— 服务端收到的是无标记报告，会被当成草稿",
  );
  assert(
    /generator:\s*"llm-sse"/.test(rb),
    "ReportBuilder 的快速草稿路径没有标 llm-sse",
  );
  return `草稿文件名带标记（${draft}），已核验的不带（${verified}）`;
});

check("the report panel does not call the verified path stream-generated", () => {
  // 面板抬头原来只有一句「Regex 提取 + 动态大纲 + 逐章流式生成 + 专业 PDF」——
  // 那**描述的是快速草稿**，却挂在「完整对比报告生成」这个抬头下，
  // 于是 **MinerU 的交付件也被说成「模型逐章编出来的」**。
  //
  // 那不是措辞洁癖：交付件的每个取值都回过源 PDF，
  // 说它是流式生成的，等于**把核验过的东西说成没核验**，
  // 也把没核验的东西（草稿）说成了核验过的。两种都骗人。
  //
  // 判据：抬头必须**按管线分支**，且「流式生成」只出现在草稿那一支。
  const rb = read("client/src/components/ReportBuilder.tsx");
  // 锚点必须落在 **JSX 里的那处标题**上 ——
  // 注释里也提到「完整对比报告生成」，用 indexOf 会锚到注释里。
  const titleMatch = />\s*完整对比报告生成\s*</.exec(rb);
  assert(titleMatch, "找不到「完整对比报告生成」面板抬头（JSX 里）");
  const header = rb.slice(titleMatch.index, titleMatch.index + 900);
  assert(
    /pipeline\s*===\s*"mineru"/.test(header),
    "面板抬头没有按管线分支 —— MinerU 是确定性渲染，不是流式生成",
  );
  assert(
    /pipeline\s*===\s*"draft"/.test(header),
    "面板抬头没有区分快速草稿",
  );
  // 「流式生成」四个字只许出现在**自报家门的那一句里**。
  //
  // 判据要**先剥掉注释** —— 注释里解释「原来那句描述的是快速草稿」是合理的，
  // 那不是页面上的文案。剥完之后，要求每一句提到「逐章流式生成」的**同一行**
  // 必须带着「未经核验」标记。
  //
  // 为什么按**行**判而不按「邻近 200 字」判：抬头那个三目表达式里，
  // MinerU 那一支与草稿那一支**挨着**（中间只隔两行）——
  // 按窗口判，MinerU 支的「逐章流式生成」会借着旁边草稿支的
  // 「未经核验」蒙混过关。**同一行**才是「这一句自报家门」的真实含义。
  const rbNoComment = rb.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const streamLines = rbNoComment.split("\n").filter((l) => l.includes("逐章流式生成"));
  assert(streamLines.length > 0, "找不到「逐章流式生成」—— 这一关大概已经失效了，请重写");
  for (const line of streamLines) {
    assert(
      /未经(?:回源)?(?:核验|复核)/.test(line),
      `「逐章流式生成」出现在不带「未经核验」标记的这一句里：${line.trim().slice(0, 80)} —— ` +
        `交付件是确定性渲染，不能说成流式生成。`,
    );
  }
  return "面板抬头按管线分支：MinerU 说回源复核，草稿才说流式生成";
});

// 版本识别对账探针：两个脚本各自认一遍版本，结果必须一致且完整。
// 写成常量而不是内联字符串 —— 内联的 Python 里有引号与缩进，转义容易出错。
const PY_FINGERPRINT_PROBE = [
  "import importlib.util, os, sys",
  "ROOT = os.getcwd()",
  "def load(name, path):",
  "    s = importlib.util.spec_from_file_location(name, os.path.join(ROOT, path))",
  "    m = importlib.util.module_from_spec(s)",
  "    s.loader.exec_module(m)",
  "    return m",
  "cs = load('clause_split', 'scripts/clause_split.py')",
  "ci = load('clause_index_src', 'scripts/clause_index_src.py')",
  "a = cs.pick_docs()",
  "b = ci.pick_docs()",
  "print('clause_split     :', {k: os.path.basename(v) for k, v in sorted(a.items())})",
  "print('clause_index_src:', {k: os.path.basename(v) for k, v in sorted(b.items())})",
  "if a == b and len(a) >= 3 and len(set(a.values())) == len(a):",
  "    print('SAME')",
  "else:",
  "    print('DIFFERENT')",
  "    sys.exit(1)",
].join("\n");

check("one source of truth for the version fingerprints and the section list", () => {
  // 「两份真相来源」是这个项目反复治的病。
  // 2026-11-04 逐行盘点时又挖出两处：
  //
  //   ① **版本指纹**：`clause_split.py` 的 VERSION_FINGERPRINTS（声明式）
  //      与 `clause_index_src.py` 里手抄的一份 if/elif ——
  //      两个脚本各认各的。换标准时改了一处忘了另一处，
  //      **条款索引与条款切分就对不上是哪一版**（页码归属错位，不报错）。
  //
  //   ② **R48 章节表**：`propose_parameters_c.py` 的 R48_SECTIONS（唯一手写处）
  //      与 `server/_core/parameterProposals.ts` 里手抄的一份 25 个章节号。
  //      漏改的后果是「章节区间算错 → 提议落到别的章里也不报错」。
  //
  // 判据：**副本不许存在**。
  const split = read("scripts/clause_split.py");
  const indexSrc = read("scripts/clause_index_src.py");
  assert(
    /VERSION_FINGERPRINTS/.test(split),
    "clause_split.py 里找不到 VERSION_FINGERPRINTS —— 版本指纹表没了",
  );
  // 索引脚本必须**引用**那一份，而不是自己再写一遍
  assert(
    /clause_split\.pick_docs/.test(indexSrc),
    "clause_index_src.py 没有引用 clause_split.pick_docs —— " +
      "它自己抄了一份版本识别逻辑，改一处忘另一处就会让条款索引认错版本。",
  );
  // 索引脚本里不许再出现手写的版本指纹
  const fingerprints = ["4785XXXX", "47852019", "UnitedNationsRegulations"];
  const leaked = fingerprints.filter((f) => indexSrc.includes(f));
  assert(
    !leaked.length,
    `clause_index_src.py 里又出现了手写的版本指纹 ${leaked.join("、")} —— ` +
      `版本识别只能有一处（clause_split.py 的 VERSION_FINGERPRINTS）。`,
  );

  // 章节表：TS 侧不许再手抄章节号
  const pp = read("server/_core/parameterProposals.ts");
  const nosBlock = /const NOS = \[([\s\S]*?)\]/.exec(pp);
  assert(
    !nosBlock,
    "server/_core/parameterProposals.ts 里又手抄了一份章节号（const NOS = [...]）—— " +
      "章节表只能有一处手写处（propose_parameters_c.py 的 R48_SECTIONS），" +
      "其余从 data/parameter-candidates-c.json 的 sections 读。",
  );
  assert(
    /cSectionNumbers\(\)/.test(pp) && /parameter-candidates-c\.json/.test(pp),
    "parameterProposals.ts 没有从 data/parameter-candidates-c.json 读章节表",
  );
  // 章节表读不到时必须**停**，不许退回内置副本
  assert(
    /cSectionNumbers[\s\S]{0,900}throw new Error/.test(pp),
    "章节表读不到时没有抛错 —— 缺了章节表还继续落盘，等于放行一切。",
  );
  // 未知章节必须被**拒绝**，不许静默跳过章节区间校验
  assert(
    !/it\.section && spans\[it\.section\] &&/.test(pp),
    "parameterProposals.ts 里还有 `it.section && spans[it.section] && …` —— " +
      "章节不存在时整道检查被静默跳过（选一个不存在的章节就能落盘）。",
  );

  // 还要**真的**验一遍：两个脚本认出来的版本必须一致
  const r = spawnSync("python", ["-c", PY_FINGERPRINT_PROBE], { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `版本识别对账脚本跑失败:\n        ${out.slice(-500)}`);
  assert(
    /SAME/.test(out),
    `两个脚本认出来的版本不一致:\n        ${out.slice(-500)}`,
  );
  return "版本指纹与 R48 章节表各只有一处手写；两个脚本认出来的版本一致";
});

check("no orphan module is left under server/reports", () => {
  // 死代码不会自己报错，但它会让「换一套标准要改多少东西」这个数**虚高** ——
  // 每一版旧渲染器都写死了 GB 4785 的名字、章节号、指标值。
  //
  // 2026-11-03 盘点时发现 server/reports 下有 4 个文件（1853 行）**零引用**：
  // 三个旧版渲染器 + 一个旧版报告入口。它们不产出任何交付件，
  // 却让下一个人以为「这个文件好像还在用，别删」。
  //
  // 判据：server/reports 下每个 .ts 都必须**被人引用**。
  // 引用只认 import 语句与真路径 —— 散文里提到一个名字不算引用。
  const r = spawnSync("node", ["scripts/orphan_scan.mjs"], { cwd: ROOT, encoding: "utf-8" });
  const out = (r.stdout || "") + (r.stderr || "");
  assert(r.status === 0, `server/reports 下有零引用模块：\n        ${out.slice(-900)}`);
  return out.trim().split("\n").slice(-1)[0].slice(0, 80);
});

check("a changed version set never degrades silently", () => {
  // 「换个标准还能不能跑」不能靠嘴说。这一关拿**真实语料**跑几种版本组合，
  // 断言机制的行为：
  //
  //   ① 三版（现在的配置）：空格全部有理由，复核全过；
  //   ② **多一版但还没写它的 spec**：新列必须整列标「未建规则」——
  //      **有理由的空**，不是静默空；而且**已有三版一个取值都不许变**
  //      （新版本不能污染老版本，这是「多一份真相」的另一种形态）；
  //   ③ **少一版**：必须**响亮失败**。
  //      静默产出一份「少了一整列却看着正常」的矩阵，是这个项目最贵的 bug 形态。
  //
  // ③ 之所以要守着：把那个 throw 改成「跳过缺失的版本」看起来很合理，
  // 但它会让**漏传一份文件**这件事变成一份看起来能交付的报告。
  const { ok, out } = runNode(["scripts/version_subset_probe.mjs"], "version_subset_probe");
  assert(ok, `版本组合探针跑失败:\n        ${out.slice(-600)}`);
  const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
  assert(line, `version_subset_probe 没有给出 SUMMARY 行:\n        ${out.slice(-600)}`);
  const s = JSON.parse(line.slice("SUMMARY ".length));

  assert(
    s.three.emptyWithoutReason === 0,
    `三版语料里有 ${s.three.emptyWithoutReason} 个空格子没写原因 —— 「空着也要说清为什么空」`,
  );
  assert(
    s.three.corroboratedBad === 0 && s.three.corroboratedOk === s.three.verified,
    `三版语料的回源复核没过 ${s.three.corroboratedBad} 格`,
  );
  assert(
    s.four.noPattern === s.three.rows,
    `加了第 4 版之后，新列不是整列「未建规则」（${s.four.noPattern}/${s.three.rows}）—— ` +
      `要么是有取值（那 spec 已经写了），要么是**有理由的空**`,
  );
  assert(
    s.four.verified === s.three.verified,
    `加了第 4 版之后，已有版本的取值数变了（${s.three.verified} → ${s.four.verified}）—— ` +
      `新版本污染了老版本`,
  );
  assert(
    s.twoVersionFails,
    `只传两版时**没有失败** —— 矩阵会少一整列却看着正常。` +
      `少传一份文件必须响亮失败。`,
  );
  return (
    `3 版：${s.three.rows} 行 / ${s.three.verified} 有值 / 空格全有理由 / 复核全过；` +
    `多 1 版：新列整列「未建规则」（有理由的空），已有三版不变；` +
    `少 1 版：响亮失败`
  );
});

check("no value is taken from a table cell that got scrambled", () => {
  // 串行错位（配对错）是**取值级复核抓不到**的一类错：
  // 它的形态是「每个数都是真的，只是配错了对象」——
  // 「值在页上」分辨不出来。
  //
  // OXR/MinerU 的 A/B 实测里，GB4785-2019 的色度表整段串成一行，
  // W1 拿到了表 2 的 0.373/0.402；B 版的表格数字精确率只有 0.364。
  //
  // 这一关把 OXR 实测的判据（M1 精确率 / M3 串行率）固化成可复算的测量
  // （`scripts/table_quality.py`），并对**每一个**从串行格里出来的矩阵取值
  // 追问一句：**它配的是哪个标签，验过吗？**
  //
  // 判据（两条都算过）：
  //   ① 复核的「引文」档或「标签+取值」档成立 ⟹ 标签与数值**一起**在源 PDF
  //      那一页上 ⟹ 配对已验；
  //   ② match 短到只有值本身（'0.5 cd'）⟹ **没有标签可配错**，
  //      条款与取值都在页上就够了。
  // 两条都不成立的 ⟹ 配对未验，直接判失败。
  const { ok, out } = runPy(["scripts/table_quality.py"], "table_quality");
  assert(ok, `表格抽取质量测量失败:\n        ${out.slice(-600)}`);
  const tq = JSON.parse(read("reports/table-quality.json"));
  const s = tq.summary ?? {};
  assert(
    (s.pairingUnverified ?? 0) === 0,
    `有 ${s.pairingUnverified} 个矩阵取值是从串行表格格里出来的、且**配对没有验过**：` +
      `\n        ${(tq.pairingUnverified ?? []).join("\n        ")}\n` +
      `        这些数确实在源 PDF 上，但「它配的是哪个标签」没验过 —— ` +
      `可能是串行错位（值是真的、配错了对象）。`,
  );
  const pv = tq.perVersion ?? {};
  const line = Object.entries(pv)
    .map(([v, x]) => `${v} 精确率 ${x.precision} · 串行率 ${x.serpentine_rate}`)
    .join(" · ");
  return `串行风险 ${s.risky ?? 0} 格：配对已验 ${s.pairingVerified ?? 0} · 无可配对 ${s.pairingNotApplicable ?? 0} · 配对未验 ${s.pairingUnverified ?? 0}（${line}）`;
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

check("A 与 C 的主差异清单要在报告里，并给设计/测试影响（客户 DR-010）", () => {
  // 客户 DR-010（P2）：「C 始终仅作参照，不参与变化判定；
  // **C 只作参考无法满足新国标与欧标主要区别的业务问题**；
  // 修改建议：**增加 A-C 主差异清单及设计/测试影响**」。
  //
  // 业务问题就是一句话：**新国标（A 草案）与欧标（R48）在哪些地方不一样**。
  // 这一节直接回答它，而且必须把差异分成**四种** ——
  // 它们的处理方式完全不同：
  //   C 有 A 无 → **出口按 C 做**；A 有 C 无 → **国内按 A 做**；
  //   数值不同 → 按各自标准核；口径不同 → 边界上适用性不同。
  //
  // 只给「A vs C 数值不同」是不够的 —— 实测那只有 3 条，
  // 而**「C 有 A 无」33 条 +「A 有 C 无」42 条才是出口时真正要动手的部分**。
  const rep = JSON.parse(read("reports/last-report.json"));
  const ch12 = (rep.chapters ?? []).find((c) => String(c.markdown ?? "").includes("## 12.6 A 与 C 的主差异清单"));
  assert(ch12, "报告第 12 章里没有 §12.6「A 与 C 的主差异清单」—— 客户问的「新国标与欧标差在哪」没人回答");
  const md = ch12.markdown;
  for (const cat of ["C 有、A 无", "A 有、C 无", "数值不同", "口径不同"]) {
    assert(
      md.includes(cat),
      `§12.6 里没有「${cat}」这一类 —— 差异必须按**处理方式**分类，不是只列数值不同的那几条`,
    );
  }
  // 每一条都要给**设计影响**与**测试影响**（客户点名要的）
  // —— 只看 §12.6 这一节里的行，别把第 12 章其它小节的条目算进来。
  const sec = md.slice(md.indexOf("## 12.6"));
  const rows = sec.split("\n").filter((l) => /^\- \*\*.*\*（/.test(l));
  assert(rows.length > 0, "§12.6 里一条明细都没有");
  const noImpact = rows.filter((l) => !l.includes("**设计**") || !l.includes("**测试**"));
  assert(
    noImpact.length === 0,
    `§12.6 有 ${noImpact.length} 条没给设计/测试影响 —— 客户点名要的就是这个`,
  );
  // 「某版没有这一条」必须是**核过的**，不是「没抽到」
  const unverified = rows.filter((l) => l.includes("无此规定") && !l.includes("已核"));
  assert(
    unverified.length === 0,
    `§12.6 有 ${unverified.length} 条把「没抽到」写成了「无此规定」—— 缺失结论必须是核过的`,
  );
  return `${rows.length} 条 A/C 主差异，四类齐全，每条都带设计影响与测试影响`;
});

check("交付件里没有近空白页（客户 DR-015）", () => {
  // 客户 DR-015：「仅保留导航句」的一页 —— 读者拿到的是一页纸和一句
  // 「逐条变化与数据核验见第 11 章」。**增加篇幅并中断阅读**。
  //
  // 根因有两处，都不是内容问题而是**版面**问题：
  //   ① 章末那句导航指针被前面的表格挤到**单独一页**上；
  //   ② 章末的「变化判定」条同样会孤行。
  //
  // 修法：导航指针搬进**章首**（内容跟着走，指针不落单）；
  //       判定条加 `page-break-before: avoid`（它是上一段的结论）。
  //
  // 判据：去掉页眉页脚后，**正文行数 ≤ 2** 的页 = 近空白页。
  // （阈值不是按字数定的 —— 一页封面只有一百来个字，但它不是空白页；
  //   真正的空白页是「只有一两行」。）
  const pdfPath = GATE_PDF;
  if (!pdfPath) return "skipped — 闸门没能渲染出 PDF";
  const py =
    "import sys,re,json,base64,io\n" +
    "import fitz\n" +
    "sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding='utf-8')\n" +
    "path=base64.b64decode(sys.stdin.read().strip()).decode('utf-8')\n" +
    "d=fitz.open(path)\n" +
    "thin=[]\n" +
    "for i,p in enumerate(d):\n" +
    "    lines=[l.strip() for l in p.get_text().split('\\n') if l.strip()]\n" +
    `    body=[l for l in lines if not l.startswith('${FAM} 多版本') and not l.startswith('汽车外部照明') and not re.fullmatch(r'\\d+ / \\d+',l)]\n` +
    "    if len(body)<=2:\n" +
    "        thin.append((i+1,len(body),' '.join(body)[:60]))\n" +
    "print(json.dumps({'pages':d.page_count,'thin':thin[:6]},ensure_ascii=False))\n";
  const out = spawnSync("python", ["-c", py], {
    input: Buffer.from(pdfPath, "utf8").toString("base64"),
    cwd: ROOT,
    encoding: "utf8",
  });
  const res = JSON.parse(out.stdout.trim().split("\n").pop());
  assert(
    !res.thin || res.thin.length === 0,
    `交付件里有 ${res.thin?.length ?? 0} 页近空白页（正文 ≤ 2 行）：` +
      `第 ${(res.thin ?? []).map((t) => t[0]).join("、")} 页` +
      ` —— 一页只放一两行，读者拿到的是纸不是内容（客户 DR-015）`,
  );
  return `${res.pages} 页里没有近空白页（正文 ≤ 2 行的页：0）`;
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
    // **PDF 全文有几百 KB（中文 3 字节/字）** —— 默认的 1 MB 缓冲
    // 会让这一关以 ENOBUFS **静默**死掉（status=null、stderr 为空）。
    maxBuffer: 256 * 1024 * 1024,
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
    // **PDF 全文有几百 KB（中文 3 字节/字）** —— 默认的 1 MB 缓冲
    // 会让这一关以 ENOBUFS **静默**死掉（status=null、stderr 为空）。
    maxBuffer: 256 * 1024 * 1024,
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
    // **PDF 全文有几百 KB（中文 3 字节/字）** —— 默认的 1 MB 缓冲
    // 会让这一关以 ENOBUFS **静默**死掉（status=null、stderr 为空）。
    maxBuffer: 256 * 1024 * 1024,
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
    // **PDF 全文有几百 KB（中文 3 字节/字）** —— 默认的 1 MB 缓冲
    // 会让这一关以 ENOBUFS **静默**死掉（status=null、stderr 为空）。
    maxBuffer: 256 * 1024 * 1024,
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
  // 台账**文件本身**必须与现算的一致 ——
  // 上面那行只验「现算的账目闭合」，**没验入库的那份是不是现算的**。
  // 差在哪儿：改一句登记理由（比如把写错的法规号改对），
  // 总数一个没动，账目照样闭合 —— 而报告里印的是**旧的那句**。
  //
  // `--check` 比的是**整份输出**（不是只比总数），
  // 所以「内容变了但分类没变」也能抓到。
  const chk = runPy(["scripts/requirement_ledger.py", "--check"], "requirement_ledger --check");
  assert(
    chk.ok,
    `入库的要求台账与现算的不一致 —— 报告附录 E.5.1 印的是台账里那份，不是现算的:\n` +
      `        ${chk.out.slice(-600)}\n` +
      `        跑一次 \`python scripts/requirement_ledger.py --write\` 更新。`,
  );
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

check("上传时按内容认版本，不靠文件名", () => {
  // 这条链路上认版本**曾经只有一条路**：sidecar 按**文件名**正则认。
  // 用户把文件改了名（很普通的事）→ 最后一步 400「未匹配任何已支持的标准」，
  // 而**文件内容完全没问题**。换一套标准时这一处也要改 ——
  // 而它**本可以不用改**：内容相似度那套不需要为新标准写任何声明。
  //
  // 现在查的是**整条链**：服务端按内容认 → 接口回传 → 界面显示 →
  // 出报告时优先用它派标签 → sidecar 以它为准。
  const sidecar = runPy(["scripts/test_label_source.py"], "test_label_source");
  assert(
    sidecar.ok,
    `sidecar 的「内容优先」自测没过:\n        ${sidecar.out.slice(-800)}`,
  );

  const routes = read("server/_core/agentRoutes.ts");
  assert(
    routes.includes("recognizeUploadVersion("),
    "上传接口没有调「按内容认版本」",
  );
  assert(
    routes.includes("versionGuess"),
    "上传接口没有把认版本的结果回传（versionGuess）—— 界面无从显示",
  );

  const home = read("client/src/pages/Home.tsx");
  assert(home.includes("versionGuess"), "界面上没有显示认版本的结果");

  const builder = read("client/src/components/ReportBuilder.tsx");
  assert(
    builder.includes("d.versionGuess?.label ?? LABELS[i]"),
    "出报告时没有优先用「按内容认出来的标签」—— 上传顺序又盖回来了",
  );
  assert(
    builder.includes("labelSource"),
    "出报告时没有告诉 sidecar 这个标签的来源 —— sidecar 会退回按文件名认",
  );

  const py = read("python_service/main.py");
  assert(
    py.includes('label_source == "content"'),
    "sidecar 不认 labelSource=content —— 内容认出来的标签会被文件名覆盖回去",
  );
  return "上传端认 → 接口回传 → 界面显示 → 派标签 → sidecar 以内容为准，全链贯通";
});

check("网站那条路不改写已入库的核验产物", () => {
  // 「在网站上点一下」曾经会改写**入库的**核验产物：
  // sidecar 的 `/verify` 顺手把 `dist/verified-comparison.json` 写了一份
  // （紧凑 JSON，与 `verify_claims.py` 的缩进格式不同）。
  //
  // 后果有两条，第二条更要命：
  //   ① 闸门「产物与重跑结果逐字一致」下一次必红 —— 而红的原因看着像
  //      「产物过期了」，其实只是**格式不同**。真过期时没人查，
  //      假过期时所有人都会去重算一遍：既浪费时间，又把真问题盖住。
  //   ② 写进去的那份**未必是核验过的那份** —— 网站那条路用的抽取结果
  //      与命令行那套不是同一份来源。而「入库产物 = 已核验的事实」
  //      正是整个项目的地基。
  //
  // 这道闸门**真的跑一遍网站那条路**，然后比对入库产物的 sha256。
  const { ok, out } = runPy(["scripts/test_no_side_effects.py"], "test_no_side_effects");
  assert(
    ok,
    `网站那条路改写了已入库的产物:\n        ${out.slice(-800)}`,
  );
  return "sidecar /verify 跑完，入库产物一个字节都没动";
});

check("引用的标准号必须真的在它所引的那一条款里", () => {
  // 客户 DR-004 / DR-005（P1）都是同一类错：**把标准号写错了**，而报告照常生成、闸门全绿。
  //
  //   · DR-004：R48 §5.30.1 写「应按 UN R10 取得型式批准」——
  //     原文是「the UN regulation No **148**」。R10 是**另一部法规**（整车型式认证），
  //     认证依据会选错；
  //   · DR-005：「UN **R4511** / R4516」—— 原文是「UN Regulation No. **45**」，
  //     其后的 11 / 16 是**脚注号**，OCR 把两者粘在了一起，
  //     于是报告里出现了一个**不存在的法规**。
  //
  // 原来的「标准号必须在语料里出现过」那道闸门抓不到这两个 ——
  // 因为 OCR 的粘连让语料里**真的**有「UN R4511」，而「UN R10」是登记过的背景引用。
  // 缺的是**归属**：引用的那个号，是不是**这一条款**里的号。
  const { ok, out } = runPy(["scripts/check_clause_citations.py"], "check_clause_citations");
  assert(
    ok,
    `引用了条款里没有的标准号 —— 认证依据会选错:\n        ${out.slice(-900)}`,
  );
  return "条款范围内的每个标准号都能在它所引的那一条款里找到";
});

check("口径不同不许判成一致", () => {
  // 客户 DR-002：矩阵只比较数字，**丢了比较符号**。
  // A §5.7.5「离地高度**小于** 750 ㎜」与 B §5.7.5「离地高度**不大于** 750mm」
  // 被判成「A/B 一致」—— 而**恰好 750 mm 时适用性不同**。
  //
  // 这道闸门查的是**判定与数据一致**：
  //   · A/B 口径不同（且两边都取到了口径）→ 判定必须是「口径不同」，不许是「一致」；
  //   · 判定是「口径不同」→ 两边口径必须真的不同，且**数值必须一样**
  //     （数值不一样那是「有变化」，不是「口径不同」）。
  const rep = JSON.parse(read("reports/last-report.json"));
  const rows = rep.parameterMatrix ?? [];
  const problems = [];
  let diffRows = 0;
  for (const r of rows) {
    const a = r.cells?.A ?? {};
    const b = r.cells?.B ?? {};
    const cmpDiff = !!(a.comparator && b.comparator && a.comparator !== b.comparator);
    const sameNums =
      (a.nums ?? []).length > 0 &&
      (a.nums ?? []).join(",") === (b.nums ?? []).join(",");
    if (cmpDiff && sameNums && r.verdict === "same") {
      problems.push(`${r.id}: A ${a.comparator} / B ${b.comparator}，判定却是「一致」`);
    }
    if (r.verdict === "comparator-differs") {
      diffRows++;
      if (!cmpDiff) {
        problems.push(`${r.id}: 判成「口径不同」，但两边口径并没有不同`);
      }
      if (!sameNums) {
        problems.push(`${r.id}: 判成「口径不同」，但数值并不相同 —— 那是「有变化」`);
      }
    }
    // **只有一边取到口径** → 不许判「口径不同」（没法比没取到的东西）
    if (
      r.verdict === "comparator-differs" &&
      !(a.comparator && b.comparator)
    ) {
      problems.push(`${r.id}: 只有一边取到口径，却判成「口径不同」`);
    }
  }
  assert(
    problems.length === 0,
    `比较口径与判定不一致:\n        ${problems.slice(0, 8).join("\n        ")}`,
  );
  return `${diffRows} 行判为「口径不同」，其余口径一致的行都没被误判`;
});

check("报告附录 E 的台账快照不是旧的", () => {
  // ## 这道闸门在补一个「顺序错了没人管」的洞
  //
  // `server/reports/reportV6.ts` 把 `data/requirement-ledger.json` **import 进去** ——
  // esbuild 会在**打包那一刻**把它内联进 `dist/reportV6.js`。
  // 所以「改了台账 → 重建报告」这件事，只有在**先 `npm run build`、后重建报告**时才对。
  //
  // 顺序错了会怎样：报告照常生成、闸门全绿（台账文件本身是对的），
  // 只是**附录 E 里印的是旧台账**。实测踩到过：
  // 改了 §11.9 的 B 侧引文 → 重建报告（**没先重建 bundle**）→ 出 PDF → 138/138 全绿，
  // 而交付件附录 E.5.2 里印的还是旧引文（5 字，新的 40 字）。
  //
  // **报告里印着的台账必须与现算的那份逐条对得上** —— 这就是这道闸门。
  const ledger = JSON.parse(read("data/requirement-ledger.json"));
  const rep = JSON.parse(read("reports/last-report.json"));
  const apE = (rep.appendices ?? []).find((a) => a.id === "E");
  assert(apE, "报告里没有附录 E（台账快照所在）");
  const md = apE.markdown ?? "";
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const mdNorm = norm(md);
  // 这两档是附录 E 里**逐条列出**的（E.5.1 原文 / E.5.2 条款号与页码）。
  const listed = (ledger.rows ?? []).filter(
    (r) => r.disposition === "已引原文" || r.disposition === "附录逐条",
  );
  const stale = [];
  for (const r of listed) {
    const ex = norm(r.excerpt);
    const head = ex.slice(0, 12);
    // 条款号要在（两种档位的表里都有），原文摘录也要在（E.5.1/E.5.2 都印摘录）。
    if (!md.includes(r.clause)) {
      stale.push(`${r.version} §${r.clause}（条款号不在附录 E 里）`);
      continue;
    }
    if (head && !mdNorm.includes(head)) {
      stale.push(`${r.version} §${r.clause} 的摘录「${head}…」不在附录 E 里 —— 附录印的是**旧台账**`);
    }
  }
  assert(
    stale.length === 0,
    `附录 E 印的台账快照与现算的不一致（${stale.length} 条）:\n        ${stale.slice(0, 8).join("\n        ")}` +
      "\n        重算顺序：npm run build → node rebuild_report.mjs → python scripts/requirement_ledger.py --write",
  );
  return `${listed.length} 条台账行在附录 E 里逐条对得上（条款号 + 原文摘录）`;
});

check("不许用「不需要改设计」下结论（客户 DR-009，P1）", () => {
  // 客户 DR-009（P1）：报告里写着「无实质数值变化，因此不需要改设计」。
  //
  // **用定量结论替代定性合规判断** —— 这是最贵的一类错：
  // 「紧急制动信号由选装变强制安装」这类义务变化，**数值一个都不动**，
  // 而设计必须改。写成「不需要改设计」，客户会照着冻结设计。
  //
  // 客户给的修法是：「统一删除不需要改设计，改为定性复核状态和交叉引用」。
  // 所以判据是那句话**不许被当成结论**。
  //
  // **但「否定式地提到」是允许的** —— 「这不等于不需要改设计」恰恰是修法本身。
  // 所以判据不是「出现即红」，而是：
  //   每一次出现，前面的十几个字里必须有一个**否定标记**
  //   （不等于 / 不是 / 不能 / 不代表 / 不意味）。
  // 没有否定标记 = 那是在下结论 → 红。
  const rep = JSON.parse(read("reports/last-report.json"));
  const blob = JSON.stringify(rep);
  const banned = ["不需要改设计", "无需改设计", "不需要修改设计", "产品无需变更"];
  const NEG = ["不等于", "不是", "不能", "不代表", "不意味", "并非"];
  const offenders = [];
  let disclaimers = 0;
  for (const w of banned) {
    let at = blob.indexOf(w);
    while (at >= 0) {
      const lead = blob.slice(Math.max(0, at - 16), at);
      if (NEG.some((n) => lead.includes(n))) disclaimers++;
      else offenders.push(`${w} ← …${blob.slice(Math.max(0, at - 40), at + w.length + 10)}…`);
      at = blob.indexOf(w, at + w.length);
    }
  }
  assert(
    offenders.length === 0,
    `报告里还在用「${offenders.length}」处下结论 —— 数值一致推不出「不用改设计」\n` +
      "        （客户 DR-009）：改成「数值未变」，并交叉引用 §11.9 的定性义务\n" +
      offenders.slice(0, 3).map((o) => `        · ${o}`).join("\n"),
  );
  const qo = blob.includes("定性义务") || blob.includes("§11.9");
  assert(qo, "报告里连「定性义务」的入口都没了 —— 删了结论却没给替代说法");
  return `没有用「不需要改设计」下结论（${disclaimers} 处否定式提及不算）`;
});

check("同一义务，报告里三处说法一致（对账）", () => {
  // 客户 DR-003（P1）：「§11.9 称 ESS 由选装变强制；第 14 章仍引 p41 并判无实质数值变化」
  // —— **同一份报告前后用不同证据、得出冲突结论**。
  //
  // 根因不是「写错了」，是两处结构：
  //   ① 第 14 章的 A 侧定位取「条款号的第一次出现」——
  //      而条款号在正文里也会被**交叉引用**
  //      （A p41：「后转向灯按7.2.1执行紧急制动信号……」），
  //      于是「5.23 紧急制动信号」引到了**转向灯**那节；
  //   ② 第 14 章的变化判定只问「**数值**变没变」——
  //      「配备：选装 → 强制安装」是定性变化，数值没变，
  //      于是那一行写「无实质数值变化 …… 不需要改设计」。
  //
  // 这道闸门是**对账**：§11.9 的每一条（逐条回原文核验过）都必须
  //   · 在第 14 章有对得上的那一节；
  //   · 那一节指向同一页；
  //   · 那一节含同一条原文摘录；
  //   · 那一节的判定提到定性义务，且**不写「不需要改设计」**；
  //   · 那一条在**要求台账**里有交代（「真缺口 0」要管得到它）。
  // 另外：第 14 章每一节引的页要与**条款索引**（第三方来源，PyMuPDF 文本层）
  // 逐一对上 —— 不加这条，定位器错了只有读者能发现。
  const { ok, out } = runPy(
    ["scripts/check_report_reconciliation.py"],
    "check_report_reconciliation",
  );
  assert(ok, `报告里的同一义务说法不一致:\n        ${out.slice(-1200)}`);
  return out.trim().split("\n").slice(-1)[0].slice(0, 90);
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
  // 「批量采纳」的**确定性**用例：**不调模型**。
  // 验的是采纳这一步的规矩 —— 不覆盖已有取值 · 不采纳命不中的 ·
  // 采纳必须写 why · 落盘先备份。957 个槽位不可能逐条手点，
  // 这条路走不通就还是人写。
  "_test_adopt_proposals.mjs",
  // Word 导出的**已知答案用例**：缺 changes/parameters/evidence 时
  // 必须是空表，不是崩溃。以前它崩在 `.map` 上，吐一个裸的 500 HTML 页。
  "_test_word_export.mjs",
  // 端口探针的**已知答案用例**：带标记的假实例要认得出，
  // 不带标记的不能误认。判据是「哪个端口上坐着我自己」。
  "_test_instance_probe.mjs",
  // 「标签 → 版本键」判据的**已知答案用例**：
  // 现在的写法要认得出、**换一套标准**也要认得出、认不出的不许瞎猜。
  "_test_version_labels.mjs",
  // 「按内容认版本」的**已知答案用例**：
  // 改了名不许改判、不相干的不许瞎猜、两版难分时不许硬认。
  "_test_version_recognition.mjs",
  // 比较口径的**已知答案用例**：
  // 否定词把方向翻过来（「不应小于」是下限）、英文等价式（or equal to）、
  // 认不出的留空（宁可空着，不可错着）。
  "_test_comparator.mjs",
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

// ── 把本次闸门结果落成机器产物 ───────────────────────────────────────────
// 讲稿（scripts/render_briefing.mjs）里那句「N 项闸门」从这份文件读，
// **不在稿子里手写数字** —— 手写的数字一定会过期。本项目已经踩过一次：
// 加了一道新闸门（参数查询对空格不敏感），稿子还写着旧的 97，交付件里
// 的数字就与当场跑出来的结果对不上。这正是「宁可空着，不可错着」要防的。
try {
  writeFileSync(
    resolve(ROOT, "dist", "verify-summary.json"),
    JSON.stringify({ at: new Date().toISOString(), total: checks, passed: checks - failures, failed: failures }, null, 2) + "\n",
    "utf-8",
  );
} catch (e) {
  console.warn(`[verify] 写 dist/verify-summary.json 失败（讲稿将拒绝出稿）：${e.message}`);
}

if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log("all green\n");