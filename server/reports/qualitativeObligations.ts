// 第 11.9 节 —— 定性义务变化清单。
//
// 为什么这一节要单独存在
// ----------------------
// 第 12 章参数矩阵只装得下**数值**：安装高度、角度、光强、频率……
// 但客户真正的问题是「产品哪里不一样、要不要改、怎么改」。
// 配备 / 禁止 / 适用范围 / 控制逻辑 这类**定性**义务变化，矩阵里一行都装不下，
// 于是整份报告给人的印象变成了客户说的那句「这版和之前差别不大」。
//
// 证据从哪来
// ----------
// `data/qualitative-obligations.json` 是唯一数据源，每条都带 A/B/C 三版的
// 条款号 + 页码 + 原文摘录。`scripts/verify_qualitative_obligations.py` 把每一条
// 对回 `data/clause-index.json` 逐项核（条款存在 / 页码一致 / 摘录在正文里 /
// absentTerms 在原文中扫过确认「本版无此规定」）。
//
// 这一节**不做任何判断** —— 变化性质、设计影响、测试影响都写在数据里，
// 渲染器只负责摆出来。判断留给读者。
//
// 「宁可空着，不可错着」在这里的具体含义：清单只列已逐条回原文核验过的条目，
// 不追求覆盖全部。「C 无对应义务」必须有原文扫描背书，不能凭印象写。

import fs from "node:fs";
import path from "node:path";
import { resolveInnerRoot } from "./innerRoot";

export interface QOSide {
  clause: string;
  page: number;
  quote: string;
  absentTerms?: string[];
  status?: string;
  noteClause?: string;
}

export interface QOEntry {
  id: string;
  device: string;
  aspect: string;
  title: string;
  a: QOSide;
  b: QOSide;
  c: QOSide;
  nature: string;
  designImpact: string;
  testImpact: string;
  evidence: string;
  note?: string;
}

export interface QOFile {
  _meta: { title: string; purpose: string; aspects: string[]; cStatuses: string[]; coverage: string; verify: string };
  entries: QOEntry[];
}

const esc = (s: string): string => (s ?? "").replace(/\|/g, "｜").replace(/\r?\n/g, " ");

// 仓库根目录 —— 用共享的 resolveInnerRoot（按标记文件向上找），
// 不用 path.resolve(import.meta.dirname, "../..")：打包到 dist/ 后那是**外层**仓库。
const root = (): string => resolveInnerRoot();

export function loadQualitativeObligations(): { file: QOFile | null; error?: string } {
  const p = path.join(root(), "data", "qualitative-obligations.json");
  try {
    if (!fs.existsSync(p)) return { file: null, error: `data/qualitative-obligations.json 不存在（${p}）` };
    return { file: JSON.parse(fs.readFileSync(p, "utf-8")) as QOFile };
  } catch (e: any) {
    return { file: null, error: `data/qualitative-obligations.json 读取失败：${e?.message ?? e}` };
  }
}

/** 一侧（版本）的渲染：条款号 + 页码 + 原文摘录。 */
function sideCell(v: string, side: QOSide | undefined): string {
  if (!side) return "—";
  const q = esc(side.quote);
  return `**${v} §${esc(side.clause)}**（p${side.page}）<br>${q}`;
}

/**
 * 构建 §11.9 的 markdown。
 *
 * 表格结构刻意是「三列版本 × 一行义务」，而不是「一行一版本」——
 * 因为客户读的是「这一条义务，A/B/C 分别怎么规定」，横着比才看得出来。
 */
export function build11_9(): string {
  const { file, error } = loadQualitativeObligations();
  if (!file) {
    return [
      "### 11.9 定性义务变化清单（配备 / 禁止 / 适用范围 / 控制逻辑）",
      "",
      `> **本节数据不可用** —— ${esc(error ?? "未知原因")}。`,
      ">",
      "> 本节列的是**已回原文核验**的定性义务变化；数据缺失时不以任何方式推测填补。",
    ].join("\n");
  }

  const entries = file.entries ?? [];
  if (!entries.length) {
    return [
      "### 11.9 定性义务变化清单（配备 / 禁止 / 适用范围 / 控制逻辑）",
      "",
      "> **本节无内容** —— 清单文件里没有任何条目。这是结论，不是缺漏。",
    ].join("\n");
  }

  const parts: string[] = [
    "### 11.9 定性义务变化清单（配备 / 禁止 / 适用范围 / 控制逻辑）",
    "",
    esc(file._meta.purpose),
    "",
    `本节列出 **${entries.length} 条**已逐条回原文核验的定性义务变化，每条给 A/B/C 三版的` +
      `**条款号、页码、原文摘录**，并分列**设计影响**与**测试影响**。`,
    "",
    "> **与第 12 章的分工**：第 12 章参数矩阵只装**数值**（高度、角度、光强、频率…）；",
    "> 本节装**矩阵装不下的那部分** —— 「必须装 / 不得用 / 哪些车适用 / 谁来控制」。",
    "> 同一项义务若同时有数值差异，两处都会出现，以条款号对照。",
    "",
    "> **C 的位置**：本节每一行都给出 C 的对应状态。**C 不参与「A 相对 B 变了什么」的判定**，",
    "> 但它决定**这件事是不是国际法规已认可的做法** —— 标「C 无对应义务」的，是 A 单边加严；",
    "> 标「C 部分对应」的，要看清差在哪一层（口径、范围、还是引用标准）。",
    "",
  ];

  // —— 按义务面汇总 ——
  const byAspect = new Map<string, QOEntry[]>();
  for (const e of entries) {
    if (!byAspect.has(e.aspect)) byAspect.set(e.aspect, []);
    byAspect.get(e.aspect)!.push(e);
  }
  parts.push("**按义务面分布**", "");
  parts.push("| 义务面 | 条数 | 涉及装置 |");
  parts.push("|---|---|---|");
  for (const [aspect, rows] of byAspect) {
    const devices = [...new Set(rows.map((r) => r.device))].join("、");
    parts.push(`| ${esc(aspect)} | ${rows.length} | ${esc(devices)} |`);
  }
  parts.push("");

  // —— 逐条 ——
  let i = 1;
  for (const e of entries) {
    parts.push(`#### 11.9.${i} ${esc(e.device)} —— ${esc(e.title)}`, "");
    parts.push(`**义务面**：${esc(e.aspect)}　|　**变化性质**：${e.nature}`, "");
    parts.push("| 版本 | 条款与原文 |");
    parts.push("|---|---|");
    parts.push(`| **B 现行版**（GB 4785-2019） | ${sideCell("B", e.b)} |`);
    parts.push(`| **A 草案**（V4.3.5） | ${sideCell("A", e.a)} |`);
    parts.push(`| **C 参照**（UN R48-09） | ${sideCell("C", e.c)}${e.c?.status ? `<br>**C 状态：${esc(e.c.status)}**` : ""} |`);
    parts.push("");
    parts.push(`- **设计影响**：${e.designImpact}`);
    parts.push(`- **测试影响**：${e.testImpact}`);
    if (e.note) parts.push(`- **补充说明**：${e.note}`);
    parts.push(`- **证据状态**：${esc(e.evidence)}`);
    parts.push("");
    i++;
  }

  parts.push("---", "");
  parts.push("**本节的口径与边界**", "");
  parts.push(`- **范围**：${esc(file._meta.coverage)}`);
  parts.push(`- **核验方式**：${esc(file._meta.verify)}`);
  parts.push(
    "- **「某版没有此规定」不是散文**：清单里的缺失结论由 `absentTerms` 在该版原文中扫描得出，" +
      "并由 `scripts/verify_qualitative_obligations.py` 逐条复现。",
  );
  parts.push(
    "- **本节不含数值判断**：凡涉及取值大小的，一律以第 12 章参数矩阵为准；本节只处理" +
      "「该义务存不存在、适用范围多大、谁控制、什么不能做」。",
  );

  return parts.join("\n");
}
