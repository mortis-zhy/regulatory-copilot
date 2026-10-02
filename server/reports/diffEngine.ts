/**
 * Programmatic three-document diff — changes are COMPUTED, never guessed.
 *
 * Direction (the semantics the client validated):
 *   change = B(现行 2019) → A(草案新版);  C(UN R48) is reference → anchor only
 *
 * Rules per topic (topics are pre-aligned by the fixed checklist):
 *   A yes + B no              → [新增]   (added)
 *   B yes + A no              → [删除]   (removed)
 *   both, text/values differ  → [修改]   (modified)   old = B, new = A
 *   both, identical           → [保留]   — NOT a change
 *
 * Value-level alignment (v3 — fixed): we walk B's values and A's values
 * symmetrically, matching by fuzzy `name`. Only emit a change when:
 *   - the names match (after normalisation), AND
 *   - the values (with unit) differ.
 * Anything else is silently dropped — we NEVER cross-compare "高度" with
 * "数量", and we NEVER surface a value whose name doesn't appear on the
 * other side.
 *
 * Each individual value difference becomes its own `change` row so 11.4
 * can render one row per data point instead of one summary row per topic.
 */
import type { DocStructure, TopicFact, ExtractedValue } from "../ingestion/structuredExtract";

export type EngineChange = {
  title: string;
  type: "added" | "removed" | "modified";
  severity: "high" | "medium" | "low";
  oldValue?: string;
  newValue?: string;
  unit?: string;
  oldExcerpt: string;
  newExcerpt: string;
  anchor: string;
};

/**
 * Flat value-level diff result — used by 11.4 to render one row per
 * real data-indicator change. Each row carries the matched name + unit
 * + B value + A value + provenance. No "topic summary" rows — those
 * were the source of every false positive in v2.
 */
export type EngineValueDiff = {
  /** Topic this value belongs to (e.g. "远光灯", "自动切换前照灯条件表"). */
  topic: string;
  /** Value name as extracted (matches across A/B). */
  name: string;
  /** Unit (cd, mm, Hz, lx, %, ...). May be empty. */
  unit: string;
  /** B 现行版 value, or undefined if missing. */
  oldValue?: string;
  /** A 草案 value, or undefined if missing. */
  newValue?: string;
  /** Source anchor in the form "B=... → A=... ；C=...". */
  source: string;
};

export type DiffResult = {
  changes: EngineChange[];
  /** Flat list of all (B value ↔ A value) pairs that actually differ,
   *  matched by name. 11.4 renders one row per entry. */
  valueDiffs: EngineValueDiff[];
  /** Every extracted value on both sides (B and A), for the appendix
   *  "数据指标明细表". Used to render every parameter, not just the
   *  ones that changed — so the customer can verify "true unchanged"
   *  entries too. */
  parameters: EngineValueDiff[];
};

function normalize(s: string): string {
  return (s ?? "")
    .replace(/\s+/g, "")
    .replace(/[，。、；：]/g, ",")
    .toLowerCase();
}

/** Strip leading clause number ("3.3.1 用于..." → "用于...") so identical
 *  facts quoted with different locators are not flagged as [修改]. */
function normalizeName(s: string): string {
  return normalize(s ?? "")
    .replace(/【[^】]*】/g, "")
    .replace(/\[?第\d+页\]?/g, "")
    .replace(/^[a-z]?:?[\d.]+[a-z]?:?/, "");
}

/** True iff `a` and `b` are likely referring to the same parameter
 *  (one is contained in the other after normalisation, or they're
 *  strictly equal). Returns a 0..1 score (1 = confident match). */
function nameMatchScore(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // Token-overlap fallback for "最大光强" vs "远光灯最大光强" etc.
  const ta = new Set(na);
  const tb = new Set(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Page label from the model may be "[第24页]" or "24" → normalise to 第24页. */
function pageLabel(page: string): string {
  if (!page) return "";
  const m = page.match(/\d+/);
  return m ? `第${m[0]}页` : page;
}

function present(t: TopicFact | undefined): boolean {
  return !!t && t.presence !== "no" && (t.excerpt.trim().length > 0 || t.values.length > 0);
}

function excerptSnippet(t: TopicFact): string {
  const base = t.excerpt.trim().slice(0, 220);
  const pl = pageLabel(t.page);
  const loc = t.clause ? `${t.clause}${pl ? `（${pl}）` : ""}` : pl;
  return loc ? `${base}【${loc}】` : base;
}

function valStr(v: ExtractedValue | undefined): string {
  if (!v) return "";
  return `${v.value}${v.unit ?? ""}`.trim();
}

/**
 * Walk B values and A values symmetrically, matching by name.
 * Returns one row per REAL value difference, and one row per
 * value that's present on only one side.
 */
function diffValues(
  bVals: ExtractedValue[],
  aVals: ExtractedValue[],
  bClause: string,
  bPage: string,
  aClause: string,
  aPage: string,
  cAnchor: string,
): {
  matched: EngineValueDiff[];
  onlyB: ExtractedValue[];
  onlyA: ExtractedValue[];
} {
  const matched: EngineValueDiff[] = [];
  const consumedA = new Set<number>();

  for (let bi = 0; bi < bVals.length; bi++) {
    const bv = bVals[bi];
    let bestIdx = -1;
    let bestScore = 0;
    for (let ai = 0; ai < aVals.length; ai++) {
      if (consumedA.has(ai)) continue;
      const score = nameMatchScore(bv.name, aVals[ai].name);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = ai;
      }
    }
    if (bestIdx >= 0 && bestScore >= 0.7) {
      consumedA.add(bestIdx);
      const av = aVals[bestIdx];
      const bStr = valStr(bv);
      const aStr = valStr(av);
      if (normalize(bStr) !== normalize(aStr)) {
        // Names matched AND values differ → real change.
        matched.push({
          topic: "",
          name: bv.name || av.name,
          unit: bv.unit ?? av.unit ?? "",
          oldValue: bStr,
          newValue: aStr,
          source: `B=${bv.name ? "" : ""}${bClause || pageLabel(bPage)} → A=${aClause || pageLabel(aPage)}${cAnchor}`,
        });
      }
      // Else: matched AND identical → no row (silent skip, becomes 保留)
    } else {
      // No name match on A side — only B has this value.
      // (Doesn't surface as a change unless the topic itself is removed.)
    }
  }

  const onlyA: ExtractedValue[] = [];
  for (let ai = 0; ai < aVals.length; ai++) {
    if (!consumedA.has(ai)) {
      // Check if any A value has no B counterpart by name (true "new" value).
      const av = aVals[ai];
      const hasBMatch = bVals.some((bv) => nameMatchScore(bv.name, av.name) >= 0.7);
      if (!hasBMatch) onlyA.push(av);
    }
  }
  const onlyB = bVals.filter((bv) => {
    return !aVals.some((av) => nameMatchScore(bv.name, av.name) >= 0.7);
  });

  return { matched, onlyB, onlyA };
}

export function diffDocuments(a: DocStructure, b: DocStructure, c?: DocStructure): DiffResult {
  const changes: EngineChange[] = [];
  const valueDiffs: EngineValueDiff[] = [];
  const parameters: EngineValueDiff[] = [];
  const topicNames = [...new Set([...a.topics.map((t) => t.topic), ...b.topics.map((t) => t.topic)])];

  for (const topic of topicNames) {
    const tA = a.topics.find((t) => t.topic === topic);
    const tB = b.topics.find((t) => t.topic === topic);
    const tC = c?.topics.find((t) => t.topic === topic);
    const cAnchor = tC && present(tC) ? `；C=${tC.clause || pageLabel(tC.page)}` : "";

    const aIn = present(tA);
    const bIn = present(tB);

    // --- structural presence changes (topic-level) ---
    if (aIn && !bIn) {
      changes.push({
        title: topic,
        type: "added",
        severity: "high",
        oldExcerpt: "B（GB 4785-2019）无此主题条款",
        newExcerpt: excerptSnippet(tA!),
        anchor: `A=${tA!.clause || pageLabel(tA!.page)}${cAnchor}`,
      });
    } else if (!aIn && bIn) {
      changes.push({
        title: topic,
        type: "removed",
        severity: "high",
        oldExcerpt: excerptSnippet(tB!),
        newExcerpt: "A（草案 V4.3.5）无此主题条款",
        anchor: `B=${tB!.clause || pageLabel(tB!.page)}${cAnchor}`,
      });
    } else if (aIn && bIn) {
      const bt = tB!;
      const at = tA!;

      // 1. value-level diff (the new authoritative result)
      const v = diffValues(
        bt.values, at.values,
        bt.clause, bt.page, at.clause, at.page,
        cAnchor,
      );
      // Each value-level difference is its own row in valueDiffs.
      for (const d of v.matched) {
        valueDiffs.push({
          ...d,
          topic,
          source: `B=${bt.clause || pageLabel(bt.page)}${bt.values.find((x) => x.name === d.name)?.name ? ` ${bt.values.find((x) => x.name === d.name)?.name}` : ""} → A=${at.clause || pageLabel(at.page)}${at.values.find((x) => x.name === d.name)?.name ? ` ${at.values.find((x) => x.name === d.name)?.name}` : ""}${cAnchor}`,
        });
        changes.push({
          title: `${topic}·${d.name}`,
          type: "modified",
          severity: "high",
          oldValue: d.oldValue,
          newValue: d.newValue,
          unit: d.unit,
          oldExcerpt: `B: ${d.oldValue}【${bt.clause || pageLabel(bt.page)}】`,
          newExcerpt: `A: ${d.newValue}【${at.clause || pageLabel(at.page)}】`,
          anchor: `参数级差异${cAnchor}`,
        });
      }
      // A-only values → real new values within an existing topic.
      for (const av of v.onlyA) {
        changes.push({
          title: `${topic}·${av.name || "新参数"}`,
          type: "added",
          severity: "medium",
          oldExcerpt: "B（GB 4785-2019）无此参数",
          newExcerpt: `A: ${valStr(av)}【${at.clause || pageLabel(at.page)}】`,
          anchor: `参数级新增${cAnchor}`,
        });
      }
      // B-only values → real removed values.
      for (const bv of v.onlyB) {
        changes.push({
          title: `${topic}·${bv.name || "已删参数"}`,
          type: "removed",
          severity: "medium",
          oldExcerpt: `B: ${valStr(bv)}【${bt.clause || pageLabel(bt.page)}】`,
          newExcerpt: "A（草案 V4.3.5）无此参数",
          anchor: `参数级删除${cAnchor}`,
        });
      }

      // 2. text-level diff: if the body text differs AND no value changes
      // were captured, surface one text-level change.
      const sameText = normalizeName(bt.excerpt) === normalizeName(at.excerpt);
      if (!sameText && v.matched.length === 0 && v.onlyA.length === 0 && v.onlyB.length === 0) {
        changes.push({
          title: topic,
          type: "modified",
          severity: "medium",
          oldExcerpt: excerptSnippet(bt),
          newExcerpt: excerptSnippet(at),
          anchor: `B=${bt.clause || pageLabel(bt.page)} → A=${at.clause || pageLabel(at.page)}${cAnchor}`,
        });
      }

      // 3. parameters[] (appendix): every value on both sides, even if
      //    identical, so the customer can verify "无变化" too.
      for (const bv of bt.values) {
        const matched = at.values.find((x) => nameMatchScore(bv.name, x.name) >= 0.7);
        parameters.push({
          topic,
          name: bv.name,
          unit: bv.unit ?? "",
          oldValue: valStr(bv),
          newValue: matched ? valStr(matched) : "",
          source: `B=${bt.clause || pageLabel(bt.page)} → A=${at.clause || pageLabel(at.page)}${cAnchor}`,
        });
      }
      // A-only values still appear in parameters (even though B doesn't)
      const accounted = new Set(bt.values.map((x) => x.name));
      for (const av of at.values) {
        if (!accounted.has(av.name)) {
          parameters.push({
            topic,
            name: av.name,
            unit: av.unit ?? "",
            oldValue: "",
            newValue: valStr(av),
            source: `A=${at.clause || pageLabel(at.page)}（B 无对应）${cAnchor}`,
          });
        }
      }
    }
  }

  return { changes, valueDiffs, parameters };
}