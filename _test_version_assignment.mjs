/**
 * **版本标签分配**的已知答案用例 ✓。
 *
 * ## 为什么要有这道用例
 *
 * 同事 issue #1：「上传顺序改变时，法规版本可能错位」✓ ——
 * 先上传「2019 年现行版」时，网页因为它是第一份文件，把它标成 A ✗；
 * 而解析服务认出它是 B ✗。
 *
 * 原来的分配写在**组件里**（`ReportBuilder.tsx` 两处 ✓）——
 * 两处各写一遍 ✗，而且**没法测** ✗：
 * 「换顺序会怎样」✗、「两份都认成 A 会怎样」✗ —— 都没人知道 ✓。
 *
 * ## 这道用例钉住三件事
 *
 * ① **按内容认出来的标签与上传顺序无关** ✓（同事的完成标准 3 ✓）；
 * ② **两份都认成同一版 → 报冲突**，不静默取第一个 ✓
 *    （同事的完成标准 2 ✓ —— 静默取一个 = **丢一份文件** ✗）；
 * ③ 认不出来的才落到**按顺序**的兜底 ✓，且**列出来** ✓
 *    （顺序确实会影响它们 ✓ —— 所以界面必须让人确认 ✓）。
 *
 * 跑法：`node _test_version_assignment.mjs`
 */
import { assignVersionLabels } from "./dist/versionAssignment.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

/** 造一份「按内容认出来」的上传件 ✓。 */
const guess = (label) => ({
  label,
  score: 1,
  source: "sha256",
  reason: `认成 ${label}`,
});
const plain = (fileName, g) => ({ fileName, versionGuess: g });

console.log("=== 版本标签分配 ===");

// --------------------------------------------------------------------------
// ① 换上传顺序 → 标签不变（同事的完成标准 3）
// --------------------------------------------------------------------------
const A = plain("GB4785草案.pdf", guess("A"));
const B = plain("GB4785-2019.pdf", guess("B"));
const C = plain("UN-R48-09.pdf", guess("C"));

const orders = [
  [A, B, C],
  [C, A, B],
  [B, C, A],
  [C, B, A],
  [A, C, B],
];
const first = assignVersionLabels(orders[0]);
for (const order of orders) {
  const r = assignVersionLabels(order);
  const map = Object.fromEntries(
    r.assignments.map((a, i) => [order[i].fileName, a.label]),
  );
  ok(
    map["GB4785草案.pdf"] === "A" &&
      map["GB4785-2019.pdf"] === "B" &&
      map["UN-R48-09.pdf"] === "C",
    `换顺序后标签不变（${Object.values(map).join("/")}）`,
  );
}
ok(
  first.assignments.every((a) => a.source === "content"),
  "认出来的都标成「按内容认」",
);

// --------------------------------------------------------------------------
// ② 两份都认成 A → 报冲突，不静默取第一个
// --------------------------------------------------------------------------
const dup = assignVersionLabels([
  plain("GB4785-2019.pdf", guess("A")),
  plain("GB4785-2019(副本).pdf", guess("A")),
]);
ok(dup.conflicts.length === 1, "两份都认成 A → 报 1 处冲突");
ok(
  dup.conflicts[0]?.label === "A" &&
    dup.conflicts[0]?.files.length === 2,
  "冲突说清是哪个标签、哪两份文件",
);

// --------------------------------------------------------------------------
// ③ 认不出来的 → 按顺序兜底，且**列出来**（顺序确实会影响它们）
// --------------------------------------------------------------------------
const mixed = assignVersionLabels([
  plain("未识别的1.pdf", { label: null, score: 0, source: "none", reason: "认不出" }),
  plain("GB4785-2019.pdf", guess("B")),
]);
ok(mixed.unassigned.length === 1, "认不出来的那份被列出来");
ok(
  mixed.assignments.some((a) => a.source === "positional"),
  "认不出的落到「按上传顺序」的兜底",
);
ok(
  mixed.assignments.some((a) => a.label === "B" && a.source === "content"),
  "认出来的那份**不受影响**（还是 B）",
);

// --------------------------------------------------------------------------
// ④ 用户确认过的优先
// --------------------------------------------------------------------------
const confirmed = assignVersionLabels([
  { fileName: "GB4785-2019.pdf", versionGuess: guess("B"), confirmedLabel: "A" },
  plain("UN-R48-09.pdf", guess("C")),
]);
ok(
  confirmed.assignments[0].label === "A" &&
    confirmed.assignments[0].source === "confirmed",
  "用户确认的版本优先于内容识别",
);

console.log(failures ? `\n✗ ${failures} 项没过` : "\n✓ 版本标签分配用例全过");
process.exit(failures ? 1 : 0);
