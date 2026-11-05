/**
 * §11.10 —— **定性义务全量台账（按义务面）**（客户 DR-013）
 *
 * ## 为什么要有这一节
 *
 * 客户 DR-013 说的是：
 *
 * > 「§11.9 列 9 项且非穷举；附录 H 给材料不替读者下结论」
 * > 「定性义务没有形成完整、可执行的差异台账」
 * > 「**证据材料不等于差异分析**」「客户仍需自行判断大量条款」
 * > 修改建议：**按义务面建立全量台账，优先裁定 H 中高相似条目并回流摘要**
 *
 * §11.9 是**变化清单**（9 条已核实的差异）；附录 H 是**材料**（条款并排原文）。
 * 两者之间缺的那一层，就是这一节：**每一个义务面，A 怎么说 · B 怎么说 ·
 * C 怎么说 · 判定是什么 · 依据是什么**。
 *
 * ## 「优先裁定」怎么落地
 *
 * 台账里**还没裁**的条目按**相似度**排序 —— 越像的越靠前。
 * 客户要的不是「全都人工看一遍」，是「**先看最像的那些**」。
 * 人工裁过的结论记在 `data/qualitative-adjudications.json`（与机器判据分开），
 * 台账里逐条带**判定 + 依据 + 影响**。
 */
import fs from "node:fs";
import path from "node:path";
import { resolveInnerRoot } from "./innerRoot";

export interface LedgerSide {
  clause: string;
  page: string | number;
  text: string;
}

export interface LedgerEntry {
  key: string;
  device: string;
  aspect: string;
  surface: string;
  a: LedgerSide;
  b: LedgerSide;
  c?: { clause: string; page: number; heading: string; text: string; device: string };
  verdict: string;
  basis: string;
  similarity: number;
  segments: Array<{ a: string; b: string; kind: string }>;
  adjudicated: boolean;
  impact?: { design?: string; test?: string };
}

export interface LedgerFile {
  _meta: {
    purpose: string;
    unit: string;
    sources: Record<string, string>;
    verdictCounts: Record<string, number>;
    surfaceCounts: Record<string, number>;
    caveats: string[];
  };
  entries: LedgerEntry[];
}

const esc = (s: string): string => (s ?? "").replace(/\|/g, "｜").replace(/\r?\n/g, " ").trim();

const root = (): string => resolveInnerRoot();

export function loadQualitativeLedger(): { file: LedgerFile | null; error?: string } {
  const p = path.join(root(), "data", "qualitative-ledger.json");
  try {
    if (!fs.existsSync(p)) return { file: null, error: `data/qualitative-ledger.json 不存在（${p}）` };
    return { file: JSON.parse(fs.readFileSync(p, "utf-8")) as LedgerFile };
  } catch (e: any) {
    return { file: null, error: `data/qualitative-ledger.json 读取失败：${e?.message ?? e}` };
  }
}

/** 实质差异的判定词（台账里带「实质·」前缀的那些）。 */
const isSubstantive = (v: string): boolean => v.startsWith("实质·");
/** 「还没裁」的那些 —— 要排序给人工看。 */
const isPending = (v: string): boolean => v === "表述不等价·需人工判读";

/** 摘要用的几个数（执行摘要「回流」到这些数）。 */
export function ledgerSummary(): {
  total: number;
  substantive: number;
  pending: number;
  settled: number;
  nonSubstantive: number;
  withC: number;
  leadIn: number;
  notComparable: number;
  truncated: number;
  adjudicated: number;
  counts: Record<string, number>;
} | null {
  const { file } = loadQualitativeLedger();
  if (!file) return null;
  const es = file.entries ?? [];
  const counts = file._meta?.verdictCounts ?? {};
  const substantive = es.filter((e) => isSubstantive(e.verdict)).length;
  const pending = es.filter((e) => isPending(e.verdict)).length;
  const nonSubstantive = es.filter(
    (e) => e.verdict.startsWith("非实质·") || e.verdict === "同文",
  ).length;
  return {
    total: es.length,
    substantive,
    pending,
    settled: es.length - pending,
    nonSubstantive,
    withC: es.filter((e) => e.c).length,
    leadIn: es.filter((e) => e.verdict === "引出条款·实质内容见子条款").length,
    notComparable: es.filter((e) => e.verdict === "不可直接对读").length,
    truncated: es.filter((e) => e.verdict === "材料截断·不可判定").length,
    adjudicated: es.filter((e) => e.adjudicated).length,
    counts,
  };
}

function sideBrief(s: LedgerSide, label: string): string {
  return `**${label} §${esc(String(s.clause))}**（p${esc(String(s.page))}）`;
}

/** 一行台账的 A/B/C 定位。 */
function locus(e: LedgerEntry): string {
  const c = e.c ? ` ／ **C §${esc(e.c.clause)}**（p${e.c.page}）` : "";
  return `${sideBrief(e.a, "A")} ／ ${sideBrief(e.b, "B")}${c}`;
}

/**
 * §11.10 的正文。
 */
export function build11_10(): string {
  const { file, error } = loadQualitativeLedger();
  if (!file) {
    return [
      "### 11.10 定性义务全量台账（按义务面）",
      "",
      `> **本节数据不可用** —— ${esc(error ?? "未知原因")}。`,
      ">",
      "> 台账是**结论**（每个义务面都判过），不是材料；数据缺失时不以任何方式推测填补。",
    ].join("\n");
  }
  const es = file.entries ?? [];
  if (!es.length) {
    return [
      "### 11.10 定性义务全量台账（按义务面）",
      "",
      "> **本节无内容** —— 台账文件里没有任何条目。这是结论，不是缺漏。",
    ].join("\n");
  }

  const counts = file._meta?.verdictCounts ?? {};
  const surfaceCounts = file._meta?.surfaceCounts ?? {};
  const substantive = es.filter((e) => isSubstantive(e.verdict));
  const pending = es.filter((e) => isPending(e.verdict)).sort((a, b) => b.similarity - a.similarity);
  const nonSubstantive = es.filter(
    (e) => e.verdict.startsWith("非实质·") || e.verdict === "同文",
  );
  const leadIn = es.filter((e) => e.verdict === "引出条款·实质内容见子条款");
  const notComparable = es.filter((e) => e.verdict === "不可直接对读");
  const truncated = es.filter((e) => e.verdict === "材料截断·不可判定");
  const withC = es.filter((e) => e.c).length;
  const adjudicated = es.filter((e) => e.adjudicated).length;

  const out: string[] = [
    "### 11.10 定性义务全量台账（按义务面）",
    "",
    esc(file._meta?.purpose ?? ""),
    "",
    `本节是**按义务面**建立的**全量台账**：单位是「**装置 × 义务面**」，` +
      `共 **${es.length} 条**，每条给 A / B / C 三版的定位、**判定**与**依据**。`,
    "",
    "> **与 §11.9 / 附录 H 的分工**：§11.9 是**已核实的差异清单**（9 条）；",
    "> 附录 H 是**材料**（条款并排原文）；**本节是台账** —— 每一条都有判定，",
    "> 「同文 / 非实质 / 实质」三选一，判不出来的明写「需人工判读」。",
    "> **证据材料不等于差异分析**：材料摆在附录 H 里，判定在本节里。",
    "",
    "> **C 的位置**：C 侧给到**条款级**（§6.x.N + 页码），**不做逐字对读** ——",
    "> GB 与 R48 的条款编号体系不同构，逐号对读会造出假对应。",
    "",
    `> **覆盖**：${withC} / ${es.length} 条带 C 侧条款（C 侧抽不到的不留空位，见 11.10.5）。`,
    "",
    "#### 11.10.1 台账总览",
    "",
    "| 判定 | 条数 | 说的是什么 |",
    "|---|---|---|",
  ];
  const VERDICT_MEANING: Record<string, string> = {
    "同文": "归一化后逐字相同 —— 这一面在两版之间没有变化",
    "非实质·措辞/格式": "措辞、单位写法、记号（α/β）、标点、OCR 断字之差 —— **义务内容相同**",
    "非实质·编号重排": "只有交叉引用的条款号不同（编号重排）—— 指向同一条款",
    "实质·内容不同": "两版条文讲的不是同一件事 —— **要逐条看**",
    "实质·限值或口径不同": "限值或比较口径不同（长度已折算成毫米）",
    "实质·义务强度不同": "要求词不同（应 / 不应 / 必须 / 允许…）—— 义务的强弱变了",
    "引出条款·实质内容见子条款": "本条正文只有款名，实质内容在子条款 —— 逐字对读它没有意义",
    "不可直接对读": "两版条款编号体系不对读（装置或款不同），不并排",
    "材料截断·不可判定": "一侧原文在抽取时被截断 —— **材料不完整，不判**",
    "表述不等价·需人工判读": "机器判据覆盖不到 —— **排进待裁定清单，按相似度排序**",
  };
  for (const [v, n] of Object.entries(counts)) {
    out.push(`| ${esc(v)} | **${n}** | ${esc(VERDICT_MEANING[v] ?? "")} |`);
  }
  out.push("");
  out.push("**按义务面**看分布：");
  out.push("");
  out.push("| 义务面 | 条数 |", "|---|---|");
  for (const [s, n] of Object.entries(surfaceCounts)) {
    out.push(`| ${esc(s)} | ${n} |`);
  }
  out.push("");

  /* ---- 11.10.2 实质差异 ---- */
  out.push("#### 11.10.2 实质差异（要逐条看的那部分）");
  out.push("");
  out.push(
    `台账里判为**实质**的有 **${substantive.length} 条** —— ` +
      `其中 **${substantive.filter((e) => e.adjudicated).length} 条已人工逐条裁定**，` +
      `其余由机器判据判出（限值集合、要求词、内容差异）。`,
  );
  out.push("");
  out.push("| 装置 | 义务面 | A / B / C 定位 | 判定 | 依据 |");
  out.push("|---|---|---|---|---|");
  for (const e of substantive) {
    out.push(
      `| ${esc(e.device)} | ${esc(e.aspect || "—")} | ${locus(e)} | **${esc(e.verdict)}** | ${esc(e.basis)} |`,
    );
  }
  out.push("");
  const withImpact = substantive.filter((e) => e.impact);
  if (withImpact.length) {
    out.push("**已裁定且给出影响的条目**（设计 / 测试）：");
    out.push("");
    for (const e of withImpact) {
      out.push(`- **${esc(e.device)} · ${esc(e.aspect || "—")}**（${esc(e.verdict)}）：`);
      out.push(`  - **设计**：${esc(e.impact?.design ?? "")}`);
      out.push(`  - **测试**：${esc(e.impact?.test ?? "")}`);
      out.push(`  - **依据**：${esc(e.basis)}`);
    }
    out.push("");
  }

  /* ---- 11.10.3 非实质 ---- */
  out.push("#### 11.10.3 已判为非实质的条目");
  out.push("");
  out.push(
    `**${nonSubstantive.length} 条**判为「同文」或「非实质」—— ` +
      `它们**不是变化**，但**曾经被当成差异**（措辞、单位写法、编号重排、OCR 断字）。`,
  );
  out.push("");
  out.push("| 装置 | 义务面 | A / B 定位 | 判定 | 依据 |");
  out.push("|---|---|---|---|---|");
  for (const e of nonSubstantive.filter((x) => x.adjudicated).slice(0, 40)) {
    out.push(`| ${esc(e.device)} | ${esc(e.aspect || "—")} | ${locus(e)} | ${esc(e.verdict)} | ${esc(e.basis)} |`);
  }
  out.push("");
  out.push(
    `> 其余 ${Math.max(0, nonSubstantive.filter((x) => x.adjudicated).length - 40)} 条判为同文/非实质的条目` +
      `不在表里逐条列 —— **判定与依据在「data/qualitative-ledger.json」里逐条可查**。`,
  );
  out.push("");

  /* ---- 11.10.4 待裁定 ---- */
  out.push("#### 11.10.4 待人工判读清单（按相似度排序）");
  out.push("");
  out.push(
    `**${pending.length} 条**机器判不出来 —— **不猜**，标「需人工判读」，` +
      `并按**相似度**排序：**越像的越靠前**，先看这些最省事。`,
  );
  out.push("");
  out.push("| # | 相似度 | 装置 | 义务面 | A / B 定位 | 差异片段 |");
  out.push("|---|---|---|---|---|---|");
  pending.slice(0, 30).forEach((e, i) => {
    const segs = (e.segments ?? [])
      .slice(0, 4)
      .map((s) => `A「${esc(s.a)}」/B「${esc(s.b)}」`)
      .join("；");
    out.push(
      `| ${i + 1} | ${e.similarity.toFixed(3)} | ${esc(e.device)} | ${esc(e.aspect || "—")} | ` +
        `${sideBrief(e.a, "A")} ／ ${sideBrief(e.b, "B")} | ${segs} |`,
    );
  });
  out.push("");
  if (pending.length > 30) {
    out.push(
      `> 清单共 ${pending.length} 条，上面列出相似度最高的 **30 条**；` +
        `全部条目与差异片段见 \`data/qualitative-ledger.json\`。`,
    );
    out.push("");
  }

  /* ---- 11.10.5 不判的那些 ---- */
  out.push("#### 11.10.5 判不了的那些，为什么不判");
  out.push("");
  out.push("| 情形 | 条数 | 去向 |", "|---|---|---|");
  out.push(`| 引出条款（正文只有款名，实质内容在子条款） | ${leadIn.length} | 附录 H.2 已把子条款并排列出 |`);
  out.push(`| 不可直接对读（编号体系不对读） | ${notComparable.length} | 附录 H.4 |`);
  out.push(`| 材料截断（一侧原文被截断） | ${truncated.length} | 回原文重取材料后再判 |`);
  out.push("");
  out.push(
    "> **这三类不是「无差异」，是「不判」** —— 报告不拿它们凑「三版一致」。",
  );
  out.push("");
  out.push("#### 11.10.6 台账怎么核验");
  out.push("");
  out.push(
    "- **机器判的**（限值集合、要求词、编号重排、措辞）与**人判的**" +
      "（`data/qualitative-adjudications.json`）**分开存放** —— 改一边不会顺手改另一边；",
    "- 每条人工裁定都带**依据**（读的是哪两句、为什么这么判）；",
    "- 闸门 `scripts/verify_qualitative_ledger.py` **不信那个 JSON**：重新从源 PDF 与" +
      "附录 H 的配对结果算一遍，逐条核对判定、引文与本节的计数。",
  );
  out.push("");
  out.push(
    `> **本节只判 A 与 B。** C 侧给到**条款级定位**（§6.x.N + 页码），` +
      `**不做逐字对读** —— 两套编号体系不同构，逐号对读会造出假对应。` +
      `C 与 A/B 的**差异分析**在 §12.6（数值）与第 14 章（章节级）。`,
  );
  return out.join("\n");
}
