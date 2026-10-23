/**
 * 变化清单的**已知答案**回归用例。
 *
 * `classify()` 是本轮**新增的判定**（变化性质：放宽/收紧/新增/删除…）。
 * 新增判定必须有已知答案的用例 —— 否则它出错时没人知道，
 * 而「把收紧写成放宽」是会把客户引到错误设计上的错。
 *
 * 每条用例都取自**报告里真实存在**的取值，不是编的。
 *
 * 跑法： node _test_change_ledger.mjs
 */
import assert from "node:assert/strict";
import { classify, buildChangeLedger, ledgerBreakdown, valuesOf } from "./dist/changeLedger.js";
import fs from "node:fs";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/* --- 1. valuesOf：必须剥掉条款号与页码 -------------------------------- */
{
  ok(
    valuesOf("B 5.8.2 数量：根据牌照板的照明要求而定").length === 0,
    "条款号 5.8.2 里的数字不算取值",
  );
  ok(
    valuesOf("A 5.8.2 数量：一套。发光单元数量与灯具型式试验时一致").length === 0,
    "同上（两侧都不该有量值）",
  );
  ok(
    valuesOf("1200mm（第29页）").join() === "1200",
    `页码要剥掉，实际 ${valuesOf("1200mm（第29页）").join()}`,
  );
  ok(
    valuesOf("1s~1.5s").sort((a, b) => a - b).join() === "1,1.5",
    "真量值要留下",
  );
  ok(
    valuesOf("6.75V（6V 系统，B 4.27b）").sort((a, b) => a - b).join() === "6,6.75",
    "括号里转引的条款号 4.27b 不算量值，但 6V 的 6 要留下 —— 实际 " +
      valuesOf("6.75V（6V 系统，B 4.27b）").join(),
  );
}

/* --- 2. classify：已知答案 -------------------------------------------- */
{
  const cases = [
    // [B 值, A 值, 期望性质, 为什么]
    [
      "1s~1.5s",
      "1.5s时间内首次熄灭",
      "数值改变",
      "转向信号灯首次熄灭：B 1~1.5s → A 1.5s。**方向不判** —— 区间收窄是收紧，但同样的数字变化在车速阈值上就是放宽",
    ],
    [
      "1200mm",
      "1200（N2G、N3G、M2G、M3G可放宽至1400）mm",
      "数值改变",
      "倒车灯最大离地高度：A 增加了车型放宽",
    ],
    [
      "6.75V（6V 系统，B 4.27b）",
      "（A 已删除 6V 系统条款）",
      "删除（A 已无）",
      "6V 系统电压档：A 删了",
    ],
    [
      "B 5.8.2 数量：根据牌照板的照明要求而定",
      "A 5.8.2 数量：一套。发光单元数量与灯具型式试验时一致",
      "表述/口径改变（两侧均无数值）",
      "牌照灯数量：两侧都没有**数字**（条款号不算数），所以只能判「表述/口径改变」—— 不能判成「数值相同」",
    ],
    [
      "B 5.13.4.2 高度：离地高度不小于 250mm，不大于 1500mm",
      "A 5.13.4.2 高度：离地高度不小于 250mm，不大于 1500mm",
      "数值相同（表述改变）",
      "完全同文",
    ],
    [
      "B 5.25.4：位置无特殊要求",
      "A 5.22.4.2：新增侧面灯具离地高度≤1500mm、同侧相邻间距≥0.5m",
      "新增（A 才有）",
      "慢行灯位置：从无到有（B 明写「位置无特殊要求」）",
    ],
    [
      "B 5.13.4.1 无 500mm 放宽条款",
      "A 5.13.4.1：若为满足 5.13.4.2 要求，此距离可以放宽至 500mm",
      "新增（A 才有）",
      "示廓灯 500mm 放宽",
    ],
    [
      "10",
      "15",
      "数值改变",
      "慢行灯车速阈值 10→15 km/h：数字变大，但**不判放宽** —— 方向要靠参数语义，不能靠数字大小",
    ],
  ];
  for (const [b, a, want, why] of cases) {
    const got = classify(b, a);
    ok(got === want, `${why}\n    期望「${want}」，实际「${got}」`);
  }

  // **绝不判「放宽 / 收紧」** —— 方向判错会把客户引到错误设计上
  for (const [b, a] of cases) {
    const got = classify(b, a);
    ok(
      !/放宽|收紧/.test(got),
      `性质里不该出现方向判断：实际「${got}」`,
    );
  }
}

/* --- 3. 清单：四套来源并成一份，且每条都标明出处 ---------------------- */
{
  const facts = JSON.parse(fs.readFileSync("dist/facts.json", "utf8"));
  const rep = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
  const rows = buildChangeLedger(facts, rep.parameterMatrix ?? []);
  ok(rows.length > 0, "清单不能是空的");

  // 每一条都要有出处，且出处必须是四套之一
  const allowed = ["§11.3 数值级", "§11.3.1 人工补录", "§11.3.3 差值裁定", "第 12 章矩阵"];
  for (const r of rows) {
    ok(r.sources.length > 0, `${r.id} 没有出处`);
    for (const s of r.sources) ok(allowed.includes(s), `${r.id} 出了个不认识的出处「${s}」`);
    ok(!!r.kind && r.kind !== "—", `${r.id} 没有变化性质`);
    ok(
      !!r.bValue || !!r.aValue,
      `${r.id} 两侧都是空的 —— 这不是一条变化`,
    );
  }

  // **守恒的真正含义**：合并只减少**重复计数**，不减少**条目**。
  // 把清单每行的 sources 展开，总数必须等于四套的原始条数之和 ——
  // 少一条 = 丢了一条真实变化（最贵的错）；多一条 = 凭空造了一条变化。
  const bd = ledgerBreakdown(rows);
  const rawNumeric = (facts.numericChanges ?? []).length;
  const rawManual = (facts.manualFindings ?? []).length;
  const rawVerdicts = Object.values(facts.diffVerdicts ?? {}).filter(
    (v) => v.verdict === "有变化",
  ).length;
  const rawMatrix = (rep.parameterMatrix ?? []).filter((m) => m.verdict === "changed").length;
  const rawTotal = rawNumeric + rawManual + rawVerdicts + rawMatrix;
  const expanded = Object.values(bd.bySource).reduce((a, b) => a + b, 0);
  ok(
    expanded === rawTotal,
    `合并后展开的条目数 ${expanded} ≠ 四套原始之和 ${rawTotal}` +
      `（数值级 ${rawNumeric} + 人工补录 ${rawManual} + 差值裁定 ${rawVerdicts} + 矩阵 ${rawMatrix}）—— ` +
      (expanded < rawTotal ? "有原始条目被丢掉了" : "凭空多出了条目"),
  );

  // 四套来源各自都必须在清单里出现过
  for (const [label, n] of Object.entries({
    "§11.3 数值级": rawNumeric,
    "§11.3.1 人工补录": rawManual,
    "§11.3.3 差值裁定": rawVerdicts,
    "第 12 章矩阵": rawMatrix,
  })) {
    ok(
      (bd.bySource[label] ?? 0) > 0,
      `清单里没有「${label}」的条目 —— 这一套清单被漏掉了`,
    );
    ok(
      (bd.bySource[label] ?? 0) === n,
      `「${label}」展开后 ${bd.bySource[label]} ≠ 原始 ${n} —— 有条目被丢或被凭空多出来`,
    );
  }

  // 合并后总条数必须 ≤ 四套之和（合并不产生新行）
  const sum = Object.values(bd.bySource).reduce((a, b) => a + b, 0);
  ok(rows.length <= sum, `合并后 ${rows.length} 竟然多于四套之和 ${sum} —— 合并逻辑有问题`);
  ok(rows.length < sum, `合并后 ${rows.length} = 四套之和 ${sum} —— 一条都没合并，合并逻辑没生效`);
}

/* --- 4. 清单里不能出现方向判断（放宽/收紧） ---------------------------- */
{
  const facts = JSON.parse(fs.readFileSync("dist/facts.json", "utf8"));
  const rep = JSON.parse(fs.readFileSync("reports/last-report.json", "utf8"));
  const rows = buildChangeLedger(facts, rep.parameterMatrix ?? []);
  for (const r of rows) {
    ok(
      !/放宽|收紧/.test(r.kind),
      `${r.id}「${r.name}」的性质里出现了方向判断：${r.kind} —— 方向判错会把客户引到错误设计上`,
    );
  }
  // 转向信号灯首次熄灭必须在清单里，且 B→A 的值看得出来
  const r = rows.find((x) => /首次熄灭时间/.test(x.name));
  ok(!!r, "清单里必须有「转向信号灯首次熄灭时间」");
  ok(
    /1\.5/.test(r.bValue) && /1\.5/.test(r.aValue),
    `首次熄灭时间的 B/A 值要能看到 1.5s，实际 B=${r.bValue} A=${r.aValue}`,
  );
  // 倒车灯最大离地高度：A 增加了 1400
  const r2 = rows.find((x) => /最大离地高度/.test(x.name) && /倒车灯/.test(x.name + x.topic));
  ok(!!r2, "清单里必须有「倒车灯最大离地高度」");
  ok(
    /1400/.test(r2.aValue),
    `倒车灯最大离地高度的 A 值要能看到 1400，实际 ${r2.aValue}`,
  );
}

console.log(`_test_change_ledger.mjs — ${checks} checks passed`);
