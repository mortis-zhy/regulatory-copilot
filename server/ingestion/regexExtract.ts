/**
 * Regex-based extraction of clause numbers and numeric values from regulatory
 * PDF text. This runs BEFORE the LLM so the model receives precise, provenance-
 * tracked data instead of having to "remember" numbers on its own.
 *
 * Every numeric value is anchored to { clause, page } so the report can cite
 * exact sources ("5.3.4.1 · 第44页").
 */

export type ClauseRef = {
  clause: string;
  title: string;
  page: number;
};

export type NumericValue = {
  clause: string;
  value: string;
  unit: string;
  context: string;
  page: number;
};

export type RegexExtractResult = {
  clauseIndex: ClauseRef[];
  numericValues: NumericValue[];
};

/** Clause number formats: 5.3.4.1 / 5.22 / 第5章 / 第5节 / 附录A */
const CLAUSE_RE = /\b(\d+\.\d+(?:\.\d+)*)\b/g;

/** Numeric value + unit: 800 cd, 15 km/h, 100 mm, 4.0±1.0 Hz, 7000 lx, 4500K */
const NUMERIC_RE =
  /(\d+(?:\.\d+)?(?:±\d+(?:\.\d+)?)?)\s*(cd|km\/h|mm|cm|m|Hz|kHz|kPa|MPa|V|ms|min|s|%|lx|nm|°|K|cm²|m\/s²)(?![a-zA-Z])/gi;

/** Page markers produced by our PDF extractor: [第N页] */
const PAGE_RE = /\[第(\d+)页\]/g;

/** Context window: characters around a match used as the description. */
function contextAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Find the clause number nearest before a position (for anchoring values). */
function nearestClause(text: string, position: number): string {
  const before = text.slice(Math.max(0, position - 300), position);
  const matches = [...before.matchAll(CLAUSE_RE)];
  if (matches.length === 0) return "";
  // Prefer deeper (more specific) clause numbers like 5.3.4.1
  const best = matches[matches.length - 1];
  return best[1];
}

/** Find the page number for a position by scanning for [第N页] markers. */
function pageAt(text: string, position: number): number {
  const before = text.slice(0, position);
  const matches = [...before.matchAll(PAGE_RE)];
  if (matches.length === 0) return 0;
  return parseInt(matches[matches.length - 1][1], 10);
}

/**
 * Extract all clause numbers and numeric values from one document's text.
 */
export function extractFromDocument(text: string): RegexExtractResult {
  const clauseMap = new Map<string, ClauseRef>();
  const numericValues: NumericValue[] = [];

  // --- Clause numbers (unique, with page + surrounding title context) ---
  for (const m of text.matchAll(CLAUSE_RE)) {
    const clause = m[1];
    if (clauseMap.has(clause)) continue;
    clauseMap.set(clause, {
      clause,
      title: contextAround(text, m.index!, clause.length),
      page: pageAt(text, m.index!),
    });
  }

  // --- Numeric values with units ---
  for (const m of text.matchAll(NUMERIC_RE)) {
    // Skip obvious non-regulatory noise (year ranges like 2019, 2024)
    const value = m[1];
    const unit = m[2];
    if (unit === "s" || unit === "min" || unit === "ms" || unit === "V") {
      // time/voltage alone is often noise (years, versions); keep only when
      // adjacent to a clause context — we keep them anyway but mark context.
    }
    numericValues.push({
      clause: nearestClause(text, m.index!),
      value,
      unit,
      context: contextAround(text, m.index!, m[0].length),
      page: pageAt(text, m.index!),
    });
  }

  return {
    clauseIndex: [...clauseMap.values()],
    numericValues,
  };
}

/**
 * Merge extractions from all documents, tagging each entry with its source
 * document label (A / B / C).
 */
export function extractAll(
  docs: Array<{ label: string; text: string }>,
): RegexExtractResult & { perDoc: Record<string, RegexExtractResult> } {
  const perDoc: Record<string, RegexExtractResult> = {};
  for (const d of docs) {
    perDoc[d.label] = extractFromDocument(d.text);
  }
  return {
    clauseIndex: docs.flatMap((d) =>
      perDoc[d.label].clauseIndex.map((c) => ({ ...c, doc: d.label })),
    ) as ClauseRef[],
    numericValues: docs.flatMap((d) =>
      perDoc[d.label].numericValues.map((v) => ({ ...v, doc: d.label })),
    ) as NumericValue[],
    perDoc,
  };
}
