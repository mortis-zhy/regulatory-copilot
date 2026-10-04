/**
 * consistencyChecks — 单位 / 术语 / 重复行 / 数值异常 的自动检测。
 *
 * 评审第五部分列出的呈现层问题里，有几类是可以机器判定的：
 *   1. 单位混用      — 同一参数在 A/B 两栏写了不同单位（500m vs 500mm）
 *   2. 术语不统一    — 视表面 / 透光面 / 发光面 混用（同一物理量三种叫法）
 *   3. 表格重复行    — 同一参数在同一张表出现两次（§11.8 第 9 条已自认）
 *   4. 疑似数值异常  — 报告摘录里出现原文不可能的值（0 负值 / 超量级）
 *
 * 这些不需要业务知识，只需要比对同一张表内的两栏文本，所以放在渲染期跑最合适：
 * 报告一旦引入新的表述错误，下次渲染就会自动暴露。
 */

export type ConsistencyIssue = {
  kind: "unit" | "term" | "duplicate" | "numeric";
  severity: "high" | "medium" | "low";
  label: string;
  detail: string;
  where?: string;
};

export type ConsistencyReport = {
  issues: ConsistencyIssue[];
  counts: Record<ConsistencyIssue["kind"], number>;
};

// ---------------------------------------------------------------------------
// 单位检测
// ---------------------------------------------------------------------------

/** Extract the unit token that follows a number, tolerating OCR spacing. */
function unitOf(text: string): string | null {
  // 500m / 500 mm / 250mmm（原文里 ㎜ 出现两次的情况）
  const m = text.match(/(\d+(?:\.\d+)?)\s*(㎜+|mm|mm|cm|dm|km|m|cd|cd|Hz|hz|%|lm|lx|kg|N|W|V|A|℃|°)(?![a-zA-Z])/);
  if (!m) return null;
  const raw = m[2];
  if (raw === "㎜" || raw === "㎜") return "mm";
  if (raw === "m" || raw === "mm" || raw === "cm" || raw === "km" || raw === "dm") return raw;
  if (raw === "Hz" || raw === "hz") return "Hz";
  if (raw === "℃" || raw === "°") return "°";
  return raw.toLowerCase();
}

/** Numeric value immediately preceding a unit. */
function valueOf(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(㎜+|mm|cm|dm|km|m|cd|cd|Hz|hz|%|lm|lx|kg|N|W|V|A|℃|°)/);
  return m ? Number(m[1]) : null;
}

/**
 * Compare every PAIR of cells in a row, not just the last two.
 *
 * Rows come in two shapes:
 *   vertical   | 版本 | 条款 | 页码 | 原文 |   → A/B are the last two cells
 *   horizontal | 主题 | 参数 | B 值 | A 值 | 分级 |  → §11.8 style
 * Taking "last two" only covered the vertical form and silently missed the
 * 500m/500mm case that actually exists in §11.8.
 */
function checkUnits(rows: string[][]): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  const reported = new Set<string>();

  for (const row of rows) {
    if (row.length < 3) continue;
    const label = (row[1] ?? row[0] ?? "").replace(/\*\*/g, "").trim();
    if (!label || /^[\d.\s—-]+$/.test(label)) continue;

    // Try every pair of value-bearing cells.
    for (let i = 2; i < row.length; i++) {
      for (let j = i + 1; j < row.length; j++) {
        const aText = row[i] ?? "";
        const bText = row[j] ?? "";
        if (!aText || !bText) continue;
        const au = unitOf(aText);
        const bu = unitOf(bText);
        if (!au || !bu || au === bu) continue;

        const isLengthSwap =
          (au === "mm" && bu === "m") || (au === "m" && bu === "mm");
        if (!isLengthSwap) continue;

        const av = valueOf(aText);
        const bv = valueOf(bText);
        const key = `${label}|${av}|${bv}`;
        if (reported.has(key)) continue;
        reported.add(key);

        if (av !== null && bv !== null && av === bv) {
          out.push({
            kind: "unit",
            severity: "high",
            label: "同值不同单位（疑似摘录单位写错）",
            detail:
              `两版数值同为 ${av}，单位却分别是 ${au} 与 ${bu} — ` +
              `极可能是某一版摘录把单位抄错（原文证据：见争议裁定书）`,
            where: label.slice(0, 40),
          });
        } else {
          out.push({
            kind: "unit",
            severity: "high",
            label: "m / mm 长度单位互换",
            detail:
              `同栏对比出现 ${au}（值 ${valueOf(aText) ?? "?"}）与 ${bu}（值 ${valueOf(bText) ?? "?"}）— ` +
              `相差 1000 倍，必须回原文核对`,
            where: label.slice(0, 40),
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 术语一致性
// ---------------------------------------------------------------------------

/**
 * GB4785 里这三个词指同一个物理面，但两版用词不同：
 *   B (2007/2019) 用「视表面」
 *   A (V4.3.5) 用「发光面」/「透光面」
 * 报告若在同一句话里混用，读者会以为是不同参数。
 */
const TERM_FAMILY: Array<{ terms: string[]; canonical: string }> = [
  { terms: ["视表面", "透光面", "发光面"], canonical: "发光面 / 视表面" },
];

function checkTerms(md: string): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  for (const fam of TERM_FAMILY) {
    const counts = fam.terms.map((t) => ({ t, n: (md.match(new RegExp(t, "g")) ?? []).length }));
    const used = counts.filter((c) => c.n > 0);
    if (used.length >= 2) {
      out.push({
        kind: "term",
        severity: "medium",
        label: `同义术语混用：${fam.canonical}`,
        detail: used.map((c) => `「${c.t}」${c.n} 处`).join(" / ") +
          " — 三者指同一物理面，混用会让读者误以为是不同参数",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 重复行
// ---------------------------------------------------------------------------

/**
 * 同一参数在**不同章节**重复出现是正常的（核心参数表 + 变化点 + 逐句对照
 * 各引用一次）；真正的问题是**同一张表内**出现两行几乎相同的参数。
 *
 * 只比「主题列 + 至少一侧有实质取值」的行 —— 表头里的分类标签
 * （"数值变化"、"GB4785指标"）和纯序号不算，否则满屏噪音。
 */
function checkDuplicates(rows: string[][]): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    if (row.length < 4) continue;
    const topic = (row[1] ?? "").replace(/\*\*/g, "").trim();
    if (!topic) continue;
    // 跳过纯序号 / 纯编号 / 占位符（"3"、"5.1"、"—"、"—（未定位）"）
    if (/^[\d.\s—-]+$/.test(topic)) continue;
    // 跳过分类标签：整行只有短标签 + 空值
    const values = row.slice(2).map((c) => c.replace(/\*\*/g, "").trim()).filter(Boolean);
    if (values.length === 0) continue;
    // 跳过"分类 | 数量 | 说明"这类汇总行（第二列全是数字或极短）
    if (topic.length <= 6 && values.every((v) => v.length <= 8)) continue;

    const key = `${topic.replace(/\s+/g, "")}|${values.join("|").slice(0, 60)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  // 只有"主题 + 取值都相同"才算真重复
  const topics = new Map<string, number>();
  for (const key of seen.keys()) topics.set(key.split("|")[0], (topics.get(key.split("|")[0]) ?? 0) + 1);
  for (const [key, n] of seen) {
    if (n < 2) continue;
    const [topic] = key.split("|");
    // 同主题但取值不同 → 是不同条目，不算重复
    if ((topics.get(topic) ?? 0) > n) continue;
    out.push({
      kind: "duplicate",
      severity: "medium",
      label: "同表完全重复行",
      detail: `「${topic}」在同一张表中连同取值完整重复 ${n} 次 — 疑似复制残留`,
      where: topic,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 数值异常
// ---------------------------------------------------------------------------

/** Physically implausible readings that usually mean a truncation or typo. */
function checkNumerics(md: string): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  // "……" 结尾的截断摘录
  const truncated = (md.match(/[^。｜|\n]{6,}…(?=[^。\n])/g) ?? []).length;
  if (truncated > 12) {
    out.push({
      kind: "numeric",
      severity: "low",
      label: "截断摘录偏多",
      detail: `全文有 ${truncated} 处摘录以「…」结尾被截断 — 关键限定条件可能丢失，工程师需回原文`,
    });
  }
  // 空单元格里的孤立数字（| 123456 |）— 常是页码串位
  const strayNums = (md.match(/\|\s*\d{5,}\s*\|/g) ?? []).length;
  if (strayNums > 0) {
    out.push({
      kind: "numeric",
      severity: "medium",
      label: "疑似页码串位",
      detail: `${strayNums} 个单元格只有 5 位以上数字 — 可能是页码被写进了数值列`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function tableBlocks(md: string): string[][][] {
  return (md.match(/((?:\|[^\n]*\n){3,})/g) ?? []).map((b) =>
    b.split("\n").filter((l) => l.trim().startsWith("|")),
  );
}

export function checkConsistency(md: string): ConsistencyReport {
  const blocks = tableBlocks(md);
  const issues: ConsistencyIssue[] = [];

  for (const block of blocks) {
    const rows = block
      .filter((l) => !/^\|[\s:|-]+\|?$/.test(l.trim()))
      .map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    issues.push(...checkUnits(rows));
    issues.push(...checkDuplicates(rows));
  }
  issues.push(...checkTerms(md));
  issues.push(...checkNumerics(md));

  const counts = issues.reduce(
    (acc, i) => {
      acc[i.kind] = (acc[i.kind] ?? 0) + 1;
      return acc;
    },
    { unit: 0, term: 0, duplicate: 0, numeric: 0 } as Record<ConsistencyIssue["kind"], number>,
  );
  return { issues, counts };
}
