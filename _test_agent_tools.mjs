/**
 * 取证工具的自测 —— **用已知答案**。
 *
 * 为什么必须测：这些工具是 agent 的**唯一证据来源**。
 * 工具回源错了，agent 就会把错的东西当事实讲出去 ——
 * 而 agent 的回答往往没有人工复核，这比「agent 查不到」危险得多。
 *
 * 每条用例都断言**具体的页码/取值**，不是「返回了东西」。
 *
 * 跑法： node _test_agent_tools.mjs
 */
import assert from "node:assert/strict";
import { runAgentTool, AGENT_TOOLS } from "./dist/agentTools.js";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/* --- 1. 工具清单本身要合法（OpenAI function-calling 格式） ----------------- */
{
  ok(Array.isArray(AGENT_TOOLS) && AGENT_TOOLS.length >= 7, "工具清单至少 7 个");
  for (const t of AGENT_TOOLS) {
    ok(t.type === "function", "每个工具的 type 必须是 function");
    ok(typeof t.function?.name === "string" && t.function.name.length > 0, "工具要有名字");
    ok(typeof t.function?.description === "string" && t.function.description.length > 10,
      `${t.function?.name} 的描述要写清楚它查什么`);
    ok(t.function?.parameters?.type === "object", `${t.function?.name} 的参数要是 object`);
  }
  const names = AGENT_TOOLS.map((t) => t.function.name);
  ok(new Set(names).size === names.length, "工具名不能重复");
}

/* --- 2. lookup_clause：查得到时必须给出**真实页码** ------------------------ */
{
  const r = await runAgentTool("lookup_clause", { version: "B", clause: "5.2.4.2" });
  ok(r.ok, `B §5.2.4.2 必须查得到：${JSON.stringify(r.data).slice(0, 200)}`);
  const m = r.data.matches?.[0];
  ok(!!m, "要返回 matches");
  ok(/第\d+页/.test(String(m.page ?? "")), `页码格式应为「第N页」，实际是 ${m?.page}`);
  ok(String(m.excerpt ?? "").length > 10, "要带原文摘录");
  ok(r.data.label.includes("GB 4785-2019"), "要标出这是哪一版");
}

/* --- 3. lookup_clause：查不到就说查不到，**不编造** ---------------------- */
{
  const r = await runAgentTool("lookup_clause", { version: "B", clause: "99.99.99" });
  ok(!r.ok, "不存在的条款号必须返回失败");
  ok(JSON.stringify(r.data).includes("未"), "要明说没找到");
  ok(!(r.data.matches ?? []).length, "不能凭空造出 matches");
}

/* --- 4. find_quote：回源核实（这是 agent 最有用的工具） ------------------ */
{
  // B 的 §5.5.7「转向信号灯的开关应独立于其他灯具」在第 33 页
  const r = await runAgentTool("find_quote", { quote: "转向信号灯的开关应独立于其他灯具" });
  ok(r.ok, `这段话必须能在源 PDF 里找到：${JSON.stringify(r.data).slice(0, 200)}`);
  const b = (r.data.hits ?? []).find((h) => h.version === "B");
  ok(!!b, "要在 B 版里命中");
  ok(b.pageNumbers?.includes(33), `应在第 33 页，实际 ${JSON.stringify(b?.pageNumbers)}`);
}

/* --- 5. find_quote：找不到就说找不到 -------------------------------------- */
{
  const r = await runAgentTool("find_quote", { quote: "这是一段根本不存在的法规原文测试文本" });
  ok(!r.ok, "不存在的引文必须返回失败");
  ok(String(r.data.note ?? "").length > 0, "要给出说明");
}

/* --- 5b. 短引文（<8 字）也必须查得到 ——
   旧实现 `if (q.length < 8) return []` 让所有短引文一律「查不到」。
   而「查不到」会被报告当成「原文里没有」—— 一个静默的错误结论。 */
{
  const r = await runAgentTool("find_quote", { quote: "紧急制动信号" });
  ok(r.ok, `6 字的引文也必须查得到：${JSON.stringify(r.data).slice(0, 200)}`);
  const b = (r.data.hits ?? []).find((h) => h.version === "B");
  ok(!!b, "要在 B 版里命中");
  ok(b.pageNumbers?.length > 0, "要给出页码");
}

/* --- 5c. 一个词的偶然命中**不能**翻转结论 ---
   「不存在」这个词在三份标准里真的出现过（所以关键词会命中）。
   判定必须是「关键词过半命中」，不是「有一个命中」。 */
{
  const r = await runAgentTool("find_quote", { quote: "这是一段根本不存在的法规原文测试文本" });
  const kw = r.data.keywords ?? [];
  const hit = kw.filter((k) => k.found);
  ok(hit.length > 0, "本用例的前提：确实有片段偶然命中");
  ok(!r.ok, "偶然命中一个词不能判成「内容存在」");
}

/* --- 5d. 概念级关键词：确实存在的内容，关键词应过半命中 --------------- */
{
  const r = await runAgentTool("find_quote", { quote: "紧急制动信号的发光强度" });
  ok(r.ok, "「紧急制动信号」在标准里存在，关键词应过半命中");
  ok(
    (r.data.keywords ?? []).some((k) => k.found),
    "要有命中的关键词",
  );
}

/* --- 6. get_coverage_status：台账数字必须与磁盘上的文件一致 -------------- */
{
  const r = await runAgentTool("get_coverage_status", { scope: "both" });
  ok(r.ok, "覆盖状态必须查得到");
  const req = r.data.requirements;
  ok(req && typeof req.total === "number", "要有要求级总数");
  ok(req.gaps === 0, `真缺口必须是 0，实际 ${req?.gaps}`);
  ok(
    req.covered + req.appendixListed + req.quoted + req.weak + req.notApplicable + req.gaps === req.total,
    `要求级六档合计必须等于总数：${JSON.stringify(req)}`,
  );
  ok(String(r.data.requirementsNote ?? "").length > 20, "要说明口径 —— 数字不带口径没有意义");
}

/* --- 7. list_requirement_gaps：列出来的必须带原文与理由 ------------------- */
{
  const r = await runAgentTool("list_requirement_gaps", { version: "C", limit: 5 });
  ok(r.ok, "必须列得出来");
  ok(r.data.count > 0, "应该有内容");
  ok(r.data.items.length <= 5, "limit 要生效");
  for (const it of r.data.items) {
    ok(!!it.clause, "每条要有条款号");
    ok(!!it.page, "每条要有页码");
    ok(String(it.excerpt ?? "").length > 5, "每条要有原文");
    ok(String(it.why ?? "").length > 10, "每条要有「为什么不进矩阵」的理由");
  }
}

/* --- 8. get_diff_verdict：判定的理由必须带出来 --------------------------- */
{
  const r = await runAgentTool("get_diff_verdict", { name: "牌照灯|数量" });
  ok(r.ok, `差值判定必须查得到：${JSON.stringify(r.data).slice(0, 200)}`);
  ok(r.data.verdict === "有变化", `牌照灯数量应判「有变化」，实际 ${r.data.verdict}`);
  ok(String(r.data.reason ?? "").length > 10, "要带裁定理由");
}

/* --- 9. get_topic_excerpts：三版都要给 ----------------------------------- */
{
  const r = await runAgentTool("get_topic_excerpts", { topic: "远光灯" });
  ok(r.ok, "主题必须查得到");
  for (const v of ["A", "B", "C"]) {
    const c = r.data.versions?.[v];
    ok(!!c, `${v} 版要有内容`);
    ok(String(c.excerpt ?? "").length > 5, `${v} 版要有原文`);
    ok(!!c.page, `${v} 版要有页码`);
  }
  ok(r.data.versions.A.status === "verified", "A 版应是已核验");
}

/* --- 10. lookup_parameter：矩阵行的三版取值要带条款与页码 --------------- */
{
  const r = await runAgentTool("lookup_parameter", { name: "近光灯最大离地高度" });
  ok(r.ok, `参数必须查得到：${JSON.stringify(r.data).slice(0, 200)}`);
  ok(r.data.cells?.A && r.data.cells?.B, "A/B 两版都要有");
  ok(r.data.cells.A.clause, "A 版要带条款号");
}

/* --- 11. 未知工具必须报错，不能静默返回空 ------------------------------- */
{
  const r = await runAgentTool("no_such_tool", {});
  ok(!r.ok, "未知工具必须失败");
  ok(String(r.data.error ?? "").includes("未知工具"), "要说清是未知工具");
}

console.log(`_test_agent_tools.mjs — ${checks} checks passed`);
