/**
 * closureLedger — 条目级差异台账。
 *
 * 为什么需要这个
 * --------------
 * 原先的 extractClosureCounts 用 `md.count("同文勘误")` 这类字符串出现次数
 * 当条目数。结果：同一份报告里仪表盘说「4 条勘误」，而 §11.3.0 表格里实际
 * 列了 9 条 —— 差 5 条，读者无从判断哪个是真的。
 *
 * 字符串计数在任何真实报告里都会错，因为：
 *   - 章节标题里会出现一次（"#### 11.3.0 同文勘误（9 条…）"）
 *   - 正文交叉引用会重复出现
 *   - 表格单元格里的标签可能一行多个
 *
 * 正确做法：把每类差异当作**表格行**来数，并保留行内容，让每个数字都能
 * 点开看到是哪几条。这就是本模块的 ledger。
 *
 * 同时提供 reconcile()：把台账和报告正文自述的数字对齐，不一致时显式报出，
 * 这样「39 vs 45」这类矛盾会在渲染期被拦下，而不是留给读者去发现。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerCategory =
  | "confirmed"    // ✅ 已双源核验 — 两版原文 + 页码齐备
  | "candidate"    // ⚠ 待复核 — 单源或缺页码
  | "errata"       // 🟡 同文勘误 — 曾误判为变化，实为同文
  | "renumber"     // 🔢 仅编号重排 — 章节重构
  | "format"       // ✍ 格式同义改写
  | "added"        // ＋ 新增条款
  | "removed"      // － 删除条款
  | "referenced";  // ↗ 引用编号变化

export type LedgerEntry = {
  category: LedgerCategory;
  /** Section the entry came from, e.g. "11.3" / "11.3.0" / "11.1.2". */
  section: string;
  /** Stable id within the section, e.g. "01". */
  no: string;
  /** Short topic label. */
  topic: string;
  /** Why this entry is in this category. */
  reason?: string;
  /** Page anchors found in the row, if any. */
  pages?: string[];
};

export type Ledger = {
  entries: LedgerEntry[];
  byCategory: Record<LedgerCategory, number>;
  /** Numbers the report claims about itself, for cross-checking. */
  selfReported: { candidateTotal?: number; errataTotal?: number; confirmedTotal?: number };
  /** Non-empty when ledger totals disagree with self-reported numbers. */
  discrepancies: string[];
};

// ---------------------------------------------------------------------------
// Table row extraction
// ---------------------------------------------------------------------------

/** Split a markdown table row into trimmed cells. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|?$/.test(line.trim());
}

/** Rows of a markdown table block, header excluded. */
function tableRows(block: string): string[][] {
  const lines = block.split("\n").filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return [];
  return lines.slice(1).filter((l) => !isSeparatorRow(l)).map(cells);
}

/**
 * Find the section body for a heading like `#### 11.3.0 …` up to the next
 * heading of any level.
 */
function section(md: string, headingRe: RegExp): string | null {
  const m = md.match(headingRe);
  if (!m || m.index === undefined) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^#{2,4}\s/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Pull `（第33页）`-style anchors out of a row. */
function pagesIn(text: string): string[] {
  return [...text.matchAll(/第\s*([0-9]+(?:[-~～][0-9]+)?)\s*页/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Per-category harvesters
// ---------------------------------------------------------------------------

function harvestConfirmed(md: string): LedgerEntry[] {
  // §11.3 数值变化表 has a 核验 column whose value is [已核验] / [待核实].
  const body = section(md, /^#{2,4}\s*11\.3\s*重大修订条款[^\n]*\n/m);
  if (!body) return [];
  const out: LedgerEntry[] = [];
  for (const row of tableRows(body)) {
    const statusCol = row.findIndex((c) => /\[已核验\]|\[待核实\]|manual-audit/.test(c));
    if (statusCol < 0) continue;
    const status = row[statusCol];
    const topic = row[statusCol - 1] ?? row[1] ?? "";
    const no = row[0] ?? "";
    const rest = row.slice(statusCol + 1).join(" ");
    out.push({
      category: /已核验/.test(status) ? "confirmed" : "candidate",
      section: "11.3",
      no,
      topic: topic.replace(/\*\*/g, ""),
      reason: /已核验/.test(status) ? "A/B 原文与页码齐备" : "缺少一侧页码，需人工回原文",
      pages: pagesIn(rest),
    });
  }
  return out;
}

function harvestErrata(md: string): LedgerEntry[] {
  const body = section(md, /^#{2,4}\s*11\.3\.0[^\n]*\n/m);
  if (!body) return [];
  const out: LedgerEntry[] = [];
  for (const row of tableRows(body)) {
    if (!/^\d+$/.test(row[0] ?? "")) continue;
    out.push({
      category: "errata",
      section: "11.3.0",
      no: row[0],
      topic: (row[1] ?? "").replace(/\*\*/g, ""),
      reason: (row[row.length - 1] ?? "").replace(/\*\*/g, ""),
      pages: pagesIn(row.slice(2, row.length - 1).join(" ")),
    });
  }
  return out;
}

function harvestAdded(md: string): LedgerEntry[] {
  const body = section(md, /^#{2,4}\s*11\.1\s*新增条款汇总[^\n]*\n/m)
    ?? section(md, /^#{2,4}\s*11\.1\.2[^\n]*\n/m);
  if (!body) return [];
  const out: LedgerEntry[] = [];
  for (const block of body.match(/((?:\|[^\n]*\n){2,})/g) ?? []) {
    for (const row of tableRows(block)) {
      if (!/^\d+$/.test(row[0] ?? "")) continue;
      out.push({
        category: "added",
        section: "11.1",
        no: row[0],
        topic: (row[2] ?? row[1] ?? "").replace(/\*\*/g, ""),
        reason: `A 草案新增，页码 ${row[3] ?? "—"}`,
        pages: pagesIn(row.join(" ")),
      });
    }
  }
  return out;
}

function harvestRenumber(md: string): LedgerEntry[] {
  const body = section(md, /^#{2,4}\s*11\.6\.1[^\n]*\n/m);
  if (!body) return [];
  const out: LedgerEntry[] = [];
  for (const row of tableRows(body)) {
    // 序号 | 重排说明 | B 编号 | A 编号 | B 页码 | A 页码
    const nums = row.filter((c) => /^\d+(\.\d+)?$/.test(c));
    if (nums.length < 2) continue;
    out.push({
      category: "renumber",
      section: "11.6.1",
      no: row[0] ?? "",
      topic: (row[1] ?? "").replace(/\*\*/g, ""),
      reason: `B ${nums[0]} → A ${nums[1]}（章节重构，技术内容不变）`,
      pages: pagesIn(row.join(" ")),
    });
  }
  return out;
}

/**
 * §11.8 「表述/术语/格式候选差异（工程师复核清单）」— the largest bucket, and
 * the one the report's own ledger prose counts as "30 条同义改写". Each row
 * carries a 分级 cell ("数字相同（低优先）" / "术语/格式（逐字复核）" / …).
 *
 * These are genuine review work items, not confirmed changes — they stay in
 * the `format` bucket (✍) rather than `candidate` so the dashboard doesn't
 * inflate the ⚠ count with what are mostly two-vs-2 formatting deltas.
 */
function harvestFormatCandidates(md: string): LedgerEntry[] {
  const body = section(md, /^#{2,4}\s*11\.8[^\n]*\n/m);
  if (!body) return [];
  const out: LedgerEntry[] = [];
  for (const block of body.match(/((?:\|[^\n]*\n){2,})/g) ?? []) {
    for (const row of tableRows(block)) {
      if (!/^\d+$/.test(row[0] ?? "")) continue;
      const grade = row[row.length - 1] ?? "";
      out.push({
        category: "format",
        section: "11.8",
        no: row[0],
        topic: `${row[1] ?? ""} · ${row[2] ?? ""}`.replace(/\*\*/g, ""),
        reason: grade.replace(/\*\*/g, ""),
        pages: pagesIn(row.join(" ")),
      });
    }
  }
  return out;
}

/**
 * ⚠ 待复核 entries come from several places. Beyond §11.3 they also appear as
 * "⚠ 未找到" rows in the quantitative tables and as "manual-audit" rows. Those
 * are the ones an engineer actually has to chase, so collect them explicitly.
 */
/**
 * Rows that look like a page-index table: `| A | p57 | 醒目标志 |`
 * (文档 | 页 | 标题). These are navigation aids, NOT comparison results —
 * a ⚠ appearing in them is a column-mapping artefact, not an unverified
 * claim. Counting them inflated the ⚠ total.
 */
function isIndexRow(row: string[]): boolean {
  const first = (row[0] ?? "").replace(/\*\*/g, "").trim();
  return /^[ABC]$/.test(first) && /^[pP]\d+$/.test((row[1] ?? "").trim());
}

/**
 * Rows that are NOT table rows at all — prose lines that happen to contain a
 * pipe, e.g. the executive-summary sentence listing
 * "9 条人工对照补录（AFS 数量、慢行灯 10→15 km/h、…）".
 *
 * The scanner splits on "\n|" so a prose bullet that opens with "|" can look
 * like a one-cell table row. Those mentions point at entries that ARE
 * verified elsewhere (§11.0 marks them 「[修改] ✓已核验」with page numbers),
 * so counting them as ⚠ work items is a false positive.
 *
 * Detection: a real comparison row has ≥3 cells, or its cells look like
 * markdown table content. A prose fragment yields one long cell that ends
 * with a full-stop / closing bracket and contains "（" + "）" spans.
 */
function isProseFragment(row: string[], rawLine: string): boolean {
  if (row.length > 2) return false;
  // Heuristic: a single very long cell that reads like a sentence.
  const only = (row[0] ?? "").trim();
  return (
    only.length > 24 &&
    /[，。；：）】]$/.test(only) &&
    !/^\|/.test(rawLine.slice(1).trim())
  );
}

/**
 * §11.0.2 溯源结果表的行：`| 指标 | A页 | B页 | C页 | 原文摘录 |`。
 * 这里的「未找到」只针对 C 版（UN R48-09），A/B 两版已回原文定位。
 */
/**
 * §11.0.2 溯源结果表的行：`| 指标 | A 草案 | B 现行 | C UN R48-09 | 原文摘录 |`
 * 其中「未找到」只针对 **C 版**，A/B 两版列都是实打实的页码。
 *
 * 这类行不是"待核验抽取点"，而是**已核验 + C 版不适用**（UN R48 章节
 * 体系与 GB 不同）。混进 ⚠ 计数会让读者误以为 A/B 的数据也还没核。
 *
 * 判定：至少两个单元格是 `pNN` 页码格式，且整行不含「核验状态」字样
 * （§11.0.3 的「声称对照表」有 `核验状态` 列，那些是误传清单，该保留 ⚠）。
 */
function isTraceabilityRow(row: string[]): boolean {
  if (row.length < 5) return false;
  if (row.some((c) => /核验状态|GB4785\s*声称/.test(c))) return false;
  const pageCells = row.filter((c) => /\*\*p\d+\*\*|^p\d+$/.test(c.trim()));
  return pageCells.length >= 2;
}

function harvestCandidates(md: string): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  // Rows whose verdict cell is ⚠ / 未找到 / manual-audit.
  for (const block of md.match(/((?:\|[^\n]*\n){2,})/g) ?? []) {
    for (const row of tableRows(block)) {
      const joined = row.join(" ");
      const isWarn = /⚠|未找到|manual-audit|未核验/.test(joined);
      if (!isWarn) continue;
      if (!row.length) continue;
      // Skip `| A | p57 | … |` index rows — their page column is a locator,
      // not a verification status.
      if (isIndexRow(row)) continue;
      // §11.0.2 traceability rows: A/B located, C not applicable → not ⚠.
      if (isTraceabilityRow(row)) continue;
      out.push({
        category: "candidate",
        section: inferSection(row[1] ?? "") ?? "正文",
        no: /^\d+$/.test(row[0] ?? "") ? row[0] : "",
        topic: (row[1] ?? row[0] ?? "").replace(/\*\*/g, "").slice(0, 60),
        reason: /未找到/.test(joined)
          ? "两版原文中未定位到该指标出处"
          : /manual-audit/.test(joined)
            ? "人工对照补录，未纳入自动捕获"
            : "未核验",
        pages: pagesIn(joined),
      });
    }
  }
  return out;
}

/** Best-effort section hint from a row's topic cell. */
function inferSection(topic: string): string | null {
  if (/GB4785指标|网传/.test(topic)) return "11.0";
  if (/结构|章节/.test(topic)) return "11.1";
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Numbers the report states about itself. */
function harvestSelfReported(md: string): Ledger["selfReported"] {
  const out: Ledger["selfReported"] = {};
  // "45 条候选的完整去向" — grab the largest such number; the phrase recurs in
  // several chapters and the first hit may be a sub-count.
  const totals = [...md.matchAll(/(\d+)\s*条候选的完整去向/g)].map((m) => Number(m[1]));
  if (totals.length) out.candidateTotal = Math.max(...totals);
  const errata = md.match(/同文勘误[（(]?\s*(\d+)\s*条/);
  if (errata) out.errataTotal = Number(errata[1]);
  const confirmed = md.match(/(\d+)\s*条[^，。]{0,12}已定位到原文页码/);
  if (confirmed) out.confirmedTotal = Number(confirmed[1]);
  return out;
}

/** Accepts either raw markdown or a chapter list, so callers don't have to
 *  remember which form the renderer happens to have on hand. */
export function buildLedger(src: string | Array<{ markdown?: string }>): Ledger {
  const md =
    typeof src === "string"
      ? src
      : src.map((c) => c?.markdown ?? "").join("\n");
  const confirmed = harvestConfirmed(md);
  // NOTE ON TWO DIFFERENT UNIVERSES — the single most confusing thing in this
  // report, so state it where the numbers are produced:
  //   §11.3「N 条候选」  = 差异候选条目（看起来像变更的参数）
  //   ledger.candidate   = 待复核抽取点（正文里 ⚠未找到 / 未核验 的行，
  //                        含 §11.0 的 9 条网传指标）
  // They overlap in spirit but not in membership. Never add them together.
  const errata = harvestErrata(md);
  const added = harvestAdded(md);
  const renumber = harvestRenumber(md);
  const candidates = harvestCandidates(md);
  const format = harvestFormatCandidates(md);

  // §11.3 rows marked 待核实 are candidates; drop them from `confirmed`
  // to avoid double counting with harvestCandidates.
  const confirmedOnly = confirmed.filter((e) => e.category === "confirmed");
  const unverified = confirmed.filter((e) => e.category === "candidate");

  // Dedupe candidates. Two keys, because the same unverified metric can appear
  // twice with different column layout: the §11.0 speed-check rows put the
  // metric name in col 1 with "—" in the value columns, while the §11.0.2
  // verification rows put it in col 0 with "A x → B y" in the last column.
  const seen = new Set<string>();
  const norm = (s: string) => s.replace(/\s+/g, "").replace(/[（）()：:·]/g, "").trim();
  // Topics already verified in §11.0 with 「[修改] ✓已核验」+ page anchors.
  // The executive summary re-mentions them in prose ("9 条人工对照补录（AFS
  // 数量、慢行灯 10→15 km/h …）"), and the scanner picks that prose up as if
  // it were an unverified work item. Cross-check against the verified set
  // so those mentions don't inflate ⚠.
  const verifiedTopics = new Set<string>();
  for (const line of md.split("\n")) {
    if (!line.trim().startsWith("|") || !/✓\s*已核验|已核验/.test(line)) continue;
    for (const cell of line.split("|").slice(3)) {
      const t = norm(cell);
      if (t.length >= 4) verifiedTopics.add(t);
    }
  }
  const mentionedInVerified = (topic: string): boolean => {
    const t = norm(topic);
    if (t.length < 4) return false;
    for (const v of verifiedTopics) {
      if (v.includes(t) || t.includes(v)) return true;
    }
    return false;
  };

  const dedupCandidates = unverified.concat(candidates).filter((e) => {
    if (mentionedInVerified(e.topic)) return false;
    const byFull = `${e.section}|${norm(e.topic)}|${(e.pages ?? []).join(",")}`;
    const byTopic = norm(e.topic);
    if (seen.has(byFull) || seen.has(byTopic)) return false;
    seen.add(byFull);
    seen.add(byTopic);
    return true;
  });

  const entries: LedgerEntry[] = [
    ...confirmedOnly,
    ...dedupCandidates,
    ...errata,
    ...added,
    ...renumber,
    ...format,
  ];

  const byCategory = entries.reduce(
    (acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<LedgerCategory, number>,
  );

  const selfReported = harvestSelfReported(md);
  const discrepancies: string[] = [];

  // The report states its own arithmetic in prose, e.g.
  //   "45 条候选的完整去向：3 条入本表 + 1 条引用编号单列 + 9 条同文勘误
  //    + 30 条同义改写 + 2 条规则判定非变化 —— 合计 45，账目闭环"
  // Reproduce that sum from the ledger and compare, rather than trusting the
  // prose. Parse the individual addends so a mismatch names the bucket.
  // Collect EVERY "N 条候选的完整去向 … 合计 M" declaration. A healthy report
  // has exactly one; the current baseline has two (13 in the executive summary,
  // 45 in §11.3) that contradict each other — which is precisely the
  // "39 vs 45" symptom a reader reports as an unexplained discrepancy.
  const claims = [...md.matchAll(
    /(\d+)\s*条候选的完整去向\s*：([\s\S]{0,320}?)(?:——|—)?\s*合计\s*(\d+)/g,
  )].map((m) => {
    const body = m[2] ?? "";
    const addends = [...body.matchAll(/([0-9]+)\s*条\s*([^，。+]{2,14}?)(?=\s*[（(，,、+＋]|，|。|$)/g)]
      .map((a) => ({ n: Number(a[1]), label: a[2].trim() }))
      .filter((a) => a.n > 0 && !/候选/.test(a.label));
    return {
      head: Number(m[1]),
      tail: Number(m[3]),
      addends,
      addendSum: addends.reduce((a, b) => a + b.n, 0),
      offset: m.index ?? 0,
    };
  });

  // 1. Two declarations that disagree with each other.
  if (claims.length >= 2) {
    const totals = [...new Set(claims.map((c) => c.tail))];
    if (totals.length > 1) {
      const where = claims.map((c) => `「${c.head}/${c.tail}」@${c.offset}`).join("、");
      discrepancies.push(
        `报告内有 ${claims.length} 处「N 条候选的完整去向」声明且总数不一致（${totals.join(" vs ")}）：${where} — 同一份报告自述口径冲突`,
      );
    }
  }

  // 2. Within one declaration: addends must sum to the stated total.
  for (const c of claims) {
    if (c.addends.length >= 2 && c.addendSum !== c.tail) {
      discrepancies.push(
        `「${c.head} 条 = ${c.addends.map((a) => `${a.n} ${a.label}`).join(" + ")}」，` +
          `分项相加 ${c.addendSum}，文中写「合计 ${c.tail}」`,
      );
    }
    if (c.head !== c.tail) {
      discrepancies.push(`开头称 ${c.head} 条候选，结尾写「合计 ${c.tail}」`);
    }
    const ledgerFor: Array<[RegExp, number]> = [
      [/已核验|入本表|数值变化/, confirmedOnly.length],
      [/同文勘误|勘误/, byCategory.errata ?? 0],
      [/同义改写|表述|格式/, byCategory.format ?? 0],
      [/编号重排|重排/, byCategory.renumber ?? 0],
      [/新增/, byCategory.added ?? 0],
    ];
    for (const a of c.addends) {
      const hit = ledgerFor.find(([re]) => re.test(a.label));
      if (!hit) continue;
      if (hit[1] !== a.n) {
        discrepancies.push(`正文称「${a.n} 条${a.label}」，台账在对应表格实算 ${hit[1]} 行`);
      }
    }
  }

  if (
    selfReported.errataTotal !== undefined &&
    (byCategory.errata ?? 0) > 0 &&
    selfReported.errataTotal !== byCategory.errata
  ) {
    discrepancies.push(
      `正文声称勘误 ${selfReported.errataTotal} 条，§11.3.0 实际 ${byCategory.errata} 行`,
    );
  }

  return { entries, byCategory, selfReported, discrepancies };
}

/** Ledger totals suitable for the closure dashboard. */
export function ledgerToCounts(ledger: Ledger) {
  const c = ledger.byCategory;
  return {
    confirmed: c.confirmed ?? 0,
    candidate: c.candidate ?? 0,
    errata: c.errata ?? 0,
    renum: c.renumber ?? 0,
    format: c.format ?? 0,
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    referenced: c.referenced ?? 0,
  };
}
