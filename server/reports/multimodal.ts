/**
 * **多模态对比** —— 表 / 图 / 公式，三版之间到底差在哪。
 *
 * ## 为什么单独一层
 *
 * 报告里现在有：**正文散文**（逐条引文 ✓）、**参数矩阵**（数值 ✓）、
 * **图版**（102 张原图 ✓）—— 但它们**各自为政** ✗：
 *
 * - 图**只是摆出来了** ✓，没有说「A 的这张和 B 的那张是不是同一张」✗；
 * - 表**抽成了 markdown** ✓，但没有跨版比 ✗；
 * - 公式**只抄了 LaTeX** ✓，没有跨版比 ✗。
 *
 * 而客户问的恰恰是「**这两版差在哪**」✓ —— 图里、表里、公式里的差异
 * 一个字都没被回答 ✗。
 *
 * ## 三条硬线（与项目其它部分同一口径）
 *
 * 1. **图只能比「像不像」，不能比「是不是同一个要求」** ✗ ——
 *    pHash 对图上改一个尺寸数字**几乎不动** ✓ ⇒ 措辞只能是
 *    「**图像近似**（距离 N）」✓，**不许**写「两版一致」✗。
 * 2. **配不上就说配不上** ✓ —— 没找到近似图的，写「本版未找到近似图
 *    （可能没有、也可能是抽取没抽到）」✓，**不许**当成「该版删除了这张图」✗。
 * 3. **表格抽取串行的不许比** ✗ —— MinerU 会把整表串成一行
 *    （实测 B 版色度表：`WWWW34564561黄紫紫蓝色…` ✓），
 *    拿串行的表比单元格 = **造出假差异** ✗ ⇒ 只登记「未比对 + 原因」✓。
 * 4. **OCR 读出的数不是原文** ✗ —— 源 PDF 文本层在图矩形里**一个字都没有**
 *    （实测 A 38 张 / B 33 张 ✓，字是画进位图的 ✓），图内数字只能 OCR ✓。
 *    而 OCR **会读错**（实测「布局A」→「布局4」✓）⇒ 只报「**疑似不同**」✓：
 *    带单位的数字是主证据 ✓；裸数字单独一档（可能只是图内标号 ✓），措辞更弱 ✗。
 *    **不许**把 OCR 的结果写成「两版一致」✗。
 */

/** OCR 的一处识别结果 —— **不是原文** ✗（会读错），见 `scripts/ocr_figures.py`。 */
export type OcrItem = { text: string; conf: number };

export type FigureRef = {
  file: string;
  page: number;
  w: number;
  h: number;
  phash: string;
  /** 图内文字（OCR）。**undefined** = 这一版没跑 OCR ✓（与「跑过但没字」不同 ✗）。 */
  ocr?: OcrItem[];
};
export type TableRef = {
  page: number;
  caption: string;
  rows: number;
  cols: number;
  scrambled: boolean;
  key: string;
  /** 原始 markdown —— 只给**单元格比对**用 ✓（不印进报告 ✓，太吵 ✗）。 */
  content: string;
};
export type EquationRef = { page: number; latex: string; key: string };

export type MultimodalInventory = {
  version: string;
  figures: FigureRef[];
  tables: TableRef[];
  equations: EquationRef[];
};

export type FigurePair = {
  left: { page: number; file: string };
  right: { page: number; file: string };
  /** Hamming 距离（64 位）。越小越像。 */
  distance: number;
  /** 「图像近似」——**不是**「一致」。 */
  note: string;
  /** 图内**数值**的 OCR 对比 —— pHash 看不见的那一层 ✓。 */
  ocr: FigureOcrDiff;
};

/** OCR 读出的一个**干净**数字（带可选单位）。 */
export type OcrNumber = { value: number; unit: string; raw: string; conf: number };

/** 一个数的「两侧出现次数差」。`a`/`b` 是**次数**，不是数值 ✗。 */
export type NumberCountDiff = { label: string; a: number; b: number };

/**
 * 一对近似图之间的「图内数值」对比结果。
 *
 * **分两档** ✓：
 * - **带单位**（`45°`、`12mm`、`5%`）—— 多半是限值，是**主证据** ✓；
 * - **裸数字**（`80`）—— 多半是限值，但**也可能是图内标号**（`2`、`4`、`7`）✗，
 *   所以单独一档、措辞更弱 ✓。
 */
export type FigureOcrDiff =
  | {
      status: "compared";
      aNumbers: number;
      bNumbers: number;
      /** 两侧次数都一样的带单位数字个数 ✓ */
      same: number;
      /** 带单位数字的次数差（主证据）✓ */
      diffs: NumberCountDiff[];
      bareA: number;
      bareB: number;
      /** 裸数字的次数差 —— **可能只是标号** ✗ */
      bareDiffs: NumberCountDiff[];
      /** 置信度不足、**没参与**的识别处数 ✓（不是「没这个数」✗） */
      lowConf: number;
    }
  | {
      status: "bare-only";
      bareA: number;
      bareB: number;
      bareDiffs: NumberCountDiff[];
      lowConf: number;
    }
  | { status: "no-numbers"; lowConf: number }
  | { status: "one-sided"; side: "a" | "b"; numbers: OcrNumber[]; lowConf: number; bare: number }
  | { status: "skipped"; reason: string };

export type VersionDiff = {
  a: string;
  b: string;
  figures: {
    paired: FigurePair[];
    /** 只在 a 里有近似图之外的图 —— **不是**「b 删了」 ✗ */
    onlyInA: FigureRef[];
    onlyInB: FigureRef[];
    /** 没有 pHash（抽图缺失 / 读不了）—— 明确列出，不参与配对 ✓ */
    unhashable: number;
  };
  tables: {
    paired: Array<{ a: TableRef; b: TableRef; by: "caption" | "header"; cellDiff: TableCellDiff }>;
    onlyInA: TableRef[];
    onlyInB: TableRef[];
    /** 串行表：只登记，不比对 ✓ */
    unscorableA: number;
    unscorableB: number;
  };
  equations: {
    identical: Array<{ a: EquationRef; b: EquationRef }>;
    onlyInA: EquationRef[];
    onlyInB: EquationRef[];
  };
};

/** 图的 pHash 距离阈值 —— ≤ 这个数才算「近似」。 */
export const FIGURE_NEAR_DISTANCE = 10;

/** OCR 置信度门槛 —— 低于它的识别**不参与**比对 ✓（不是「没这个数」✗）。 */
export const OCR_MIN_CONF = 0.6;

/** 全角 → 半角（数字与字母）—— OCR 偶尔吐全角 ✓。 */
function toHalfWidth(s: string): string {
  return String(s ?? "")
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/／/g, "/")
    .replace(/％/g, "%");
}

/**
 * **一处** OCR 文字 → 一个干净数字。
 *
 * ## 为什么这么严
 *
 * 宁可**漏**，不可**错** ✓：只要识别结果里带一点不确定（汉字、未知字母、
 * 多个数字挤在一起），就**整处丢掉** ✗（返回 `null`）。
 *
 * 实测的坑：`布局A` 被读成 `布局4`（带汉字 ⇒ 丢）✓；
 * `2a,26类` 把编号读成数字（未知字母 + 汉字 ⇒ 丢）✓；
 * `功能1的7a` 是图内标号，**不是限值**（汉字 ⇒ 丢）✓。
 *
 * 只有**整处就是一个数 + 可选单位**才收 ✓（`80`、`45°`、`1.2mm`、`12%`）。
 */
export function ocrNumber(item: OcrItem, minConf = OCR_MIN_CONF): OcrNumber | null {
  if (!item || !(Number(item.conf) >= minConf)) return null;
  let t = toHalfWidth(item.text).trim();
  t = t
    .replace(/^[\s,;:：、()（）[\]【】"'“”‘’]+/, "")
    .replace(/[\s,;:：、()（）[\]【】"'“”‘’]+$/, "")
    .replace(/\s+/g, "");
  // 单位按**长的在前**排列 ✓（`km/h` 不能被 `km` 抢走、`mm` 不能被 `m` 抢走）。
  // **不收单字母单位** ✗ —— 实测图内标号 `7a`、`2M`、`3M` 会被读成「7 安」「2 米」✗，
  // 而那几个根本不是量 ✗（`7a` 是配光镜的**视表面标号** ✓）。
  const m =
    /^(\d{1,6}(?:[.,]\d{1,3})?)(km\/h|kcd|cm²|m²|m2|mm|cm|km|kg|min|lx|lm|cd|㎜|°|。|%|h|s)?$/.exec(
      t,
    );
  if (!m) return null;
  let num = m[1];
  // 千分位：`1,200` → 1200 ✓；其余逗号按小数点 ✓（图里的限值不会有其它逗号用法）
  num = /^\d{1,3}(?:,\d{3})+$/.test(num) ? num.replace(/,/g, "") : num.replace(/,/g, ".");
  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  const rawUnit = m[2] ?? "";
  const unit =
    rawUnit === "。"
      ? "°" // OCR 把度号读成句号 ✓（实测 `45。` conf 0.92 ✓）——
      : rawUnit === "㎜"
        ? "mm"
        : rawUnit === "m2"
          ? "m²"
          : rawUnit;
  return { value, unit, raw: item.text, conf: Number(item.conf) };
}

function labelOf(n: OcrNumber): string {
  return `${n.value}${n.unit}`;
}

/**
 * 一对近似图的**图内数值**对比（OCR 层 ✓）。
 *
 * ## 界线（与 pHash 层同一条思路）
 *
 * 比的是「**OCR 读出来的数字**」，不是「图上的数字」✗ ——
 * OCR 会读错（实测 `布局A`→`布局4`）✓、会漏读 ✓。
 * 所以：
 * - 只有**一侧**读出数字 ⇒ `one-sided` ✓（是「**提示**」，不是「那版删了这个数」✗）；
 * - 两侧都读不出 ⇒ `no-numbers` ✓（**不比**，不写「相同」✗）；
 * - 任一侧**整张图一个字都没读出** ⇒ `skipped` ✓（多半是 OCR 失败，不是图没字 ✗）。
 *
 * 比的是**次数多重集** ✓ —— 同一张图里 `80°` 出现三次和出现两次是**不同**的 ✓。
 */
export function compareFigureOcr(
  a?: OcrItem[],
  b?: OcrItem[],
  minConf = OCR_MIN_CONF,
): FigureOcrDiff {
  if (!a || !b) {
    return {
      status: "skipped",
      reason: "这张图没有 OCR 结果（未跑 scripts/ocr_figures.py，或图是新抽的）",
    };
  }
  const lowConf =
    a.filter((i) => !(Number(i.conf) >= minConf)).length +
    b.filter((i) => !(Number(i.conf) >= minConf)).length;
  if (!a.length || !b.length) {
    return {
      status: "skipped",
      reason: `${!a.length ? "A" : "B"} 侧 OCR 一个字都没读出（多半是识别失败，不是图里没字）`,
    };
  }
  const na = a.map((i) => ocrNumber(i, minConf)).filter((x): x is OcrNumber => !!x);
  const nb = b.map((i) => ocrNumber(i, minConf)).filter((x): x is OcrNumber => !!x);
  const ua = na.filter((n) => n.unit);
  const ub = nb.filter((n) => n.unit);
  const ba = na.filter((n) => !n.unit);
  const bb = nb.filter((n) => !n.unit);
  if (!na.length && !nb.length) return { status: "no-numbers", lowConf };
  // **只有一侧**有带单位的数字 ⇒ 提示 ✓（不是「那版删了这个数」✗）
  if (ua.length && !ub.length && !bb.length) {
    return { status: "one-sided", side: "a", numbers: ua, lowConf, bare: ba.length };
  }
  if (ub.length && !ua.length && !ba.length) {
    return { status: "one-sided", side: "b", numbers: ub, lowConf, bare: bb.length };
  }
  if (!ua.length && !ub.length) {
    // 两侧都只有裸数字 ⇐ 只做**弱对比** ✓（可能全是标号 ✗）
    const d = diffMultisets(ba, bb);
    return { status: "bare-only", bareA: ba.length, bareB: bb.length, bareDiffs: d.diffs, lowConf };
  }
  const du = diffMultisets(ua, ub);
  const db = diffMultisets(ba, bb);
  return {
    status: "compared",
    aNumbers: ua.length,
    bNumbers: ub.length,
    same: du.same,
    diffs: du.diffs,
    bareA: ba.length,
    bareB: bb.length,
    bareDiffs: db.diffs,
    lowConf,
  };
}

/** 两个数字列表的**次数多重集**差异。 */
function diffMultisets(
  xs: OcrNumber[],
  ys: OcrNumber[],
): { same: number; diffs: NumberCountDiff[] } {
  const count = (arr: OcrNumber[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const x of arr) m.set(labelOf(x), (m.get(labelOf(x)) ?? 0) + 1);
    return m;
  };
  const ma = count(xs);
  const mb = count(ys);
  const labels = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => {
    // 数字按大小排 ✓（`9` 不应排在 `80` 后面 ✗）
    const nx = Number(x.replace(/[^\d.]/g, ""));
    const ny = Number(y.replace(/[^\d.]/g, ""));
    return nx - ny || x.localeCompare(y);
  });
  const diffs: NumberCountDiff[] = [];
  let same = 0;
  for (const k of labels) {
    const ca = ma.get(k) ?? 0;
    const cb = mb.get(k) ?? 0;
    same += Math.min(ca, cb);
    if (ca !== cb) diffs.push({ label: k, a: ca, b: cb });
  }
  return { same, diffs };
}

/** 64 位十六进制 pHash 的 Hamming 距离。 */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let x = 0n;
  try {
    x = BigInt("0x" + a) ^ BigInt("0x" + b);
  } catch {
    return 64;
  }
  let n = 0;
  while (x > 0n) {
    if (x & 1n) n++;
    x >>= 1n;
  }
  return n;
}

/**
 * 表格是不是**串行**了（MinerU 把整表挤成一行）。
 *
 * 判据：连续 6 个以上**重复的汉字**（`WWWW34564561黄紫紫蓝色…` ✓），
 * 或者某一"行"里的字符数是列数的 20 倍以上 ✓。
 * 这两种都是抽取坏了 ✓ —— **不是**原文如此 ✗。
 */
export function looksScrambled(content: string): boolean {
  const s = String(content ?? "");
  // ① 同一字连出 6 个（`WWWWWW`）—— 极端的重复 ✓
  if (/([\s\S])\1{5,}/.test(s) && /[A-Za-z一-鿿]/.test(s)) return true;
  // ② **相邻重复的两字组** —— 实测样本就是这么坏的 ✓：
  //    `…黄色边界边界界界…`「色边色边」「边界边界」✓。
  //    （正常法规文字里几乎不会出现「两个字重复两遍」✓）
  if (/([一-鿿]{2})\1/.test(s)) return true;
  // ③ 单个单元里塞了**几百字** ✓ —— 整表被挤进一格 ✓
  const lines = s.split("\n").filter((l) => l.trim().startsWith("|"));
  for (const l of lines) {
    for (const cell of l.split("|").slice(1, -1)) {
      if (cell.replace(/\s+/g, "").length > 300) return true;
    }
  }
  return false;
}

/** 从 markdown 表格里数行列（跳过 `| --- |` 分隔行）。 */
export function tableShape(content: string): { rows: number; cols: number } {
  const rows = String(content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l));
  const cols = rows.length ? Math.max(...rows.map((r) => r.split("|").length - 2)) : 0;
  return { rows: rows.length, cols };
}

/**
 * 归一化表头 → 指纹（用于跨版配对）。
 *
 * **必须同时有题注或表头文字** ✓ —— 只按「行×列」配是**瞎配** ✗：
 * 实测会配出 `A p16 ↔ C p2` 这种明显不对的对子 ✗（三版页数体系完全不同 ✓，
 * 同样的 3×4 到处都是 ✗）。
 *
 * 没有题注、也没有可读表头 ⇒ **不给指纹**（`""`）⇒ **不参与配对** ✓
 * （宁可空着，不可错着 ✓）。
 */
export function tableKey(caption: string, content: string): string {
  const cap = String(caption ?? "").replace(/\s+/g, "").trim();
  if (cap) return "cap:" + cap.slice(0, 60);
  const lines = String(content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|[\s:|-]+\|$/.test(l));
  const header = (lines[0] ?? "").replace(/^\||\|$/g, "");
  const cells = header
    .split("|")
    .map((c) => c.replace(/\s+/g, "").trim())
    .filter(Boolean);
  // 表头至少要有两个**可读**单元（汉字/字母 ≥ 2 个字）✓ —— 否则是空表或数字表 ✗
  const readable = cells.filter((c) => /[一-鿿]|[A-Za-z]/.test(c) && c.length >= 2);
  if (readable.length < 2) return "";
  const { rows, cols } = tableShape(content);
  return `hdr:${rows}x${cols}:${cells.join("|").slice(0, 80)}`;
}

/**
 * 公式归一化 —— 只抹**写法差异**，不抹**内容** ✓。
 *
 * 抹：空白、`\mathrm{}` / `\text{}` 的外壳、`\left` `\right`。
 * 不抹：数字、比较符、上下标、分数结构。
 */
export function normalizeLatex(latex: string): string {
  let s = String(latex ?? "");
  // **先抹掉结构外壳** ✓ —— 不抹的话 `\begin{array}{l}` 会留在指纹里 ✗，
  // 同一道公式在 A 是单行、在 B 被并成 array ✓ ⇒ 永远配不上 ✗。
  s = s.replace(/\\begin\{[^}]*\}(?:\{[^}]*\})?/g, "");
  s = s.replace(/\\end\{[^}]*\}/g, "");
  s = s.replace(/\\\\/g, " "); // 数组的行分隔 ✓
  s = s.replace(/\\tag\{[^}]*\}/g, ""); // 公式编号是**标签**，不是内容 ✓（三版编号本来不同 ✓）
  s = s.replace(/\\label\{[^}]*\}/g, "");
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\(?:mathrm|mathbf|mathit|mathsf|text|operatorname)\s*\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\(?:quad|qquad|,|;|:|!|\s)/g, "");
  s = s.replace(/\s+/g, "");
  return s;
}

/** 一格里的一处差异 —— **文本**不同，不代表要求不同 ✗。 */
export type CellChange = {
  row: number;
  col: number;
  a: string;
  b: string;
};

/** 单元格级差异的结果。 */
export type TableCellDiff =
  | {
      status: "compared";
      changes: CellChange[];
      changed: number;
      total: number;
      /** 抽取串行、**没参与比对**的格数 ✓（不是「相同」✗） */
      unscorable: number;
      note: string;
    }
  | { status: "skipped"; reason: string };

/**
 * **一格**是不是抽取串行了。
 *
 * 这是逐格判据 ✓ —— 整表判据（`looksScrambled`）会漏：
 * 实测 B 版色度表整表没被判串行 ✗，但格子里是 `WW23 00..451478` ✗（明显坏了 ✗）。
 *
 * 判据：
 * - 连出两个点（`00..451478`）✓ —— OCR 把小数点与数字挤在一起 ✓；
 * - 同一个**大写字母**连出 3 个（`FRRR`）✓ —— 合并单元的标签被重复拼接 ✓；
 * - 同一个汉字连出 3 个 ✓。
 */
export function looksGarbledCell(s: string): boolean {
  const t = String(s ?? "");
  if (/\.\./.test(t)) return true;
  if (/([A-Z])\1{2,}/.test(t)) return true;
  if (/([一-鿿])\1{2,}/.test(t)) return true;
  return false;
}

/** 把 markdown 表格解析成二维单元（只收 `|` 行，丢掉分隔行）。 */
export function parseTableCells(content: string): string[][] {
  return String(content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|[\s:|-]+\|$/.test(l))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

/** 单元归一化：只抹**写法**（空白、全半角、常见单位写法），不抹数字 ✓。 */
export function normCell(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\$|\\(?:mathrm|text|quad|,|;)/g, "")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/[：]/g, ":")
    .replace(/[％]/g, "%")
    .replace(/㎜/g, "mm")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * 两表**单元格级**比对。
 *
 * ## 什么时候**不比**
 *
 * 任何一条不满足，就返回 `skipped` + 原因 ✓ —— **不猜** ✗：
 * - 任一边串行（抽取坏了）✗；
 * - 行数或列数不同 ✗（结构变了 ⇒ 逐格对读没有意义 ✗）；
 * - 有一边是空表 ✗。
 *
 * ## 比出来的是什么
 *
 * **文本**不同 ✓ —— 带行号列号与两边原文 ✓。
 * 它**不是**「要求不同」✗：可能只是写法差异（`㎜` vs `mm`、公式排版 ✓）。
 * 所以措辞必须是「文本不同，须人工判断是否实质」✓。
 */
export function diffTableCells(aContent: string, bContent: string): TableCellDiff {
  const A = parseTableCells(aContent);
  const B = parseTableCells(bContent);
  if (!A.length || !B.length) return { status: "skipped", reason: "有一边解析不出表格" };
  if (A.length !== B.length || A[0].length !== B[0].length) {
    return {
      status: "skipped",
      reason: `行×列不同（${A.length}×${A[0]?.length} vs ${B.length}×${B[0]?.length}）—— 结构变了，逐格对读没有意义`,
    };
  }
  const changes: CellChange[] = [];
  let total = 0;
  let unscorable = 0;
  let dataComparable = 0;
  for (let r = 0; r < A.length; r++) {
    for (let c = 0; c < A[r].length; c++) {
      const a = A[r][c] ?? "";
      const b = B[r][c] ?? "";
      // **一格坏了就不比这一格** ✓ —— 拿乱码当「B 原文」印出去 ✗
      // 比「少一格」更糟 ✗（读者会以为那就是标准原文 ✗）。
      if (looksGarbledCell(a) || looksGarbledCell(b)) {
        unscorable++;
        continue;
      }
      total++;
      if (r > 0) dataComparable++;
      const x = normCell(a);
      const y = normCell(b);
      if (x !== y) changes.push({ row: r + 1, col: c + 1, a, b });
    }
  }
  // **数据行一格都比不了** ⇒ 整表跳过 ✓ —— 只剩表头「相同」没有任何意义 ✗
  if (dataComparable === 0) {
    return { status: "skipped", reason: "数据行全部判为抽取串行 —— 只剩表头能比，不比" };
  }
  return {
    status: "compared",
    changes,
    changed: changes.length,
    total,
    unscorable,
    note:
      "**文本**不同 —— 可能只是写法差异（单位/公式排版）✗，须人工判断是否实质 ✗" +
      (unscorable ? `；另有 ${unscorable} 格**抽取串行、没比** ✗` : ""),
  };
}

/** 版本 → 素材清单。图的 pHash 由 `scripts/hash_figures.py` 先算好 ✓。 */
export function buildInventory(
  version: string,
  data: any,
  hashes: Record<string, { phash?: string; w?: number; h?: number }> = {},
  gallery?: { dir: string; pages: Record<string, Array<{ file: string; w: number; h: number }>> } | null,
  /** `reports/figure-ocr.json` 的 `images` 部分（按图路径索引）✓ */
  ocr?: Record<string, { items?: OcrItem[] }> | null,
): MultimodalInventory {
  const figures: FigureRef[] = [];
  if (gallery) {
    for (const [p, files] of Object.entries(gallery.pages ?? {})) {
      for (const f of files) {
        const rel = `${gallery.dir}/${f.file}`;
        const h = hashes[rel];
        const items = ocr?.[rel]?.items;
        figures.push({
          file: rel,
          page: Number(p),
          w: f.w,
          h: f.h,
          phash: h?.phash ?? "",
          // 没跑 OCR 的图**不挂空数组** ✗ —— `[]` 会被当成「跑过、图上没字」✗
          ...(items ? { ocr: items } : {}),
        });
      }
    }
  }
  const tables: TableRef[] = (data?.tables ?? []).map((t: any) => {
    const { rows, cols } = tableShape(t.content ?? "");
    return {
      page: Number(t.page),
      caption: String(t.caption ?? ""),
      rows,
      cols,
      scrambled: looksScrambled(t.content ?? ""),
      key: tableKey(t.caption ?? "", t.content ?? ""),
      content: String(t.content ?? ""),
    };
  });
  const equations: EquationRef[] = (data?.equations ?? [])
    .map((e: any) => ({ page: Number(e.page), latex: String(e.latex ?? "") }))
    .filter((e: EquationRef) => e.latex.trim())
    .map((e: EquationRef) => ({ ...e, key: normalizeLatex(e.latex) }));
  return { version, figures, tables, equations };
}

/**
 * 两版之间配对。
 *
 * **图**：pHash 距离 ≤ 10 且长宽比接近（0.6–1.7 倍）才配 ✓ ——
 * 一对一配（贪心，按距离从近到远 ✓），配过的两边都不再参与 ✓。
 *
 * **表**：先按题注指纹 ✓；没有题注的按「行×列」唯一匹配 ✓；
 * 串行表**不参与** ✓。
 *
 * **公式**：归一化后**完全相同**才算对 ✓（不判「近似公式」✗ —— 那要语义 ✗）。
 */
export function diffVersions(invA: MultimodalInventory, invB: MultimodalInventory): VersionDiff {
  // ---- 图 ----
  const aFigs = invA.figures.filter((f) => f.phash);
  const bFigs = invB.figures.filter((f) => f.phash);
  const unhashable = invA.figures.length - aFigs.length + (invB.figures.length - bFigs.length);
  const cands: Array<{ d: number; a: FigureRef; b: FigureRef }> = [];
  for (const a of aFigs) {
    for (const b of bFigs) {
      const ar1 = a.w / Math.max(1, a.h);
      const ar2 = b.w / Math.max(1, b.h);
      const ratio = ar1 / Math.max(1e-6, ar2);
      if (ratio < 0.6 || ratio > 1.7) continue; // 长宽比差太多 ⇒ 肯定不是同一张 ✓
      const d = hamming(a.phash, b.phash);
      if (d <= FIGURE_NEAR_DISTANCE) cands.push({ d, a, b });
    }
  }
  cands.sort((x, y) => x.d - y.d);
  const usedA = new Set<string>();
  const usedB = new Set<string>();
  const paired: FigurePair[] = [];
  for (const c of cands) {
    if (usedA.has(c.a.file) || usedB.has(c.b.file)) continue;
    usedA.add(c.a.file);
    usedB.add(c.b.file);
    paired.push({
      left: { page: c.a.page, file: c.a.file },
      right: { page: c.b.page, file: c.b.file },
      distance: c.d,
      note:
        `图像近似（pHash 距离 ${c.d} / 64）—— ` +
        "「近似」**不是**「一致」：pHash 看不出图内数字/标注有没有变 ✗，另由 OCR 提示（会读错）✗",
      // **图内数值**在配对之后另算 ✓ —— 用 OCR，不靠 pHash ✓
      ocr: compareFigureOcr(c.a.ocr, c.b.ocr),
    });
  }
  const onlyInA = aFigs.filter((f) => !usedA.has(f.file));
  const onlyInB = bFigs.filter((f) => !usedB.has(f.file));

  // ---- 表 ----
  const tA = invA.tables.filter((t) => !t.scrambled);
  const tB = invB.tables.filter((t) => !t.scrambled);
  const pairedTables: VersionDiff["tables"]["paired"] = [];
  const ua = new Set<number>();
  const ub = new Set<number>();
  const idxA = new Map(tA.map((t, i) => [i, t]));
  const idxB = new Map(tB.map((t, i) => [i, t]));
  // **只按指纹配** ✓ —— 题注或**可读表头**（`tableKey` 里已经保证）✓。
  // 没有指纹的表**不配对** ✗（只按行×列配会瞎配 ✓ —— 实测配出过 `A p16 ↔ C p2` ✗）。
  for (const [ia, ta] of idxA) {
    if (!ta.key) continue;
    for (const [ib, tb] of idxB) {
      if (ub.has(ib) || tb.key !== ta.key) continue;
      ua.add(ia);
      ub.add(ib);
      pairedTables.push({
        a: ta,
        b: tb,
        by: ta.key.startsWith("cap:") ? "caption" : "header",
        // **配对之后才比单元格** ✓ —— 结构/串行不满足就 `skipped` + 原因 ✓
        cellDiff: diffTableCells(ta.content, tb.content),
      });
      break;
    }
  }
  const onlyTblA = [...idxA].filter(([i]) => !ua.has(i)).map(([, t]) => t);
  const onlyTblB = [...idxB].filter(([i]) => !ub.has(i)).map(([, t]) => t);

  // ---- 公式 ----
  const keyedA = new Map<string, EquationRef[]>();
  for (const e of invA.equations) keyedA.set(e.key, [...(keyedA.get(e.key) ?? []), e]);
  const eqIdentical: VersionDiff["equations"]["identical"] = [];
  const usedEqB = new Set<number>();
  for (const e of invB.equations) {
    const pool = keyedA.get(e.key) ?? [];
    if (pool.length) {
      eqIdentical.push({ a: pool.shift()!, b: e });
      usedEqB.add(invB.equations.indexOf(e));
    }
  }
  const matchedAKeys = new Set(eqIdentical.map((p) => p.a.key));
  const onlyEqA = invA.equations.filter((e) => !matchedAKeys.has(e.key));
  const onlyEqB = invB.equations.filter((_, i) => !usedEqB.has(i));

  return {
    a: invA.version,
    b: invB.version,
    figures: { paired, onlyInA, onlyInB, unhashable },
    tables: {
      paired: pairedTables,
      onlyInA: onlyTblA,
      onlyInB: onlyTblB,
      unscorableA: invA.tables.filter((t) => t.scrambled).length,
      unscorableB: invB.tables.filter((t) => t.scrambled).length,
    },
    equations: { identical: eqIdentical, onlyInA: onlyEqA, onlyInB: onlyEqB },
  };
}

/**
 * 表格单元里的文本 → 一行可印的字 ✓。
 *
 * **不转义 HTML** ✗ —— 报告的渲染层会自己转义 ✓，这里再转一次就是**双重转义** ✗。
 * 只做两件事：把 `|` 换成全角 ✓（否则会把 markdown 表切坏 ✗）、压掉换行与空白 ✓。
 */
function cellText(s: string, max = 60): string {
  return String(s ?? "")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** 把两版差异写成 markdown（报告里直接嵌 ✓）。 */
export function renderVersionDiff(d: VersionDiff): string {
  const { a, b } = d;
  const out: string[] = [];
  out.push(`### ${a} ↔ ${b}`, "");

  // 图
  out.push(
    `**图**：近似同图 **${d.figures.paired.length}** 对 · ` +
      `只有 ${a} **${d.figures.onlyInA.length}** 张 · 只有 ${b} **${d.figures.onlyInB.length}** 张` +
      (d.figures.unhashable ? ` · **${d.figures.unhashable} 张算不了指纹（不参与）**` : ""),
    "",
  );
  if (d.figures.paired.length) {
    // **图内数值（OCR）** —— pHash 看不见的那一层 ✓。
    const fmtDiffs = (ds: NumberCountDiff[]): string =>
      ds
        .slice(0, 3)
        .map((x) => `${x.label}（A ${x.a} / B ${x.b}）`)
        .join("、") + (ds.length > 3 ? ` 等 ${ds.length} 处` : "");
    const ocrCell = (o: FigureOcrDiff): string => {
      if (o.status === "compared") {
        const weak = o.bareDiffs.length
          ? `；裸数字另有 **${o.bareDiffs.length} 处**不同（可能只是标号 ✗）`
          : "";
        if (!o.diffs.length) {
          return `带单位数字相同（A ${o.aNumbers} / B ${o.bNumbers} 个）${weak}`;
        }
        return (
          `**疑似不同**：${fmtDiffs(o.diffs)}` +
          (o.bareDiffs.length ? `；裸数字另有 ${o.bareDiffs.length} 处不同（可能只是标号 ✗）` : "")
        );
      }
      if (o.status === "bare-only") {
        return o.bareDiffs.length
          ? `只有裸数字：**${o.bareDiffs.length} 处**不同（**可能只是标号** ✗）`
          : `只有裸数字：相同（A ${o.bareA} / B ${o.bareB} 个，**可能只是标号** ✗）`;
      }
      if (o.status === "one-sided") {
        const list = o.numbers.slice(0, 3).map(labelOf).join("、");
        return `只有 ${o.side.toUpperCase()} 读出带单位的数字（${list}${o.numbers.length > 3 ? "…" : ""}）`;
      }
      if (o.status === "no-numbers") return "两侧都读不出数字";
      return `未比（${o.reason}）`;
    };
    out.push(
      `| ${a} 页 | ${b} 页 | 距离 | 图内数值（OCR） |`,
      "|---|---|---|---|",
    );
    for (const p of d.figures.paired) {
      out.push(`| p${p.left.page} | p${p.right.page} | ${p.distance} | ${ocrCell(p.ocr)} |`);
    }
    out.push("");
    const oc = d.figures.paired.map((p) => p.ocr);
    const sameN = oc.filter((o) => o.status === "compared" && !o.diffs.length).length;
    const susN = oc.filter((o) => o.status === "compared" && o.diffs.length > 0).length;
    const oneN = oc.filter((o) => o.status === "one-sided").length;
    const noneN = oc.filter((o) => o.status === "no-numbers").length;
    const skipN = oc.filter((o) => o.status === "skipped").length;
    const bareOnlyN = oc.filter((o) => o.status === "bare-only").length;
    const bareWeakN = oc.reduce((s, o) => {
      if (o.status === "compared" || o.status === "bare-only") return s + o.bareDiffs.length;
      return s;
    }, 0);
    out.push(
      `**图内数值（OCR）**：配对 ${oc.length} 对 —— 两侧带单位数字相同 **${sameN}** · ` +
        `**疑似不同 ${susN}** · 只有一侧读出 **${oneN}** · 只有裸数字 **${bareOnlyN}** · ` +
        `读不出 **${noneN}** · 未比 **${skipN}**` +
        (bareWeakN
          ? ` · 裸数字差异 **${bareWeakN} 处**（分不清是限值还是图内标号 ✗，**仅供参考**）`
          : ""),
      "",
    );
    if (oc.length) {
      out.push(
        `> 图内数值来自 **OCR**（置信度 ≥ ${OCR_MIN_CONF}、只收「整处就是一个数 + 可选单位」的识别）✓ —— ` +
          "OCR **会读错**（实测「布局A」读成「布局4」）✗、**会漏读** ✗，",
        "> 所以「疑似不同」**只是提示**，**不是**结论；「相同」也**不是**原文一致的证明 ✗。须对照原图 ✗。",
        "",
      );
    }
  }
  if (d.figures.onlyInA.length || d.figures.onlyInB.length) {
    out.push(
      `> 只出现在一版的图 = **本版未找到近似图** ✓ —— ` +
        "可能是该版确实没有、也可能是图没抽出来 ✗；**不能据此说「删除了这张图」** ✗。",
      "",
    );
    if (d.figures.onlyInA.length) {
      out.push(`- 只有 ${a}：` + d.figures.onlyInA.map((f) => `p${f.page}`).join("、"));
    }
    if (d.figures.onlyInB.length) {
      out.push(`- 只有 ${b}：` + d.figures.onlyInB.map((f) => `p${f.page}`).join("、"));
    }
    out.push("");
  }

  // 表
  out.push(
    `**表**：配成 **${d.tables.paired.length}** 对 · ` +
      `只有 ${a} **${d.tables.onlyInA.length}** · 只有 ${b} **${d.tables.onlyInB.length}**` +
      (d.tables.unscorableA + d.tables.unscorableB
        ? ` · **串行表未比对 ${d.tables.unscorableA + d.tables.unscorableB} 张**（抽取坏了 ✗）`
        : ""),
    "",
  );
  if (d.tables.paired.length) {
    out.push(`| ${a} 页 | ${b} 页 | 依据 | 单元格文本 |`, "|---|---|---|---|");
    for (const p of d.tables.paired) {
      const cell =
        p.cellDiff.status === "compared"
          ? (p.cellDiff.changed === 0
              ? "**全部相同**"
              : `**${p.cellDiff.changed} / ${p.cellDiff.total} 格不同**`) +
            (p.cellDiff.unscorable ? ` · ${p.cellDiff.unscorable} 格串行未比` : "")
          : `未比（${p.cellDiff.reason.slice(0, 24)}…）`;
      out.push(`| p${p.a.page} | p${p.b.page} | ${p.by === "caption" ? "题注" : "可读表头"} | ${cell} |`);
    }
    out.push("");
    // **逐格差异只印前 6 处** ✓ —— 全印会把报告撑爆 ✗，而且读者也看不完 ✗
    const withChanges = d.tables.paired.filter(
      (p) => p.cellDiff.status === "compared" && p.cellDiff.changed > 0,
    );
    for (const p of withChanges.slice(0, 3)) {
      if (p.cellDiff.status !== "compared") continue;
      out.push(
        `**表 p${p.a.page} ↔ p${p.b.page}** 的单元格文本差异（前 ${Math.min(6, p.cellDiff.changed)} 处，共 ${p.cellDiff.changed}）：`,
        "",
        `| 行 | 列 | ${a} | ${b} |`,
        "|---|---|---|---|",
      );
      for (const c of p.cellDiff.changes.slice(0, 6)) {
        out.push(`| ${c.row} | ${c.col} | ${cellText(c.a)} | ${cellText(c.b)} |`);
      }
      out.push("");
    }
    out.push(
      `> 单元格差异是**文本**不同 ✓ —— 可能只是写法（\`㎜\` vs \`mm\`、公式排版）✗，` +
        "**须人工判断是否实质变化** ✗。",
      "",
    );
  }

  // 公式
  out.push(
    `**公式**：归一化后**完全相同** **${d.equations.identical.length}** 个 · ` +
      `只在 ${a} **${d.equations.onlyInA.length}** · 只在 ${b} **${d.equations.onlyInB.length}**`,
    "",
  );
  if (d.equations.onlyInA.length) {
    out.push(`- 只在 ${a}：` + d.equations.onlyInA.map((e) => `p${e.page}`).join("、"));
  }
  if (d.equations.onlyInB.length) {
    out.push(`- 只在 ${b}：` + d.equations.onlyInB.map((e) => `p${e.page}`).join("、"));
  }
  out.push("");
  return out.join("\n");
}
