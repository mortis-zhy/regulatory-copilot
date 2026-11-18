/**
 * 多模态对比（表 / 图 / 公式）的**已知答案**用例 —— **不调模型** ✓、不读真语料 ✓。
 *
 * 判据（三条硬线）：
 * 1. **图像近似 ≠ 一致** —— pHash 距离只说明「像」，文案必须留这条界线；
 * 2. **配不上就说配不上** —— 只按「行×列」配是**瞎配**（实测配出过 A p16 ↔ C p2）；
 * 3. **串行的表不许比** —— MinerU 把整表挤成一行时，比单元格 = 造假差异。
 */
import assert from "node:assert/strict";
import {
  hamming,
  looksScrambled,
  tableKey,
  normalizeLatex,
  diffVersions,
  diffTableCells,
  parseTableCells,
  normCell,
  looksGarbledCell,
  FIGURE_NEAR_DISTANCE,
} from "./dist/multimodal.js";

let n = 0;
const ok = (cond, msg) => {
  n++;
  assert.ok(cond, msg);
};

console.log("\n[test-multimodal] 表 / 图 / 公式的跨版对比");

// ① pHash 距离
ok(hamming("0000000000000000", "0000000000000000") === 0, "同一哈希距离应为 0");
ok(hamming("0000000000000000", "0000000000000001") === 1, "差一位距离应为 1");
ok(hamming("ffffffffffffffff", "0") === 64, "长度不合法应回 64（不参与配对）");

// ② 串行表识别（实测样本 ✓）
ok(
  looksScrambled("| 颜色 | 边界 |\n| --- | --- |\n| 白色 | WWWW34564561黄紫紫蓝色红色色边色边边界边界界界 |"),
  "实测的串行表没被认出来",
);
ok(
  !looksScrambled("| 颜色 | 色度区域边界 | 边界交点 |\n| --- | --- | --- |\n| 白色 | W12绿色边界 | x y |"),
  "正常的表被误判成串行",
);

// ③ 表格指纹：**没有可读表头/题注 ⇒ 不给指纹**（不参与配对）✓
ok(tableKey("表 5 光色", "x") === "cap:表5光色", "有题注时应以题注为准");
const weak = tableKey("", "| 1 | 2 | 3 |\n| --- | --- | --- |\n| 4 | 5 | 6 |");
ok(weak === "", "纯数字表头不应给出指纹（否则会瞎配）");
const strong = tableKey("", "| 颜色 | 色度区域边界 | 边界交点 |\n| --- | --- | --- |\n| 白色 | W12 | x y |");
ok(strong.startsWith("hdr:") && strong.includes("颜色"), "可读表头应给出指纹");

// ④ 公式归一化：外壳/编号抹掉，**数字与结构不抹** ✓
const f1 = "h \\leqslant 0.8 \\quad \\text {限值：} -1.0\\% \\sim -3.0\\%";
const f1b = "\\mathrm{h} \\leqslant 0.8 \\quad \\text{限值：} -1.0\\% \\sim -3.0\\%";
ok(normalizeLatex(f1) === normalizeLatex(f1b), "同一公式的写法差异没被抹平");
const arr = "\\begin{array}{l} \\text{限值}: -1.0\\% \\\\ \\text{初始照准}: -1.5\\% \\end{array}";
ok(!/begin|end|\\\\/.test(normalizeLatex(arr)), "array 外壳没被抹掉");
ok(
  normalizeLatex("\\frac{a}{b}\\tag{1}") === normalizeLatex("\\frac{a}{b}"),
  "公式编号（tag）应被抹掉",
);
ok(
  normalizeLatex("h \\leqslant 0.8") !== normalizeLatex("h \\leqslant 0.9"),
  "**数字被抹掉**了 —— 那是内容，不能抹",
);

// ⑤ 配对：图只配近似且一对一；表只按指纹配（形状相同不配）
const fig = (p, hash, w = 1000, h = 800) => ({ file: `f${p}.png`, page: p, w, h, phash: hash });
const invA = {
  version: "A",
  figures: [fig(10, "0000000000000000"), fig(11, "ffffffffffffffff")],
  tables: [
    { page: 5, caption: "", rows: 3, cols: 3, scrambled: false, key: "hdr:3x3:颜色|边界|x" },
    { page: 6, caption: "", rows: 2, cols: 2, scrambled: false, key: "" },
  ],
  equations: [{ page: 7, latex: "a+b", key: normalizeLatex("a+b") }],
};
const invB = {
  version: "B",
  figures: [fig(20, "0000000000000000"), fig(21, "fffffffffffffffe")], // 第二张与 A 的第二张只差 1 位 ✓
  tables: [
    { page: 9, caption: "", rows: 3, cols: 3, scrambled: false, key: "hdr:3x3:颜色|边界|x" },
    // **同一个 2×2 形状**但**没有指纹** ⇒ 不许配 ✓
    { page: 10, caption: "", rows: 2, cols: 2, scrambled: false, key: "" },
  ],
  equations: [{ page: 30, latex: "a + b", key: normalizeLatex("a + b") }],
};
const d = diffVersions(invA, invB);
ok(d.figures.paired.length === 2, `图应配成 2 对，实得 ${d.figures.paired.length}`);
ok(
  d.figures.paired.every((p) => p.distance <= FIGURE_NEAR_DISTANCE),
  "配成对的距离超了阈值",
);
ok(
  d.figures.paired.every((p) => p.note.includes("近似") && p.note.includes("不是")),
  "图的说明没有写清「近似 ≠ 一致」",
);
ok(d.tables.paired.length === 1, `表只应按指纹配 1 对，实得 ${d.tables.paired.length}`);
ok(d.tables.onlyInA.length === 1 && d.tables.onlyInB.length === 1, "没有指纹的表应算「未配对」");
ok(d.equations.identical.length === 1, "写法不同但内容相同的公式应配上");

// ⑥ 串行表**不参与**配对 ✓
const invC = {
  version: "C",
  figures: [],
  tables: [{ page: 1, caption: "表 1", rows: 3, cols: 3, scrambled: true, key: "cap:表1" }],
  equations: [],
};
const d2 = diffVersions(invA, invC);
ok(d2.tables.unscorableB === 1 && d2.tables.paired.length === 0, "串行表被拿去配对了");

// ⑦ **单元格级**表 diff —— 只在「结构一致」时比 ✓，而且**只说文本不同** ✗
const tA = "| 参数 | A 版 | B 版 |\n| --- | --- | --- |\n| 高度 | 350㎜ | 400mm |";
const tB = "| 参数 | A 版 | B 版 |\n| --- | --- | --- |\n| 高度 | 350mm | 400mm |";
ok(parseTableCells(tA).length === 2, "表头与数据行应解析成 2 行");
ok(normCell("350㎜") === normCell("350mm"), "同一数值的两种单位写法没被归一");
ok(normCell("1，200") === "1,200", "全角逗号没被归一");

const same = diffTableCells(tA, tB);
ok(
  same.status === "compared" && same.changed === 0,
  `只有单位写法不同应判「全部相同」，实得 ${JSON.stringify(same).slice(0, 80)}`,
);

const changed = diffTableCells(tA, "| 参数 | A 版 | B 版 |\n| --- | --- | --- |\n| 高度 | 350㎜ | 420mm |");
ok(changed.status === "compared" && changed.changed === 1, "改了一个数应报 1 格不同");
ok(
  changed.changes[0].row === 2 && changed.changes[0].col === 3,
  `差异位置不对：${JSON.stringify(changed.changes[0])}`,
);
ok(
  changed.note.includes("须人工") && changed.note.includes("文本"),
  "单元格差异的说明没写清「文本不同 ≠ 实质变化」",
);

// **结构变了 ⇒ 不比** ✓（行数不同 / 列数不同都跳过 ✓）
const skipRows = diffTableCells(tA, "| 参数 | A 版 | B 版 |\n| --- | --- | --- |");
ok(skipRows.status === "skipped" && skipRows.reason.includes("行×列"), "行数不同时应跳过并说明");
const skipCols = diffTableCells(
  tA,
  "| 参数 | A 版 |\n| --- | --- |\n| 高度 | 350mm |",
);
ok(skipCols.status === "skipped", "列数不同时应跳过");

// 串行表 ⇒ 在配对层就**不参与** ✓（已有用例覆盖），这里补一条：串行内容解析出来的列数是乱的 ✓
ok(looksScrambled("| a | b |\n| --- | --- |\n| 色边色边 | x |"), "相邻重复两字组应判串行");

// ⑧ **逐格**串行判据 —— 整表判据会漏（实测 B 版色度表 ✗）
ok(looksGarbledCell("WW23 00..451478"), "连出两个点应判串行");
ok(looksGarbledCell("FRRR234341紫黄"), "同一大写字母连出 3 个应判串行");
ok(looksGarbledCell("边界界界y"), "同一汉字连出 3 个应判串行");
ok(!looksGarbledCell("W12绿色边界y=0.150+0.640x"), "正常的色度边界式被误判成串行");
{
  // 一格坏了 ⇒ **那一格不比** ✓，不能拿乱码当原文印出去 ✗
  const g = diffTableCells(
    "| 参数 | 值 |\n| --- | --- |\n| 高度 | 350 |\n| 宽度 | 200 |",
    "| 参数 | 值 |\n| --- | --- |\n| 高度 | 350 |\n| 宽度 | 20..0 |",
  );
  ok(g.status === "compared", "一格串行不应让整表跳过");
  ok(g.unscorable === 1, `应报 1 格串行未比，实得 ${g.status === "compared" ? g.unscorable : g.status}`);
  ok(g.changed === 0, "串行的格子被算成了「不同」");
  ok(g.note.includes("串行"), "说明里没写清「有格子串行未比」");
}
{
  // **整表**都串行 ⇒ 跳过 ✓
  const all = diffTableCells(
    "| a | b |\n| --- | --- |\n| 00..1 | FRRR |",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
  );
  ok(all.status === "skipped", "整表串行时应跳过");
}

console.log(`\n✓ 多模态用例全过（${n} 条断言）`);
