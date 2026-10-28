#!/usr/bin/env node
/**
 * q —— 控制台查询台。
 *
 * 把 agent 的 7 个取证工具包成一条命令，**不调模型、不花钱**。
 * 网页上的问答要走 MiniMax（额度限制）；这里直接调工具本身 ——
 * 工具是确定性的，查出来的东西和 agent 查出来的是同一份。
 *
 * 用法：
 *   node scripts/q.mjs tools                         列出全部工具
 *   node scripts/q.mjs clause A 5.21.4.2             查某版某条款的原文 + 页码
 *   node scripts/q.mjs quote "离地高度不小于250mm"    回源查一句话
 *   node scripts/q.mjs param 倒车灯最大离地高度        查参数在三版的取值
 *   node scripts/q.mjs verdict 倒车灯最大离地高度     查该参数的差值裁定
 *   node scripts/q.mjs coverage                      查覆盖状态
 *   node scripts/q.mjs gaps A 20                     查某版的要求缺口
 *   node scripts/q.mjs topic 倒车灯                  查某主题的原文摘录
 */
import { runAgentTool, toolSchemas } from "../dist/agentTools.js";

const [, , cmd, ...rest] = process.argv;

/** 友好别名 → 工具真名（runAgentTool 只认真名） */
const ALIAS = {
  c: "lookup_clause",
  clause: "lookup_clause",
  q: "find_quote",
  quote: "find_quote",
  p: "lookup_parameter",
  param: "lookup_parameter",
  v: "get_diff_verdict",
  verdict: "get_diff_verdict",
  cov: "get_coverage_status",
  coverage: "get_coverage_status",
  g: "list_requirement_gaps",
  gaps: "list_requirement_gaps",
  t: "get_topic_excerpts",
  topic: "get_topic_excerpts",
  tools: "tools",
  h: "help",
  help: "help",
};

function usage() {
  console.log(`
q —— 控制台查询台（确定性，不调模型、不花钱）

  node scripts/q.mjs tools                        列出全部 7 个工具
  node scripts/q.mjs clause  <A|B|C> <条款号>      条款原文 + 页码
  node scripts/q.mjs quote   "<原文片段>"          回源查一句话
  node scripts/q.mjs param   "<参数名或 id>"       参数在三版的取值
  node scripts/q.mjs verdict "<参数名或 id>"       该参数的差值裁定
  node scripts/q.mjs coverage [scope]              覆盖状态（缺参数则全量）
  node scripts/q.mjs gaps    <A|B|C> [limit]        要求缺口清单
  node scripts/q.mjs topic   "<主题>"              某主题的原文摘录

例：
  node scripts/q.mjs clause A 5.21.4.2
  node scripts/q.mjs param 倒车灯最大离地高度
`);
}

function pick(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== "") out[k] = o[k];
  return out;
}

/** 把工具返回摊平成人眼能扫的形状（字段名对着 agentTools.ts 的真实返回写） */
function printResult(name, res) {
  const d = res?.data ?? {};
  if (!res?.ok) {
    console.log(`
✗ ${name} 没查到`);
    if (d.error) console.log(`  ${d.error}`);
    if (d.hint) console.log(`  提示：${d.hint}`);
    if (d.note) console.log(`  ${d.note}`);
    if (Array.isArray(d.available) && d.available.length) {
      console.log(`  可用主题：${d.available.slice(0, 30).join("、")}${d.available.length > 30 ? " …" : ""}`);
    }
    console.log("");
    return;
  }
  console.log("");
  switch (name) {
    case "lookup_clause": {
      console.log(`【${d.label}】 条款 ${d.clause}`);
      for (const m of d.matches ?? []) {
        console.log(`  · 来源 ${m.source}${m.topic ? ` / ${m.topic}` : ""}${m.page ? `  ${m.page}` : ""}`);
        console.log(`    ${m.excerpt}`);
        if (m.status) console.log(`    核验状态：${m.status}`);
        console.log("");
      }
      if (!(d.matches ?? []).length) console.log("  （无匹配）\n");
      break;
    }
    case "find_quote": {
      console.log(`回源查「${d.quote ?? ""}」`);
      for (const h of d.hits ?? []) {
        console.log(`  ✓ ${h.label ?? h.version}  ${(h.pages ?? []).join("、")}`);
      }
      const kw = (d.keywords ?? []).filter((k) => k.found);
      if (kw.length) {
        console.log(`  命中关键词（${kw.length}/${(d.keywords ?? []).length}）：`);
        for (const k of kw.slice(0, 12)) {
          console.log(`    · ${k.keyword}  ${(k.versions ?? []).map((v) => `${v.version} 第${v.page}页`).join("、")}`);
        }
      }
      if (d.note) console.log(`  ℹ ${d.note}`);
      console.log("");
      break;
    }
    case "lookup_parameter": {
      console.log(`参数：${d.name ?? d.id ?? ""}`);
      for (const [ver, cell] of Object.entries(d.cells ?? {})) {
        if (cell && typeof cell === "object") {
          const v = cell.value ?? cell.valueText ?? "—";
          console.log(`  ${ver}: ${v}${cell.unit ? " " + cell.unit : ""}   ${cell.clause ?? ""} ${cell.page ?? ""}`);
        } else {
          console.log(`  ${ver}: ${cell}`);
        }
      }
      if (d.absent && Object.keys(d.absent).length) {
        console.log(`  无此规定（已核）：${JSON.stringify(d.absent, null, 1)}`);
      }
      console.log("");
      break;
    }
    case "get_diff_verdict": {
      console.log(`差值裁定：${d.topic ?? ""} · ${d.name ?? ""}`);
      console.log(`  判定：${d.verdict ?? "（无）"}`);
      if (d.reason) console.log(`  依据：${d.reason}`);
      if (d.oldValue !== undefined || d.newValue !== undefined) {
        console.log(`  A ${d.oldValue ?? "—"}   →   B ${d.newValue ?? "—"}`);
      }
      if (d.aClause || d.bClause) console.log(`  条款：A ${d.aClause ?? "—"}   B ${d.bClause ?? "—"}`);
      console.log("");
      break;
    }
    case "get_coverage_status": {
      if (d.limits) {
        console.log("限值级口径（统计单位 = 一条可量化的限值）");
        console.log(`  限值总数 ${d.limits.total ?? "?"}　真缺口 ${d.limits.missing ?? "?"}　别装置顶替 ${d.limits.otherDevice ?? "?"}`);
        console.log(`  同文 ${d.limits.same ?? "?"}　一般条款 ${d.limits.general ?? "?"}　他章 ${d.limits.otherChapter ?? "?"}`);
      }
      if (d.requirements) {
        const r = d.requirements;
        console.log("要求级口径（统计单位 = 一条要求条款）");
        console.log(`  要求总数 ${r.total ?? "?"}　已覆盖 ${r.covered ?? "?"}　真缺口 ${r.gaps ?? "?"}　弱证据 ${r.weak ?? "?"}`);
        console.log(`  附录逐条列出 ${r.appendixListed ?? "?"}　已引原文 ${r.quoted ?? "?"}　非产品要求 ${r.notApplicable ?? "?"}`);
      }
      console.log("");
      break;
    }
    case "list_requirement_gaps": {
      console.log(`不进参数矩阵的定性要求：共 ${d.count ?? 0} 条（本次列 ${d.shown ?? 0} 条）`);
      for (const r of d.items ?? []) {
        console.log(`  · ${r.version} ${r.clause ?? ""} ${r.page ?? ""}`);
        console.log(`    ${String(r.excerpt ?? "").slice(0, 130)}`);
        if (r.why) console.log(`    为什么不进矩阵：${String(r.why).slice(0, 110)}`);
      }
      if (d.note) console.log(`  ℹ ${d.note}`);
      console.log("");
      break;
    }
    case "get_topic_excerpts": {
      console.log(`主题：${d.topic ?? ""}`);
      for (const [ver, c] of Object.entries(d.versions ?? {})) {
        console.log(`  ${ver} ${c.label ?? ""} ${c.clause ?? ""} ${c.page ?? ""}`);
        console.log(`    ${c.excerpt ?? ""}`);
        if (c.status) console.log(`    核验状态：${c.status}`);
      }
      console.log("");
      break;
    }
    default:
      console.log(JSON.stringify(d, null, 1).slice(0, 4000));
      console.log("");
  }
}

const key = ALIAS[(cmd ?? "").toLowerCase()];

if (!key || key === "help" || cmd === undefined) {
  usage();
  process.exit(0);
}

if (key === "tools") {
  console.log("\n可用工具（全部回源到三份源 PDF，确定性，不调模型）：\n");
  for (const t of toolSchemas()) {
    console.log(`  ${t.function.name.padEnd(24)} ${String(t.function.description).split("。")[0]}`);
    const props = t.function.parameters?.properties ?? {};
    console.log(`  ${" ".repeat(24)} 参数：${Object.keys(props).join(", ") || "无"}`);
    console.log("");
  }
  process.exit(0);
}

const args = (() => {
  switch (key) {
    case "lookup_clause":
      return pick({ version: rest[0], clause: rest[1] });
    case "find_quote":
      return pick({ quote: rest.join(" ") });
    case "lookup_parameter":
    case "get_diff_verdict":
      return pick({ name: rest.join(" ") });
    case "get_coverage_status":
      return pick({ scope: rest[0] });
    case "list_requirement_gaps":
      return pick({ version: rest[0], limit: rest[1] ? Number(rest[1]) : undefined });
    case "get_topic_excerpts":
      return pick({ topic: rest.join(" ") });
    default:
      return {};
  }
})();

const res = await runAgentTool(key, args);
printResult(key, res);
