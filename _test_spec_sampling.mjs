/**
 * 回归取样的**已知答案用例** —— **不调模型** ✓（那是钱 ✗）。
 *
 * ## 为什么要有
 *
 * 原来的取样规则「每个装置只取一条」✗ 让「要求 120 条」**从来没被真测到过** ✗
 * （池子 737 条 ✓、装置 50 个 ⇒ 只挑到 50 条 ✗，日志还写「池子不够」✗ —— 说反了 ✗）。
 *
 * 规则改了之后**只实测过 50 条** ✗ —— 而「要求 120」这个数要能到 120 ✓，
 * 必须**不花钱**也能证明 ✓。所以把它抽成函数 + 用例 ✓。
 */
import assert from "node:assert/strict";
import { pickSample } from "./scripts/spec_agent_sampling.mjs";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

// 造一个真实形状的池子：50 个装置 × 若干版本
const pool = [];
for (let d = 0; d < 50; d++) {
  for (const v of ["A", "B", "C"]) {
    if ((d + v.charCodeAt(0)) % 6 === 0) continue; // 不是每个装置每版都可测 ✓
    pool.push({ spec: { id: `dev${String(d).padStart(2, "0")}.p` }, version: v, device: `dev${String(d).padStart(2, "0")}` });
  }
}
console.log(`[test-spec-sampling] 池子 ${pool.length} 条 · 装置 %d 个`, new Set(pool.map((p) => p.device)).size);

// ① 要求 120 ⇒ **真能到 120** ✓（这是旧规则做不到的 ✗）
const p120 = pickSample(pool, 120, []);
ok(p120.length === 120, `要求 120，只给了 ${p120.length} 条`);

// ② **同一槽位不重复** ✓
const keys = p120.map((p) => `${p.spec.id}::${p.version}`);
ok(new Set(keys).size === keys.length, "取样里有重复槽位");

// ③ **第一轮是多样性** ✓ —— 前 50 条覆盖 50 个不同装置 ✓
const firstHalf = p120.slice(0, 50).map((p) => p.device);
ok(new Set(firstHalf).size === 50, `第一轮没做到「每装置一条」：只有 ${new Set(firstHalf).size} 个装置`);

// ④ 要的比池子多 ⇒ 给满池子为止 ✓（不无限循环 ✗）
ok(pickSample(pool, 99999, []).length === pool.length, "要的比池子多时没给满");

// ⑤ 要 0 条 ⇒ 0 条 ✓
ok(pickSample(pool, 0, []).length === 0, "要 0 条却给了样本");

// ⑥ 指定 ids ⇒ 只取那几条 ✓，**不受条数上限限制** ✓
//    （一个参数在池子里有多个版本 ⇒ 取回的是**它所有的槽位** ✓，
//      这与脚本原来的语义一致 ✓ —— `--ids` 是「我要测这几个参数」✓）
const ids = ["dev03.p", "dev17.p", "dev42.p"];
const expectById = pool.filter((p) => ids.includes(p.spec.id));
const byId = pickSample(pool, 1, ids);
ok(
  byId.length === expectById.length,
  `按 id 取应得 ${expectById.length} 条（含各版本），实得 ${byId.length}`,
);
ok(byId.every((p) => ids.includes(p.spec.id)), "按 id 取时混进了别的参数");

// ⑦ 取出来的顺序**稳定** ✓（同一个池子两次取样结果一致 ✓ —— 回归要可复现 ✓）
const a = pickSample(pool, 30, []).map((p) => `${p.spec.id}::${p.version}`).join(",");
const b = pickSample([...pool].reverse(), 30, []).map((p) => `${p.spec.id}::${p.version}`).join(",");
ok(a === b, "池子顺序变了，取样结果就变了 —— 不可复现 ✗");

console.log(`\n✓ 取样规则用例全过（${n} 条断言）`);
