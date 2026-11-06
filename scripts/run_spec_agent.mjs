/**
 * **取值规格提议 agent** 的命令行入口。
 *
 * 用途：给 `data/parameter-specs.json` 里**缺某一版**的参数槽位，
 * 让 agent 从原文里提议一条条款锚定的正则，并**当场用抽取器的语义验一遍**。
 *
 * 产物写进 `data/parameter-specs-agent.json`（**提议**，不是 spec），
 * 人工确认后才并进 `data/parameter-specs.json`。
 *
 * 跑法：
 *   node scripts/run_spec_agent.mjs                    # 所有缺规则的槽位
 *   node scripts/run_spec_agent.mjs --only headlamp.maxHeight
 *   node scripts/run_spec_agent.mjs --versions C --limit 20
 *   node scripts/run_spec_agent.mjs --hide headlamp.maxHeight,brakeLamp.height
 *        # **把已有的手写正则藏起来**，让 agent 自己重新找 ——
 *        # 这是「泛化性」的已知答案回归：藏起来的答案是已知的。
 *   node scripts/run_spec_agent.mjs --dry             # 只打印，不写文件
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

const SPECS = path.join(ROOT, "data", "parameter-specs.json");
const INDEX = path.join(ROOT, "data", "clause-index.json");
const CORPUS = path.join(ROOT, "dist", "mineru-v4-data.json");
const OUT = path.join(ROOT, "data", "parameter-specs-agent.json");

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const has = (name) => args.includes("--" + name);

const only = opt("only");
const versions = (opt("versions", "A,B,C") ?? "A,B,C").split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(opt("limit", "0") ?? 0);
const dry = has("dry");
const hideIds = new Set(
  (opt("hide", "") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/* -------------------------------------------------------------------------- */
/* MiniMax 的工具调用循环                                                     */
/* -------------------------------------------------------------------------- */

/**
 * MiniMax 的 OpenAI 兼容层有两处不按规范来（踩过）：
 *  ① `tool_choice:"none"` 不生效 —— 它把工具调用**写成正文里的文本标记**，
 *     所以收口轮要**整个不发 `tools` 字段**；
 *  ② `messages` 里塞一个裸字符串会回 400，而且这个 400 **只在下一轮出现**，
 *     表现为「agent 突然不说话了」。所以每条消息都必须是对象。
 */
async function callModel(messages, tools) {
  const base = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.cn").replace(/\/$/, "");
  const url = `${base}/v1/chat/completions`;
  const key = process.env.MINIMAX_API_KEY ?? "";
  if (!key) throw new Error("MINIMAX_API_KEY 未配置（.env）");
  const body = {
    model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
    messages,
    ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
    // **M3 会先输出一整段 `<think>` 思考**，而思考和答案共用这个预算 ——
    // 8192 不够用时，模型思考完就被截断，JSON 根本没输出出来
    // （实测：思考用了预算的绝大部分，回答被砍在半路）。
    max_tokens: Number(process.env.SPEC_AGENT_MAX_TOKENS ?? 40000),
    temperature: 0.1,
    stream: false,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  const j = await r.json();
  const msg = j?.choices?.[0]?.message ?? {};
  const raw = String(msg.content ?? "");
  return {
    // `<think>` 的剥离在模块里统一做（stripThink）——
    // 这里只负责传输，免得两处各剥一次、剥得不一样。
    content: raw,
    raw,
    finishReason: j?.choices?.[0]?.finish_reason ?? "",
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
  };
}



/* -------------------------------------------------------------------------- */
/* 主流程                                                                     */
/* -------------------------------------------------------------------------- */

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

const specsDoc = readJson(SPECS, { specs: [] });
const specs = specsDoc.specs ?? [];
const clauseIndex = readJson(INDEX, { _clauses: {} })._clauses ?? {};
const corpus = readJson(CORPUS, {});

/** 藏起来的槽位：把已有的手写正则从**内存里的副本**删掉，agent 看不见。 */
const workingSpecs = specs.map((s) => {
  if (!hideIds.has(s.id)) return s;
  const patterns = { ...(s.patterns ?? {}) };
  for (const v of versions) delete patterns[v];
  return { ...s, patterns };
});

const ctx = {
  clauseIndex,
  docFor(v) {
    return corpus[v];
  },
  prefixesFor(dev, v) {
    return deviceChapterPrefixes(workingSpecs, dev, v);
  },
  candidatesFor(dev, v, prefixes, unit) {
    if (!prefixes.length) return [];
    // **按单位过滤** —— 不传单位时 `numbersOf(sentence, undefined)` 放行所有数字，
    // 单位不对的候选句也会进池子（模型挑错灯的温床）。
    return candidateSentences(clauseIndex, v, prefixes, { limit: 400, unit });
  },
};

const slots = [];
const absentSlots = [];
for (const s of workingSpecs) {
  for (const v of versions) {
    if (s.patterns?.[v]) continue;
    const base = {
      id: s.id,
      name: s.name,
      family: s.family,
      unit: s.unit,
      version: v,
      device: s.id.split(".")[0],
    };
    // **已经登记为「该版无此规定（已核）」的槽位不再提议** ——
    // 那 144 条是逐条人工核过原文的结论，带着理由。
    // agent 在这些槽位上的职责不是「再找一次」，而是**独立复核**：
    // 它要是给出一个值，那就是**编造法规**，比空着坏一个数量级。
    if (s.absent?.[v]) {
      absentSlots.push({ ...base, absentReason: s.absent[v] });
      continue;
    }
    slots.push(base);
  }
}

// `--verify-absent`：让 agent **独立复核**那 144 个「该版无此规定」的结论。
// 这不是「再找一次值」——是问它「这一版到底有没有这条要求」。
// 它给出一个值 = 它认为人工的结论错了，那一条必须立刻被人看。
const verifyAbsent = has("verify-absent");
if (verifyAbsent) {
  slots.length = 0;
  slots.push(...absentSlots);
}

let todo = slots;
if (hideIds.size) {
  // 回归模式：只跑**被藏起来的**那些槽位。
  // 其余本来就缺规则的槽位（多为「该版无此规定」）不是这次要测的。
  todo = todo.filter((s) => hideIds.has(s.id));
}
if (only) todo = todo.filter((s) => s.id === only || s.id.startsWith(only + "."));
if (limit > 0) todo = todo.slice(0, limit);

console.log(
  `[spec-agent] ${todo.length} 个槽位待提议` +
    (hideIds.size ? `（藏起 ${hideIds.size} 个已有正则做回归）` : "") +
    (verifyAbsent ? "（**独立复核**「该版无此规定」的既有结论）" : ""),
);

const results = [];
for (const [i, slot] of todo.entries()) {
  const prefixes = ctx.prefixesFor(slot.device, slot.version);
  const candidates = ctx.candidatesFor(slot.device, slot.version, prefixes, slot.unit);
  const label = `[${i + 1}/${todo.length}] ${slot.id} · ${slot.version} · ${slot.name}`;
  if (!prefixes.length) {
    console.log(`${label} —— 跳过：这个装置在这一版没有兄弟正则，章号未知`);
    results.push({ ...slot, error: "章号未知（该装置在这一版没有任何兄弟参数有正则）", prefixes: [] });
    continue;
  }
  if (!candidates.length) {
    console.log(`${label} —— 跳过：候选句为空`);
    results.push({ ...slot, error: "候选句为空", prefixes });
    continue;
  }
  let proposal;
  try {
    proposal = await proposeSpec(ctx, slot, candidates, (messages, tools) =>
      callModel(messages, tools),
    );
    if (typeof proposal.error === "string" && proposal.error.includes("__TRUNCATED__")) {
      proposal = {
        ...proposal,
        error:
          "模型回答被**截断**（思考吃光了 token 预算）—— " +
          "调大 SPEC_AGENT_MAX_TOKENS，或把候选句裁短",
      };
    }
  } catch (e) {
    proposal = { ...slot, error: `agent 失败：${e.message}` };
  }
  const v = validateProposal(proposal, corpus[slot.version], prefixes, { unit: slot.unit });

  // ---- 口径对账：与**同族其他版本**比口径 ------------------------------
  //
  // 数值层看不出「不大于」与「小于」的差别。口径不一样却判成「一致」，
  // 比判成「有变化」更坏 —— 客户照着「一致」就以为不用改设计。
  //
  // 所以拿**抽取器自己的口径判定**（`validateProposal` 复刻同一套语义）
  // 算一遍同族其他版本的口径，与提议比。对不上 → **进残余，不自动采纳**。
  let comparatorNote = null;
  if (v.ok && v.comparator) {
    for (const ov of versions) {
      if (ov === slot.version) continue;
      const osp = specs.find((s) => s.id === slot.id);
      const pat = (osp?.patterns ?? {})[ov];
      if (!pat?.source) continue;
      const oPrefixes = ctx.prefixesFor(slot.device, ov);
      const ov2 = validateProposal(
        { id: slot.id, version: ov, device: slot.device, name: osp.name ?? slot.id, source: pat.source, flags: pat.flags ?? "i" },
        corpus[ov],
        oPrefixes,
        { unit: slot.unit },
      );
      if (!ov2.ok || !ov2.comparator) continue;
      if (ov2.comparator !== v.comparator) {
        comparatorNote = `口径与 ${ov} 版不同（${ov2.comparator} vs ${v.comparator}）`;
        break;
      }
    }
  }
  const rec = {
    id: slot.id,
    name: slot.name,
    family: slot.family,
    unit: slot.unit,
    version: slot.version,
    device: slot.device,
    prefixes,
    source: proposal.source ?? null,
    flags: proposal.flags ?? null,
    why: proposal.why ?? "",
    absent: proposal.absent ?? null,
    error: proposal.error ?? null,
    validation: v,
    // 口径（≤/</≥/>/=）—— 数值层看不出它，报告里却按它判「一致 / 变化」。
    comparator: v.comparator ?? null,
    // 与同族其他版本口径对不上 —— **进残余，不自动采纳**。
    comparatorNote,
    // 独立复核模式下，这一条**人工核过的理由**记在这里 ——
    // 但**不给模型看**（模型只看到参数名/单位/候选句），
    // 否则就不是独立复核，而是让模型照抄结论。
    absentReason: slot.absentReason ?? null,
    kind: slot.absentReason
      ? proposal.absent
        ? "agrees-absent"
        : proposal.source && v.ok
          ? "disagrees-has-value"
          : "no-conclusion"
      : proposal.source
        ? "proposes"
        : proposal.absent
          ? "says-absent"
          : "none",
  };
  results.push(rec);
  const status = proposal.error
    ? "错误"
    : proposal.absent
      ? "判定无此规定"
      : v.ok
        ? slot.absentReason
          ? "**给出了值（与人工结论相反 —— 要人看）**"
          : "通过"
        : "被校验挡下";
  console.log(
    `${label} —— ${status}` +
      (v.ok && v.nums ? `：${JSON.stringify(v.nums)} @ §${v.clause} 第${v.page}页` : "") +
      (v.reason && !v.ok ? `：${v.reason}` : "") +
      (proposal.error ? `：${proposal.error}` : ""),
  );
  if (proposal.error && process.env.AGENT_DEBUG) {
    console.log("    [原始回答] " + String(proposal.error).slice(0, 900));
  }
  if (process.env.AGENT_DEBUG) {
    console.log("    [提议] " + (proposal.source ? `source=${proposal.source} flags=${proposal.flags}` : "(无 source)"));
    if (proposal.why) console.log("    [理由] " + proposal.why.slice(0, 300));
    if (proposal.absent) console.log("    [判定] " + proposal.absent.slice(0, 300));
  }
}

const ok = results.filter((r) => r.validation?.ok && r.source);
console.log(
  `\n[spec-agent] ${results.length} 个槽位：通过 ${ok.length} · ` +
    `判定无此规定 ${results.filter((r) => r.absent).length} · ` +
    `被挡下 ${results.filter((r) => !r.validation?.ok && !r.absent).length} · ` +
    `出错 ${results.filter((r) => r.error).length}`,
);
if (verifyAbsent) {
  const agree = results.filter((r) => r.kind === "agrees-absent").length;
  const disagree = results.filter((r) => r.kind === "disagrees-has-value").length;
  const silent = results.filter((r) => r.kind === "no-conclusion").length;
  console.log(
    `[spec-agent] 独立复核：与人工结论一致 ${agree} · **不一致 ${disagree}** · 无结论 ${silent}`,
  );
  if (disagree) {
    console.log("[spec-agent] ⚠ 下面这些 agent 认为「这一版其实有这条要求」，必须逐条人工看：");
    for (const r of results.filter((x) => x.kind === "disagrees-has-value")) {
      console.log(`   · ${r.id} ${r.version} → ${JSON.stringify(r.validation.nums)} @ §${r.validation.clause}`);
      console.log(`     人工核验的理由：${r.absentReason}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* 产物声明 —— 项目统一的形状                                                  */
/* -------------------------------------------------------------------------- */
/**
 * 「这份产物是谁、用什么、从哪份原料、什么时候做的」。
 *
 * 为什么要有：**源 PDF 一换，产物立刻作废**（指纹变了）；
 * 换个 prompt 跑出来的结果**分得清**（`_promptVersion`）；
 * 模型换了也**看得见**（`_model`）。
 *
 * 没有这三样，一份产物放在那儿，谁也说不清它是不是还作数。
 */
const gitSha = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
})();

const sourceSha = (() => {
  const doc = readJson(INDEX, {});
  const out = {};
  for (const [v, info] of Object.entries(doc._sourcePdfs ?? {})) {
    out[v] = info?.sha256 ?? "";
  }
  return out;
})();

const productHeader = {
  _generator: `scripts/run_spec_agent.mjs @ ${gitSha}`,
  _model: process.env.MINIMAX_MODEL ?? "MiniMax-M3",
  _promptVersion: process.env.SPEC_AGENT_PROMPT_VERSION ?? "spec-agent/2026-11-06",
  _sourceSha256: sourceSha,
  _builtAt: new Date().toISOString(),
};

/* -------------------------------------------------------------------------- */
/* 残余台账 —— 由**唯一写者**生成                                              */
/* -------------------------------------------------------------------------- */
/**
 * 残余（机器判不了的那些）由 `scripts/build_spec_residue.mjs` 生成 ——
 * 那是它的**唯一写者**。这里跑完调它一下，
 * 不在这里另写一份（两个写者迟早漂移）。
 */

// **这一轮是不是根本没跑成**（余额不足 / 模型不可用 / 网络断了）。
//
// 全盘同一个错 → 那不是「agent 提不出正则」，是**一次都没跑成**。
// 写出去会污染下游：一份「全是失败」的提议会流进采纳流程，
// 而残余台账会凭空多出几十条 R1 —— 看着像「机器不行」，其实是「没跑」。

function commonFailure(rs) {
  const errs = rs
    .map((r) => String(r.error ?? "").trim())
    .filter(Boolean)
    .map((e) => e.slice(0, 120));
  if (!errs.length || errs.length < rs.length) return null;
  const first = errs[0];
  if (!errs.every((e) => e === first)) return null;
  return first;
}

const didNotRun = commonFailure(results);
if (didNotRun) {
  console.log(
    `[spec-agent] ⚠⚠ 这一轮**根本没跑成** —— 不是 agent 的问题：\n          ${didNotRun}\n` +
      `          产物**不写**（免得污染残余台账与采纳流程）。`,
  );
}

if (!dry && !didNotRun) {
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        _comment:
          "**提议**，不是 spec。人工确认后并进 data/parameter-specs.json。" +
          "每条都带校验结果 —— 没通过校验的不要采纳。" +
          "机器判不了的那些在 data/spec-residue.json（按 R1/R2/R3 分档）。",
        ...productHeader,
        generatedBy: "scripts/run_spec_agent.mjs",
        rows: results,
      },
      null,
      1,
    ) + "\n",
    "utf-8",
  );
  console.log(`[spec-agent] 已写出 ${path.relative(ROOT, OUT)}`);

  // 残余台账 —— **唯一写者**是 `scripts/build_spec_residue.mjs`
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, "scripts", "build_spec_residue.mjs")], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    console.log(String(out).trim());
  } catch (e) {
    console.log(`[spec-agent] ⚠ 残余台账没生成：${e.message}`);
  }
} else {
  console.log("[spec-agent] --dry：未写文件");
}
