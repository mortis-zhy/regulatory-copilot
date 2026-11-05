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

export interface QOElsewhere {
  /** 这一条登记覆盖的词（`absentTerms` 里的） */
  terms: string[];
  /** 「相关」= 同一义务确实在别处存在；「无关」= 同一个词出现在别的装置上 */
  verdict: "相关" | "无关";
  /** 在哪儿（条款号 / 脚注号 / 条目） */
  where: string;
  /** 「相关」的必须附上可在原文查到的引文 */
  quote?: string;
}

export interface QOFootnote {
  no: number;
  text: string;
  where: string;
}

export interface QOSide {
  clause: string;
  page: number;
  quote: string;
  absentTerms?: string[];
  /** 缺失结论的范围：「条款正文」还是「本版全篇」 */
  absentScope?: "clause" | "version";
  /** 全版扫描在别处的命中，逐条登记 */
  absentElsewhere?: QOElsewhere[];
  /** 脚注 —— 规定常常躲在脚注里（客户 DR-006） */
  footnote?: QOFootnote;
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

/** 一侧（版本）的渲染：条款号 + 页码 + 原文摘录（+ 状态 + 脚注）。 */
function sideCell(v: string, side: QOSide | undefined): string {
  if (!side) return "—";
  const q = esc(side.quote);
  let out = `**${v} §${esc(side.clause)}**（p${side.page}）<br>${q}`;
  if (side.status) out += `<br>**${v} 状态：${esc(side.status)}**`;
  if (side.footnote) {
    out +=
      `<br>**${v} 脚注 ${side.footnote.no}**：${esc(side.footnote.text)}` +
      `<br>（${esc(side.footnote.where)}）`;
  }
  return out;
}

/**
 * 缺失结论的**范围** —— 这一段是客户 DR-006 逼出来的。
 *
 * 「本版没有这条义务」是**版本级**主张，
 * 而条款正文扫描背书不了它（脚注、别的章节都在条款正文之外）。
 * 所以这里把「扫了哪儿、那儿有什么」摆出来：
 * 每个词在全版命中了没有、命中的是不是同一件事。
 */
function absenceScopeLine(e: QOEntry, corpus: Map<string, string>): string | null {
  const lines: string[] = [];
  for (const [v, side] of [
    ["A", e.a],
    ["B", e.b],
    ["C", e.c],
  ] as [string, QOSide][]) {
    const terms = side?.absentTerms ?? [];
    if (!terms.length) continue;
    const full = corpus.get(v) ?? "";
    const scope = side.absentScope ?? "clause";
    const regs = side.absentElsewhere ?? [];
    const flat = normForScan(full);
    const groups: string[] = [];
    const done = new Set<string>();
    for (const t of terms) {
      if (done.has(t)) continue;
      const hit = !!flat && normForScan(t).length > 0 && flat.includes(normForScan(t));
      if (!hit) {
        groups.push(`「${t}」**全版无命中**`);
        done.add(t);
        continue;
      }
      const reg = regs.find((r) => (r.terms ?? []).includes(t));
      if (!reg) {
        groups.push(`「${t}」全版命中（**未登记**）`);
        done.add(t);
        continue;
      }
      // 同一条登记覆盖的词合成一句，不重复念同一段位置
      const group = (reg.terms ?? []).filter((x) => terms.includes(x));
      group.forEach((x) => done.add(x));
      groups.push(`「${group.join(" / ")}」**${reg.verdict}**（${reg.where}）`);
    }
    const scopeLabel =
      scope === "version" ? "**本版全篇**" : "**该条款正文**（另做全版复核）";
    lines.push(`  - **${v}**（${scopeLabel}）：${groups.join("；")}`);
  }
  if (!lines.length) return null;
  return ["- **缺失范围**（扫了哪儿、那儿有什么）：", ...lines].join("\n");
}

/** 扫描用的归一化：去标签、去空白、转小写。 */
function normForScan(s: string): string {
  return (s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 各版全文 —— 供「缺失范围」那段做全版复核（读不到就不写那一段，不猜）。 */
function loadCorpusTexts(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const p = path.join(root(), "dist", "mineru-v4-data.json");
    if (!fs.existsSync(p)) return out;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && typeof (v as any).fullText === "string") {
        out.set(k, (v as any).fullText);
      }
    }
  } catch {
    /* 读不到就不写那段 */
  }
  return out;
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
    "> 标「C 部分对应」的，要看清差在哪一层（口径、范围、还是引用标准）；",
    "> 标「C **条款正文**无…」的，**还要看它的脚注** —— 规定常常躲在脚注里，",
    "> 而脚注不在条款正文之内（这一条是客户 DR-006 逼出来的）。",
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
  const corpus = loadCorpusTexts();
  let i = 1;
  for (const e of entries) {
    parts.push(`#### 11.9.${i} ${esc(e.device)} —— ${esc(e.title)}`, "");
    parts.push(`**义务面**：${esc(e.aspect)}　|　**变化性质**：${e.nature}`, "");
    parts.push("| 版本 | 条款与原文 |");
    parts.push("|---|---|");
    parts.push(`| **B 现行版**（GB 4785-2019） | ${sideCell("B", e.b)} |`);
    parts.push(`| **A 草案**（V4.3.5） | ${sideCell("A", e.a)} |`);
    parts.push(`| **C 参照**（UN R48-09） | ${sideCell("C", e.c)} |`);
    parts.push("");
    parts.push(`- **设计影响**：${e.designImpact}`);
    parts.push(`- **测试影响**：${e.testImpact}`);
    const scopeLine = absenceScopeLine(e, corpus);
    if (scopeLine) parts.push(scopeLine);
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
    "- **缺失结论有范围，范围要写出来**：「该条款正文没有」与「本版全篇没有」是两件事 —— " +
      "**条款正文扫描背书不了版本级主张**（脚注、别的章节都在条款正文之外）。" +
      "所以每条都标了范围，**全版扫描的每一处命中都登记了「相关 / 无关」与位置**；" +
      "标「相关」的还附上可在原文查到的引文（客户 DR-006：把 C 脚注 11 的缔约方选择权写成「完全没有」）。",
  );
  parts.push(
    "- **本节不含数值判断**：凡涉及取值大小的，一律以第 12 章参数矩阵为准；本节只处理" +
      "「该义务存不存在、适用范围多大、谁控制、什么不能做」。",
  );

  return parts.join("\n");
}
