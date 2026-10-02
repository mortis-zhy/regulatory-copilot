/**
 * Deterministic text-scanner for the 9 critical GB4785 data indicators.
 *
 * These indicators live in prose paragraphs (NOT layout tables), so the
 * table parser can't reach them. We scan the raw extracted text for
 * known patterns and return exact values with page anchors. Zero LLM.
 *
 * The 9 indicators (from GB4785 第 11.4 表 11.6):
 *   1. DRL 最小光度          400 → 500 cd
 *   2. ESS 闪烁频率          4 → 5 Hz
 *   3. ESS 光度              400 → 600 cd (推荐)
 *   4. DRL 可见度角度        ±20° → ±25°
 *   5. 侧标志灯间距          ≤6m → ≤4m
 *   6. LED 寿命              2000 → 3000 h
 *   7. 光通维持率            70% → 80%
 *   8. 预热点灯时间          30 → 60 min
 *   9. AFS 切换时间          ≤2s → ≤1.5s
 */

export type IndicatorHit = {
  id: string;
  label: string;
  value: string;
  unit: string;
  page: string;
  clause: string;
};

type Pattern = {
  id: string;
  label: string;
  unit: string;
  /** Multiple regex patterns to try (first match wins). */
  patterns: RegExp[];
  /** Minimum context around the match to include in the result. */
  contextBefore: number;
};

const PATTERNS: Pattern[] = [
  {
    id: "drl_min_cd",
    label: "DRL 最小光度",
    unit: "cd",
    patterns: [
      /昼间行驶灯[^。]{0,80}?最小光强[^。]{0,20}?(\d{2,4})\s*(?:cd|坎德拉)/i,
      /昼间行驶灯[^。]{0,80}?发光强度[^。]{0,20}?(\d{2,4})\s*(?:cd|坎德拉)/i,
      /DRL[^。]{0,80}?(\d{2,4})\s*(?:cd|坎德拉)/i,
      /最小光强[^。]{0,20}?(\d{2,4})\s*cd/i,
    ],
    contextBefore: 30,
  },
  {
    id: "ess_freq_hz",
    label: "紧急制动信号闪烁频率",
    unit: "Hz",
    patterns: [
      /紧急制动信号[^。]{0,60}?闪烁频率[^。]{0,20}?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz/i,
      /紧急制动信号[^。]{0,60}?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz/i,
      /ESS[^。]{0,60}?(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz/i,
      /(\d\.?\d*)\s*[±±]\s*1\.?\d*\s*Hz[^。]{0,30}?紧急制动/i,
    ],
    contextBefore: 30,
  },
  {
    id: "ess_cd",
    label: "紧急制动信号光度",
    unit: "cd",
    patterns: [
      /紧急制动信号[^。]{0,80}?发光强度[^。]{0,20}?(\d{2,4})\s*cd/i,
      /紧急制动信号[^。]{0,80}?光强[^。]{0,20}?(\d{2,4})\s*cd/i,
    ],
    contextBefore: 30,
  },
  {
    id: "drl_visibility_deg",
    label: "DRL 可见度角度",
    unit: "°",
    patterns: [
      /昼间行驶灯[^。]{0,80}?可见度[^。]{0,30}?[±±]\s*(\d{1,2})\s*°/i,
      /DRL[^。]{0,80}?[±±]\s*(\d{1,2})\s*°/i,
      /昼间行驶灯[^。]{0,80}?[±±]\s*(\d{1,2})\s*°/i,
    ],
    contextBefore: 30,
  },
  {
    id: "side_marker_spacing_m",
    label: "侧标志灯间距",
    unit: "m",
    patterns: [
      /侧标志灯[^。]{0,80}?间距[^。]{0,20}?[≤<]\s*(\d(?:\.\d+)?)\s*m/i,
      /侧标志灯[^。]{0,80}?[≤<]\s*(\d(?:\.\d+)?)\s*m/i,
      /侧标志灯[^。]{0,80}?不小于\s*(\d+(?:\.\d+)?)\s*m/i,
    ],
    contextBefore: 30,
  },
  {
    id: "led_life_h",
    label: "LED 模块寿命",
    unit: "h",
    patterns: [
      /寿命[^。]{0,30}?(\d{3,4})\s*h/i,
      /LED[^。]{0,30}?寿命[^。]{0,20}?(\d{3,4})\s*h/i,
    ],
    contextBefore: 30,
  },
  {
    id: "lumen_maintenance",
    label: "LED 光通维持率",
    unit: "%",
    patterns: [
      /光通维持率[^。]{0,30}?(\d{1,3})\s*%/i,
    ],
    contextBefore: 30,
  },
  {
    id: "preheat_min",
    label: "光源预热点灯时间",
    unit: "min",
    patterns: [
      /预热[^。]{0,30}?(\d{1,3})\s*min/i,
    ],
    contextBefore: 30,
  },
  {
    id: "afs_switch_s",
    label: "AFS 切换时间",
    unit: "s",
    patterns: [
      /AFS[^。]{0,40}?切换[^。]{0,20}?[≤<]\s*(\d\.?\d*)\s*s/i,
      /自适应[^。]{0,40}?切换[^。]{0,20}?[≤<]\s*(\d\.?\d*)\s*s/i,
    ],
    contextBefore: 30,
  },
];

function findPage(text: string, idx: number): string {
  const before = text.slice(0, idx);
  const matches = [...before.matchAll(/\[第(\d+)页\]/g)];
  return matches.length ? `第${matches[matches.length - 1][1]}页` : "";
}

function findClause(text: string, idx: number): string {
  const before = text.slice(Math.max(0, idx - 200), idx);
  const m = before.match(/(\d+\.\d+(?:\.\d+)*(?:\.\d+)*)\s*$/);
  return m ? m[1] : "";
}

export function scanIndicators(docText: string): IndicatorHit[] {
  const hits: IndicatorHit[] = [];
  for (const p of PATTERNS) {
    for (const re of p.patterns) {
      const m = re.exec(docText);
      if (m) {
        const idx = m.index;
        hits.push({
          id: p.id,
          label: p.label,
          value: m[1],
          unit: p.unit,
          page: findPage(docText, idx),
          clause: findClause(docText, idx),
        });
        break; // first pattern match wins
      }
    }
  }
  return hits;
}

/**
 * Pair indicators from A and B into old/new rows for 11.4.
 * Returns only rows where at least one side has a value.
 */
export function pairIndicatorHits(
  aHits: IndicatorHit[],
  bHits: IndicatorHit[],
): Array<{
  id: string;
  label: string;
  unit: string;
  oldValue: string;
  newValue: string;
  source: string;
}> {
  const byId = new Map<string, { a?: IndicatorHit; b?: IndicatorHit }>();
  for (const h of bHits) {
    const e = byId.get(h.id) ?? {};
    e.b = h;
    byId.set(h.id, e);
  }
  for (const h of aHits) {
    const e = byId.get(h.id) ?? {};
    e.a = h;
    byId.set(h.id, e);
  }
  const out: Array<{
    id: string;
    label: string;
    unit: string;
    oldValue: string;
    newValue: string;
    source: string;
  }> = [];
  for (const [id, e] of byId) {
    const label = (e.a ?? e.b)!.label;
    const unit = (e.a ?? e.b)!.unit;
    const oldV = e.b?.value ?? "—";
    const newV = e.a?.value ?? "—";
    const src = `B=${e.b?.clause || e.b?.page || "—"} → A=${e.a?.clause || e.a?.page || "—"}`;
    if (oldV !== newV) {
      out.push({ id, label, unit, oldValue: oldV, newValue: newV, source: src });
    }
  }
  return out;
}