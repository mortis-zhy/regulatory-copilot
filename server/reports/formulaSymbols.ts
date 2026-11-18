/**
 * **公式符号表** —— 「式中：h1——…」「where: h1 is …」的跨版对照。
 *
 * ## 比什么、不比什么
 *
 * B.5 的公式对比只到**字符串**（归一化后完全相同才算对 ✓）：
 * 「同一个式子、符号定义变了」比不出来 ✗。
 *
 * 这里只比**机器能判的三件事** ✓：
 * 1. 每个符号**这一版有没有定义** ✓（没有 = 该版未找到，**不是**「那一版没这个符号」✗）；
 * 2. 定义里的**单位** ✓（mm / % / °）—— 两边都读出来且不同才算「不同」✗；
 * 3. 定义在**哪一页** ✓（可回源 ✓）。
 *
 * **不比语义** ✗：三版的语言本来就不同（中文 vs 英文），
 * 定义文字不同**不代表**含义不同 ✗ —— 报告里必须写清这条界线 ✓。
 */

export type SymbolDef = { symbol: string; definition: string; unit: string };
export type SymbolBlock = { version: string; page: number; symbols: SymbolDef[] };
export type SymbolLedger = { blocks: SymbolBlock[] };

export type SymbolCell = { page: number; unit: string; definition: string } | null;

export type SymbolRow = {
  symbol: string;
  byVersion: Record<string, SymbolCell>;
};

export type SymbolComparison = {
  versions: string[];
  rows: SymbolRow[];
  /** 某一版**未找到定义**的符号 ✓（不是「不存在」✗） */
  missing: Array<{ symbol: string; versions: string[] }>;
  /** 两边都读出单位、且单位不同的符号 ✓ */
  unitMismatch: Array<{ symbol: string; units: Record<string, string> }>;
};

/** 取每版**第一处**定义（同一版重复定义时以第一处为准 —— 报告里会注明）。 */
export function compareSymbols(ledger: SymbolLedger | null | undefined): SymbolComparison {
  const blocks = ledger?.blocks ?? [];
  const versions = [...new Set(blocks.map((b) => b.version))].sort();
  const symbols: string[] = [];
  for (const b of blocks) {
    for (const s of b.symbols ?? []) if (!symbols.includes(s.symbol)) symbols.push(s.symbol);
  }
  const rows: SymbolRow[] = [];
  const missing: SymbolComparison["missing"] = [];
  const unitMismatch: SymbolComparison["unitMismatch"] = [];
  for (const sym of symbols) {
    const byVersion: Record<string, SymbolCell> = {};
    const missingIn: string[] = [];
    for (const v of versions) {
      const block = blocks.find((b) => b.version === v && b.symbols.some((s) => s.symbol === sym));
      const def = block?.symbols.find((s) => s.symbol === sym);
      byVersion[v] = def ? { page: block!.page, unit: def.unit || "", definition: def.definition } : null;
      if (!def) missingIn.push(v);
    }
    rows.push({ symbol: sym, byVersion });
    if (missingIn.length) missing.push({ symbol: sym, versions: missingIn });
    const units = Object.fromEntries(
      versions
        .map((v) => [v, byVersion[v]?.unit ?? ""] as const)
        .filter(([, u]) => !!u),
    );
    const distinct = new Set(Object.values(units));
    if (distinct.size > 1) unitMismatch.push({ symbol: sym, units });
  }
  return { versions, rows, missing, unitMismatch };
}

/** 定义截断 —— 报告里只要够认出是哪一条 ✓。 */
function cut(s: string, n = 70): string {
  const t = String(s ?? "").replace(/\|/g, "｜").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * 把符号表写成 markdown ✓ —— **只写机器能判的**，语义留给读者 ✗。
 */
export function renderSymbolTable(ledger: SymbolLedger | null | undefined): string {
  const c = compareSymbols(ledger);
  if (!c.rows.length) {
    return [
      "",
      "**公式符号**：本份语料里**没有**找到「式中：/ where:」形式的符号定义 —— " +
        "**不判定**符号是否一致 ✗（不是「一致」✗）。",
      "",
    ].join("\n");
  }
  const out: string[] = [];
  out.push(
    `**公式符号**：${c.rows.length} 个符号 × ${c.versions.length} 版 —— 只比**有没有定义 / 单位 / 页码** ✓；` +
      "定义文字不同（中英）**不代表**含义不同 ✗；「未找到定义」也可能只是写法不同 ✗ —— **语义须人判** ✗。",
    "",
  );
  out.push(`| 符号 | ${c.versions.join(" | ")} | 判定 |`, "|---|" + "---|".repeat(c.versions.length) + "---|");
  for (const r of c.rows) {
    const cells = c.versions.map((v) => {
      const x = r.byVersion[v];
      if (!x) return "**未找到定义**";
      return `p${x.page}${x.unit ? ` · ${x.unit}` : " · 单位未读出"}`;
    });
    const units = c.versions.map((v) => r.byVersion[v]?.unit ?? "").filter(Boolean);
    const uniq = new Set(units);
    const verdict = r.byVersion && c.missing.some((m) => m.symbol === r.symbol)
      ? "**有版本未找到定义** ✗"
      : uniq.size > 1
        ? "**单位不同** ✗"
        : units.length
          ? `单位均为 **${[...uniq][0]}** ✓`
          : "单位均未读出 ✗";
    out.push(`| ${r.symbol} | ${cells.join(" | ")} | ${verdict} |`);
  }
  out.push("");
  // 定义摘要：按版本列，一行一条 ✓（九条以内，可读 ✓）
  for (const v of c.versions) {
    const defs = c.rows
      .map((r) => {
        const x = r.byVersion[v];
        return x ? `\`${r.symbol}\`：${cut(x.definition)}` : null;
      })
      .filter(Boolean);
    // 定义可能分在几页上 —— 有几页列几页 ✓（只写第一页 = 指错地方 ✗）
    const pages = [...new Set(c.rows.map((r) => r.byVersion[v]?.page).filter(Boolean))].sort(
      (x, y) => Number(x) - Number(y),
    );
    if (defs.length) out.push(`- **${v}**（p${pages.join(" / p")}）：${defs.join("；")}`);
  }
  out.push("");
  return out.join("\n");
}
