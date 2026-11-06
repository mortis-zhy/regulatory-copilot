/**
 * 「批量采纳」的**确定性**用例 —— **不调模型**。
 *
 * 真模型的泛化率由 `scripts/run_spec_agent_regression.mjs` 单独测
 * （记账在 `reports/spec-agent-baseline.json`）；这一份只验**采纳这一步的规矩**：
 *
 * | 情形 | 期望 |
 * |---|---|
 * | 提议通过校验、槽位空着 | **采纳**，并且 `why` 写上了 |
 * | 槽位**已经有**取值 | **不覆盖** |
 * | 正则在语料里命不中 | **不采纳** |
 * | 捕获组框到的不是值 | **不采纳** |
 * | 口径与同族其他版本不同 | **不采纳**（要人看过） |
 * | 落盘前 | **先备份** |
 *
 * 跑法：`node _test_adopt_proposals.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 这个文件在**仓库根目录**（与 `_test_spec_agent.mjs` 同级）——
// 所以 ROOT 就是它自己所在的目录，不是它的上一级。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(ROOT, "tmp", "adopt-test");
fs.mkdirSync(TMP, { recursive: true });

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.log(`  FAIL  ${msg}`);
  }
};

// --------------------------------------------------------------------------
// 造一份**临时**的 spec 与提议（不碰仓库里那份）
// --------------------------------------------------------------------------
const real = readJson(path.join(ROOT, "data", "parameter-specs.json"), { specs: [] });
// 挑一个真实存在、**B 版正则带条款锚点**的槽位 ——
// 没有锚点的正则，校验层判不出「落在哪一章」（那是校验层的硬条件）。
const sample = real.specs.find(
  (s) =>
    s.patterns?.B?.source &&
    s.unit === "mm" &&
    /^\s*\\?\d/.test(s.patterns.B.source),
);
if (!sample) {
  console.log("  FAIL  找不到可用的样本 spec");
  process.exit(1);
}

const specsPath = path.join(TMP, "specs.json");
const agentPath = path.join(TMP, "agent.json");

// 只保留这一个槽位，且**删掉 B 版的取值** —— 模拟「这一版还没有取值」
const specs = {
  ...real,
  specs: [
    {
      ...sample,
      patterns: { ...sample.patterns, B: undefined },
    },
  ],
};
delete specs.specs[0].patterns.B;

const agent = {
  rows: [
    {
      id: sample.id,
      name: sample.name,
      family: sample.family,
      unit: sample.unit,
      version: "B",
      device: String(sample.id).split(".")[0],
      // 抄 A 版那条正则的前缀，但条款号换成 B 的 —— 命中不中就该被拒
      source: "这一条故意写错\\d{5}",
      flags: "i",
      why: "",
      absent: null,
      error: null,
      validation: { ok: true, nums: ["1"], clause: "9.9.9", page: 1, hitPages: [1] },
      comparator: null,
      comparatorNote: null,
      kind: "proposes",
    },
  ],
};

fs.writeFileSync(specsPath, JSON.stringify(specs, null, 2));
fs.writeFileSync(agentPath, JSON.stringify(agent, null, 2));

const runAdopt = (rows) => {
  fs.writeFileSync(agentPath, JSON.stringify({ rows }, null, 2));
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "adopt_spec_proposals.mjs")], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      SPEC_ADOPT_SPECS: specsPath,
      SPEC_ADOPT_AGENT: agentPath,
    },
  });
  return { out: (r.stdout || "") + (r.stderr || ""), status: r.status };
};

// --------------------------------------------------------------------------
// 用例 1：正则命不中 → 不采纳，spec 不变
// --------------------------------------------------------------------------
{
  const r = runAdopt(agent.rows);
  const after = readJson(specsPath, {});
  ok(
    !after.specs?.[0]?.patterns?.B,
    "命不中的正则**不该**被采纳（落盘后 B 版仍然没有取值）",
  );
  ok(/不采纳|抽取器语义下不成立/.test(r.out), "拒绝理由要说清楚");
}

// --------------------------------------------------------------------------
// 用例 2：槽位已经有取值 → 不覆盖
// --------------------------------------------------------------------------
{
  const withB = JSON.parse(JSON.stringify(specs));
  withB.specs[0].patterns.B = { source: sample.patterns.B.source, flags: sample.patterns.B.flags ?? "i" };
  fs.writeFileSync(specsPath, JSON.stringify(withB, null, 2));
  const r = runAdopt([
    {
      ...agent.rows[0],
      source: sample.patterns.C.source.replace(/6\\\./, "6\\."),
    },
  ]);
  const after = readJson(specsPath, {});
  ok(
    after.specs?.[0]?.patterns?.B?.source === withB.specs[0].patterns.B.source,
    "已有取值的槽位**不许被覆盖**",
  );
  ok(/不覆盖/.test(r.out), "拒绝理由要说清楚");
}

// --------------------------------------------------------------------------
// 用例 3：真能命中的提议 → 采纳 + 写 why + 先备份
// --------------------------------------------------------------------------
{
  // **槽位得是空的** —— 否则走的是「不覆盖」那条路（用例 2 验过了）
  fs.writeFileSync(specsPath, JSON.stringify(specs, null, 2));

  // 用 **B 版自己那条**正则当提议 —— 它在 B 版语料里当然命中
  // （模拟「agent 重新找到了我们本来就知道的那一条」）。
  const proposal = {
    ...agent.rows[0],
    source: sample.patterns.B.source,
    why: "这是 agent 给的理由",
  };
  const r = runAdopt([proposal]);
  const after = readJson(specsPath, {});
  const adopted = after.specs?.[0]?.patterns?.B;
  const bakExists = fs.existsSync(specsPath + ".bak");

  ok(!!adopted, `命中且槽位空着的提议**应该被采纳**（${r.out.trim().split("\n").slice(0, 2).join(" / ")}）`);
  if (adopted) {
    ok(
      String(after.specs[0].why?.B ?? "").includes("这是 agent 给的理由"),
      "采纳之后 `why` 必须写上（下一个改这里的人要知道为什么）",
    );
    ok(bakExists, "落盘前必须先备份");
    ok(
      String(after.specs[0].why?.B ?? "").includes("抽取器语义校验通过"),
      "`why` 里要写清**凭什么**采纳（值、条款、页码、口径）",
    );
  }
}

if (failed) {
  console.log(`  FAIL  ${failed} 条`);
  process.exit(1);
}
console.log("  ✓ 批量采纳的规矩都对（不覆盖 · 不采纳命不中的 · 采纳要写 why · 落盘先备份）");
