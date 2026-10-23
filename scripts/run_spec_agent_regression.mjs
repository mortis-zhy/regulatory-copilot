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
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  deviceChapterPrefixes,
  candidateSentences,
  validateProposal,
  proposeSpec,
} from "../dist/specAgent.js";

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
const picked = [];
const usedDevices = new Set();
const sorted = pool.sort((a, b) => a.spec.id.localeCompare(b.spec.id));
for (const p of sorted) {
  if (ids.length && !ids.includes(p.spec.id)) continue;
  if (picked.length >= sampleSize) break;
  if (usedDevices.has(p.device) && usedDevices.size < sampleSize / 2) continue;
  usedDevices.add(p.device);
  picked.push(p);
}
if (ids.length) {
  picked.length = 0;
  for (const p of sorted) if (ids.includes(p.spec.id)) picked.push(p);
}

console.log(
  `[regression] 样本 ${picked.length} 个（候选池 ${pool.length} 个）· ` +
    `装置 ${new Set(picked.map((p) => p.device)).size} 个`,
);

/* --- 真模型调用 ---------------------------------------------------------- */
async function callModel(messages, tools) {
  const base = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn").replace(/\/$/, "");
  const key = process.env.MINIMAX_API_KEY ?? "";
  if (!key) throw new Error("MINIMAX_API_KEY 未配置（.env）");
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
      messages,
      ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      max_tokens: Number(process.env.SPEC_AGENT_MAX_TOKENS ?? 40000),
      temperature: 0.1,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
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
  candidatesFor: (d, v, p) => candidateSentences(clauseIndex, v, p, { limit: 400 }),
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
  const candidates = ctx.candidatesFor(p.device, p.version, p.prefixes);
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
          `｜实得 ${v.ok ? `§${v.clause} 第${v.page}页 ${JSON.stringify(gotNums)}` : (v.reason ?? "无产出")}`),
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
  const candidates = ctx.candidatesFor(p.device, p.version, p.prefixes);
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
  const kind = !fabricated
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
    source: proposal.source ?? null,
    got: { clause: v.clause ?? null, nums: gotNums },
  });
  console.log(
    `[空槽 ${i + 1}/${absentSample.length}] ${p.spec.id} · ${p.version} —— ` +
      (proposal.absent
        ? "✓ 判「该版无此规定」（与人工核验一致）"
        : kind === "wrong-quantity"
          ? `✗ **误配量值** ${JSON.stringify(gotNums)} @ §${v.clause}（数是真的，但不是这个参数的量值）`
          : kind === "hallucinated"
            ? `✗✗ **凭空生成** ${JSON.stringify(gotNums)} —— 原文里没有这个数`
            : `△ 没能给出结论（${v.reason ?? proposal.error ?? "无产出"}）`),
  );
}
const fab = absentRows.filter((r) => r.fabricated).length;
const wrongQty = absentRows.filter((r) => r.kind === "wrong-quantity").length;
const halluc = absentRows.filter((r) => r.kind === "hallucinated").length;
const saidAbsent = absentRows.filter((r) => r.saidAbsent).length;
console.log(
  `\n[regression] 空槽复核 ${absentRows.length} 条：判「无此规定」 ${saidAbsent} · ` +
    `**误配量值 ${wrongQty}** · **凭空生成 ${halluc}** · 未结论 ${absentRows.length - saidAbsent - fab}`,
);
if (fab > 0) {
  console.log("[regression] ⚠ 这两类都意味着「报告里会多出一条这一版没有的规定」—— 逐条人工看：");
  for (const r of absentRows.filter((x) => x.fabricated)) {
    console.log(`   · [${r.kind}] ${r.id} ${r.version} → ${JSON.stringify(r.got.nums)} @ §${r.got.clause}`);
    console.log(`     人工核验的理由：${r.reason}`);
  }
}

if (!dry) {
  const outPath = path.join(ROOT, "reports", "spec-agent-baseline.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        _comment:
          "取值规格提议 agent 的**泛化率实测**（真模型，藏起已知答案重找）。" +
          "这是记账，不是闸门 —— 它调模型、会花钱、会有抖动。",
        sampleSize: rows.length,
        passed,
        rate: Number(rate.toFixed(3)),
        rows,
        absentCheck: {
          sampleSize: absentRows.length,
          saidAbsent: absentRows.filter((r) => r.saidAbsent).length,
          fabricated: fab,
          rows: absentRows,
        },
      },
      null,
      1,
    ) + "\n",
    "utf-8",
  );
  console.log(`[regression] 已写出 ${path.relative(ROOT, outPath)}`);
}
