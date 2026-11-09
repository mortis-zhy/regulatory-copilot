/**
 * 取值级「回源 PDF 复核」。
 *
 * ## 为什么要有这一层
 *
 * 矩阵里每一格的页码来自 MinerU 的分页标记，值来自 MinerU 的抽取结果。
 * 交付前那道闸（`scripts/matrix_page_check.py`）拿**引文**回源 PDF 找，
 * 找不到就归为「skipped —— MinerU 与源 PDF 措辞不同，查不到不算错」。
 *
 * 那个「不算错」是一个**没有证据的免罪**：实测 796 个取值格里有 120 格
 * 引文根本查不到（引文本身就是纯数值：'1300'、'2 0 ^'、'20 ㎜'，
 * 源 PDF 写成 '1,300'、'20°'、'20 mm'），而「措辞不同」与
 * **「这个值根本是编出来的」**在那一格里长得一模一样。
 *
 * 所以复核下沉到**取值层**：不看引文，直接看这个值本身在不在源 PDF 里。
 *
 * ## 四档证据（任一档落在所报的那一页上，就算定位成功）
 *
 * | 档 | 证据 | 强度 | 它能证明什么 |
 * |---|---|---|---|
 * | `excerpt` | 引文片段在所报页上 | 最强 | 读者翻过去能看到那句话和那个数 |
 * | `match` | **标签 + 取值**那一小段在所报页上 | 强 | **配对已验** —— 这个数配的是那个标签 |
 * | `value+clause` | 取值与条款号都在所报页上 | 中 | 人工复核时真正会看的东西 |
 * | `value` | 取值字面量在所报页上 | 弱 | 那个数在（但可能配错了对象） |
 * | `clause` | 条款号在所报页上 | 最弱 | 条款在，但值可能是英文词（'two minutes'） |
 *
 * **`match` 那一档是抓「串行错位」的**：
 * 串行错误（GB4785-2019 的色度表整段串成一行）的形态是
 * 「每个数都是真的，只是配错了对象」——
 * 「值在页上」分辨不出来，「标签与值一起在页上」才分辨得出来。
 *
 * 都不在所报页、但值在文档别处 → **页码不符**；
 * 都不在、值在整份文档里也找不到 → **疑似编造**（这一类必须为 0）。
 *
 * ## 为什么「引文查不到」不等于「值查不到」
 *
 * 源 PDF 的写法与 MinerU 的转写系统性不同：
 *   '1,300' / '1 300' / '1300'      —— 千分位
 *   '20 ㎜' / '20 mm' / '20°'        —— 单位与符号
 *   '$2 0 ^ { \circ }' / '2 0 ^'    —— LaTeX 把一个数字拆成两位
 *   '0.150' / '0.15'                —— 有效位
 *   'two minutes' / '2'             —— 英文数词展开
 * 所以取值要**同时**用「字面量」和「规范化后的数值」去找。
 */

import { hasComparisonWordNear } from "./comparatorWords";

/** 数字 token：允许千分位逗号与小数点连用（'1,300' / '0.150'）。 */
const NUMTOK = /\d+(?:[.,]\d+)*/g;

/** 数字之间的逗号（千分位）。 */
const COMMA_BETWEEN_DIGITS = /(\d)[,，](\d)/g;

/** 去标签 / 去 LaTeX / 去表格竖线 / 去空白。 */
export function normalizeText(s: string): string {
  return String(s ?? "")
    .replace(/\$\s*\\mathrm\s*\{([^}]*)\}\s*\$/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[|^{}_]/g, "")
    // 表格竖线只在 MinerU 的转写里有，源 PDF 的文本层没有。
    // 不去掉的话，引文片段会带着 '||' 去源 PDF 里找，永远找不到 ——
    // 那正是「das.wiperDuration」这一格长期挂在 skipped 里的原因。
    .replace(/\|/g, "")
    .replace(/㎜/g, "mm")
    .replace(/\s+/g, "");
}

/** 千分位逗号去掉，空白也去掉 —— 「数字在哪」的最终形态。 */
function squash(s: string): string {
  let prev = "";
  let t = String(s ?? "");
  while (prev !== t) {
    prev = t;
    t = t.replace(COMMA_BETWEEN_DIGITS, "$1$2");
  }
  return t.replace(/\s+/g, "");
}

/**
 * 引文与源页文本必须**用同一套归一化**，否则永远对不上。
 *
 * 这里踩过一次：源页文本去掉了千分位逗号（'7,000 lx' → '7000lx'），
 * 而引文片段没有（仍是 '7,000lx.'）—— 于是「引文在页上」这一档
 * 整整少了 115 格，全都掉到了证据更弱的「取值在页」那档。
 * **两边归一化不一致，是比规则本身更容易犯、也更难发现的错。**
 */
function canonicalText(s: string): string {
  return squash(normalizeText(s));
}

/** 一个数字前面不能是数字，后面也不能是数字（否则 '20' 会命中 '200'）。 */
function digitAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && s[i] >= "0" && s[i] <= "9";
}

/**
 * 字面量是否作为一个**独立的数**出现在压平后的文本里。
 *
 * 边界规则：前后都不能是数字；前后都不能是「小数点 + 数字」
 * （否则 '0.15' 会命中 '0.150' 的前半截 —— 那是同一个数，但要按原样对）。
 */
export function hasLiteral(squashed: string, lit: string): boolean {
  if (!lit) return false;
  let i = squashed.indexOf(lit);
  while (i >= 0) {
    const before = i > 0 ? squashed[i - 1] : "";
    const after = squashed[i + lit.length] ?? "";
    const beforeBad = digitAt(squashed, i - 1) || (before === "." && digitAt(squashed, i - 2));
    const afterBad = digitAt(squashed, i + lit.length) || (after === "." && digitAt(squashed, i + lit.length + 1));
    if (!beforeBad && !afterBad) return true;
    i = squashed.indexOf(lit, i + 1);
  }
  return false;
}

/** 从引文里挑一段足够独特、又不会太长的连续文字（对齐 matrix_page_check.py）。 */
export function excerptFragment(excerpt: string, match: string, width = 14): string {
  const n = canonicalText(excerpt);
  if (n.length < width) return n;
  const m = canonicalText(match);
  const at = m ? n.indexOf(m) : -1;
  if (at < 0 || !m) return n.slice(0, width * 2);
  return n.slice(at, at + m.length + width);
}

/** 一个取值在源 PDF 里可能的所有写法。 */
export function valueCandidates(match: string, nums: string[]): string[] {
  const out = new Set<string>();
  for (const m of String(match ?? "").matchAll(NUMTOK)) {
    const tok = m[0];
    // 两个点以上是条款号（'5.2.4.2'），不是值。
    if ((tok.match(/\./g) ?? []).length >= 2) continue;
    out.add(tok);
    out.add(tok.replace(/[,，]/g, ""));
  }
  for (const raw of nums ?? []) {
    const s = String(raw).replace(/[,，]/g, "");
    if (!s) continue;
    out.add(s);
    // '1300' 的源 PDF 写法可能是 '1,300' 或 '1 300'。
    if (/^\d{4,}$/.test(s)) {
      out.add(`${s.slice(0, -3)},${s.slice(-3)}`);
      out.add(`${s.slice(0, -3)} ${s.slice(-3)}`);
    }
  }
  return [...out];
}

/** 一版源 PDF 的索引：页码 → 压平后的文本。 */
export interface SourceIndex {
  /** 源 PDF 的页码（1 起） */
  pageNos: number[];
  /** 与 pageNos 一一对应的压平文本 */
  squashed: string[];
}

export function buildSourceIndex(pages: Array<[number, string]> | undefined): SourceIndex | null {
  if (!pages || !pages.length) return null;
  const pageNos: number[] = [];
  const squashed: string[] = [];
  for (const [no, text] of pages) {
    pageNos.push(no);
    // 源页文本必须与引文片段**走同一套归一化**。
    // GB 4785 的 PDF 文本层带 LaTeX 残渣（`^{...}`、`_`），
    // 只去空白而不去标记，源页就会多出引文里没有的字符 ——
    // 于是引文明明在那一页上，却判成「查不到」（实测差 45 格）。
    squashed.push(canonicalText(text));
  }
  return { pageNos, squashed };
}

/**
 * 复核结论。
 *
 * `status` 是给人看的结论，`evidence` 是支撑它的证据类型，
 * `rarity` 是**这次复核有几分分量** —— 一个在全文 60% 的页上都出现的
 * 「20」，找到了也说明不了什么，读者需要知道这一点。
 */
export interface Corroboration {
  /**
   * `unchecked` 与 `not-found` **必须分开**：
   * 前者是「没法复核」（这一版没有源 PDF 语料、或者这一格没有页码），
   * 后者是「复核了，查不到」（疑似编造）。
   * 把两者合并，等于在换标准、语料尚未入库时把「数据缺失」报成「数据造假」。
   */
  status: "on-page" | "elsewhere" | "not-found" | "unchecked";
  evidence: "excerpt" | "match" | "value+clause" | "value" | "clause" | "none";
  /** 取值在源 PDF 出现的页码 */
  valuePages: number[];
  /** 引文在源 PDF 出现的页码 */
  excerptPages: number[];
  /** 「标签 + 取值」那一小段在源 PDF 出现的页码（**配对证据**） */
  matchPages: number[];
  /** 取值（或引文）在全文出现的页占比 0..1 */
  rarity: number;
  /** 一句话说明，给报告直接用 */
  note: string;
  /**
   * 四个维度的核验状态 —— 「值在这一页上」**不等于**「这一格的语义是对的」
   * （客户 DR-012）。没有机械判据的写「未核」，不写「已核」。
   */
  dimensions?: Dimensions;
}

/** 复核所需的格子字段（避免与 parameterMatrix.ts 循环依赖）。 */
export interface CorroborationTarget {
  value: string;
  match: string;
  nums: string[];
  clause: string;
  page: string;
  /** 行声明的单位（`spec.unit`） */
  unit?: string;
  /** 行名（用来找适用条件） */
  rowName?: string;
  /** 取值口径（< / ≤ / ≥ / > / =）—— 取不到就是没取到 */
  comparator?: string;
}

/* -------------------------------------------------------------------------- */
/* 四个维度 —— 「值在这一页上」不等于「这一格的语义是对的」                     */
/* -------------------------------------------------------------------------- */

/**
 * 客户 DR-012（P1）：报告写「796 个取值格每一个都回源 PDF 核过，页码与取值逐格对得上」，
 * 而这句话**只证明了值出现在那一页上** —— 它证明不了：
 *
 *   · **语义配对**：这个数配的是那个标签吗（串行错位时，每个数都是真的）；
 *   · **条件**：这个数在什么前提下才成立（车型、档位、触发条件）；
 *   · **符号**：是「小于 750」还是「不大于 750」（客户 DR-002）；
 *   · **单位**：值的单位与行声明的单位一致吗（1200mm 还是 1200cm）。
 *
 * 所以这四件事各有各的核验状态，**没有机械判据的写「未核」，不写「已核」**。
 */
export type DimStatus = "已核" | "部分核" | "未核" | "不一致" | "未判定" | "不适用";

export interface Dimensions {
  /** 语义配对：这个数配的是那个标签 */
  pairing: DimStatus;
  /** 条件：适用条件 */
  condition: DimStatus;
  /** 符号：比较口径 */
  symbol: DimStatus;
  /** 单位：值的单位与行声明的单位 */
  unit: DimStatus;
}

/** 单位别名 → 规范形态。 */
const UNIT_ALIASES: Array<[string[], string]> = [
  [["㎜", "mm", "毫米"], "mm"],
  [["cm²", "cm2", "平方厘米"], "cm²"],
  [["cm", "厘米"], "cm"],
  [["m²", "m2", "平方米"], "m²"],
  [["m", "米"], "m"],
  [["cd/m²", "cd/m2"], "cd/m²"],
  [["cd", "坎德拉"], "cd"],
  [["lx", "勒克斯"], "lx"],
  [["lm", "流明"], "lm"],
  [["km/h", "kmh", "公里每小时", "千米每小时"], "km/h"],
  [["m/s"], "m/s"],
  [["%", "％"], "%"],
  [["ms", "毫秒"], "ms"],
  [["s", "秒"], "s"],
  [["v", "伏"], "V"],
  [["°", "度", "degree", "degrees"], "°"],
  [["n", "牛"], "N"],
];

/**
 * 单位**种类** —— 判断「不一致」时用它。
 *
 * 「声明 mm、原文 cm」是**硬错**（同一类量纲，单位差 10 倍）；
 * 「声明 s、原文 km/h」不是硬错 —— 那是**旁边另一个数**的单位，
 * 只能判「未核」（我们没找到这个取值的单位），不能判「不一致」。
 */
const UNIT_KIND: Record<string, string> = {
  mm: "长度",
  cm: "长度",
  m: "长度",
  "cm²": "面积",
  "m²": "面积",
  cd: "光度",
  lm: "光通量",
  lx: "照度",
  "cd/m²": "亮度",
  "km/h": "速度",
  "m/s": "速度",
  "%": "比例",
  ms: "时间",
  s: "时间",
  V: "电压",
  "°": "角度",
  N: "力",
};

/** 上标要拍平：'cm<sup>2</sup>' / 'cm²' → 'cm2'。 */
function flattenSup(text: string): string {
  return String(text ?? "")
    .replace(/<sup>\s*2\s*<\/sup>/gi, "2")
    .replace(/²/g, "2");
}

/** 把一个单位写法归一成规范形态（认不出来就返回原样）。 */
export function normalizeUnit(u: string): string {
  const s = String(u ?? "").trim();
  if (!s) return "";
  for (const [aliases, norm] of UNIT_ALIASES) {
    if (aliases.some((a) => a.toLowerCase() === s.toLowerCase())) return norm;
  }
  return s;
}

/** 文本里出现了哪些单位（按别名长短优先，避免 'mm' 被 'm' 抢走）。 */
function unitsIn(text: string): string[] {
  const t = flattenSup(text);
  const out: string[] = [];
  const sorted = [...UNIT_ALIASES].sort((a, b) => b[0].length - a[0].length);
  for (const [aliases, norm] of sorted) {
    const hit = aliases.some((a) => {
      // 拉丁单位要卡边界，但**数字紧挨着单位是常态**（'7000lx'、'1.5s'）
      // —— 所以只挡字母，不挡数字。
      // 后面的那个 lookahead 仍要挡数字：'20' 里的 '0' 不是单位。
      if (/^[a-zA-Z%°\/0-9]+$/.test(a)) {
        return new RegExp(`(?<![A-Za-z])${a.replace("/", "\\/")}(?![A-Za-z])`, "i").test(t);
      }
      return t.includes(a);
    });
    if (hit && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * 取值**紧邻**的那一小段（取值在引文里的位置 ±width 个字）。
 *
 * 为什么不能扫整段引文：引文里常有**别的数、别的单位**
 * （「两个相邻发光单元之间的距离不应小于 600mm，且相邻单元的宽度为 20cm」）——
 * 扫整段会把 'cm' 当成这个取值的单位，判成「不一致」，
 * 而那是个**假警报**（实测 226 格）。
 */
function windowAround(value: string, match: string, width = 12): string {
  const v = String(value ?? "");
  const m = String(match ?? "");
  if (!m) return "";
  const at = v.indexOf(m);
  if (at < 0) return "";
  return v.slice(Math.max(0, at - width), at + m.length + width);
}

/**
 * 行名里的适用条件标记 —— 取最后一个「（…）」里的**字母数字词**。
 *
 * 「终端稳态电压上限（6V 系统）」→「6V」
 * 「制动灯低安装高度门槛（可见度角可减小的条件）」→ 没有字母数字词 → 未核
 *
 * **返回 null = 行名里根本没有括号** → **没有条件可核**（「不适用」✓）。
 * 这两件事以前混在一起，于是 296 个**本来没有条件**的参数
 * 被写成「条件未核」—— 761 处 ✗。
 */
function conditionTokens(rowName: string): string[] | null {
  const m = /[（(]([^）)]*)[）)]\s*$/.exec(String(rowName ?? ""));
  if (!m) return null;
  return [...new Set(m[1].match(/[A-Za-z]*\d+[A-Za-z]*|\d+[A-Za-z]+/g) ?? [])];
}

/** 四个维度的核验状态。 */
export function computeDimensions(
  cell: CorroborationTarget,
  evidence: Corroboration["evidence"],
  numeric: boolean,
): Dimensions {
  // ── 语义配对：证据档直接决定 ──────────────────────────────────────
  let pairing: DimStatus = "未核";
  if (evidence === "excerpt" || evidence === "match") pairing = "已核";
  else if (evidence === "value+clause") pairing = "部分核";
  else if (evidence === "none") pairing = "未核";

  // ── 符号：口径是**从原文紧贴取值的地方**取的 ──────────────────────
  //
  // 三档（以前两档 ✗）：
  //   · 取到口径 → 已核 ✓；
  //   · 原文所在句**有比较词**却没取到 → **未判定** ✓（真缺口 ✓）；
  //   · 原文所在句**根本没有比较词** → **不适用** ✓
  //     （「按 0.1% 的准确度」「单边误差在 50mm 范围内」这类数
  //     本来就不是限值 ✓ —— 标成「未判定」是把「没有」写成「没做」✗）。
  let symbol: DimStatus = "不适用";
  if (cell.comparator) symbol = "已核";
  else if (numeric) {
    symbol = hasComparisonWordNear(cell.value ?? "", cell.match ?? "")
      ? "未判定"
      : "不适用";
  }

  // ── 单位：值的单位与行声明的单位 ──────────────────────────────────
  //
  // **没声明单位**的行（如色度边界，unit 是「—」✓）→ **不适用** ✓
  // （以前一律写「未核」✗ —— 读者会以为「单位没核」✗）。
  let unit: DimStatus = "不适用";
  const declared = normalizeUnit(cell.unit ?? "");
  if (declared) {
    unit = "未核";
    // 只看**取值紧邻**的那一小段：整段引文里常有别的数、别的单位。
    const near = `${cell.match ?? ""} ${windowAround(cell.value ?? "", cell.match ?? "")}`;
    const found = unitsIn(near);
    if (found.includes(declared)) {
      unit = "已核";
    } else if (found.length) {
      // 只有**同量纲**的单位不同才是硬错（声明 mm、原文 cm）。
      // 量纲都不同 → 那是旁边另一个数的单位，只能判「未核」。
      const sameKind = found.some((f) => UNIT_KIND[f] && UNIT_KIND[f] === UNIT_KIND[declared]);
      if (!sameKind) {
        unit = "未核";
      } else {
        // **同量纲但写法不同**：可能是**原文就是另一种写法、已按 spec 换算**
        // （A 草案写「6m」，GB 2019 与 R48 写「6000mm」，矩阵统一按 mm 报）。
        // 换算过的判据是：**原文里的数与报出的数不一样**。
        const rawNum = /(\d+(?:[.,]\d+)?)/.exec(cell.match ?? "")?.[1]?.replace(",", "");
        const reported = (cell.nums ?? []).map((n) => String(n).replace(",", ""));
        const converted = !!rawNum && reported.some((n) => n !== rawNum);
        unit = converted ? "已核" : "不一致";
      }
    }
  }

  // ── 条件：行名带条件标记、且取值原文里能看到同一个标记 ────────────
  //
  // 三档（以前只有两档 ✗）：
  //   · 行名**没有**括号 → **不适用** ✓（319 个参数里只有 23 个带条件 ✓
  //     —— 其余 296 个**本来就没有条件可核** ✗，写成「未核」是误导）；
  //   · 有括号、能自动核、原文里找得到 → 已核 ✓；
  //   · 有括号但核不了（如「车型结构受限」✓）或找不到 → 未核 ✓（老实说）。
  let condition: DimStatus = "不适用";
  const toks = conditionTokens(cell.rowName ?? "");
  if (toks !== null) {
    condition = "未核";
    if (toks.length) {
      const hay = `${cell.match ?? ""} ${cell.value ?? ""}`;
      condition = toks.every((t) => hay.includes(t)) ? "已核" : "未核";
    }
  }

  return { pairing, condition, symbol, unit };
}

/** 从 '第36页' 里取出页码。 */
function citedPage(page: string): number | null {
  const m = /第\s*(\d+)\s*页/.exec(String(page ?? ""));
  return m ? Number(m[1]) : null;
}

export function corroborateCell(
  cell: CorroborationTarget,
  index: SourceIndex | null,
): Corroboration {
  const raw = corroborateCellRaw(cell, index);
  return {
    ...raw,
    dimensions: computeDimensions(cell, raw.evidence, (cell.nums?.length ?? 0) > 0),
  };
}

function corroborateCellRaw(
  cell: CorroborationTarget,
  index: SourceIndex | null,
): Corroboration {
  const empty: Corroboration = {
    status: "unchecked",
    evidence: "none",
    valuePages: [],
    excerptPages: [],
    matchPages: [],
    rarity: 0,
    note: "未复核（该版本没有源 PDF 语料）",
  };
  if (!index || !index.pageNos.length) {
    return { ...empty, note: "未复核：没有该版本的源 PDF 语料" };
  }
  const cited = citedPage(cell.page);
  if (!cited) {
    return { ...empty, note: "未复核：该格没有页码" };
  }
  const at = (no: number) => index.pageNos.indexOf(no);

  // ── 证据一：引文片段 ────────────────────────────────────────────────
  const frag = excerptFragment(cell.value, cell.match);
  const excerptPages: number[] = [];
  if (frag.length >= 8) {
    for (let i = 0; i < index.squashed.length; i++) {
      if (index.squashed[i].includes(frag)) excerptPages.push(index.pageNos[i]);
    }
  }

  // ── 证据二：取值字面量 ──────────────────────────────────────────────
  const cands = valueCandidates(cell.match, cell.nums);
  const valuePages: number[] = [];
  for (let i = 0; i < index.squashed.length; i++) {
    if (cands.some((c) => hasLiteral(index.squashed[i], c))) valuePages.push(index.pageNos[i]);
  }

  // ── 证据一之二：match 本身（标签 + 取值） ────────────────────────────
  //
  // 「引文」那一档查的是 match **往后 14 个字**，那段后文来自 MinerU 的
  // 转写 —— 而转写本身可能是坏的（GB4785-2019 的色度表整段串成一行）。
  // 所以要再查一档：**match 自己**（标签与取值绑在一起的那一小段）
  // 在不在源 PDF 的那一页上。
  //
  // 这一档是**抓「配对错」的那一档**：
  // 「值在页上」只能证明这个数是真的；「标签与值一起在页上」才能证明
  // **这个数配的是那个标签**。串行错位（每个数都是真的，只是配错了对象）
  // 只有这一档能分辨。
  //
  // 长度门槛 8：match 太短（比如 '20mm'、'600'）就只是个数，
  // 找到它证明不了「标签与值的绑定」。
  const matchText = canonicalText(cell.match);
  const matchUsable = matchText.length >= 8;
  const matchPages: number[] = [];
  if (matchUsable) {
    for (let i = 0; i < index.squashed.length; i++) {
      if (index.squashed[i].includes(matchText)) matchPages.push(index.pageNos[i]);
    }
  }

  // ── 证据三：条款号 ──────────────────────────────────────────────────
  const clause = String(cell.clause ?? "").trim();
  const clausePages: number[] = [];
  if (clause) {
    for (let i = 0; i < index.squashed.length; i++) {
      if (hasLiteral(index.squashed[i], clause)) clausePages.push(index.pageNos[i]);
    }
  }

  const citedIdx = at(cited);
  const onExcerpt = citedIdx >= 0 && excerptPages.includes(cited);
  const onMatch = citedIdx >= 0 && matchPages.includes(cited);
  const onValue = citedIdx >= 0 && valuePages.includes(cited);
  const onClause = citedIdx >= 0 && clausePages.includes(cited);

  // 分量：取值（或引文）在全文出现的页占比。
  const denom = index.pageNos.length;
  const rarity = Math.min(
    1,
    (valuePages.length ? valuePages.length : excerptPages.length) / (denom || 1),
  );

  if (onExcerpt) {
    return {
      status: "on-page",
      evidence: "excerpt",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `引文与取值都在源 PDF 第 ${cited} 页`,
    };
  }
  if (onMatch) {
    return {
      status: "on-page",
      evidence: "match",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `标签与取值（${matchText}）在源 PDF 第 ${cited} 页 —— **配对已验**`,
    };
  }
  if (onValue) {
    // 取值与条款号同时落在所报页上 —— 这是人工复核时真正会看的东西：
    // 「翻到第 N 页，看到第 X 条写着那个数」。证据分量比单看取值强得多。
    if (onClause) {
      return {
        status: "on-page",
        evidence: "value+clause",
        valuePages,
        excerptPages,
        matchPages,
        rarity,
        note: `取值与条款 ${clause} 都在源 PDF 第 ${cited} 页（引文措辞与源 PDF 不同）`,
      };
    }
    return {
      status: "on-page",
      evidence: "value",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `取值在源 PDF 第 ${cited} 页（引文措辞与源 PDF 不同）`,
    };
  }
  if (onClause) {
    return {
      status: "on-page",
      evidence: "clause",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `条款 ${clause} 在源 PDF 第 ${cited} 页（取值是英文词展开，页面上是词不是数字）`,
    };
  }
  // 值在文档别处 → 页码不符
  if (valuePages.length) {
    return {
      status: "elsewhere",
      evidence: "value",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `取值在源 PDF 第 ${valuePages.slice(0, 5).join("、")} 页，不在所报的第 ${cited} 页`,
    };
  }
  if (excerptPages.length) {
    return {
      status: "elsewhere",
      evidence: "excerpt",
      valuePages,
      excerptPages,
      matchPages,
      rarity,
      note: `引文在源 PDF 第 ${excerptPages.slice(0, 5).join("、")} 页，不在所报的第 ${cited} 页`,
    };
  }
  return {
    status: "not-found",
    evidence: "none",
    valuePages,
    excerptPages,
    matchPages,
    rarity,
    note: `取值与引文在源 PDF 全篇都查不到（所报第 ${cited} 页）`,
  };
}
