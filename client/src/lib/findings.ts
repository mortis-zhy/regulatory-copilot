/**
 * Structured findings emitted by the regulatory agent. The server asks
 * MiniMax-M3 to wrap a JSON block in ```json fences after its prose answer;
 * the client extracts and parses it here so the rest of the UI can render
 * typed cards instead of relying solely on markdown.
 */

export type Severity = "high" | "medium" | "low" | "info";

export type ChangeType =
  | "added"
  | "removed"
  | "rewritten"
  | "numeric"
  | "condition"
  | "reference"
  | "structural"
  | "editorial";

export type Change = {
  id: string;
  title: string;
  type: ChangeType;
  severity: Severity;
  confidence: number;
  oldExcerpt?: string;
  newExcerpt?: string;
  anchor?: string;
  productImpact?: string;
};

export type Parameter = {
  name: string;
  oldValue?: string | number;
  newValue?: string | number;
  unit?: string;
  impact?: Severity;
  source?: string;
};

export type SourceLevel = "official" | "standards_body" | "certification" | "industry" | "secondary";

export type Evidence = {
  title: string;
  source: string;
  url?: string;
  level: SourceLevel;
  retrievedAt: string;
};

export type Findings = {
  changes: Change[];
  parameters: Parameter[];
  evidence: Evidence[];
};

export const CHANGE_TYPE_LABEL: Record<ChangeType, string> = {
  added: "新增",
  removed: "删除",
  rewritten: "改写",
  numeric: "数值",
  condition: "条件",
  reference: "引用",
  structural: "结构",
  editorial: "编辑",
};

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "高影响",
  medium: "中影响",
  low: "低影响",
  info: "信息",
};

export const SOURCE_LEVEL_LABEL: Record<SourceLevel, string> = {
  official: "官方",
  standards_body: "标委",
  certification: "认证",
  industry: "行业",
  secondary: "次级",
};

const SEVERITY_SET = new Set<Severity>(["high", "medium", "low", "info"]);
const CHANGE_TYPE_SET = new Set<ChangeType>([
  "added",
  "removed",
  "rewritten",
  "numeric",
  "condition",
  "reference",
  "structural",
  "editorial",
]);
const SOURCE_LEVEL_SET = new Set<SourceLevel>([
  "official",
  "standards_body",
  "certification",
  "industry",
  "secondary",
]);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Pull structured JSON out of an LLM response. Tries in order:
 *   1. Fenced ```json ... ``` block
 *   2. Fenced ``` ... ``` block (any language)
 *   3. JSONL — one JSON object per line (模型经常这么输出)
 *   4. 单个顶层 JSON 对象/数组
 *
 * 当一个 JSON 对象同时含 changes/parameters/evidence 三个键时返回它本身；
 * 否则把所有解析到的对象按字段名分类合并到一个对象里。
 */
export function extractJsonBlock(text: string): unknown | null {
  // 1. 优先尝试 fenced ```json ... ```
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* fall through */
    }
  }
  // 2. 其他围栏 ```任意语言```
  const anyFence = text.match(/```\w*\s*([\s\S]*?)```/);
  if (anyFence) {
    try {
      return JSON.parse(anyFence[1]);
    } catch {
      /* fall through */
    }
  }
  // 3. 试解析每行非空 JSON (JSONL 模式)
  const lines = text.split(/\n/);
  const parsed: Array<Record<string, unknown>> = [];
  let inArray = false;
  let arrayBuf = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // 累积方括号内的多行 JSON 数组
    if (!inArray && line.startsWith("[")) {
      inArray = true;
      arrayBuf = line;
      if (line.endsWith("]")) {
        try {
          return JSON.parse(arrayBuf);
        } catch {
          inArray = false;
          arrayBuf = "";
        }
      }
      continue;
    }
    if (inArray) {
      arrayBuf += "\n" + line;
      if (line.endsWith("]")) {
        try {
          return JSON.parse(arrayBuf);
        } catch {
          inArray = false;
          arrayBuf = "";
        }
      }
      continue;
    }
    // 单行对象
    if (line.startsWith("{") && (line.endsWith("}") || line.endsWith("},,") || line.endsWith("},,"))) {
      try {
        const cleaned = line.replace(/,+$/, "");
        const obj = JSON.parse(cleaned);
        if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
          parsed.push(obj as Record<string, unknown>);
        }
      } catch {
        /* skip */
      }
      continue;
    }
    // 顶层的完整对象（可能是跨行）
    if (line.startsWith("{")) {
      // 累计直到深度归零
      let depth = 0;
      let buf = "";
      for (let j = i; j < lines.length; j++) {
        const ln = lines[j];
        for (const ch of ln) {
          if (ch === "{") depth++;
          else if (ch === "}") depth--;
          buf += ch;
        }
        if (depth === 0 && buf.length > 0) {
          try {
            const obj = JSON.parse(buf);
            if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
              parsed.push(obj as Record<string, unknown>);
            }
          } catch {
            /* skip */
          }
          i = j;
          break;
        }
        buf += "\n";
      }
    }
  }
  if (parsed.length === 0) return null;
  // 4. 合并所有解析到的对象
  const merged: Record<string, unknown> = {};
  for (const obj of parsed) {
    for (const [k, v] of Object.entries(obj)) {
      // 如果 key 是数组（changes/parameters/evidence），拼接
      if (Array.isArray(v) && Array.isArray(merged[k])) {
        (merged[k] as unknown[]).push(...v);
      } else {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Normalise a parsed JSON blob into a `Findings` object. Be lenient: silently
 * drop entries that don't match the schema rather than throwing — the chat
 * bubble still falls back to the markdown rendering when the model goes off
 * format.
 */
export function toFindings(input: unknown): Findings {
  const root = asObject(input);
  if (!root) return { changes: [], parameters: [], evidence: [] };

  const rawChanges = Array.isArray(root.changes) ? root.changes : [];
  const changes: Change[] = rawChanges
    .map((raw) => {
      const r = asObject(raw);
      if (!r) return null;
      const id = asString(r.id) ?? `CHG-${Math.random().toString(36).slice(2, 6)}`;
      const title = asString(r.title) ?? "";
      const typeRaw = asString(r.type);
      const type: ChangeType = typeRaw && CHANGE_TYPE_SET.has(typeRaw as ChangeType) ? (typeRaw as ChangeType) : "rewritten";
      const sevRaw = asString(r.severity);
      const severity: Severity = sevRaw && SEVERITY_SET.has(sevRaw as Severity) ? (sevRaw as Severity) : "medium";
      const confidence = asNumber(r.confidence) ?? 0.7;
      return {
        id,
        title,
        type,
        severity,
        confidence,
        oldExcerpt: asString(r.oldExcerpt) ?? asString(r.oldText),
        newExcerpt: asString(r.newExcerpt) ?? asString(r.newText),
        anchor: asString(r.anchor) ?? asString(r.source),
        productImpact: asString(r.productImpact) ?? asString(r.impact),
      } as Change;
    })
    .filter((c): c is Change => c !== null && Boolean(c.title));

  const rawParams = Array.isArray(root.parameters) ? root.parameters : [];
  const parameters: Parameter[] = rawParams
    .map((raw) => {
      const r = asObject(raw);
      if (!r) return null;
      const name = asString(r.name);
      if (!name) return null;
      const impactRaw = asString(r.impact);
      const impact: Severity | undefined = impactRaw && SEVERITY_SET.has(impactRaw as Severity) ? (impactRaw as Severity) : undefined;
      return {
        name,
        oldValue: r.oldValue as string | number | undefined,
        newValue: r.newValue as string | number | undefined,
        unit: asString(r.unit),
        impact,
        source: asString(r.source),
      } as Parameter;
    })
    .filter((p): p is Parameter => p !== null);

  const rawEvidence = Array.isArray(root.evidence) ? root.evidence : [];
  const evidence: Evidence[] = rawEvidence
    .map((raw) => {
      const r = asObject(raw);
      if (!r) return null;
      const title = asString(r.title);
      const source = asString(r.source);
      if (!title || !source) return null;
      const levelRaw = asString(r.level);
      const level: SourceLevel = levelRaw && SOURCE_LEVEL_SET.has(levelRaw as SourceLevel) ? (levelRaw as SourceLevel) : "secondary";
      const retrievedAt = asString(r.retrievedAt) ?? new Date().toISOString().slice(0, 10);
      return {
        title,
        source,
        url: asString(r.url),
        level,
        retrievedAt,
      } as Evidence;
    })
    .filter((e): e is Evidence => e !== null);

  return { changes, parameters, evidence };
}

/**
 * Strip the JSON block out of the assistant message so Streamdown only sees
 * the prose portion. We render the JSON as cards alongside the message.
 */
export function stripJsonBlock(text: string): string {
  return text.replace(/```json[\s\S]*?```/gi, "").trim();
}