/**
 * trustChecks — TypeScript port of verify_pipeline.py (the source-independent
 * half of it).
 *
 * Scope note: verify_pipeline.py has two halves:
 *   A. Cross-checks that need the three source PDFs (page counts, voltage
 *      values, clause page numbers, units). Those stay in Python because they
 *      need PyMuPDF + the original files, which the server legitimately may
 *      not have.
 *   B. Report-internal consistency checks (dual-source anchors, false-diff
 *      truncation, renumber mapping, C-placeholder ratio). These only read
 *      last-report.json — pure string analysis, so they belong in-process.
 *
 * This module implements group B. The /api/agent/report/trust endpoint uses
 * it as the source of truth; verify_report.json, when present, is merged on
 * top so the PDF-vs-source checks still surface in the UI.
 */

import { buildLedger, ledgerToCounts } from "./closureLedger";

export type TrustCounts = {
  confirmed: number;
  /** §11.3.1 人工核验补录 —— 双源核验，但不在 18 个固定对比主题内 */
  manual: number;
  candidate: number;
  errata: number;
  renum: number;
  format: number;
};

export type TrustWarning = {
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Real markdown with newlines — never json.dumps (it escapes them to \n). */
export function reportMarkdown(chapters: Array<{ markdown?: string }>): string {
  return chapters.map((c) => c?.markdown ?? "").join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    n++;
    i = j + needle.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 5-category closure counts
//
// Entry-level, NOT string-level.
//
// The previous implementation counted how many times a tag string appeared in
// the markdown. That produced nonsense on a real report: the dashboard showed
// "4 条同文勘误" while §11.3.0 listed 9 rows, because "同文勘误" appears in a
// heading and two cross-references but the rows themselves carry no such tag.
// The same report also declares "45 条候选" in prose while the tag scan said 39.
//
// closureLedger.ts walks the actual tables instead, so every number now equals
// "how many rows does this table have".
// ---------------------------------------------------------------------------

export function extractClosureCounts(md: string): TrustCounts {
  const c = ledgerToCounts(buildLedger(md));
  return {
    confirmed: c.confirmed,
    manual: c.manual,
    candidate: c.candidate,
    errata: c.errata,
    renum: c.renum,
    format: c.format,
  };
}

// ---------------------------------------------------------------------------
// §11.3.0 同文假差异 (errata) — the table that says why a "change" isn't one
// ---------------------------------------------------------------------------

export type Erratum = {
  no: string;
  topic: string;
  bValue: string;
  aValue: string;
  reason: string;
  humanVerdict: "pending" | "confirmed" | "rejected";
  humanNote?: string;
};

export function extractErrata(md: string): Erratum[] {
  const sec =
    md.match(/####\s*11\.3\.0[^\n]*\n([\s\S]{0,6000}?)(?=\n####|\n###)/)?.[1] ??
    md.match(/11\.3\.0\s*同文勘误[^\n]*\n([\s\S]{0,6000}?)(?=\n####|\n###)/)?.[1];
  if (!sec) return [];

  const out: Erratum[] = [];
  for (const line of sec.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (/\|-{3,}\||\|\s*#\s*\|/.test(t)) continue;
    const c = t.replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
    if (c.length < 5 || !/^\d+$/.test(c[0])) continue;
    out.push({
      no: c[0],
      topic: c[1],
      bValue: c[2],
      aValue: c[3],
      reason: c[4] ?? "",
      humanVerdict: "pending",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §11.0 网传指标核验 (rumors)
// ---------------------------------------------------------------------------

export type Rumor = {
  metric: string;
  bValue: string;
  aValue: string;
  verdict: string;
  status: "两版均有出处" | "仅草案单边出现" | "仅现行单边出现" | "两版原文均无出处";
};

export function extractRumors(md: string): Rumor[] {
  const out: Rumor[] = [];
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    if (!/GB4785指标|网传|行业流传/.test(t)) continue;
    const c = t.replace(/^\||\|$/g, "").split("|").map((s) => s.trim());
    if (c.length < 5) continue;
    const metric = c[2] || c[1] || "";
    if (!metric || metric === "指标" || /^-{3,}$/.test(metric)) continue;
    const bRaw = c[3] ?? "";
    const aRaw = c[4] ?? "";
    const bFound = bRaw !== "—" && bRaw !== "";
    const aFound = aRaw !== "—" && aRaw !== "";
    out.push({
      metric,
      bValue: bRaw,
      aValue: aRaw,
      verdict: c[5] ?? "",
      status: bFound && aFound
        ? "两版均有出处"
        : aFound
          ? "仅草案单边出现"
          : bFound
            ? "仅现行单边出现"
            : "两版原文均无出处",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Check A — dual-source anchors
// ---------------------------------------------------------------------------

export function checkDualSource(md: string): TrustWarning {
  const rowA = /\|\s*\*\*\s*A\s*(?:草案|版)?\s*\*\*\s*\|/;
  const rowB = /\|\s*\*\*\s*B\s*(?:现行|版|2019)?\s*\*\*\s*\|/;
  let checked = 0;
  let ok = 0;
  let bad = 0;
  const samples: string[] = [];

  for (const m of md.matchAll(/((?:\|[^\n]*\n){3,})/g)) {
    const lines = m[1].split("\n");
    const aLine = lines.find((l) => rowA.test(l));
    const bLine = lines.find((l) => rowB.test(l));
    if (!aLine || !bLine) continue;
    const header = lines[0] + (lines[1] ?? "");
    if (!/页码/.test(header)) continue; // skip |文档|页|标题| index tables

    checked++;
    const cells = (l: string) => l.split("|").map((c) => c.trim());
    const hasPage = (cs: string[]) => cs.some((c) => /第\s*\d+\s*页|\bp\d+\b/.test(c));
    const hasClause = (cs: string[]) => cs.some((c) => /\d+\.\d+/.test(c));
    const aOk = hasPage(cells(aLine)) && hasClause(cells(aLine));
    const bOk = hasPage(cells(bLine)) && hasClause(cells(bLine));

    if (aOk && bOk) {
      ok++;
    } else {
      bad++;
      if (samples.length < 5) {
        const miss: string[] = [];
        if (!aOk) miss.push("A 行缺页码/条款号");
        if (!bOk) miss.push("B 行缺页码/条款号");
        samples.push(`${(lines[0] ?? "").replace(/^\||\|$/g, "").trim().slice(0, 40)} → ${miss.join("; ")}`);
      }
    }
  }

  if (checked === 0) {
    return { label: "双源核验 · A+B 锚点", status: "warn", detail: "未扫描到含 A/B 行的「页码 + 条款」三栏对比表" };
  }
  return {
    label: "双源核验 · A+B 锚点",
    status: bad === 0 ? "pass" : "warn",
    detail: `扫描 ${checked} 张 A/B 对比表, 双源锚点完整 ${ok}, 缺锚点 ${bad}`,
    evidence: samples.join("; ") || undefined,
  };
}

// ---------------------------------------------------------------------------
// Check B — false-diff truncation (B excerpt much shorter than A)
// ---------------------------------------------------------------------------

export function checkFalseDiff(md: string): TrustWarning {
  const rowA = /\*\*\s*A\s*(?:草案|版)?\s*\*\*/;
  const rowB = /\*\*\s*B\s*(?:现行|版|2019)?\s*\*\*/;
  const pairs: Array<{ topic: string; a: number; b: number }> = [];

  for (const m of md.matchAll(/((?:\|[^\n]*\n){3,})/g)) {
    const lines = m[1].split("\n");
    const aLine = lines.find((l) => rowA.test(l));
    const bLine = lines.find((l) => rowB.test(l));
    if (!aLine || !bLine) continue;
    const cells = (l: string) => l.split("|").map((c) => c.trim()).filter(Boolean);
    const a = cells(aLine);
    const b = cells(bLine);
    if (a.length < 4 || b.length < 4) continue;
    const aText = a.slice(3).join(" ");
    const bText = b.slice(3).join(" ");
    if (aText.length > 0 && bText.length > 0 && aText.length > bText.length * 3) {
      pairs.push({ topic: a[0].slice(0, 30), a: aText.length, b: bText.length });
    }
  }

  if (!pairs.length) {
    return { label: "假差异 · B 列截断", status: "pass", detail: "未发现 B 列截断嫌疑(长度比 ≤ 3)" };
  }
  return {
    label: "假差异 · B 列截断",
    status: "warn",
    detail: `发现 ${pairs.length} 个对比表 A/B 长度差 >3 倍`,
    evidence: pairs.slice(0, 5).map((p) => `${p.topic} A=${p.a}B=${p.b}`).join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check C — §11.6.1 renumber mapping exists
// ---------------------------------------------------------------------------

export function checkRenumber(md: string): TrustWarning {
  const sec = md.match(/11\.6\.1\s*章节级重排.{0,30}.*?(?=###)/s)?.[0];
  if (!sec) {
    return { label: "编号重排 · 11.6.1", status: "warn", detail: "未找到 11.6.1 / 章节级重排 子节标题" };
  }
  const tableRows = sec
    .split("\n")
    .filter((l) => l.trim().startsWith("|") && !/\|\s*-{3,}\s*\|/.test(l));
  const pairs = tableRows.filter((l) => {
    const nums = l.match(/\|\s*\d+(?:\.\d+)?\s*\|/g);
    return (nums?.length ?? 0) >= 2;
  });
  if (!pairs.length) {
    return { label: "编号重排 · 11.6.1", status: "warn", detail: "11.6.1 子节无 B/A 编号配对行(可能有数据遗漏)" };
  }
  return {
    label: "编号重排 · 11.6.1",
    status: "pass",
    detail: `找到 ${pairs.length} 行 B/A 编号映射, 已纳入 🔢 闭环统计`,
    evidence: sec.slice(0, 300),
  };
}

// ---------------------------------------------------------------------------
// Check D — C-version placeholder ratio
// ---------------------------------------------------------------------------

export function checkCPlaceholder(md: string): TrustWarning {
  const explicit = (md.match(/\*\*\s*C\s*(?:UN|版|草案)?[^*]*\*\*\s*\|\s*[^|]*本版未规定[^|]*/g) ?? []).length;
  const fallback = countOccurrences(md, "源数据未提供");
  const missing = Math.max(explicit, fallback);
  const slots =
    countOccurrences(md, "**C ") + countOccurrences(md, "**C UN") + countOccurrences(md, "**C 现行") + countOccurrences(md, "**C 版");

  if (slots === 0) {
    return { label: "C 版占位检测", status: "pass", detail: "未检测到 C 灰卡(C 版未参与本次对比或全有内容)" };
  }
  const pct = Math.round((missing / slots) * 100);
  if (pct >= 50) {
    return {
      label: "C 版占位检测",
      status: "warn",
      detail: `C 灰卡 ${missing}/${slots} (${pct}%),可能存在抽取失败,非纯数据问题`,
      evidence: `灰卡计数 ${missing}`,
    };
  }
  return {
    label: "C 版占位检测",
    status: "pass",
    detail: `C 灰卡 ${missing}/${slots} (${pct}%),比例合理`,
    evidence: `总 C 槽 ${slots}`,
  };
}

// ---------------------------------------------------------------------------
// Check E–H — report-integrity gates
//
// These answer a different question from A–D. A–D ask "is each entry
// trustworthy?"; E–H ask "is this document structurally whole?" The
// difference matters when the extractor or the generator fails on a new
// source PDF: without these gates a degraded report renders a confident-looking
// 100-page PDF with an empty chapter and no page anchors, and the reader has
// no way to tell.
// ---------------------------------------------------------------------------

/** E — chapters whose body is effectively empty (extraction failure). */
export function checkEmptyChapters(
  chapters: Array<{ title?: string; markdown?: string }>,
): TrustWarning {
  const thin: string[] = [];
  for (const ch of chapters) {
    const md = (ch?.markdown ?? "").replace(/\s+/g, "");
    if (md.length < 80) thin.push(`${ch?.title ?? "(untitled)"} (${md.length}字)`);
  }
  if (thin.length === 0) {
    return { label: "章节完整性 · 空章节检测", status: "pass", detail: "无空章节" };
  }
  return {
    label: "章节完整性 · 空章节检测",
    status: "fail",
    detail: `${thin.length} 个章节正文近乎为空 — 抽取或生成环节失败: ${thin.slice(0, 4).join(", ")}`,
  };
}

/** F — page-anchor coverage: can a reader actually trace a claim back? */
export function checkPageAnchors(md: string): TrustWarning {
  const real = (md.match(/第\s*\d+\s*页/g) ?? []).length;
  const vague = (md.match(/某页|未核验\s*⚠|未标注/g) ?? []).length;
  if (real === 0 && vague > 0) {
    return {
      label: "溯源 · 页码锚点",
      status: "fail",
      detail: `全报告 0 个可核验页码，却有 ${vague} 处「某页/未核验」占位 — 无法回查原文`,
    };
  }
  if (real === 0) {
    return { label: "溯源 · 页码锚点", status: "warn", detail: "未检出任何页码锚点" };
  }
  return {
    label: "溯源 · 页码锚点",
    status: "pass",
    detail: `${real} 处页码锚点`,
  };
}

/** G — three-column integrity: can we still tell A from B from C?
 *
 * Two table conventions exist in practice:
 *   vertical — | 版本 | 条款 | 页码 | 原文 | with rows `| **A 草案** | … |`
 *   horizontal — | 项目 | A（GB 4785 草案） | B（GB 4785-2019） | C（UN R48-09） |
 * The LLM picks one per run. Counting only the vertical form made a perfectly
 * good horizontal report look like "no version markers at all".
 */
export function checkVersionColumns(md: string): TrustWarning {
  const vA = countOccurrences(md, "**A 草案**") + countOccurrences(md, "**A**");
  const vB = countOccurrences(md, "**B 现行**") + countOccurrences(md, "**B**");
  const vC = countOccurrences(md, "**C UN R48-09**") + countOccurrences(md, "**C**");
  const vertical = vA + vB + vC;

  // Header row carrying all three version labels on one line. Avoid \b — it
  // behaves inconsistently before full-width brackets in JS regex. The
  // character class escapes the ASCII "(" so it isn't read as a group opener.
  const OPEN = "[（(【 ]";
  const horizontal = (
    md.match(
      new RegExp(
        "^\\|[^\\n|]*\\|[^\\n|]*A" + OPEN + "[^\\n|]*\\|[^\\n|]*B" + OPEN +
        "[^\\n|]*\\|[^\\n|]*C" + OPEN,
        "gm",
      ),
    ) ?? []
  ).length;

  if (vertical === 0 && horizontal === 0) {
    return {
      label: "三栏对照 · 版本标记",
      status: "fail",
      detail: "全报告无任何 A/B/C 版本标记 — 无法区分三版内容，对照表已失效",
    };
  }

  const missing: string[] = [];
  if (vertical > 0) {
    if (vA === 0) missing.push("A");
    if (vB === 0) missing.push("B");
    if (vC === 0) missing.push("C");
  } else {
    // Horizontal tables must carry A, B and C headers.
    for (const v of ["A", "B", "C"]) {
      if (!new RegExp(`^\\|[^\\n|]*\\|[^\\n|]*${v}[（(【 ]`, "m").test(md)) missing.push(v);
    }
  }

  if (missing.length) {
    return {
      label: "三栏对照 · 版本标记",
      status: "warn",
      detail: `缺少 ${missing.join("/")} 版标记 (纵向 ${vertical} 处 / 横向表头 ${horizontal} 张)`,
    };
  }
  const shape =
    vertical > 0 && horizontal > 0
      ? `纵向 ${vertical} 处 + 横向表头 ${horizontal} 张`
      : vertical > 0
        ? `纵向 ${vertical} 处`
        : `横向表头 ${horizontal} 张`;
  return {
    label: "三栏对照 · 版本标记",
    status: "pass",
    detail: `${shape}`,
  };
}

/** H — substance check: does the conclusions chapter carry anything? */
export function checkSubstance(md: string): TrustWarning {
  // The change-summary chapter is where verdicts live; if it's gone the whole
  // document is just source dump with no analysis.
  const verdicts = countOccurrences(md, "变化判定") + countOccurrences(md, "实质差异") + countOccurrences(md, "已核验");
  if (verdicts === 0) {
    return {
      label: "结论完整性 · 判定条目",
      status: "fail",
      detail: "未检出任何变化判定条目 — 报告只有原文转录，没有对比结论",
    };
  }
  return { label: "结论完整性 · 判定条目", status: "pass", detail: `${verdicts} 处判定条目` };
}

/** Roll several integrity checks into one gate verdict for the UI. */
export type IntegrityGate = {
  level: "ok" | "degraded" | "blocked";
  checks: TrustWarning[];
  blockers: TrustWarning[];
};

export function assessIntegrity(
  chapters: Array<{ title?: string; markdown?: string }>,
  md: string,
): IntegrityGate {
  const checks = [
    checkEmptyChapters(chapters),
    checkPageAnchors(md),
    checkVersionColumns(md),
    checkSubstance(md),
  ];
  const blockers = checks.filter((c) => c.status === "fail");
  return {
    level: blockers.length === 0 ? "ok" : blockers.length >= 2 ? "blocked" : "degraded",
    checks,
    blockers,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export type TrustBundle = {
  counts: TrustCounts;
  total: number;
  candidateShare: number;
  errata: Erratum[];
  rumors: Rumor[];
  warnings: TrustWarning[];
  integrity: IntegrityGate;
  /** Entry-level ledger — every count above traces back to rows here. */
  ledger: {
    entries: Array<{
      category: string;
      section: string;
      no: string;
      topic: string;
      reason?: string;
      pages?: string[];
    }>;
    /** 30 待复核条目逐条列出，供工程师分工核验 */
    candidateDetail: Array<{
      no: string;
      section: string;
      topic: string;
      reason: string;
      pages: string[];
    }>;
    /** 报告自述数字 vs 台账实算数字 */
    reconciliation: {
      selfReported: Record<string, number | undefined>;
      ledgerCounts: Record<string, number>;
      discrepancies: string[];
      ledgerTotal: number;
    };
  };
};

export function buildTrustBundle(
  chapters: Array<{ markdown?: string; title?: string }>,
): TrustBundle {
  const md = reportMarkdown(chapters);
  const ledger = buildLedger(md);
  const c = ledgerToCounts(ledger);
  const counts: TrustCounts = {
    confirmed: c.confirmed,
    manual: c.manual,
    candidate: c.candidate,
    errata: c.errata,
    renum: c.renum,
    format: c.format,
  };
  const total =
    counts.confirmed + counts.manual + counts.candidate +
    counts.errata + counts.renum + counts.format;
  const warnings = [
    checkDualSource(md),
    checkFalseDiff(md),
    checkRenumber(md),
    checkCPlaceholder(md),
  ];
  // Report-internal number disagreement is itself a defect the reader must see.
  if (ledger.discrepancies.length) {
    warnings.push({
      label: "账目闭环 · 统计口径",
      status: "warn",
      detail: ledger.discrepancies.join("；"),
      evidence: "台账按表格行逐条统计，报告正文按自述数字声明，两者不一致需人工裁定",
    });
  }
  const integrity = assessIntegrity(chapters, md);
  return {
    counts,
    total,
    candidateShare: total > 0 ? Math.round((counts.candidate / total) * 100) : 0,
    errata: extractErrata(md),
    rumors: extractRumors(md),
    warnings,
    integrity,
    ledger: {
      entries: ledger.entries,
      candidateDetail: ledger.entries
        .filter((e) => e.category === "candidate")
        .map((e) => ({
          no: e.no,
          section: e.section,
          topic: e.topic,
          reason: e.reason ?? "",
          pages: e.pages ?? [],
        })),
      reconciliation: {
        selfReported: ledger.selfReported,
        ledgerCounts: { ...counts, added: c.added ?? 0 },
        discrepancies: ledger.discrepancies,
        ledgerTotal: ledger.entries.length,
      },
    },
  };
}