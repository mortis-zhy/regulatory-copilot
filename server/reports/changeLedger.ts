/**
 * **变化总清单** —— 一份权威的「A 草案相对 B 现行改了什么」。
 *
 * 为什么需要它
 * ------------
 * 报告里现在有**四套**变化清单，各自都是真的，但数目对不上：
 *
 * | 出处 | 条数 | 内容 |
 * |---|---|---|
 * | §11.3 重大修订条款（数值级） | 3 | diff 管线的数值变化幸存者 |
 * | §11.3.1 人工对照补录 | 11 | 固定主题之外、人工核过的变化 |
 * | §11.3.3 参数对照矩阵 | 6 | 45 条差值候选里判为「有变化」的 |
 * | 第 12 章参数矩阵 | 9 | 305 个参数里 verdict=changed 的 |
 *
 * 执行摘要写的是 14（= 3 + 11），矩阵里是 9，11.3.3 里是 6 ——
 * **四个数都不是错的，但读者无从知道它们的关系**。
 * 客户说「这版和之前差别不大」，一部分原因就是**对不上账**。
 *
 * 这一份清单做三件事：
 *   1. 把四套并成一张表，每行标出它出现在哪几套（重复的合并成一行）；
 *   2. 执行摘要只报**一个**数，并说清这个数是怎么来的；
 *   3. 合并只发生在**可证同一**的两行之间（同一主题 + 同一底层条款/数值），
 *      合并表是显式的、逐条写了理由的。
 *
 * 合并的底线
 * ----------
 * 宁可**多列一行**，也不把两条不同的变化合并成一条 ——
 * 合并错了 = 少报了一条真实变化，那是最贵的一类错。
 * 所以合并表只收「同一主题 + 同一底层条款或同一组数值」的条目。
 */

/** 一行变化。 */
export interface ChangeRow {
  id: string;
  /** 装置族 / 参数域，如「转向信号灯」「安装高度」。 */
  topic: string;
  /** 参数名。 */
  name: string;
  /**
   * 变化性质 —— **由值本身算出来，不是人写的**：
   *   数值变化 / 放宽 / 收紧 / 新增 / 删除 / 口径重构 / 分类新增
   * 判定依据在 `classify()` 里，写死了。
   */
  kind: string;
  bValue: string;
  aValue: string;
  bPage?: string;
  aPage?: string;
  /** 这条出现在哪几套清单里（合并后可能有多项）。 */
  sources: string[];
  /**
   * 每个来源**贡献了几条**原始条目。
   *
   * `sources` 是去重后的标签（显示用），但一行可能来自**同一套清单的多条** ——
   * 慢行灯那条人工补录同时覆盖「倒车灯作慢行灯」和「慢行灯自动点亮」两个矩阵行。
   * 只记标签会**少算**，导致「合并后有没有丢条目」这个问题答不出来。
   */
  sourceRows: Record<string, number>;
  /** 已核验的理由原文（人工核验 / 裁定里写的），不重写。 */
  reason?: string;
  /** 对应第 12 章矩阵的行 id（若有）。 */
  matrixRowId?: string;
}

/**
 * 跨清单的**同一性别名** —— 显式声明，不自动猜。
 *
 * 四套清单来自四条不同的管线，同一条变化在它们里的叫法不一样：
 *   §11.3  「转向信号灯 · 首次熄灭时间」（topic=装置名，name=参数名）
 *   第12章 「转向信号灯首次熄灭时间」（topic=类别，name=装置+参数）
 * 两边的 topic 词表**根本不同**（一边是「转向信号灯」，一边是「闪烁频率 / 时间参数」），
 * 所以自动归一化会误合并（两个「最大离地高度」分属近光灯和倒车灯）。
 * 宁可**多列一行**，也不把两条不同的变化合并成一条 ——
 * 合并错了 = 少报了一条真实变化，那是最贵的一类错。
 *
 * 所以：**显式列出成对关系，每对写清凭什么说它们是同一条**，
 * 并且由 `sameChange()` 用**数值**自动复核 —— 说法与数字对不上就拒绝合并。
 */
const SAME_AS: Array<{
  /** 矩阵行名（第 12 章） */
  matrix: string;
  /** 另一套清单里的键，写作 "topic|name" */
  key: string;
  /** 凭什么说它们是同一条 */
  why: string;
}> = [
  {
    matrix: "转向信号灯首次熄灭时间",
    key: "转向信号灯|首次熄灭时间",
    why: "同一条：都是 §5.5.9 / §5.6.9「在 1s~1.5s 时间内首次熄灭」，B 第33页 → A 第41页",
  },
  {
    matrix: "倒车灯最大离地高度",
    key: "倒车灯|最大离地高度",
    why: "同一条：都是「离地高度不小于 250mm，不大于 1200mm」，A 另加 N2G/N3G/M2G/M3G 可放宽至 1400mm",
  },
  {
    matrix: "终端稳态电压上限（12V 系统）",
    key: "电气与试验条件|6V 系统电压限值",
    why: "同一条：B 保留 6V 系统 6.75V 档，A 删除了 6V 系统条款 —— 同一处改动（6V 档消失）",
  },
  {
    matrix: "倒车灯垂直可见角",
    key: "倒车灯|垂直几何可见度 α 角",
    why: "同一条：B §5.4.5.1「α 角向上 15°、向下 5°」→ A §5.21.5.1「垂直方向角 α 向上、向下各 10°」",
  },
  {
    matrix: "慢行灯自动点亮的的车速上限",
    key: "慢行灯|倒车灯作慢行灯 / 慢行灯自动点亮速度阈值",
    why: "同一条：人工补录那一条同时覆盖「倒车灯作慢行灯」与「慢行灯自动点亮」两个车速阈值",
  },
  {
    matrix: "倒车灯作慢行灯的车速阈值",
    key: "慢行灯|倒车灯作慢行灯 / 慢行灯自动点亮速度阈值",
    why: "同一条：同上（同一个人工补录条目覆盖的两个阈值之一）",
  },
];

/**
 * §11.3.3 差值裁定里的条目与 §11.3 的条目之间也有同一条的两种叫法。
 * 合并规则同上：**显式声明 + 数值自动复核**。
 */
const VERDICT_ALIASES: Array<{ from: string; to: string; why: string }> = [
  {
    from: "电气与试验条件|6V系统终端稳定电压上限",
    to: "电气与试验条件|6V 系统电压限值",
    why: "同一条：都是「B 保留 6V 系统 6.75V 档、A 删除 6V 系统条款」这一处改动",
  },
  {
    from: "昼间行驶灯DRL|配备",
    to: "前位灯|A1/A2 类位置灯互斥配备分类（B 无）",
    why:
      "同一条：差值裁定的 reason 原文写着「与 11.3.1 人工补录的「A1/A2 类位置灯互斥配备分类」同源」—— " +
      "两处都是 A 新增的「昼间行驶灯不应与 A2 类位置灯同时配备」这一互斥要求",
  },
];

/** 差值裁定条目的键 → 它归属的 §11.3 条目键。 */
function verdictAlias(topic: string, name: string): string | null {
  const k = normKey(topic, name);
  for (const a of VERDICT_ALIASES) {
    if (k === normKey(...(a.from.split("|") as [string, string]))) {
      return normKey(...(a.to.split("|") as [string, string]));
    }
  }
  return null;
}

/** 归一化：去掉括号限定语、空格、连接符，只留可比的骨架。 */
function normKey(topic: string, name: string): string {
  const t = String(topic ?? "").replace(/\s+/g, "");
  const n = String(name ?? "")
    .replace(/[（(][^）)]*[）)]/g, "") // 括号限定语
    .replace(/[\s·・:：]/g, "")
    .replace(/的+/g, "");
  return `${t}|${n}`;
}

/** 矩阵行名 → 它归属的那条「sourceKey」（若已声明为同一条）。 */
function matrixAlias(name: string): string | null {
  for (const a of SAME_AS) {
    if (a.matrix === name) return normKey(...(a.key.split("|") as [string, string]));
  }
  return null;
}

/**
 * 复核一条「同一条」的声明：两边的**数值**必须对得上。
 *
 * 这是给别名表上的自动闸门 —— 说法与数字对不上，就不是同一条，
 * 合并会让两条变化变成一条（少报），所以宁可不合并。
 */
function sameChange(a: string, b: string): boolean {
  const na = [...String(a ?? "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const nb = [...String(b ?? "").matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  if (!na.length || !nb.length) return true; // 无数值可比 —— 靠人的判断
  // 取交集：有任何一个共同数字就算可能同源（放宽类改动会多出新数字）
  return na.some((x) => nb.includes(x));
}

/**
 * 从一段「取值文本」里剥掉**条款号、页码、车型编号**，只留真正的量值。
 *
 * 不剥的话，判定的就是编号：
 *   B「B 5.8.2 数量：根据牌照板的照明要求而定」→ 数字 [5,8,2]
 *   A「A 5.8.2 数量：一套。发光单元数量与灯具型式试验时一致」→ 数字 [5,8,2]
 * 两边「数值相同」—— 纯属条款号相同，跟值没关系。
 *
 * 这类误判会让「新增了一条规定」被写成「只是表述变了」——
 * **漏报一条真变化**，是最贵的一类错。
 *
 * 三个坑（都踩过）：
 *   ① 条款号要**带上下文**才认 —— 「1.5s」的小数不是条款号，「B 5.8.2」才是；
 *   ② 括号里转引的条款要单独剥，但括号里**同时可能有真值**（「6V 系统，B 4.27b」）；
 *   ③ 车型编号不是值（N2G / M3G / 1a / 1b）—— 项目的老规矩。
 */
export function valuesOf(text: string): number[] {
  let s = String(text ?? "");
  // 页码：（第29页）
  s = s.replace(/[（(]\s*第\s*\d+\s*页\s*[）)]/g, " ");
  // 条款号：**带上下文**才认 —— 版本字母前缀（B 5.8.2）或行首（5.19.7.6 若…）
  s = s.replace(/(?:^|[\s（(，,、;；:：])(?:[ABC]|GB|R48|UN)\s+\d+\.\d+(?:\.\d+)*[a-z]?/g, " ");
  s = s.replace(/^\s*\d+\.\d+(?:\.\d+)*[a-z]?\s+(?=\S)/, " ");
  // 括号里转引的条款：B 4.27b（只剥条款，括号里的真值留着）
  s = s.replace(/[（(][^）)]*?(?:[ABC]|GB|R48|UN)\s+\d+\.\d+(?:\.\d+)*[a-z]?/g, " ");
  // 车型编号：N2G / M3G / A1 / A2 —— 项目老规矩「车型编号不是值」
  s = s.replace(/\b[A-Z]\d+[A-Z]?\b/g, " ");
  // 「第 5/6 类」里的类号也是编号
  s = s.replace(/第\s*\d+(?:\s*\/\s*\d+)*\s*类/g, " ");
  // R48 的类别后缀 1a / 1b —— **只剥 a/b**：
  // 「1s」「1.5s」是**真值**（秒），跟 1a/1b 长得一样但性质相反。
  // 负向前查：不能吃掉小数的一部分（"1.5s" 里的 "5s"）。
  s = s.replace(/(?<![\d.])\b\d+[ab]\b/g, " ");
  // 剩下的数字
  return [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]));
}

/**
 * 变化性质 —— **只判能判的**。
 *
 * 为什么**不判「放宽 / 收紧」**：
 * 同一个「数字变大」，在不同参数上方向相反 ——
 *   车速阈值 10 → 15 km/h 是**放宽**（允许更高车速下仍可用）
 *   离地高度上限 1200 → 1400 mm 是**放宽**
 *   首次熄灭时间 1~1.5s → 1.5s 是**收紧**（区间收窄）
 * 光看数字大小判不出方向，而判错方向 = 把客户引到错误的设计上。
 *
 * 所以：性质只说「数值变了」，**方向由 B 值 → A 值本身呈现**，
 * 读者看得到 10→15、1200→1400。真正的定性说明放在「核验依据」列
 * （那是从原文核出来的理由，不是猜的）。
 */
export function classify(bValue: string, aValue: string): string {
  const b = String(bValue ?? "").trim();
  const a = String(aValue ?? "").trim();
  if (!b && a) return "新增（A 才有）";
  if (b && !a) return "删除（A 已无）";
  if (!b && !a) return "—";
  // 「已删除」「无」这类显式表述
  if (/已?删除|无此条款|取消了/.test(a) && !/已?删除/.test(b)) return "删除（A 已无）";
  if (/B\s*全文\s*0\s*命中|无此分类|无\s*500mm|位置无特殊要求/.test(b)) return "新增（A 才有）";

  const bn = valuesOf(b);
  const an = valuesOf(a);
  if (!bn.length && an.length) return "新增（A 才有具体数值）";
  if (bn.length && !an.length) return "删除（A 已无数值）";
  if (!bn.length && !an.length) return "表述/口径改变（两侧均无数值）";
  const bset = new Set(bn);
  const aset = new Set(an);
  const added = an.filter((x) => !bset.has(x));
  const removed = bn.filter((x) => !aset.has(x));
  if (!added.length && !removed.length) return "数值相同（表述改变）";
  return "数值改变";
}

type Any = Record<string, any>;

/**
 * 建清单。
 *
 * @param verified  facts.json 的内容（numericChanges / manualFindings / diffVerdicts / diffValueDiffs）
 * @param matrixRows 第 12 章矩阵的行（verdict=changed 的进来）
 */
export function buildChangeLedger(verified: Any, matrixRows: Any[] = []): ChangeRow[] {
  const rows = new Map<string, ChangeRow>();

  const put = (r: Omit<ChangeRow, "id" | "kind"> & { kind?: string }) => {
    const key = normKey(r.topic, r.name);
    const existing = rows.get(key);
    if (existing) {
      // 合并：**只加来源，不改值** —— 值以第一次出现的为准，
      // 而且第一个来源是最权威的（§11.3 数值级 > 人工补录 > 差值裁定 > 矩阵）。
      if (!existing.sources.includes(r.sources[0])) existing.sources.push(r.sources[0]);
      existing.sourceRows[r.sources[0]] = (existing.sourceRows[r.sources[0]] ?? 0) + 1;
      if (!existing.reason && r.reason) existing.reason = r.reason;
      if (!existing.bPage && r.bPage) existing.bPage = r.bPage;
      if (!existing.aPage && r.aPage) existing.aPage = r.aPage;
      if (!existing.matrixRowId && r.matrixRowId) existing.matrixRowId = r.matrixRowId;
      return;
    }
    rows.set(key, {
      ...r,
      id: `chg${String(rows.size + 1).padStart(2, "0")}`,
      kind: r.kind ?? classify(r.bValue, r.aValue),
      sourceRows: { [r.sources[0]]: 1 },
    });
  };

  // ── 1) §11.3 数值级（diff 管线的幸存者） ──────────────────────────────
  for (const x of verified?.numericChanges ?? []) {
    put({
      topic: x.topic ?? "",
      name: x.name ?? "",
      bValue: String(x.oldValue ?? ""),
      aValue: String(x.newValue ?? ""),
      bPage: x.bPage || undefined,
      aPage: x.aPage || undefined,
      sources: ["§11.3 数值级"],
    });
  }

  // ── 2) §11.3.1 人工对照补录 ───────────────────────────────────────
  for (const x of verified?.manualFindings ?? []) {
    put({
      topic: x.topic ?? "",
      name: x.name ?? "",
      bValue: String(x.oldValue ?? ""),
      aValue: String(x.newValue ?? ""),
      bPage: x.bPage || undefined,
      aPage: x.aPage || undefined,
      sources: ["§11.3.1 人工补录"],
      reason: x.note || x.brief || undefined,
    });
  }

  // ── 3) §11.3.3 差值裁定（verdict = 有变化） ────────────────────────
  for (const v of Object.values<Any>(verified?.diffVerdicts ?? {})) {
    if (v?.verdict !== "有变化") continue;
    const bValue = String(v.oldValue ?? "");
    const aValue = String(v.newValue ?? "");
    // 已声明与 §11.3 同一条的，合并过去（数值对不上就拒绝合并）。
    const alias = verdictAlias(v.topic ?? "", v.name ?? "");
    if (alias && rows.has(alias)) {
      const target = rows.get(alias)!;
      if (sameChange(target.bValue, bValue) || sameChange(target.aValue, aValue)) {
        if (!target.sources.includes("§11.3.3 差值裁定")) target.sources.push("§11.3.3 差值裁定");
        target.sourceRows["§11.3.3 差值裁定"] = (target.sourceRows["§11.3.3 差值裁定"] ?? 0) + 1;
        if (!target.reason && v.reason) target.reason = v.reason;
        continue;
      }
    }
    put({
      topic: v.topic ?? "",
      name: v.name ?? "",
      bValue,
      aValue,
      sources: ["§11.3.3 差值裁定"],
      reason: v.reason || undefined,
    });
  }

  // ── 4) 第 12 章矩阵（verdict = changed） ───────────────────────────
  for (const m of matrixRows ?? []) {
    if (m?.verdict !== "changed") continue;
    const cs = m.cells ?? {};
    const b = cs.B ?? {};
    const a = cs.A ?? {};
    const c = cs.C ?? {};
    const bValue = (b.nums ?? []).length ? (b.nums ?? []).join(" / ") : String(b.value ?? "");
    const aValue = (a.nums ?? []).length ? (a.nums ?? []).join(" / ") : String(a.value ?? "");

    // 已声明为同一条的，合并到那一条上；**数值对不上就拒绝合并**。
    const alias = matrixAlias(m.name ?? "");
    if (alias && rows.has(alias)) {
      const target = rows.get(alias)!;
      if (sameChange(target.bValue, bValue) || sameChange(target.aValue, aValue)) {
        if (!target.sources.includes("第 12 章矩阵")) target.sources.push("第 12 章矩阵");
        target.sourceRows["第 12 章矩阵"] = (target.sourceRows["第 12 章矩阵"] ?? 0) + 1;
        if (!target.matrixRowId) target.matrixRowId = m.id;
        if (!target.bPage && b.page) target.bPage = b.page;
        if (!target.aPage && a.page) target.aPage = a.page;
        if (c.nums?.length && !target.reason) {
          target.reason = `C UN R48-09 取值：${(c.nums ?? []).join(" / ")}`;
        }
        continue;
      }
      // 数值对不上 —— 不合并，单独成行（宁可多列一行）
    }

    put({
      topic: m.family ?? "",
      name: m.name ?? "",
      bValue,
      aValue,
      bPage: b.page || undefined,
      aPage: a.page || undefined,
      sources: ["第 12 章矩阵"],
      matrixRowId: m.id,
      reason: c.nums?.length ? `C UN R48-09 取值：${(c.nums ?? []).join(" / ")}` : undefined,
    });
  }

  return [...rows.values()];
}

/** 清单的来源分解 —— 执行摘要要把它一并说清，读者才能对上账。 */
export function ledgerBreakdown(rows: ChangeRow[]): {
  total: number;
  /** 每个来源贡献的原始条目数（**展开**后的，不是行数）。 */
  bySource: Record<string, number>;
  /** 每个来源**出现在多少行**里（去重后的行数）。 */
  rowsBySource: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  const rowsBySource: Record<string, number> = {};
  for (const r of rows) {
    for (const [label, n] of Object.entries(r.sourceRows ?? {})) {
      bySource[label] = (bySource[label] ?? 0) + n;
    }
    for (const s of r.sources) rowsBySource[s] = (rowsBySource[s] ?? 0) + 1;
  }
  return { total: rows.length, bySource, rowsBySource };
}
