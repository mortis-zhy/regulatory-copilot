/**
 * **跨供应商凭据池** 的已知答案用例 —— **不调模型** ✓（那要花钱 ✗）。
 *
 * ## 为什么要有这个用例
 *
 * 实测（2026-11-14）：MiniMax 的两把 key **额度全满** ✗（402 ✗），
 * 而手上有一把能用的 OpenAI key ✓ —— 但原来的池子**只有 key** ✗
 * ⇒ 所有 key 都打**同一个地址、同一个模型** ✗ ⇒ 换供应商**必须改代码** ✗。
 *
 * 现在池子里的每一项都带 **baseUrl + model** ✓ ⇒ 轮换可以**跨供应商** ✓。
 *
 * 这一条判的是**能不能**用 OpenAI 那把 key：池子读得懂配置 ✓、
 * 缺 baseUrl/模型时**不猜** ✓（宁可空着，不可错着 ✓）、
 * 重复项不重复收 ✓。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 这个用例在**仓库根** ⇒ ROOT 就是它自己所在的目录 ✓
const ROOT = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : " —— " + detail}`);
  if (!cond) failed++;
};

console.log("\n[test-model-credential-pool] 跨供应商凭据池");

// 用**假的 env** 驱动它 ✓（不碰真的 .env ✓ —— 里面的 key 是秘密 ✓）
const prev = { ...process.env };
process.env.MINIMAX_API_KEY = "sk-mm-main";
process.env.MINIMAX_API_KEY_FALLBACK = "sk-mm-back1,sk-mm-back2";
process.env.MODEL_KEY_POOL = "openai|sk-oa-1|https://api.openai.com/v1|gpt-6.1-sol";
delete process.env.OPENAI_BASE_URL;
delete process.env.OPENAI_MODEL;

const mod = await import(pathToFileURL(path.join(ROOT, "dist", "minimaxPool.js")).href);

let pool = mod.modelCredentialPool();
check("MiniMax 的三把都在池子里", pool.filter((c) => c.provider === "minimax").length === 3,
  JSON.stringify(pool.map((c) => c.provider)));
check("OpenAI 那把也在池子里", pool.some((c) => c.provider === "openai"), JSON.stringify(pool));
const oa = pool.find((c) => c.provider === "openai");
check("OpenAI 项带着自己的 baseUrl 与模型",
  oa?.baseUrl === "https://api.openai.com/v1" && oa?.model === "gpt-6.1-sol",
  JSON.stringify(oa));
check("MiniMax 项用的是 MiniMax 的地址与模型",
  pool[0].baseUrl.includes("minimax") && pool[0].model === "MiniMax-M3",
  JSON.stringify(pool[0]));
check("只有 MiniMax 是 native（别的供应商没有那条原生路由）",
  pool.filter((c) => c.native).every((c) => c.provider === "minimax")
    && pool.find((c) => c.provider === "openai")?.native === false);

// ② 缺 baseUrl/模型 ⇒ **不猜** ✓
process.env.MODEL_KEY_POOL = "weirdvendor|sk-xxx";
pool = mod.modelCredentialPool();
check("不认识又没给 baseUrl/模型的供应商 ⇒ 跳过（不猜）",
  !pool.some((c) => c.provider === "weirdvendor"), JSON.stringify(pool.map((c) => c.provider)));

// ③ 重复项不重复收 ✓
process.env.MODEL_KEY_POOL = "openai|sk-mm-main|https://api.openai.com/v1|gpt-6.1-sol";
pool = mod.modelCredentialPool();
check("同一把 key 不会因为换了供应商就收两次",
  new Set(pool.map((c) => c.key)).size === pool.length,
  JSON.stringify(pool.map((c) => `${c.provider}:${c.key.slice(0, 8)}`)));

// ④ 空池 ⇒ 报错而不是「静默用空 key」✓
delete process.env.MINIMAX_API_KEY;
delete process.env.MINIMAX_API_KEY_FALLBACK;
process.env.MODEL_KEY_POOL = "";
pool = mod.modelCredentialPool();
check("什么都没配 ⇒ 池子是空的（调用方会响亮报错）", pool.length === 0, JSON.stringify(pool));

// 还原环境 ✓（别把假 key 留给别的进程 ✓）
for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
Object.assign(process.env, prev);

if (failed) {
  console.error(`\n[test-model-credential-pool] ${failed} 条没过 ✗\n`);
  process.exit(1);
}
console.log("\n[test-model-credential-pool] 全部通过 ✓\n");
