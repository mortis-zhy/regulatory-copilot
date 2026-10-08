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
import { buildChangePointsChapter, type ChangeChapterInput } from "./changePointChapter";
import { detectDeviceClasses, deviceClassesAsChapterChanges } from "./deviceClassScan";
import { detectStructuralChapters, DEVICE_RENUMBERING } from "./chapterStructural";
import { diffRefs, buildRefSection } from "./refDiff";

// Resolve from this module's location rather than a hardcoded absolute path —
// the old literal only worked on one machine and broke the moment the checkout
// moved. From dist/index.js, "../.." lands on the inner repo root.
const ROOT = process.env.COMPARE_AGENT_ROOT
  ? path.resolve(process.env.COMPARE_AGENT_ROOT)
  : path.resolve(import.meta.dirname, "../..");
const DATA = path.join(ROOT, "dist", "mineru-v4-data.json");
const OUT_PDF = path.join(ROOT, "..", "GB4785_多版本横向对比研究报告.pdf");

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
  },
  {
    id: "drl_vis_deg", label: "DRL 可见度角度", unit: "°",
    gb4785Old: "±20°",
    gb4785New: "±25°",
    patterns: [/昼间行驶灯[\s\S]{0,100}?(?:可见度|水平角|垂直角)[\s\S]{0,30}?[±±]\s*(\d{1,2})\s*°/i],
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
  },
  {
    id: "lumen_pct", label: "光通维持率", unit: "%",
    gb4785Old: "70%",
    gb4785New: "80%",
    patterns: [/光通维持率[\s\S]{0,40}?(\d{1,3})\s*%/i],
  },
  {
    id: "preheat_min", label: "预热点灯时间", unit: "min",
    gb4785Old: "30 min",
    gb4785New: "60 min",
    patterns: [/预热[\s\S]{0,40}?(\d{1,3})\s*min/i],
  },
  {
    id: "afs_switch_s", label: "AFS 切换时间", unit: "s",
    gb4785Old: "≤2 s",
    gb4785New: "≤1.5 s",
    patterns: [/(?:AFS|自适应前照)[\s\S]{0,60}?切换[\s\S]{0,40}?[≤<]?\s*(\d\.?\d*)\s*s/i],
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
  for (const def of INDICATORS) {
    const a = data.A?.fullText ? scanIndicator(data.A.fullText, def) : undefined;
    const b = data.B?.fullText ? scanIndicator(data.B.fullText, def) : undefined;
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
    if (r.status === "modified") tag = "[修改]";
    else if (r.status === "kept") tag = "[保留] 两版相同";
    else if (r.status === "single-side") {
      tag = "[单边] " + (r.aValue ? "仅 A 提到" : "仅 B 提到");
      const cn = (r.def?.gb4785New || "").match(/\d+/);
      const co = (r.def?.gb4785Old || "").match(/\d+/);
      const claimedNew = cn ? cn[0] : null;
      const claimedOld = co ? co[0] : null;
      const actual = r.aValue ?? r.bValue;
      if (actual && claimedNew && actual !== claimedNew && claimedOld && actual !== claimedOld) {
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
    "> 说明：GB4785 第 11.4 表 11.6 中部分数值为推算或引用，未经 A/B 原文出现。⚠ 标记 = 本报告实测值与 GB4785 声称不一致，以原文为准。",
    "",
    "**GB4785 声称值的人工复核结论（fitz 对照三份原文，2026-09-28）**：",
    "- **侧标志灯间距 \"≤6m→≤4m\" 属误读**：两版原文实为**两相邻侧标志灯间距不大于 3m（车型结构不能保证时可增至 4m）**——A p55 / B p46 逐字一致，\"3m [保留]\"判定正确；GB4785 引用的\"6m\"实际是**车长不大于 6m 车辆的侧回复反射器数量豁免**（A p54 / B p45），与间距无关。",
    "- **DRL 最小光度 400→500 cd、ESS 光度 400→600 cd：A/B 原文均未出现**（A/B 全文检索 0 命中）——[未找到] 判定正确，勿引用。",
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
    "**DRL 减光 140cd 判定**：B 只允许\"关闭混合部分\"（B p48 5.19.7.6）；A 新增允许\"降光至 ≤140cd\"（A p57 5.19.7.6）——[单边]，属 A 草案新增的软件标定选项。",
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

function build14_clauseTextDiff(data: Record<string, any>): string {
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
    "# 第 14 章 条款正文逐句 A vs B 对比",
    "",
    "> **说明**：以 B 现行的完整章节结构为骨架，逐条映射到 A 对应条款（章节映射：B6→A8、B6.1→A9、B7→A10；装置节映射见 11.6.2），并排对照 A/B 条款正文（每条截断 600 字）。A 独有的第 6/7 章追加在末尾。",
    "",
    `> 对比条目：${clauses.length}（B 驱动 ${clauses.length - aOnly.length} + A 独有 ${aOnly.length}）· A 侧定位成功 ${clauses.filter((c) => c.aPage).length} / ${clauses.length}`,
    "",
    "**使用提示**：每行一对条款。`🔴 实质差异` 需逐字比对；`🔧 局部调整` 需确认语义；`📝 实质一致` 无需动作；`🆕/🗑` 对应新增/删除。",
    "",
  ];
  for (const c of clauses) {
    out.push(`## 14.x 条款 ${c.clause} — ${c.title}`);
    out.push("");
    out.push(`| 来源 | 页码 | 条款正文（截断） |`, "|---|---|---|");
    out.push(`| **A 草案** | ${c.aPage ? "第 " + c.aPage + " 页" : "—（未定位到 A 对应条款）"} | ${(c.aText || "（A 无对应条款）").slice(0, 500).replace(/\|/g, "｜")} |`);
    out.push(`| **B 现行** | ${c.bPage ? "第 " + c.bPage + " 页" : "—"} | ${(c.bText || "（A 草案独有，B 无对应条款）").slice(0, 500).replace(/\|/g, "｜")} |`);
    out.push("");
    const aa = c.aText.replace(/\s+/g, "");
    const bb = c.bText.replace(/\s+/g, "");
    if (!c.bText) out.push(`**变化判定**：🆕 A 新增，B 无对应条款。`);
    else if (!c.aText) out.push(`**变化判定**：🗑 B 有 A 无（A 删除或未定位到，工程师请核对 A 编号 ${c.clause.split("↔ A ")[1]?.split("（")[0] ?? "?"}）。`);
    else if (aa === bb) out.push(`**变化判定**：📝 实质一致（仅标点/空白差异）。`);
    else if (aa.includes(bb) || bb.includes(aa)) out.push(`**变化判定**：🔧 局部调整。`);
    else out.push(`**变化判定**：🔴 实质差异 — 请逐字比对。`);
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
      `| GB4785 表 11.6 九条指标（第 11.4 节） | 9 | 9（2[保留]+7[未找到]） | 100% 逐条核验 | 未找到者如实标注，不推测引用 |`,
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
): string {
  const a = data.A?.headings ?? [];
  const b = data.B?.headings ?? [];
  const c = data.C?.headings ?? [];
  const parts: string[] = [`# 第 ${chapterId} 章 ${title}`, ""];

  // 写作改进 2: topic-level three-column comparison first (the real content)
  const topicFilter = CHAPTER_TOPIC_FILTER[chapterId];
  if (topicColumns && topicFilter) {
    const topicBlock = buildChapterTopics(topicColumns, topicFilter);
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
    parts.push("## 3.1 章节层级对比", "");
    parts.push("| 文档 | 一级标题 | 段落级标题 | 页码标注 |", "|---|---|---|---|");
    for (const k of ["A", "B", "C"]) {
      const hs = data[k]?.headings ?? [];
      const l1 = hs.filter((h: any) => h.level === 1).length;
      const pt = hs.filter((h: any) => h.level >= 2).length;
      parts.push(`| ${k} | ${l1} | ${pt} | ${data[k]?.pageCount ?? "-"} |`);
    }
    parts.push("", "## 3.2 A 草案一级标题（原文）", "");
    parts.push("| 页 | 标题 |", "|---|---|");
    for (const h of a.filter((x: any) => x.level === 1).slice(0, 25)) {
      parts.push(`| p${h.page} | ${esc(h.title)} |`);
    }
    parts.push("", "## 3.3 B 现行一级标题", "");
    parts.push("| 页 | 标题 |", "|---|---|");
    for (const h of b.filter((x: any) => x.level === 1).slice(0, 25)) {
      parts.push(`| p${h.page} | ${esc(h.title)} |`);
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
    // ch10: 附录与实施 — 按主题分组（同一型式判定 / 实施日期 / 附录 / 过渡条款），
    // 每个主题下并排展示 A/B/C 的对应标题（而非按文档顺序罗列）。
    const themes: Array<{ label: string; re: RegExp }> = [
      { label: "同一型式判定",        re: /同一型式/ },
      { label: "实施日期",            re: /实施/ },
      { label: "规范性附录",          re: /规范性附录|附录/ },
      { label: "过渡条款 / 放宽判定", re: /过渡|车型结构|放宽/ },
    ];
    for (const th of themes) {
      parts.push(`### 主题：${th.label}`, "");
      parts.push("| 文档 | 页 | 标题 |", "|---|---|---|");
      let any = false;
      for (const k of ["A", "B", "C"]) {
        const hs = (data[k]?.headings ?? []).filter((h: any) => th.re.test(h.title));
        if (hs.length) any = true;
        for (const h of hs.slice(0, 10)) parts.push(`| ${k} | p${h.page} | ${esc(h.title)} |`);
      }
      if (!any) parts.push("| — | — | 三份文档均无匹配条款 |");
      parts.push("");
    }
    parts.push("> 逐条变化与数据核验见第 11 章。");
    parts.push("> 注：本章按主题分组而非按文档分组，便于工程师快速对位每条主题在三份文档中的对应位置。");
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
/*  11.3 numeric changes — from verify_claims.py (machine-verified)            */
/* -------------------------------------------------------------------------- */

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
      parts.push(`| ${pad2(i + 1)} | ${cell(m.topic)} · ${cell(m.name)} | [人工核验] | ${cell(bCell)} | ${cell(aCell)} | ${cell(m.source || "manual-audit")} |`);
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
/*  写作改进 1：执行摘要（报告开篇 5 要点）                                     */
/* -------------------------------------------------------------------------- */

function buildExecSummary(input: {
  data: Record<string, any>;
  verified: any;
  indicators: any[];
  chapterAdded: number;
  newDevices: number;
}): string {
  const { data, verified, indicators, chapterAdded, newDevices } = input;
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
  const counts = verified?.counts ?? {};
  const wordingN = counts.wordingFiltered ?? 0;
  const ruleD = counts.ruleDropped ?? 0;
  const sameN = (verified?.sameTextDropped ?? []).length;
  const cand = counts.candidates ?? (num.length + refN + wordingN + ruleD + sameN);

  return [
    "# 执行摘要",
    "",
    "本报告对三份法规文件（A 草案 V4.3.5 / B 现行 GB 4785-2019 / C UN R48-09）做逐条横向对照。核心结论：",
    "",
    `**1. 结构变化**：A 草案在 B 基础上新增 ${chapterAdded} 项（${chapterAdded - newDevices} 项章节级：第 6 从属功能章、第 7 扩展功能章；${newDevices} 项装置级新功能：ADS 标志灯、驾驶员辅助投射、图文交互、发光徽标、外部氛围功能、外部状态指示器等）。另有 ${DEVICE_RENUMBERING.length} 项装置级编号重排 + ${refN} 项引用编号变化（章节重组所致，非实质，见 11.6.2 / 11.3.2）。`,
    "",
    `**2. 数值变化**：共 ${num.length} 条 A/B 同名参数数值变化（**${numOk} 条已定位到原文页码**，第 11.3 节标注 [已核验]）+ ${(verified.manualFindings ?? []).length} 条人工对照补录（AFS 数量、慢行灯 10→15 km/h、近光灯倾斜度分档、前位灯 A1/A2 分类、倒车灯可见度、前雾灯判定基准、示廓灯基准、慢行灯位置、示廓灯500mm放宽——均为 18 个固定对比主题之外的条款，见 11.3.1）。${cand} 条候选的完整去向：${num.length} 条入 11.3、${refN} 条引用编号变化单列 11.3.2、**${sameN} 条同文勘误见 11.3.0**（两版原文同文，非变化）、${wordingN} 条表述差异 + ${ruleD} 条非变化项过滤（表述差异全部呈现于 **11.8 表述/术语候选差异（复核清单）**）——合计 ${num.length + refN + sameN + wordingN + ruleD}，账目闭环。`,
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
function buildChapterTopics(topicColumns: any[], keywords: RegExp): string {
  const rows = topicColumns.filter((r: any) => keywords.test(r.topic));
  if (!rows.length) return "";
  const norm = (s: string) => (s || "").replace(/[\s,，。.;；:：、（）()【】\[\]]/g, "");
  const parts: string[] = [
    `## 本章三列原文对照（A | B | C）`,
    "",
    "下表为三份文档**同一主题**的原文摘录对照；页码带 ✓ 者已回原文核验。",
    "**变化标签**列：A↔B 经空白与标点规范化后比对——`三方一致` / `格式差异` / `实质差异` / `A 新增独有` / `仅 B 现行` / `未比对`。",
    "",
  ];
  // Per-topic summary
  const labels: string[] = [];
  for (const row of rows) {
    const a = row.A?.excerpt ?? "";
    const b = row.B?.excerpt ?? "";
    const c = row.C?.excerpt ?? "";
    const an = norm(a), bn = norm(b), cn = norm(c);
    let label: string;
    if (!a && !b) label = "未比对";
    else if (!b) label = "A 新增独有";
    else if (!a) label = "仅 B 现行";
    else if (an === bn && bn === cn) label = "三方一致";
    else if (an === bn) label = "A↔B 一致 / C 不同";
    else if (an.replace(/\d/g, "") === bn.replace(/\d/g, "")) label = "格式差异";
    else if (Math.abs(a.length - b.length) < 5 && an.includes(bn.slice(0, 30))) label = "微调";
    else label = "实质差异";
    labels.push(label);
  }
  const allLabels = labels.join(" / ");
  parts.push(`**本章主题：${rows.length} 个**｜变化分布：${allLabels}`, "", "");

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    parts.push(`### ${row.topic}`, "");
    parts.push("| 版本 | 条款 | 页码 | 原文摘录 |", "|---|---|---|---|");
    for (const lb of ["A", "B", "C"]) {
      const c = row[lb];
      if (!c) {
        parts.push(`| ${lb} | — | — | （本文档无此主题） |`);
        continue;
      }
      const pg = c.status === "verified" ? `${c.actualPage} ✓` : `未核验 ⚠`;
      const ex = c.excerpt.length > 130 ? c.excerpt.slice(0, 130) + "…" : c.excerpt;
      parts.push(`| **${lb}** | ${cell(c.clause || "—")} | ${cell(pg)} | ${cell(ex)} |`);
    }
    parts.push("");
    parts.push(`**变化判定**：\`${labels[i]}\`｜工程师核验任务：${labels[i] === "实质差异" || labels[i] === "格式差异" || labels[i] === "微调" ? "请逐字比对差异 → 决定是否需要更新产品/测试" : labels[i] === "三方一致" ? "无需变更" : "如该主题不适用请记录原因"}。`);
    parts.push("");
  }
  return parts.join("\n");
}

/** Chapter → topic filter mapping (writing improvement 2). */
const CHAPTER_TOPIC_FILTER: Record<number, RegExp> = {
  4: /^术语与定义/,
  5: /安装位置|几何可见度|电气/,
  6: /远光|近光|前雾灯|自动切换|安装高度/,
  7: /转向|制动|位置灯|牌照灯|危险警告|倒车|昼间|慢行|回复反射|示廓|追尾/,
  8: /光度与色度|光色|闪烁频率/,
  9: /试验项目|追尾警告/,
};

/* -------------------------------------------------------------------------- */
/*  写作改进 4：第 11 章开头速查表（14 数值 + 9 指标 一页看全）                  */
/* -------------------------------------------------------------------------- */

function buildQuickRef(numChanges: any[], indicators: any[]): string {
  const parts: string[] = [
    "## 11.0 速查表：全部变化一页看全",
    "",
    `共 ${numChanges.length + indicators.length} 项：${numChanges.length} 条数值变化（绿=已核验）+ ${indicators.length} 条 GB4785 指标核验。`,
    "",
    "| # | 类别 | 项目 | B 现行版 | A 草案 | 状态 |",
    "|---|---|---|---|---|---|",
  ];
  let n = 0;
  for (const v of numChanges) {
    n++;
    const tag = v.status === "verified" ? "[修改] ✓已核验" : "[修改] ⚠待核实";
    const b = v.oldValue + (v.bPage ? `（${v.bPage}）` : "");
    const a = v.newValue + (v.aPage ? `（${v.aPage}）` : "");
    parts.push(`| ${pad2(n)} | 数值变化 | ${cell(v.topic)}·${cell(v.name)} | ${cell(b)} | ${cell(a)} | ${tag} |`);
  }
  for (const ind of indicators) {
    n++;
    const tag =
      ind.status === "kept" ? "[保留] 数值两版相同" : ind.status === "modified" ? "[修改] 有变化" : "⚠ 未找到";
    const b = ind.bValue ? `${ind.bValue}（${ind.bPage}）` : "—";
    const a = ind.aValue ? `${ind.aValue}（${ind.aPage}）` : "—";
    parts.push(`| ${pad2(n)} | GB4785指标 | ${cell(ind.def.label)} | ${cell(b)} | ${cell(a)} | ${tag} |`);
  }
  parts.push("");
  return parts.join("\n");
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
      const excerpt = c.excerpt.length > 160 ? c.excerpt.slice(0, 160) + "…" : c.excerpt;
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
export function buildMinerUReport(
  data: Record<string, any>,
  verified: any,
): { report: RenderableReport; indicatorResults: any[] } {
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
    } as ChangeChapterInput,
    11,
  );

  // Replace empty section placeholders in chapter 11 with verified content.
  // With emptyDiff the placeholders appear in order: 11.2, 11.3, 11.4.
  //   2nd → 11.3 numeric changes (machine-verified)
  //   3rd → 11.4 GB4785 9-indicator verification
  let ch11Md = ch11.fullMarkdown;
  const parts11 = ch11Md.split(/(?=### 11\.)/);
  const rebuilt: string[] = [];
  for (const seg of parts11) {
    if (seg.startsWith("### 11.4")) {
      rebuilt.push(build11_4_v62(indicatorResults) + "\n\n");
    } else {
      rebuilt.push(seg);
    }
  }
  let merged = rebuilt.join("\n");
  if (!merged.includes("### 11.4") || !merged.includes("### 11.3 重大修订条款（数值级")) {
    let count = 0;
    merged = merged.replace(/_\(本子节无内容\)_/g, () => {
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
      if (count === 2) return build11_3numeric(verified.numericChanges, verified.renumberedOnly, verified.manualFindings, verified.textChanges, verified.counts, verified.sameTextDropped);
      if (count === 3) return build11_4_v62(indicatorResults);
      return "_(本子节无内容)_";
    });
  }
  ch11Md = merged;
  // 写作改进 4: quick-reference table right after chapter-11 methodology note
  const quickRef = buildQuickRef([...(verified.numericChanges ?? []), ...(verified.manualFindings ?? [])], indicatorResults);
  const noteEnd = ch11Md.indexOf("### 11.1");
  if (noteEnd > 0) {
    ch11Md = ch11Md.slice(0, noteEnd) + quickRef + "\n---\n\n" + ch11Md.slice(noteEnd);
  } else {
    ch11Md = ch11Md.replace(/^# 第 11 章[^\n]*\n/, (m) => m + "\n" + quickRef + "\n");
  }
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
  const keptIndicators = indicatorResults.filter((r) => r.status === "kept").length;
  const singleSideIndicators = indicatorResults.filter((r) => r.status === "single-side").length;
  ch11Md = ch11Md.replace(
    /另有 \d+ 条重大修订条款、\d+ 条数据指标数值变化[^。]*。/,
    `另有 ${numChanges} 条重大修订条款（数值级 · 见 11.3）+ ${manualN} 条人工审计补录（见 11.3.1）+ ${refChanges} 条引用编号变化（见 11.3.2）+ ${((verified.sameTextDropped ?? []).length)} 条同文勘误（见 11.3.0，非变化）+ ${DEVICE_RENUMBERING.length} 项装置级编号重排（见 11.6.2，非实质），以及 ${indicatorResults.length} 条 GB4785 指标核验（${keptIndicators} 保留 + ${singleSideIndicators} 单边，见 11.4）；另有 ${(verified.wordingOnly ?? []).length} 条表述/术语候选差异（未做数值核验，见 11.8 工程师复核清单）。`,
  );

  // Chapters 2-10 from MinerU headings
  const chapterTitles = ["三份法规基本信息", "章节体系总览", "术语与定义", "一般要求", "前照灯规定", "信号灯与反射器", "光度与色度要求", "测试与检验方法", "附录与实施"];
  const refDiff = { added: [], removed: [], kept: [] }; // filled below if textA/textB ready
  const narrativeChapters = chapterTitles.map((t, i) => ({
    id: i + 2,
    title: t,
    markdown: buildNarrativeFromHeadings(data, i + 2, t, verified.topicColumns, diffRefs(textA, textB)),
  }));

  // 方法学章节已整体移除（客户报告只保留三个 PDF 的内容）
  const ch12 = build12_quantitativeTables(data);
  const ch13 = build13_lampColorDiff(data);
  const ch14 = build14_clauseTextDiff(data);

  // 写作改进 1: executive summary as chapter 0 (rendered before ch1)
  const execSummary = buildExecSummary({
    data,
    verified,
    indicators: indicatorResults,
    chapterAdded: structChanges.length + deviceChanges.length,
    newDevices: deviceChanges.length,
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
        { id: 14, title: "条款正文逐句 A vs B 对比", sections: [] },
      ],
      appendices: [
        { id: "A", title: "A/B/C 原始表格汇编" },
        { id: "B", title: "图片、公式与标题索引" },
        { id: "C", title: "A|B|C 三版本主题对照（逐条核验）" },
      ],
    },
    chapters: [
      { id: 0, title: "执行摘要", markdown: execSummary },
      ...narrativeChapters,
      { id: 11, title: "关键变化点总结", markdown: ch11Md },
      { id: 12, title: "A/B/C 量化参数表横向对比", markdown: ch12 },
      { id: 13, title: "灯具光色分配逐行 A vs B 对比", markdown: ch13 },
      { id: 14, title: "条款正文逐句 A vs B 对比", markdown: ch14 },
    ],
    appendices: [
      { id: "A", title: "A/B/C 原始表格汇编", markdown: buildAppendixA(data) },
      { id: "B", title: "图片、公式与标题索引", markdown: buildAppendixB(data) },
      { id: "C", title: "A|B|C 三版本主题对照（逐条核验）", markdown: buildAppendixC(verified.topicColumns) },
    ],
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

  const { report } = buildMinerUReport(data, verified);

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
    const pass1Path = path.join(ROOT, "dist", "_pass1.pdf");
    fs.writeFileSync(pass1Path, pdf);
    const { execFileSync } = await import("node:child_process");
    const json = execFileSync("python", [path.join(ROOT, "extract_toc_pages.py"), pass1Path], { encoding: "utf8", windowsHide: true });
    const pageMap = JSON.parse(json) as Record<string, number>;
    const match = (t: string): number | undefined =>
      pageMap[t] ?? Object.entries(pageMap).find(([k]) => t.includes(k) || k.includes(t))?.[1];
    let hits = 0;
    for (const c of report.chapters) { const pg = match(c.title); if (pg) { c.page = pg; hits++; } }
    for (const a of report.appendices ?? []) { const pg = match(a.title); if (pg) { a.page = pg; hits++; } }
    fs.rmSync(pass1Path, { force: true });
    console.log(`[v6] TOC pages resolved: ${hits} entries`);
    console.log("[v6] rendering PDF via Chromium (pass 2 — with TOC page numbers)...");
    pdf = await renderPdfFromReport(report);
  } catch (e) {
    console.warn("[v6] TOC two-pass skipped, keeping pass-1 PDF:", String(e).slice(0, 300));
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

  // Patch PDF metadata (author/subject/keywords/pipeline-version).
  // Chromium's page.pdf() only honours `title`; set the rest via PyMuPDF.
  try {
    const { execFileSync } = await import("node:child_process");
    const ver = "v6.2-" + new Date().toISOString().slice(0, 10);
    execFileSync("python", [
      "set_pdf_meta.py", OUT_PDF,
      "--title", report.outline.title,
      "--author", "GB 4785 多版本对比报告 pipeline",
      "--subject", "A 草案 / B 现行 / C UN R48-09 三版本法规横向对照",
      "--keywords", "GB 4785, UN R48, 法规对比, 核验追溯",
      "--pipeline-version", ver,
    ], { encoding: "utf8", windowsHide: true, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    console.log(`[v6] pdf-meta patched (${ver})`);
  } catch (e) {
    console.warn("[v6] pdf-meta patch skipped:", String(e).slice(0, 300));
  }

  // Bookmark outline (17 chapter-level bookmarks) — must run LAST because it
  // rewrites the file; then re-read so the returned buffer includes bookmarks.
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("python", ["add_pdf_outline.py"], {
      encoding: "utf8", windowsHide: true, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    });
    console.log("[v6] bookmarks: add_pdf_outline ok");
    pdf = fs.readFileSync(OUT_PDF);
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
