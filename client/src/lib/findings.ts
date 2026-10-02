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
  if (parsed.length === 0) return parseMarkdownTables(text);
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
 * Last-resort extraction: MiniMax-M3 often answers with a markdown comparison
 * table instead of JSON (see the `参数 | 旧版 | 新版` shape). Parse any
 * markdown tables into the same changes/parameters structure so the UI still
 * renders typed cards. Returns null when the text has no tables.
 */
function parseMarkdownTables(text: string): Record<string, unknown> | null {
  const lines = text.split("\n");
  const changes: Array<Record<string, unknown>> = [];
  const parameters: Array<Record<string, unknown>> = [];
  let found = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    // A table row looks like `| a | b | c |` and the next line is `|---|---|`
    if (/^\|.*\|$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      const headers = splitRow(line).map((h) => h.toLowerCase());
      i += 2; // skip header + separator
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
        const cells = splitRow(lines[i].trim());
        i++;
        if (cells.length === 0) continue;
        found = true;
        const row = rowToObject(headers, cells);
        classifyTableRow(row, changes, parameters);
      }
      continue;
    }
    i++;
  }

  if (!found) return null;
  const result: Record<string, unknown> = {};
  if (changes.length) result.changes = changes;
  if (parameters.length) result.parameters = parameters;
  return Object.keys(result).length ? result : null;
}

/** Split `| a | b |` into ["a", "b"], dropping empty leading/trailing cells. */
function splitRow(row: string): string[] {
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Build a header→cell map for one table row. */
function rowToObject(headers: string[], cells: string[]): Record<string, string> {
  const row: Record<string, string> = {};
  headers.forEach((h, idx) => {
    if (h) row[h] = cells[idx] ?? "";
  });
  return row;
}

/**
 * Decide whether a table row describes a change or a parameter, based on its
 * headers, and push it onto the right array with normalised field names.
 */
function classifyTableRow(
  row: Record<string, string>,
  changes: Array<Record<string, unknown>>,
  parameters: Array<Record<string, unknown>>,
): void {
  const keys = Object.keys(row);
  const findKey = (...patterns: RegExp[]): string | undefined =>
    keys.find((k) => patterns.some((p) => p.test(k)));

  // Special columns that are never "document value" columns.
  const paramKey = findKey(/param|参数|指标|项目|metric|item|维度|对比维度|^条目$|名称|^内容$|^列$|^模块$|^灯具$|^装置$/i);
  const unitKey = findKey(/unit|单位/i);
  const severityKey = findKey(/severity|严重|等级|影响程度|risk|性质/i);
  const anchorKey = findKey(/anchor|来源|出处|页码|条款定位|clause|page|依据/i);
  // Identifier-style columns (id, key, 标识, 序号) should never become the title.
  const idKey = findKey(/^id$|^key$|^序号$|^标识$|^编号$|^#$/i);

  // ---- version-aware column resolution (客户反馈的核心修复) ----
  // A change runs B(现行 2019) → A(草案新版). C(UN R48) is reference only.
  const refKey = findKey(/^c[\s(（]|un\s*r|国际|参照|欧版/i);
  const oldKey = findKey(/旧值|^old$|现行|2019|(^|\s)b(\s|$|：|:)/i);
  const newKey = findKey(/新值|^new$|草案|v4[.]?3|(^|\s)a(\s|$|：|:)/i);

  const reserved = new Set(
    [paramKey, unitKey, severityKey, anchorKey, idKey, refKey, oldKey, newKey].filter(Boolean) as string[],
  );
  const valueKeys = keys.filter((k) => !reserved.has(k));

  const explicitName = paramKey ? row[paramKey] : undefined;
  const longestValue = valueKeys
    .map((k) => row[k])
    .filter((v) => v && v.length > 0)
    .sort((a, b) => b.length - a.length)[0];
  const nameCell = explicitName || longestValue || "";
  if (!nameCell) return;

  const unit = unitKey ? row[unitKey] : undefined;
  const refVal = refKey ? row[refKey]?.trim() : "";
  const baseAnchor = [anchorKey ? row[anchorKey] : "", refVal ? `C=${refVal}` : ""]
    .filter(Boolean)
    .join("；") || undefined;

  // Resolve old/new by header semantics (旧值/新值, 现行2019/草案, B/A…).
  const oldVal = oldKey ? row[oldKey]?.trim() : "";
  const newVal = newKey ? row[newKey]?.trim() : "";

  const mkParam = (oldV: string, newV: string) =>
    parameters.push({
      name: nameCell,
      oldValue: oldV || undefined,
      newValue: newV || undefined,
      unit,
      source: baseAnchor,
    });

  if (oldVal !== undefined && newVal !== undefined && oldVal !== "" && newVal !== "") {
    mkParam(oldVal, newVal);
    if (oldVal !== newVal) {
      changes.push({
        title: nameCell,
        type: "rewritten",
        severity: fuzzySeverity(severityKey ? row[severityKey] : "") ?? "medium",
        oldExcerpt: oldVal,
        newExcerpt: newVal,
        anchor: baseAnchor,
      });
    }
    return;
  }

  // Only one side of the version pair resolved — record as a parameter, and
  // never fall through to positional guessing (which would flip old/new).
  if ((oldKey && oldVal) || (newKey && newVal)) {
    mkParam(oldVal, newVal);
    return;
  }

  // Headers unrecognised — fall back to positional interpretation with the
  // version convention: values are usually ordered [A(草案), B(现行), C(国际)].
  const values = valueKeys.filter((k) => row[k] && row[k].trim()).map((k) => row[k].trim());
  if (values.length >= 2) {
    // old = 现行版 value, new = 草案版 value (A/B columns are ordered A first)
    const oldV = values.length >= 2 ? values[1] : "";
    const newV = values[0];
    mkParam(oldV, newV);
    if (oldV !== newV) {
      changes.push({
        title: nameCell,
        type: "rewritten",
        severity: fuzzySeverity(severityKey ? row[severityKey] : "") ?? "medium",
        oldExcerpt: oldV,
        newExcerpt: newV,
        anchor: baseAnchor ?? (values.length >= 3 ? `C=${values[2]}` : undefined),
      });
    }
  } else if (values.length === 1) {
    mkParam("", values[0]);
  }
}

/**
 * Normalise a parsed JSON blob into a `Findings` object.
 *
 * MiniMax-M3 does not reliably follow the requested field names — it emits
 * `parameter`/`from`/`to` instead of `title`/`oldExcerpt`/`newExcerpt`,
 * `change_id` instead of `id`, `source_name` instead of `source`, etc.
 * Every field below therefore accepts a list of aliases, and the type/severity
 * strings are fuzzy-matched so "数值变更 (Numerical Modification)" still maps
 * to a known ChangeType. Entries that end up with no usable title are dropped,
 * but the function never throws — the chat bubble falls back to markdown.
 */
export function toFindings(input: unknown): Findings {
  const root = asObject(input);
  if (!root) return { changes: [], parameters: [], evidence: [] };

  const rawChanges = Array.isArray(root.changes) ? root.changes : [];
  const changes: Change[] = rawChanges
    .map((raw, idx) => {
      const r = asObject(raw);
      if (!r) return null;
      const id = pickString(r, ["id", "change_id", "changeId", "key"]) ?? `CHG-${String(idx + 1).padStart(3, "0")}`;
      // Title: the model often omits `title` but provides parameter/description.
      const title =
        pickString(r, ["title", "summary", "headline", "description", "parameter", "parameter_name", "change", "name"]) ?? "";
      if (!title) return null;
      const type = inferChangeType(r);
      const severity = inferSeverity(r);
      const confidence = asNumber(r.confidence) ?? 0.7;
      const oldExcerpt = pickString(r, ["oldExcerpt", "oldText", "from", "old_value", "oldValue", "previous", "doc_a_value", "baseline", "old"]);
      const newExcerpt = pickString(r, ["newExcerpt", "newText", "to", "new_value", "newValue", "current", "doc_b_value", "revised", "new"]);
      const anchor = pickString(r, ["anchor", "source", "source_anchor", "clause", "reference", "location", "page"]);
      const productImpact = pickString(r, ["productImpact", "impact", "impact_description", "significance", "note"]);
      return { id, title, type, severity, confidence, oldExcerpt, newExcerpt, anchor, productImpact } as Change;
    })
    .filter((c): c is Change => c !== null && Boolean(c.title))
    // 客户反馈修复：旧文 == 新文的"变化"是伪变化，直接丢弃
    .filter((c) => {
      const o = (c.oldExcerpt ?? "").replace(/\s+/g, "");
      const n = (c.newExcerpt ?? "").replace(/\s+/g, "");
      return !(o && n && o === n);
    });

  const rawParams = Array.isArray(root.parameters) ? root.parameters : [];
  const parameters: Parameter[] = rawParams
    .map((raw) => {
      const r = asObject(raw);
      if (!r) return null;
      const name = pickString(r, ["name", "parameter", "parameter_name", "param_id", "title", "metric"]);
      if (!name) return null;
      const impactRaw = pickString(r, ["impact", "severity"]);
      const impact: Severity | undefined = impactRaw ? fuzzySeverity(impactRaw) : undefined;
      return {
        name,
        oldValue: (r.oldValue ?? r.old_value ?? r.from ?? r.doc_a_value) as string | number | undefined,
        newValue: (r.newValue ?? r.new_value ?? r.to ?? r.doc_b_value) as string | number | undefined,
        unit: pickString(r, ["unit", "units", "uom"]),
        impact,
        source: pickString(r, ["source", "source_anchor", "anchor", "clause", "reference"]),
      } as Parameter;
    })
    .filter((p): p is Parameter => p !== null);

  const rawEvidence = Array.isArray(root.evidence) ? root.evidence : [];
  const evidence: Evidence[] = rawEvidence
    .map((raw) => {
      const r = asObject(raw);
      if (!r) return null;
      const title = pickString(r, ["title", "claim", "statement", "evidence", "description", "summary"]);
      const source = pickString(r, ["source", "sourceName", "source_name", "sourceUrl", "url", "origin", "reference", "category", "source_type", "verification_path"]);
      if (!title || !source) return null;
      const levelRaw = pickString(r, ["level", "category", "source_level", "type"]);
      const level: SourceLevel = levelRaw ? fuzzySourceLevel(levelRaw) : "secondary";
      const retrievedAt = pickString(r, ["retrievedAt", "retrieved_at", "date"]) ?? new Date().toISOString().slice(0, 10);
      return {
        title,
        source,
        url: pickString(r, ["url", "sourceUrl", "source_url", "link"]),
        level,
        retrievedAt,
      } as Evidence;
    })
    .filter((e): e is Evidence => e !== null);

  // If the model forgot to emit a `changes` block (it does that roughly half
  // the time), synthesise one from the parameter list. Every parameter is a
  // comparison point — each becomes a change so the follow-up button always
  // has something to act on. Only parameters whose old(B)/new(A) actually
  // differ qualify — identical content is [保留], not a change (客户反馈修复).
  if (changes.length === 0) {
    let chgIdx = 0;
    for (const p of parameters) {
      const oldV = p.oldValue !== undefined ? String(p.oldValue).replace(/\s+/g, "") : "";
      const newV = p.newValue !== undefined ? String(p.newValue).replace(/\s+/g, "") : "";
      if (!oldV || !newV || oldV === newV) continue;
      chgIdx += 1;
      changes.push({
        id: `CHG-${String(chgIdx).padStart(3, "0")}`,
        title: p.name,
        type: "numeric",
        severity: "medium",
        oldExcerpt: p.oldValue !== undefined ? String(p.oldValue) : undefined,
        newExcerpt: p.newValue !== undefined ? String(p.newValue) : undefined,
        anchor: p.source,
        confidence: 0.7,
      });
    }
  }

  return { changes, parameters, evidence };
}

/** First non-empty string among the given keys. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = asString(obj[key]);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** Map free-form type text onto a known ChangeType. */
function inferChangeType(r: Record<string, unknown>): ChangeType {
  const explicit = asString(r.type);
  if (explicit && CHANGE_TYPE_SET.has(explicit as ChangeType)) return explicit as ChangeType;
  const haystack = [explicit, asString(r.change_type), asString(r.category), asString(r.parameter), asString(r.parameter_name), asString(r.title), asString(r.name)]
    .filter(Boolean).join(" ").toLowerCase();
  if (/added|新增|增加|new\b/.test(haystack)) return "added";
  if (/removed|删除|移除|deleted/.test(haystack)) return "removed";
  if (/numeric|数值|数值变更|threshold|limit|parameter|参数|指标/.test(haystack)) return "numeric";
  if (/condition|条件|except/.test(haystack)) return "condition";
  if (/reference|引用|参引/.test(haystack)) return "reference";
  if (/structural|结构|章节/.test(haystack)) return "structural";
  if (/editorial|编辑|措辞|wording/.test(haystack)) return "editorial";
  return "rewritten";
}

/** Map free-form severity text onto a known Severity. */
function inferSeverity(r: Record<string, unknown>): Severity {
  const explicit = asString(r.severity);
  if (explicit && SEVERITY_SET.has(explicit as Severity)) return explicit as Severity;
  return fuzzySeverity([explicit, asString(r.impact), asString(r.significance), asString(r.priority)].filter(Boolean).join(" ")) ?? "medium";
}

/** Fuzzy-match a severity string; returns undefined when nothing matches. */
function fuzzySeverity(raw: string): Severity | undefined {
  const s = raw.toLowerCase();
  if (/high|高|critical|严重/.test(s)) return "high";
  if (/low|低|minor|轻微/.test(s)) return "low";
  if (/info|信息|note/.test(s)) return "info";
  if (/medium|中|moderate/.test(s)) return "medium";
  return undefined;
}

/** Fuzzy-match a source-level string. */
function fuzzySourceLevel(raw: string): SourceLevel {
  const s = raw.toLowerCase();
  if (/official|官方|gov|sac|samr|state/.test(s)) return "official";
  if (/standards[_ ]?body|标准机构|iso|iec|unece|ece/.test(s)) return "standards_body";
  if (/certification|认证|ccc|ccap/.test(s)) return "certification";
  if (/industry|行业|协会/.test(s)) return "industry";
  if (/secondary|二级|media|新闻/.test(s)) return "secondary";
  // 【原文事实】 style labels are still trustworthy sources of the document itself
  if (/原文事实|document|用户输入/.test(s)) return "official";
  return "secondary";
}

/**
 * Strip the JSON block out of the assistant message so Streamdown only sees
 * the prose portion. We render the JSON as cards alongside the message.
 *
 * Handles:
 *   1. Fenced ```json ... ``` blocks (original)
 *   2. Bare JSONL (one JSON object/array per line, no fences)
 *   3. Multi-line bare JSON objects/arrays
 */
export function stripJsonBlock(text: string): string {
  // 1. Fenced blocks: ```json ... ``` or ``` ... ```
  let result = text.replace(/```(?:json)?[\s\S]*?```/gi, "");

  // 2. JSONL: individual lines that are valid JSON objects or arrays
  const lines = result.split(/\n/);
  const cleaned = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // Skip lines that look like standalone JSON objects or arrays
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && (trimmed.endsWith("}") || trimmed.endsWith("]"))) {
      try {
        JSON.parse(trimmed);
        return "";
      } catch {
        // not valid JSON on this line, keep it
      }
    }
    return line;
  });
  result = cleaned.join("\n");

  // 3. Multi-line bare JSON blocks: find { ... } or [ ... ] spans
  // Use a brace-depth scanner to locate and remove them
  const stripped: string[] = [];
  let i = 0;
  while (i < result.length) {
    // Skip whitespace between blocks
    if (/[\s]/.test(result[i])) {
      let j = i;
      while (j < result.length && /[\s]/.test(result[j])) j++;
      stripped.push(result.slice(i, j));
      i = j;
      continue;
    }
    // Detect JSON block start
    if (result[i] === "{" || result[i] === "[") {
      const open = result[i];
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let j = i;
      while (j < result.length) {
        if (result[j] === open) depth++;
        else if (result[j] === close) depth--;
        j++;
        if (depth === 0) break;
      }
      // Skip the entire JSON block (don't add to stripped)
      i = j;
      // Add a single newline separator
      if (stripped.length > 0 && !stripped[stripped.length - 1].endsWith("\n")) {
        stripped.push("\n");
      }
      continue;
    }
    // Regular character, keep it
    stripped.push(result[i]);
    i++;
  }
  return stripped.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Extract the raw JSON string from an LLM response for display purposes.
 * Returns the JSON string (without fences) or null if not found.
 * This is separate from `extractJsonBlock` which parses it — this one
 * preserves the raw text so users can always see what the model output.
 */
export function extractRawJsonString(text: string): string | null {
  // 1. Fenced ```json ... ```
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // 2. Other fenced ``` ... ```
  const anyFence = text.match(/```\w*\s*([\s\S]*?)```/);
  if (anyFence) return anyFence[1].trim();
  // 3. Look for a top-level JSON object or array (not inside prose)
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // not valid standalone JSON
    }
  }
  return null;
}