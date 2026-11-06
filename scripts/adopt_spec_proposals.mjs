/**
 * **批量采纳** agent 的取值提议。
 *
 * ## 为什么要有这一步
 *
 * agent 的提议现在停在 `data/parameter-specs-agent.json` 里，
 * 要靠人在 `web/参数提议确认.html` **逐条点** + 手改正则 + 手写 `why`。
 * 957 个槽位 —— 逐条点是不现实的。
 *
 * 实测的 4 条 agent 提议落地时**全被手改过**，`why` 是空的 ——
 * 走的根本不是这条路。**这条路得走通。**
 *
 * ## 采纳的条件（全部满足才自动采纳）
 *
 * 1. **槽位存在**，且**这一版还没有取值**（不覆盖已采纳的）；
 * 2. **用抽取器的语义当场重验一遍**（`validateProposal`）——
 *    提议文件里那份校验是**当时**的语料上的结果，语料换了就得重验；
 * 3. **口径与同族其他版本一致** —— 口径不同**不自动采纳**：
 *    有可能真有一条「有变化」要摆给客户看，但那得**人**看一眼
 *    （判成「一致」比判成「有变化」更坏）。
 *
 * 没过条件的 → **留在残余台账里**（`data/spec-residue.json`），不硬塞。
 *
 * ## 落盘
 *
 * 先备份（`data/parameter-specs.json.bak`），再写；
 * 每条采纳都写 `why`（agent 的理由 + 采纳条件）——
 * `why` 不是装饰，是给下一个改这里的人看的。
 *
 * ## 用法
 *
 * ```
 * node scripts/adopt_spec_proposals.mjs           # 采纳（先备份）
 * node scripts/adopt_spec_proposals.mjs --dry     # 只打印，不写
 * node scripts/adopt_spec_proposals.mjs --check   # 只报「该采纳却没采纳」的
 * ```
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deviceChapterPrefixes, legacyChapterPrefixes, validateProposal } from "../dist/specAgent.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 路径可以由环境变量改 —— **测试要能在临时目录里跑这套逻辑**，
// 不能去动仓库里那份「全项目唯一的取值来源」。
const SPECS = process.env.SPEC_ADOPT_SPECS ?? path.join(ROOT, "data", "parameter-specs.json");
const AGENT = process.env.SPEC_ADOPT_AGENT ?? path.join(ROOT, "data", "parameter-specs-agent.json");
const CORPUS = process.env.SPEC_ADOPT_CORPUS ?? path.join(ROOT, "dist", "mineru-v4-data.json");

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const checkOnly = args.includes("--check");

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

const specsDoc = readJson(SPECS, { specs: [] });
const specs = specsDoc.specs ?? [];
const agent = readJson(AGENT, { rows: [] });
const corpus = readJson(CORPUS, {});

/**
 * 口径对账：同族其他版本的口径，与提议的口径比一比。
 *
 * 口径不一样**不自动采纳** —— 有可能真有一条「有变化」要摆给客户看，
 * 但那得人看一眼（数值层分不出「不大于」与「小于」）。
 */
function comparatorNote(proposal, spec, version) {
  if (!proposal.comparator) return null;
  for (const [v, pat] of Object.entries(spec.patterns ?? {})) {
    if (v === version || !pat?.source) continue;
    const prefixes = legacyChapterPrefixes(specs, String(spec.id).split(".")[0], v);
    if (!prefixes.length) continue;
    const other = validateProposal(
      {
        id: spec.id,
        version: v,
        device: String(spec.id).split(".")[0],
        name: spec.name ?? spec.id,
        source: pat.source,
        flags: pat.flags ?? "i",
      },
      corpus[v],
      prefixes,
      { unit: spec.unit },
    );
    if (!other.ok || !other.comparator) continue;
    if (other.comparator !== proposal.comparator) {
      return `口径与 ${v} 版不同（${other.comparator} vs ${proposal.comparator}）`;
    }
  }
  return null;
}

const adopted = [];
const refused = [];

for (const row of agent.rows ?? []) {
  const spec = specs.find((s) => s.id === row.id);
  if (!spec) {
    refused.push({ id: row.id, version: row.version, reason: "spec 里没有这个 id" });
    continue;
  }
  if (!row.source) {
    refused.push({
      id: row.id,
      version: row.version,
      reason: row.absent ? "提议的是「该版无此规定」—— 那不是取值，不进 spec" : "没有产出正则",
    });
    continue;
  }
  if (spec.patterns?.[row.version]) {
    refused.push({
      id: row.id,
      version: row.version,
      reason: `该行已经有 ${row.version} 的取值 —— 不覆盖`,
    });
    continue;
  }

  // **当场重验**（语料可能换了）
  const device = String(row.id).split(".")[0];
  const prefixes = deviceChapterPrefixes(specs, device, row.version);
  if (!prefixes.length) {
    refused.push({
      id: row.id,
      version: row.version,
      reason: "章号未知 —— 「命中落在对的章」这道校验做不了，不采纳",
    });
    continue;
  }
  const val = validateProposal(
    {
      id: row.id,
      version: row.version,
      device,
      name: spec.name ?? row.id,
      source: row.source,
      flags: row.flags ?? "i",
    },
    corpus[row.version],
    prefixes,
    { unit: spec.unit },
  );
  if (!val.ok) {
    refused.push({ id: row.id, version: row.version, reason: `抽取器语义下不成立：${val.reason}` });
    continue;
  }

  const note = comparatorNote(row, spec, row.version);
  if (note) {
    refused.push({ id: row.id, version: row.version, reason: `${note} —— 要人看过才能采纳` });
    continue;
  }

  adopted.push({
    id: row.id,
    version: row.version,
    source: row.source,
    flags: row.flags ?? "i",
    nums: val.nums,
    clause: val.clause,
    page: val.page,
    comparator: val.comparator ?? null,
    why: row.why ?? "",
  });
}

console.log(`[adopt] 提议 ${(agent.rows ?? []).length} 条 · 可自动采纳 ${adopted.length} · 不采纳 ${refused.length}`);
for (const a of adopted) {
  console.log(
    `  ✓ ${a.id} ${a.version}  ${JSON.stringify(a.nums)} @ §${a.clause} 第${a.page}页  口径=${a.comparator ?? "—"}`,
  );
}
for (const r of refused) {
  console.log(`  · ${r.id} ${r.version} —— ${r.reason}`);
}

if (checkOnly) {
  const pending = adopted.filter((a) => {
    const spec = specs.find((s) => s.id === a.id);
    return !spec?.patterns?.[a.version];
  });
  if (pending.length) {
    console.log(`[adopt] ⚠ 有 ${pending.length} 条**该采纳却没采纳** —— 跑 node scripts/adopt_spec_proposals.mjs`);
    process.exitCode = 1;
  } else {
    console.log("[adopt] 没有「该采纳却没采纳」的");
  }
  process.exit(process.exitCode ?? 0);
}

if (dry) {
  console.log("[adopt] --dry：未写文件");
  process.exit(0);
}

if (adopted.length === 0) {
  console.log("[adopt] 没什么可采纳的，未改动 spec");
  process.exit(0);
}

// 先备份再落盘 —— 这个文件是全项目唯一的取值来源，写坏了没有第二份。
fs.writeFileSync(SPECS + ".bak", fs.readFileSync(SPECS, "utf-8"), "utf-8");

for (const a of adopted) {
  const spec = specs.find((s) => s.id === a.id);
  spec.patterns = {
    ...(spec.patterns ?? {}),
    [a.version]: { source: a.source, flags: a.flags },
  };
  spec.why = {
    ...(spec.why ?? {}),
    [a.version]:
      (a.why?.trim() || "（agent 没给理由）") +
      `\n（由 scripts/adopt_spec_proposals.mjs 自动采纳：抽取器语义校验通过` +
      `（值 ${JSON.stringify(a.nums)} @ §${a.clause} 第${a.page}页` +
      `${a.comparator ? `，口径 ${a.comparator}` : ""}），口径与同族其他版本一致）`,
  };
}

fs.writeFileSync(SPECS, JSON.stringify({ ...specsDoc, specs }, null, 2) + "\n", "utf-8");
console.log(
  `[adopt] 已写入 ${path.relative(ROOT, SPECS)}（${adopted.length} 条）· 备份 ${path.relative(ROOT, SPECS + ".bak")}`,
);
console.log("[adopt] 下一步：npm run build && node rebuild_report.mjs && npm run verify");
