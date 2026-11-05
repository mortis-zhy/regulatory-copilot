/**
 * 比较口径（comparator）的**已知答案**用例。
 *
 * ## 为什么要有这张用例
 *
 * 客户 DR-002：矩阵只比较数字，**丢了比较符号**。
 * A §5.7.5「离地高度**小于** 750 ㎜」与 B §5.7.5「离地高度**不大于** 750mm」
 * 被判成「A/B 一致」—— 而**恰好 750 mm 时适用性不同**。
 *
 * 口径的判据里有两个坑，**都会把法规结论说反**，所以必须用已知答案钉住：
 *
 * ① **否定词把方向翻过来**：
 *    「不**小于** X」= 值 ≥ X（不是 <）；「不**大于** X」= 值 ≤ X。
 *    「距离**不应小于** 600mm」是**下限** 600 —— 判成「<」就把下限说成了上限。
 * ② **英文的等价式**：
 *    「less than **or equal to** X」= ≤；「equal **or less than** X」= ≤。
 *    而 R48 里最常见的「the deviation ... **differs by more than** 0.15」
 *    说的其实是「偏差**不得大于** 0.15」= ≤ ——
 *    裸的「more than」判成「>」就是**反的**。
 *
 * **留空优于猜**：认不出来的写法一律留空（`null`）——
 * 留空只是少一个维度，猜错是把法规结论说反。
 *
 * 运行：node _test_comparator.mjs
 */
import { comparatorBefore, COMPARATOR_TEXT } from "./dist/parameterMatrix.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

/** 取值紧前面的一段文字 → 期望的口径。 */
const CASES = [
  // ── 中文：不否定 ──────────────────────────────────────────────
  ["离地高度小于 ", "<", "小于 → <"],
  ["离地安装高度小于 ", "<", "小于 → <"],
  ["间距大于 ", ">", "大于 → >"],
  ["高度不低于 ", "≥", "不低于 → ≥（不小于的下限）"],
  ["等于 ", "=", "等于 → ="],

  // ── 中文：否定把方向翻过来 ────────────────────────────────────
  ["离地高度不大于 ", "≤", "不大于 → ≤"],
  ["距离不应大于 ", "≤", "不应大于 → ≤"],
  ["不得超过 ", "≤", "不得超过 → ≤"],
  ["不得大于 ", "≤", "不得大于 → ≤"],
  ["距离不小于 ", "≥", "不小于 → ≥"],
  ["不应低于 ", "≥", "不应低于 → ≥"],
  ["不得小于 ", "≥", "不得小于 → ≥"],
  ["距离不应小于 ", "≥", "不应小于 → ≥（下限，不是上限）"],
  ["至多 ", "≤", "至多 → ≤"],
  ["至少 ", "≥", "至少 → ≥"],

  // ── 英文 ──────────────────────────────────────────────────────
  ["mounted below ", "<", "below → <"],
  ["shall not exceed ", "≤", "shall not exceed → ≤"],
  ["not exceed ", "≤", "not exceed → ≤"],
  ["no more than ", "≤", "no more than → ≤"],
  ["not more than ", "≤", "not more than → ≤"],
  ["nor more than ", "≤", "nor more than → ≤"],
  ["shall not be more than ", "≤", "not be more than → ≤"],
  ["is less than or equal to ", "≤", "less than or equal to → ≤"],
  ["is equal or less than ", "≤", "equal or less than → ≤"],
  ["Not less than ", "≥", "Not less than（首字母大写）→ ≥"],
  ["not less than ", "≥", "not less than → ≥"],
  ["no less than ", "≥", "no less than → ≥"],
  ["at least ", "≥", "at least → ≥"],
  ["not below ", "≥", "not below → ≥"],

  // ── **不判**的情形（宁可留空，不猜） ──────────────────────────
  ["differs by more than ", null, "「differs by more than」→ 留空（限值关系其实是 ≤，但不猜）"],
  ["a gap of more than ", null, "裸的「more than」→ 留空"],
  ["shall be ", null, "没有比较词 → 留空"],
  ["", null, "空文本 → 留空"],
];

console.log("比较口径判据：");
for (const [text, want, why] of CASES) {
  const got = comparatorBefore(text, text.length);
  ok(got === want, `${why} —— ${JSON.stringify(text)} → ${String(got)}（期望 ${String(want)}）`);
}

// ── 口径必须在原文里找得到（不许凭空出现） ──────────────────────
console.log("\n口径的中文说法：");
ok(COMPARATOR_TEXT["<"] === "小于", "< → 小于");
ok(COMPARATOR_TEXT["≤"] === "不大于", "≤ → 不大于");
ok(COMPARATOR_TEXT["≥"] === "不小于", "≥ → 不小于");

console.log(
  failures === 0
    ? "\n比较口径用例全过：否定词方向对、英文等价式对、认不出的留空。"
    : `\n${failures} 条比较口径用例没过。`,
);
process.exit(failures === 0 ? 0 : 1);
