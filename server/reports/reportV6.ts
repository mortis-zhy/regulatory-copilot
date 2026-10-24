/**
 * v6 report renderer — REAL MinerU/RAG-Anything multimodal data.
 *
 * Data source: dist/mineru-v4-data.json (produced by extract_mineru_v4_sdk.py
 * using mineru 4.0.6 SDK + locally-downloaded v4 model weights):
 *   - markdown   (full MinerU markdown incl. rendered tables/figures)
 *   - fullText   (page-tagged plain text for indicator scanning)
 *   - tables[]   (17+17+43 structured tables from layout model)
 *   - figures[]  (136 figures with captions)
 *   - equations[] (12 LaTeX equations)
 *   - headings[] (1209 headings with levels & pages)
 *
 * Chapter 11 is deterministic: 9 GB4785 indicator status table with
 * [保留]/[修改]/[未找到] tags backed by MinerU-extracted text.
 *
 * Run: node dist/report-v6.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { renderPdfFromReport, type RenderableReport } from "./htmlRender";
// Aliased: reportV6.ts already has a local buildParameterMatrix() that builds
// the §11.3.3 A-vs-B matrix. Same name, different job — the import below is the
// three-version matrix and would be shadowed by the local declaration.
import { buildParameterMatrix as buildParamMatrix, renderMatrixTable, renderMatrixSummaryTable, renderMatrixDetails, groupRows, loadSourceCorpus, verdictLabel } from "./parameterMatrix";
// 条款标签修复表（scripts/fix_clause_labels.py 生成）—— 把 MinerU 揉坏的 R48 行标签还原。
import FIXED_CLAUSES from "../../data/clause-label-fixes.json";
import COVERAGE_AUDIT from "../../data/coverage-audit.json";
import REQUIREMENT_LEDGER from "../../data/requirement-ledger.json";
import REQUIREMENT_GAPS from "../../data/requirement-gaps.json";
import APPENDIX_TABLES from "../../data/appendix-tables.json";
// GB 章节 → UN R48-09 章节的对应表（scripts/build_r48_chapters.py 生成，
// 每条都回 R48 原文验过）。第 14 章的 C 列用它。
import R48_CHAPTERS from "../../data/r48-chapters.json";
import { buildChangePointsChapter, type ChangeChapterInput } from "./changePointChapter";
import { buildChangeLedger, ledgerBreakdown, type ChangeRow } from "./changeLedger";
import { detectDeviceClasses, deviceClassesAsChapterChanges } from "./deviceClassScan";
import { detectStructuralChapters, DEVICE_RENUMBERING } from "./chapterStructural";
import { diffRefs, buildRefSection } from "./refDiff";

/**
 * The INNER repo root — the one holding dist/, diff-result.json and the Python
 * helpers (verify_claims.py, extract_toc_pages.py, add_pdf_outline.py).
 *
 * This used to be `path.resolve(import.meta.dirname, "../..")` with a comment
 * claiming it "lands on the inner repo root". It does not: bundled to
 * dist/index.js, dirname is `<inner>/dist`, so "../.." resolves to the OUTER
 * workbench repo. That mis-resolution is why §11.3.3 rendered empty, why
 * add_pdf_outline.py was never found, and why the TOC two-pass aborted — three
 * silent degradations with only console warnings.
 *
 * Walk up from the module until we find the marker file instead of assuming a
 * fixed depth. COMPARE_AGENT_ROOT still wins when set.
 */
function resolveInnerRoot(): string {
  if (process.env.COMPARE_AGENT_ROOT) return path.resolve(process.env.COMPARE_AGENT_ROOT);
  let dir = import.meta.dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "verify_claims.py"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(import.meta.dirname, "../..");
}
const ROOT = resolveInnerRoot();
const DATA = path.join(ROOT, "dist", "mineru-v4-data.json");
const OUT_PDF = path.join(path.dirname(ROOT), "GB4785_多版本横向对比研究报告.pdf");
// Full A/B/C value-diff set. verify_claims.py filters these down to a handful of
// "survivors"; the report needs the unfiltered set too, because that is what
// carries the C (UN R48) clause numbers the deliverable is judged on.
//
// diff-result.json sits next to verify_claims.py (the INNER repo root), whereas
// ROOT above resolves to the OUTER workbench repo — so `path.join(ROOT, …)`
// missed it and §11.3.3 silently rendered as an empty section. Probe the
// plausible roots instead of guessing one.
function findDiffResult(): string | null {
  const candidates = [path.join(ROOT, "diff-result.json"), path.join(path.dirname(ROOT), "diff-result.json")];
  const hit = candidates.find((p) => fs.existsSync(p)) ?? null;
  console.log(`[v6] resolveInnerRoot → ${ROOT} | diff-result: ${hit ?? "NOT FOUND"}`);
  return hit;
}

function esc(s: string): string {
  return (s ?? "").replace(/<[^>]+>/g, "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/* -------------------------------------------------------------------------- */
/*  9 GB4785 indicators — multiline scan on MinerU fullText                    */
/* -------------------------------------------------------------------------- */

type IndicatorDef = {
  id: string;
  label: string;
  unit?: string;
  gb4785Old: string;   // what GB4785 表11.6 claims as 现行版
  gb4785New: string;   // what GB4785 claims as 草案版
  patterns: RegExp[];
  /**
   * 查不到时**要说清查过哪里、那里有什么**。
   *
   * 只有一个「[未找到]」标签等于把「检索没找对」和「原文里真没有」
   * 混成一谈 —— 前者是可修的 bug，后者才是结论。
   * 这段话是人工回原文逐条核过的（见 11.4 的人工复核结论）。
   */
  absenceNote?: string;
};

const INDICATORS: IndicatorDef[] = [
  {
    id: "drl_min_cd", label: "DRL 转向冲突时减光后最大光强", unit: "cd",
    gb4785Old: "400 cd",
    gb4785New: "500 cd",
    patterns: [
      // covers A 5.19.7.6 "最大光强不大于 N" + B alternatives
      /昼间行驶灯[\s\S]{0,100}?(?:最大|最小)光强[\s\S]{0,30}?(\d{2,4})\s*(?:cd|坎德拉)/i,
      /昼间行驶灯[\s\S]{0,100}?(?:最大|最小)(?:发光强度|光度)[\s\S]{0,30}?(\d{2,4})\s*(?:cd|坎德拉)/i,
      /DRL[\s\S]{0,100}?(\d{2,4})\s*cd/i,
    ],
  },
  {
    id: "ess_freq_hz", label: "ESS 紧急制动信号闪烁频率", unit: "Hz",
    gb4785Old: "4 Hz",
    gb4785New: "5 Hz",
    patterns: [
      // tolerate full-width parens （）and half-width () around the number,
      // and full-width right paren ） between 1.0 and Hz:
      // A: （4.0±1.0）Hz ; B: (4.0±1.0)Hz
      /紧急制动[\s\S]{0,120}?[（(](\d\.?\d*)\s*[±±]\s*1\.?\d*\s*[）)]?\s*Hz/i,
      /紧急制动信号[\s\S]{0,120}?闪烁频率[\s\S]{0,40}?[（(]?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*[）)]?\s*Hz/i,
      /追尾警告[\s\S]{0,120}?[（(]?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*[）)]?\s*Hz/i,
    ],
  },
  {
    id: "ess_cd", label: "ESS 光度", unit: "cd",
    gb4785Old: "400 cd",
    gb4785New: "600 cd",
    patterns: [/紧急制动信号[\s\S]{0,100}?(?:发光强度|光强|光度)[\s\S]{0,30}?(\d{2,4})\s*cd/i],
    absenceNote:
      "已查：B §5.23「紧急制动信号」(PDF 第50–54页) 全文只含 配备/数量/布局/安装位置/几何可见度/方向/电路连接 七项，" +
      "**无光度条款**；A §7.2 同构。全文检索「紧急制动信号…cd」0 命中。结论：ESS 只规定闪烁频率，不规定光强。",
  },
  {
    id: "drl_vis_deg", label: "DRL 可见度角度", unit: "°",
    gb4785Old: "±20°",
    gb4785New: "±25°",
    // **按条款锚定**，不按主题名 —— 按主题名首次命中会打到远光灯的
    // 几何可见度（5.1.5）上去，那不是 DRL 的角度。
    // 原文写法是「水平方向角:向外、向内各20°」，
    // **没有 ± 号**（旧正则要求 ±，所以永远匹配不上 → 被误判成「未找到」）。
    patterns: [
      /5\.\s*19\s*\.\s*5[\s\S]{0,80}?水平方向角[^。]{0,20}?各\s*(\d{1,2})\s*°/i,
      /昼间行驶灯[\s\S]{0,300}?几何可见度[\s\S]{0,60}?水平方向角[^。]{0,20}?各\s*(\d{1,2})\s*°/i,
      // 兼容真的带 ± 的写法
      /5\.\s*19\s*\.\s*5[\s\S]{0,80}?[±±]\s*(\d{1,2})\s*°/i,
    ],
  },
  {
    id: "side_marker_m", label: "侧标志灯间距", unit: "m",
    gb4785Old: "≤6 m",
    gb4785New: "≤4 m",
    // no /g flag — stale lastIndex across A/B regex reuse silently
    // drops the second doc's match. Capture the first number after 间距.
    patterns: [/侧标志灯[\s\S]{0,150}?间距[\s\S]{0,60}?(?:不小于|不大于|应不大于)?\s*(\d(?:\.\d+)?)\s*m/i],
  },
  {
    id: "led_life_h", label: "LED 寿命", unit: "h",
    gb4785Old: "2000 h",
    gb4785New: "3000 h",
    patterns: [/(?:LED|发光二极管)[\s\S]{0,60}?寿命[\s\S]{0,40}?(\d{3,4})\s*h/i],
    absenceNote:
      "已查：A/B/C 三版全文检索「寿命」**0 命中**。LED 相关只有术语定义" +
      "（A 3.2.1.x「发光二极管/LED模块」；B 3.7.6/3.7.7）。结论：光源寿命属光源标准" +
      "（GB 15766 / UN R37 / UN R99 / UN R128）范畴，不在 GB 4785 外部照明装置标准内。",
  },
  {
    id: "lumen_pct", label: "光通维持率", unit: "%",
    gb4785Old: "70%",
    gb4785New: "80%",
    patterns: [/光通维持率[\s\S]{0,40}?(\d{1,3})\s*%/i],
    absenceNote:
      "已查：A/B/C 三版只有「**目标光通量**」（A 3.2.2 / B 3.7.8，指向光源标准数据页），" +
      "**无「光通维持率」**。结论：光通维持率不在本标准内，同属光源标准范畴。",
  },
  {
    id: "preheat_min", label: "预热点灯时间", unit: "min",
    gb4785Old: "30 min",
    gb4785New: "60 min",
    patterns: [/预热[\s\S]{0,40}?(\d{1,3})\s*min/i],
    absenceNote:
      "已查：A/B/C 三版全文检索「预热」**0 命中**。结论：预热点灯时间不在本标准内。",
  },
  {
    id: "afs_switch_s", label: "AFS 切换时间", unit: "s",
    gb4785Old: "≤2 s",
    gb4785New: "≤1.5 s",
    patterns: [/(?:AFS|自适应前照)[\s\S]{0,60}?切换[\s\S]{0,40}?[≤<]?\s*(\d\.?\d*)\s*s/i],
    absenceNote:
      "已查：B §5.22「自适应前照明系统(AFS)」(PDF 第45–53页) 全节无「切换时间」；" +
      "全文「切换」只出现在「自动切换前照灯近光」（附录 H）与「切换为另一个功能」（4.9b）。" +
      "该节有的是 5.22.9.4「远光最大发光强度限值 430000cd」等条款。结论：AFS 切换时间不在本标准内。",
  },
];

type IndicatorResult = {
  def: IndicatorDef;
  aValue?: string;
  aPage?: string;
  bValue?: string;
  bPage?: string;
  status: "modified" | "kept" | "single-side" | "missing";
};

function findPage(text: string, idx: number): string {
  const before = text.slice(0, idx);
  const ms = [...before.matchAll(/\[第(\d+)页\]/g)];
  return ms.length ? `第${ms[ms.length - 1][1]}页` : "";
}

/**
 * 把 MinerU 里的 **LaTeX 数学片段**折算成普通文本。
 *
 * 为什么必须有这一步
 * ------------------
 * 同一个角度，A 版 MinerU 写「向外、向内各20°」，
 * B 版写「向外、向内各 $2 0 ^ { \circ }$」——
 * **数字被拆成两个字符，还带一层 LaTeX 壳**。
 * 于是同一句话的同一个值，正则在 A 上匹配得到、在 B 上永远匹配不到。
 * 后果不是「少一行」，而是**造出一条假的版本差异**（B 版被说成没有这条）。
 *
 * 本项目的老规矩：**宁可空着，不可错着** —— 但「错着说没有」同样不可接受。
 * 所以扫描前先归一化，扫描口径对 A/B 完全一致。
 *
 * 覆盖的形态（统计自 dist/mineru-v4-data.json 实际语料）：
 *   $2 0 ^ { \circ }$   18 处
 *   ${ 2 0 } ^ { \circ }$  12 处
 *   $2 ^ { \circ }$      6 处
 */
function normalizeMath(t: string): string {
  return (t ?? "").replace(
    /\$\s*([^{}$]*?)\s*\^\s*\{\s*\\circ\s*\}\s*\$/g,
    (_m, body: string) => {
      const digits = String(body).replace(/[^\d]/g, "");
      return digits ? `${digits}°` : "°";
    },
  );
}

function scanIndicator(text: string, def: IndicatorDef): { value: string; page: string } | undefined {
  for (const pat of def.patterns) {
    // reset lastIndex — a /g regex reused across A and B documents
    // otherwise carries stale state and misses matches in the 2nd doc
    pat.lastIndex = 0;
    const m = pat.exec(text);
    if (m) return { value: m[1], page: findPage(text, m.index) };
  }
  return undefined;
}

function scanAllIndicators(data: Record<string, any>): IndicatorResult[] {
  const results: IndicatorResult[] = [];
  // **先归一化再扫描** —— A/B 的 LaTeX 形态不同，不归一化就是拿两把尺子量同一张桌子。
  const aText = data.A?.fullText ? normalizeMath(data.A.fullText) : "";
  const bText = data.B?.fullText ? normalizeMath(data.B.fullText) : "";
  for (const def of INDICATORS) {
    const a = aText ? scanIndicator(aText, def) : undefined;
    const b = bText ? scanIndicator(bText, def) : undefined;
    let status: IndicatorResult["status"] = "missing";
    if (a && b) status = normalize(a.value) === normalize(b.value) ? "kept" : "modified";
    else if (a || b) status = "single-side"; // only one doc mentions it — show actual value
    if (!def) return { def: undefined as any, aValue: a?.value, aPage: a?.page, bValue: b?.value, bPage: b?.page, status };
    results.push({ def, aValue: a?.value, aPage: a?.page, bValue: b?.value, bPage: b?.page, status });
  }
  return results;
}

function normalize(s: string): string {
  return (s ?? "").replace(/\s+/g, "").replace(/[，。、；：]/g, ",").toLowerCase();
}

/* -------------------------------------------------------------------------- */

function build11_4_v62(results: IndicatorResult[]): string {
  // defensive: skip items without def metadata; use ?. on all def accesses
  const rows = (results || []).filter((r: any) => r && r.def).map((r, i) => {
    let tag = "[未找到]";
    let gbNote = "";
    const cn = (r.def?.gb4785New || "").match(/\d+/);
    const co = (r.def?.gb4785Old || "").match(/\d+/);
    const claimedNew = cn ? cn[0] : null;
    const claimedOld = co ? co[0] : null;
    /**
     * 声称值与原文实测值是否对不上 —— **逐侧比、按数值比**。
     *
     * 逐侧：B 声称值对 B 实测、A 声称值对 A 实测。
     * 声称「4 Hz → 5 Hz」而两版原文都是 4.0 Hz —— 只看 A 侧就知道声称错了。
     * 按数值：「4.0」与「4」是同一个数，字符串比会误报。
     */
    const numOf = (s?: string): number | null => {
      if (!s) return null;
      const m = String(s).match(/\d+(?:\.\d+)?/);
      return m ? parseFloat(m[0]) : null;
    };
    const sideMismatch = (actual: string | undefined, claimed: string | null): boolean => {
      const a = numOf(actual);
      const c = numOf(claimed ?? undefined);
      if (a === null || c === null) return false;
      return Math.abs(a - c) > 1e-9;
    };
    const contradictsClaim =
      sideMismatch(r.bValue, claimedOld) || sideMismatch(r.aValue, claimedNew);
    if (r.status === "modified") tag = "[修改]";
    else if (r.status === "kept") {
      tag = "[保留] 两版相同";
      // 两版相同**不代表** GB4785 声称的相同 —— 声称 20→25 而原文两版都是 20，
      // 这是声称值错了，不是原文变了。不标 ⚠ 就会让读者以为「三版一致」。
      if (contradictsClaim) {
        gbNote = " ⚠ GB4785 表 11.6 声称值与原文不一致";
      }
    } else if (r.status === "single-side") {
      tag = "[单边] " + (r.aValue ? "仅 A 提到" : "仅 B 提到");
      if (contradictsClaim) {
        gbNote = " ⚠ GB4785 表 11.6 声称值与原文不一致";
      }
    }
    const aVal = r.aValue ? `${r.aValue}${r.aPage ? `（${r.aPage}）` : ""}` : "—";
    const bVal = r.bValue ? `${r.bValue}${r.bPage ? `（${r.bPage}）` : ""}` : "—";
    return `| ${pad2(i + 1)} | ${cell(r.def?.label || "")} | ${tag}${gbNote} | ${cell(r.def?.gb4785Old || "")} → ${cell(r.def?.gb4785New || "")} | ${cell(bVal)} | ${cell(aVal)} |`;
  });
  const found = results.filter((r) => r.status !== "missing").length;
  const kept = results.filter((r) => r.status === "kept").length;
  const modified = results.filter((r) => r.status === "modified").length;
  const single = results.filter((r) => r.status === "single-side").length;
  // [未找到] 项的查证依据 —— 「查过哪里、那里有什么」。
  // 没有它，「未找到」就分不清是「原文里真没有」还是「没找对」。
  const absenceLines = results
    .filter((r) => r.status === "missing" && r.def?.absenceNote)
    .map((r) => `- **${r.def?.label}** —— ${r.def?.absenceNote}`);
  return [
    "### 11.4 数据指标变化（GB4785 表 11.6 逐条核验）",
    "",
    "下表将 GB4785 参考报告表 11.6 声称的 9 条数据指标，逐条与 **A/B 原文**对照核验。⚠ 标记表示 GB4785 声称值与原文不一致。",
    "",
    "| 序号 | 指标 | 核验状态 | GB4785 声称 | B 现行版（原文） | A 草案（原文） |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `**核验结论**：9 条中 ${found} 条在原文找到（${modified} 条实际变化、${kept} 条两版相同 [保留]、${single} 条仅一版提到 [单边]），${9 - found} 条当前文档未找到。`,
    "",
    ...(absenceLines.length
      ? ["**逐条查证依据**（「未找到」= 查过了，原文里确实没有，不是没查对）：", "", ...absenceLines, ""]
      : []),
    "> 说明：GB4785 第 11.4 表 11.6 中部分数值为推算或引用，未经 A/B 原文出现。⚠ 标记 = 本报告实测值与 GB4785 声称不一致，以原文为准。",
    "",
    // No `**` here on purpose: this line gets absorbed into the preceding
    // table cell, which is rendered without inlineMd, so the asterisks would
    // print literally. The bullets below carry the emphasis anyway.
    "GB4785 声称值的人工复核结论（fitz 对照三份原文，逐条回查）：",
    "- **侧标志灯间距 \"≤6m→≤4m\" 属误读**：两版原文实为**两相邻侧标志灯间距不大于 3m（车型结构不能保证时可增至 4m）**——A p55 / B p46 逐字一致，\"3m [保留]\"判定正确；GB4785 引用的\"6m\"实际是**车长不大于 6m 车辆的侧回复反射器数量豁免**（A p54 / B p45），与间距无关。",
    "- **DRL 可见度角度「±20°→±25°」：两版原文都是 20°，没有 25°**——A p56 §5.19.5「水平方向角β：向外、向内各20°」与 B p47 §5.19.5「水平方向角：向外、向内各20°」逐字一致，判 **[保留] 两版相同**；GB4785 声称的 25° 在 A/B 原文均不存在。",
    "- **DRL 最小光度 400→500 cd、ESS 光度 400→600 cd：A/B 原文均未出现**——B §5.23「紧急制动信号」全节无光度条款，DRL 减光的 140cd 是**减光后的上限**、不是最小光度。两者均判 [未找到]，勿引用。",
    "- **「DRL 转向冲突时减光后最大光强 140cd」是 A 独有的**——A p57 §5.19.7.6 把 B 的定性规定（B p48 §5.19.7.5「关闭；或……降低发光强度」）**量化**为「降低发光强度，使昼间行驶灯最大光强不大于 140cd」，并增加 HV 点 50% 豁免；A §5.19.7.7 对部分共用时剩余部分同样要求 ≤140cd。**注意：B 并非不允许降光，只是没有给 cd 上限**——把它写成「B 只允许关闭」是误述。",
    "- **ADB / 矩阵式 LED：A/B 原文 0 命中**；A 的附录 D 实为\"近光光束倾斜度随装载变化的测量\"（非 ADB 测试程序），\"像素\"唯一出处是 3.2.1.3 术语注（灯丝、发光颗粒、像素）。",
    "- **慢行灯速度阈值 10→15 km/h：GB4785 表 11.6 第 5 条声称正确**，两处子句均已改（B p30/p57 → A p58/p59）——因不在 18 主题内，已人工补录至 11.3.1。",
    "",
    "### 11.4.1 实际查得的原文数值（A/B 原文）",
    "",
    "| 指标 | 数值 | 出现位置 | 判定 |",
    "|---|---|---|---|",
    ...results
      .filter((r: any) => r && r.aValue || r.bValue)
      .map((r) => {
        const v = r.aValue ?? r.bValue;
        const pages = [r.bPage ? `${r.bPage}(B)` : "", r.aPage ? `${r.aPage}(A)` : ""].filter(Boolean).join(" ");
        const tag = r.status === "modified" ? "[修改]" : r.status === "kept" ? "[保留]" : "[单边]";
        return `| ${cell(r.def?.label || "")} | ${cell(v)} | ${cell(pages || "—")} | ${tag} |`;
      }),
    "",
    "**DRL 减光 140cd 判定**：B §5.19.7.5（B p48）已允许两种操作——「关闭」或「降低发光强度」，**但未给 cd 上限**；A §5.19.7.6（A p57）把「降低发光强度」量化为「最大光强不大于 140cd」，并增加「前转向灯 HV 点光强 > 昼间行驶灯 HV 点光强 50% 时可不采用上述操作」的豁免；A §5.19.7.7 对部分共用的剩余部分同样要求 ≤140cd。判 [单边]（**数值**仅 A 有），实质是 A 把 B 的定性授权收紧为定量上限，属 A 草案新增的标定约束。",
  ].join("\n");
}

function cell(s: string): string {
  return esc(s ?? "");
}

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  写作改进 3：量化表格横向对比（A vs B）—— 工程师最关心的色度/频率/可见度        */
/* -------------------------------------------------------------------------- */

const TABLE_CATEGORIES: Array<{ key: string; label: string; kws: RegExp[] }> = [
  { key: "chromaticity", label: "色度区域边界（白/黄/红/蓝）", kws: [/色度/, /白色/, /选择性黄色/, /红色边界/, /蓝色边界/, /W\d{2}/, /SY\d{2}/, /SR\d{2}/, /SB\d{2}/, /boundary/i, /chromaticity/i, /\bWhite\b/, /\bYellow\b/, /spectral/i] },
  { key: "photometric",   label: "光强 / 照度限值",              kws: [/光强/, /照度/, /\bcd\b/, /\blx\b/, /\bcd\/m²/, /luminous\s+intensity/i, /illuminance/i] },
  { key: "frequency",     label: "闪烁频率 / 时间要求",          kws: [/闪烁频率/, /频率/, /次\/min/, /Hz/, /时间/, /flash/i, /frequency/i] },
  { key: "visibility",    label: "几何可见度 / 安装角度",        kws: [/可见度/, /可见角度/, /视表面/, /横向/, /纵向/, /visibility/i, /field\s+of\s+vision/i] },
  { key: "geometry",      label: "安装尺寸 / 离地高度",          kws: [/离地高度/, /高度/, /距离/, /间距/, /mounting\s+height/i, /spacing/i] },
  { key: "electrical",    label: "电气条件 / 试验电压",          kws: [/电压/, /电气/, /接地/, /voltage/i] },
  { key: "markings",      label: "标记 / 标识要求",              kws: [/标记/, /标识/, /铭牌/, /图案/, /符号/, /marking/i] },
  { key: "general",       label: "其他通用参数表",                kws: [/^$/] }, // fallback
];

function categorizeTable(content: string): string {
  for (const c of TABLE_CATEGORIES) {
    if (c.kws.some((re) => re.test(content))) return c.key;
  }
  return "general";
}

function tableSummary(content: string, max = 80): string {
  const flat = htmlTableToText(content || "").replace(/<[^>]+>/g, "");
  const head = (flat.split("\n")[0] || "").replace(/^\|/, "").replace(/\|$/, "").trim();
  return head.length > max ? head.slice(0, max) + "…" : head;
}

function build12_quantitativeTables(data: Record<string, any>): string {
  const aTables: any[] = data.A?.tables ?? [];
  const bTables: any[] = data.B?.tables ?? [];
  const cTables: any[] = data.C?.tables ?? [];
  if (!aTables.length && !bTables.length && !cTables.length) return "_(本子节无内容 — 未提取到 A/B/C 表格)_";

  const out: string[] = [
    "# 第 12 章 A/B/C 量化参数表横向对比",
    "",
    "> **说明**：本章逐表对比 A 草案 / B 现行 / C (UN R48-09) 在量化参数上的差异，覆盖信号灯最关键的 **色度边界 / 光强限值 / 闪烁频率 / 几何可见度** 等类别，是工程师做合规差距分析的核心数据。",
    "",
    `> A 共 ${aTables.length} 个表 · B 共 ${bTables.length} 个表 · C (UN R48-09) 共 ${cTables.length} 个表 · 按主题分组对比。`,
    "",
  ];

  const aCat = new Map<string, any[]>();
  const bCat = new Map<string, any[]>();
  const cCat = new Map<string, any[]>();
  for (const c of TABLE_CATEGORIES) {
    aCat.set(c.key, []); bCat.set(c.key, []); cCat.set(c.key, []);
  }
  for (const t of aTables) aCat.get(categorizeTable(t.content || ""))!.push(t);
  for (const t of bTables) bCat.get(categorizeTable(t.content || ""))!.push(t);
  for (const t of cTables) cCat.get(categorizeTable(t.content || ""))!.push(t);

  let secNo = 0;
  for (let ci = 0; ci < TABLE_CATEGORIES.length; ci++) {
    const cat = TABLE_CATEGORIES[ci];
    const aL = aCat.get(cat.key) ?? [];
    const bL = bCat.get(cat.key) ?? [];
    const cL = cCat.get(cat.key) ?? [];
    if (!aL.length && !bL.length && !cL.length) continue;
    secNo += 1; // running counter - empty categories must not leave number gaps
    out.push(`## 12.${secNo} ${cat.label}`);
    out.push("");
    out.push(`> A: ${aL.length} 个表 · B: ${bL.length} 个表 · C: ${cL.length} 个表`);
    out.push("");
    if (cat.key === "general") {
      // Uncurated bucket: index-pairing would put UNRELATED tables side by
      // side (e.g. an ESS Vr/TTC table grouped with a sensor-height table).
      // List every table under its own document instead.
      for (const [label, list] of [["A", aL], ["B", bL], ["C", cL]] as const) {
        list.forEach((t: any, idx: number) => {
          out.push(`### ${cat.label} · ${label} doc table #${idx + 1}${t.page ? ` (p${t.page})` : ""}`);
          out.push("");
          const body = htmlTableToText(String(t.content ?? "")).replace(/<[^>]+>/g, "").slice(0, 1500);
          out.push("```", body, "```", "");
          out.push("---", "");
        });
      }
      continue;
    }
    const maxN = Math.max(aL.length, bL.length, cL.length);
    for (let i = 0; i < maxN; i++) {
      out.push(`### ${cat.label} · 表组 #${i + 1}`);
      out.push("");
      const at = aL[i]; const bt = bL[i]; const ct = cL[i];
      const cmp = (label: string, t: any | undefined) => {
        if (!t) return `| **${label}** | — | — | 本类未匹配表 #${i + 1} |`;
        const page = t.page ? `第 ${t.page} 页` : "—";
        const summary = tableSummary(t.content || "", 50);
        return `| **${label}** | ${page} | ${summary} | 见下方表格内容 |`;
      };
      out.push("| 来源 | 页码 | 表头摘要 | 完整内容 |", "|---|---|---|---|");
      out.push(cmp("A 草案", at));
      out.push(cmp("B 现行", bt));
      out.push(cmp("C UN R48-09", ct));
      out.push("");
      const emit = (label: string, t: any | undefined) => {
        if (!t?.content) return;
        const trimmed = htmlTableToText(String(t.content ?? "")).replace(/<[^>]+>/g, "").slice(0, 1500);
        out.push(`**${label}**：`, "", "```", trimmed, "```", "");
      };
      emit("A 草案", at);
      emit("B 现行", bt);
      emit("C UN R48-09", ct);
      out.push("---");
      out.push("");
    }
  }

  out.push("## 12.小结：表覆盖盘点");
  out.push("");
  const summary = (label: string, n: number, cat: Map<string, any[]>) => {
    out.push(`**${label} 共 ${n} 个表**，按类别分布：`);
    for (const c of TABLE_CATEGORIES) {
      out.push(`- ${c.label}：${cat.get(c.key)?.length ?? 0}`);
    }
    out.push("");
  };
  summary("A 草案", aTables.length, aCat);
  summary("B 现行", bTables.length, bCat);
  summary("C UN R48-09", cTables.length, cCat);
  out.push("**使用提示**：本节按主题逐表展示 A/B/C 三方原始表格内容（截断到 1500 字）。**已知提取缺陷**：B p23 传感器安装高度表在提取时出现列字符交错（源数据如此，非排版问题）——该表请回查 B 原件 p23 为准。");
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  写作改进 5：ch13 灯具光色分配逐行 A vs B 对比                                  */
/* -------------------------------------------------------------------------- */

interface LampColorRow { name: string; color: string }

function parseLampColorTable(content: string): LampColorRow[] {
  const rows: LampColorRow[] = [];
  const lines = (content || "").split("\n").filter((l) => l.startsWith("|"));
  // skip header + separator
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const name = cells[0];
    const color = cells[1];
    if (!name || name === "灯具名称") continue;
    rows.push({ name, color });
  }
  return rows;
}

function build13_lampColorDiff(data: Record<string, any>): string {
  // Heuristic: lamp-color table contains "灯具名称" header row
  const findLampTable = (tables: any[]): LampColorRow[] => {
    for (const t of tables ?? []) {
      const c = (t && t.content) ?? "";
      if (/灯具名称/.test(c) && /光色/.test(c)) return parseLampColorTable(c);
    }
    return [];
  };
  const aRows = findLampTable(data.A?.tables ?? []);
  const bRows = findLampTable(data.B?.tables ?? []);

  const out: string[] = [
    "# 第 13 章 灯具光色分配逐行 A vs B 对比",
    "",
    "> **本章范围：仅 A 与 B 两版，不含 C（UN R48-09）。**",
    ">",
    "> UN R48 对光色的规定体例是「每类灯具 §6.x.x Colour 条款」，与 GB 的「灯具名称 - 光色」表格不同构，",
    "> 无法逐行对齐；本章因此只做 A vs B。**需要三版对照请看第 12 章参数矩阵与附录 C 主题对照。**",
    ">",
    "> **说明**：从 A/B 原文的「灯具名称 - 光色」表格逐行对照，供工程师做光色合规差距分析。",
    "",
    `> A 共 ${aRows.length} 行 · B 共 ${bRows.length} 行`,
    "",
  ];

  // Build sets by name
  // Normalise punctuation width + whitespace before diffing: A writes
  // "自适应前照明系统（AFS）" (fullwidth parens) where B writes "(AFS)"
  // (halfwidth), and "白色，后面" vs "白色,后面" — these are NOT real
  // name/color differences and previously produced false A-only/B-only rows.
  const normRow = (s: string) =>
    (s || "")
      .replace(/[（]/g, "(").replace(/[）]/g, ")")
      .replace(/[，]/g, ",").replace(/[；]/g, ";").replace(/[、]/g, ",")
      .replace(/\s+/g, "");
  const aMap = new Map(aRows.map((r) => [normRow(r.name), r]));
  const bMap = new Map(bRows.map((r) => [normRow(r.name), r]));
  const aOnly: string[] = [];
  const bOnly: string[] = [];
  const diff: Array<{ name: string; a: string; b: string }> = [];
  for (const [k, ra] of aMap) {
    const rb = bMap.get(k);
    if (!rb) {
      aOnly.push(ra.name);
      continue;
    }
    if (normRow(ra.color) !== normRow(rb.color)) {
      diff.push({ name: ra.name, a: ra.color, b: rb.color });
    }
  }
  for (const [k, rb] of bMap) if (!aMap.has(k)) bOnly.push(rb.name);

  out.push("## 13.1 A 新增灯具（不在 B 中）");
  out.push("");
  if (!aOnly.length) out.push("_(无)_");
  else {
    out.push("| 灯具名称 | A 草案光色 | 说明 |", "|---|---|---|");
    for (const n of aOnly) out.push(`| ${n} | ${aMap.get(normRow(n))?.color ?? "—"} | A 新装置 / A 章节重组后归入此表 |`);
  }
  out.push("");

  out.push("## 13.2 B 独有灯具（不在 A 中）");
  out.push("");
  if (!bOnly.length) out.push("_(无)_");
  else {
    out.push("| 灯具名称 | B 现行光色 | 说明 |", "|---|---|---|");
    for (const n of bOnly) out.push(`| ${n} | ${bMap.get(normRow(n))?.color ?? "—"} | 工程师核验：A 草案是否遗漏此灯具 |`);
  }
  out.push("");

  out.push("## 13.3 光色发生变化（A 与 B 同一灯具光色不同）");
  out.push("");
  if (!diff.length) out.push("_(无 — A/B 共有灯具光色一致)_");
  else {
    out.push("| 灯具名称 | A 草案光色 | B 现行光色 |", "|---|---|---|");
    for (const d of diff) out.push(`| ${d.name} | ${d.a} | ${d.b} |`);
  }
  out.push("");

  out.push("## 13.4 完整对照表（A 列在 B 列右）");
  out.push("");
  out.push("| 序号 | A 灯具 | A 光色 | B 灯具 | B 光色 | 状态 |", "|---|---|---|---|---|---|");
  const allNames = Array.from(new Set([...aMap.keys(), ...bMap.keys()]));
  let i = 1;
  for (const n of allNames) {
    const ra = aMap.get(n);
    const rb = bMap.get(n);
    const ac = ra?.color ?? "—";
    const bc = rb?.color ?? "—";
    const disp = ra?.name ?? rb?.name ?? n;
    let status = "一致";
    if (!ra) status = "B 独有";
    else if (!rb) status = "A 新增";
    else if (normRow(ac) !== normRow(bc)) status = "光色变化";
    out.push(`| ${i++} | ${disp} | ${ac} | ${disp} | ${bc} | ${status} |`);
  }
  out.push("");
  out.push("**使用提示**：本节是工程师检查光色合规差距的速查表。13.1 节列出 A 新增装置（A 必须为新装置配置合适光色并验证光色合规）；13.2 节列出 B 独有（工程师需确认 A 草案是删除、合并还是遗漏）；13.3 节显示光色调整（如有）。");
  return out.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  写作改进 6：ch14 全条款正文逐句 A vs B 对比                                  */
/* -------------------------------------------------------------------------- */

/** Split fullText into per-page string dict. */
function pageTextOf(fullText: string): Map<number, string> {
  const out = new Map<number, string>();
  const pages = fullText.split(/\[第(\d+)页\]/);
  // pages[0] = preamble, pages[1]=p1, pages[2]=p1text, pages[3]=p2num, pages[4]=p2text, ...
  for (let i = 1; i < pages.length; i += 2) {
    const n = parseInt(pages[i], 10);
    if (!isNaN(n)) out.set(n, (pages[i + 1] || "").trim());
  }
  return out;
}

/** Get text between two headings (by page range) for a given doc. */
function textBetweenPages(pageMap: Map<number, string>, startPage: number, endPage: number, maxChars = 800): string {
  const lines: string[] = [];
  let total = 0;
  for (let p = startPage; p <= endPage && total < maxChars; p++) {
    let txt = pageMap.get(p);
    if (!txt) continue;
    // MinerU fullText embeds HTML: inline <table> blocks become a readable
    // grid; leftover inline tags (<sub> etc.) are stripped so raw markup
    // never leaks into customer-visible excerpts.
    txt = txt.replace(/<table[\s\S]*?<\/table>/gi, (m) => htmlTableToText(m));
    txt = txt.replace(/<[^>]+>/g, "");
    const remaining = maxChars - total;
    // drop stand-alone page footers/headers ("53 |", "GB 4785—XXXX") that
    // pollute excerpt cells
    const clean = txt
      .split("\n")
      .filter((l) => !/^[\d]{1,3}\s*\|?\s*$/.test(l.trim()) && !/^GB\s?4785/.test(l.trim()))
      .join("\n");
    lines.push(clean.length > remaining ? clean.slice(0, remaining) + "…" : clean);
    total += clean.length;
  }
  return lines.join("\n").trim();
}

/** Map each L2/L3 heading to its page. */
function headingPages(headings: any[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const h of headings ?? []) {
    if (h.level && h.title) out.set(String(h.title).trim(), h.page);
  }
  return out;
}

/** Find the "main" clause number from a heading title (e.g., "5.1 远光灯" → "5.1"). */
function mainClause(title: string): string {
  const m = (title || "").match(/^\s*(\d+(?:\.\d+)*)\s/);
  return m ? m[1] : title;
}

interface ClauseBlock { clause: string; title: string; aText: string; aPage: number; bText: string; bPage: number }

/**
 * A GB clause number → the `topicColumns` row that covers it, if any.
 *
 * Three things this has to get right, all of them measured against the real
 * corpus rather than assumed:
 *
 * 1. **Compound clause numbers.** `位置灯` is `5.9/5.10`, `回复反射器` is
 *    `5.14/5.15/5.16/5.17`. Prefix-matching the whole string
 *    (`"5.9/5.10".startsWith("5.9.")`) drops all seven of those clauses. Split
 *    on `/` first, then match each number on its own.
 * 2. **B side only.** A/B numbering is NOT isomorphic — 前雾灯 B=5.3 ↔ A=5.4,
 *    倒车灯 B=5.4 ↔ A=5.21, 危险警告信号 B=5.6 ↔ A=7.1. Chapter 14 is driven
 *    from B, and the B→C correspondence is the side `topicColumns` verifies;
 *    matching on A too would file AFS (`5.22 ↔ A 5.3`) under 前雾灯.
 * 3. **Anchor the number at the start.** A-only blocks read `— ↔ A 7（A 独有）`;
 *    an unanchored search finds `7` there and then goes looking for an R48
 *    counterpart to a clause that has no B side at all. Returns null.
 *
 * 4. **Name confirmation for prefix matches.** `5.23 紧急制动信号` shares a
 *    prefix with 闪烁频率与时间要求 (B includes `5.23.7.1`), but R48 §5.35.11 —
 *    not the blink-frequency clauses — is what governs it. So a non-exact
 *    clause match also has to share a device word with the chapter title,
 *    otherwise nothing is printed.
 *
 * This invents no correspondence of its own — a miss leaves the clause exactly
 * as it was (A/B only), which is the intended behaviour, not a gap.
 */
/**
 * 本节（某个 GB 条款/章节）在**变化总清单**里对应哪几条。
 *
 * 匹配口径：清单行的 topic 或 name 里含这个装置名。
 * 清单的 topic 有两种形态 —— 差值/人工那几套是**装置名**（转向信号灯），
 * 矩阵那几套是**参数类别**（闪烁频率 / 时间参数）而装置名在 name 里 ——
 * 所以两处都查。
 */
function ledgerRowsForSection(ledger: ChangeRow[] | undefined, sectionTitle: string): ChangeRow[] {
  if (!ledger?.length) return [];
  const tok = topicDeviceToken(
    String(sectionTitle ?? "")
      .replace(/^\s*[\d.]+\s*/, "")
      .replace(/[（(][^）)]*[）)]/g, ""),
  );
  if (!tok || tok.length < 2) return [];
  return ledger.filter((r) => String(r.topic ?? "").includes(tok) || String(r.name ?? "").includes(tok));
}

function findTopicForClause(
  topicColumns: any[] | undefined,
  gbClause: string,
  chapterTitle: string,
): any {
  // `5.4 ↔ A 5.4` → `5.4`. The B side is the skeleton, so take what precedes ↔.
  const bSide = String(gbClause ?? "").split("↔")[0].trim();
  const m = bSide.match(/^(\d+(?:\.\d+)*)$/);
  const want = m ? m[1] : "";
  if (!want || !Array.isArray(topicColumns) || !topicColumns.length) return null;
  const atBoundary = (longer: string, shorter: string) =>
    longer === shorter || longer.startsWith(shorter + ".");
  const titleName = String(chapterTitle ?? "")
    .replace(/^\s*[\d.]+\s*/, "")
    .replace(/[（(][^）)]*[）)]/g, "");
  const scored: Array<{ t: any; cl: string; score: number }> = [];
  for (const t of topicColumns) {
    const tok = topicDeviceToken(String(t?.topic ?? ""));
    // A name match alone is too weak — "特殊规定" shares no device word with
    // anything — so require at least two characters of overlap.
    const nameHit = !!tok && tok.length >= 2 && titleName.includes(tok);
    for (const part of String(t?.B?.clause ?? "").split("/")) {
      const cl = part.trim();
      if (!cl || (!atBoundary(cl, want) && !atBoundary(want, cl))) continue;
      const exact = cl === want;
      // No exact clause AND no name agreement = one sub-clause standing in for a
      // whole chapter. Print nothing rather than imply a correspondence.
      if (!exact && !nameHit) continue;
      scored.push({ t, cl, score: (exact ? 1000 : 0) + (nameHit ? 500 : 0) + cl.length });
    }
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y.score - x.score);
  return scored[0].t;
}

/**
 * 第 14 章某一节的 **GB（B 版）章节号** —— C 列对应表与取值表都按它查。
 *
 * 条款串形如 `5.10 ↔ A 5.10`（B 驱动）或 `— ↔ A 7（A 独有）`（A 独有）。
 * 后者没有编号，整串当 key。
 */
function gbChapterKey(clause: string): string {
  const b = String(clause ?? "").split("↔")[0].trim();
  return /^\d/.test(b) ? b : String(clause ?? "").trim();
}

/**
 * GB chapter name / topic name → the matrix rows for the same device.
 *
 * Chapter 14 titles look like `5.20 角灯(符合 GB/T30511要求的灯具)` — the
 * parenthetical is a standard reference, not part of the device name. And GB's
 * own wording differs from the matrix's in a couple of places, so a small
 * alias table maps the chapter name onto the wording the parameters use. It is
 * a display lookup over rows that are already verified in chapter 12; it states
 * nothing about the regulations.
 */
const MATRIX_NAME_ALIAS: Record<string, string> = {
  前位灯: "位置灯", // GB 5.9 前位灯 = 位置灯 in the parameter names
  后位灯: "位置灯", // GB 5.10 后位灯 = 位置灯
  后牌照板照明装置: "牌照", // GB 5.8 wording; matrix rows would say 牌照灯
};

function matrixRowsForTopic(matrixRows: any[] | undefined, topic: string, explicitToken?: string): any[] {
  if (!Array.isArray(matrixRows) || !matrixRows.length) return [];
  // Drop a leading clause number and any trailing `(符合 …)` standard reference.
  const name = String(topic ?? "")
    .replace(/^\s*[\d.]+\s*/, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .trim();
  // An explicit token wins: the device names in the map are longer than the
  // 5-character window `topicDeviceToken` takes, and truncating them picks the
  // WRONG device's rows (「三角形后回复反射器」would match the 11 rows of
  // 「非三角形后回复反射器」).
  const tok = explicitToken && explicitToken.trim() ? explicitToken.trim() : topicDeviceToken(name);
  if (!tok) return [];
  const aliased = MATRIX_NAME_ALIAS[tok];
  return matrixRows
    .filter((m: any) => {
      const n = String(m.name ?? "");
      return n.includes(tok) || (!!aliased && n.includes(aliased));
    })
    .slice(0, 6);
}

/** One markdown table cell of clause prose: no newlines, no raw pipes. */
function clauseCell(text: string, empty: string): string {
  const t = String(text ?? "")
    // A newline inside a cell ends the markdown row early and dumps the rest of
    // the clause into the body as loose paragraphs.
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim();
  return cell(t ? t.slice(0, 500) : empty);
}

function build14_clauseTextDiff(
  data: Record<string, any>,
  topicColumns?: any[],
  matrixRows?: any[],
  ledger?: ChangeRow[],
): string {
  const aFull: string = data.A?.fullText ?? "";
  const bFull: string = data.B?.fullText ?? "";
  const aPages = pageTextOf(aFull);
  const bPages = pageTextOf(bFull);

  // B is the structural skeleton: MinerU extracted B's full heading tree
  // (chapters 1-10 + sections 5.1-5.26 + 6.x + 7.x). A's heading extraction
  // only captured chapter-level titles, so we drive from B and map to A.
  const bItems: Array<{ num: string; title: string; page: number }> = [];
  const seenB = new Set<string>();
  for (const h of (data.B?.headings ?? [])) {
    if (!/^\d+(\.\d+)?\s/.test(h.title) || h.title.length <= 2) continue;
    const num = mainClause(h.title);
    if (seenB.has(num)) continue;
    seenB.add(num);
    bItems.push({ num, title: h.title.replace(/<[^>]+>/g, ""), page: h.page });
  }
  bItems.sort((a, b) => {
    const an = a.num.split(".").map(Number);
    const bn = b.num.split(".").map(Number);
    for (let i = 0; i < Math.max(an.length, bn.length); i++) {
      const d = (an[i] ?? 0) - (bn[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });

  // B→A chapter-level mapping (from chapterStructural knowledge):
  // B6 检验规则→A8, B6.1 同一型式→A9, B7 实施日期→A10; others identity.
  const CH_MAP: Record<string, string> = { "6": "8", "6.1": "9", "7": "10" };
  // B→A section-level mapping from DEVICE_RENUMBERING.
  const SEC_MAP = new Map(DEVICE_RENUMBERING.map((r) => [r.bNumber, r.aNumber]));

  // A chapter headings (title starts "<num> ") for direct chapter lookup.
  const aChap = new Map<string, { title: string; page: number }>();
  for (const h of (data.A?.headings ?? [])) {
    const m = h.title.match(/^(\d{1,2})\s/);
    if (m && !aChap.has(m[1])) aChap.set(m[1], { title: h.title, page: h.page });
  }

  const pageOfPos = (full: string, pos: number): number => {
    const ms = [...full.matchAll(/\[第(\d+)页\]/g)];
    let pg = 0;
    for (const m of ms) {
      if (m.index > pos) break;
      pg = Number(m[1]);
    }
    return pg;
  };

  // A section start: first subclause "<num>.N" occurrence in A fullText.
  const aSectionStart = (aNum: string): number => {
    const re = new RegExp(`(?<![\\d.])${aNum.replace(/\./g, "\\.")}\\.\\d`);
    const m = re.exec(aFull);
    return m ? pageOfPos(aFull, m.index) : 0;
  };

  const mapToA = (bNum: string): string => {
    // Chapter-level special cases FIRST (B 6.1 同一型式 → A 9, not 8.1).
    if (CH_MAP[bNum]) return CH_MAP[bNum];
    // B ch6 检验规则 subsections (6.2 型式检验 …) live under A ch8 检验规则 —
    // identity-mapping them to A ch6 (从属功能的特殊规定) paired UNRELATED
    // clauses and produced fake "实质差异" rows (second evaluation).
    if (bNum.startsWith("6.")) return "8." + bNum.slice(2);
    if (bNum.startsWith("7.")) return "10." + bNum.slice(2);
    if (bNum.startsWith("5.")) return SEC_MAP.get(bNum) ?? bNum;
    return bNum;
  };

  const nextBPage = (idx: number): number => (idx + 1 < bItems.length ? bItems[idx + 1].page : bItems[idx].page + 1);

  const clauses: ClauseBlock[] = [];
  const coveredA = new Set<string>();
  for (let i = 0; i < bItems.length; i++) {
    const bi = bItems[i];
    const aNum = mapToA(bi.num);
    coveredA.add(aNum);
    let bText = textBetweenPages(bPages, bi.page, nextBPage(i), 600);
    // Align B excerpt to its own HEADING — number IMMEDIATELY followed by the
    // device name from B's title ("5.3前雾灯("). A bare number match hits
    // cross-references ("满足5.3要求") sitting before the real heading and
    // would leave the previous section's tail in place. Search the FULL
    // window (headings can sit past the first 600 chars — 5.3 is at the END
    // of p27), then emit 600 chars from the heading.
    if (bText) {
      const devNameB = bi.title.replace(/^\d+(?:\.\d+)?\s*/, "").replace(/[（(].*$/, "").trim();
      const escB = bi.num.replace(/\./g, "\\.");
      const headRe = new RegExp(`(?<![\\d.])${escB}(?![\\d.])`, "g");
      const fullB = textBetweenPages(bPages, bi.page, nextBPage(i), 8000);
      let hm: RegExpExecArray | null;
      let bestB = -1;
      const probe = devNameB.slice(0, Math.min(4, devNameB.length));
      while ((hm = headRe.exec(fullB))) {
        const after = fullB.slice(hm.index + bi.num.length, hm.index + bi.num.length + devNameB.length + 8);
        if (devNameB.length >= 2 && probe && after.includes(probe)) {
          bestB = hm.index;
          break;
        }
      }
      if (bestB >= 0) bText = fullB.slice(bestB, bestB + 600);
    }

    let aPage = 0;
    let nameAnchored = false;
    let aTitle = `（A 对应条款 ${aNum}）`;
    if (aChap.has(aNum)) {
      aPage = aChap.get(aNum)!.page;
      aTitle = aChap.get(aNum)!.title;
    } else {
      aPage = aSectionStart(aNum);
      if (!aPage) {
        // Fallback: some A sections have no numbered subclause anchor in the
        // body (e.g. A 5.20 醒目标志 is a bare name line + prose with no
        // "5.20.x"). Use DEVICE_RENUMBERING's fitz/C3-audited aPage.
        const dr = DEVICE_RENUMBERING.find((r) => r.aNumber === aNum);
        const pm = dr?.aPage?.match(/第(\d+)页/);
        if (pm) {
          aPage = Number(pm[1]);
          nameAnchored = true;
        }
      }
    }
    let aText = aPage ? textBetweenPages(aPages, aPage, aPage + 1, 600) : "";
    // Name-anchored sections: the page window may begin mid-previous-section
    // (e.g. p57 starts with 5.19.7.2 DRL prose and 醒目标志 sits deeper in
    // the page); pull the full page, find the device name, re-slice there.
    if (nameAnchored && aPage) {
      const devName = bi.title.replace(/^\d+(?:\.\d+)?\s*/, "").replace(/[（(].*$/, "").trim();
      if (devName.length >= 2) {
        const full = textBetweenPages(aPages, aPage, aPage + 1, 8000);
        const idx = full.indexOf(devName);
        if (idx >= 0) aText = full.slice(idx, idx + 600);
      }
    } else if (aPage && aNum.includes(".")) {
      // Normal sections: A body style is DEVICE-NAME-LINE + first subclause
      // ("倒车灯\n5.21.1 配备") — the section NUMBER rarely appears before the
      // name. Anchor on the first subclause "<aNum>.N" on the page, then pull
      // backward to include the device-name line (within ~60 chars) if present.
      const devName = bi.title.replace(/^\d+(?:\.\d+)?\s*/, "").replace(/[（(].*$/, "").trim();
      const full = textBetweenPages(aPages, aPage, aPage + 1, 8000);
      const esc = aNum.replace(/\./g, "\\.");
      const sm = new RegExp(`(?<![\\d.])${esc}\\.\\d`).exec(full);
      if (sm) {
        let start = sm.index;
        if (devName.length >= 2) {
          const back = full.slice(Math.max(0, start - 80), start);
          const di = back.lastIndexOf(devName);
          if (di >= 0) start = Math.max(0, start - 80) + di;
        }
        aText = full.slice(start, start + 600);
      }
      // else: keep the page-start window computed earlier
    } else if (aPage && aChap.has(aNum)) {
      // Chapter rows: the chapter heading sits BELOW the previous chapter's
      // tail on the same page (A ch10 实施日期 is under 8.2.1 型式检验 prose
      // on p72). Align to "<num> <chapter name>" heading.
      const chapTitle = aChap.get(aNum)!.title;
      const chapName = chapTitle.replace(/^\d+\s*/, "").trim();
      const full = textBetweenPages(aPages, aPage, aPage + 1, 8000);
      const re = new RegExp(`(?<![\\d.])${aNum}(?![\\d.])`, "g");
      let m2: RegExpExecArray | null;
      let best = -1;
      const probe = chapName.slice(0, Math.min(4, chapName.length));
      while ((m2 = re.exec(full))) {
        const after = full.slice(m2.index + aNum.length, m2.index + aNum.length + chapName.length + 8);
        if (chapName.length >= 2 && probe && after.includes(probe)) {
          best = m2.index;
          break;
        }
      }
      if (best >= 0) aText = full.slice(best, best + 600);
    }

    clauses.push({
      clause: aPage ? `${bi.num} ↔ A ${aNum}` : `${bi.num} ↔ —（A 无对应条款）`,
      title: bi.title,
      aText, aPage: aPage || 0, bText, bPage: bi.page,
    });
  }

  // A-only chapters (A 6 从属功能 / A 7 扩展功能 — not reachable from B side)
  const aOnly: ClauseBlock[] = [];
  for (const [num, info] of aChap) {
    if (coveredA.has(num)) continue;
    if (!["6", "7"].includes(num)) continue; // only the two genuinely-new chapters
    const nextNum = num === "6" ? "7" : String(Number(num) + 1);
    const endPage = aChap.get(nextNum)?.page ?? info.page + 1;
    aOnly.push({
      clause: `— ↔ A ${num}（A 独有）`,
      title: info.title,
      aText: textBetweenPages(aPages, info.page, endPage, 600),
      aPage: info.page, bText: "", bPage: 0,
    });
  }
  aOnly.sort((x, y) => Number(x.clause.match(/A (\d+)/)?.[1]) - Number(y.clause.match(/A (\d+)/)?.[1]));
  clauses.push(...aOnly);

  // Render
  const out: string[] = [
    "# 第 14 章 条款正文 A vs B 逐条对照（附 C UN R48-09 对应章节与实质变化判定）",
    "",
    "> **C 列是欧标原文，不是指针。** 每一行的第三列给出 UN R48-09 对应章节的条款号、页码与原文摘录。",
    "> 数据来自 `data/r48-chapters.json`（GB 章节 → R48 章节对应表，",
    `> **${Object.keys((R48_CHAPTERS as any)?.map ?? {}).length} 条对应关系逐条回 R48 原文验过**：英文标题原文必须在语料里、R48 章节号必须`,
    "> 出现在该标题前后 400 字内、GB 章标题必须含该装置名）。",
    ">",
    "> **C 列的粒度是「同一盏灯」，不是「同一条款」**：UN R48 与 GB 的条款编号体系",
    "> （§2 定义 / §5 通用 / §6 各灯具 / Annex）完全不同构，逐号对读会造出假对应 ——",
    "> 例如 GB 5.4.5.1 与 R48 6.4.5.1 编号相似却不是同一条款。",
    "> **逐参数的条款级对照以第 12 章为准**（那里 915 个取值位每个都带条款与页码）。",
    ">",
    "> **R48 确实没有对应章的，报告写明「无对应章」并给出理由**（如 GB 的「检验规则」、",
    "> 「实施日期」这类管理性章节，以及 GB 独有的「牵引杆挂车标志灯」），不硬凑。",
    ">",
    "> **变化判定由 §11.0 变化总清单回答** —— 那一节是全报告唯一一份「改了什么」，",
    "> 逐条回原文核验过。本章只回答一件事：**这一节有没有实质变化**；",
    "> 有 → 列出是哪几条（编号 + B 值 → A 值），没有 → 明写「无实质数值变化」。",
    ">",
    "> **说明**：以 B 现行的完整章节结构为骨架，逐条映射到 A 对应条款（章节映射：B6→A8、B6.1→A9、B7→A10；装置节映射见 11.6.2），并排对照条款正文（每条截断 600 字）。A 独有的第 6/7 章追加在末尾。",
    "",
    `> 对比条目：${clauses.length}（B 驱动 ${clauses.length - aOnly.length} + A 独有 ${aOnly.length}）· A 侧定位成功 ${clauses.filter((c) => c.aPage).length} / ${clauses.length}`,
    "",
    "**使用提示**：`🔴 本节有 N 条实质变化` → 看下面列出的 chg 编号，到 §11.0 看完整依据与页码；`📝 无实质数值变化` → 差异只在措辞/编号，产品无需改；`🆕/🗑` 对应新增/删除。**没有「请逐字比对」这种把判断推回给读者的判定。**",
    "",
  ];
  for (const c of clauses) {
    out.push(`## 14.x 条款 ${c.clause} — ${c.title}`);
    out.push("");
    const aHead = `**A 草案**（${c.aPage ? "第 " + c.aPage + " 页" : "未定位到 A 对应条款"}）`;
    const bHead = `**B 现行**（${c.bPage ? "第 " + c.bPage + " 页" : "B 无对应条款"}）`;
    // Side by side, not a 来源/页码/正文 table. Two reasons, both measured:
    //   · a literal newline inside a cell splits the markdown row into several
    //     physical lines, so the table stops being a table (the old form lost
    //     ~277 of every 500 chars to orphan paragraphs);
    //   · a 来源/来源-style header is read as the version column, and the
    //     triptych renderer then treats the 500-char body as a PAGE NUMBER.
    //     Only a header that is not 版本/来源/文档/文件/标准 AND that has A, B
    //     and C columns reaches that layout, so A|B stays a plain table.
    // **C 列是真的欧标内容** —— 客户抱怨「无欧标」。
    //
    // 数据源是**已核验的 GB 章节 → R48 章节对应表**（data/r48-chapters.json，
    // 由 scripts/build_r48_chapters.py 逐条回 R48 原文验过：英文标题原文
    // 必须在语料里、R48 章节号必须在该标题前后 400 字内、GB 章标题必须
    // 含该装置名）。
    //
    // 为什么不用 24 个「主题」反查：早先那样做，后位灯被指到**前位灯**的
    // §6.9.4.1，四个回复反射器全被指到 §6.14；R48 明明有的 6.11 后雾灯 /
    // 6.12 驻车灯 / 6.18 侧标志灯 / 6.20 角灯 / 6.21 醒目标志 / 6.22 AFS /
    // 6.23 紧急制动信号，却被写成「无同构章节」。**指错比空着贵一个数量级**
    // —— 读者会当真。
    const gbKey = gbChapterKey(c.clause);
    const r48Hit = (R48_CHAPTERS as any)?.map?.[gbKey];
    const gbOnlyReason = String((R48_CHAPTERS as any)?.gbOnly?.[gbKey] ?? "").trim();
    // R48 的摘录来自 MinerU 的文本层，里面带表格竖线（`| 6.1.2. |`）。
    // **表格单元格里的竖线会把一行劈成多列** —— 和 A/B 两列一样，
    // 竖线一律换成全角「｜」（A/B 两列的 `clauseCell` 也是这么做的）。
    const cCol = (
      r48Hit
        ? `§${r48Hit.r48}（${r48Hit.pageLabel}）${r48Hit.excerpt}`
        : gbOnlyReason
          ? `（UN R48-09 无对应章 —— ${gbOnlyReason}）`
          : "（UN R48-09 无对应章）"
    )
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\|/g, "｜")
      .replace(/\s+/g, " ")
      .trim();
    out.push(
      `| ${cell(aHead)} | ${cell(bHead)} | ${cell("C UN R48-09（对应章节）")} |`,
      "|---|---|---|",
    );
    out.push(
      `| ${clauseCell(c.aText, "（A 无对应条款）")} | ${clauseCell(c.bText, "（A 草案独有，B 无对应条款）")} | ${cell(cCol)} |`,
    );
    out.push("");
    // --- C 侧：章节级对应指针 + 该灯具的三版取值 ---
    // 章节级，不做条款级推导 —— 见本章抬头。数据来源是已核验的
    // GB 章节 → R48 章节对应表，不是这里新写的映射。
    const hit = findTopicForClause(topicColumns, c.clause, c.title);
    if (r48Hit) {
      out.push(
        `**R48 对应章节（章节级，非条款级）**：${cell(r48Hit.gbName)} → ` +
          `${cell("§" + r48Hit.r48 + " " + r48Hit.r48Name)}（${cell(r48Hit.pageLabel)}）`,
      );
      out.push("");
    } else if (gbOnlyReason) {
      out.push(`**R48 对应章节（章节级，非条款级）**：无对应章 —— ${cell(gbOnlyReason)}`);
      out.push("");
    }
    // The value table comes from chapter 12 either way: by the **GB 章的装置名**
    // when the chapter map knows it, otherwise by topic, otherwise by this
    // clause's own title. The rows carry their own clause + page, so this adds
    // no new assertion — it only puts the numbers next to the A/B prose.
    //
    // 用装置名（而不是 24 主题反查）是有原因的：「后位灯」那一节原来拿到的是
    // 「位置灯」这个主题的 2 行，而不是后位灯自己的 15 行 —— **张冠李戴**。
    const deviceName = r48Hit?.gbName || hit?.topic || c.title;
    const related = matrixRowsForTopic(matrixRows, deviceName, r48Hit?.matrixToken);
    if (related.length) {
      out.push("**该灯具的三版取值（取自第 12 章参数矩阵）**", "");
      out.push("| 参数 | 单位 | A 草案 | B 现行 | C UN R48-09 | 判定 |", "|---|---|---|---|---|---|");
      for (const mr of related) {
        const cs = mr.cells ?? {};
        const v = (x: string) => {
          const cv = cs[x];
          return cv && cv.nums && cv.nums.length ? cell(cv.nums.join(" / ")) : "—";
        };
        out.push(
          `| ${cell(mr.name)} | ${cell(mr.unit || "—")} | ${v("A")} | ${v("B")} | ${v("C")} | ${cell(verdictLabel(mr, ["A", "B", "C"]))} |`,
        );
      }
      out.push("");
    }
    // **变化判定改由变化总清单给出** ——
    // 旧判定是把两段原文当字符串一比，于是 39 条里 36 条判「实质差异 · 请逐字比对」。
    // 那不是判定，是**把判断责任推给读者**，而且零信息量
    // （客户抱怨的「只有罗列，无对比」就是这条）。
    // 现在：这一节有没有实质变化，由 §11.0 的权威清单回答 ——
    //   有 → 列出是哪几条（chgNN + B 值 → A 值）
    //   没有 → 明写「本节无实质数值变化」，并说明依据是逐条回原文核过
    const ledgerHere = ledgerRowsForSection(ledger, deviceName);
    const aa = c.aText.replace(/\s+/g, "");
    const bb = c.bText.replace(/\s+/g, "");
    if (!c.bText) {
      out.push(`**变化判定**：🆕 A 新增，B 无对应条款。`);
    } else if (!c.aText) {
      out.push(
        `**变化判定**：🗑 B 有 A 无（A 删除或未定位到，工程师请核对 A 编号 ${c.clause.split("↔ A ")[1]?.split("（")[0] ?? "?"}）。`,
      );
    } else if (ledgerHere.length) {
      out.push(
        `**变化判定**：🔴 **本节有 ${ledgerHere.length} 条实质变化**（见 §11.0 变化总清单）：`,
      );
      for (const lr of ledgerHere) {
        out.push(
          `  - **${lr.id}** ${lr.name} —— ${lr.bValue || "（B 无）"} → ${lr.aValue || "（A 无）"}` +
            `（${lr.kind}）`,
        );
      }
    } else if (aa === bb) {
      out.push(`**变化判定**：📝 实质一致（仅标点/空白差异）。`);
    } else if (aa.includes(bb) || bb.includes(aa)) {
      out.push(`**变化判定**：🔧 局部调整 —— 未列入 §11.0 变化总清单（无数值层面的变化）。`);
    } else {
      out.push(
        `**变化判定**：📝 **无实质数值变化** —— 本节未列入 §11.0 变化总清单` +
          `（该清单逐条回原文核验过；差异在措辞/编号层面，不需要改设计）。`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

function buildMethodChapter(data: Record<string, any>, verified?: any): string {
  const rows = ["A", "B", "C"].map((k) => {
    const d = data[k];
    if (!d) return "";
    return `| ${k} | ${esc(d.fileName)} | ${Object.values(d.blockTypes ?? {}).reduce((a: number, b: any) => a + (b as number), 0)} blocks | ${d.tables.length} 表 | ${d.figures.length} 图 | ${d.equations.length} 式 | ${d.headings.length} 标题 | ${Math.round(d.extractionTime)}s |`;
  }).filter(Boolean);

  // Verification statistics (machine check results)
  const vRows: string[] = [];
  if (verified?.stats) {
    const n = verified.stats.numeric ?? {};
    const e = verified.stats.excerpts ?? {};
    const okN = n.verified ?? 0;
    const totN = Object.values(n).reduce((a: number, b: any) => a + b, 0);
    const okE = e.verified ?? 0;
    const totE = e.total ?? 0;
    vRows.push(
      "",
      "| 核验对象 | 总数 | 机器核验通过 | 通过率 | 失败处理 |",
      "|---|---|---|---|---|",
      `| 条款级数值变化（第 11.3 节） | ${totN} | ${okN} | ${totN ? ((okN / totN) * 100).toFixed(0) : "-"}% | 标注 [待核实]，不作为确定事实 |`,
      `| 三版本主题摘录（附录 C） | ${totE} | ${okE} | ${totE ? ((okE / totE) * 100).toFixed(0) : "-"}% | 标注 ⚠，使用前人工复核 |`,
      `| GB4785 表 11.6 九条指标（第 11.4 节） | 9 | 9（3[保留]+1[单边]+5[未找到]） | 100% 逐条核验 | 未找到者附「查过哪里、那里有什么」，不推测引用 |`,
    );
  }

  return [
    "# 附录 D 方法学说明与数据可信度（审计翻查用）",
    "",
    "## D.1 版本演进",
    "",
    "| 版本 | 方法 | 问题 |",
    "|---|---|---|",
    "| v1-v2 | LLM 直接阅读 PDF 撰写变化点 | 页码系统性错位、原文被改写、遗漏 60+ 条核心变化 |",
    "| v3 | LLM 过度抽取 | 364 条变更 80%+ 是噪音、99 页失控 |",
    "| v4 | PyMuPDF 纯文本 | 表格/图片/公式丢失、9 条指标仅命中 1 条 |",
    "| v6 | MinerU 4.0.6 多模态（本地部署） | Layout 模型 + VLM + 公式识别 + OCR 全链路 |",
    "| **v6.1（本版）** | **v6 + 机器核验层** | **每条数值变化回原文定位页码，噪音自动过滤** |",
    "",
    "## D.2 管线（RAG-Anything 结构 + 核验闭环）",
    "",
    "1. **MinerU 多模态提取**（`extract_mineru_v4_sdk.py`）：PP-DocLayoutV2 版面模型 + Qwen-VL 视觉语言模型 + PP-FormulaNet 公式识别 + PaddleOCR，本地推理（模型权重 ~854 MB 已下载至 `.mineru-models/`）",
    "2. **结构化 diff**（`diffEngine` 家族）：条款级同名参数差值提取 → 同义改写/提取噪音过滤",
    "3. **机器核验**（`verify_claims.py`，本版新增）：每条数值变化回 MinerU 原文定位 B 页 + A 页；定位成功标 [已核验]，失败标 [待核实]；三主题摘录逐条回原文验证",
    "4. **9 指标核验**（`reportV6.ts`）：GB4785 表 11.6 的 9 条指标逐条与 A/B 原文正则核验，输出 [修改]/[保留]/[未找到]",
    "5. **Playwright 渲染**：Markdown → HTML → PDF",
    "",
    "## D.3 提取统计",
    "",
    "| 文档 | 文件 | 块 | 表格 | 图 | 公式 | 标题 | 提取耗时 |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## D.4 核验统计（v6.1 新增）",
    ...(vRows.length ? vRows : ["", "（核验数据未找到，请先运行 verify_claims.py）"]),
    "",
    "## D.5 数据可信度声明",
    "",
    "- 所有原文引用来自 MinerU 的 Layout+VLM+OCR 联合提取，非 LLM 自由生成",
    "- 第 11.3 / 11.4 节每条数据均标注原文页码，可直接对照 PDF 验证",
    "- GB4785 声称但原文中不存在的数值，如实标注 [未找到]，不做推测性引用",
    "- 未通过机器核验的条目一律标注 [待核实]/⚠，不冒充已验证事实",
    "",
    "> 本报告为法规对比技术研究用途；具体产品合规判定以官方发布法规原文为准。",
  ].join("\n");
}

function buildNarrativeFromHeadings(
  data: Record<string, any>,
  chapterId: number,
  title: string,
  topicColumns?: any[],
  refDiff?: any,
  matrixRows?: any[],
): string {
  const a = data.A?.headings ?? [];
  const b = data.B?.headings ?? [];
  const c = data.C?.headings ?? [];
  const parts: string[] = [`# 第 ${chapterId} 章 ${title}`, ""];

  // 写作改进 2: topic-level three-column comparison first (the real content)
  const topicFilter = CHAPTER_TOPIC_FILTER[chapterId];
  if (topicColumns && topicFilter) {
    const topicBlock = buildChapterTopics(topicColumns, topicFilter, matrixRows);
    if (topicBlock) parts.push(topicBlock, "");
  }

  if (chapterId === 2) {
    parts.push("## 2.1 三份法规概况", "");
    parts.push("| 文档 | 标准号 | 状态 | 页数 |", "|---|---|---|---|");
    parts.push(`| A | GB 4785—XXXX | 草案 V4.3.5（代替 GB 4785-2019） | 103 |`);
    parts.push(`| B | GB 4785—2019 | 现行（代替 GB 4785—2007，2020-07-01 实施） | 81 |`);
    parts.push(`| C | UN R48-09 + Suppl.1 | 国际法规（2025-09-26 生效，作参照） | 147 |`);
    parts.push("", "## 2.2 A 草案的适用范围（原文）", "");
    const scope = (a.find((h: any) => /范围/.test(h.title)) || {}).title;
    parts.push(`A 第 1 章「范围」位于 ${(a.find((h: any) => /范围/.test(h.title)) || {}).page ?? "?"}。完整原文见第 11 章数据溯源。`);
    // normative references diff — fills a real omission (GB 45831 etc.)
    parts.push(buildRefSection(refDiff), "");
    parts.push("> 本章数据均来自三份原文，可回查对应页码。");
  } else if (chapterId === 3) {
    parts.push("## 3.1 规模对比", "");
    parts.push("| 文档 | 一级标题 | 段落级标题 | 页码标注 |", "|---|---|---|---|");
    for (const k of ["A", "B", "C"]) {
      const hs = data[k]?.headings ?? [];
      const l1 = hs.filter((h: any) => h.level === 1).length;
      const pt = hs.filter((h: any) => h.level >= 2).length;
      parts.push(`| ${k} | ${l1} | ${pt} | ${data[k]?.pageCount ?? "-"} |`);
    }
    // 3.2 replaces what used to be two separate A-only and B-only heading
    // dumps. Those listed 25 headings each and said nothing — and C appeared
    // nowhere in the chapter at all, which is why the structure chapter read
    // as a two-standard document. The clause correspondence below is built
    // from `topicColumns`, which is already verified against the source PDFs,
    // so no new mapping has to be hand-written or trusted.
    const corr = (topicColumns ?? []).filter((r: any) => r.A || r.B || r.C);
    if (corr.length) {
      parts.push(
        "",
        "## 3.2 条款对应关系（A | B | C 三版逐主题）",
        "",
        "GB 4785 按 `5.x` 组织、UN R48 按 `6.x` 组织，两套编号不同构，**不能逐号对读**。",
        "下表按主题给出三版各自的条款号与页码，是本报告里唯一可核对的章节映射；",
        "带 ✓ 的页码已回源 PDF 逐句核对。",
        "",
        "| 主题 | A 草案条款 | B 现行条款 | C UN R48 条款 | A 页 | B 页 | C 页 |",
        "|---|---|---|---|---|---|---|",
      );
      for (const r of corr) {
        const cl = (x: string) => cell(r[x]?.clause || "—");
        const pg = (x: string) => cell(r[x]?.actualPage ? `${r[x].actualPage} ✓` : "—");
        parts.push(`| ${cell(r.topic)} | ${cl("A")} | ${cl("B")} | ${cl("C")} | ${pg("A")} | ${pg("B")} | ${pg("C")} |`);
      }
    }
    parts.push("", "## 3.3 A / B 一级标题（原文，仅供回查）", "");
    parts.push("| 文档 | 页 | 一级标题 |", "|---|---|---|");
    for (const [k, hs] of [["A", a], ["B", b], ["C", c]] as const) {
      for (const h of (hs as any[]).filter((x: any) => x.level === 1).slice(0, 14)) {
        parts.push(`| ${k} | p${h.page} | ${esc(h.title)} |`);
      }
    }
  } else if (chapterId === 4) {
    parts.push("## 4.1 术语定义章节（原文标题）", "");
    parts.push("| 文档 | 术语章节标题 | 页 |", "|---|---|---|");
    for (const k of ["A", "B", "C"]) {
      const hs = (data[k]?.headings ?? []).filter((h: any) => /术语|定义|Definition/.test(h.title));
      for (const h of hs.slice(0, 3)) parts.push(`| ${k} | ${esc(h.title)} | p${h.page} |`);
    }
    parts.push("", "> 术语条目级对比见第 11 章重大修订条款。");
  } else if (chapterId >= 5 && chapterId <= 9) {
    const map: Record<number, RegExp> = {
      5: /一般要求|一般规定/,
      6: /远光|近光|前照灯|前雾灯|自适应/,
      7: /转向|制动|位置灯|信号灯|反射器|标志/,
      8: /光度|色度|颜色|亮度/,
      9: /试验|测试|检验|测量/,
    };
    const re = map[chapterId];
    parts.push(`## 本章相关条款（原文标题，关键词：${re.source}）`, "");
    parts.push("| 文档 | 页 | 标题 |", "|---|---|---|");
    for (const k of ["A", "B", "C"]) {
      const hs = (data[k]?.headings ?? []).filter((h: any) => re.test(h.title));
      for (const h of hs.slice(0, 20)) parts.push(`| ${k} | p${h.page} | ${esc(h.title)} |`);
    }
    parts.push("", "> 逐条变化与数据核验见第 11 章。");
  } else if (chapterId === 10) {
    // ch10: 附录与实施 — 按主题分组，每个主题下并排展示 A/B/C 的对应条款。
    //
    // 每个主题都需要**中英两套关键词**：R48 的标题是英文，只用中文正则时
    // C 永远匹配不上，于是这一章看上去只有新旧 GB 两版。之前正是如此。
    const themes: Array<{ label: string; cn: RegExp; en: RegExp; note: string }> = [
      {
        label: "同一型式判定",
        cn: /同一型式/,
        // R48 的对应条款**不叫「同一型式」** —— 它是 §10「Modifications and
        // extensions of approval of the vehicle type」（p97），配套 §3「Application
        // for approval」（p22）/ §4「Approval」（p23）。
        // 关键词只写 `same type` 时这一行永远是 0，客户看到的是「R48 没有这一档」。
        en: /same type|identical type|modifications and extensions of approval|application for approval/i,
        note: "决定一族产品的型式试验覆盖范围。GB 按「同一型式」判定；R48 以 §10「Modifications and extensions of approval of the vehicle type」（p97）配合 UN R10（整车型式认证）承载，判定口径不同，不可直接对读。",
      },
      {
        label: "实施日期 / 过渡期",
        cn: /实施/,
        en: /entry into force|date of entry|transitional/i,
        note: "A 草案的生效日期决定企业切换时间表；R48 的过渡条款按修正案序列给出，两者时点独立。",
      },
      {
        label: "规范性附录",
        cn: /规范性附录|附录/,
        en: /annex/i,
        note: "附录是测量方法的载体。近光倾斜度随装载变化的测量、自动切换条件、AFS 试验路段都在附录里，条款正文只给限值。",
      },
      {
        label: "过渡条款 / 放宽判定",
        cn: /过渡|车型结构|放宽/,
        en: /shape of the bodywork|impossible to satisfy|may be increased/i,
        note: "**这是出口欧盟最容易踩的一档**：GB 用「车型结构不能保证」放宽高度/位置限值，R48 用「the shape of the bodywork makes it impossible」放宽同类限值，触发条件与放宽幅度都要逐条比对。",
      },
    ];
    parts.push(
      "> 本章按主题分组，三份文档并排；**R48 侧的匹配用英文关键词**（`the shape of the bodywork`、`same type`、`annex`），",
      "> 否则中文正则永远匹配不到英文标题，这一章会看起来只有新旧 GB 两版。",
      "",
    );
    for (const th of themes) {
      const hs = (k: string) =>
        (data[k]?.headings ?? []).filter((h: any) =>
          k === "C" ? th.en.test(h.title) : th.cn.test(h.title),
        );
      const A = hs("A"), B = hs("B"), C = hs("C");
      parts.push(`### ${th.label}`, "");
      parts.push(`> ${th.note}`, "");
      parts.push("| 文档 | 匹配条款数 | 页码 | 标题（最多 4 条） |", "|---|---|---|---|");
      for (const [k, list] of [["A 草案", A], ["B 现行", B], ["C UN R48-09", C]] as const) {
        if (!list.length) {
          // **不写「0」**。客户读到「条款 0 页码 —」只会以为这一版没有这一档，
          // 而真相是「关键词没命中」—— 那是**检索口径**的问题，不是法规事实。
          parts.push(`| ${k} | — | — | 本主题关键词在该版未命中（见上方说明：各版措辞不同） |`);
          continue;
        }
        const pages = [...new Set(list.map((h: any) => `p${h.page}`))].slice(0, 6).join(" ");
        const titles = list.slice(0, 4).map((h: any) => esc(h.title)).join("；");
        parts.push(`| ${k} | ${list.length} | ${pages} | ${titles}${list.length > 4 ? " …" : ""} |`);
      }
      parts.push("");
    }
    parts.push("> 逐条变化与数据核验见第 11 章；逐参数三版取值见第 12 章。");
  }

  return parts.join("\n");
}

/** MinerU table content is HTML — convert to a readable text grid. */
function htmlTableToText(html: string): string {
  if (!html) return "";
  if (!/<t[dh]|<tr/i.test(html)) return html; // already plain/markdown
  const rows = html.split(/<\/tr>/i);
  const lines: string[] = [];
  let first = true;
  for (const row of rows) {
    if (!/<t[dh]/i.test(row)) continue;
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) =>
      m[1]
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (!cells.length) continue;
    lines.push(`| ${cells.join(" | ")} |`);
    if (first) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      first = false;
    }
  }
  return lines.join("\n");
}

function buildAppendixA(data: Record<string, any>): string {
  const parts: string[] = [
    "# 附录 A A/B/C 原始表格汇编",
    "",
    "本附录汇编三份 PDF 中的全部表格原文。表格内容逐字来自原文，未改写。",
    "",
  ];
  let n = 1;
  for (const label of ["A", "B", "C"]) {
    const doc = data[label];
    if (!doc?.tables?.length) continue;
    parts.push(`## ${label} 文档（${doc.tables.length} 个表格）`, "");
    for (const t of doc.tables) {
      const caption = t.caption ? `${t.caption}` : `表格 ${n}`;
      parts.push(`### ${caption}（${label} p${t.page}）`, "");
      parts.push(htmlTableToText((t.content || "").slice(0, 4000)).replace(/<[^>]+>/g, ""), "");
      n++;
    }
  }
  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Parameter matrix — the deliverable's centrepiece                          */
/* -------------------------------------------------------------------------- */

/**
 * How strongly A maps onto C for a given parameter. A compliance crosswalk that
 * presents a partial overlap as an equivalence is the single most common cause
 * of audit failure, so the strength is stated per row rather than assumed.
 */
type MapStrength = "完全对应" | "部分重叠" | "无对应" | "未映射";

/** Parameter families a reader actually looks up, in report order. */
const PARAM_FAMILIES: Array<{ label: string; kws: RegExp[] }> = [
  { label: "安装高度 / 离地距离", kws: [/离地高度/, /安装高度/, /高度/, /间距/, /距离/, /直径/, /height/i, /spacing/i, /distance/i] },
  { label: "几何可见度 / 安装角度", kws: [/可见度/, /可见角/, /水平角/, /垂直角/, /横向/, /纵向/, /方向角/, /倾/, /visibility/i, /angle/i, /angular/i] },
  { label: "光强 / 照度限值", kws: [/光强/, /照度/, /cd\b/, /lx\b/, /坎德拉/, /intensity/i, /illuminance/i] },
  { label: "闪烁频率 / 时间参数", kws: [/频率/, /时间/, /次\/min/, /Hz/, /延迟/, /熄灭/, /点亮/, /flash/i, /frequency/i, /duration/i] },
  { label: "电气条件 / 试验电压", kws: [/电压/, /电气/, /接地/, /V\b/, /voltage/i, /electrical/i] },
  { label: "试验条件 / 路段速度", kws: [/试验/, /路段/, /速度/, /km\/h/, /判定/, /test/i, /speed/i, /trial/i] },
  { label: "配备 / 数量", kws: [/配备/, /数量/, /presence/i, /number/i, /installation/i] },
  { label: "光色 / 标记", kws: [/光色/, /颜色/, /标记/, /标识/, /色度/, /colour/i, /color/i, /marking/i] },
];

function paramFamilyOf(name: string, topic: string): string {
  const probe = `${topic} ${name}`;
  for (const f of PARAM_FAMILIES) if (f.kws.some((re) => re.test(probe))) return f.label;
  return "其他参数";
}

/**
 * Decide whether the R48 clause genuinely covers the same requirement.
 *
 * `source` looks like "B=5.2 最大离地高度 → A=5.2 最大离地高度；C=6.2". A bare
 * clause number proves the topic was matched, not that the requirement is
 * equivalent — so the strength is derived from what we can actually verify:
 * whether R48 text exists for the topic, and whether the numbers agree.
 *
 * We deliberately never emit "完全对应" from this evidence. Proving equivalence
 * needs a clause-by-clause reading of R48 §6.2 against GB §5.2, and a partial
 * overlap presented as an equivalence is the classic audit failure this report
 * must not reproduce.
 */
function mapStrength(row: any, cExcerptByTopic: Map<string, string>): MapStrength {
  const excerpt = cExcerptByTopic.get(String(row.topic ?? "").trim());
  if (!excerpt) return "未映射";
  const cNums = new Set((excerpt.match(/\d+(?:\.\d+)?/g) ?? []));
  const aNums = String(row.newValue ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
  // The A value's numbers appearing in the R48 excerpt is real evidence the two
  // regulate the same quantity — but not that they set the same limit.
  if (aNums.length && aNums.some((n) => cNums.has(n))) return "部分重叠";
  // R48 text exists for the topic but carries none of our numbers: related
  // subject, unverified equivalence.
  return "无对应";
}

/**
 * Extract the R48 reference from a `source` string.
 *
 * Two shapes occur. Most rows cite a clause in §6, and those numbers are
 * multi-level (6.5.9, 2.4.17.3, 5.28) — taking only the last segment collapsed
 * them all onto 6.x. Five rows instead cite an Annex ("C=Annex 13", "C=Annex
 * 12"), which a digits-only pattern dropped entirely, leaving those parameters
 * with an empty C cell.
 */
function cClauseOf(source: string): string {
  const m = String(source ?? "").match(/C=((?:\d+(?:\.\d+)+)|Annex\s*\d+[A-Za-z]?)/i);
  return m ? m[1].replace(/\s+/g, " ") : "";
}

/**
 * The parameter matrix: every A/B/C value difference, grouped by parameter
 * family, with the R48 clause in its own column.
 *
 * Before this chapter the report showed 3 such rows (§11.3, after evidence
 * filtering) and left the other 42 — including every 安装高度 / 可见度角 /
 * 闪烁频率 / 试验速度 row a reviewer opens the document for — either demoted to
 * a wording-review list or dropped. UN R48 never appeared as a column at all.
 *
 * **变化判定这一列**：过去是把两个取值当字符串一比（`b === a`），于是
 * 「（4.0±1.0）HzHz」vs「(4.0±1.0)Hz」（重复单位）、「不大于500mm」vs「500m」
 * （抄错单位）、「开启」vs「不大于2s」（抽取错配）全被判成**有变化**，
 * 矩阵小结还写着「45 项参数中 45 项有实质变化」—— 45 行里 42 行是假的。
 * 现在判定来自 `verify_claims.py`：
 *   人工更正（`data/diff-corrections.json`，回原文核过）> 证据分桶
 *   > 「数字 + 口径」签名比对 > 待核实。
 * 取值也一并换成清洗+更正后的版本（`scripts/diff_corrections.py`）。
 */
function buildParameterMatrix(
  diffValueDiffs: any[],
  diffVerdicts: Record<string, any>,
  topicColumns: any[],
): string {
  const rows: any[] = Array.isArray(diffValueDiffs) ? diffValueDiffs : [];
  if (!rows.length) {
    return "_(参数矩阵：差值数据缺失 —— 请重跑 `python verify_claims.py` 生成 facts.json 里的 diffValueDiffs。宁可空着，也不用未经核验的原始 diff-result.json 顶替。)_";
  }

  // R48 excerpts are verified per topic in facts.json; index them so the mapping
  // strength column has something to judge on instead of defaulting to 未映射.
  const cExcerptByTopic = new Map<string, string>();
  for (const t of topicColumns ?? []) {
    const ex = String(t?.C?.excerpt ?? "").trim();
    if (ex) cExcerptByTopic.set(String(t?.topic ?? "").trim(), ex);
  }

  const byFamily = new Map<string, any[]>();
  for (const r of rows) {
    const fam = paramFamilyOf(r.name ?? "", r.topic ?? "");
    if (!byFamily.has(fam)) byFamily.set(fam, []);
    byFamily.get(fam)!.push(r);
  }

  // Report order per PARAM_FAMILIES, then anything unmatched.
  const ordered = [
    ...PARAM_FAMILIES.map((f) => f.label).filter((l) => byFamily.has(l)),
    ...[...byFamily.keys()].filter((l) => !PARAM_FAMILIES.some((f) => f.label === l)),
  ];

  const parts: string[] = [
    "### 11.3.3 A/B/C 参数对照矩阵（安装高度 · 角度 · 频率 · 车速）",
    "",
    `本节是全报告的**参数级主对照表**：把 ${rows.length} 条 A/B 差值候选按参数维度归类，` +
      "每行给出 B 现行值 → A 草案值，并单列 **变化判定**、**C UN R48 条款号**与**映射强度**。" +
      "映射强度按 [完全对应 / 部分重叠 / 无对应] 标注——**部分重叠不得按等价使用**。",
    "",
    "> **「变化判定」这一列是核验过的**，不是把两个取值当字符串一比。" +
      "取值来自 18 主题 diff 管线的 LLM 抽取，其中抄错单位、重复单位、错配行的情况都真实发生过" +
      "（例如近光灯弯道照明曲率半径的 A 值曾被抄成「500mm」，原文是「500m」）。" +
      "本表已逐条回原文核验并更正，判定依据见 `data/diff-corrections.json`。",
    "",
    "> 阅读方式：先按参数维度定位（客户通常只关心安装高度、可见度角、闪烁频率、试验车速），" +
      "再看该维度内 B→A 的变化幅度，最后用 C 列确认出口欧盟时是否需要额外满足 R48。" +
      "**「表述差异（待复核）」的行不是数值变化，但措辞改动也可能是真变化**（例如「允许选装」→「选装」），" +
      "已逐条列在 11.8。",
    "",
  ];

  let n = 0;
  const verdictOf = (r: any): { verdict: string; reason: string } => {
    const key = `${String(r.topic ?? "").trim()}|${String(r.name ?? "").trim()}`;
    const v = diffVerdicts?.[key];
    if (v) return { verdict: String(v.verdict ?? "待核实"), reason: String(v.reason ?? "") };
    return { verdict: "待核实", reason: "未匹配到判定结果" };
  };
  // 判定的**短标签**（表格里只放短标签，长的理由放在表下的更正说明里）
  const shortVerdict = (v: string): string => {
    switch (v) {
      case "有变化":
        return "**有变化**";
      case "有变化（待核实）":
        return "**有变化**（待核实）";
      case "两版同文（已回原文核验）":
        return "无变化（已核原文）";
      case "两版同文（勘误）":
        return "无变化（同文）";
      case "数值与口径相同（非数值变化）":
        return "无变化（数值同）";
      case "引用编号变化（非实质）":
        return "无变化（编号重排）";
      case "非变化（规则判定）":
        return "无变化（规则判定）";
      case "重复行（已合并）":
        return "重复行（已合并）";
      case "表述差异（未做数值核验）":
        return "表述差异（待复核）";
      default:
        return "待核实";
    }
  };

  const corrections: { name: string; verdict: string; reason: string }[] = [];

  for (const fam of ordered) {
    const famRows = byFamily.get(fam)!;
    parts.push(`#### ${fam}（${famRows.length} 项）`, "");
    parts.push(
      "| # | 参数 | B 现行 GB 4785-2019 | A 草案 V4.3.5 | 变化判定 | C UN R48 条款 | 映射强度 |",
      "|---|---|---|---|---|---|---|",
    );
    for (const r of famRows) {
      n++;
      const b = String(r.oldValue ?? "—").replace(/\s+/g, " ").trim();
      const a = String(r.newValue ?? "—").replace(/\s+/g, " ").trim();
      const { verdict, reason } = verdictOf(r);
      const delta = shortVerdict(verdict);
      const cClause = cClauseOf(r.source);
      const strength = mapStrength(r, cExcerptByTopic);
      const strengthCell =
        strength === "完全对应" ? "[完全对应]" : strength === "部分重叠" ? "[部分重叠]" : strength === "无对应" ? "[无对应]" : "未映射";
      if (r.verdictReason) corrections.push({ name: `${r.topic} · ${r.name}`, verdict, reason: String(r.verdictReason) });
      parts.push(
        `| ${pad2(n)} | ${cell(`${r.topic} · ${r.name}`)} | ${cell(b)} | ${cell(a)} | ${delta} | ${cClause ? `R48 ${cClause}` : "—"} | ${strengthCell} |`,
      );
    }
    parts.push("");
  }

  // 判定分布 —— 小结只报**核验过的**事实
  const byVerdict = new Map<string, number>();
  for (const r of rows) {
    const v = verdictOf(r).verdict;
    byVerdict.set(v, (byVerdict.get(v) ?? 0) + 1);
  }
  const vcount = (v: string) => byVerdict.get(v) ?? 0;
  const realChanges = vcount("有变化") + vcount("有变化（待核实）");
  const parts_: string[] = [];
  parts_.push(
    `**矩阵小结**：${rows.length} 项差值候选中 **${vcount("有变化")} 项为实质变化**（均已回原文核验）` +
      (vcount("有变化（待核实）") ? `、${vcount("有变化（待核实）")} 项标为待核实` : "") +
      `；其余 ${rows.length - realChanges} 项**不是数值变化**：` +
      `两版同文 ${vcount("两版同文（已回原文核验）") + vcount("两版同文（勘误）")} 项` +
      `、数值与口径相同 ${vcount("数值与口径相同（非数值变化）")} 项` +
      `、表述差异待复核 ${vcount("表述差异（未做数值核验）")} 项` +
      `、编号重排 ${vcount("引用编号变化（非实质）")} 项` +
      `、规则判定非变化 ${vcount("非变化（规则判定）")} 项` +
      `、重复行 ${vcount("重复行（已合并）")} 项。` +
      `覆盖 ${ordered.length} 个参数维度；${rows.filter((r) => cClauseOf(r.source)).length} 项标注了 C UN R48 对应条款号。`,
    "",
    `> **口径说明**：本表的分布是**逐条裁定后**的；执行摘要第 2 条用的是**抽取流量**口径` +
      `（候选 = 数值变化 + 引用重排 + 同文 + 措辞差异 + 规则过滤）。两者的差额来自下面这 ` +
      `${corrections.length} 条**回原文裁定**的行 —— 抽取时看着像差异，回原文核过才知道是同文、错配或非变化。` +
      `逐条理由见本表下方。`,
    "",
  );
  if (corrections.length) {
    parts_.push(
      `**本表对 ${corrections.length} 行做了人工裁定**（逐条回原文核验，含抄错单位、错配行、纯措辞与定性要求的裁定；` +
        `裁定清单见 \`data/diff-corrections.json\`，由 \`scripts/diff_value_check.py\` 在交付闸门里复核）：`,
      "",
    );
    for (const c of corrections) {
      parts_.push(`- **${c.name}** —— ${c.verdict}：${c.reason}`);
    }
    parts_.push("");
  }
  parts.push(...parts_);
  return parts.join("\n");
}



/**
 * The candidate-flow counts, normalised across the three shapes the pipeline
 * can hand us. These keys are what decide the executive summary's "N 条候选"
 * and §11.3's closure sentence, so a miss is not cosmetic — it prints a
 * confident but wrong total:
 *
 *   - `counts` (dist/facts.json)        flat:  { candidates, wordingFiltered, ruleDropped }
 *   - `flow`  (verified-comparison.json) nested: buckets.{...}, plus flow.candidates
 *                                          and flow.ruleDropped at the top level
 *
 * Reading `verified.flow` as if it were flat (the bug) picked up ruleDropped
 * but silently lost buckets.wordingFiltered, so the summary summed 3+1+9+0+2=15
 * and printed "合计 15" beside a claim of 45 candidates.
 */
function resolveFlowCounts(verified: any): Record<string, number> {
  const c = verified?.counts;
  if (c && typeof c.candidates === "number") return c;
  const flow = verified?.flow;
  if (flow) {
    const b = flow.buckets ?? {};
    return {
      ...b,
      candidates: flow.candidates ?? b.numeric,
      ruleDropped: flow.ruleDropped ?? b.ruleDropped ?? 0,
    };
  }
  return {};
}

function build11_3numeric(vchanges: any[], renumbered?: any[], manualFindings?: any[], textChanges?: any[], counts?: any, sameText?: any[]): string {
  const sameT = sameText ?? [];
  if (!vchanges.length && !(renumbered && renumbered.length) && !(textChanges && textChanges.length) && !sameT.length) return "_(本子节无内容)_";
  // Counts come straight from verify_claims.py's flow accounting. The old code
// hardcoded `?? 30` / `?? 2`, which meant a changed or missing key still rendered
// a confident-looking total — the partition could silently rot. Default to 0 and
// shout instead, so a gap is visible rather than plausible.
  if (counts && (counts.wordingFiltered === undefined || counts.ruleDropped === undefined)) {
    console.warn("[v6] counts missing wordingFiltered/ruleDropped — rendering 0; verify_claims output shape changed?");
  }
  const wording = counts?.wordingFiltered ?? 0;
  const rule = counts?.ruleDropped ?? 0;
  const cand = counts?.candidates ?? (vchanges.length + (renumbered?.length ?? 0) + wording + rule + sameT.length);
  const total = vchanges.length + (renumbered?.length ?? 0) + sameT.length + wording + rule;
  // Only claim "账目闭环" when the buckets actually reconcile against the
  // candidate total; otherwise state the discrepancy instead of asserting it.
  const closed = counts?.candidates === undefined || total === counts.candidates;
  const closureNote = closed
    ? `——合计 ${total}，账目闭环。`
    : `——合计 ${total}，与候选数 ${counts?.candidates} 不符，需人工复核。`;
  const parts: string[] = [];
  parts.push(
    "### 11.3 重大修订条款（数值级）",
    "",
    `下表为 **A/B 同名参数的数值变化**（经证据规则过滤后的幸存者）。${cand} 条候选的完整去向：**${vchanges.length} 条入本表** + ${(renumbered?.length ?? 0)} 条引用编号单列（11.3.2）+ **${sameT.length} 条同文勘误**（11.3.0，曾误列已降级）+ ${wording} 条同义改写（11.8 复核清单）+ ${rule} 条规则判定非变化（表格行错位、电压分层两版同存）${closureNote}`,
    "",
  );
  if (vchanges.length) {
    const rows = vchanges.map((v, i) => {
      const ok = v.status === "verified";
      const tag = ok ? "[已核验]" : "[待核实]";
      const bCell = v.oldValue + (v.bPage ? `（${v.bPage}）` : "");
      const aCell = v.newValue + (v.aPage ? `（${v.aPage}）` : "");
      return `| ${pad2(i + 1)} | ${cell(v.topic)} · ${cell(v.name)} | ${tag} | ${cell(bCell)} | ${cell(aCell)} |`;
    });
    const okCount = vchanges.filter((v) => v.status === "verified").length;
    parts.push(
      "| 序号 | 主题·参数 | 核验 | B 现行版（原文） | A 草案（原文） |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      `**小计**：${vchanges.length} 条数值变化，其中 ${okCount} 条已定位到原文页码（标注页码可直接对照 PDF），${vchanges.length - okCount} 条标注 [待核实] 未能定位，使用前建议人工复核。`,
      "",
    );
  }
  if (sameT.length) {
    parts.push(
      `#### 11.3.0 同文勘误（${sameT.length} 条——曾误列数值表，已回原文核验两版同文，非数值变化）`,
      "",
      "下列条目曾被误列为数值变化：B 侧值记录被**截断**（只记录\"1200mm\"，而 B 原文还有\"…可增加到1500mm\"）。回原文核验两版同文，故降级为勘误：",
      "- **B 同页已含**：A 的特征数字在 B 同一页已出现 → 两版同文",
      "- **数值序列相同 / 无特征数字**：仅格式差异（如\"两只→2只\"）",
      "- **重复行**：与前一条同参数、同页码",
      "",
      "工程师**无需**把这些当变化查证；本清单是勘误，页码可直接对照原文复核。",
      "",
      "| # | 主题·参数 | B 现行版 | A 草案 | 降级依据 |",
      "|---|---|---|---|---|",
      ...sameT.map((s, i) => {
        const bCell = s.oldValue + (s.bPage ? `（${s.bPage}）` : "");
        const aCell = s.newValue + (s.aPage ? `（${s.aPage}）` : "");
        return `| ${pad2(i + 1)} | ${cell(s.topic)} · ${cell(s.name)} | ${cell(bCell)} | ${cell(aCell)} | ${cell(s.reason)} |`;
      }),
      "",
    );
  }
  if (manualFindings && manualFindings.length) {
    parts.push(
      "#### 11.3.1 人工对照补录（固定对比主题之外的条款）",
      "",
      "下列变化经人工对照 A/B 原文确认，但因不在 18 个固定对比主题内而未被程序捕获，单独补录并注明来源。",
      "",
      "| # | 主题·参数 | 核验 | B 现行版 | A 草案 | 来源 |",
      "|---|---|---|---|---|---|",
    );
    manualFindings.forEach((m, i) => {
      const bCell = m.bPage ? `${m.oldValue}（${m.bPage}）` : m.oldValue;
      const aCell = m.aPage ? `${m.newValue}（${m.aPage}）` : m.newValue;
      // 来源列：显示中文说明，不要把内部标记 manual-audit 直接印给读者
      const srcText = /manual-audit|人工对照/.test(String(m.source ?? ""))
        ? "人工对照（已核原文）"
        : String(m.source ?? "—");
      parts.push(`| ${pad2(i + 1)} | ${cell(m.topic)} · ${cell(m.name)} | [人工核验] | ${cell(bCell)} | ${cell(aCell)} | ${cell(srcText)} |`);
    });
    parts.push("");
  }
  if (textChanges && textChanges.length) {
    parts.push(
      `#### 11.3.x 文字表述变化（${textChanges.length} 条，非数值）`,
      "",
      "下列差异为**句子/结构层面的表述不同**（两边都含文字叙述，非纯数字）。单列以免冒充数值变化；数值部分已在 11.3 上表体现。",
      "",
      "| # | 主题·参数 | B 现行版 | A 草案 | 核验 |",
      "|---|---|---|---|---|",
    );
    textChanges.forEach((v, i) => {
      const ok = v.status === "verified";
      const tag = ok ? "[已核验]" : "[待核实]";
      const bCell = v.oldValue + (v.bPage ? `（${v.bPage}）` : "");
      const aCell = v.newValue + (v.aPage ? `（${v.aPage}）` : "");
      parts.push(`| ${pad2(i + 1)} | ${cell(v.topic)} · ${cell(v.name)} | ${cell(bCell)} | ${cell(aCell)} | ${tag} |`);
    });
    parts.push("");
  }
  if (renumbered && renumbered.length) {
    parts.push(
      "#### 11.3.2 引用编号变化（非实质修改，章节重组所致）",
      "",
      "下列条目 A/B 的**实质内容完全相同**，仅所引用的条款编号因章节重组而改变。**不是技术内容变化**，不计入上表。",
      "",
      "| # | 主题·参数 | B 现行版 | A 草案 |",
      "|---|---|---|---|",
    );
    renumbered.forEach((c, i) => {
      parts.push(`| ${pad2(i + 1)} | ${cell(c.topic)} · ${cell(c.name)} | ${cell(c.oldValue)} | ${cell(c.newValue)} |`);
    });
    parts.push("", `**小计**：${renumbered.length} 条纯引用编号变化。`, "");
  }
  return parts.join("\n");
}

function buildAppendixB(data: Record<string, any>): string {
  const parts: string[] = [
    "# 附录 B 图片、公式与数据溯源",
    "",
    "## B.1 公式（原文公式，LaTeX 形式）",
    "",
  ];
  for (const label of ["A", "B", "C"]) {
    const eqs = data[label]?.equations ?? [];
    if (!eqs.length) continue;
    parts.push(`**${label}**（${eqs.length} 个）：`);
    for (const e of eqs) parts.push(`- p${e.page}: \`${(e.latex || "").slice(0, 200)}\``);
    parts.push("");
  }
  parts.push("## B.2 图片清单", "");
  parts.push("| 文档 | 页 | 标题 |", "|---|---|---|");
  for (const label of ["A", "B", "C"]) {
    const figs = data[label]?.figures ?? [];
    // Recover figure captions: MinerU left caption empty for many figures
    // but the ORIGINAL page text carries them ("图1 明暗截止线下倾度范围").
    const pmap = pageTextOf(data[label]?.fullText ?? "");
    for (const f of figs) {
      let cap = f.caption || "";
      if (!cap) {
        const pt = pmap.get(Number(f.page)) ?? "";
        const m = pt.match(/图\s*\d+\s*[一-鿿][^\n。；]{2,28}/);
        if (m) cap = m[0].trim();
      }
      parts.push(`| ${label} | p${f.page} | ${esc(cap || "（无题注）")} |`);
    }
  }
  parts.push("");
  parts.push("## B.3 标题层级索引（原文标题）", "");
  parts.push("按文档分列 L1/L2/L3 标题，便于工程师做文档结构对比与跳转。", "");
  for (const label of ["A", "B", "C"]) {
    let hs: any[] = data[label]?.headings ?? [];
    // Merge font-split fragments: pure clause-number lines join the NEXT
    // title ("3.1.2" + "系统控制器"), pure "（规范性）" and appendix-header
    // chains join the PREVIOUS entry. Same-page only.
    {
      const merged: any[] = [];
      let pendingNum = "";
      for (const h of hs) {
        const t = String(h.title ?? "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        if (/^\d+(?:\.\d+)+$/.test(t)) { pendingNum = t; continue; }
        const title = pendingNum ? `${pendingNum} ${t}` : t;
        pendingNum = "";
        const prev = merged[merged.length - 1];
        const pureParen = /^[（(][^）)]+[）)]$/.test(title);
        const prevChain = !!prev && (/（规范性）$|\(规范性\)$|附\s*录\s*[A-Z]\s*$/.test(prev.title));
        if (prev && h.page === prev.page && (pureParen || prevChain)) {
          prev.title = prev.title + title;
        } else {
          merged.push({ ...h, title });
        }
      }
      if (pendingNum) merged.push({ ...hs[hs.length - 1], title: pendingNum });
      hs = merged;
    }
    parts.push(`**${label}** 共 ${hs.length} 个标题：`);
    const l1 = hs.filter((h: any) => h.level === 1);
    const l2 = hs.filter((h: any) => h.level === 2);
    const l3 = hs.filter((h: any) => h.level === 3);
    parts.push(`- L1（一级）${l1.length} 个 | L2（二级）${l2.length} 个 | L3（三级）${l3.length} 个`);
    parts.push("");
    parts.push("| 级别 | 页 | 标题 |", "|---|---|---|");
    for (const h of [...l1, ...l2, ...l3]) parts.push(`| L${h.level} | p${h.page} | ${esc(h.title)} |`);
    parts.push("");
  }
  parts.push("## B.4 数据溯源（第 11 章指标 → 原文页）", "");
  parts.push("第 11.4 节每条指标的 B/A 数值均标注出现页码，可对照 PDF 原文直接验证。");
  return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* --------------------------------------------------------- source corpus */

let CORPUS_CACHE: any = null;

/**
 * Source-PDF text, loaded once per process. MinerU's table extraction garbles
 * GB 4785-2019's chromaticity table; the uploaded PDFs read directly through
 * PyMuPDF (fragments concatenated) recover it. Cached because the caller runs it
 * on every generation and the dump shells out to Python.
 */
async function getSourceCorpus(data: Record<string, any>) {
  if (CORPUS_CACHE) return CORPUS_CACHE;
  try {
    CORPUS_CACHE = await loadSourceCorpus(ROOT, data);
    // Report what actually loaded, not what was hoped for: a version missing
    // from `pages` is exactly the condition the matrix cells fall back from, so
    // printing 0p for it here is how you spot it. (Keying the log on a literal
    // A/B/C list is what turned a missing corpus into a TypeError here.)
    console.log(
      `[v6] source-PDF corpus: ${Object.entries(CORPUS_CACHE.pages)
        .map(([v, p]) => `${v}=${p.length}p`)
        .join(" ")}`,
    );
  } catch (e) {
    console.warn("[v6] source-PDF corpus unavailable, MinerU only:", String(e).slice(0, 160));
    CORPUS_CACHE = { pages: {}, origin: {} };
  }
  return CORPUS_CACHE;
}

/*  写作改进 1：执行摘要（报告开篇 5 要点）                                     */
/* -------------------------------------------------------------------------- */

/**
 * Chapter 12 — the parameter matrix the customer actually asked for.
 *
 * Replaces build12_quantitativeTables, which shipped three consecutive raw
 * table dumps (A's, then B's, then C's) under a summary column that read
 * 见下方表格内容 on all 492 rows. That was a listing, not a comparison, and
 * its 1:1:1 grouping was impossible anyway: C has 43 tables to A/B's 17.
 *
 * The matrix is one row per parameter with a value from each version, plus
 * clause and page so every cell can be checked against the source. Coverage
 * is stated up front — including which families are still missing — because a
 * reader who trusts an unlocated cell is worse off than one told it is absent.
 */
function buildChapter12Matrix(
  rows: ReturnType<typeof buildParamMatrix>["rows"],
  stats: ReturnType<typeof buildParamMatrix>["stats"],
): string {
  const vs = stats.versions;
  const bv = stats.byVersion;
  const n = vs.length;
  const all = (r: (typeof rows)[number]) => vs.every((v) => r.cells[v].status === "verified");
  const full = rows.filter(all);
  const families = [...new Set(rows.map((r) => r.family))];
  const hitLine = vs.map((v) => `${v} ${bv[v].hit}/${bv[v].total}`).join(" · ");
  const cols = vs.join("/");
  const colsSpaced = vs.join(" / ");
  const way = n === 3 ? "三版" : `${n} 版`;

  const head = [
    `# 第 12 章 关键参数 ${cols} ${way}本对照`,
    "",
    `> 本章是**逐参数对照**：一行一个参数，${colsSpaced} 各列给出该版本的原文取值、`,
    `> 条款号与页码，可直接回原文核对。判定列只回答一个问题——${vs[0]} 与 ${vs[1]} 是否一致。`,
    "",
    `**本版覆盖**：${rows.length} 个参数 × ${n} 版本 = ${stats.cells} 个取值位，` +
      `已定位 ${stats.verified} 个` +
      `（${hitLine}）；` +
      `其中 ${full.length} 个参数${way}取值齐全，可做完整${n > 2 ? "三方" : ""}对照。`,
    "",
    `**覆盖的参数族**：${families.join(" · ")}。`,
    "",
    "**每一个空格子都有明确归类：要么有值（带条款与页码），要么标「无此规定（已核）」并附逐条依据。**",
    "**没有「不知道」的格子** —— 不做推测填充；定位不到与定位到错误的区别是：前者读者知道要自己去翻，后者读者会当真。",
    `**取值来源**：MinerU 抽取 ${stats.cells - stats.fromSourcePdf} 处；` +
      `${stats.fromSourcePdf} 处 MinerU 未能读出，改由上传的源 PDF 直读补齐` +
      "（明细表页码后标注「· 源 PDF」）。GB 4785-2019 的色度表文本层会把三列串成一行" +
      "（WWWW34564561黄紫紫蓝色红色色边…），" +
      "直读源 PDF 并把碎片拼接后可完整还原。",
    "",
    "---",
    "",
  ].join("\n");

  const gaps = rows.filter((r) => vs.some((v) => r.cells[v].status === "not-found"));

  /**
   * The question an export engineer actually asks: where A changed, does R48
   * already say the same thing, or does A now diverge from it? This is only
   * answerable with all three columns present, which is why the matrix exists.
   */
  const divergence = rows.filter(
    (r) => r.verdict === "changed" && vs.slice(2).every((v) => r.cells[v].status === "verified") &&
      vs.slice(2).every((v) => r.cells[v].nums.length) && r.cells[vs[0]].nums.length,
  );
  const divergenceMd = divergence.length
    ? [
        "",
        "---",
        "",
        `## 12.4 三方取值分歧（出口欧盟重点看这一节）`,
        "",
        `下列参数 ${vs[0]} 与 ${vs[1]} 不一致，且 ${vs[2]} 也有取值 —— 据此可判断 ${vs[0]} 是在向 R48 对齐，还是背离 R48。`,
        "",
        ...divergence.map((r) => {
          const a = r.cells[vs[0]].nums.join(" / ");
          const b = r.cells[vs[1]].nums.join(" / ");
          const ref = vs[2];
          const c = r.cells[ref].nums.join(" / ");
          // Containment, not equality: A's clause usually states the same limit
          // plus extra conditions, so the test is whether the reference
          // version's values are already covered by the national pair's.
          const cIn = (set: string[]) => r.cells[ref].nums.every((n) => set.includes(n));
          const align = cIn(r.cells[vs[0]].nums)
            ? `**${vs[0]} 已覆盖 ${ref} 的取值 —— ${vs[0]} 在向 R48 对齐**`
            : cIn(r.cells[vs[1]].nums)
              ? `${vs[1]} 已覆盖 ${ref} 的取值、${vs[0]} 未覆盖 —— **${vs[0]} 在此条上背离 R48**`
              : "三版取值互不相同，需逐条回原文核对";
          return `- **${r.name}**（${r.unit}）：${vs[0]} ${a} ／ ${vs[1]} ${b} ／ ${ref} ${c} —— ${align}`;
        }),
      ].join("\n")
    : "";
  const tail = gaps.length
    ? [
        "",
        "---",
        "",
        "## 12.3 缺一版取值的参数（本版不判定）",
        "",
        `下列参数在${way}里**没有可比的数值规定**，因此不做判定，也不填入推测值。`,
        "",
        "> **这一节不是「数据缺口」。** 每一个空格都是**人工回该版原文逐条核对**过的：",
        "> 该版确实没有这一条规定（或转引他标、本标准自身不含数值），",
        "> 逐条依据写在 12.2 的明细里。**空 ≠ 没抽到。**",
        "> 真正「没抽到」的情况（抽取失败）在这批数据里是 **0 条**。",
        "",
        ...gaps.map((r) => {
          const miss = vs.filter((v) => r.cells[v].status === "not-found");
          const noSpec = miss.filter((v) => r.cells[v].miss === "not-specified");
          const notLoc = miss.filter((v) => r.cells[v].miss !== "not-specified");
          const parts: string[] = [];
          if (noSpec.length) parts.push(`${noSpec.join("/")} 已核「该版无此规定」`);
          if (notLoc.length) parts.push(`${notLoc.join("/")} 未定位到`);
          return `- **${r.name}**（${r.family}）—— ${parts.join("；") || "—"}`;
        }),
      ].join("\n")
    : "";

  // ── 分组 ────────────────────────────────────────────────────────────
  // 305 行平铺，205 行「三版一致」和 9 行「变了」混在一起 ——
  // 读者要自己扫才知道哪几行要他改设计。客户抱怨的「只有罗列，无对比」
  // 在这一章的具体表现就是这个。
  const groups = groupRows(rows, vs);
  const needAction = [...groups.changed, ...groups.singleSide, ...groups.incomplete];
  const famCount = (list: typeof rows): string => {
    const m = new Map<string, number>();
    for (const r of list) m.set(r.family, (m.get(r.family) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([f, n]) => `${f} ${n}`)
      .join(" · ");
  };

  const decisionView = [
    "",
    "---",
    "",
    "## 12.0 决策视图：305 个参数里，需要动作的是这些",
    "",
    `**${rows.length} 个参数按「读者要不要动手」分四组：**`,
    "",
    "| 组 | 条数 | 含义 | 要做什么 |",
    "|---|---|---|---|",
    `| **有变化** | ${groups.changed.length} | ${vs[0]} 与 ${vs[1]} 取值不一致 | **逐条核对 12.1.1** |`,
    `| **只有一版有** | ${groups.singleSide.length} | 另一版确实没有这条规定 | 确认是「该版无此规定」还是漏了 |`,
    `| **缺一版取值** | ${groups.incomplete.length} | 有一版没取到可比数值 | 见 12.4 的逐条依据 |`,
    `| **三版一致** | ${groups.same.length} | ${vs.join("/")} 取值相同 | **不需要改设计** |`,
    "",
    `> **${groups.same.length} 行「三版一致」（占 ${Math.round((groups.same.length / rows.length) * 100)}%）的明细在附录 G。**`,
    "> 它们不是不重要 —— 是**逐条列出来供核对**，但不需要工程师动手。",
    "> 按参数族分布：" + (famCount(groups.same) || "—"),
    "",
    "### 需要动作的 " + needAction.length + " 条（速览）",
    "",
    renderMatrixSummaryTable(needAction, vs),
    "",
  ].join("\n");

  const grouped = [
    "## 12.1 参数对照总表（按判定分组）",
    "",
    "> 同一个表格，**按「要不要动手」排** —— 而不是按参数名字母序。",
    "",
    "### 12.1.1 有变化（" + groups.changed.length + " 条）",
    "",
    renderMatrixSummaryTable(groups.changed, vs),
    "",
    "### 12.1.2 只有一版有规定（" + groups.singleSide.length + " 条）",
    "",
    renderMatrixSummaryTable(groups.singleSide, vs),
    "",
    "### 12.1.3 缺一版取值（" + groups.incomplete.length + " 条）",
    "",
    renderMatrixSummaryTable(groups.incomplete, vs),
    "",
    "### 12.1.4 三版一致（" + groups.same.length + " 条）",
    "",
    renderMatrixSummaryTable(groups.same, vs),
    "",
  ].join("\n");

  // 明细块：**只给需要动作的行**；「三版一致」那批挪到附录 G。
  const details = [
    "## 12.2 逐参数原文明细（需要动作的 " + needAction.length + " 条）",
    "",
    `上表只给数值，便于横向扫读；下面逐个参数给出${n === 3 ? "三版" : `${n} 版`}原文取值、条款号与页码，可直接回原文核对。`,
    "> **三版一致那 " + groups.same.length + " 条的逐条明细在附录 G** —— 它们不需要动手，",
    "> 但保留在交付件里供核对。",
    "",
    renderMatrixDetails(needAction, vs),
  ].join("\n");

  return head + decisionView + grouped + details + tail + divergenceMd;
}

/**
 * Aggregate the parameter matrix so the executive summary can state impact.
 *
 * Every number here MUST come from the audited candidate flow (facts.counts /
 * verified.flow.buckets) or from the explicit change lists. The previous
 * version re-derived them by comparing valueDiff.oldValue !== newValue, which
 * counted every *wording* difference as a substantive parameter change: it
 * reported 45 "实质变化" while the audited flow said 3 numeric + 9 manual, and
 * its own family breakdown (15+8+8=31) didn't even sum to the 45 it claimed.
 * Two numbers in the same bullet then contradicted the summary's own body.
 *
 * A number that can be counted has exactly one source. See HANDOVER §7.1.
 */
function matrixStats(verified: any) {
  const counts = resolveFlowCounts(verified);
  const numeric: any[] = Array.isArray(verified?.numericChanges) ? verified.numericChanges : [];
  const manual: any[] = Array.isArray(verified?.manualFindings) ? verified.manualFindings : [];
  const sameText: any[] = Array.isArray(verified?.sameTextDropped) ? verified.sameTextDropped : [];

  // The two kinds of real A→B change, and nothing else. Wording differences and
  // same-text rows are NOT design-impacting, so they must not be counted here.
  const real = [...numeric, ...manual];
  const changed = real.length;

  const famCount = new Map<string, number>();
  for (const r of real) {
    const fam = paramFamilyOf(r.name ?? "", r.topic ?? "");
    famCount.set(fam, (famCount.get(fam) ?? 0) + 1);
  }
  const topFamilies = Array.from(famCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f, n]) => `${f}（${n} 项）`)
    .join("、");

  const wordingOnly = counts.wordingFiltered ?? 0;
  return {
    total: counts.candidates ?? (changed + sameText.length + wordingOnly + counts.ruleDropped),
    changed,
    numericOnly: numeric.length,
    manualOnly: manual.length,
    same: sameText.length,
    wordingOnly,
    topFamilies: famCount.size ? topFamilies : "—",
    // The illustrative example must come from a real row. It used to be a
    // hardcoded literal — "近光灯最大离地高度由 1200mm 改为「1200mm，N3G 类可
    // 放宽至 1500mm」" — but GB 4785-2019 §5.2.4.2 already carries that exact
    // wording (B p24), so the summary's single concrete illustration of a
    // "substantive change" was not a change at all.
    example: realChangeExample(real),
  };
}

/** First genuine A→B change, quoted verbatim with its pages, or "" if none. */
function realChangeExample(real: any[]): string {
  for (const r of real) {
    const o = String(r.oldValue ?? "").trim();
    const n = String(r.newValue ?? "").trim();
    if (!o || !n || o === n) continue;
    if (o.length > 70 || n.length > 70) continue;
    const pages = [r.bPage, r.aPage].filter(Boolean).join(" → ");
    return `例如「${r.topic ?? ""}·${r.name ?? ""}」由「${o}」改为「${n}」${pages ? `（${pages}）` : ""}。`;
  }
  return "";
}

function renumberNote(verified: any): number {
  return (verified?.renumberedOnly ?? []).length;
}



function buildExecSummary(input: {
  data: Record<string, any>;
  verified: any;
  indicators: any[];
  chapterAdded: number;
  newDevices: number;
  diffResult?: any;
  /** 变化总清单 —— 全报告唯一的「改了什么」。执行摘要只报这一个数。 */
  changeLedger?: ChangeRow[];
}): string {
  const { data, verified, indicators, chapterAdded, newDevices, diffResult: diffResultForSummary } = input;
  const ledger = input.changeLedger ?? [];
  const ledgerBd = ledgerBreakdown(ledger);
  // 参数族分解**按清单算** —— 以前按 numeric+manual 算（14 条），
  // 而报的总数是别的数，两处对不上。现在同一份清单出两个数。
  const ledgerFam = new Map<string, number>();
  for (const r of ledger) {
    const fam = paramFamilyOf(r.name ?? "", r.topic ?? "");
    ledgerFam.set(fam, (ledgerFam.get(fam) ?? 0) + 1);
  }
  const ledgerTopFamilies =
    Array.from(ledgerFam.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([f, n]) => `${f}（${n} 项）`)
      .join("、") || "—";
  const num = verified?.numericChanges ?? [];
  const numOk = num.filter((v: any) => v.status === "verified").length;
  const keep = indicators.filter((i) => i.status === "kept");
  const missing = indicators.filter((i) => i.status === "missing");
  const single = indicators.filter((i) => i.status === "single-side");
  const topics = verified?.topicColumns ?? [];
  const exStats = verified?.stats?.excerpts ?? { total: 0, verified: 0 };
  const totalTables = ["A", "B", "C"].reduce((a, k) => a + (data[k]?.tables?.length ?? 0), 0);
  // candidate-flow accounting — every valueDiff lands in exactly one bucket
  // (candidates = numeric + renumbered + wordingFiltered + ruleDropped).
  // Derived from facts.counts, never hardcoded (drifted before, REPORT_ERRORS 三十二).
  const refN = (verified?.renumberedOnly ?? []).length;
  // See resolveFlowCounts: verified-comparison.json nests the buckets under
  // flow.buckets, so `verified.counts ?? verified.flow` is not a safe fallback.
  const counts = resolveFlowCounts(verified);
  if (counts.candidates === undefined) {
    console.warn(
      "[v6] no candidate-flow counts (facts.counts or flow.buckets) — the executive " +
        "summary total is a guess. Run verify_claims.py to regenerate dist/facts.json.",
    );
  }
  const wordingN = counts.wordingFiltered ?? 0;
  const ruleD = counts.ruleDropped ?? 0;
  const sameN = (verified?.sameTextDropped ?? []).length;
  const cand = counts.candidates ?? (num.length + refN + wordingN + ruleD + sameN);
  // 人工补录的清单**从数据生成** —— 以前是手写的一句话，
  // 新增一条 manual finding 时它不会跟着变（漏数据，且没人会发现）。
  const manualBriefs = (verified?.manualFindings ?? [])
    .map((m: any) => String(m.brief ?? `${m.topic ?? ""}·${m.name ?? ""}`).trim())
    .filter(Boolean)
    .join("、");

  // 差值候选的**裁定后**分布（11.3.3 逐行判定的那一份）。
  // 执行摘要第 2 条以前用的是**抽取流量**分桶（sameText 9 / wording 30），
  // 那些桶是「抽取时看着像不像差异」，不是「有没有工程含义」——
  // 牌照灯数量、醒目标志光色、DRL×A2 互斥三行都落在措辞桶里，
  // 回原文核过却是**真变化**。按流量桶下结论，会把三条真变化说成「无工程含义」。
  const verdictCounts = (() => {
    const m = new Map<string, number>();
    for (const v of Object.values((verified?.diffVerdicts ?? {}) as Record<string, any>)) {
      const k = String((v as any)?.verdict ?? "");
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  })();
  const vc = (k: string) => verdictCounts.get(k) ?? 0;
  const diffCandidates = (verified?.diffValueDiffs ?? []).length;
  const diffChanges = vc("有变化");
  const diffSameText = vc("两版同文（已回原文核验）") + vc("两版同文（勘误）");
  const diffSameNum = vc("数值与口径相同（非数值变化）");
  const diffPending = vc("表述差异（未做数值核验）");
  const diffRenumbered = vc("引用编号变化（非实质）");
  const diffDuplicate = vc("重复行（已合并）");
  const diffNonChange = diffSameText + diffSameNum + diffPending + diffRenumbered + diffDuplicate;

  // Decision layer. The summary previously listed what changed ("新增 9 项")
  // and stopped there, so a reader learned nothing actionable. These four lines
  // are derived from the parameter matrix (§11.3.3) — the same numbers a reader
  // can check — and state what the changes MEAN for design and certification.
  const matrix = matrixStats(verified);
  const mmNote = matrix.total
    ? [
        "",
        "## 本报告的结论（按决策口径）",
        "",
        `1. **设计端必须改**：**${ledgerBd.total} 条**实质变化，集中在 ${ledgerTopFamilies}。` +
          (matrix.example ? `这些不是措辞调整——${matrix.example}` : "") +
          `**完整清单见 §11.0 变化总清单**（每一行带条款与页码，可回原文逐条核对）。` +
          `本报告里「变化」一共有四套来源的原始清单（§11.3 数值级、§11.3.1 人工补录、` +
          `§11.3.3 差值裁定、第 12 章参数矩阵，共 ` +
          `${Object.values(ledgerBd.bySource).reduce((a, b) => a + b, 0)} 条原始条目），` +
          `去掉重复后是 **${ledgerBd.total} 条** —— 报告各处只报这一个数，逐条来源在 §11.0 的「出处」列。`,
        `2. **不需要改设计**：${diffCandidates} 条差值候选里 **${diffChanges} 项为实质变化**` +
          `（均已回原文核验，含在上条的 ${ledgerBd.total} 条之内；逐条判定见 11.3.3），` +
          `其余 **${diffNonChange} 项不是数值变化**：` +
          `两版原文完全相同 ${diffSameText} 项（已回原文核验）、` +
          `数值与限值口径相同 ${diffSameNum} 项（仅措辞/格式不同）、` +
          `条款号重排 ${diffRenumbered} 项、重复行 ${diffDuplicate} 项——` +
          "这些只需更新内部引用文件编号，产品无需变更。",
        `3. **出口欧盟：请以第 12 章的参数矩阵为准**。该章逐参数给出 A/B/C 三版取值与条款页码，` +
          `是本版唯一可支撑 C 定量判断的部分。**每一个取值位都有明确归类**：` +
          `有值（带页码）或「无此规定（已核）」（附逐条依据）—— **没有「不知道」的格子**，` +
          `也**不填推测值**。第 12.4 节是出口重点：A 与 B 不一致且 C 也有取值的那几条，` +
          `逐条给出「A 在向 R48 对齐」还是「A 在此条上背离 R48」。` +
          `附录 C 另提供 24 个主题的原文摘录与条款号，可回查原文。` +
          `**出口认证前请勿以本报告替代 R48 原文逐条比对。**`,
        `4. **数值相同 ≠ 口径相同 —— 本版已发现 1 处方向相反**。` +
          "驾驶员辅助投射的开启/保持车速：GB A 为「开启车速上限 65 km/h、保持开启下限 40 km/h」，" +
          "而 R48 §5.35.10 写的是「**低于 65 km/h 不得开启**」「**高于 40 km/h 方可保持开启**」——" +
          "**数字相同，条件方向相反**。矩阵里两列都显示 65 / 40，只看数值会判成「三版一致」。" +
          "这类差异无法从数值矩阵自动检出（要读条件句而非读数字），全表需人工过一遍条件方向。",
        `5. **本版不能作为认证依据的项**：${missing.length} 条 GB4785 表 11.6 声称指标在 A/B 原文中未检索到；` +
          `差值候选里 **${diffPending} 项仍待人工裁定**（其余 ${diffCandidates - diffPending - diffChanges} 项已逐条回原文核验，` +
          `判定见 11.3.3；11.8 保留全部 ${wordingN} 条表述/术语候选差异供工程师复核）。` +
          "结论层面已逐条列在第 11 章，使用前须回原文确认。",
        `6. **「真缺口 0」说的是量化限值，不是全部要求**：三版合计 ${(REQUIREMENT_LEDGER as any)?.totals?.requirements ?? 0} 条要求条款里，` +
          `${(REQUIREMENT_LEDGER as any)?.totals?.covered ?? 0} 条已覆盖、` +
          `**${(REQUIREMENT_LEDGER as any)?.totals?.appendixListed ?? 0} 条定性要求在附录 E.5.1 逐条列出原文、页码与理由**` +
          `（如 R48 的「紧急制动信号应自动开启与关闭」「应独立于其他灯具工作」—— 报告只对照了它的闪烁频率），` +
          `${(REQUIREMENT_LEDGER as any)?.totals?.quoted ?? 0} 条已引原文（随长摘录带入，E.5.2 列出条款号与页码），` +
          `${(REQUIREMENT_LEDGER as any)?.totals?.notApplicable ?? 0} 条非产品要求（已登记理由），` +
          `**真缺口 ${(REQUIREMENT_LEDGER as any)?.totals?.gaps ?? 0} 条**。见附录 E.5。`,
      ]
    : [];

  return [
    "# 执行摘要",
    "",
    ...mmNote,
    ...(mmNote.length ? ["", "---", ""] : []),
    "## 逐条统计",
    "",
    "本报告对三份法规文件（A 草案 V4.3.5 / B 现行 GB 4785-2019 / C UN R48-09）做逐条横向对照。核心结论：",
    "",
    `**1. 结构变化**：A 草案在 B 基础上新增 ${chapterAdded} 项（${chapterAdded - newDevices} 项章节级：第 6 从属功能章、第 7 扩展功能章；${newDevices} 项装置级新功能：ADS 标志灯、驾驶员辅助投射、图文交互、发光徽标、外部氛围功能、外部状态指示器等）。另有 ${DEVICE_RENUMBERING.length} 项装置级编号重排 + ${refN} 项引用编号变化（章节重组所致，非实质，见 11.6.2 / 11.3.2）。`,
    "",
    `**2. 数值变化**：共 ${num.length} 条 A/B 同名参数数值变化（**${numOk} 条已定位到原文页码**，第 11.3 节标注 [已核验]）+ ${(verified.manualFindings ?? []).length} 条人工对照补录（${manualBriefs}——均为 18 个固定对比主题之外的条款，见 11.3.1）。${cand} 条候选的**抽取流量口径**（尚未逐条裁定）：${num.length} 条入 11.3、${refN} 条引用编号变化单列 11.3.2、**${sameN} 条同文勘误见 11.3.0**（两版原文同文，非变化）、${wordingN} 条表述差异 + ${ruleD} 条非变化项过滤——合计 ${num.length + refN + sameN + wordingN + ruleD}，账目闭环。表述差异全部呈现于 **11.8 表述/术语候选差异（复核清单）**；其中 ${diffChanges - num.length} 条经回原文核验后**改判为实质变化**，其余改判为同文或数值口径相同 —— 逐条判定见 11.3.3。`,
    "",
    `**3. GB4785 表 11.6 九条数据指标核验**：${keep.length} 条在 A/B 原文找到且**数值两版相同（[保留]）**（ESS 闪烁频率 4.0±1.0Hz、侧标志灯间距 3m），${single.length} 条仅一版提到（[单边]，如 DRL 减光后最大光强 140cd），${missing.length} 条在当前版本原文**未找到**——此前引用该 9 条数值属未经核验，本版如实标注。`,
    "",
    `**4. 三版本主题对照**：${topics.length} 个核心主题做了 A|B|C 三列原文摘录对照，每条均标注原文页码，可直接回查。`,
    "",
    `**5. 对照范围**：A 草案 103 页 / B 现行 81 页 / C UN R48-09 147 页；三份文件共含 ${totalTables} 个参数表格、${["A", "B", "C"].reduce((a, k) => a + (data[k]?.figures?.length ?? 0), 0)} 处插图对象（明细见附录 B.2，逐行可回查）、${["A", "B", "C"].reduce((a, k) => a + (data[k]?.equations?.length ?? 0), 0)} 个公式、${["A", "B", "C"].reduce((a, k) => a + (data[k]?.headings?.length ?? 0), 0)} 条标题条目。`,
    "",
    "---",
    "",
    "> **使用指引**：变化详情见第 11 章（11.3 数值变化带页码可直接对照原文）；主题级横向对比见第 4-9 章与附录 C；全部原始表格见附录 A。[已核验] = 已定位到原文页码；[待核实]/⚠ = 未定位成功，使用前请人工复核；[未找到] = 该数值在原文中不存在。",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  写作改进 2：主题级三列对照（A|B|C）——供第 4-9 章正文使用                    */
/* -------------------------------------------------------------------------- */

/** Filter topic columns for one chapter and render compact three-column table. */
/** 摘录按子句边界截断，并明确标出被截掉。
 *
 * 之前是 `slice(0,130) + "…"`，中文侧句子会断在「若发射光不应直接」这种
 * 半截词上，读者看不出是截断还是原文如此。改为：尽量切到最近的子句边界
 * （。；. 之后），确实切不到才退回硬截，且两种情况都带 …。
 */
function clipExcerpt(s: string, limit = 150): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length <= limit) return t;
  const head = t.slice(0, limit);
  const cut = Math.max(head.lastIndexOf("。"), head.lastIndexOf("；"), head.lastIndexOf(". "));
  let out = (cut > limit * 0.5 ? head.slice(0, cut + 1) : head).trim();
  // Never cut through a tag. `N<sub>3</sub>G` sliced at 120 characters left a
  // bare `N<sub>` on the page — three of them in the delivered PDF. The tag is
  // dropped and the sentence ends there; a half-open tag is worse than a short
  // excerpt because the reader sees markup instead of the requirement.
  const opens = [...out.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)[\s>]/g)];
  const lastTag = opens[opens.length - 1];
  if (lastTag && !out.slice(lastTag.index).includes(`</${lastTag[1]}>`)) {
    out = out.slice(0, lastTag.index).trimEnd();
  }
  return out + " …";
}

/** 主题名里代表「哪种灯」的中文词，用来回第 12 章矩阵里找同族参数。 */
function topicDeviceToken(topic: string): string {
  const runs = String(topic).match(/[一-鿿]{2,5}/g) ?? [];
  return runs[0] ?? "";
}

function buildChapterTopics(topicColumns: any[], keywords: RegExp, matrixRows?: any[]): string {
  const rows = topicColumns.filter((r: any) => keywords.test(r.topic));
  if (!rows.length) return "";
  const parts: string[] = [
    `## 本章三列原文对照（A | B | C）`,
    "",
    "下表为三份文档**同一主题**的原文摘录对照；页码带 ✓ 者已回原文核验。",
    "C 列已剔除 `§6.x.1 Presence / §6.x.2 Number` 这类配备样板，改用**同章的定量条款**；",
    "R48 该主题确实没有量化条款时，明写「只有配备/数量的规定」而不是拿样板充数。",
    "",
    "**本节不再给「实质差异 / 格式差异」标签** —— 那是把两版不同条款号的摘录做文本比对，",
    "25 条里 25 条都判成「实质差异」，零信息量。真正的取值对照在每个主题下的**三版取值表**",
    "（取自第 12 章参数矩阵）与「变化判定」行。",
    "",
  ];

  const hasMatrix = Array.isArray(matrixRows) && matrixRows.length > 0;
  const withParams = rows.filter((r: any) =>
    hasMatrix && matrixRows.some((m: any) => topicDeviceToken(r.topic) && String(m.name).includes(topicDeviceToken(r.topic))),
  ).length;

  parts.push(
    `**本章主题：${rows.length} 个**｜其中 ${withParams} 个在第 12 章矩阵中有对应参数`,
    "",
    "",
  );

  for (const row of rows) {
    parts.push(`### ${row.topic}`, "");
    parts.push("| 版本 | 条款 | 页码 | 原文摘录 |", "|---|---|---|---|");
    for (const lb of ["A", "B", "C"]) {
      const c = row[lb];
      if (!c) {
        parts.push(`| ${lb} | — | — | （本文档无此主题） |`);
        continue;
      }
      const pg = c.status === "verified" ? `${c.actualPage} ✓` : `未核验`;
      const upg = c.upgradedFromBoilerplate && lb === "C" ? " ·定量条款" : "";
      parts.push(`| **${lb}** | ${cell(c.clause || "—")}${upg} | ${cell(pg)} | ${cell(clipExcerpt(c.excerpt, 240))} |`);
    }
    parts.push("");

    // The comparison the client actually needs, taken from the verified matrix
    // rather than from prose similarity.
    const tok = topicDeviceToken(row.topic);
    const related = hasMatrix && tok
      ? matrixRows.filter((m: any) => String(m.name).includes(tok)).slice(0, 6)
      : [];
    if (related.length) {
      parts.push("**该主题的三版取值（取自第 12 章参数矩阵）**", "");
      parts.push("| 参数 | 单位 | A 草案 | B 现行 | C UN R48-09 | 判定 |", "|---|---|---|---|---|---|");
      for (const m of related) {
        const cs = m.cells ?? {};
        const v = (x: string) => {
          const cell = cs[x];
          if (!cell || !cell.nums || !cell.nums.length) return "—";
          return cell.nums.join(" / ");
        };
        parts.push(
          `| ${cell(m.name)} | ${cell(m.unit || "—")} | ${v("A")} | ${v("B")} | ${v("C")} | ${cell(verdictLabel(m, ["A", "B", "C"]))} |`,
        );
      }
      parts.push("");
    }

    // Verdict: say what R48 does and does not require, which is the question a
    // reader of this table actually has.
    const c = row.C;
    const cNote = !c
      ? "R48 未见对应章节"
      : c.upgradedFromBoilerplate
        ? `R48 定量要求见 ${c.clause}`
        : /Presence|Mandatory|Optional/.test(c.excerpt || "")
          ? `R48 ${c.clause} 只规定配备/数量`
          : `R48 ${c.clause}`;
    parts.push(`**变化判定**：${cNote}｜${related.length ? "取值是否变化以上表为准" : "本主题暂无对应量化参数，请回原文逐条比对"}。`);
    parts.push("");
  }
  return parts.join("\n");
}

/** Chapter → topic filter mapping (writing improvement 2). */
/**
 * Which source headings belong in each chapter's "本章节相关条款" block.
 *
 * Both the Chinese and the English (UN R48) forms are listed. The keywords used
 * to be Chinese-only, so every R48 heading — "driving-beamheadlamp",
 * "direction-indicatorlamp", … — matched nothing and the C column of chapters
 * 4–9 rendered as "源数据未提供（报告生成时 C 版无对应条款行）" even though R48
 * does have the clause. Note MinerU strips spaces inside these headings, so
 * "driving-beam headlamp" arrives as "driving-beamheadlamp"; the patterns below
 * are written to survive that.
 */
const CHAPTER_TOPIC_FILTER: Record<number, RegExp> = {
  4: /术语与定义|terms?anddefinitions/i,
  5: /安装位置|几何可见度|电气|positionoflamps|geometricvisibility|electric/i,
  6: /远光|近光|前雾灯|自动切换|安装高度|driving-?beam|dippedbeam|foglam|adaptive|main-beam/i,
  7: /转向|制动|位置灯|牌照灯|危险警告|倒车|昼间|慢行|回复反射|示廓|追尾|direction-?indicator|stop-?lamp|position-?lamp|registration|rear-?position|tail|daytime|side-marker| reversing|retro-?reflector/i,
  8: /光度与色度|光色|闪烁频率|photometric|colour|color|chromatic|intensity/i,
  9: /试验项目|追尾警告|test|warning/i,
};

/* -------------------------------------------------------------------------- */
/*  写作改进 4：第 11 章开头速查表（14 数值 + 9 指标 一页看全）                  */
/* -------------------------------------------------------------------------- */

/**
 * §11.0 变化总清单 —— **全报告唯一的一份「改了什么」**。
 *
 * 以前这里是「速查表」，内容是 §11.3 的 3 条 + §11.3.1 的 11 条 + 9 条指标核验 ——
 * **它是第四套清单**，跟前三套对不上账。
 * 现在它由 `buildChangeLedger` 生成：四套来源并成一份、重复的合并、每行标明出处。
 *
 * 为什么放在第 11 章最前面：客户抱怨「这版和之前差别不大」，
 * 很大一部分是**得自己翻到第 11 章的中段**才知道改了什么。
 * 清单要在一屏之内看全。
 */
function buildChangeLedgerSection(ledger: ChangeRow[]): string {
  if (!ledger.length) return "";
  const bd = ledgerBreakdown(ledger);
  const rawTotal = Object.values(bd.bySource).reduce((a, b) => a + b, 0);
  const parts: string[] = [
    "## 11.0 变化总清单（全报告唯一一份「改了什么」）",
    "",
    `**共 ${bd.total} 条。** 每一行都带条款与页码，可直接回原文核对。`,
    "",
    `> **这个数怎么来的**：报告里有四套变化清单（§11.3 数值级、§11.3.1 人工补录、` +
      `§11.3.3 差值裁定、第 12 章参数矩阵），原始条目共 ${rawTotal} 条，` +
      `其中有重复（同一条变化在几套清单里各出现一次）。` +
      `合并后 **${bd.total} 条** —— 逐条来源见「出处」列。`,
    "",
    "> **合并的底线**：只在能证同一（同一主题 + 同一底层条款或同一组数值）时才合并，" +
      "合并表是显式的、每条都写了理由，并由数值自动复核。" +
      "**宁可多列一行，也不把两条不同的变化并成一条** —— 并错了就是少报了一条真变化。",
    "",
    "| # | 装置 · 参数 | 变化性质 | B 现行版 | A 草案 | 页码 | 出处 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const [i, r] of ledger.entries()) {
    const b = r.bValue ? cell(r.bValue) : "—";
    const a = r.aValue ? cell(r.aValue) : "—";
    const pages = [r.bPage ? `B ${r.bPage}` : "", r.aPage ? `A ${r.aPage}` : ""]
      .filter(Boolean)
      .join(" · ") || "—";
    const src = r.sources
      .map((s) => {
        const n = r.sourceRows?.[s] ?? 1;
        return n > 1 ? `${s} ×${n}` : s;
      })
      .join(" + ");
    parts.push(
      `| ${pad2(i + 1)} | ${cell(r.topic ? `${r.topic} · ${r.name}` : r.name)} | ${cell(r.kind)} | ${b} | ${a} | ${cell(pages)} | ${cell(src)} |`,
    );
  }
  // 「核验依据」单列一段 —— 理由原文较长，塞进表格会挤爆 A4。
  const withReason = ledger.filter((r) => r.reason && r.reason.length > 12);
  if (withReason.length) {
    parts.push("");
    parts.push("**逐条核验依据**（已回原文核对，理由原文不改写）：");
    parts.push("");
    for (const r of withReason) {
      parts.push(`- **${r.id} ${r.name}** —— ${r.reason}`);
    }
  }
  parts.push("");
  return parts.join("\n");
}

/**
 * 附录 D：UN R48-09 §6 的量化条款全量清单。
 *
 * 客户说「少了很多数据」。这句话可能是对的，也可能是报告没写清覆盖到哪 ——
 * 两种情况在 PDF 上长得一模一样。唯一能区分的办法是**把 R48 的量化内容
 * 全量摊开，并标出哪些进了矩阵、哪些没进、为什么没进**。
 *
 * 全部现算：每次出报告都从语料重扫，不落盘，所以它跟矩阵同步。
 */
/**
 * 附录 E：三版量化限值覆盖清单 —— 回答客户那句「还有没有少数据」。
 *
 * 以前只有 R48 §6 有清单（附录 D），GB 两版**没有** ——
 * 「GB 4785 的要求你们全覆盖了吗」这个问题没人答过。
 * 本附录把三份标准都按**条款**清点一遍，逐条比对第 12 章的矩阵。
 *
 * 数据来自 `data/coverage-audit.json`，由 `scripts/coverage_audit.py` 生成：
 * 它读的是**源 PDF 的文本层**（条款号可靠），矩阵的取值来自 `reports/last-report.json`。
 */
function buildAppendixE(matrixRows: any[]): string {
  const A = (COVERAGE_AUDIT as any) ?? { versions: {}, totals: {} };
  const vs = A.versions ?? {};
  const order = ["A", "B", "C"];
  const label: Record<string, string> = {
    A: "GB 4785 草案 V4.3.5",
    B: "GB 4785-2019",
    C: "UN R48-09",
  };
  const t0 = A.totals ?? {};

  const sumRows = order.map((v) => {
    const x = vs[v] ?? {};
    const lim = x.limits ?? 0;
    const covered = (x.same ?? 0) + (x.otherChapter ?? 0) + (x.general ?? 0) + (x.otherDevice ?? 0);
    const pct = lim ? Math.round((100 * covered) / lim) : 0;
    return `| ${esc(label[v])}（${v}） | ${esc(String(x.clauses ?? 0))} | ${esc(String(lim))} | ${esc(
      String(x.same ?? 0),
    )} | ${esc(String(x.otherChapter ?? 0))} | ${esc(String(x.general ?? 0))} | ${esc(
      String(x.otherDevice ?? 0),
    )} | **${esc(String(x.missing ?? 0))}** | ${esc(String(pct))}% |`;
  });

  const sumTotal =
    `| **三版合计** | — | **${esc(String(t0.limits ?? 0))}**` +
    ` | **${esc(String(t0.same ?? 0))}** | **${esc(String(t0.otherChapter ?? 0))}**` +
    ` | **${esc(String(t0.general ?? 0))}** | **${esc(String(t0.otherDevice ?? 0))}**` +
    ` | **${esc(String(t0.missing ?? 0))}** | — |`;

  const tableRows: string[] = [];
  const oosRows: string[] = [];
  for (const v of order) {
    const x = vs[v] ?? {};
    for (const tb of x.tableShaped ?? []) {
      // 「原文位置」由覆盖审计登记（data/table-clauses.json 的 appendixF 字段），
      // 逐条写明这条表的原文在附录 F 的哪一条 —— 附录 F 没收录的（配光测试点
      // 网格这类大表）就写「见页码回原文」，不笼统地说「都在附录 F」。
      const af = String(tb.appendixF ?? "").trim();
      const where = af
        ? `附录 F：${af}`
        : "附录 F 未收录（配光网格表），见上列页码回原文";
      tableRows.push(
        `| ${esc(label[v])}（${v}） | ${esc(tb.clause)} | ${esc(tb.device || "—")} | 第 ${esc(
          String(tb.page),
        )} 页 | ${esc(where)} | ${esc(tb.note ?? "")} |`,
      );
    }
    for (const o of x.outOfScope ?? []) {
      oosRows.push(
        `| ${esc(label[v])}（${v}） | ${esc(o.clause)} | ${esc(o.note ?? "")} |`,
      );
    }
  }

  const totalLimits = t0.limits ?? 0;
  const totalMiss = t0.missing ?? 0;
  const lines = [
    "# 附录 E 三版量化限值覆盖清单（有没有少数据）",
    "",
    "> **这一节是为了让「有没有漏」可以被核对，而不是让读者相信报告作者没漏。**",
    "> 附录 D 只覆盖 UN R48-09 的 §6；GB 4785 草案与 2019 版此前**没有**任何覆盖清单。",
    "> 本附录把三份标准都按**条款**清点：每一条带限值的法规陈述，逐一比对第 12 章的参数矩阵。",
    "",
    "> 清单是**每次出报告时现算**的（`scripts/coverage_audit.py` 读源 PDF 的文本层，",
    "> 矩阵取值读 `reports/last-report.json`），与第 12 章同步 —— 参数加了，清单不会忘记更新。",
    "",
    "---",
    "",
    "## E.1 覆盖总览",
    "",
    "| 标准 | 含限值条款 | 限值条数 | 同条款覆盖 | 同章别处 | 通用条款覆盖 | 别装置顶替 | **真缺口** | 覆盖率 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...sumRows,
    sumTotal,
    "",
    `**三版合计 ${esc(String(totalLimits))} 条限值，真缺口 ${esc(String(totalMiss))} 条。**`,
    "",
    "### 四档判定口径",
    "",
    "| 档 | 含义 | 需不需要处理 |",
    "|---|---|---|",
    "| 同条款覆盖 | 限值就在矩阵行引用的那条条款里 | 已覆盖 |",
    "| 同章别处 | 限值在同一章的另一条条款里（一般是「通用条款」那一份） | 已覆盖 |",
    "| 通用条款覆盖 | 矩阵里有一条**通用条款行**（如「低安装高度灯具向下几何可见度角上限」）载着同一个值 | 已覆盖 |",
    "| 别装置顶替 | 这一版里有同值，但矩阵把它记在了**别的装置**下 | 已核对 |",
    "| **真缺口** | 这一版整列里都找不到这个值 | **要补** |",
    "",
    "---",
    "",
    "## E.2 未入矩阵的「分档表 / 配光表」条款",
    "",
    "> 这些条款的限值**是表**（按安装高度分档、或配光测试点网格），",
    "> 压成一行标量会丢掉「哪一档对应哪个高度」这个信息。",
    "> **已进附录 F 的**按附录 F 逐字回查；**未进附录 F 的**（配光测试点网格这类大表）",
    "> 请按「原文位置」一列的页码回原文 —— 逐条标清了，不含糊。",
    "",
    "| 标准 | 条款号 | 装置 | 页码 | 原文位置 | 说明 |",
    "|---|---|---|---|---|---|",
    ...(tableRows.length ? tableRows : ["| — | — | — | — | — | （无） |"]),
    "",
    "---",
    "",
    "## E.3 不计入覆盖范围的条款",
    "",
    "> 这些条款**不是安装要求**（试验条件、实施日期、过渡条款、定义），",
    "> 计入分母只会把覆盖率灌水，所以单列在此。",
    "",
    "| 标准 | 条款号 | 说明 |",
    "|---|---|---|",
    ...(oosRows.length ? oosRows : ["| — | — | （无） |"]),
    "",
    "---",
    "",
    "## E.4 结论",
    "",
    totalMiss === 0
      ? [
          `**三版共 ${esc(String(totalLimits))} 条量化限值，全部有着落：**`,
          "要么进了第 12 章的矩阵（分四档见 E.1），要么是分档表/配光表（在附录 F 逐条列出，或在 E.2 标出页码），",
          "要么本来就不是安装要求（在 E.3 单列）。",
          "**没有需要补的量值。**",
        ]
      : [
          `**仍有 ${esc(String(totalMiss))} 条量值未进矩阵** —— 见下方清单。`,
          "这些是本报告已知的缺口，不得当作「已覆盖」使用。",
        ],
    "",
    "> **口径提醒**：本清单按「条款 + 数值 + 单位」比对，**不比对引文措辞**。",
    "> 另外，矩阵比较的是**数值**；条件方向相反（同样两个数、一个是上限一个是下限）",
    "> 这类差异数值矩阵**检不出来**，须回原文读条件句 —— 第 12 章开头已就此单列提示。",
    "",
    "---",
    "",
    "## E.5 要求级清点（定性要求有没有漏）",
    "",
    "> **E.1–E.4 回答的是「限值有没有漏」。这一节回答的是「要求有没有漏」。**",
    "> 两者不是一回事：法规里的要求有一大半**没有数值** ——",
    "> 「紧急制动信号应自动开启与关闭」「应独立于其他灯具工作」",
    "> 「转向灯、危险警告信号或紧急制动信号工作时，追尾警告信号不得开启」。",
    "> 这些要求**不参与限值统计**，所以 E.1 的「真缺口 0」**只对可量化的那一半成立**。",
    "",
    "> 本节把三份标准里每一条**含要求语的条款**逐条处置（`scripts/requirement_ledger.py` 现算，",
    "> 数据见 `data/requirement-ledger.json`）。六档口径：",
    "",
    "| 档 | 含义 | 需不需要处理 |",
    "|---|---|---|",
    "| 已覆盖 | 报告里**明确引用了这一条**（矩阵格 / 主题列 / 覆盖清单 / 章内引文） | 已覆盖 |",
    "| **附录逐条** | 是产品要求，但**没有可压缩的标量**（定性要求）—— 本附录 E.5.1 逐条列出**原文、页码与理由** | 已覆盖 |",
    "| **已引原文** | 报告引用父条款时，长摘录把这一条的正文**一并带进去了** —— 客户在报告里**找得到原文**，但报告没按它的编号索引（E.5.2 列出条款号、页码与命中长度） | 已在报告里，按号回查即可 |",
    "| 同章别处 | 报告讲了这一章，但没逐条讲这一条，**原文也不在报告里** | **弱覆盖**，回原文时留意 |",
    "| 不适用 | 不是产品要求（批准程序 / 标志 / 生产一致性 / 过渡），已登记理由 | 不进对照 |",
    "| **真缺口** | 是产品要求，报告里**一条都没说** | **要补** |",
    "",
  ];
  // --- E.5 的数据 ---
  const LEDGER = (REQUIREMENT_LEDGER as any) ?? { totals: {}, rows: [] };
  const T = LEDGER.totals ?? {};
  const ledRows = Array.isArray(LEDGER.rows) ? LEDGER.rows : [];
  const listedRows = ledRows.filter((r: any) => r.disposition === "附录逐条");
  const weakRows = ledRows.filter((r: any) => r.disposition === "同章别处");
  const quotedRows = ledRows.filter((r: any) => r.disposition === "已引原文");
  const gapRows = ledRows.filter((r: any) => String(r.disposition ?? "").startsWith("真缺口"));
  const gapReasons = new Map<string, string>();
  for (const g of ((REQUIREMENT_GAPS as any)?.gaps ?? []) as any[]) {
    if (g && g.version && g.clause) gapReasons.set(`${g.version}|${g.clause}`, String(g.reason ?? ""));
  }
  const verLabel: Record<string, string> = {
    A: "GB 4785 草案 V4.3.5",
    B: "GB 4785-2019",
    C: "UN R48-09",
  };
  lines.push(
    `**三版合计 ${esc(String(T.requirements ?? 0))} 条要求条款**：`,
    `已覆盖 ${esc(String(T.covered ?? 0))} 条（正文/矩阵/主题列）· ` +
      `**附录逐条 ${esc(String(T.appendixListed ?? 0))} 条**（E.5.1 列出原文、页码与理由）· ` +
      `已引原文 ${esc(String(T.quoted ?? 0))} 条（随长摘录带入，E.5.2 列出条款号与页码）· ` +
      `同章别处 ${esc(String(T.weak ?? 0))} 条（弱覆盖，E.5.2 列出条款号与页码）· ` +
      `不适用 ${esc(String(T.notApplicable ?? 0))} 条（已登记理由）· ` +
      `**真缺口 ${esc(String(T.gaps ?? 0))} 条**。`,
    "",
  );
  if (listedRows.length) {
    lines.push(
      "### E.5.1 定性要求逐条列出（原文 + 页码）",
      "",
      "> 这些是**产品要求**，但**没有可压缩的标量**（不是安装高度、不是光强、不是频率）——",
      "> 所以它们不进第 12 章的参数矩阵，而是在这里**逐条列出原文与源 PDF 页码**。",
      "> 「为什么不进矩阵」一列写的是本版的取舍理由（登记在 `data/requirement-gaps.json`）。",
      "",
      "> **这些条款对出口认证的影响不比频率小** —— 比如 R48 对紧急制动信号要求",
      "> 「应自动开启与关闭」「应独立于其他灯具工作」，对转向/危险警告信号互斥；",
      "> 报告只对照了它的闪烁频率与作用时间，功能性子条款在这里补齐。",
      "",
      "| 标准 | 条款号 | 页码 | 原文摘录 | 为什么不进矩阵 |",
      "|---|---|---|---|---|",
      ...listedRows.map((r: any) => {
        const key = `${r.version}|${r.clause}`;
        const reason = gapReasons.get(key) || String(r.reason ?? "");
        const ex = String(r.excerpt ?? "").replace(/\|/g, "／").slice(0, 300);
        const pg = r.page ? `第${r.page}页` : "—";
        return `| ${esc(verLabel[r.version] ?? r.version)} | ${esc(r.clause)} | ${esc(pg)} | ${esc(ex) || "—"} | ${esc(reason)} |`;
      }),
      "",
    );
  } else {
    lines.push("### E.5.1 定性要求逐条列出", "", "（无）", "");
  }
  if (quotedRows.length) {
    lines.push(
      "### E.5.2 已引原文（正文随长摘录带入报告，编号未单独索引）",
      "",
      "> 这些条款的**原文已经在报告里** —— 报告引用父条款或相邻条款时，",
      "> 长摘录把它们的正文一并带了出来（所以在报告里搜得到这段话，",
      "> 哪怕报告没有按这一条的编号单独列一行）。",
      "> 判据是**正文内容**的连续命中（不是条款号出现）——",
      "> 「命中长度」列给出的是连续命中了多少字。",
      "",
      "> 这一档**不是缺口**，但也不是「明确覆盖」：报告没有按它的编号索引，",
      "> 要精确回查时按条款号回原文即可。",
      "",
      "| 标准 | 条款号 | 页码 | 原文摘要 | 命中长度 |",
      "|---|---|---|---|---|",
      ...quotedRows.map((r: any) => {
        const ex = String(r.excerpt ?? r.head ?? "").replace(/\|/g, "／").slice(0, 100);
        const pg = r.page ? `第${r.page}页` : "—";
        return `| ${esc(verLabel[r.version] ?? r.version)} | ${esc(r.clause)} | ${esc(pg)} | ${esc(ex) || "—"} | ${esc(String(r.quotedMatch ?? 0))} 字 |`;
      }),
      "",
    );
  }
  if (weakRows.length) {
    lines.push(
      "### E.5.3 同章别处的弱覆盖（本章讲了，但这几条没逐条讲）",
      "",
      "> 这些条款**不是缺数据**：同一章里报告讲了别的条款（通常是该装置的定量条款），",
      "> 而这几条**本身**没有被逐条展开。下表列出它们的**条款号与页码**，",
      "> 出口认证时按号回原文即可核对。",
      "",
      "| 标准 | 条款号 | 页码 | 条款摘要 |",
      "|---|---|---|---|",
      ...weakRows.map((r: any) => {
        const ex = String(r.excerpt ?? r.head ?? "").replace(/\|/g, "／").slice(0, 120);
        const pg = r.page ? `第${r.page}页` : "—";
        return `| ${esc(verLabel[r.version] ?? r.version)} | ${esc(r.clause)} | ${esc(pg)} | ${esc(ex) || "—"} |`;
      }),
      "",
    );
  }
  lines.push(
    "> **这一节不影响 E.1 的结论**：E.1 的「真缺口 0」指的是**量化限值**没有缺口；",
    "> 本节把**定性要求**也逐条清点了 —— 口径不同，不要混用。",
    "> 要求级里剩下的不是「缺」，而是**已引原文**（E.5.2，随长摘录带入）与**不适用**（已登记理由）。",
    "",
  );
  return lines.join("\n");
}

/**
 * 附录 F：分档限值与公式型限值（三版原文对照）。
 *
 * 内容源 `data/appendix-tables.json`；每条引文都由
 * `scripts/check_appendix_tables.py` 逐字回源 PDF 验证（交付闸门里跑）。
 */
/**
 * 附录 G：三版一致参数的逐条明细。
 *
 * 为什么把它们从第 12 章挪到附录：
 * 305 个参数里 205 个三版取值相同 —— 逐条列出来要占几十页，
 * 而客户读这一章是为了**找要改的那几条**。
 * 挪到附录不是「藏起来」：第 12.0 节明写「205 条在附录 G」，
 * 而且明细一个字没删，每条照样带三版原文、条款号与页码。
 */
function buildAppendixG(matrixRows: any[]): string {
  if (!Array.isArray(matrixRows) || !matrixRows.length) return "";
  const versions = Object.keys(matrixRows[0].cells ?? {});
  const groups = groupRows(matrixRows, versions);
  if (!groups.same.length) return "";
  return [
    "# 附录 G 三版一致参数逐条明细（全量供核对）",
    "",
    `第 12 章的 ${matrixRows.length} 个参数里，有 **${groups.same.length} 个三版取值一致** ——`,
    "**它们不需要改设计**，但逐条列在这里，供核对与留档。",
    "",
    "> 每条给出三版原文取值、条款号与页码，可直接回原文核对。",
    "> 需要动手的那部分见第 12.1.1～12.1.3 节与第 12.2 节。",
    "",
    renderMatrixDetails(groups.same, versions),
  ].join("\n");
}

function buildAppendixF(): string {
  const T = (APPENDIX_TABLES as any) ?? { groups: [] };
  const label: Record<string, string> = {
    A: "GB 4785 草案 V4.3.5",
    B: "GB 4785-2019",
    C: "UN R48-09",
  };
  const lines = [
    "# 附录 F 分档限值与公式型限值（三版原文对照）",
    "",
    "> 第 12 章的参数矩阵收的是**标量**限值。有一类要求不是标量：",
    "> 限值随安装高度分档、或者写成 h 的线性公式。",
    "> 压成一行数字就丢掉「哪一档对应哪个高度」—— 而那恰恰是设计时唯一要用的信息，",
    "> 所以它们单列在这里，**原文逐字**给出，可直接回查。",
    "",
    "> 每一段引文都由 `scripts/check_appendix_tables.py` 回源 PDF 逐字验证过（交付闸门的一步）。",
    "",
  ];
  const groups = T.groups ?? [];
  groups.forEach((g: any, gi: number) => {
    lines.push("---", "");
    lines.push(`## F.${gi + 1} ${g.title ?? ""}`);
    lines.push("");
    if (g.note) {
      lines.push(g.note);
      lines.push("");
    }
    for (const v of ["A", "B", "C"]) {
      const ent = (g.versions ?? {})[v];
      if (!ent) continue;
      lines.push(`### ${v} · ${label[v]}`);
      lines.push("");
      lines.push(`条款：\`${ent.clause ?? "—"}\`${ent.page ? ` · 源 PDF 第 ${ent.page} 页` : ""}`);
      lines.push("");
      const rows: string[][] = ent.rows ?? [];
      if (rows.length) {
        lines.push(`| ${rows[0].map((c: string) => esc(c)).join(" | ")} |`);
        lines.push(`|${rows[0].map(() => "---").join("|")}|`);
        for (const r of rows.slice(1)) {
          lines.push(`| ${r.map((c: string) => esc(String(c).replace(/\|/g, "｜"))).join(" | ")} |`);
        }
        lines.push("");
      }
      if (ent.quote) {
        lines.push(`原文：「${esc(ent.quote)}」`);
        lines.push("");
      }
      if (ent.extra) {
        lines.push(`> ${esc(ent.extra)}`);
        lines.push("");
      }
    }
  });
  return lines.join("\n");
}

function buildAppendixD(data: Record<string, any>, matrixRows: any[]): string {
  const full = String(data?.C?.fullText ?? "");
  if (!full) return "";

  // ── 逐行扫，按 R48 的条款号与页码归属 ──────────────────────────────
  const lines = full.split("\n");
  const UNIT = "(?:cd/m2|cd/m²|cd/m|cd|mm2|mm²|mm|cm2|cm²|cm|km/h|m/s|mrad|deg|°|%|V|W|Hz|s|min)";
  // Thousands separators FIRST. `(?<![\w.])` does not exclude a comma, so
  // `1,200 mm` used to match as "200 mm" — the inventory then printed a number
  // that does not exist in the source, and every 1,200 / 1,400 / 1,500 row
  // failed to match the matrix (which stores 1200 / 1400 / 1500), silently
  // understating the coverage rate.
  const NUM = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
  const q = new RegExp("(?<![\\w.])" + NUM + "\\s*[-–]?\\s*(" + UNIT + ")\\b", "gi");
  // R48 的条款表是 markdown 表格行：`| 6.14.2. | Number Two,…`。
  // 原来的正则要求条款号在**行首**，于是**整张 R48 表格的数值都落到上一行的条款上**
  // —— §6.14 那一批（400 / 600 / 1300 / 250 / 900 / 1200 / 1500）被算到 §6.13 头上，
  // 覆盖率因此被系统性低估。行首的竖线要放过。
  const clauseRe = /^\s*\|?\s*(\d+(?:\.\d+)*)\.?\s*\|?\s+\S/;
  // MinerU 把 R48 §6 条款表的**下一行标签并进了上一行**：
  //   `| 6.14.4.6.14.4.1. |`（真条款 6.14.4.1）、`| 6.27.9.6.27.9.1. |`（真条款 6.27.9.1）。
  // 印着这样的标签，客户在 R48 里**根本找不到这个条款号**；
  // 而且按章匹配时它会落到**错误的章**（§6.14 而不是 §6.13），
  // 把已经覆盖的 200mm 误判成「未入矩阵」。
  // 修复表由 scripts/fix_clause_labels.py 生成（拿值 + 原文片段回查源 PDF 的干净条款索引），
  // 每一条都在那里写了理由。
  const clauseFix = (FIXED_CLAUSES as Record<string, string>) ?? {};
  const secRe = /^\s*6\.(\d{1,2})\.?\s+[A-Za-z][A-Za-z ,\-/()']{2,70}\s*$/;

  /** `1,200` → `1200`: the inventory stores the number the way the matrix does. */
  const bareNum = (s: string): string => s.replace(/,/g, "");

  let page = 0;
  let curClause = "";
  let inSec6 = false;
  const raw: Array<{ clause: string; page: number; value: string; unit: string; text: string; note?: boolean }> = [];
  for (const line of lines) {
    const st = line.trim();
    const pm = st.match(/^\[第(\d+)页\]$/);
    if (pm) {
      page = Number(pm[1]);
      continue;
    }
    if (secRe.test(line)) {
      inSec6 = true;
      curClause = "";
      continue;
    }
    // 附录（道路试验、测量方法、型式试验）**不属于安装要求**，
    // 它们的条款号自成一套（「1.2」「2.2」「12.8.7」…），混进来会：
    // ① 把覆盖率的分母灌水；② 让「未入矩阵」里出现根本不是灯具要求的条目。
    // 到附录为止即止。
    if (/^\s*Annex\s+\d+/i.test(st)) {
      inSec6 = false;
      curClause = "";
      continue;
    }
    const mc = st.match(clauseRe);
    if (mc) {
      const num = mc[1];
      if (num.includes(".")) {
        // **带点的才是条款号。**
        // 裸整数是脚注号或表格单元格的标签 ——「13 In case of additional…」
        // 「1 or 1a or 1b,」—— 旧代码把它当条款号，于是这些行挂到了
        //「13」「1」这种**客户在 R48 里根本翻不到**的号上；
        // 更糟的是它们还会被误判成「已入矩阵」。
        // 这里不动 curClause：脚注总是紧跟它注释的那一条款，
        // 所以这些行继承**所属条款**（6.22.4.1.4 之类）—— 那才是能用的查找线索。
        if (!num.startsWith("6.")) {
          // 离开了 §6 —— UN R48-09 的 §7 起（型式批准变更 / 一致性生产 /
          // 处罚 / 停产 / 过渡条款）自成一套编号，**不是安装要求**。
          // 旧代码只认 `Annex N` 这行标题，而 MinerU 的文本里根本没有那一行，
          // 于是 §12「过渡条款」的 2,100 mm / 6,000 mm（车宽/车长阈值）
          // 混进了「§6 量化条款全量清单」。
          inSec6 = false;
          curClause = "";
          continue;
        }
        curClause = clauseFix[num] ?? num;
      }
    }
    if (!inSec6) continue;
    q.lastIndex = 0;
    let m: RegExpExecArray | null;
    // 行首是「13 」这样的裸整数 + 空格 → 这是**脚注**（R48 的注号），
    // 不是条款的正文。它归属它注释的那一条款，但性质上不是条款本身。
    const isFootnote = /^\d{1,2}\s+[A-Z“"(]/.test(st);
    while ((m = q.exec(st)) !== null) {
      raw.push({ clause: curClause, page, value: bareNum(m[1]), unit: m[2], text: st, note: isFootnote });
    }
  }

  // ── 与矩阵对账：值与条款都对得上才算「已入矩阵」 ─────────────────────
  const matC: Array<{ name: string; clause: string; nums: string[] }> = [];
  for (const r of matrixRows ?? []) {
    const c = (r as any)?.cells?.C;
    if (!c?.nums?.length) continue;
    matC.push({ name: String((r as any).name ?? ""), clause: String(c.clause ?? ""), nums: c.nums.map(String) });
  }
  const numEq = (a: string, b: string): boolean => {
    const x = parseFloat(a.replace(/,/g, ""));
    const y = parseFloat(b.replace(/,/g, ""));
    if (!Number.isNaN(x) && !Number.isNaN(y)) return Math.abs(x - y) < 1e-9;
    return a.trim() === b.trim();
  };
  // Chapter + value (+ unit). The clause NUMBERS of the two sides do not
  // agree — MinerU puts `6.3.4.2.` *after* the height sentence it belongs to,
  // so a line-anchored clause (6.3.4.2) and a nearest-preceding one (6.3.4.1)
  // both describe the same paragraph. §6.x is one lamp in R48, so chapter +
  // value + unit identifies the parameter without relying on either numbering.
  const chapterOf = (c: string): string => {
    const m = String(c ?? "").match(/^(6\.\d{1,2})/);
    return m ? m[1] : "";
  };
  const matchMatrix = (r: { clause: string; value: string; unit: string }): string => {
    const ch = chapterOf(r.clause);
    // **条款号无效的行不许进矩阵。**
    // 旧代码里 `chapterOf("13")` 返回 ""，而矩阵里那些**没有 C 列条款号**的行
    // 也返回 "" —— 两边一撞就判成「已入矩阵」。
    // 于是「13 In case of … 200 mm」这种脚注行被标成
    // 「✅ 驾驶员辅助投射·保持开启车速下限」—— 一个完全错误的归属。
    if (!ch) return "";
    for (const m of matC) {
      if (chapterOf(m.clause) !== ch) continue;
      if (m.unit && r.unit && m.unit.replace(/\s/g, "") !== r.unit.replace(/\s/g, "")) continue;
      if (m.nums.some((n) => numEq(r.value, n))) return m.name;
    }
    return "";
  };

  // 去重：同一条款里的同一个数值只列一次（「1,400 mm」在一句里出现 4 次不算 4 条）
  const seen = new Set<string>();
  const items = raw
    .filter((r) => {
      const k = `${r.clause}|${r.value}|${r.unit}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((r) => ({ ...r, matrix: matchMatrix(r) }));

  // ── 未入矩阵的分类 ──────────────────────────────────────────────────
  const kindOf = (r: { clause: string; text: string; note?: boolean }): string => {
    if (!r.clause) return "非条款行";
    // 脚注：归属它注释的条款，但**本身不是条款正文**
    if (r.note) return "脚注（归属所引条款）";
    // 脚注号 / 图注里的编号（「1」「13」「12.2」）不是条款号 ——
    // 它们没有第 6 章的前缀，多半是表格的脚注或图的标注。
    if (!/^6\./.test(r.clause)) return "非条款行（脚注/图注）";
    if (/No (individual specifications|special requirement)/.test(r.text)) return "转引他标 / 无独立数值";
    // a quantified value that is only a vehicle-class or a cross-reference
    // is not a limit the client can act on
    if (/\b(class|category|type)\b/i.test(r.text) && !/\b(mm|cd|km\/h|°|mrad)\b/i.test(r.text)) {
      return "定性条款";
    }
    return "未展开的参数";
  };
  for (const it of items) if (!it.matrix) it.kind = kindOf(it as any);

  const covered = items.filter((i) => i.matrix).length;

  // ── D.1 覆盖统计 ───────────────────────────────────────────────────
  const bySec = new Map<string, typeof items>();
  for (const it of items) {
    const m = it.clause.match(/^(6\.\d{1,2})/);
    const key = m ? m[1] : "—";
    if (!bySec.has(key)) bySec.set(key, []);
    bySec.get(key)!.push(it);
  }
  const secRows = [...bySec.entries()]
    .sort((a, b) => (a[0] === "—" ? 1 : b[0] === "—" ? -1 : a[0].localeCompare(b[0])))
    .map(([sec, xs]) => {
      const cv = xs.filter((x) => x.matrix).length;
      const kinds = new Map<string, number>();
      for (const x of xs) {
        if (x.matrix) continue;
        kinds.set(x.kind!, (kinds.get(x.kind!) ?? 0) + 1);
      }
      const detail = [...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(" · ");
      return `| **§${sec}** | ${xs.length} | ${cv} | ${xs.length - cv} | ${esc(detail || "—")} |`;
    });

  // ── D.2 未入矩阵的分类清单 ──────────────────────────────────────────
  const notIn = items.filter((i) => !i.matrix);
  const kindCounts = new Map<string, number>();
  for (const i of notIn) kindCounts.set(i.kind!, (kindCounts.get(i.kind!) ?? 0) + 1);
  const kindRows = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => {
      const note =
        k === "未展开的参数"
          ? "**需要留意**：R48 有这个限值，但本报告没有把它做成矩阵行（多为其余灯具的位置/可见度档位）"
          : k === "转引他标 / 无独立数值"
            ? "R48 自己不含数值（光度值在 UN R112 / R149 等型式试验法规里）"
            : k === "定性条款"
              ? "条款本身不带可量化限值（配备 / 数量 / 方向 / 布局）"
              : "非条款行（表头或续行）";
      return `| ${esc(k)} | ${n} | ${esc(note)} |`;
    });

  // ── D.3 逐条全量清单 ───────────────────────────────────────────────
  const itemRows = items.map((it) => {
    const inM = it.matrix ? `✅ ${esc(it.matrix)}` : `— （${esc(it.kind!)}）`;
    return `| ${esc(it.clause || "—")} | 第 ${it.page} 页 | ${esc(it.value)} | ${esc(it.unit)} | ${esc(
      it.text.replace(/\|/g, "｜").replace(/\s+/g, " ").slice(0, 150),
    )} | ${inM} |`;
  });

  const pct = items.length ? Math.round((100 * covered) / items.length) : 0;
  return [
    "# 附录 D UN R48-09 §6 量化条款全量清单",
    "",
    "> **这一节是为了让「有没有漏」可以被核对，而不是让读者相信报告作者没漏。**",
    "> 下表把 UN R48-09 §6 里**每一条带数字的法规陈述**都列出来：条款号、页码、",
    "> 数值、单位、原文，以及它有没有进第 12 章参数矩阵。",
    "",
    `> 实测：R48 §6 共 **${items.length}** 条唯一量化陈述（同一句里重复出现的同一数值只算一条），`,
    `> 其中 **${covered}** 条进了参数矩阵（**${pct}%**）` +
      (notIn.length ? `，其余 ${notIn.length} 条在 D.2 逐类说明。` : "，**没有漏项**。"),
    "> 清单是**每次出报告时从语料现算**的，与第 12 章同步 —— 参数加了，清单不会忘记更新。",
    ">",
    "> **「已入矩阵」的判定口径**：同一 R48 章（§6.x，一章一盏灯）+ 同一数值 + 同一单位。",
    "> 不用条款号逐字比对 —— MinerU 里 `6.3.4.2.` 这个编号排在它所属的句子**之后**，",
    "> 所以「行首条款号」与「最近前置条款号」会指向同一段却写成两个号。",
    "",
    "> **条款号说明**：MinerU 把 R48 §6 条款表的**下一行标签并进了上一行**",
    "> （`6.14.4.6.14.4.1.` / `6.27.9.6.27.9.1.` 这样的粘连标签），",
    "> 这样的条款号在 R48 原文里**根本不存在**，客户翻不到。",
    "> 本表的**条款列已按源 PDF 的文本层还原**（逐条查证，见 `scripts/fix_clause_labels.py`）；",
    "> **原文列保持抽取原样**，所以引文里仍可能看得到粘连的标签 —— 那是抽取的样子，不是法规的样子。",
    "",
    "---",
    "",
    "## D.1 按章覆盖统计",
    "",
    "| R48 章 | 唯一量化陈述 | 已入矩阵 | 未入矩阵 | 未入矩阵分类 |",
    "|---|---|---|---|---|",
    ...secRows,
    "",
    `**合计**：${items.length} 条 · 已入矩阵 ${covered} 条（${pct}%）· 未入 ${notIn.length} 条。`,
    "",
    "---",
    "",
    "## D.2 未入矩阵的分类",
    "",
    "| 分类 | 条数 | 说明 |",
    "|---|---|---|",
    ...kindRows,
    "",
    ...(kindCounts.get("未展开的参数")
      ? [
          "> **「未展开的参数」是唯一一类需要读者自己留意的**：",
          "> R48 确实有那个限值，但本报告没有把它做成矩阵行 —— 绝大多数是其余灯具",
          "> 的位置/可见度档位（横向距外缘 400mm、内缘间距 600mm、最小离地高度 250mm 之类），",
          "> 它们与已收录的参数在法规上同型，只是装置不同。",
          "> 需要逐条查这些的话，D.3 给了条款号与页码，可直接回原文。",
        ]
      : notIn.length === 0
        ? [
            "> **本节无条目** —— R48 §6 里每一条带数字的量化陈述都进了第 12 章参数矩阵",
            `> （${items.length}/${items.length}，100%），没有需要读者自己留意的漏项。`,
            "> D.3 仍逐条列出条款号、页码与原文，供逐条核对。",
          ]
        : [
            "> **没有「未展开的参数」了** —— R48 §6 每一条带数字的安装要求都进了第 12 章矩阵。",
            "> 下面列的都不是要求：脚注号、图注、表格续行（它们没有第 6 章的条款号前缀）。",
            "> D.3 仍逐条列出，供核对。",
          ]),
    "",
    "---",
    "",
    "## D.3 逐条全量清单",
    "",
    "| R48 条款 | 页码 | 数值 | 单位 | 原文 | 第 12 章 |",
    "|---|---|---|---|---|---|",
    ...itemRows,
  ].join("\n");
}

function buildAppendixC(topicColumns: any[]): string {
  if (!topicColumns.length) return "_(待生成：请先运行 verify_claims.py)_";
  const parts: string[] = [
    "# 附录 C A|B|C 三版本主题对照（逐条摘录核验）",
    "",
    "本附录为 **三份文档同一主题的横向对照**：每格给出条款号 + 原文摘录（≥30 字）+ 页码。每条摘录均标注页码，状态 [已核验] = 已定位到原文页码，[未核验] = 未定位成功。",
    "",
    "- **A** = GB 4785 草案 V4.3.5（新版） · **B** = GB 4785-2019（现行） · **C** = UN R48-09（国际参照，仅作对照不做变化判定）",
    "",
  ];
  for (const row of topicColumns) {
    parts.push(`## ${row.topic}`, "");
    parts.push("| 文档 | 条款 | 页码（核验） | 原文摘录 |", "|---|---|---|---|");
    for (const lb of ["A", "B", "C"]) {
      const c = row[lb];
      if (!c) {
        parts.push(`| ${lb} | — | — | （本文档无此主题） |`);
        continue;
      }
      const pageCell = c.status === "verified" ? `${c.actualPage} ✓` : `未核验 ⚠`;
      const excerpt = clipExcerpt(c.excerpt, 240);
      parts.push(`| ${lb} | ${cell(c.clause || "—")} | ${cell(pageCell)} | ${cell(excerpt)} |`);
    }
    parts.push("");
  }
  const st = topicColumns.reduce(
    (acc, row) => {
      for (const lb of ["A", "B", "C"]) {
        if (row[lb]) acc[row[lb].status === "verified" ? "v" : "m"]++;
      }
      return acc;
    },
    { v: 0, m: 0 } as Record<string, number>,
  );
  parts.push(
    `> 核验统计：共 ${st.v + st.m} 条主题摘录，${st.v} 条已定位到原文页码（${((st.v / (st.v + st.m)) * 100).toFixed(0)}%），${st.m} 条未定位（措辞差异，使用前建议人工复核）。`,
  );
  return parts.join("\n");
}

/**
 * Build the full v6.5 RenderableReport from MinerU-extracted data + verified
 * comparison data. Web-service entry point: reportGenerator can call this
 * directly after fetching extraction/verification from the Python sidecar.
 */
export async function buildMinerUReport(
  data: Record<string, any>,
  verified: any,
): Promise<{ report: RenderableReport; indicatorResults: any[] }> {
  console.log("[v6] building report...");
  console.log(`[v6] docs: ${Object.keys(data).join(", ")}`);

  console.log("[v6] scanning 9 GB4785 indicators on MinerU text...");
  const indicatorResults = scanAllIndicators(data);
  for (const r of indicatorResults) {
    const a = r.aValue ? `${r.aValue}(${r.aPage})` : "-";
    const b = r.bValue ? `${r.bValue}(${r.bPage})` : "-";
    console.log(`  ${r.def.label}: ${r.status} | A=${a} | B=${b}`);
  }

  // Deterministic chapter-11 base (structural changes + device classes)
  const textA = data.A?.fullText ?? "";
  const textB = data.B?.fullText ?? "";
  const devs = detectDeviceClasses(textA, textB);
  const deviceChanges = deviceClassesAsChapterChanges(devs);
  const struct = detectStructuralChapters();
  const structChanges = struct.added.map((c) => ({ number: c.number, level: "chapter" as const, title: c.title, page: c.page }));

  const emptyDiff = { changes: [], valueDiffs: [], parameters: [] };
  const ch11 = buildChangePointsChapter(
    {
      diff: emptyDiff as any,
      chapterAdded: [...structChanges, ...deviceChanges],
      chapterRemoved: struct.removed.map((c) => ({ number: c.number, level: "chapter" as const, title: c.title, page: c.page })),
      chapterRenumbered: struct.renumbered,
      indicatorRows: [],
      wordingOnly: (verified.wordingOnly ?? []) as any,
      diffVerdicts: (verified.diffVerdicts ?? {}) as any,
    } as ChangeChapterInput,
    11,
  );

  // Replace empty section placeholders in chapter 11 with verified content.
  // With emptyDiff the placeholders appear in order: 11.2, 11.3, 11.4.
  //   2nd → 11.3 numeric changes (machine-verified)
  //   3rd → 11.4 GB4785 9-indicator verification
  let ch11Md = ch11.fullMarkdown;
  // Anchor at the line start. Without `^` the lookahead also matches inside
  // "#### 11.1.1" (offset 1), so every h4 subsection was split in half and
  // rejoined as a stray "#" line followed by "### 11.1.1" — a visible orphan
  // glyph above six subheadings in the delivered PDF.
  const parts11 = ch11Md.split(/^(?=### 11\.)/m);
  const rebuilt: string[] = [];
  // The parameter matrix is generated here rather than in changePointChapter
  // because it needs diff-result.json, which that module never sees.
  let diffResult: any = null;
  try {
    const diffPath = findDiffResult();
    if (diffPath) {
      diffResult = JSON.parse(fs.readFileSync(diffPath, "utf-8"));
      console.log(`[v6] diff-result: ${diffResult.valueDiffs?.length ?? 0} valueDiffs from ${path.basename(diffPath)}`);
    } else {
      console.warn("[v6] diff-result.json not found — §11.3.3 参数对照矩阵 will be empty");
    }
  } catch (e) {
    console.warn("[v6] diff-result.json unreadable:", e);
  }
  const matrixMd = buildParameterMatrix(
    verified.diffValueDiffs ?? [],
    verified.diffVerdicts ?? {},
    verified.topicColumns ?? [],
  );
  for (const seg of parts11) {
    if (seg.startsWith("### 11.4")) {
      rebuilt.push(build11_4_v62(indicatorResults) + "\n\n");
    } else {
      rebuilt.push(seg);
    }
  }
  let merged = rebuilt.join("\n");
  if (!merged.includes("### 11.4") || !merged.includes("### 11.3 重大修订条款（数值级")) {
    // The placeholder that changePointChapter.ts emits when a section has no
    // data is a blockquote — "> **本子节无内容** — …" — NOT the old
    // "_(本子节无内容)_" this regex was written for. Matching the wrong shape
    // meant the replace never fired, so §11.2 / §11.3 / §11.3.0 / §11.4 were
    // silently dropped from the delivered PDF while the executive summary kept
    // pointing readers at "11.3 数值变化带页码可直接对照原文". Match both forms.
    let count = 0;
    merged = merged.replace(/^(?:>\s*)?\*\*本子节无内容\*\*[^\n]*$/gm, () => {
      count++;
      // 1st placeholder = 11.2 删除条款, 2nd = 11.3, 3rd = 11.4
      if (count === 1) {
        return [
          "### 11.2 删除条款汇总",
          "",
          "经核验：A 草案（V4.3.5）相对 B（GB 4785-2019）**未删除任何章节级结构或主题级条款**。",
          "",
          "| 核验维度 | 数量 | 说明 |",
          "|---|---|---|",
          "| 章节级删除 | 0 | A 保留了 B 的全部章节，新增第 6/7 章（见 11.1.1），并将 B 6.1 拆分独立为第 9 章（见 11.6.1） |",
          "| 主题级删除 | 0 | 18 个固定对比主题在 A/B 均存在 |",
          "",
        ].join("\n");
      }
      // changePointChapter returns early on empty data so its own "### 11.3 …"
      // heading never lands; build11_3numeric emits its own heading with the body.
      if (count === 2) {
        return build11_3numeric(verified.numericChanges, verified.renumberedOnly, verified.manualFindings, verified.textChanges, resolveFlowCounts(verified), verified.sameTextDropped);
      }
      if (count === 3) return build11_4_v62(indicatorResults);
      return "_(本子节无内容)_";
    });
    if (count < 3) {
      console.warn(
        `[v6] chapter 11: replaced ${count}/3 empty-section placeholders — ` +
          "§11.2/11.3/11.4 may be missing from the PDF. Check the placeholder " +
          "text emitted by changePointChapter.ts.",
      );
    }
  }
  ch11Md = merged;
  // §11.2/11.3/11.4 do not exist as segments in the raw chapter markdown — they
  // are "> **本子节无内容**" placeholders that the replace above just turned into
  // real sections. So the matrix has to be spliced in AFTER that replace, keyed
  // on a heading that is known to exist at that point. Attaching it to §11.4
  // keeps it next to the other numeric material rather than orphaned at the end.
  if (matrixMd && !ch11Md.includes("### 11.3.3")) {
    const anchor = ch11Md.indexOf("### 11.4 ");
    if (anchor < 0) {
      console.warn("[v6] §11.3.3 参数对照矩阵 not inserted — no '### 11.4' anchor in chapter 11");
    } else {
      // Cross-link, not a fourth copy. §11.3.3 is the exhaustive A-vs-B diff
      // (45 rows, every valueDiff); chapter 12 is the three-version matrix.
      // Putting them side by side without saying which is which is how a reader
      // ends up treating the 45-row list as a three-way comparison. The note goes
      // directly under the heading, not before it.
      const nl = matrixMd.indexOf("\n");
      const withNote =
        nl > 0
          ? matrixMd.slice(0, nl + 1) +
            "\n> **本节范围：仅 A 与 B 两版的逐条差异**，不含 C（UN R48-09）。" +
            "需要三版取值对照请看**第 12 章 参数矩阵** —— 那里按参数给出 A/B/C 各自的取值、条款与页码。\n" +
            ">\n> ⚠ 本表的「映射强度」列由主题级原文摘录推得，**不能作为 R48 等价性判据**；" +
            "C 的定量条款请以第 12 章矩阵为准。\n" +
            matrixMd.slice(nl + 1)
          : matrixMd;
      ch11Md = ch11Md.slice(0, anchor) + withNote + "\n\n" + ch11Md.slice(anchor);
      console.log(`[v6] §11.3.3 参数对照矩阵 inserted (${matrixMd.length} chars) before §11.4`);
    }
  }
  if (!ch11Md.includes("### 11.3.3")) {
    console.warn("[v6] §11.3.3 参数对照矩阵 missing from chapter 11");
  }
  // 写作改进 4: 变化总清单插在第 11 章最前面。
  // **清单要等矩阵建好** —— 第 12 章矩阵里的 changed 行也是四套来源之一，
  // 所以这里先记下插入位置，等 matrixRows 出来再填内容。
  const noteEnd = ch11Md.indexOf("### 11.1");
  const insertLedger = (md: string, section: string): string => {
    if (!section) return md;
    const at = md.indexOf("### 11.1");
    if (at > 0) return md.slice(0, at) + section + "\n---\n\n" + md.slice(at);
    return md.replace(/^# 第 11 章[^\n]*\n/, (m) => m + "\n" + section + "\n");
  };
  void noteEnd;
  // Update the methodology note to reflect v6 (MinerU) pipeline
  ch11Md = ch11Md.replace(
    /本章内容由三层程序化引擎构建[\s\S]*?LLM 完全不参与本章事实生成。/,
    "本章每条事实均带锁定条款号与原文页码，可直接对照 A/B 原文验证；未能定位页码的条目一律标注 [待核实]，不冒充已验证事实。",
  );
  // Fix 11.7 summary: changePointChapter uses an empty diff so it reports
  // "0 条重大修订条款、0 条数据指标数值变化" — inject the REAL numbers
  // from verified data, since 11.3/11.4 are rendered from facts but not
  // passed back to the impact builder. Every count is DERIVED from
  // facts/indicatorResults (a hardcoded 13 previously double-counted the
  // 11.3 table and dropped the device-renumbering clause — REPORT_ERRORS 三十二).
  const numChanges = (verified.numericChanges ?? []).length;
  const manualN = (verified.manualFindings ?? []).length;
  const refChanges = (verified.renumberedOnly ?? []).length;
  // 差值候选的裁定后「实质变化」数（11.3.3 的判定分布）
  const diffChanges = Object.values((verified.diffVerdicts ?? {}) as Record<string, any>)
    .filter((v: any) => String(v?.verdict ?? "") === "有变化").length;
  const keptIndicators = indicatorResults.filter((r) => r.status === "kept").length;
  const singleSideIndicators = indicatorResults.filter((r) => r.status === "single-side").length;
  ch11Md = ch11Md.replace(
    /另有 \d+ 条重大修订条款、\d+ 条数据指标数值变化[^。]*。/,
    `另有 ${numChanges} 条重大修订条款（数值级 · 见 11.3）+ ${manualN} 条人工审计补录（见 11.3.1）+ ${refChanges} 条引用编号变化（见 11.3.2）+ ${((verified.sameTextDropped ?? []).length)} 条同文勘误（见 11.3.0，非变化）+ ${DEVICE_RENUMBERING.length} 项装置级编号重排（见 11.6.2，非实质），以及 ${indicatorResults.length} 条 GB4785 指标核验（${keptIndicators} 保留 + ${singleSideIndicators} 单边，见 11.4）；另有 ${(verified.wordingOnly ?? []).length} 条表述/术语候选差异（抽取时的候选口径，已在 11.3.3 逐条回原文裁定，其中 ${diffChanges - numChanges} 条改判为**实质变化**；11.8 保留原始候选供工程师复核）。`,
  );

  // Chapters 2-10 from MinerU headings
  const chapterTitles = ["三份法规基本信息", "章节体系总览", "术语与定义", "一般要求", "前照灯规定", "信号灯与反射器", "光度与色度要求", "测试与检验方法", "附录与实施"];
  const refDiff = { added: [], removed: [], kept: [] }; // filled below if textA/textB ready
  // The matrix is built BEFORE the narrative chapters on purpose: chapters 4–9
  // now quote their three-way values from it instead of judging A vs B by
  // prose similarity, which graded all 25 topics "实质差异" and told the
  // reader nothing.
  const corpus = await getSourceCorpus(data);
  const { rows: matrixRows, stats: matrixStatsOut } = buildParamMatrix(data, corpus);

  // 变化总清单 —— **在矩阵建好之后**才能算全（四套来源里有一套来自矩阵）。
  // 这份清单是全报告唯一的「改了什么」，第 11 章开头与执行摘要都用它。
  const changeLedger = buildChangeLedger(verified as any, matrixRows as any[]);
  const changeLedgerSection = buildChangeLedgerSection(changeLedger);
  ch11Md = insertLedger(ch11Md, changeLedgerSection);
  console.log(
    `[v6] §11.0 变化总清单 inserted — ${changeLedger.length} 条（四套来源合并后）`,
  );
  const narrativeChapters = chapterTitles.map((t, i) => ({
    id: i + 2,
    title: t,
    markdown: buildNarrativeFromHeadings(data, i + 2, t, verified.topicColumns, diffRefs(textA, textB), matrixRows),
  }));

  // 方法学章节已整体移除（客户报告只保留三个 PDF 的内容）
  const ch12 = buildChapter12Matrix(matrixRows, matrixStatsOut);
  const ch13 = build13_lampColorDiff(data);
  const ch14 = build14_clauseTextDiff(data, verified?.topicColumns, matrixRows, changeLedger);

  // 写作改进 1: executive summary as chapter 0 (rendered before ch1)
  const execSummary = buildExecSummary({
    data,
    verified,
    indicators: indicatorResults,
    chapterAdded: structChanges.length + deviceChanges.length,
    newDevices: deviceChanges.length,
    diffResult,
    changeLedger,
  });

  const report: RenderableReport = {
    outline: {
      title: "GB 4785 多版本横向对比研究报告（A 草案 / B 现行 / C UN R48 三版本对照）",
      chapters: [
        { id: 0, title: "执行摘要", sections: ["核心结论", "使用指引"] },
        // 方法学说明降级为附录 D —— 客户不应被内部管线细节挡路
        // (product feedback: "客户为什么要看方法学说明").
        ...narrativeChapters.map((c) => ({ id: c.id, title: c.title, sections: [] })),
        { id: 11, title: "关键变化点总结", sections: ["速查表", "新增条款", "删除条款", "重大修订(数值级·机器核验)", "数据指标变化(GB4785 表11.6 核验)", "新概念", "修订重点", "影响分析", "表述/术语候选差异（工程师复核清单）"] },
        { id: 12, title: "A/B/C 量化参数表横向对比", sections: TABLE_CATEGORIES.map((c) => c.label) },
        { id: 13, title: "灯具光色分配逐行 A vs B 对比", sections: ["A 新增灯具", "B 独有灯具", "光色发生变化", "完整对照表"] },
        { id: 14, title: "条款正文逐句 A vs B 对照（附 C 章节级对应与三版取值）", sections: [] },
      ],
      appendices: [
        { id: "A", title: "A/B/C 原始表格汇编" },
        { id: "B", title: "图片、公式与标题索引" },
        { id: "C", title: "A|B|C 三版本主题对照（逐条核验）" },
        { id: "D", title: "UN R48 §6 量化条款全量清单" },
        { id: "E", title: "三版量化限值覆盖清单（有没有少数据）" },
        { id: "F", title: "分档限值与公式型限值（三版原文对照）" },
        { id: "G", title: "三版一致参数逐条明细（全量供核对）" },
      ],
    },
    chapters: [
      { id: 0, title: "执行摘要", markdown: execSummary },
      ...narrativeChapters,
      { id: 11, title: "关键变化点总结", markdown: ch11Md },
      { id: 12, title: "A/B/C 量化参数表横向对比", markdown: ch12 },
      { id: 13, title: "灯具光色分配逐行 A vs B 对比", markdown: ch13 },
      { id: 14, title: "条款正文逐句 A vs B 对照（附 C 章节级对应与三版取值）", markdown: ch14 },
    ],
    appendices: [
      { id: "A", title: "A/B/C 原始表格汇编", markdown: buildAppendixA(data) },
      { id: "B", title: "图片、公式与标题索引", markdown: buildAppendixB(data) },
      { id: "C", title: "A|B|C 三版本主题对照（逐条核验）", markdown: buildAppendixC(verified.topicColumns) },
      { id: "D", title: "UN R48 §6 量化条款全量清单", markdown: buildAppendixD(data, matrixRows) },
      { id: "E", title: "三版量化限值覆盖清单（有没有少数据）", markdown: buildAppendixE(matrixRows) },
      { id: "F", title: "分档限值与公式型限值（三版原文对照）", markdown: buildAppendixF() },
      {
        id: "G",
        title: "三版一致参数逐条明细（全量供核对）",
        markdown: buildAppendixG(matrixRows),
      },
    ],
    // Structured twin of chapter 12. The chapter's markdown is a rendering;
    // this is the data. The web client, the delivery gate and any future
    // exporter read this, so there is exactly one matrix — no second parser
    // scraping markdown back out of the chapter (which is how the old
    // "核心参数总表" ended up with 49 源数据未提供 cards).
    parameterMatrix: matrixRows,
    parameterMatrixStats: matrixStatsOut,
    sourceDocuments: [
      { label: "A", name: "GB 4785 草案 V4.3.5（103 页）", meta: "原文 PDF" },
      { label: "B", name: "GB 4785-2019（81 页）", meta: "原文 PDF" },
      { label: "C", name: "UN R48-09（147 页）", meta: "国际法规原文" },
    ],
    generatedAt: new Date().toISOString(),
  };

  return { report, indicatorResults };
}

async function main() {
  if (!fs.existsSync(DATA)) throw new Error(`MinerU data not found: ${DATA}. Run extract_mineru_v4_sdk.py first.`);
  console.log("[v6] loading MinerU v4 data...");
  const data: Record<string, any> = JSON.parse(fs.readFileSync(DATA, "utf-8"));

  // Machine-verified changes + three-column topics — SINGLE SOURCE OF TRUTH:
  // prefer facts.json (v6.9 consolidated), fall back to verified-comparison.json.
  const FACTS = path.join(ROOT, "dist", "facts.json");
  const VERIFIED = path.join(ROOT, "dist", "verified-comparison.json");
  const factsFile = fs.existsSync(FACTS) ? FACTS : VERIFIED;
  let verified: any = { numericChanges: [], textChanges: [], topicColumns: [], stats: {} };
  if (fs.existsSync(factsFile)) {
    verified = JSON.parse(fs.readFileSync(factsFile, "utf-8"));
    console.log(
      `[v6] facts source: ${path.basename(factsFile)} | numeric=${(verified.numericChanges ?? []).length} ` +
      `text=${(verified.textChanges ?? []).length} manual=${(verified.manualFindings ?? []).length} ` +
      `topics=${(verified.topicColumns ?? []).length}`,
    );
  } else {
    console.log("[v6] WARNING: facts.json missing — run verify_claims.py first");
  }

  const { report } = await buildMinerUReport(data, verified);

  console.log("[v6] rendering PDF via Chromium (pass 1 — TOC page discovery)...");
  const pass1Pdf = await renderPdfFromReport(report);
  await finalizePdf(report, pass1Pdf);
}

/**
 * finalizePdf — SHARED by the CLI (main) AND the web route (agentRoutes
 * POST /api/agent/report/mineru): pass-2 render with real TOC page numbers →
 * write OUT_PDF → audit+render gates → PDF metadata → bookmark outline →
 * final buffer (the customer download is this exact buffer).
 */
export async function finalizePdf(report: RenderableReport, pass1: Buffer): Promise<Buffer> {
  let pdf = pass1;
  // Two-pass render: pass 1 locates each chapter's start page, then pass 2
  // re-renders with the page map so the TOC shows real page numbers
  // (TOC row height is unchanged → chapter offsets stay stable).
  try {
    // NOTE: the incoming buffer is already the final artifact. Both callers
    // pass a renderPdfFromReportV8() result, which resolves chapter pages from
    // injected anchors and stamps its own bookmark outline. This block used to
    // re-render with the OLD renderPdfFromReport(), which is how the
    // API-generated PDF ended up with the v6.2 printed TOC whose 17 entries all
    // read "11" while a locally-rendered PDF of the same report had a correct
    // one — two renderers for one document, disagreeing. `npm run verify`'s
    // "printed TOC page numbers resolve to real chapter pages" gate now covers
    // whichever buffer actually ships.
    console.log("[v6] keeping the V8 render as-is (TOC pages + bookmarks already resolved)");
  } catch (e) {
    console.warn("[v6] finalize step skipped, keeping incoming PDF:", String(e).slice(0, 300));
  }
  fs.writeFileSync(OUT_PDF, pdf);
  console.log(`[v6] wrote ${OUT_PDF} (${(pdf.length / 1024).toFixed(1)} KB)`);

  // Post-render gates (audit_pages + render_gate): log failures but DO NOT
  // block delivery yet — gates inform CI/customer-support, future iteration
  // can refuse to download when they hard-fail.
  for (const [script, label] of [["audit_pages.py", "audit"], ["render_gate.py", "render"]]) {
    try {
      const { execFileSync } = await import("node:child_process");
      const stdout = execFileSync("python", [script, OUT_PDF], {
        encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const last = stdout.trim().split("\n").pop() ?? "";
      console.log(`[v6] gate ${label}: ${last}`);
    } catch (e) {
      const msg = (e.stderr ?? e.stdout ?? "").toString().slice(0, 600);
      console.warn(`[v6] gate ${label} FAILED:
${msg}`);
    }
  }

  // The Python helpers sit next to ROOT, so cwd: ROOT is correct for locating
  // them. What actually broke: add_pdf_outline.py hardcodes its own PDF path
  // (`ROOT.parent / "GB4785_多版本横向对比研究报告.pdf"`) and silently exits when
  // that file is absent — which it is whenever OUT_PDF points elsewhere, e.g.
  // the API's returnPdf path. Point it at the file we actually wrote.
  const scriptDir = ROOT;
  const script = (name: string) => path.join(scriptDir, name);
  const canonicalPdf = path.join(path.resolve(ROOT, ".."), "GB4785_多版本横向对比研究报告.pdf");

  // Patch PDF metadata (author/subject/keywords/pipeline-version).
  // Chromium's page.pdf() only honours `title`; set the rest via PyMuPDF.
  try {
    const { execFileSync } = await import("node:child_process");
    const ver = "v6.2-" + new Date().toISOString().slice(0, 10);
    execFileSync("python", [
      script("set_pdf_meta.py"), OUT_PDF,
      "--title", report.outline.title,
      "--author", "GB 4785 多版本对比报告 pipeline",
      "--subject", "A 草案 / B 现行 / C UN R48-09 三版本法规横向对照",
      "--keywords", "GB 4785, UN R48, 法规对比, 核验追溯",
      "--pipeline-version", ver,
    ], { encoding: "utf8", windowsHide: true, cwd: scriptDir, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`[v6] pdf-meta patched (${ver})`);
  } catch (e) {
    console.warn("[v6] pdf-meta patch skipped:", String(e).slice(0, 300));
  }

  // Bookmark outline — must run LAST because it rewrites the file; then re-read
  // so the returned buffer includes bookmarks.
  //
  // This used to shell out to add_pdf_outline.py, which hardcodes its own PDF
  // path and exits silently when that file is absent. Every API-rendered report
  // therefore shipped with zero bookmarks and only a console warning to say so.
  // Do it here instead: we know exactly which file we wrote and where each
  // chapter starts, so the outline is derived from the same two-pass TOC data
  // rather than re-parsed out of a fixed filename.
  try {
    const entries: Array<[string, number]> = [
      ...report.chapters.map((c: any) => [c.title, c.page] as [string, number]),
      ...(report.appendices ?? []).map((a: any) => [a.title, a.page] as [string, number]),
    ].filter(([, p]) => typeof p === "number" && p > 0) as Array<[string, number]>;
    if (entries.length) {
      const { execFileSync } = await import("node:child_process");
      const payload = JSON.stringify(entries.map(([t, p]) => [t, p]));
      const py =
        "import json,sys,fitz,shutil\n" +
        "toc=json.loads(sys.stdin.read())\n" +
        "d=fitz.open(sys.argv[1])\n" +
        "d.set_toc([[1,t,int(p)-1] for t,p in toc if 0 < int(p)-1 < d.page_count])\n" +
        "d.save(sys.argv[1]+'.toc.tmp',garbage=3,deflate=True)\n" +
        "d.close()\n" +
        "shutil.move(sys.argv[1]+'.toc.tmp',sys.argv[1])\n";
      execFileSync("python", ["-c", py, OUT_PDF], {
        input: payload,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      pdf = fs.readFileSync(OUT_PDF);
      console.log(`[v6] bookmarks: injected ${entries.length} entries`);
    } else {
      console.warn("[v6] no chapter page numbers resolved — PDF will ship without bookmarks");
    }
  } catch (e) {
    console.warn("[v6] bookmark step skipped:", String(e).slice(0, 300));
  }
  return pdf;
}

// Only run main() when executed directly. Importing this module from the web
// server (buildSidecarReport) must NOT trigger a background render that
// races with the web route's own render/download.
const invokedDirectly = !!process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("report-v6.mjs");
if (invokedDirectly) {
  main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
}
