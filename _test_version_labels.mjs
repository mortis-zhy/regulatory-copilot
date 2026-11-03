/**
 * 「标签 → 版本键」判据的**已知答案**用例。
 *
 * ## 为什么必须有这张用例
 *
 * 判据是从**显示名表**（`VERSION_META`）派生的 ——
 * 那它对不对，就该用**换一张表**来验，而不是靠声称。
 *
 * 三组断言：
 *   ① 现在这套语料（GB 4785 / GB 4785-2019 / UN R48-09）的各种写法都要认得出；
 *   ② **换一套标准**（假表）也要认得出 —— 这才是「泛化」那句声称的证据；
 *   ③ **认不出的不许瞎猜** —— 老版本里有一条正则优先级 bug，
 *      `/^GB\s*4785\D{0,3}XXXX|草案/` 实际是「以 GB 4785 开头 **或** 含『草案』」，
 *      于是**任何**带「草案」两个字的标签都被判成 A。
 *      现在判据是「从表里找前缀」，不再有那种误判。
 *
 * 运行：node _test_version_labels.mjs
 */
import { normVersionLabel, buildVersionMatcher } from "./dist/typedTables.js";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
};

// ── ① 现在这套语料 ────────────────────────────────────────────────
console.log("当前语料（GB 4785 / GB 4785-2019 / UN R48-09）：");
const current = [
  ["A", "A"],
  ["**A**", "A"],
  ["A 草案", "A"],
  ["A 版", "A"],
  ["GB 4785 草案", "A"],
  ["GB 4785 草案 V4.3.5", "A"],
  ["GB 4785—XXXX", "A"],
  ["B", "B"],
  ["**B**", "B"],
  ["B 现行", "B"],
  ["B 版", "B"],
  ["GB 4785-2019", "B"],
  ["GB 4785—2019", "B"],
  ["C", "C"],
  ["C UN", "C"],
  ["UN R48-09", "C"],
  ["UN R48", "C"],
  ["UN R48-09 + Suppl.1", "C"],
];
for (const [input, want] of current) {
  const got = normVersionLabel(input);
  ok(got === want, `「${input}」→ ${got ?? "（认不出）"}（应为 ${want}）`);
}

// ── ② 认不出的不许瞎猜 ────────────────────────────────────────────
console.log("\n认不出的不许瞎猜：");
for (const input of ["", "  ", "总计", "备注", "2024"]) {
  const got = normVersionLabel(input);
  ok(got === null, `「${input}」→ ${got ?? "null"}（应为 null）`);
}
// 老 bug：任何含「草案」的标签都被判成 A
ok(
  normVersionLabel("备注草案") === null,
  `「备注草案」→ ${normVersionLabel("备注草案") ?? "null"}（老版本会误判成 A —— 正则里 | 的优先级最低）`,
);
// 「UN R48 草案」：族名（UN R48）说了算 → C；老版本会判成 A
ok(
  normVersionLabel("UN R48 草案") === "C",
  `「UN R48 草案」→ ${normVersionLabel("UN R48 草案") ?? "null"}（应为 C：族名比「草案」这截更具体）`,
);
// 共用标准族时，光看族名**分不出是哪一版** → 不猜
ok(
  normVersionLabel("GB 4785") === null,
  `「GB 4785」→ ${normVersionLabel("GB 4785") ?? "null"}（应为 null：A 与 B 共用这个族名，分不出是哪一版）`,
);

// ── ③ 换一套标准 ──────────────────────────────────────────────────
console.log("\n换一套标准（假表：GB 24599 草案 / GB 24599-2024 / UN R149）：");
const fakeMeta = [
  {
    key: "A",
    label: "A 草案",
    desc: "",
    doc: "GB 24599 草案 V1.2",
    std: "GB 24599—XXXX",
    status: "",
  },
  {
    key: "B",
    label: "B 现行",
    desc: "",
    doc: "GB 24599-2024",
    std: "GB 24599—2024",
    status: "",
  },
  {
    key: "C",
    label: "C UN R149",
    desc: "",
    doc: "UN R149",
    std: "UN R149 + Suppl.1",
    status: "",
  },
];
const fakeMatcher = buildVersionMatcher(fakeMeta);
const fakeCases = [
  ["A", "A"],
  ["A 草案", "A"],
  ["GB 24599 草案", "A"],
  ["GB 24599 草案 V1.2", "A"],
  ["GB 24599—XXXX", "A"],
  ["B", "B"],
  ["B 现行", "B"],
  ["GB 24599-2024", "B"],
  ["GB 24599—2024", "B"],
  ["C", "C"],
  ["C UN R149", "C"],
  ["UN R149", "C"],
];
for (const [input, want] of fakeCases) {
  const got = fakeMatcher(input);
  ok(got === want, `「${input}」→ ${got ?? "（认不出）"}（应为 ${want}）`);
}

// 换标准后，**旧标准的写法必须认不出**（否则就是串台）
ok(
  fakeMatcher("GB 4785-2019") === null,
  `换标准后「GB 4785-2019」→ ${fakeMatcher("GB 4785-2019") ?? "null"}（应为 null，不能串台）`,
);

console.log(
  failures === 0
    ? `\n✓ 版本标签判据：${current.length + 5 + fakeCases.length + 1} 条全过`
    : `\n✗ 版本标签判据：${failures} 条失败`,
);
process.exit(failures === 0 ? 0 : 1);
