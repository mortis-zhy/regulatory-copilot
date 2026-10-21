/**
 * 泛化自测 —— 换一套标准会怎样？
 *
 * 背景：数据层（`parameterMatrix.ts`）早就是声明式的
 * （`VERSION_META` + `versionsOf` 从语料推版本），但**渲染层**曾经
 * 把版本写死成 A/B/C：
 *   · `findHorizontalVersionCols` 只认 A/B/C → 语料里多一版时，
 *     整张横向对照表**退回普通表格**（卡片布局整个消失）；
 *   · `ParsedTable.comparisonCols` 的类型是 `("A"|"B"|"C")[]`；
 *   · `.triptych` 的栅格是 `repeat(3, 1fr)` → 四张卡挤成三列；
 *   · `DOC_META` 只有 A/B/C 三项 → 未知版本 `DOC_META[v]` 是 undefined。
 *
 * 这些在**三份文档**的语料上全都看不出来 —— 硬编码与推导的结果一模一样。
 * 所以必须喂它**它永远不会在生产里见到**的语料：两版、四版、改名的版本键。
 */
import assert from "node:assert/strict";

const { orderVersions } = await import("./dist/parameterMatrix.js");
const { setActiveVersions, findHorizontalVersionCols } = await import("./dist/htmlRenderV8.js");

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

/* --- 1. 版本顺序：声明的在前，未知的按字母排 -------------------------------- */
ok(
  JSON.stringify(orderVersions(["D", "A", "C", "B"])) === '["A","B","C","D"]',
  "第四版必须排在声明的版本之后，而不是按字母混进中间",
);
ok(
  JSON.stringify(orderVersions(["Z", "X", "Y"])) === '["X","Y","Z"]',
  "完全未知的版本键按字母排",
);
ok(
  JSON.stringify(orderVersions(["B", "A"])) === '["A","B"]',
  "两版语料只出两列",
);
ok(orderVersions([]).length === 0, "空语料不出列");

/* --- 2. 横向对照表的版本列按「当前语料实际有的版本」认 ---------------------- */
setActiveVersions(["A", "B", "C"]);
ok(
  JSON.stringify(findHorizontalVersionCols(["参数", "A 草案", "B 现行", "C UN R48-09"])) ===
    '{"A":1,"B":2,"C":3}',
  "三版语料：三列都要认出来",
);
ok(
  findHorizontalVersionCols(["参数", "A 草案", "B 现行"]) === null,
  "少一版就退回普通表格（两版对照用普通表格更清楚）",
);
ok(
  findHorizontalVersionCols(["参数", "单位", "A 草案", "B 现行", "C UN R48-09", "判定"]) === null,
  "带「单位」「判定」两列的宽表不进卡片布局（卡片放不下）",
);

setActiveVersions(["A", "B", "C", "D"]);
ok(
  JSON.stringify(findHorizontalVersionCols(["参数", "A 草案", "B 现行", "C UN R48-09", "D 第四版"])) ===
    '{"A":1,"B":2,"C":3,"D":4}',
  "四版语料：第四版必须被认成版本列",
);
ok(
  findHorizontalVersionCols(["参数", "A 草案", "B 现行", "C UN R48-09"]) === null,
  "四版语料里缺一版就退回普通表格",
);

/* --- 3. 版本键改名（换一套标准）也认得出来 ---------------------------------- */
setActiveVersions(["X", "Y", "Z"]);
ok(
  JSON.stringify(findHorizontalVersionCols(["参数", "X 草案", "Y 现行", "Z 参照"])) ===
    '{"X":1,"Y":2,"Z":3}',
  "版本键叫 X/Y/Z 时同样认得出来（换标准不用改代码）",
);
ok(
  findHorizontalVersionCols(["参数", "A 草案", "B 现行", "C UN R48-09"]) === null,
  "语料里没有的版本列不该被认出来（否则「R48 条款」这种表头会被误当成版本列）",
);

setActiveVersions(["A", "B", "C"]);

console.log(`_test_gen.mjs — ${checks} checks passed`);
