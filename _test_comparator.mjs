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
 *    **「by more than」与裸的「more than」不是一回事**：
 *    前者是偏差的**上限**（≤），后者是下限（>）。
 *    两者混为一谈就会把法规结论说反（2026-11-06 补，见下面的用例）。
 *
 * **留空优于猜**：认不出来的写法一律留空（`null`）——
 * 留空只是少一个维度，猜错是把法规结论说反。
 *
 * 运行：node _test_comparator.mjs
 */
import { comparatorBefore, COMPARATOR_TEXT, judgeMatrixCells, verdictLabel } from "./dist/parameterMatrix.js";

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
  ["shall not be switched ON when the vehicle speed is below ", "<", "条件中的阈值不继承动作禁止的否定"],
  ["shall not be less than 600 mm. is less than ", "<", "前一个限值的否定不作用于后一个限值"],
  // ── 中文：不否定 ──────────────────────────────────────────────
  ["离地高度小于 ", "<", "小于 → <"],
  ["离地安装高度小于 ", "<", "小于 → <"],
  ["间距大于 ", ">", "大于 → >"],
  ["高度不低于 ", "≥", "不低于 → ≥（不小于的下限）"],
  ["等于 ", "=", "等于 → ="],

  // ── 中文：比较词可以离取值几个字（**就近匹配**）──────────────────
  // 「…其透光面面积应不小于一个 80mm 直径圆的面积」
  ["其透光面面积应不小于一个 ", "≥", "比较词隔着「一个 」（3 个字）→ 仍认得出 ≥"],
  ["遮蔽后位灯不应超过其视表面的 ", "≤", "比较词隔着「其视表面的 」→ 仍认得出 ≤"],
  // 超出预算（8 个字）→ **不认** ✓（宁可空着，不可错着 ✓）
  ["距离不应小于 600mm 其离地高度为 ", null, "比较词隔了 9 个字（超预算）→ 留空"],

  // ── 中文：「可增至 / 可减至」—— 增至=上限、减至=下限 ──────────
  // （英文那份本来就有 ✓，中文这份漏了 ✗ —— 2026-11-09 补 ✓）
  ["则可增至 ", "≤", "可增至 → ≤（增**到**那个数 = 上限）"],
  ["可增至 ", "≤", "可增至 → ≤"],
  ["应可增至 ", "≤", "应可增至 → ≤"],
  ["上述间距可减至 ", "≥", "可减至 → ≥（减**到**那个数 = 下限）"],
  ["可减至 ", "≥", "可减至 → ≥"],
  ["其向下的几何可见度可减至 ", "≥", "可减至 → ≥"],
  ["向内的水平方向角可减至 ", "≥", "可减至 → ≥"],

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
  ["shall be ", null, "没有比较词 → 留空"],
  ["", null, "空文本 → 留空"],

  // ── 英文：R48 的实际写法（2026-11-06 补）───────────────────────
  //
  // 原来「裸的 more than / greater than」一律留空，理由是
  // 「the deviation ... differs by more than 0.15」（偏差**超过** 0.15 即不合格）。
  // 但把**所有** more than 都留空，代价是**整列 C 的口径全丢** ——
  // 于是 C 列看上去「只有数字、没有限值关系」，A 与 C 的差异被放大成一片假差异。
  //
  // 现在按**句子的真实限值关系**分别判：
  //   「by more than X」= 偏差的**上限** → ≤（先于裸 more than 判）；
  //   裸的「more than / greater than / exceeding / above」= 下限 → >。
  ["not exceeding ", "≤", "not exceeding → ≤"],
  ["exceeding ", ">", "exceeding → >（下限）"],
  ["exceeds ", ">", "exceeds → >"],
  ["vehicle speed is above ", ">", "above → >"],
  ["not further than ", "≤", "not further than → ≤"],
  ["not lower than ", "≥", "not lower than → ≥"],
  ["lower than ", "<", "lower than → <"],
  ["is greater than ", ">", "greater than → >"],
  ["a gap of more than ", ">", "裸的「more than」→ >（下限，不是偏差上限）"],
  ["differs by more than ", "≤", "「differs by more than」→ ≤（偏差的上限，不是下限）"],
  ["may be reduced to ", "≥", "「可减至 X」→ X 是下限 → ≥"],
  ["may be increased to ", "≤", "「可增至 X」→ X 是上限 → ≤"],

  // ── 英文的**否定作用域**：否定离比较词可以很远 ──────────────────
  //
  // R48 的否定有两类：
  //   紧邻否定   「not exceeding 140 mm」
  //   **主语否定**「**None** of the additional lighting units … shall be
  //                positioned **lower than** 250 mm」
  //                —— 否定管的是主语（一个也不许低于 250），比较词紧挨取值。
  //                只看前 24/40/64 个字都够不着否定，
  //                「不得低于 250」会被判成「低于 250」（**把下限说成上限**）。
  //
  // 反过来，否定与比较词之间若隔着**并列词**，否定就不作用于那个比较词：
  // 「shall not be more than 3 m **and** the gap shall be more than 250 mm」
  // 里的 250 是**下限**（>），不是上限。
  [
    "None of the additional lighting units described in paragraph 6.22.4.1.2. above shall be positioned lower than ",
    "≥",
    "主语否定（None of …）→ 「不得低于 250」→ ≥",
  ],
  ["shall not be: Less than: ", "≥", "否定在冒号前一段 → ≥"],
  [
    "shall not be more than 3 m and the gap shall be more than ",
    ">",
    "否定被并列词 and 阻断 → 后面的 more than 仍是下限 → >",
  ],
  ["the outer edge of the apparent surface shall not be more than ", "≤", "not more than → ≤"],
];

console.log("比较口径判据：");
for (const [text, want, why] of CASES) {
  const got = comparatorBefore(text, text.length);
  ok(got === want, `${why} —— ${JSON.stringify(text)} → ${String(got)}（期望 ${String(want)}）`);
}

// ── 口径必须在原文里找得到（不许凭空出现） ──────────────────────
console.log("\n口径的中文说法：");
const cell = (comparator) => ({ status: "verified", nums: ["40"], comparator, value: "" });
const absent = { status: "not-found", nums: [], value: "", miss: "not-specified" };
ok(judgeMatrixCells({ X: cell("≥"), Y: cell("≥"), Z: cell(">") }, ["X", "Y", "Z"]).verdict === "c-diverged",
  "参照版严格边界不同也必须进入差异组");
ok(judgeMatrixCells({ X: cell("≥"), Y: absent, Z: cell(">") }, ["X", "Y", "Z"]).verdict !== "y-only",
  "缺一版时不能把另两版边界不同写成取值一致");
const fourCells = { X: cell("≥"), Y: cell("≥"), Z: cell("≥"), W: cell(">") };
const fourJudge = judgeMatrixCells(fourCells, ["X", "Y", "Z", "W"]);
ok(fourJudge.verdict === "c-diverged" && fourJudge.note.includes("W 边界口径不同"), "第四版不能被比较逻辑漏掉");
ok(verdictLabel({ ...fourJudge, cells: fourCells }, ["X", "Y", "Z", "W"]).includes("W 不同"), "差异标签指向真正不同的版本");
const { DRAFT_SYSTEM_PROMPT } = await import("./dist/agentPrompt.js");
ok(!/至少输出\s*\d/.test(DRAFT_SYSTEM_PROMPT) && DRAFT_SYSTEM_PROMPT.includes("返回空数组"), "草稿证据不足允许空数组，不按最低条数凑数");
ok(COMPARATOR_TEXT["<"] === "小于", "< → 小于");
ok(COMPARATOR_TEXT["≤"] === "不大于", "≤ → 不大于");
ok(COMPARATOR_TEXT["≥"] === "不小于", "≥ → 不小于");

console.log(
  failures === 0
    ? "\n比较口径用例全过：否定词方向对、英文等价式对、认不出的留空。"
    : `\n${failures} 条比较口径用例没过。`,
);
process.exit(failures === 0 ? 0 : 1);
