// **服务器上的取证问答**端到端探针 ✓ —— 一句话问出去，看它会不会回源 ✓。
//
// ## 为什么要有这个
//
// 「服务起来了」≠「问答能用」✗ —— 服务器上**模型没配**的话，
// 页面能开、报告能看，但一问就说「MINIMAX_API_KEY 未配置」✗（实测踩过 ✓）。
// 这个脚本**把整条链路走一遍** ✓：模型 ✓ → 只读工具 ✓ → 回源页码 ✓ → 查不到就如实说查不到 ✓。
//
// 用法：
//   node scripts/probe_server_chat.mjs [服务器地址] [问题]
//   node scripts/probe_server_chat.mjs http://100.124.96.115:3000 "A 版近光灯最大离地高度是多少？"
//
// ⚠ **用 PowerShell 的 `Invoke-WebRequest` 跑更稳** ✓ ——
// Node 的 `fetch` **不走系统代理** ✗，而这台机器到 Tailscale 地址有时走代理 ⇒ 连接超时 ✗。
const url = `${(process.argv[2] || "http://100.124.96.115:3000").replace(/\/$/, "")}/api/agent/chat/agent`;
const question = process.argv[3] || "查一下 A 版近光灯最大离地高度是多少，在第几页？";

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "X-Task-Id": "probe-from-dev" },
  body: JSON.stringify({
    messages: [{ role: "user", content: question }],
    model: "MiniMax-M3",
    temperature: 0.2,
    maxRounds: 6,
  }),
});
console.log("HTTP", res.status);
const text = await res.text();
const events = text
  .split("\n")
  .filter((l) => l.startsWith("data:"))
  .map((l) => {
    try {
      return JSON.parse(l.slice(5).trim());
    } catch {
      return { type: "raw", raw: l.slice(5).trim() };
    }
  });
const calls = events.filter((e) => e.type === "tool_call").map((e) => e.name);
const hits = events.filter((e) => e.type === "tool_result" && e.ok).length;
const misses = events.filter((e) => e.type === "tool_result" && !e.ok).length;
console.log(`工具调用 ${calls.length} 次：${[...new Set(calls)].join("、") || "（无）"}`);
console.log(`命中 ${hits} 次 · 如实说「未找到」${misses} 次`);
for (const e of events.slice(-4)) console.log(JSON.stringify(e).slice(0, 400));
