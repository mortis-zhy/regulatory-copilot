/**
 * **案例包**的回归用例 —— 「通用流程」不许自动套用「案例资料」。
 *
 * ## 背景（同事在 GitHub issue #5 提的）
 *
 * 这个项目里有两类东西：
 *
 * | | 换一套标准时 |
 * |---|---|
 * | **通用流程**（上传 → 认版本 → 提取 → 比差异 → 标页码 → 出报告） | 不用改 |
 * | **案例资料**（哪些章节讨论远光灯、GB↔R48 的章节对应、人工核对过的结论） | **要重做** |
 *
 * 它们以前**混在一起** —— 报告生成时**不看输入是谁**，
 * 直接把案例资料套上去。于是上传一份**完全不同的法规**，
 * 报告里照样会出现「GB 与 UN R48 的章节对应」「9 条声称指标」——
 * **一本正经地讲错标准**，而读者分不出来。
 *
 * ## 这道用例验三件事
 *
 * 1. **本案例包管的文件 → 照常出报告**（别把正常路径挡了）；
 * 2. **外来的文件 → 判定为「尚未配置」，并说清理由**；
 * 3. **生成器拿到外来语料 → 当场拒绝**，不产出一份 GB 的报告
 *    （这是同事那条 issue 的核心症状）。
 *
 * 跑法：`node _test_case_pack.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
const ok = (cond, msg) => {
  if (cond) {
    console.log("  ✓ " + msg);
  } else {
    failed++;
    console.log("  FAIL  " + msg);
  }
};

const { matchCasePack, assertCasePack, CasePackNotConfiguredError } = await import(
  "./dist/casePack.js"
);
const { buildMinerUReport } = await import("./dist/reportV6.js");

console.log("=== 案例包判定 ===");

// --------------------------------------------------------------------------
// ① 本案例包管的文件 → 适用
// --------------------------------------------------------------------------
const corpus = JSON.parse(
  fs.readFileSync(path.join(ROOT, "dist", "mineru-v4-data.json"), "utf8"),
);
const own = Object.entries(corpus).map(([key, doc]) => ({
  key,
  sha256: doc.sourceSha256,
  text: doc.fullText,
}));
const ownDecision = matchCasePack(own);
ok(ownDecision.applies, "本案例包自己的语料 → 适用");
ok(
  ownDecision.perDoc.every((d) => d.by === "sha256"),
  "认出来靠的是**指纹**（零歧义）",
);
ok(
  ownDecision.perDoc.every((d) => d.matchedTo === d.key),
  "每一份都认成了自己那一版",
);

// --------------------------------------------------------------------------
// ② 外来的文件 → 「尚未配置」
// --------------------------------------------------------------------------
// 造一份**别的法规**的语料：指纹不同，正文也完全不同。
const foreignText =
  "本文件是另一部法规的正文，与本案例包的任何一版都没有共同内容。" +
  "它讲的是完全不同的装置、不同的章节号与不同的限值。" +
  "用来验证：外来的输入不会被套上 GB 4785 的案例资料。";
const foreign = matchCasePack([
  { key: "X", sha256: "0".repeat(64), text: foreignText },
]);
ok(!foreign.applies, "外来的文件 → **不适用**（不会套用案例资料）");
ok(
  foreign.reason.includes("尚未配置"),
  "理由里说清「尚未配置」：" + JSON.stringify(foreign.reason.slice(0, 40)) + "…",
);
ok(
  foreign.perDoc.every((d) => d.matchedTo === null),
  "每一份都**没**被认成案例包里的任何一版",
);

// ②b 指纹对得上 → 适用（即使正文被截断/换行）
const byShaOnly = matchCasePack([
  { key: "A", sha256: corpus.A.sourceSha256, text: "" },
]);
ok(byShaOnly.applies, "只有指纹对得上（正文缺失）→ 仍适用");

// ②c 内容对得上（同一份标准的另一个副本）→ 适用
const byContent = matchCasePack([
  { key: "A", sha256: "1".repeat(64), text: corpus.A.fullText },
]);
ok(byContent.applies, "内容与 A 版一致（另一个副本）→ 适用");
ok(
  byContent.perDoc[0].by === "content",
  "认出来靠的是**内容**（同一种表示互比）",
);

// --------------------------------------------------------------------------
// ②d 噪声副本 —— **客户上传自己那份**的情形
//
// 实测：同一份文件加 3% 字符噪声 + 丢 8% 段落，相似度掉到 0.43（< 0.7），
// 但**声明里的文件名签名**对得上 → 仍应适用 ✓
// （跨标准的相似度只有 0.14–0.16，这一档安全 ✓）。
// --------------------------------------------------------------------------
const noisy = (() => {
  const t = corpus.A.fullText;
  const chars = [...t];
  // 固定种子的伪随机：同样输入 → 同样结果（用例要可复现 ✓）
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < chars.length; i += 1) {
    if (rnd() < 0.03) chars[i] = "〇";
  }
  const paras = chars.join("").split("\n");
  return paras.slice(0, Math.floor(paras.length * 0.92)).join("\n");
})();
const noisyByName = matchCasePack([
  { key: "A", sha256: "2".repeat(64), text: noisy, name: "GB4785草案V4.3.5.pdf" },
]);
ok(
  noisyByName.applies,
  "噪声副本 + 文件名签名对得上 → 仍适用（客户上传自己那份的情形）",
);
const noisyForeignName = matchCasePack([
  { key: "A", sha256: "3".repeat(64), text: noisy, name: "some-other-regulation.pdf" },
]);
ok(
  !noisyForeignName.applies,
  "噪声副本 + 文件名对不上 → 拒绝（相似度不够又没有别的证据）",
);

// --------------------------------------------------------------------------
// ③ 生成器拿到外来语料 → 当场拒绝（同事那条 issue 的核心症状）
// --------------------------------------------------------------------------
let threw = null;
try {
  await buildMinerUReport(
    {
      X: {
        fileName: "other-regulation.pdf",
        fullText: foreignText,
        markdown: foreignText,
        tables: [],
        figures: [],
        equations: [],
        headings: [],
        blockTypes: {},
        sourceSha256: "0".repeat(64),
      },
    },
    { numericChanges: [], topicColumns: [], stats: {}, renumberedOnly: [] },
  );
} catch (e) {
  threw = e;
}
ok(threw !== null, "生成器对着外来语料 → **拒绝出报告**（不是产出一份 GB 的报告）");
ok(
  // **不认类身份**：esbuild 打包后，同一个类在两份 bundle 里是两个对象，
  // `instanceof` 会判 false ✗。认**行为**（错误码）才稳 ✓。
  String(threw?.code ?? "") === "case_pack_not_configured" ||
    String(threw?.name ?? "") === "CasePackNotConfiguredError",
  "拒绝的理由带「这套标准尚未配置」的错误码（" + String(threw?.code ?? threw?.name) + "）",
);
ok(
  String(threw?.message ?? "").includes("尚未配置"),
  "错误信息里说清「尚未配置」",
);

// --------------------------------------------------------------------------
// ④ assertCasePack：适用就放行
// --------------------------------------------------------------------------
let ok2 = false;
try {
  assertCasePack(own);
  ok2 = true;
} catch {
  ok2 = false;
}
ok(ok2, "assertCasePack：本案例包的语料 → 放行");

console.log(failed ? `\n✗ ${failed} 项没过` : "\n✓ 案例包用例全过");
process.exit(failed ? 1 : 0);
