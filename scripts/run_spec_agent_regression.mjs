/**
 * **取值规格提议 agent 的泛化率实测**（真模型）。
 *
 * 做法：把 `data/parameter-specs.json` 里**已经手写好、并且已经回原文核过**的
 * 若干条正则**藏起来**，让 agent 从零重新找一遍，然后拿它跟**已知答案**比。
 *
 * 已知答案从哪来 —— `reports/last-report.json` 的参数矩阵：
 * 每一格的 clause / page / nums 都是已经过闸门核验的（条款号可查、
 * 引文回源验过、值在它引的条款里）。那是**这份项目里最可信的一份答案**。
 *
 * 判「对」的三个条件（缺一不可）：
 *   ① 条款号与已知答案一致  —— 抓对条款（抓错灯是这里最贵的错）
 *   ② 页码与已知答案一致    —— 没有串页
 *   ③ 取到的值落在已知答案的值里 —— 取到了这个参数自己的值
 *
 * 结果写进 `reports/spec-agent-baseline.json`（**记账**，不是闸门）——
 * 它会花钱、会有抖动，所以不进 `npm run verify`。
 *
 * 跑法：
 *   node scripts/run_spec_agent_regression.mjs --sample 12
 *   node scripts/run_spec_agent_regression.mjs --ids a,b,c
 */
import fs from "node:fs";
import { withKeyRotation } from "../dist/minimaxPool.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  deviceChapterPrefixes,
  candidateSentences,
  validateProposal,
  proposeSpec,
} from "../dist/specAgent.js";
// **记账规矩**（「没跑成」≠「没编造」）住在这一个文件里 ✓ ——
// 脚本与用例都 import 它 ✓ ⇒ 用例测的就是脚本跑的那份 ✓。
// （抄一份到用例里 = 两份实现会漂移 ✗）
import {
  commonFailure as commonFailureImpl,
  buildAbsentBlock,
  phaseOutcome,
} from "./run_spec_agent_regression_accounting.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf("--" + n);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const sampleSize = Number(opt("sample", "12") ?? 12);
const ids = (opt("ids", "") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dry = args.includes("--dry");

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

const specs = readJson(path.join(ROOT, "data", "parameter-specs.json"), { specs: [] }).specs ?? [];
const clauseIndex = readJson(path.join(ROOT, "data", "clause-index.json"), { _clauses: {} })._clauses ?? {};
const corpus = readJson(path.join(ROOT, "dist", "mineru-v4-data.json"), {});
const report = readJson(path.join(ROOT, "reports", "last-report.json"), { parameterMatrix: [] });

/* --- 挑样本：必须是「已知答案齐备 + 装置章号可推导」的槽位 ---------------- */
const cellsById = new Map();
for (const r of report.parameterMatrix ?? []) cellsById.set(r.id, r.cells ?? {});

const pool = [];
for (const s of specs) {
  const device = s.id.split(".")[0];
  for (const v of ["A", "B", "C"]) {
    const cell = cellsById.get(s.id)?.[v];
    if (!cell || cell.status !== "verified") continue;
    if (!cell.clause || !cell.nums?.length) continue;
    if (!s.patterns?.[v]) continue; // 本来就没有手写正则的（多为该版无此规定）
    // 装置在这一版要有兄弟正则，否则章号推不出来 —— 那是「数据不够」，
    // 不是「agent 不会」，两类不能混在一个分母里。
    const prefixes = deviceChapterPrefixes(specs, device, v);
    if (!prefixes.length) continue;
    pool.push({ spec: s, version: v, device, cell, prefixes });
  }
}

// 覆盖不同的装置与版本，别都挑同一个灯
//
// ## 为什么**两轮**
//
// 原来只有一轮 ✗：每个装置**只取一条** ✗（`usedDevices.size < sampleSize/2` ✓）
// —— 于是「要求 120 条」在**装置数不够**时**永远达不到** ✗
// （实测：候选池 737 条 ✓、装置 50 个 ⇒ 只挑到 50 条 ✗，
//   而日志却写「池子不够」✗ —— **说反了** ✗：池子够 ✓，是**挑选规则**卡住的 ✗）。
//
// 现在：第一轮每个装置取一条 ✓（多样性 ✓），
// 第二轮**没凑够就补** ✓（同一装置可以再取 ✓）⇒ 「要求 N 条」真能到 N 条 ✓。
const picked = [];
const usedDevices = new Set();
const sorted = pool.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
const slotKey = (p) => `${p.spec.id}::${p.version}`;
const taken = new Set();
for (const p of sorted) {
  if (ids.length && !ids.includes(p.spec.id)) continue;
  if (picked.length >= sampleSize) break;
  if (usedDevices.has(p.device)) continue;
  usedDevices.add(p.device);
  taken.add(slotKey(p));
  picked.push(p);
}
// 第二轮 —— 补齐到**要求的条数** ✓（多样性已经尽力了 ✓）
if (!ids.length && picked.length < sampleSize) {
  for (const p of sorted) {
    if (picked.length >= sampleSize) break;
    const k = slotKey(p);
    if (taken.has(k)) continue;
    taken.add(k);
    picked.push(p);
  }
}
if (ids.length) {
  picked.length = 0;
  for (const p of sorted) if (ids.includes(p.spec.id)) picked.push(p);
}

const nDevices = new Set(picked.map((p) => p.device)).size;
console.log(
  `[regression] 样本 ${picked.length} 个（**要求 ${sampleSize}**·候选池 ${pool.length} 条·` +
    `装置 ${nDevices} 个）` +
    (picked.length < sampleSize
      ? ` —— **没凑够**：可选槽位只有 ${picked.length} 条可用` +
        `（要「已知答案齐备 + 装置章号可推导」，二者缺一就不进池子 ✓）`
      : ""),
);

/* --- 真模型调用 ---------------------------------------------------------- */
async function callModel(messages, tools) {
  const base = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn").replace(/\/$/, "");
  const body = JSON.stringify({
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
    messages,
    ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    max_tokens: Number(process.env.SPEC_AGENT_MAX_TOKENS ?? 40000),
    temperature: 0.1,
    stream: false,
  });
  // **key 池 + 传输层重试** ✓ —— 与服务端**同一份实现** ✓
  // （`server/_core/minimaxPool.ts` 的 `withKeyRotation` ✓）。
  //
  // 原来这里只读 `MINIMAX_API_KEY` ✗：撞上 402 就直接「没跑成」✗，
  // 而 `.env` 里的兜底 key **明明可用** ✓（实测 ✓）——
  // 于是「额度不够」被误当成「没有别的办法」✗。
  const r = await withKeyRotation(
    async (key) => {
      const resp = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body,
      });
      const text = await resp.text();
      if (resp.status >= 200 && resp.status < 300) {
        return { ok: true, value: { status: resp.status, text } };
      }
      return { ok: false, status: resp.status, body: text };
    },
    { label: "spec-agent-regression" },
  );
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  }
  const j = JSON.parse(r.text);
  const msg = j?.choices?.[0]?.message ?? {};
  return {
    content: String(msg.content ?? ""),
    finishReason: j?.choices?.[0]?.finish_reason ?? "",
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  };
}

/* --- 逐个跑 -------------------------------------------------------------- */
const ctx = {
  clauseIndex,
  docFor(v) {
    return corpus[v];
  },
  prefixesFor: (d, v) => deviceChapterPrefixes(specs, d, v),
  // **按单位过滤** —— 不传单位时 `numbersOf(sentence, undefined)` 放行所有数字，
  // 单位不对的候选句也会进池子（那是模型挑错灯的温床）。
  candidatesFor: (d, v, p, unit) => candidateSentences(clauseIndex, v, p, { limit: 400, unit }),
};

const rows = [];
for (const [i, p] of picked.entries()) {
  const slot = {
    id: p.spec.id,
    name: p.spec.name,
    family: p.spec.family,
    unit: p.spec.unit,
    version: p.version,
    device: p.device,
  };
  const candidates = ctx.candidatesFor(p.device, p.version, p.prefixes, p.spec.unit);
  const label = `[${i + 1}/${picked.length}] ${p.spec.id} · ${p.version}`;
  let proposal;
  try {
    proposal = await proposeSpec(ctx, slot, candidates, callModel);
  } catch (e) {
    proposal = { ...slot, error: `agent 失败：${e.message}` };
  }
  const v = validateProposal(proposal, corpus[p.version], p.prefixes, { unit: p.spec.unit });

  const expectedClause = String(p.cell.clause ?? "");
  const expectedPage = Number(String(p.cell.page ?? "").replace(/[^0-9]/g, ""));
  const expectedNums = p.cell.nums ?? [];
  const gotNums = v.nums ?? [];

  const clauseOk = !!v.clause && expectedClause.startsWith(v.clause.split(".").slice(0, 2).join("."));
  const pageOk = !expectedPage || v.page === expectedPage;
  const valueOk = gotNums.length > 0 && gotNums.every((n) => expectedNums.includes(n));
  const pass = v.ok && clauseOk && pageOk && valueOk;

  rows.push({
    id: p.spec.id,
    name: p.spec.name,
    version: p.version,
    device: p.device,
    unit: p.spec.unit,
    expected: { clause: expectedClause, page: expectedPage, nums: expectedNums },
    got: { clause: v.clause ?? null, page: v.page ?? null, nums: gotNums },
    source: proposal.source ?? null,
    why: proposal.why ?? proposal.absent ?? "",
    validation: v.reason ?? null,
    // **错误也要记**：没有这一栏，失败只会显示成「没有产出正则」，
    // 分不清是「被截断」「轮次用尽」还是「模型就是没答」。
    error: proposal.error ?? null,
    pass,
  });

  console.log(
    `${label} ${p.spec.name} —— ${pass ? "✓ 对" : "✗ 错"}` +
      (pass
        ? `（§${v.clause} 第${v.page}页 ${JSON.stringify(gotNums)}）`
        : `｜期望 §${expectedClause} 第${expectedPage}页 ${JSON.stringify(expectedNums)}` +
          `｜实得 ${v.ok ? `§${v.clause} 第${v.page}页 ${JSON.stringify(gotNums)}` : (v.reason ?? "无产出")}` +
          // **错误要打出来** —— 只写「没有产出正则」的话，
          // 「模型调用失败」与「模型没找到」看起来一模一样。
          (proposal.error ? `｜⚠ ${String(proposal.error).slice(0, 160)}` : "")),
  );
}

const passed = rows.filter((r) => r.pass).length;
const rate = rows.length ? passed / rows.length : 0;
console.log(
  `\n[regression] ${passed}/${rows.length} 对（${(rate * 100).toFixed(0)}%）· ` +
    `条款对 ${rows.filter((r) => r.got.clause && r.expected.clause.startsWith(r.got.clause.split(".").slice(0, 2).join("."))).length}` +
    ` · 页码对 ${rows.filter((r) => r.got.page === r.expected.page).length}` +
    ` · 值对 ${rows.filter((r) => r.got.nums.length && r.got.nums.every((n) => r.expected.nums.includes(n))).length}`,
);

/* --- 第二阶段：**编造率**（比命中率更要紧） -----------------------------
 *
 * `data/parameter-specs.json` 里有 144 个槽位登记为「该版无此规定（已核）」——
 * 那是**逐条人工核过原文**的结论。agent 在这些槽位上如果给出一个**值**，
 * 那就是**编造法规**：它会把一句这一版根本没有的规定当成结论发给客户。
 *
 * 所以这里测的不是「agent 能不能找到」，而是「**agent 会不会乱说**」。
 * 期望：绝大多数判「该版无此规定」；给出值的要一条条看。
 * ------------------------------------------------------------------- */
const absentPool = [];
for (const s of specs) {
  for (const v of ["A", "B", "C"]) {
    if (!s.absent?.[v]) continue;
    if (s.patterns?.[v]) continue; // 已经同时有正则的，不算
    const device = s.id.split(".")[0];
    const prefixes = deviceChapterPrefixes(specs, device, v);
    if (!prefixes.length) continue; // 章号推不出来的，这一阶段不测
    absentPool.push({ spec: s, version: v, device, prefixes, reason: s.absent[v] });
  }
}
const absentSample = absentPool.slice(0, Math.max(4, Math.round(sampleSize / 3)));
const absentRows = [];
for (const [i, p] of absentSample.entries()) {
  const slot = {
    id: p.spec.id,
    name: p.spec.name,
    family: p.spec.family,
    unit: p.spec.unit,
    version: p.version,
    device: p.device,
  };
  const candidates = ctx.candidatesFor(p.device, p.version, p.prefixes, p.spec.unit);
  let proposal;
  try {
    proposal = await proposeSpec(ctx, slot, candidates, callModel);
  } catch (e) {
    proposal = { ...slot, error: `agent 失败：${e.message}` };
  }
  const v = validateProposal(proposal, corpus[p.version], p.prefixes, { unit: p.spec.unit });
  // **把「乱说」分成两类** —— 两类的后果不同，混在一起报会掩盖真正的问题：
  //   · **凭空生成**：那个数在原文里根本不存在 ⇒ 模型编的，最危险；
  //   · **误配量值**：那个数在原文里**确实存在**，但在**另一条要求**下
  //     （R48 的「参考值」对 GB 的「实测最大值」；R48 的「倾斜度限值」对
  //     GB 的「标注准确度」）⇒ 抓到了真的条款、真的数，但不是这个参数的量值。
  const corpusText = String(corpus[p.version]?.fullText ?? "");
  const gotNums = v.nums ?? [];
  const existsInCorpus = gotNums.length > 0 &&
    gotNums.every((n) => corpusText.includes(n) || corpusText.includes(n + ".0"));
  const fabricated = !!proposal.source && v.ok;
  // **「没跑成」与「跑成了、但模型没乱说」必须分开** ✓
  //
  // 这一段测的是**编造率** —— 它是整份回归里**最要紧**的数 ✗：
  // agent 在「该版无此规定」的槽位上给出一个值 = 报告里多出一条这一版
  // 根本没有的规定 ⇒ 客户照着改设计 ⇒ **最贵的错** ✓。
  //
  // 而 402（额度用完）、网络断了、模型不可用 ⇒ 那一条**根本没跑** ✗。
  // 两种情况在 `fabricated` 这个布尔上**长得一模一样** ✗ ——
  // 「没跑成」被记成「没编造」⇒ 文件里写着 `fabricated: 0` ✗
  // ⇒ 读的人以为「编造问题解决了」✗，其实只是**模型没答** ✗。
  //
  // 实测（2026-11-13）：120 条那轮撞上 402 ⇒ 空槽 40 条里 **28 条没跑成** ✗
  // ⇒ 文件写 `fabricated: 0`（上一轮是 **4**）✗ —— 读起来像「修好了」✗。
  //
  // 所以：**错误要记下来** ✓，且**没跑成的单独计数** ✓。
  const notRun = !!proposal.error;
  const kind = notRun
    ? "not-run"
    : !fabricated
      ? proposal.absent
        ? "said-absent"
        : "no-conclusion"
      : existsInCorpus
        ? "wrong-quantity"
        : "hallucinated";
  absentRows.push({
    id: p.spec.id,
    name: p.spec.name,
    version: p.version,
    reason: p.reason,
    saidAbsent: !!proposal.absent,
    fabricated,
    kind,
    // **错误也记** ✓ —— 否则「没跑成」与「模型没找到」在文件里无法区分 ✗
    error: proposal.error ?? null,
    source: proposal.source ?? null,
    got: { clause: v.clause ?? null, nums: gotNums },
  });
  console.log(
    `[空槽 ${i + 1}/${absentSample.length}] ${p.spec.id} · ${p.version} —— ` +
      (notRun
        ? `⚠ **没跑成**（${String(proposal.error).slice(0, 120)}）`
        : proposal.absent
          ? "✓ 判「该版无此规定」（与人工核验一致）"
          : kind === "wrong-quantity"
            ? `✗ **误配量值** ${JSON.stringify(gotNums)} @ §${v.clause}（数是真的，但不是这个参数的量值）`
            : kind === "hallucinated"
              ? `✗✗ **凭空生成** ${JSON.stringify(gotNums)} —— 原文里没有这个数`
              : `△ 没能给出结论（${v.reason ?? "无产出"}）`),
  );
}
const fab = absentRows.filter((r) => r.fabricated).length;
const wrongQty = absentRows.filter((r) => r.kind === "wrong-quantity").length;
const halluc = absentRows.filter((r) => r.kind === "hallucinated").length;
const saidAbsent = absentRows.filter((r) => r.saidAbsent).length;
const notRun = absentRows.filter((r) => r.kind === "not-run").length;
// **真正跑成的那几条** —— 分母是它，不是样本总数 ✓
const ranCount = absentRows.length - notRun;
console.log(
  `\n[regression] 空槽复核 ${absentRows.length} 条（**跑成 ${ranCount}**${notRun ? ` · 没跑成 ${notRun}` : ""}）：` +
    `判「无此规定」 ${saidAbsent} · **误配量值 ${wrongQty}** · **凭空生成 ${halluc}**` +
    (notRun ? ` · **没跑成 ${notRun}（不计入上面的数）**` : ""),
);
if (notRun) {
  console.log(
    `[regression] ⚠ 有 ${notRun} 条**根本没跑成**（额度/网络/模型）—— ` +
      `上面那些数**只覆盖跑成的那 ${ranCount} 条** ✓，` +
      `不能当成「全样本 ${absentRows.length} 条都没编造」✗。`,
  );
}
if (fab > 0) {
  console.log("[regression] ⚠ 这两类都意味着「报告里会多出一条这一版没有的规定」—— 逐条人工看：");
  for (const r of absentRows.filter((x) => x.fabricated)) {
    console.log(`   · [${r.kind}] ${r.id} ${r.version} → ${JSON.stringify(r.got.nums)} @ §${r.got.clause}`);
    console.log(`     人工核验的理由：${r.reason}`);
  }
}

/**
 * 这一轮**是不是根本没跑成**。
 *
 * 全部槽位都失败、而且错的是**同一件事**（余额不足、模型不可用、网络断了）——
 * 那不是「泛化率 0」，是**一次都没跑成**。
 *
 * 两者必须分开记：把「没跑成」记成「0 分」，会让人以为泛化能力崩了；
 * 而它还会**覆盖掉上一次的真结果** ✗。
 */
function commonFailure(rows) {
  return commonFailureImpl(rows);
}

const didNotRun = commonFailure(rows);
// **主回归那半边**的「跑成几条」✓ ——
// API 失败的那几条**不是「agent 不会」** ✗（是「模型没答」✗），
// 混进「答错」里会把泛化率**压低** ✗ ⇒ 两个数都记 ✓（`rate` 与 `rateOverRan` ✓）。
const mainNotRun = rows.filter((r) => r.error).length;
const mainOutcome = phaseOutcome(rows.length, mainNotRun, didNotRun);
if (mainOutcome.systemic) {
  console.log(
    "\n[regression] ⚠⚠ 主回归**基本没跑成**（跑成 " +
      `${mainOutcome.ran} / ${rows.length}）—— 不是泛化率问题：` +
      `${String(didNotRun ?? "大量槽位调用失败").slice(0, 140)}\n` +
      "          （余额 / 模型可用性 / 网络）—— 这次的结果**不写进** baseline，" +
      "上一次的真结果保留。",
  );
} else if (mainNotRun) {
  console.log(
    `[regression] 主回归里有 ${mainNotRun} 条**没跑成**（调用失败 ✓）—— ` +
      `泛化率按**跑成的 ${mainOutcome.ran} 条**算是 ` +
      `${mainOutcome.ran ? (rows.filter((r) => r.pass).length / mainOutcome.ran * 100).toFixed(0) : "0"}%` +
      `（含失败的保守口径是 ${(rate * 100).toFixed(0)}%）✓`,
  );
}

// 空槽（编造率）那半边**单独判**「没跑成」 ✓
//
// 为什么不能跟主回归共用一个判据 ✓：两半的**分母不一样** ✓ ——
// 主回归 50 条全跑成、编造率那半边 28 条没跑成，是**可能同时发生**的 ✗
// （实测 2026-11-13：主回归 44/50 ✓，而空槽 40 条里 28 条撞上 402 ✗）。
//
// 而共用一个判据的后果很具体 ✗：文件里写着 `fabricated: 0` ✓，
// 读的人以为「编造问题解决了」✗ —— 其实只是**模型没答** ✗。
//
// 所以：**全盘同一个错 ⇒ 这一半不写进 baseline** ✓（保留上一次的真结果 ✓）；
// **部分没跑成 ⇒ 写，但要写清楚「跑成几条 / 没跑成几条」** ✓。
const absentDidNotRun = commonFailure(absentRows);
const absentOutcome = phaseOutcome(
  absentRows.length,
  absentRows.filter((r) => r.kind === "not-run").length,
  absentDidNotRun,
);
if (absentOutcome.systemic) {
  console.log(
    "\n[regression] ⚠⚠ **编造率那半边基本没跑成**（跑成 " +
      `${absentOutcome.ran} / ${absentRows.length}）—— 不是「没编造」：` +
      `${String(absentOutcome.reason ?? "大量槽位调用失败").slice(0, 140)}\n` +
      "          （余额 / 模型可用性 / 网络）—— 这一半的结果**不写进** baseline，" +
      "上一次的真结果保留。",
  );
}

if (!dry && !mainOutcome.systemic) {
  const outPath = path.join(ROOT, "reports", "spec-agent-baseline.json");
  // 空槽那半边**没跑成** ⇒ **保留上一次的真结果** ✓，
  // 不要用这一轮的「0 条编造」把它盖掉 ✗。
  //
  // 实测（2026-11-13）：上一轮是真的 4 条编造 ✗；这一轮撞上 402 ⇒
  // 40 条里 39 条没跑成 ⇒ 写出来的 `fabricated: 0` ✗
  // ⇒ 读的人以为「编造问题解决了」✗ —— 其实只是**模型没答** ✗。
  // 这正是「宁可空着，不可错着」✗ —— **空着（保留旧值 + 标注）比错着好** ✓。
  const prev = readJson(outPath, null);
  const absentBlock = buildAbsentBlock({
    absentRows,
    absentDidNotRun: absentOutcome.systemic ? absentOutcome.reason : null,
    previous: prev?.absentCheck ?? null,
  });
  const passedCount = rows.filter((r) => r.pass).length;
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        _comment:
          "取值规格提议 agent 的**泛化率实测**（真模型，藏起已知答案重找）。" +
          "这是记账，不是闸门 —— 它调模型、会花钱、会有抖动。" +
          "**读法**：`rate` 是保守口径（含没跑成的）✓；`rateOverRan` 只算**真跑成**的那些 ✓；" +
          "`ran` / `notRun` 说明这一轮**真的跑了几条** ✓ —— " +
          "`absentCheck.ran` / `absentCheck.notRun` 说明编造率那半边跑成了几条 ✓，" +
          "**`fabricated` 只覆盖跑成的那几条** ✗。" +
          "（`_carriedOver` / `_notRun` 表示这一半没跑成 ✓。）",
        sampleSize: rows.length,
        ran: mainOutcome.ran,
        notRun: mainOutcome.notRun,
        passed: passedCount,
        rate: Number(rate.toFixed(3)),
        // **只按跑成的算** ✓ —— API 失败不是「agent 不会」✗
        rateOverRan: mainOutcome.ran
          ? Number((passedCount / mainOutcome.ran).toFixed(3))
          : null,
        rows,
        absentCheck: absentBlock,
      },
      null,
      1,
    ) + "\n",
    "utf-8",
  );
  console.log(`[regression] 已写出 ${path.relative(ROOT, outPath)}`);
}
