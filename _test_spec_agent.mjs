/**
 * **取值规格提议 agent** 的确定性回归用例。
 *
 * 分工
 * ----
 * · 这个文件（`_test_spec_agent.mjs`）跑**假模型** —— 零 API 成本、
 *   零抖动，进 `npm run verify`。它验的是三件事：
 *     ① 候选层捞出来的句子里**真的有那个值**（不是空转）；
 *     ② 校验层**该挡的挡住**（抓错章 / 框不到值 / 正则不合法）；
 *     ③ 提案层对模型输出的解析（`<think>`、代码围栏、缺字段）都处理得对。
 * · `scripts/run_spec_agent_regression.mjs` 跑**真模型** —— 那才是
 *   「泛化性」的实测数字，但会花钱、会有抖动，所以不进闸门，
 *   结果记在 `reports/spec-agent-baseline.json` 里。
 *
 * 跑法： node _test_spec_agent.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  deviceChapterPrefixes,
  dominantDeviceToken,
  candidateSentences,
  validateProposal,
  proposeSpec,
  parseJson,
  stripThink,
  toolCallsFromContent,
} from "./dist/specAgent.js";

let checks = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  checks++;
};

const readJson = (p, d) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return d;
  }
};

const specsDoc = readJson("data/parameter-specs.json", { specs: [] });
const specs = specsDoc.specs ?? [];
const clauseIndex = readJson("data/clause-index.json", { _clauses: {} })._clauses ?? {};
const corpus = readJson("dist/mineru-v4-data.json", {});

/* --- 1. 候选层：捞出来的句子里真的有那个值 ------------------------------- */
{
  const prefixes = deviceChapterPrefixes(specs, "dippedBeam", "A");
  ok(prefixes.length === 1, `近光灯在 A 版的章应只有一个，实际 ${JSON.stringify(prefixes)}`);
  ok(
    prefixes[0] === "5.2",
    `近光灯在 A 版应落在 §5.2，实际「${prefixes[0]}」`,
  );

  // **被归错前缀的别的灯必须被剔除**。
  // `dippedBeam.offRoadHeightOnly` 的中文名是「前雾灯越野车型放宽高度」，
  // 锚在前雾灯的章 —— 算进近光灯的章，候选句就会混进前雾灯的条文。
  const token = dominantDeviceToken(
    specs.filter((s) => s.id.split(".")[0] === "dippedBeam").map((s) => s.name),
  );
  ok(token === "近光灯", `近光灯的通用名应是「近光灯」，实际「${token}」`);
  ok(
    !prefixes.includes("5.4"),
    `近光灯在 A 版的章里混进了前雾灯的 5.4：${JSON.stringify(prefixes)}`,
  );

  // **GB 里根本没有的装置，推不出章号** —— 那是「数据不够」，
  // 不是「agent 不会」，两类不能混在一个分母里。
  const noSuchDevice = deviceChapterPrefixes(specs, "manoeuvringLamp", "B");
  ok(
    noSuchDevice.length === 0,
    `操纵灯在 GB-2019 里不存在，章号应推不出来，实际 ${JSON.stringify(noSuchDevice)}`,
  );

  const cands = candidateSentences(clauseIndex, "A", prefixes, { unit: "mm", limit: 200 });
  ok(cands.length > 0, "近光灯在 A 版没捞到任何候选句");
  // 候选句必须带条款号与页码 —— 模型靠这两个字段判断自己在读哪一条。
  ok(
    cands.every((c) => /^\d+(\.\d+)+$/.test(c.clause)),
    "有候选句的条款号不是条款号形态",
  );
  ok(
    cands.every((c) => c.page > 0),
    "有候选句没有页码 —— 模型无从回查",
  );
  // 高度这一族必须捞到 1200（近光灯最大离地高度，A 版 §5.2.4.2）
  const hit = cands.find((c) => c.nums.includes("1200"));
  ok(!!hit, "近光灯在 A 版的候选句里找不到 1200mm（最大离地高度）");
  ok(
    !!hit && hit.clause.startsWith("5.2"),
    `1200mm 那句的条款号应是 5.2.x，实际 ${hit?.clause}`,
  );

  // **候选层不得跨装置**：前雾灯的章（5.3 / 5.4）不该混进近光灯的候选。
  ok(
    !cands.some((c) => c.clause.startsWith("5.3") || c.clause.startsWith("5.4")),
    "近光灯的候选句里混进了别的灯的章（5.3 / 5.4）",
  );
}

/* --- 2. 校验层：该挡的挡住 ------------------------------------------------ */
{
  const prefixes = deviceChapterPrefixes(specs, "dippedBeam", "A");
  const doc = corpus.A;

  // 2a. 正确的一条：应当通过
  const good = {
    id: "x",
    version: "A",
    device: "dippedBeam",
    name: "近光灯最大离地高度",
    source: "5\\.2\\.4\\.2[^。]{0,80}?不大于\\s*(1200)\\s*mm",
    flags: "i",
  };
  const v1 = validateProposal(good, doc, prefixes, { unit: "mm" });
  ok(v1.ok, `一条正确的正则被挡住了：${v1.reason}`);
  ok(v1.nums.join() === "1200", `取值应为 1200，实际 ${JSON.stringify(v1.nums)}`);
  ok(v1.clause === "5.2.4.2", `条款号应为 5.2.4.2，实际 ${v1.clause}`);
  ok(v1.page === 26, `页码应为 26，实际 ${v1.page}`);

  // 2b. 正则不合法
  const v2 = validateProposal(
    { id: "x", version: "A", device: "dippedBeam", name: "x", source: "5\\.2\\.4\\.2([0-9]+" },
    doc,
    prefixes,
    { unit: "mm" },
  );
  ok(!v2.ok && /编译失败/.test(v2.reason ?? ""), `非法正则没被挡下：${v2.reason}`);

  // 2c. 抓不到 —— 条款锚点写错
  const v3 = validateProposal(
    { id: "x", version: "A", device: "dippedBeam", name: "x", source: "9\\.9\\.9\\.9\\s*(1200)" },
    doc,
    prefixes,
    { unit: "mm" },
  );
  ok(!v3.ok && /一条页都没命中/.test(v3.reason ?? ""), `抓不到的正则没被挡下：${v3.reason}`);

  // 2d. **框不到值** —— 捕获组里没有数字。
  //     这是最隐蔽的一类：匹配成功、数值为空，矩阵里会显示成空格子。
  const v4 = validateProposal(
    {
      id: "x",
      version: "A",
      device: "dippedBeam",
      name: "x",
      source: "5\\.2\\.4\\.2[^。]{0,40}?(高度)",
    },
    doc,
    prefixes,
    { unit: "mm" },
  );
  ok(!v4.ok && /不是值/.test(v4.reason ?? ""), `框不到值的正则没被挡下：${v4.reason}`);

  // 2e. **抓错章** —— 正则命中的是别的灯的条文。
  //     抽取器取的是**第一页命中**，所以这类正则会静默产出错值。
  //     A 版的 5.4 是**前雾灯**（近光灯是 5.2）—— 正则锚在前雾灯的条款上。
  const v5 = validateProposal(
    {
      id: "x",
      version: "A",
      device: "dippedBeam",
      name: "x",
      source: "5\\.4\\.4\\.2[\\s\\S]{0,200}?离地高度不大于\\s*(1500\\s*mm)",
    },
    doc,
    prefixes,
    { unit: "mm" },
  );
  ok(
    !v5.ok && /不在本装置的章/.test(v5.reason ?? ""),
    `抓错章的正则没被挡下：${v5.reason}`,
  );
}

/* --- 3. 提案层：模型输出的解析 ------------------------------------------- */
{
  ok(
    parseJson('<think>先想一下</think>{"source":"a","flags":"i"}')?.source === "a",
    "带 <think> 前缀的 JSON 没解析出来",
  );
  ok(
    parseJson('```json\n{"absent":"该版没有"}\n```')?.absent === "该版没有",
    "代码围栏里的 JSON 没解析出来",
  );
  ok(
    parseJson('前言 {"source":"x"} 后语')?.source === "x",
    "前后带话的 JSON 没解析出来",
  );
  ok(parseJson("完全不是 JSON") === null, "不是 JSON 的文本不该被解析成对象");
  ok(stripThink("<think>abc</think>def") === "def", "<think> 没剥干净");
  const calls = toolCallsFromContent('<invoke name="get_clause_text">{"version":"C","clause":"6.10.2"}</invoke>');
  ok(calls.length === 1 && calls[0].name === "get_clause_text", "文本形态的工具调用没解析出来");
  ok(calls[0]?.args?.clause === "6.10.2", "工具调用的参数没解析出来");
}

/* --- 4. 假模型跑通整条链路 ----------------------------------------------- */
{
  const prefixes = deviceChapterPrefixes(specs, "dippedBeam", "A");
  const cands = candidateSentences(clauseIndex, "A", prefixes, { unit: "mm", limit: 50 });
  const ctx = {
    clauseIndex,
    prefixesFor: (d, v) => deviceChapterPrefixes(specs, d, v),
    candidatesFor: (d, v, p) => candidateSentences(clauseIndex, v, p, { limit: 400 }),
  };
  const slot = {
    id: "dippedBeam.maxHeight",
    name: "近光灯最大离地高度",
    family: "安装高度 / 离地距离",
    unit: "mm",
    version: "A",
    device: "dippedBeam",
  };
  const p = await proposeSpec(ctx, slot, cands, async () => ({
    content:
      '<think>5.2.4.2 上限 1200</think>{"source":"5\\\\.2\\\\.4\\\\.2[^。]{0,80}?不大于\\\\s*(1200)\\\\s*mm","flags":"i","why":"锚在条款号上"}',
  }));
  ok(!p.error, `假模型的产物被当成错误：${p.error}`);
  ok(p.source?.includes("5\\.2\\.4\\.2"), "假模型的正则没保留下来");
  const v = validateProposal(p, corpus.A, prefixes, { unit: "mm" });
  ok(v.ok, `假模型的产物没通过校验：${v.reason}`);
  ok(v.nums.join() === "1200", `取值应为 1200，实际 ${JSON.stringify(v.nums)}`);

  // 模型说「该版没有」时，产物必须带 absent 而**不是**一个空正则
  const p2 = await proposeSpec(ctx, slot, cands, async () => ({
    content: '{"absent":"该版确实没有这条规定"}',
  }));
  ok(p2.absent === "该版确实没有这条规定", "absent 没被识别");
  ok(!p2.source, "absent 的产物不该同时带 source");
}

console.log(`_test_spec_agent.mjs — ${checks} checks passed`);
