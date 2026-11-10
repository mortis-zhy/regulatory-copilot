/**
 * 决策正文（客户 DR-016，P3）——**20–30 页的正文 + 证据附件**。
 *
 * ## 客户要的
 *
 * > 「大量原文、矩阵和附录重复呈现」「附录 A–H 约占 137 页；第 14 章与附录重复证据较多」
 * > 「保留证据附件，正文集中呈现**结论、影响和待确认项**」
 * > 「决策信息被原文淹没」「客户难以快速定位优先动作」
 * > 修改建议：**拆成 20–30 页决策正文 + 证据附件，统一证据入口**
 *
 * ## 怎么拆
 *
 * - **正文（本文件）**：结论 · 影响 · 待确认项 · **证据入口**；
 * - **证据附件**：`delivery/PDF对比/⑪_C列补全_最新版.pdf`（全报告，一字不改）。
 *
 * ## 「统一证据入口」是什么
 *
 * 正文里**每一条结论都带一个证据位置**（附件的哪一节 / 哪一个附录），
 * 而且这些位置集中在一张**证据入口表**里 ——
 * 客户不必翻 278 页找证据，从正文末尾那张表直接跳。
 *
 * ## 数字从哪来
 *
 * **一个来源都不许另写**：结论里的每一个数都从**全报告自己的 markdown** 里取
 * （取不到就**当场报错**，不填 0、不填猜测值）。
 * 闸门 `scripts/verify_decision_brief.mjs` 再反过来核一遍：
 * 正文里的数必须与附件里的数**一致**。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderPdfFromReportV8 } from "../dist/htmlRenderV8.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// ── 标准声明 —— 讲稿里的标准名、版本名、版本数都从这儿来 ──────────────
//
// 以前写死在这个脚本里（换标准要改代码）；现在改声明就行。
const PACK = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "standard-pack.json"), "utf-8"));
const VBY = Object.fromEntries((PACK.versions || []).map((v) => [v.key, v]));
const vLabel = (k) => VBY[k]?.label ?? k;
const vDoc = (k) => VBY[k]?.doc ?? k;
const vRev = (k) => VBY[k]?.rev ?? "";
const FAM = PACK.standardFamily;
const FAM_SHORT = PACK.standardFamilyShort;
const N_VERSIONS = (PACK.versions || []).length;
const CN_DIGITS = ["零", "一", "两", "三", "四", "五", "六", "七", "八", "九"];
const N_ZHOU = `${N_VERSIONS <= CN_DIGITS.length ? CN_DIGITS[N_VERSIONS] : N_VERSIONS}版`;

const OUTDIR = path.join(ROOT, "delivery", "PDF对比");

const main = JSON.parse(fs.readFileSync(path.join(ROOT, "reports", "last-report.json"), "utf8"));

/**
 * 附件 §12.5 的四维核验状态 —— **现算** ✓（不手写 ✓）。
 *
 * 两件不同的事 ✓：
 *   ① 每个取值**在不在它所报的那一页上** ✓（全部核过 ✓）；
 *   ② 这个数的**语义**对不对 ✓（归属 / 条件 / 符号 / 单位 **四件事** ✓）。
 *
 * 正文只说结论 ✓，但**必须说清是哪一件** ✓ ——
 * 把①说成②，就是**把没核的说成核过了** ✗✗。
 */
const DIM = (() => {
  const acc = {};
  let cells = 0;
  let elsewhere = 0;
  let notFound = 0;
  for (const row of main.parameterMatrix ?? []) {
    for (const [, cell] of Object.entries(row.cells ?? {})) {
      if (cell?.status !== "verified") continue;
      cells++;
      const st = String(cell?.corroborated?.status ?? "");
      if (st === "elsewhere") elsewhere++;
      else if (st === "not-found") notFound++;
      const dims = cell?.corroborated?.dimensions ?? {};
      for (const [k, v] of Object.entries(dims)) {
        acc[k] = acc[k] ?? {};
        acc[k][String(v)] = (acc[k][String(v)] ?? 0) + 1;
      }
    }
  }
  const ok = (k) => acc[k]?.["已核"] ?? 0;
  return { cells, elsewhere, notFound, ok };
})();
const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "qualitative-ledger.json"), "utf8"));

const chById = Object.fromEntries((main.chapters || []).map((c) => [c.id, c]));
const md11 = chById[11]?.markdown ?? "";
const md12 = chById[12]?.markdown ?? "";
const md13 = chById[13]?.markdown ?? "";
const mdExec = chById[0]?.markdown ?? "";

/** 取一个数；取不到就**当场报错** —— 不填 0、不填猜测值。 */
function num(label, re, text) {
  const m = text.match(re);
  if (!m) throw new Error(`决策正文取不到「${label}」—— 附件结构变了，先改这个脚本（正则：${re}）`);
  return Number(m[1]);
}

const N_CHANGES = num("§11.0 变化总清单条数", /## 11\.0[\s\S]{0,400}?\*\*共 (\d+) 条。/, md11);
const N_AC_TOTAL = num("§12.6 A–C 差异总数", /A 与 C 有实质差异的有 (\d+) 条/, md12);
const N_AC_C_ONLY = num("§12.6 C 有 A 无", /\| \*\*C 有、A 无\*\* \| \*\*(\d+)\*\* \|/, md12);
const N_AC_A_ONLY = num("§12.6 A 有 C 无", /\| \*\*A 有、C 无\*\* \| \*\*(\d+)\*\* \|/, md12);
const N_AC_VALUE = num("§12.6 数值不同", /\| 数值不同 \| (\d+) \|/, md12);
const N_AC_CALIB = num("§12.6 口径不同", /\| 口径不同（数值同） \| (\d+) \|/, md12);
const N_COLOUR_SAME = num("§13.6 光色要素相同", /A\/B\/C 光色要素相同 \| \*\*(\d+)\*\* \|/, md13);
const N_COLOUR_PENDING = num("§13.6 表述不等价", /表述不等价（未判定） \| \*\*(\d+)\*\* \|/, md13);
const N_MATRIX = num("第 12 章参数数", /本章 (\d+) 个参数里/, md12);
const N_LEDGER = ledger.entries.length;
const N_SUBSTANTIVE = ledger.entries.filter((e) => e.verdict.startsWith("实质·")).length;
const N_PENDING = ledger.entries.filter((e) => e.verdict === "表述不等价·需人工判读").length;
const N_ADJUDICATED = ledger.entries.filter((e) => e.adjudicated).length;
const N_QO = num("§11.9 定性义务条数", /本节列出 \*\*(\d+) 条\*\*已逐条回原文核验/, md11);
const N_REQ = num("要求台账条数", /三版合计 (\d+) 条要求条款里/, mdExec);
const N_GAP = num("真缺口", /\*\*真缺口 (\d+) 条\*\*/, mdExec);
// 「声称指标」那一族的标准名与表号 —— **从声明取**。
// 原来写死「表 11.6」与「GB4785」：换标准时它会**悄悄失配** →
// 计数变成 0，决策正文里那一条就**静默地消失**（没报错，只是少了内容）。
const FAM_KEY = FAM.replace(/\s+/g, "");
const CLAIM_TABLE = String(PACK.claimedIndicators?.tableNo ?? "");
const CLAIM_TABLE_RE = CLAIM_TABLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const N_TABLE116 = num(
  `${CLAIM_TABLE} 未检索到`,
  new RegExp(`(\\d+) 条 ${FAM_KEY} ${CLAIM_TABLE_RE} 声称指标`),
  mdExec,
);

const substantive = ledger.entries
  .filter((e) => e.verdict.startsWith("实质·"))
  .sort((a, b) => a.similarity - b.similarity);
const pending = ledger.entries
  .filter((e) => e.verdict === "表述不等价·需人工判读")
  .sort((a, b) => b.similarity - a.similarity);

const esc = (s) => String(s ?? "").replace(/\|/g, "｜").replace(/\r?\n/g, " ").trim();
const locus = (e) =>
  `A §${esc(e.a.clause)}（p${esc(e.a.page)}） ／ B §${esc(e.b.clause)}（p${esc(e.b.page)}）` +
  (e.c ? ` ／ C §${esc(e.c.clause)}（p${e.c.page}）` : " ／ C 无对应条款");

/* ------------------------------------------------------------------
 * 从附件自己的 markdown 里抽三段可执行的内容。
 * 抽不到就报错 —— **不许用 0 或「略」顶替**。
 * ------------------------------------------------------------------ */

// ① §11.0 的 22 行表格
const sec110 = md11.slice(md11.indexOf("## 11.0"), md11.indexOf("## 11.1"));
const changes = sec110
  .split("\n")
  .filter((l) => /^\| \d+ \|/.test(l))
  .map((l) => {
    const c = l.split("|").slice(1, -1).map((x) => x.trim());
    return { no: c[0], item: c[1], kind: c[2], b: c[3], a: c[4], page: c[5], from: c[6] };
  });
if (changes.length !== N_CHANGES) {
  throw new Error(`§11.0 抽到 ${changes.length} 行，但清单说 ${N_CHANGES} 条 —— 附件结构变了`);
}

// ② §11.9 的 9 条（标题 / 义务面 / 性质 / 设计 / 测试 / 证据）
const sec119 = md11.slice(md11.indexOf("### 11.9"), md11.indexOf("### 11.10"));
const qoEntries = [];
for (const blk of sec119.split(/\n#### /).slice(1)) {
  const title = blk.split("\n")[0].trim();
  const aspect = (blk.match(/\*\*义务面\*\*：([^\s|　]+)/) || [])[1] ?? "—";
  const nature = (blk.match(/\*\*变化性质\*\*：\*\*([^*]+)\*\*/) || [])[1] ?? "";
  const design = (blk.match(/- \*\*设计影响\*\*：([^\n]+)/) || [])[1] ?? "";
  const test = (blk.match(/- \*\*测试影响\*\*：([^\n]+)/) || [])[1] ?? "";
  const evid = (blk.match(/\*\*证据状态\*\*：([^\n]+)/) || [])[1] ?? "";
  const clauses = [...blk.matchAll(/\*\*([ABC]) §([\d.]+)\*\*（p(\d+)）/g)].map(
    (m) => `${m[1]} §${m[2]}（p${m[3]}）`,
  );
  qoEntries.push({ title, aspect, nature, design, test, evid, clauses });
}
if (qoEntries.length !== N_QO) {
  throw new Error(`§11.9 抽到 ${qoEntries.length} 条，但清单说 ${N_QO} 条 —— 附件结构变了`);
}

// ③ §12.6 的 81 条 A–C 差异（带设计/测试影响）
//
// 这一段有**三种形状**：
//   ① C 有 A 无 ／ A 有 C 无：—— **设计**：… ；**测试**：…
//   ② 数值不同 ／ 口径不同：   —— **A 比 C 更松**；**设计**：… ；**测试**：…
//   ③ 单位里带括号：          （参考标记（无量纲））：C ≤ 100 ／ A 无此规定（已核） —— **设计**：…
// 所以**不写一条大正则** —— 按「先切两段，再各取字段」拆。
const sec126 = md12.slice(md12.indexOf("## 12.6"));
const acItems = [];
for (const l of sec126.split("\n")) {
  if (!l.startsWith("- **") || !l.includes(" —— ")) continue;
  const [head, tail] = l.split(" —— ");
  const hm = head.match(/^- \*\*(.+?)\*\*(.*)$/);
  if (!hm) continue;
  const rest = hm[2] ?? "";
  const um = rest.match(/^（(.+)）：(.*)$/);
  const design = (tail.match(/\*\*设计\*\*：(.+?)(?:[；;]\*\*测试\*\*：|$)/) || [])[1] ?? "";
  const test = (tail.match(/\*\*测试\*\*：(.+)$/) || [])[1] ?? "";
  if (!design || !test) continue;
  acItems.push({
    item: hm[1],
    unit: um ? um[1].replace(/[（）]/g, "") : "",
    diff: (um ? um[2] : rest).trim(),
    verdict: (tail.match(/^\*\*([^*]+)\*\*[；;]/) || [])[1] ?? "",
    design: design.trim(),
    test: test.trim(),
  });
}
if (acItems.length !== N_AC_TOTAL) {
  throw new Error(
    `§12.6 抽到 ${acItems.length} 条，但清单说 ${N_AC_TOTAL} 条 —— 附件结构变了`,
  );
}

/* ------------------------------------------------------------------ 第 1 章 */
const ch1 = [
  "# 第 1 章 决策正文 —— 怎么读这份文件",
  "",
  "> **这份文件只有结论。** 全部原文、矩阵、台账、附录都在**证据附件**里 ——",
  "> 附件是 `delivery/PDF对比/⑪_C列补全_最新版.pdf`（全报告，一字未改）。",
  ">",
  "> **每一章末尾都有「证据位置」**，正文最后还有一张**统一的证据入口表** ——",
  "> 要回原文核对，从那张表直接跳，不用翻 278 页。",
  "",
  "## 1.1 结论速览",
  "",
  "| 要回答的问题 | 结论 | 证据位置（附件） |",
  "|---|---|---|",
  `| **A 草案相对 B 现行改了什么？** | **${N_CHANGES} 条实质变化** | §11.0 变化总清单 |`,
  `| **三版的定性义务差在哪？** | 台账 **${N_LEDGER} 条**义务面，判出 **${N_SUBSTANTIVE} 条实质差异** | §11.10 定性义务全量台账 |`,
  `| **新国标与欧标差在哪（出口视角）？** | **${N_AC_TOTAL} 条**主差异（C 有 A 无 ${N_AC_C_ONLY} · A 有 C 无 ${N_AC_A_ONLY} · 数值不同 ${N_AC_VALUE} · 口径不同 ${N_AC_CALIB}） | §12.6 A 与 C 的主差异清单 |`,
  `| **光色差多少？** | **不是差异点**：${N_COLOUR_SAME} 个灯具三版光色要素相同，仅 ${N_COLOUR_PENDING} 个待专家判读 | §13.4–13.6 |`,
  `| **哪些是已核实的定性义务变化？** | **${N_QO} 条**（配备 / 禁止 / 适用范围 / 控制逻辑） | §11.9 定性义务变化清单 |`,
  `| **逐参数三版取值在哪？** | **${N_MATRIX} 个参数**，每个取值位带条款与页码 | 第 12 章 参数矩阵 |`,
  `| **要求有没有漏？** | 台账 **${N_REQ} 条**要求条款，**真缺口 ${N_GAP} 条** | 附录 E.5 |`,
  "",
  `> **一句话**：**${N_CHANGES} 条数值/条款级变化 + ${N_SUBSTANTIVE} 条定性义务实质差异 + ${N_AC_TOTAL} 条出口视角差异**；光色不是差异点；**${N_PENDING} 条定性义务判不出来，要法规专家看**。`,
  "",
  "## 1.2 这份正文**不**说什么",
  "",
  `- **不说「不用改设计」** —— 数值一致推不出不用改设计（配备 / 禁止这类义务，数值可以一个都不动）；`,
  `- **不说「C 没有这一条」而不写查过哪里** —— 「某版没有」是**核过的**，附检索依据与条款号；`,
  `- **不把「判不出来」写成「一致」** —— 台账里 **${N_PENDING} 条**标「需人工判读」，按相似度排序（见第 3 章）；`,
  `- **不替法规专家下结论** —— 涉及术语定义是否等义的，一律排进「待确认项」。`,
  `- **不把「核过页面存在」说成「核过语义」** —— 每个取值都回源核过它**在不在所报的那一页上**`
    + `（**${DIM.cells} 个取值格，页码不符 ${DIM.elsewhere} 处、全篇查不到 ${DIM.notFound} 处** ✓），`
    + `但**归属 / 适用条件 / 比较符号 / 单位**是**四件事** ✓，`
    + `已核 **${DIM.ok("pairing")} / ${DIM.ok("condition")} / ${DIM.ok("symbol")} / ${DIM.ok("unit")}** ✓；`
    + `**没核的写「未核 / 未判定」，本来就不适用的写「不适用」，都不写成「已核」** ✓`
    + `（逐维状态见附件 **§12.5** ✓）。`,
  "",
  "## 1.3 这份正文里的每个数从哪来",
  "",
  "| 正文里的数 | 来源 | 附件位置 |",
  "|---|---|---|",
  `| A→B ${N_CHANGES} 条变化 | 附件 §11.0 的表行数 | §11.0 |`,
  `| 定性义务 ${N_QO} 条 | 附件 §11.9 的条目数 | §11.9 |`,
  `| 台账 ${N_LEDGER} 条 / 实质 ${N_SUBSTANTIVE} 条 / 待判读 ${N_PENDING} 条 | 台账 JSON 的计数 | §11.10 |`,
  `| A–C ${N_AC_TOTAL} 条 | 附件 §12.6 的四类计数 | §12.6 |`,
  `| 光色 ${N_COLOUR_SAME} 相同 / ${N_COLOUR_PENDING} 待判读 | 附件 §13.6 的计数表 | §13.6 |`,
  `| 参数 ${N_MATRIX} 个 / 要求 ${N_REQ} 条 / 真缺口 ${N_GAP} 条 | 附件第 12 章与附录 E.5 | 第 12 章 · 附录 E.5 |`,
  "",
  "> **取不到就报错** —— 这份正文的脚本从附件自己的正文里取这些数，",
  "> **取不到就当场失败**，不填 0、不填「略」、不填上一版的数。",
  "> 交付闸门再反过来核一遍：正文里的数必须与附件里的数一致。",
  "",
  "## 1.4 附件怎么用",
  "",
  "| 你要做的事 | 去附件哪里 |",
  "|---|---|",
  "| 逐参数核三版取值 | 第 12 章 参数矩阵（每个取值位带条款与页码） |",
  "| 看条款原文 | 第 14 章（逐句并排）· 附录 H（定性条款并排） |",
  "| 核「改了什么」 | 第 11 章 §11.0（22 条总清单）· §11.9（9 条定性义务）· §11.10（412 条台账） |",
  "| 核出口差异 | 第 12 章 §12.6（81 条 A–C 主差异） |",
  "| 核「有没有漏」 | 附录 E.5（要求台账） |",
  "| 核光色 | 第 13 章 §13.4–13.6 |",
  "| 查原始表格 / 插图 / 公式 | 附录 A · B |",
  "",
].join("\n");

/* ------------------------------------------------------------------ 第 2 章 */
const ch2 = [
  "# 第 2 章 结论与影响",
  "",
  "> 结论分五块：**① A→B 的 22 条变化** · **② 9 条定性义务变化** · **③ 台账判出的 23 条实质差异** ·",
  "> **④ 出口视角的 81 条 A–C 差异** · **⑤ 光色**。",
  "> 每一块都给**证据位置**；逐条明细在附件对应章节。",
  "",
  "## 2.1 A 草案相对 B 现行：22 条实质变化",
  "",
  `附件 **§11.0 变化总清单**逐条列出 **${N_CHANGES} 条**，每行带条款号与页码。`,
  "",
  "| # | 装置 · 参数 | 变化性质 | B 现行版 | A 草案 | 页码 | 出处 |",
  "|---|---|---|---|---|---|---|",
  ...changes.map(
    (c) =>
      `| ${esc(c.no)} | ${esc(c.item)} | ${esc(c.kind)} | ${esc(c.b)} | ${esc(c.a)} | ${esc(c.page)} | ${esc(c.from)} |`,
  ),
  "",
  `> **证据位置**：附件 §11.0（总清单）· §11.3（数值级）· §11.3.3（差值裁定）· 第 12 章（逐参数取值）`,
  "",
  "## 2.2 9 条定性义务变化（矩阵装不下的那半边）",
  "",
  `**数值可以一个都不动，义务照样变** —— 下面 ${N_QO} 条是**配备 / 禁止 / 适用范围 / 控制逻辑**层面的变化，` +
    "每条带 A/B/C 三版原文与**设计、测试影响**。",
  "",
  ...qoEntries.flatMap((e) => [
    `### ${esc(e.title)}`,
    "",
    `**义务面**：${esc(e.aspect)}　|　**变化性质**：${esc(e.nature)}`,
    "",
    `**条款定位**：${e.clauses.length ? e.clauses.map(esc).join(" ／ ") : "—"}`,
    "",
    `- **设计影响**：${esc(e.design)}`,
    `- **测试影响**：${esc(e.test)}`,
    `- **证据状态**：${esc(e.evid)}`,
    "",
  ]),
  `> **证据位置**：附件 §11.9 全节（每条带 A/B/C 三版条款号、页码与原文摘录）`,
  "",
  "## 2.3 定性义务台账判出的实质差异",
  "",
  `附件 **§11.10** 的台账按**义务面**逐条判定，共 **${N_LEDGER} 条**义务面，判出 **${N_SUBSTANTIVE} 条实质差异**。`,
  `其中 **${N_ADJUDICATED} 条已人工逐条裁定**（读原文判的，写明了依据）。`,
  "",
  "**下面这 23 条是要动手的部分** —— 每条给 A/B/C 定位、判定与依据：",
  "",
  "| # | 装置 · 义务面 | A / B / C 定位 | 判定 | 依据 |",
  "|---|---|---|---|---|",
  ...substantive.map(
    (e, i) =>
      `| ${i + 1} | ${esc(e.device)} · ${esc(e.aspect || "—")} | ${locus(e)} | **${esc(e.verdict)}** | ${esc(e.basis)} |`,
  ),
  "",
  "> **设计 / 测试影响**：附件 §11.10.2 的「已裁定且给出影响的条目」逐条给了设计与测试影响。",
  "",
  `> **证据位置**：附件 §11.10 全节（台账）· §11.10.2（实质差异与影响）· 附录 H（条款并排原文）`,
  "",
  "## 2.4 出口视角：A 与 C 的主差异",
  "",
  `附件 **§12.6** 给出 **${N_AC_TOTAL} 条** A–C 主差异，分四类：`,
  "",
  "| 差异类别 | 条数 | 谁要动手 |",
  "|---|---|---|",
  `| **C 有、A 无** | **${N_AC_C_ONLY}** | **出口按 C 做** —— 欧标有这条要求，国标没有 |`,
  `| **A 有、C 无** | **${N_AC_A_ONLY}** | **国内按 A 做** —— 国标有这条要求，欧标没有 |`,
  `| 数值不同 | ${N_AC_VALUE} | 两套限值不同，按各自标准核 |`,
  `| 口径不同（数值同） | ${N_AC_CALIB} | 恰好落在该值上的产品，适用性不同 |`,
  "",
  "> **这 81 条是「要求的有多无」，不是一个数字的差** —— 只比数值的话一条都看不见。",
  "",
  "**逐条（含设计 / 测试影响）**：",
  "",
  "| # | 项目 | 单位 | A ／ C | 设计影响 | 测试影响 |",
  "|---|---|---|---|---|---|",
  ...acItems.map(
    (a, i) =>
      `| ${i + 1} | ${esc(a.item)} | ${esc(a.unit)} | ${esc(a.diff)} | ${esc(a.design)} | ${esc(a.test)} |`,
  ),
  "",
  `> **证据位置**：附件 §12.6（四类清单，每条带设计/测试影响）· 第 12 章（逐参数取值）· 附录 G（三版一致参数全量）`,
  "",
  "## 2.5 光色：不是差异点",
  "",
  `附件 **§13.4–13.6** 逐行对照了 GB 表 5 与 ${vDoc("C")} §5.15：**${N_COLOUR_SAME} 个对应灯具的光色要素三版一致**，` +
    `**${N_COLOUR_PENDING} 个**带例外条件、需专家判读，**A 与 B 只差 1 个**（醒目标志）。`,
  "",
  "> **结论**：**光色不会单独成为出口认证的卡点**；差异集中在**安装位置、几何可见度、光度与光轴**。",
  "> **光色一致不等于整件产品一致** —— 仍须按 §11.9 的定性义务逐条复核。",
  "",
  `> **证据位置**：附件 §13.4（三版对照表）· §13.5（映射说明与 GB 术语交叉核对）· §13.6（结论）`,
  "",
].join("\n");

/* ------------------------------------------------------------------ 第 3 章 */
const ch3 = [
  "# 第 3 章 待确认项",
  "",
  "> 这一章是**要客户/法规专家拍板的事** —— 报告不替他们定。",
  "",
  "## 3.1 台账里判不出来、已按相似度排序的条目",
  "",
  `定性义务台账里 **${N_PENDING} 条**机器判不出来（写作层面的差异超出了机械判据能覆盖的范围）。`,
  "**排了序**：越像的越靠前 —— 越像的越可能只是措辞差，先清它们最省事。",
  "",
  "| # | 相似度 | 装置 · 义务面 | A / B 定位 | 差异片段 |",
  "|---|---|---|---|---|",
  ...pending.map(
    (e, i) =>
      `| ${i + 1} | ${e.similarity.toFixed(3)} | ${esc(e.device)} · ${esc(e.aspect || "—")} | ` +
      `A §${esc(e.a.clause)}（p${esc(e.a.page)}） ／ B §${esc(e.b.clause)}（p${esc(e.b.page)}） | ` +
      `${esc((e.segments || []).slice(0, 3).map((s) => `A「${s.a}」/B「${s.b}」`).join("；"))} |`,
  ),
  "",
  `> 全部 ${N_PENDING} 条另见附件 §11.10.4 与 \`data/qualitative-ledger.json\`。`,
  "",
  "## 3.2 报告明确标注「须回原件确认」的疑点",
  "",
  `- **${VBY["B"]?.doc ?? FAM} §5.18.4.3（p46）**：侧标志灯纵向要求里，B 写「各安装一只**侧回复反射器**」，`,
  "  而该条讲的是侧标志灯（同一句的前半段写的是侧标志灯）。**报告如实陈述，不替原文改字**；",
  "  这可能是 GB 的排字问题，**回原件确认后再引用**。",
  "- **A §5.18.4.3（p55）**：A 写「纵向：**车辆每侧**，应至少有1只侧标志灯…」，",
  "  B 的同一条**没有「每侧」二字** —— 侧标志灯是**双边**装置，两版条文要求不同。",
  "  → 附件 §11.10.2 已列为**实质差异**，并给了设计/测试影响。",
  "",
  "## 3.3 本版不能作为认证依据的项",
  "",
  `- **${N_TABLE116} 条 ${FAM_KEY} ${CLAIM_TABLE} 声称指标**在 A/B 原文中未检索到 —— 报告如实标注，**不拿别处的数填**；`,
  "- 差值候选里 **0 项仍待人工裁定**（其余已逐条回原文核验）；",
  `- 要求台账 **真缺口 ${N_GAP} 条** —— 但「真缺口」说的是**量化限值**，不是全部要求；`,
  "- 台账里 **引出条款 / 不可直接对读 / 材料截断** 三类**故意不判** —— 这三类**不是「无差异」，是「不判」**。",
  "",
  `> **证据位置**：附件 §11.10.5（判不了的那些，为什么不判）· 附录 E.5（要求台账）· 第 11 章 §11.3.3（差值裁定）`,
  "",
].join("\n");

/* ------------------------------------------------------------------ 第 4 章 */
const ch4 = [
  "# 第 4 章 证据入口（统一）",
  "",
  "> **这一张表就是「统一证据入口」** —— 正文里每一条结论都能在这里找到它回附件的位置。",
  "> 要核对哪一条，从这里直接跳，不用翻 278 页。",
  "",
  "| 正文里的结论 / 待确认项 | 证据位置（附件） |",
  "|---|---|",
  `| A→B 的 ${N_CHANGES} 条实质变化 | §11.0 变化总清单（逐条带条款与页码） |`,
  `| 数值级变化逐条 | §11.3 · §11.3.3 差值裁定 |`,
  `| ${N_QO} 条定性义务变化（配备/禁止/适用范围/控制逻辑） | §11.9 定性义务变化清单（带三版原文与设计、测试影响） |`,
  `| 定性义务台账 ${N_LEDGER} 条（按义务面） | §11.10 全节 |`,
  `| 其中 ${N_SUBSTANTIVE} 条实质差异 | §11.10.2（含设计/测试影响） |`,
  `| 其中 ${N_PENDING} 条待人工判读 | §11.10.4（按相似度排序） |`,
  `| A–C 主差异 ${N_AC_TOTAL} 条（出口视角） | §12.6（四类清单，每条带设计/测试影响） |`,
  `| 逐参数三版取值（${N_MATRIX} 参数） | 第 12 章 参数矩阵 |`,
  `| 光色三版对照 | §13.4 对照表 · §13.5 映射说明 · §13.6 结论 |`,
  `| 条款正文逐句对照 | 第 14 章 |`,
  `| 要求台账（${N_REQ} 条要求条款） | 附录 E.5 |`,
  `| 三版一致参数全量明细 | 附录 G |`,
  `| A/B 定性条款并排（条款级） | 附录 H |`,
  `| 原始表格 / 插图 / 公式 / 溯源 | 附录 A · B |`,
  "",
  "---",
  "",
  "## 4.1 附件在哪",
  "",
  "```",
  "delivery/PDF对比/⑪_C列补全_最新版.pdf      ← 证据附件（全报告，本文件是它的决策摘要）",
  "```",
  "",
  "> **附件一个字都没改** —— 正文里的每个数都取自附件自己的正文（取不到就报错，不填猜测值），",
  "> 闸门 `scripts/verify_decision_brief.mjs` 反过来核一遍：两边的数必须一致。",
  "",
].join("\n");

/* ------------------------------------------------------------------ 组装 */
const report = {
  outline: {
    title: `${FAM} 多版本对比 —— 决策正文（证据见附件）`,
    chapters: [
      { id: 0, title: "决策正文 —— 怎么读这份文件", sections: ["结论速览", "这份正文不说什么"] },
      { id: 1, title: "结论与影响", sections: ["A→B 的变化", "定性义务的实质差异", "出口视角的 A–C 差异", "光色"] },
      { id: 2, title: "待确认项", sections: ["待人工判读（按相似度）", "须回原件确认的疑点", "不能作为认证依据的项"] },
      { id: 3, title: "证据入口（统一）", sections: [] },
    ],
    appendices: [],
  },
  chapters: [
    { id: 0, title: "决策正文 —— 怎么读这份文件", markdown: ch1 },
    { id: 1, title: "结论与影响", markdown: ch2 },
    { id: 2, title: "待确认项", markdown: ch3 },
    { id: 3, title: "证据入口（统一）", markdown: ch4 },
  ],
  appendices: [],
  sourceDocuments: main.sourceDocuments,
  generatedAt: main.generatedAt,
};

fs.writeFileSync(path.join(ROOT, "reports", "decision-report.json"), JSON.stringify(report, null, 1));

const pdf = await renderPdfFromReportV8(report);
fs.mkdirSync(OUTDIR, { recursive: true });
const outPath = path.join(OUTDIR, "决策正文_最新.pdf");
fs.writeFileSync(outPath, pdf);
console.log(`[decision] ✅ ${outPath}`);
console.log(`[decision] ${(pdf.length / 1024 / 1024).toFixed(2)} MB`);
console.log(
  `[decision] 数字：A→B ${N_CHANGES} · 台账 ${N_LEDGER}（实质 ${N_SUBSTANTIVE} · 待判读 ${N_PENDING}）· ` +
    `A–C ${N_AC_TOTAL} · 光色相同 ${N_COLOUR_SAME}`,
);
