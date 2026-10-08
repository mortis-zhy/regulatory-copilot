/**
 * Render a report directly from PyMuPDF extraction output (dist/pymupdf-data.json).
 *
 * This bypasses the LLM-extracted diff entirely. The 9 GB4785 data
 * indicators come from the deterministic indicator scan; the structural
 * data comes from the PyMuPDF table extraction.
 *
 * Usage: node dist/report-from-pymupdf.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { renderPdfFromReport, type RenderableReport } from "./htmlRender";
import { buildChangePointsChapter, type ChangeChapterInput } from "./changePointChapter";
import { detectDeviceClasses, deviceClassesAsChapterChanges } from "./deviceClassScan";
import { detectStructuralChapters } from "./chapterStructural";
import { scanIndicators, pairIndicatorHits } from "../ingestion/indicatorScan";
import { parseAllTables, extractCanonicalIndicators, pairIndicatorsById } from "../ingestion/tableParser";

const ROOT = process.env.COMPARE_AGENT_ROOT
  ? path.resolve(process.env.COMPARE_AGENT_ROOT)
  : path.resolve(import.meta.dirname, "../..");
const DATA = path.join(ROOT, "dist", "pymupdf-data.json");
const OUT_PDF = path.join(ROOT, "..", "GB4785_多版本横向对比研究报告.pdf");

function esc(s: string): string {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function main() {
  if (!fs.existsSync(DATA)) {
    throw new Error(`PyMuPDF data not found at ${DATA}. Run: python extract_pymupdf.py`);
  }
  const data: Record<string, any> = JSON.parse(fs.readFileSync(DATA, "utf-8"));
  console.log(`[report] loaded ${Object.keys(data).length} docs from PyMuPDF`);

  const textA = data.A?.fullText || "";
  const textB = data.B?.fullText || "";

  // ---- Method 1: 9 GB4785 data indicators (deterministic text scan) ----
  const hitsA = scanIndicators(textA);
  const hitsB = scanIndicators(textB);
  const indicatorRows = pairIndicatorHits(hitsA, hitsB);
  console.log(`[report] text-scan indicators: A=${hitsA.length} B=${hitsB.length} pairs=${indicatorRows.length}`);
  for (const r of indicatorRows) console.log(`  ${r.label}: ${r.oldValue}${r.unit} → ${r.newValue}${r.unit}`);

  // ---- Method 2: Canonical table indicators (deterministic table scan) ----
  const tablesA = parseAllTables(textA);
  const tablesB = parseAllTables(textB);
  const tabIndsA = extractCanonicalIndicators(tablesA);
  const tabIndsB = extractCanonicalIndicators(tablesB);
  const tabIndicatorPairs = pairIndicatorsById(tabIndsA, tabIndsB);
  // Convert to indicatorRows shape; merge with text-scan results (text wins on dup)
  const seenIds = new Set(indicatorRows.map((r) => r.label));
  for (const p of tabIndicatorPairs) {
    if (!seenIds.has(p.label)) {
      indicatorRows.push({
        id: p.id,
        label: p.label,
        unit: p.unit,
        oldValue: p.b?.value ?? "—",
        newValue: p.a?.value ?? "—",
        source: `B=${p.b?.page || "—"} → A=${p.a?.page || "—"}`,
      });
      seenIds.add(p.label);
    }
  }

  // ---- Method 3: Device classes ----
  const devs = detectDeviceClasses(textA, textB);
  const deviceChanges = deviceClassesAsChapterChanges(devs);

  // ---- Method 4: Structural chapter changes ----
  const struct = detectStructuralChapters();
  const structAsChanges = struct.added.map((c) => ({
    number: c.number,
    level: "chapter" as const,
    title: c.title,
    page: c.page,
  }));

  // Build change-points chapter with empty diff (we have no diffEngine here).
  const chapterChanges = {
    added: [...structAsChanges, ...deviceChanges],
    removed: struct.removed.map((c) => ({
      number: c.number,
      level: "chapter" as const,
      title: c.title,
      page: c.page,
    })),
    renumbered: struct.renumbered,
  };

  // Build a minimal diff result (empty — no LLM-extracted changes here)
  const emptyDiff = {
    changes: [],
    valueDiffs: [],
    parameters: [],
  };

  const ch11 = buildChangePointsChapter(
    {
      diff: emptyDiff as any,
      chapterAdded: chapterChanges.added,
      chapterRemoved: chapterChanges.removed,
      chapterRenumbered: chapterChanges.renumbered,
      indicatorRows,
    } as ChangeChapterInput,
    11,
  );

  // ---- Build appendix from PyMuPDF table data ----
  const allTables = [
    ...(data.A?.tables || []).map((t: any) => ({ ...t, doc: "A" })),
    ...(data.B?.tables || []).map((t: any) => ({ ...t, doc: "B" })),
    ...(data.C?.tables || []).map((t: any) => ({ ...t, doc: "C" })),
  ];

  // Build chapter 1 — methodology
  const ch1 = [
    "# 第 1 章 方法学说明（PyMuPDF 直接管线 v3）",
    "",
    "## 1.1 旧管线的问题",
    "",
    "前三版报告（v1/v2/v3）由 LLM 直接生成变化点总结，导致：",
    "",
    "- **页码系统错位**（每条差 1-5 页）",
    "- **原文被改写**（不是逐字引用）",
    "- **LLM 过度提取**（v3 共 364 条变更，80%+ 是噪音）",
    "- **报告页数失控**（v3 = 99 页）",
    "",
    "## 1.2 新管线（PyMuPDF 直接）",
    "",
    "本次更新采用**三路确定性提取**，完全跳过 LLM 变化点生成：",
    "",
    "1. **文本正则扫描**（indicatorScan.ts）：从 PDF 文本直接扫描 9 条核心数据指标",
    "2. **表格解析**（tableParser.ts）：从 layout tables 解析色度坐标、Vr 条件等结构化数据",
    "3. **关键词扫描**（deviceClassScan.ts）：从章节标题识别新装置类（ADB / 矩阵式 LED 等）",
    "",
    "## 1.3 数据来源",
    "",
    "- **A**：GB 4785 草案 V4.3.5（103 页，86,097 字符）",
    "- **B**：GB 4785-2019（81 页，65,313 字符）",
    "- **C**：UN R48-09（147 页，301,018 字符）",
    "",
    `## 1.4 提取统计`,
    "",
    `| 文档 | 页数 | 字符数 | 表格数 |`,
    `|---|---|---|---|`,
    `| A | ${data.A?.pageCount || 0} | ${data.A?.fullTextLength || 0} | ${data.A?.tableCount || 0} |`,
    `| B | ${data.B?.pageCount || 0} | ${data.B?.fullTextLength || 0} | ${data.B?.tableCount || 0} |`,
    `| C | ${data.C?.pageCount || 0} | ${data.C?.fullTextLength || 0} | ${data.C?.tableCount || 0} |`,
  ].join("\n");

  // ---- Build appendix A: All tables (compact Markdown) ----
  const appendixATables = allTables.slice(0, 60).map((t: any, idx: number) => {
    const rows = [t.header.join(" | "), t.header.map(() => "---").join(" | "), ...t.rows.map((r: any[]) => r.map(esc).join(" | "))].join("\n");
    return `\n### 表 ${idx + 1} (${t.doc} p${t.page}) ${t.title || "(无标题)"}\n\n${rows}\n`;
  }).join("\n");

  const appendixA = [
    "# 附录 A 三份 PDF 的所有 layout tables（PyMuPDF 提取）",
    "",
    `本附录列出 PyMuPDF 检测到的全部 layout 表格。共 ${allTables.length} 个表（受篇幅限制附录只展示前 60 个）。`,
    "",
    appendixATables,
  ].join("\n");

  // ---- Build appendix B: PyMuPDF table-data provenance ----
  const appendixB = [
    "# 附录 B 数据溯源索引",
    "",
    "本附录列出第 11 章每条变化的锚点定位，可直接对照 PDF 原文页码验证。",
    "",
    "| 序号 | 类别 | 标签 | 锚点 |",
    "|---|---|---|---|",
    indicatorRows.map((r, i) => `| ${(i + 1).toString().padStart(2, "0")} | 核心指标 | [修改] | ${r.source} |`).join("\n"),
    chapterChanges.added.map((c: any, i) => `| ${(indicatorRows.length + i + 1).toString().padStart(2, "0")} | 新增章节/子条款 | [新增] | A=${c.number}（${c.page || "—"}） |`).join("\n"),
  ].join("\n");

  const report: RenderableReport = {
    outline: {
      title: "GB 4785 多版本横向对比研究报告（PyMuPDF 直接管线 v3）",
      chapters: [
        { id: 1, title: "方法学说明", sections: ["旧管线问题", "新管线", "数据来源", "提取统计"] },
        { id: 11, title: "关键变化点总结", sections: ["新增条款", "删除条款", "重大修订", "数据指标变化", "新概念", "修订重点章节对比", "影响分析"] },
      ],
      appendices: [
        { id: "A", title: "三份 PDF 的所有 layout tables" },
        { id: "B", title: "数据溯源索引" },
      ],
    },
    chapters: [
      { id: 1, title: "方法学说明", markdown: ch1 },
      { id: 11, title: "关键变化点总结", markdown: ch11.fullMarkdown },
    ],
    appendices: [
      { id: "A", title: "三份 PDF 的所有 layout tables", markdown: appendixA },
      { id: "B", title: "数据溯源索引", markdown: appendixB },
    ],
    sourceDocuments: [
      { label: "A", name: "GB 4785 草案 V4.3.5（103 页）", meta: "2026-08-26_不带Comments的版本" },
      { label: "B", name: "GB 4785-2019（81 页）", meta: "现行国标" },
      { label: "C", name: "UN R48-09（147 页）", meta: "anchor only" },
    ],
    generatedAt: new Date().toISOString(),
  };

  console.log("[report] rendering PDF via Chromium...");
  const pdf = await renderPdfFromReport(report);
  fs.writeFileSync(OUT_PDF, pdf);
  console.log(`[report] wrote ${OUT_PDF} (${(pdf.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });