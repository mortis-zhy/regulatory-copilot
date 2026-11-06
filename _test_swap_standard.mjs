/**
 * 「换标准」实验 —— **没有手写 spec，还能不能产出装置↔章？**
 *
 * ## 为什么这是关键的一关
 *
 * agent 的候选句是从**章里**捞的，而「这个装置住在哪一章」原来是从
 * **现有手写 spec 的正则**里反推的。于是换一套标准时：
 *
 * ```
 * 没有手写 spec → 推不出章号 → 候选为空 → agent 跑不起来 → 还是得手写 spec
 * ```
 *
 * 这是 agent-native 的**死结**。而 W1 的解法是：**章表从语料扫出来**，
 * 不依赖任何手写 spec。
 *
 * ## 怎么验
 *
 * 把 `parameter-specs.json` 里的**正则全部抽掉**（只留参数清单 ——
 * 「要测哪些参数」是可复用的，「这一版的值是多少」不是），
 * 重跑映射产出，然后断言：
 *
 * 1. **章表还在**（从语料扫的，不依赖 spec）；
 * 2. **装置↔章还在**（认得出来的那些）；
 * 3. **每条探针都过**（探针必须在那一版的语料里）；
 * 4. 与「有 spec 时」的版本**不矛盾**（认出来的章不能互相打架）。
 *
 * 跑法：`node _test_swap_standard.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(ROOT, "tmp", "swap-standard-test");
fs.mkdirSync(TMP, { recursive: true });

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    failed++;
    console.log(`  FAIL  ${msg}`);
  }
};

// --------------------------------------------------------------------------
// 造一份「没有手写正则」的 spec —— 只留参数清单
// --------------------------------------------------------------------------
const real = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "parameter-specs.json"), "utf8"));
const stripped = {
  ...real,
  specs: real.specs.map((s) => ({
    id: s.id,
    name: s.name,
    family: s.family,
    unit: s.unit,
    // **正则与 absent 全部抽掉** —— 这就是「换一套标准，还没写任何取值」的样子
  })),
};
const strippedPath = path.join(TMP, "specs-no-patterns.json");
fs.writeFileSync(strippedPath, JSON.stringify(stripped, null, 2));

// --------------------------------------------------------------------------
// 跑两遍：有 spec / 没 spec
// --------------------------------------------------------------------------
const runBuilder = (outPath, specsPath) => {
  const r = spawnSync("python", ["scripts/build_device_chapter_map.py"], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      DEVICE_CHAPTER_MAP_OUT: outPath,
      DEVICE_CHAPTER_MAP_SPECS: specsPath,
    },
  });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
};

const outWith = path.join(TMP, "map-with-specs.json");
const outWithout = path.join(TMP, "map-no-specs.json");

const r1 = runBuilder(outWith, path.join(ROOT, "data", "parameter-specs.json"));
ok(r1.status === 0, `有 spec 时跑不动：${r1.out.slice(-300)}`);
const r2 = runBuilder(outWithout, strippedPath);
ok(r2.status === 0, `**没有 spec 时跑不动**（死结还在）：${r2.out.slice(-300)}`);

if (failed) {
  console.log(`  FAIL  ${failed} 条`);
  process.exit(1);
}

const withSpec = JSON.parse(fs.readFileSync(outWith, "utf8"));
const noSpec = JSON.parse(fs.readFileSync(outWithout, "utf8"));

// ① 章表还在（从语料扫的）
const nChapters = Object.values(noSpec.chapters ?? {}).reduce((n, c) => n + Object.keys(c ?? {}).length, 0);
ok(nChapters > 0, "没有 spec 时章表是空的 —— 章表不该依赖手写 spec");
ok(
  Object.keys(noSpec.chapters ?? {}).length === Object.keys(withSpec.chapters ?? {}).length,
  "有没有 spec，章表的**版数**不一样",
);

// ② 装置↔章还在
const nDevices = Object.keys(noSpec.devices ?? {}).length;
ok(nDevices > 0, "没有 spec 时一个装置都接不上 —— 死结没解开");

// ③ 每条探针都过
const corpus = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "mineru-v4-data.json"), "utf8"));
const bad = [];
for (const [v, chapters] of Object.entries(noSpec.chapters ?? {})) {
  const text = String(corpus[v]?.fullText ?? "");
  for (const [prefix, info] of Object.entries(chapters ?? {})) {
    for (const probe of info.probes ?? []) {
      if (probe && !text.includes(probe)) bad.push(`${v} ${prefix} 「${probe}」`);
    }
  }
}
ok(bad.length === 0, `${bad.length} 条探针不在语料里：${bad.slice(0, 3).join("、")}`);

// ④ 与「有 spec 时」不矛盾：认出来的章必须一致（不许一会儿一个样）
let conflict = 0;
for (const [dev, perVersion] of Object.entries(noSpec.devices ?? {})) {
  for (const [v, chapters] of Object.entries(perVersion ?? {})) {
    const a = (withSpec.devices ?? {})[dev]?.[v];
    if (a && a.join(",") !== chapters.join(",")) conflict++;
  }
}
ok(
  conflict === 0,
  `${conflict} 处「有没有 spec」认出来的章不一样 —— 那说明它**确实**依赖了手写 spec`,
);

if (failed) {
  console.log(`  FAIL  ${failed} 条`);
  process.exit(1);
}
console.log(
  `  ✓ 没有手写 spec 也照样产出装置↔章（${nDevices} 个装置 · ${nChapters} 章 · 探针全过 · 与有 spec 时零矛盾）`,
);
