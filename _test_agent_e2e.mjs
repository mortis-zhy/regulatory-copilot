/**
 * agent 端到端 —— **真的调一次模型**，看它是否：
 *   1. 先调工具再回答（而不是凭记忆）
 *   2. 回答里的页码与工具返回的一致
 *   3. 查不到时如实说查不到
 *
 * 这个测试**要花钱**（调 MiniMax），所以默认不在 `npm run verify` 里跑。
 * 跑法： node _test_agent_e2e.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { runAgentLoop } from "./dist/agentLoop.js";
import { AGENT_SYSTEM_PROMPT } from "./dist/agentPrompt.js";

// 从 .env 读 key
const envTxt = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const get = (k) => (envTxt.match(new RegExp("^" + k + "=(.*)$", "m"))?.[1] ?? "").trim();
process.env.MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || get("MINIMAX_API_KEY");
process.env.MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || get("MINIMAX_BASE_URL");
process.env.MINIMAX_MODEL = process.env.MINIMAX_MODEL || get("MINIMAX_MODEL");

if (!process.env.MINIMAX_API_KEY) {
  console.log("_test_agent_e2e.mjs — 跳过（没有 MINIMAX_API_KEY）");
  process.exit(0);
}

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/* --- 用例 1：该查的时候要查 ---------------------------------------------- */
{
  const q = "GB 4785-2019 的 5.5.7 电路连接是怎么规定的？在第几页？";
  let tools = [];
  let text = "";
  for await (const ev of runAgentLoop({
    messages: [{ role: "user", content: q }],
    systemPrompt: AGENT_SYSTEM_PROMPT,
    maxRounds: 5,
  })) {
    if (ev.type === "tool_call") tools.push(ev.name);
    if (ev.type === "content") text += ev.delta;
  }
  console.log(`\n[用例1] 工具调用：${tools.join(", ") || "（无）"}`);
  console.log(`[用例1] 回答：${text.slice(0, 400)}`);
  ok(tools.length > 0, "必须调工具 —— 凭记忆回答就是 v1 事故的根源");
  ok(
    tools.some((t) => t === "lookup_clause" || t === "find_quote"),
    `应当用条款/引文工具，实际用了 ${tools.join(",")}`,
  );
  ok(/第\s*\d+\s*页/.test(text), "回答里必须带页码");
  ok(!/至少输出\s*\d+\s*条/.test(text), "不得套用旧提示词的「至少输出 30 条」格式");
}

/* --- 用例 2：查不到就如实说查不到 ---------------------------------------- */
{
  const q = "GB 4785-2019 里有没有关于「氢燃料电池车辆的车身强度」的规定？在第几页？";
  let tools = [];
  let text = "";
  for await (const ev of runAgentLoop({
    messages: [{ role: "user", content: q }],
    systemPrompt: AGENT_SYSTEM_PROMPT,
    maxRounds: 5,
  })) {
    if (ev.type === "tool_call") tools.push(ev.name);
    if (ev.type === "content") text += ev.delta;
  }
  console.log(`\n[用例2] 工具调用：${tools.join(", ") || "（无）"}`);
  console.log(`[用例2] 回答：${text.slice(0, 400)}`);
  ok(tools.length > 0, "也要先查");
  ok(
    /未找到|没有|查不到|未检索到|不存在|没有规定/.test(text),
    "查不到时必须如实说查不到，不能编一个页码",
  );
  ok(
    !/第\s*\d+\s*页/.test(text) || /未找到|没有|查不到/.test(text),
    "不能给一个查不到的页码",
  );
}

console.log(`\n_test_agent_e2e.mjs — ${checks} checks passed`);
