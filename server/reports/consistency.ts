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
    // 主题 = 第一个不是纯序号的单元格（与 checkDuplicates 同一口径）。
    // 过去一律从第 2 格开始取值对，于是**三列**的横向表
    // （| 参数 | A | B |）根本不会被比较 —— m/mm 互换查不出来。
    const cells = row.map((c) => (c ?? "").replace(/\*\*/g, "").trim());
    let labelIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      if (/^[\d.\s\u2014-]+$/.test(c)) continue;
      labelIdx = i;
      break;
    }
    if (labelIdx < 0) continue;
    const label = cells[labelIdx];
    if (!label) continue;

    // Try every pair of value-bearing cells.
    for (let i = labelIdx + 1; i < cells.length; i++) {
      for (let j = i + 1; j < cells.length; j++) {
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
 * 同义词族检查。
 *
 * **曾经在这里放过「视表面 / 透光面 / 发光面」—— 那是错的，已移除。**
 * GB 4785 把这三个词定义成**三个不同的面**（A 3.1.8 透光面 light emitting
 * surface、3.1.9 发光面 illuminating surface、3.1.10 视表面 apparent
 * surface；B 版同）。报告照抄原文摘录，三个词都会出现 —— 那是**忠实引用**，
 * 不是术语混用。把它报成「三者指同一物理面」等于在客户面前给报告扣一个
 * 不存在的罪名。
 *
 * 往这里加词族的前提：**标准自己把它们当同一个东西**。
 * 三个不同的术语混在一起报，只会制造误报。
 */
const TERM_FAMILY: Array<{ terms: string[]; canonical: string }> = [];

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
          " — 同一概念出现多种写法，读者可能误以为是不同参数",
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
 * **主题列不固定在第 2 格。** 报告里的表有三种列法：
 *   | 序号 | 主题 | 参数 | … |   → 主题在第 2 格，第 1 格是行号
 *   | 参数 | 单位 | A | B | C |   → 主题在第 1 格，第 2 格是**单位**
 *   | 版本 | 原文取值 | 条款 | … | → 第 1 格是**版本**；同一句「—该版无此规定」
 *                                     在 B、C 两行都出现，那是**两行合法的对照**，
 *                                     不是复制残留
 * 过去一律拿第 2 格当主题，于是「单位那列是 s」的两行被判成「s 重复 3 次」，
 * 而「两版都无此规定」被判成「重复行」—— 55 项中等告警里 53 项是这么来的。
 * 现在主题取**第一个不是纯序号的单元格**，值取它**之后**的各格。
 */
function checkDuplicates(rows: string[][]): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    if (row.length < 4) continue;
    const cells = row.map((c) => (c ?? "").replace(/\*\*/g, "").trim());
    // 主题 = 第一个「不是纯序号/占位符」的单元格
    let topicIdx = -1;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      if (/^[\d.\s\u2014-]+$/.test(c)) continue;
      topicIdx = i;
      break;
    }
    if (topicIdx < 0) continue;
    const topic = cells[topicIdx];
    // 跳过纯序号 / 纯编号 / 占位符（"3"、"5.1"、"—"、"—（未定位）"）
    if (/^[\d.\s—-]+$/.test(topic)) continue;
    // 跳过分类标签：整行只有短标签 + 空值
    // 值 = 主题之后的各格（主题之前的格是行号/序号，不参与比较）
    const values = cells.slice(topicIdx + 1).filter(Boolean);
    if (values.length === 0) continue;
    // 跳过"分类 | 数量 | 说明"这类汇总行：主题很短、取值格 ≤ 2 且都很短。
    // （取值格多于 2 个的短行是**真条目**，不能跳 —— 否则真重复行反而检不出来）
    if (topic.length <= 6 && values.length <= 2 && values.every((v) => v.length <= 8)) continue;

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

/**
 * 表格单元里**以「…」收尾**的摘录数 —— 这才是我们截断的。
 * 原文自带的省略号在句子中间，不收尾，不算。
 */
function countTruncatedCells(md: string): number {
  let n = 0;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    for (const raw of t.slice(1, -1).split("|")) {
      const c = raw.trim();
      if (c.length >= 8 && c.endsWith("…")) n++;
    }
  }
  return n;
}

/** Physically implausible readings that usually mean a truncation or typo. */
function checkNumerics(md: string): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  // 截断摘录 —— 只数**以「…」收尾**的表格单元。
  //
  // 以前数的是「… 前面有 6 个字、后面还有字」，于是**标准原文自带的省略号**
  // （GB 4785 A 的 4.x 正文里就有「……各灯具每个方向上允差为±3°」这种）
  // 也被算成截断：交付件第 4 页写着「全文有 16 处摘录以「…」结尾被截断」，
  // 而其中大部分根本没被截断。
  // 一个只会误报的检查比没有检查更糟 —— 读者会学会忽略整块自查面板，
  // 于是连真的那几条也会被一起忽略（㉒ 的 53 项误报就是这个形状）。
  const truncated = countTruncatedCells(md);
  if (truncated > 12) {
    out.push({
      kind: "numeric",
      severity: "low",
      label: "截断摘录偏多",
      detail: `全文有 ${truncated} 处摘录以「…」结尾被截断 — 关键限定条件可能丢失，工程师需回原文`,
    });
  }
  // 曾经还有一条「疑似页码串位」（任何单元格里只有 5 位以上数字就算），
  // **已删除** —— 它没有可靠信号：
  //   · 页码在本报告里是「第26页」，**裸 5 位以上的数字从来不是页码**；
  //   · 而 430000cd（同时点亮远光灯最大发光强度之和，GB/R48 都有）
  //     恰恰就是 6 位数 —— 真实光度值被报成页码串位；
  //   · 缩窄成「同一行里出现与页码相同的裸数字」也不准：26mm 这种
  //     合法取值一样会中枪。
  // 一个只会误报的检查比没有检查更糟：读者会学会忽略整块自查面板。
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
