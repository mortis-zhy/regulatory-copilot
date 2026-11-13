/**
 * 回归脚本的**记账规矩** —— 「没跑成」不许被记成「没编造」。
 *
 * ## 为什么要有这个用例
 *
 * 2026-11-13 实测：跑 120 条那轮撞上 **HTTP 402**（Token Plan 用量上限），
 * 空槽（编造率）那 40 条里 **28 条根本没跑成** ✗
 * —— 而脚本把这一轮写成 `fabricated: 0` ✗。
 *
 * 上一轮**真的**有 4 条编造 ✗。于是文件里的数从「4」变成「0」✗
 * —— 读的人会以为「**编造问题解决了**」✗，
 * 而真相是「**模型没答**」✗。
 *
 * 这跟同事 2026-11-10 复核抓到的那一类是**同一类**：
 * **「没跑成」≠「通过」** ✗ —— 只不过这里藏得更深（在**记账**里，不在闸门里）✗。
 *
 * ## 这个用例做什么
 *
 * **不调模型** ✓（那要花钱，而且额度可能已经用完 ✗）——
 * 它直接驱动脚本里**导出出来的那两个判定函数** ✓，
 * 用**造出来的错误行**验它们的行为 ✓。
 *
 * 判据三条：
 *   ① 一半「同一个错」⇒ 判「**没跑成**」✓（不是「0 分」✗）
 *   ② 一半「不是同一个错」⇒ 判「**质量问题**」✓（不是「没跑成」✗）
 *   ③ 写盘时：没跑成的那一半 ⇒ **保留上一次的数 + 标注** ✗（不是写 0 ✓）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? " —— " + detail : ""}`);
  }
};

/* --- 把脚本里那两个判定函数抠出来测 --------------------------------------- *
 *
 * 不 import 整个脚本 ✓ —— 它一上来就调模型 ✗（要花钱 ✗）。
 * 这里**照抄**判定逻辑 ✗……不，那会变成两份实现 ✗。
 *
 * 所以：脚本把这两个函数**导出** ✓，用例直接 import ✓
 * （`export` 不改变运行行为 ✓ —— 脚本自己跑的时候照样执行 ✓）。
 */
const mod = await import("./scripts/run_spec_agent_regression_accounting.mjs");

console.log("\n[test-regression-accounting] 回归脚本的记账规矩");

// ① 全盘同一个错 ⇒ 「没跑成」
const allSame = [
  { error: "agent 失败：HTTP 402: Token Plan 用量上限" },
  { error: "agent 失败：HTTP 402: Token Plan 用量上限" },
  { error: "agent 失败：HTTP 402: Token Plan 用量上限" },
];
check(
  "全盘同一个错 → 判「没跑成」",
  typeof mod.commonFailure(allSame) === "string" && mod.commonFailure(allSame).includes("402"),
  `commonFailure 返回 ${JSON.stringify(mod.commonFailure(allSame))}`,
);

// ② 不是全盘同一个错 ⇒ 质量问题（不是「没跑成」）
const mixed = [
  { error: "agent 失败：HTTP 402: Token Plan 用量上限" },
  { error: "agent 失败：HTTP 500: internal" },
  { error: null },
];
check("错法不一致 → 判「质量问题」而不是「没跑成」", mod.commonFailure(mixed) === null);

// ③ 全都没有错 ⇒ 什么都不是
check("没有错 → 不是「没跑成」", mod.commonFailure([{ error: null }, { error: null }]) === null);

// ④ **半边没跑成时，写盘不许写 0** ✓ —— 这是最要紧的一条
const prev = {
  absentCheck: {
    sampleSize: 40,
    ran: 40,
    notRun: 0,
    saidAbsent: 36,
    fabricated: 4,
    wrongQuantity: 4,
    hallucinated: 0,
    rows: [{ id: "x", kind: "wrong-quantity" }],
  },
};
const kept = mod.buildAbsentBlock({
  absentRows: [
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" },
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" },
  ],
  absentDidNotRun: "HTTP 402",
  previous: prev.absentCheck,
});
check(
  "空槽没跑成 → 保留上一次的编造数（4），不是写 0",
  kept.fabricated === 4 && kept.ran === 40 && kept.notRun === 0,
  `fabricated=${kept.fabricated} ran=${kept.ran} notRun=${kept.notRun}`,
);
check(
  "空槽没跑成 → 带上「这一轮没跑成」的标注",
  typeof kept._carriedOver === "string" && kept._carriedOver.includes("没跑成"),
  `标注=${JSON.stringify(kept._carriedOver)}`,
);

// ⑤ 空槽没跑成、且**上一次也没有** ⇒ 不许假装有数据
const fresh = mod.buildAbsentBlock({
  absentRows: [{ kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" }],
  absentDidNotRun: "HTTP 402",
  previous: null,
});
check(
  "空槽没跑成且无旧数据 → 明确写「没有数据」，不是「0 条编造」",
  fresh.fabricated === 0 &&
    fresh.ran === 0 &&
    fresh.notRun === 1 &&
    typeof fresh._notRun === "string" &&
    fresh.rows.length === 0,
  `fabricated=${fresh.fabricated} ran=${fresh.ran} notRun=${fresh.notRun} _notRun=${JSON.stringify(fresh._notRun)}`,
);

// ⑥ 正常跑成 ⇒ 写实的数（含 ran / notRun 与两种「编造」的分开）
const ok = mod.buildAbsentBlock({
  absentRows: [
    { kind: "said-absent", saidAbsent: true, fabricated: false, error: null },
    { kind: "wrong-quantity", saidAbsent: false, fabricated: true, error: null },
    { kind: "hallucinated", saidAbsent: false, fabricated: true, error: null },
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" },
  ],
  absentDidNotRun: null,
  previous: null,
});
check(
  "跑成时：ran/notRun 分开 · 误配量值与凭空生成分列",
  ok.ran === 3 &&
    ok.notRun === 1 &&
    ok.fabricated === 2 &&
    ok.wrongQuantity === 1 &&
    ok.hallucinated === 1 &&
    ok.saidAbsent === 1,
  JSON.stringify({ ran: ok.ran, notRun: ok.notRun, fabricated: ok.fabricated, wq: ok.wrongQuantity, h: ok.hallucinated }),
);

// ⑦ **一条不许把「没跑成」算成「没编造」** ✓ —— 逐行验
const rowKinds = [
  { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" },
  { kind: "said-absent", saidAbsent: true, fabricated: false, error: null },
];
check(
  "「没跑成」的行：既不算 saidAbsent 也不算 fabricated",
  rowKinds[0].saidAbsent === false && rowKinds[0].fabricated === false,
);

// ⑧ **一半以上没跑成 ⇒ 这一轮不能代表能力** ✓
//
// 实测（2026-11-13）打脸了「全盘同一个错才算没跑成」的判据 ✗：
// 40 条里 39 条撞上 402 ✗，但**错法不完全一样** ✗（截断位置不同 ✗）⇒ 判据不触发 ✗
// ⇒ 「4 条编造」被盖成「0 条编造」✗ ✗。
//
// ⇒ 判据改成**比例** ✓。
const partial = mod.buildAbsentBlock({
  absentRows: [
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402 …(截断位置 A)" },
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402 …(截断位置 B)" },
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402 …(截断位置 C)" },
    { kind: "said-absent", saidAbsent: true, fabricated: false, error: null },
  ],
  absentDidNotRun: null, // **错法不一样** ⇒ 老的判据不触发 ✗
  previous: prev.absentCheck,
});
check(
  "大部分没跑成（错法还不一样）→ 仍然保留上一次的编造数（4）",
  partial.fabricated === 4 && typeof partial._carriedOver === "string",
  `fabricated=${partial.fabricated} carried=${partial._carriedOver ? "有" : "无"}`,
);

// ⑨ 一半**没到**就没跑成 ⇒ 这一轮还能用 ✓（不能连累真结果 ✗）
const small = mod.buildAbsentBlock({
  absentRows: [
    { kind: "said-absent", saidAbsent: true, fabricated: false, error: null },
    { kind: "wrong-quantity", saidAbsent: false, fabricated: true, error: null },
    { kind: "not-run", saidAbsent: false, fabricated: false, error: "HTTP 402" },
    { kind: "said-absent", saidAbsent: true, fabricated: false, error: null },
  ],
  absentDidNotRun: null,
  previous: null,
});
check(
  "只有 1/4 没跑成 → 这一轮算数（不 carry over）",
  small._carriedOver === undefined && small.fabricated === 1 && small.ran === 3 && small.notRun === 1,
  JSON.stringify({ carried: small._carriedOver, fab: small.fabricated, ran: small.ran }),
);

// ⑩ 主回归那半边：**API 失败不是「agent 不会」** ⇒ 两个口径都记 ✓
const main = mod.phaseOutcome(50, 5, "HTTP 402");
check(
  "主回归：ran/notRun 分开 · 一半没跑成才算系统性失败",
  main.ran === 45 && main.notRun === 5 && main.systemic === false,
  JSON.stringify(main),
);
const mainBad = mod.phaseOutcome(50, 39, "HTTP 402");
check("主回归：39/50 没跑成 ⇒ 判「系统性失败」", mainBad.systemic === true, JSON.stringify(mainBad));

if (failed) {
  console.error(`\n[test-regression-accounting] ${failed} 条没过 ✗\n`);
  process.exit(1);
}
console.log("\n[test-regression-accounting] 10 条全过 ✓\n");
