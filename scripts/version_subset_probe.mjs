/**
 * 泛化能力实测：**同一套机制，换版本组合会怎样？**
 *
 * 这份脚本回答一个常被含糊的问题：「换个标准还能不能跑？」
 * 含糊的回答是「应该可以」；这里给的是**数**：
 * 换掉一版之后，矩阵还有多少行、多少格有值、空格有没有说清原因。
 *
 * ## 为什么测这个
 *
 * 「机制」与「内容」在这个项目里是分开的：
 *   - **机制**（版本无关）：抽取、矩阵构建、复核、渲染、闸门
 *   - **内容**（版本相关）：`data/parameter-specs.json` 这套 spec
 *
 * 换一套新标准，要重写的是**内容**。
 * 但「内容要重写」这句话掩盖了一个真问题：
 * **机制在只给两版、只给旧版、给三版时分别表现如何？**
 * 如果机制里有写死 A/B/C 的地方，症状会等到真换标准那天才出现 ——
 * 而那天正好是最忙的时候。
 *
 * ## 测什么
 *
 * 拿**真实语料**跑若干个版本子集，每��报：
 *   - 行数 / 取值位 / 有值的格数 / 每版的命中率
 *   - **空格子有没有说清原因**（`miss` 的三种归类）
 *   - 复核结论（回源 PDF 核过的比例）
 *
 * 用法： node scripts/version_subset_probe.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { buildParameterMatrix, loadSourceCorpus } = await import("../dist/parameterMatrix.js");

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "mineru-v4-data.json"), "utf8"));

console.log("正在读源 PDF 语料（用于回源复核）…");
const corpus = await loadSourceCorpus(ROOT, data);
console.log(
  "语料：" +
    Object.entries(corpus.pages)
      .map(([v, p]) => `${v}=${p.length}页`)
      .join(" · "),
);

/** 取一个版本子集。 */
const pick = (keys) => {
  const out = {};
  for (const k of keys) if (data[k]) out[k] = data[k];
  return out;
};

const SUBSETS = [
  ["A", "B", "C"],
  ["A", "B"],
  ["A", "C"],
  ["B", "C"],
  ["C"],
];

const rowsOut = [];
for (const keys of SUBSETS) {
  // 「多一版，但还没写它的 spec」—— 换标准时最先遇到的状态。
  // 用 A 的语料当第 4 版：spec 包里没有 D 的模式，于是 D 列全是「未建规则」，
  // **而且是有理由的空**（不是静默空）。
  if (keys.length === 3 && keys.join("/") === "A/B/C") {
    const four = { ...pick(keys), D: data.A };
    try {
      const r4 = buildParameterMatrix(four, corpus);
      const d = r4.rows.map((r) => r.cells.D);
      const dNoPattern = d.filter((c) => c.miss === "no-pattern").length;
      const dVerified = d.filter((c) => c.status === "verified").length;
      console.log(`\n=== A/B/C + D（第 4 版，尚未写它的 spec）`);
      console.log(
        `  行 ${r4.stats.rows} · 取值位 ${r4.stats.cells} · 有值 ${r4.stats.verified}` +
          `（D ${r4.stats.byVersion.D.hit}/${r4.stats.byVersion.D.total}）`,
      );
      console.log(
        `  D 列：已建规则 ${dVerified} · 未建规则 ${dNoPattern}` +
          ` —— **有理由的空，不是静默空**`,
      );
      rowsOut.push({
        versions: "A/B/C/D",
        rows: r4.stats.rows,
        cells: r4.stats.cells,
        verified: r4.stats.verified,
        newVersionColumn: { D: r4.stats.byVersion.D, noPattern: dNoPattern },
      });
    } catch (e) {
      console.log(`\n=== A/B/C + D：构建失败 —— ${String(e.message).slice(0, 200)}`);
      rowsOut.push({ versions: "A/B/C/D", error: String(e.message).slice(0, 160) });
    }
  }
  const sub = pick(keys);
  let res;
  try {
    res = buildParameterMatrix(sub, corpus);
  } catch (e) {
    console.log(`\n=== ${keys.join("/")}：构建失败 —— ${String(e.message).slice(0, 200)}`);
    rowsOut.push({ versions: keys.join("/"), error: String(e.message).slice(0, 160) });
    continue;
  }
  const { rows, stats } = res;
  const miss = { "no-pattern": 0, "no-match": 0, "not-specified": 0 };
  let noReason = 0;
  let corrobOk = 0;
  let corrobBad = 0;
  for (const r of rows) {
    for (const v of stats.versions) {
      const c = r.cells[v];
      if (c.status === "verified") {
        if (c.corroborated?.status === "on-page") corrobOk++;
        else corrobBad++;
        continue;
      }
      if (c.miss) miss[c.miss] = (miss[c.miss] ?? 0) + 1;
      // 「空着也要说清为什么空」：not-specified 必须带依据
      if (c.miss === "not-specified" && !String(c.absentReason ?? "").trim()) noReason++;
      if (!c.miss) noReason++;
    }
  }
  const hit = stats.versions.map((v) => `${v} ${stats.byVersion[v].hit}/${stats.byVersion[v].total}`);
  console.log(`\n=== ${keys.join("/")}（${stats.versions.length} 版）`);
  console.log(
    `  行 ${stats.rows} · 取值位 ${stats.cells} · 有值 ${stats.verified}（${hit.join(" · ")}）` +
      ` · 判定：变化 ${stats.changed}`,
  );
  console.log(
    `  空格子归类：已核「该版无此规定」 ${miss["not-specified"] ?? 0} · 未建规则 ${miss["no-pattern"] ?? 0}` +
      ` · 抽不到 ${miss["no-match"] ?? 0} · **没写原因的 ${noReason}**`,
  );
  console.log(`  回源复核：核过 ${corrobOk} · 没核过/没通过 ${corrobBad}`);
  rowsOut.push({
    versions: keys.join("/"),
    rows: stats.rows,
    cells: stats.cells,
    verified: stats.verified,
    hit: stats.byVersion,
    changed: stats.changed,
    emptyWithoutReason: noReason,
    corroboratedOk: corrobOk,
    corroboratedBad: corrobBad,
  });
}

const out = path.join(ROOT, "reports", "version-subset-probe.json");
fs.writeFileSync(out, JSON.stringify(rowsOut, null, 2));

// 机器可读的一行：闸门要拿它做断言。
const full = rowsOut.find((r) => r.versions === "A/B/C") ?? {};
const four = rowsOut.find((r) => r.versions === "A/B/C/D") ?? {};
const two = rowsOut.find((r) => r.versions === "A/B") ?? {};
console.log(
  "SUMMARY " +
    JSON.stringify({
      three: {
        rows: full.rows ?? 0,
        verified: full.verified ?? 0,
        emptyWithoutReason: full.emptyWithoutReason ?? -1,
        corroboratedOk: full.corroboratedOk ?? 0,
        corroboratedBad: full.corroboratedBad ?? -1,
      },
      four: {
        noPattern: four.newVersionColumn?.noPattern ?? -1,
        verified: four.verified ?? 0,
      },
      twoVersionFails: Boolean(two.error),
      twoVersionError: two.error ?? "",
    }),
);
console.log(`\n写出 ${out}`);
